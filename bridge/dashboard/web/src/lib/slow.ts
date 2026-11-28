/* Slow spots on the page (ADR 0005). lib/reports.ts loads this only on a team
 * install, after Sentry, and sends what it finds; nothing under a limit leaves.
 *
 * - Input: the engine's event timing (WebKit and Chromium both have it). An
 *   input whose time to the next paint is over 100 ms is `input: <kind>`, named
 *   by its control's role and data-ctx-type, never its text. An engine without
 *   event timing (WebKitGTK may lack it) is timed here: input to the next frame.
 * - Frame: Chromium's long animation frames, over 150 ms, with the scripts it
 *   names. WebKit has none, and a frame loop that never stops would keep the
 *   page from resting, so there frames are watched for one second after each
 *   input only, and no longer once the window loses focus. shortcut: a WebKit
 *   freeze with no input before it goes unseen, and its frames name no script;
 *   upgrade if WebKit ships long-animation-frame.
 * - Start-up: `start-up: page`, once a load, from the startup: marks
 *   lib/reports.ts's markStartup leaves (main.tsx and App.tsx).
 *
 * The rules (inputSpot, frameSpot, startupSpot) are pure, for lib/slow.check.ts;
 * the caps are lib/reports.ts's, on everything sent. */

import { controlOf } from "./reports.ts";

export const INPUT_LIMIT = 100;
export const FRAME_LIMIT = 150;
const WATCH_MS = 1000;     // WebKit: frames watched this long after an input

export interface Spot { name: string; surface: "input" | "frame" | "start-up"; ms: number; context: Record<string, unknown> }

// What counts as an input: a click or a key. Hovers and scrolls are reported too, and left out.
const INPUTS = new Set(["click", "dblclick", "contextmenu", "pointerdown", "pointerup", "mousedown", "mouseup",
  "keydown", "keyup", "keypress", "beforeinput", "input"]);

/** An event-timing entry, or an input this page timed itself, as a slow spot or null. */
export function inputSpot(e: { name: string; duration: number; target?: unknown }): Spot | null {
  if (!INPUTS.has(e.name) || !(e.duration > INPUT_LIMIT)) return null;
  return { name: `input: ${e.name}`, surface: "input", ms: Math.round(e.duration), context: { control: controlOf(e.target), limit_ms: INPUT_LIMIT } };
}

interface Script { invoker?: string; sourceURL?: string; sourceFunctionName?: string; duration: number }

/** A long animation frame (or a gap between two frames WebKit drew) as a slow spot or null. */
export function frameSpot(e: { duration: number; scripts?: readonly Script[] }, after?: string): Spot | null {
  if (!(e.duration > FRAME_LIMIT)) return null;
  // one line each: Sentry cuts a context's objects off three levels down
  const scripts = [...(e.scripts ?? [])].sort((a, b) => b.duration - a.duration).slice(0, 5)
    .map((s) => `${s.invoker ?? "?"} ${s.sourceFunctionName || "(anonymous)"} @ ${s.sourceURL || "?"} (${Math.round(s.duration)} ms)`);
  return { name: "frame", surface: "frame", ms: Math.round(e.duration), context: { scripts, ...(after ? { after } : {}), limit_ms: FRAME_LIMIT } };
}

export const MARKS = ["script loaded", "shell painted", "sidebar rows painted", "first turn painted"] as const;

/** `start-up: page` once the four timed marks are in, else null. Rows and the
 *  turn can't paint before the shell does (the intro holds it back), so neither
 *  reads earlier than it. */
export function startupSpot(marks: Record<string, number>, intro: boolean): Spot | null {
  if (!MARKS.every((m) => m in marks)) return null;
  const shell = marks["shell painted"];
  const at: Record<string, number> = {};
  for (const m of MARKS) at[m] = Math.round(m === "sidebar rows painted" || m === "first turn painted" ? Math.max(marks[m], shell) : marks[m]);
  return { name: "start-up: page", surface: "start-up", ms: Math.max(...Object.values(at)), context: { marks: at, intro } };
}

interface LongFrame extends PerformanceEntry { scripts: Script[] }

/** Start every watcher this engine supports; each slow spot goes to `send`. */
export function watchSlowSpots(send: (s: Spot) => void): void {
  // Hidden, the page draws nothing: no gap across it is a frozen frame, and a
  // start-up that waited on it says so.
  let hidden = document.hidden;
  let last = 0;
  addEventListener("visibilitychange", () => { hidden ||= document.hidden; last = 0; });
  const has = (t: string) => PerformanceObserver.supportedEntryTypes?.includes(t);
  const observe = (type: string, cb: (list: PerformanceObserverEntryList) => void, opts: Record<string, unknown> = {}) =>
    new PerformanceObserver(cb).observe({ type, ...opts } as PerformanceObserverInit);

  const timed = has("event");
  if (timed) {
    observe("event", (list) => {
      // One click is several entries (pointerup, click) painted together: the longest of a
      // batch speaks for it, the later on a tie (the click, not its pointerup).
      // shortcut: two slow inputs in one paint send one.
      let top: Spot | null = null;
      for (const e of list.getEntries() as PerformanceEventTiming[]) {
        const s = inputSpot(e);
        if (s && s.ms >= (top?.ms ?? 0)) top = s;
      }
      if (top) send(top);
    }, { durationThreshold: INPUT_LIMIT });
  }

  const longFrames = has("long-animation-frame");
  if (longFrames) observe("long-animation-frame", (list) => {
    for (const e of list.getEntries() as LongFrame[]) { const s = frameSpot(e); if (s) send(s); }
  });

  // No event timing or no long frames: watch frames after each input, then stop.
  if (!timed || !longFrames) {
    let until = 0;
    let after = "";
    const tick = (now: number) => {
      const s = last ? frameSpot({ duration: now - last }, after) : null;
      if (s) send(s);
      last = now;
      if (now < until) requestAnimationFrame(tick); else last = 0;
    };
    const onInput = (e: Event) => {
      const t0 = e.timeStamp;
      // a click's pointerdown starts the frame watch; the click itself is what's timed
      if (!timed && e.type !== "pointerdown") requestAnimationFrame(() => {
        const s = inputSpot({ name: e.type, duration: performance.now() - t0, target: e.target });
        if (s) send(s);
      });
      if (longFrames) return;
      after = `${e.type} on ${controlOf(e.target)}`;
      const running = until > performance.now();
      until = performance.now() + WATCH_MS;
      if (!running) requestAnimationFrame(tick);
    };
    for (const type of ["pointerdown", "click", "keydown"]) addEventListener(type, onInput, { capture: true, passive: true });
    // A window that lost focus can stop drawing with no visibilitychange (a Linux window switched
    // away by a key: the 3 to 48 s until it was back came in as one frame). The watch ends there.
    addEventListener("blur", () => { last = 0; until = 0; });
  }

  // start-up: page, from the marks so far and each one after.
  const marks: Record<string, number> = {};
  let intro = false;
  let sent = false;
  observe("mark", (list) => {
    for (const e of list.getEntries()) {
      if (e.name === "startup:intro ran") intro = true;
      else if (e.name.startsWith("startup:")) marks[e.name.slice(8)] = e.startTime;
    }
    const s = sent ? null : startupSpot(marks, intro);
    if (s) { sent = true; send(hidden ? { ...s, context: { ...s.context, hidden } } : s); }
  }, { buffered: true });
}
