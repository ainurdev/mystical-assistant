// Which tool screenshots you have had on screen, so a shut WORK zone can say
// "2 shots" in your accent until you have, and in grey after (RunStream's
// WorkZone reads it; MediaThumb's onSeen and the lightbox write it). The
// bridge keeps no read state for a tool result, so this lives in the browser
// like the lessons' read set (LearnTab READ_KEY): Mystical.app beside Chrome
// starts with its own memory.
//
// Shots from before the store was born count as seen. Without that, the day it
// ships every old turn with a screenshot lights up at once, and shots the upload
// dir has since pruned would glow over a thumbnail that 404s.

import { useSyncExternalStore } from "react";

const KEY = "hud-shots-seen";
const SINCE_KEY = "hud-shots-since";
/** Past this the oldest marks go — the upload dir prunes shots by age anyway.
 *  500 lasted six days of real use, and the sidebar tag reads a full day back. */
const CAP = 2000;

const read = <T>(k: string, fallback: T): T => {
  try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v) as T; }
  catch { return fallback; }
};

let seen = new Set<string>(read<string[]>(KEY, []));
/** Epoch seconds the store first ran in this browser, stamped once. */
const since: number = (() => {
  const s = read<number | null>(SINCE_KEY, null);
  if (s != null) return s;
  const now = Date.now() / 1000;
  try { localStorage.setItem(SINCE_KEY, String(now)); } catch { /* ignore */ }
  return now;
})();
const subs = new Set<() => void>();
let version = 0;

/** True for a shot you have not had on screen: taken after the store was born
 *  (`at` is the tool event's clock, epoch seconds) and not marked since. */
export function shotUnseen(path: string, at: number | undefined): boolean {
  return at != null && at >= since && !seen.has(path);
}

/** The shot's thumbnail has been on screen. */
export function markShotSeen(path: string): void {
  if (seen.has(path)) return;
  seen.add(path);
  if (seen.size > CAP) seen = new Set([...seen].slice(-CAP));
  try { localStorage.setItem(KEY, JSON.stringify([...seen])); } catch { /* ignore */ }
  version++;
  subs.forEach((fn) => fn());
}

/** Re-render on every mark, so a zone's chip dims the moment its shot is seen. */
export function useSeenShots(): number {
  return useSyncExternalStore(
    (fn) => { subs.add(fn); return () => { subs.delete(fn); }; },
    () => version,
  );
}
