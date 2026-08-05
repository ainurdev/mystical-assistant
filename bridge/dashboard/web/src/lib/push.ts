/** OS notifications for sessions you're not watching.
 *
 *  The bridge already pushes to Telegram; this is the same event reaching the
 *  machine you're sitting at (and, installed to a phone home screen, that phone).
 *  Deliberately the plain Notification API — no service worker, no push server,
 *  no subscription to keep alive. The cost is that notifications only fire while
 *  a dashboard tab is open somewhere; Telegram remains the offline path.
 */

export function pushSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function pushGranted(): boolean {
  return pushSupported() && Notification.permission === "granted";
}

/** Ask once. Returns whether we're allowed to notify afterwards — a denial is
 *  permanent until the user clears it in browser settings, so callers should
 *  switch their toggle back off rather than ask again. */
export async function requestPush(): Promise<boolean> {
  if (!pushSupported()) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try {
    return (await Notification.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

/** Fire one notification. `tag` collapses repeats for the same session, so a
 *  chatty session replaces its own notification instead of stacking twenty. */
export function push(title: string, body: string, tag?: string, onClick?: () => void): void {
  if (!pushGranted()) return;
  try {
    const n = new Notification(title, { body, tag, icon: "/favicon.svg" });
    // Clicking should land you in the dashboard, on the session that pinged.
    n.onclick = () => { window.focus(); onClick?.(); n.close(); };
  } catch {
    /* some browsers throw for notifications outside a service worker; ignore */
  }
}

/** The blip that goes with the notification, for when the OS banner lands on a
 *  screen you aren't looking at. Synthesised rather than shipped as files: four
 *  note lists and one envelope, so there's nothing to decode, cache or 404.
 *  Each is short on purpose — this is punctuation, not a ringtone. */
export const TONES = {
  blip: { label: "BLIP", notes: [880, 1320], wave: "sine" },
  chime: { label: "CHIME", notes: [1318, 1046, 784], wave: "sine" },
  ping: { label: "PING", notes: [1568], wave: "sine" },
  knock: { label: "KNOCK", notes: [196, 147], wave: "triangle" },
} as const satisfies Record<string, { label: string; notes: number[]; wave: OscillatorType }>;

export type ToneKey = keyof typeof TONES;

/** Play one. Silent until the browser has had a user gesture, which by the time
 *  a session pings it has. `volume` is the 0..1 the settings slider carries. */
let ac: AudioContext | null = null;
export function chime(tone: ToneKey = "blip", volume = 0.6): void {
  if (volume <= 0) return;
  try {
    ac ??= new AudioContext();
    void ac.resume();
    const now = ac.currentTime;
    const spec = TONES[tone] ?? TONES.blip;
    // exponentialRamp can't touch zero, hence the floor on both ends.
    const peak = Math.max(0.002, 0.16 * volume);
    spec.notes.forEach((hz, i) => {
      const osc = ac!.createOscillator();
      const gain = ac!.createGain();
      const t = now + i * 0.09;
      osc.type = spec.wave;
      osc.frequency.value = hz;
      // Ramps, not a square step — an abrupt gain change clicks.
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      osc.connect(gain).connect(ac!.destination);
      osc.start(t);
      osc.stop(t + 0.18);
    });
  } catch {
    /* no audio device, or a context the browser won't start */
  }
}

/** Piebald's rule, and the right one: never notify about what you're already
 *  looking at. Anything else — another session, a hidden tab, another window —
 *  is news. */
export function shouldPush(sessionId: string, openSessionId: string | null): boolean {
  if (document.visibilityState !== "visible") return true;
  return sessionId !== openSessionId;
}
