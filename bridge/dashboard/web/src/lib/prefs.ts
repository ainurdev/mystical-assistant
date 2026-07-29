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
