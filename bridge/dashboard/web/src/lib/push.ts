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

/** Piebald's rule, and the right one: never notify about what you're already
 *  looking at. Anything else — another session, a hidden tab, another window —
 *  is news. */
export function shouldPush(sessionId: string, openSessionId: string | null): boolean {
  if (document.visibilityState !== "visible") return true;
  return sessionId !== openSessionId;
}
