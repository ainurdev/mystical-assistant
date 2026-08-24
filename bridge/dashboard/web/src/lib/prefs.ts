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

/** A string the browser remembers — which lesson you were reading, and whatever
 *  the next panel needs to survive being unmounted. */
export function useStickyStr(key: string, initial = ""): [string, Dispatch<SetStateAction<string>>] {
  const [s, setS] = useState(() => {
    try { return localStorage.getItem(key) ?? initial; } catch { return initial; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, s); } catch { /* ignore */ }
  }, [key, s]);
  return [s, setS];
}

/** A set of ids the browser remembers — pinned sessions, lessons already read. */
export function useStickySet(key: string): [Set<string>, Dispatch<SetStateAction<Set<string>>>] {
  const [set, setSet] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(key) || "[]") as string[]); }
    catch { return new Set(); }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify([...set])); } catch { /* ignore */ }
  }, [key, set]);
  return [set, setSet];
}

/** A small JSON object the browser remembers — the study ladder, and whatever
 *  the next panel needs beyond a flag or a set. */
export function useStickyObj<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [obj, setObj] = useState<T>(() => {
    try { return { ...initial, ...JSON.parse(localStorage.getItem(key) || "{}") }; }
    catch { return initial; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(obj)); } catch { /* ignore */ }
  }, [key, obj]);
  return [obj, setObj];
}

/** Sessions you pinned to the top of the lists. Call it once (App owns it) and
 *  hand the pair down — the sessions panel and the context menu have to toggle
 *  the same set, so two copies of this state would drift. */
export function useSessionPins(): [Set<string>, (id: string) => void] {
  const [pins, setPins] = useStickySet("hud-session-pins");
  const toggle = (id: string) => setPins((p) => {
    const next = new Set(p);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  return [pins, toggle];
}
