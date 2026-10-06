import type { DiffRow } from "./diff";

/** Review notes on the GIT tab's diff (review loop A,
 *  docs/superpowers/specs/review-loop.md). Each worktree and branch keeps its
 *  own drafts in this browser's localStorage until SEND or CLEAR. SEND hands
 *  them to the branch's session as one message.
 *
 *  ponytail: no server table, so the Mini App never sees these. Give them one
 *  if it ever needs to. */

export interface Note {
  id: string;
  path: string;     // repo-relative, the way git status names it
  start: number;    // working-tree line numbers, inclusive
  end: number;
  code: string;     // line `start`'s text when the note was left: how SEND finds it again
  text: string;
  at: number;       // ms epoch
  lost?: boolean;   // set at SEND only: that line isn't in the file any more
}

/** A note being written, or edited when `id` is set. */
export type NoteDraft = Omit<Note, "id" | "at" | "lost"> & { id?: string };

/** Where SEND goes: a session by id, or a new session started in this tree.
 *  Resolves true once the message ran or was queued. Only then are the notes
 *  dropped. */
export type SendTo = (text: string, to: { session: string } | { cwd: string }) => Promise<boolean>;

const STORE = "review-notes:";

export const notesKey = (project: string, branch: string) => `${project}@${branch}`;

export function loadNotes(key: string): Note[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(STORE + key) ?? "[]");
    return Array.isArray(v) ? (v as Note[]) : [];
  } catch {
    return [];
  }
}

export function saveNotes(key: string, notes: Note[]): void {
  try {
    if (notes.length) localStorage.setItem(STORE + key, JSON.stringify(notes));
    else localStorage.removeItem(STORE + key);
  } catch { /* storage full or blocked: the notes last as long as the tab */ }
}

export function countByPath(notes: Note[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of notes) out[n.path] = (out[n.path] ?? 0) + 1;
  return out;
}

/** The lines a drag from row `a` to row `b` covers. Only rows in the working
 *  tree count: a deleted line or a hunk header has no number to cite. */
export function noteRange(rows: DiffRow[], a: number, b: number): { start: number; end: number; code: string } | null {
  const picked = rows.slice(Math.min(a, b), Math.max(a, b) + 1).filter((r) => r.ln !== "");
  if (!picked.length) return null;
  return { start: Number(picked[0].ln), end: Number(picked[picked.length - 1].ln), code: picked[0].text };
}

/** "L45", or "L36–37" for a range (sheet A's thread header). */
export const lineLabel = (start: number, end: number) => (start === end ? `L${start}` : `L${start}–${end}`);

/** The note's lines in the file as it is now. The agent may have moved them
 *  since the note was left: the nearest line with the same text wins, and the
 *  range keeps its length. If the line is gone, the note is marked `lost`.
 *  `lines` is null when the file can't be read (deleted, binary).
 *  A trailing "\r" is ignored on both sides: the bridge's git diff comes
 *  through a text-mode subprocess that drops it, and files/read keeps it. */
export function reanchor(n: Note, lines: string[] | null): Note {
  if (!lines) return { ...n, lost: true };
  const code = n.code.replace(/\r$/, "");
  const same = (l: string | undefined) => l !== undefined && l.replace(/\r$/, "") === code;
  if (same(lines[n.start - 1])) return n;
  let best = -1;
  lines.forEach((l, i) => {
    if (same(l) && (best < 0 || Math.abs(i + 1 - n.start) < Math.abs(best + 1 - n.start))) best = i;
  });
  if (best < 0) return { ...n, lost: true };
  const d = best + 1 - n.start;
  return { ...n, start: n.start + d, end: n.end + d };
}

/** The one message the session gets (sheet A): a header, then each note's
 *  place and its words, in file then line order. */
export function notesMessage(branch: string, notes: Note[]): string {
  const sorted = [...notes].sort((x, y) => x.path.localeCompare(y.path) || x.start - y.start);
  const out = [`Review notes on ⎇ ${branch} (${notes.length}):`];
  for (const n of sorted) {
    const at = n.start === n.end ? `${n.start}` : `${n.start}-${n.end}`;
    out.push(`${n.path}:${at}${n.lost ? " (that line has changed since)" : ""}`);
    for (const l of n.text.trim().split("\n")) out.push(`  ${l}`);
  }
  return out.join("\n");
}
