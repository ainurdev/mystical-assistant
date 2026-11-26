import { useEffect, useState } from "react";
import { getViewPrefs, setViewPrefs, type ViewPrefs } from "./readapi";

/* How views read (the diff mode), one setting for every chat on every surface: the bridge keeps
   it (bridge/saved_views.py prefs), so a pick on the phone holds on the desktop. This browser
   keeps a copy so a diff opens in the right mode before the bridge answers. The same file is in
   both apps. */

const KEY = "dv-view-prefs";
const DEFAULT: ViewPrefs = { diff_mode: "unified" };
let now: ViewPrefs = (() => {
  try { return { ...DEFAULT, ...(JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<ViewPrefs>) }; } catch { return DEFAULT; }
})();
let asked = false;
const heard = new Set<(p: ViewPrefs) => void>();
const keep = (p: ViewPrefs) => {
  now = p;
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private mode */ }
  heard.forEach((f) => f(p));
};

export function useViewPrefs(): [ViewPrefs, (p: Partial<ViewPrefs>) => void] {
  const [p, setP] = useState(now);
  useEffect(() => {
    heard.add(setP);
    if (!asked) { asked = true; void getViewPrefs().then((got) => keep({ ...DEFAULT, ...got }), () => { asked = false; }); }
    return () => { heard.delete(setP); };
  }, []);
  const change = (next: Partial<ViewPrefs>) => {
    const was = now;
    keep({ ...now, ...next });
    void setViewPrefs(next).then((got) => keep({ ...DEFAULT, ...got }), () => keep(was));
  };
  return [p, change];
}
