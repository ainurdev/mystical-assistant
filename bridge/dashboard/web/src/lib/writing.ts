// FILES' writing card: the newest edit a turn landed. An edit's text reaches the
// page only in its tool_done (`patch`, the diff Claude Code computed), so the
// card follows edit by edit rather than keystroke by keystroke. It shows while
// the turn runs and for a minute after. Pure — no clock of its own.

import { resumeOf } from "./checkpoints.ts";
import { toolKind } from "./tools.ts";

type Ev = { type: string; name?: string; summary?: string; detail?: string; id?: string; patch?: string[]; at?: number };
type T = { prompt?: string; status: string; events: Ev[]; started?: number; elapsed?: number | null };
export type WLine = { sign: "+" | "-" | " "; text: string; n: number | null };
export type Writing = { path: string; name: string; dir: string; lines: WLine[]; line: number | null; turn: number; at: number; live: boolean };

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
/** The number the TURNS tab gives turn `ti`: a resume or promptless turn folds into the row before it. */
const turnNo = (turns: T[], ti: number) =>
  turns.slice(0, ti + 1).reduce((n, t, i) => (i > 0 && (resumeOf((t.prompt || "").trim()) || !(t.prompt || "").trim()) ? n : n + 1), 0);
export const WROTE_FOR = 60; // seconds a finished turn's last edit stays up

export function writing(turns: T[], root: string | null | undefined, now: number): Writing | null {
  for (let ti = turns.length - 1; ti >= 0; ti--) {
    const t = turns[ti];
    const done = new Map<string, Ev>();
    for (const e of t.events) if (e.type === "tool_done" && e.id) done.set(e.id, e);
    for (let i = t.events.length - 1; i >= 0; i--) {
      const e = t.events[i];
      const patch = e.type === "tool" && e.id && toolKind(e.name ?? "") === "write" ? done.get(e.id)?.patch : undefined;
      if (!patch?.length) continue;
      const at = done.get(e.id!)?.at ?? e.at ?? t.started ?? 0;
      const live = t.status === "running";
      const ended = t.started != null && t.elapsed != null ? t.started + t.elapsed : at;
      if (!live && now - ended > WROTE_FOR) return null;
      const abs = e.detail ?? e.summary ?? "";
      const pre = root ? (root.endsWith("/") ? root : `${root}/`) : null;
      const path = pre && abs.startsWith(pre) ? abs.slice(pre.length) : abs;
      const cut = path.lastIndexOf("/") + 1;
      const all: WLine[] = [];
      let n: number | null = null, line: number | null = null;
      for (const p of patch) {
        const h = HUNK.exec(p);
        if (h) { n = line = +h[1]; continue; }
        const s = p[0];
        if (s === "+" || s === "-" || s === " ") {
          all.push({ sign: s, text: p.slice(1), n: s === "-" ? null : n });
          if (s !== "-" && n != null) n++;
        }
      }
      // shortcut: the backend caps a patch at 120 lines, so "last 4" is of the first 120 for a huge edit; upgrade if the cap grows or the card must show the true tail.
      const lines = all.filter((l) => l.sign !== " ").slice(-4);
      // The jump lands on a changed line shown here; the hunk start only when none of them is added.
      const firstAdd = lines.find((l) => l.sign === "+")?.n;
      if (line != null) line = firstAdd ?? line;
      return { path, name: path.slice(cut), dir: path.slice(0, cut), lines,
               line, turn: turnNo(turns, ti), at, live };
    }
  }
  return null;
}
