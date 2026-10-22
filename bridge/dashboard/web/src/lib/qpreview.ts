import type { Question } from "../api";

/** What an AskUserQuestion option's `preview` gives the card: its pictures and
 *  whatever text is left. The bridge asks for screenshots as markdown images,
 *  one per state, with absolute paths (config.ASK_SYSTEM_PROMPT), and the runner
 *  re-points them at copies in the run's uploads (runner._adopt_preview_images)
 *  so /local/attachment can serve them. The CLI's own tool text also invites
 *  ASCII mockups and code: that's the text. */
export interface Shot { path: string; alt: string }
export interface Preview { shots: Shot[]; text: string }

// Same shape as the runner's _PREVIEW_IMG: an absolute path, optionally in <>.
const IMG = /!\[([^\]\n]*)\]\(\s*<?(\/[^)\s>]+)>?\s*\)/g;

export function parsePreview(md?: string): Preview {
  const shots: Shot[] = [];
  const text = (md ?? "").replace(IMG, (_m, alt: string, path: string) => {
    shots.push({ path, alt: alt.trim() });
    return "";
  }).trim();
  return { shots, text };
}

// Claude letters its own labels ("A · TOKEN"); that letter wins over the position.
const KEY = /^([A-D]|[1-4])\s*[·.):—–-]\s*/;
const REC = /\s*\(Recommended\)\s*$/i;

/** An option's key, the name to print beside it, and whether Claude recommends
 *  it. Display only: the answer still sends the label exactly as asked. */
export function optionKey(label: string, i: number): { key: string; name: string; rec: boolean } {
  const m = KEY.exec(label);
  const name = label.slice(m ? m[0].length : 0).replace(REC, "").trim();
  return { key: m ? m[1] : "ABCD"[i] ?? String(i + 1), name: name || label, rec: REC.test(label) };
}

/** Does this question get the stage? The CLI allows previews on single-select only. */
export const staged = (q: Question) =>
  !q.multiSelect && q.options.some((o) => (o.preview ?? "").trim() !== "");
