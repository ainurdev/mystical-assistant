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

/** Does this question get the stage? Only pictures earn it: options carrying
 *  text alone were drawn as picture tiles reading "No picture" (2026-10-25).
 *  The CLI allows previews on single-select only. */
export const staged = (q: Question) =>
  !q.multiSelect && q.options.some((o) => parsePreview(o.preview).shots.length > 0);

/** Each option's preview text when the previews are text alone, for the one
 *  panel under the rows (QuestionCard TextPreview); null when there is none or
 *  the question is staged. */
export function previewTexts(q: Question): string[] | null {
  if (q.multiSelect || staged(q)) return null;
  const texts = q.options.map((o) => parsePreview(o.preview).text);
  return texts.some(Boolean) ? texts : null;
}

/** The one frame a question's shots share (.mystical/design-drafts/ask-pictures-steady):
 *  the largest width and the largest height among them, in natural px, so a tab or
 *  an option never resizes the card; each shot then fills it as large as it fits
 *  (object-fit: contain), hung from the top. 16 × 10 until every shot has a size
 *  (`undefined` = still loading; leave out the ones that failed), so the frame
 *  settles once, as the card arrives, rather than once per picture. */
export function frameOf(sizes: ([number, number] | undefined)[]): [number, number] {
  if (!sizes.length || sizes.some((s) => !s)) return [16, 10];
  return [Math.max(...sizes.map((s) => s![0])), Math.max(...sizes.map((s) => s![1]))];
}
