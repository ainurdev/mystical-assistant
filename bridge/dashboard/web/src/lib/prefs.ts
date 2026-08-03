import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

/** A boolean the browser remembers across opens — modal maximize state, and
 *  whatever the next modal needs. Same shape as useState, so a modal opts in by
 *  swapping the call. */
export function useStickyFlag(key: string): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [on, setOn] = useState(() => {
    try { return localStorage.getItem(key) === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, on ? "1" : "0"); } catch { /* ignore */ }
  }, [key, on]);
  return [on, setOn];
}

const PINS_KEY = "hud-session-pins";

/** Sessions you pinned to the top of the lists. Call it once (App owns it) and
 *  hand the pair down — the sessions panel and the context menu have to toggle
 *  the same set, so two copies of this state would drift. */
export function useSessionPins(): [Set<string>, (id: string) => void] {
  const [pins, setPins] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(PINS_KEY) || "[]") as string[]); }
    catch { return new Set(); }
  });
  useEffect(() => {
    try { localStorage.setItem(PINS_KEY, JSON.stringify([...pins])); } catch { /* ignore */ }
  }, [pins]);
  const toggle = (id: string) => setPins((p) => {
    const next = new Set(p);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  return [pins, toggle];
}
