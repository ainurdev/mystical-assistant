import { useEffect, useState } from "react";

/** Read + JSON-parse a localStorage key, falling back to `initial` on missing
 *  or corrupt data (and when localStorage is unavailable in a rare webview). */
function read<T>(key: string, initial: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return initial;
    return JSON.parse(raw) as T;
  } catch {
    return initial;
  }
}

/** Like useState, but persisted to localStorage[key]. Quota / unavailable
 *  errors are swallowed so the app keeps working in-memory. */
export function usePersistentState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => read(key, initial));

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // QuotaExceededError or no localStorage — degrade to in-memory.
    }
  }, [key, value]);

  return [value, setValue] as const;
}
