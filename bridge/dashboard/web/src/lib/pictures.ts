// Two kinds of pictures. Most images in a turn are the agent looking at something: a
// file it read, a screenshot it took to check its work. A few it is showing you: a
// figure (show_image, compare_images) or an Attach/Record clip, chosen as proof, with a
// caption saying of what. Treated alike, the proof got lost in 40 contact-sheet tiles,
// so they're split here. What it looked at stays with the work (RunStream's shot strip);
// what it shows you draws large, with the answer (components/Proof).

type Clip = { notes?: string; chapters?: { t: number; text: string }[]; todos?: { content: string; status: string }[]; resolves?: number[] };

type Ev = { type: string; id?: string; name?: string; summary?: string; at?: number; text?: string;
  images?: string[]; clip?: Clip; kind?: string; caption?: string };

/** A tool whose result is shown to you rather than looked at. */
export function isShowTool(name: string): boolean {
  return /(^|__)(Attach|Record)$/.test(name);
}

export type ProofItem = {
  key: string;
  /** Where it sits in the events. */
  i: number;
  kind: "shown" | "compare";
  images: string[];
  caption: string;
  /** The tool it came from. */
  tool: string;
  at?: number;
  clip?: Clip;
};

const toolWord = (name: string) => name.split("__").pop() ?? name;

/** Everything a turn shows you, in order. */
export function proofsOf(events: Ev[]): ProofItem[] {
  const done = new Map<string, Ev>();
  for (const e of events) if (e.type === "tool_done" && e.id) done.set(e.id, e);
  const out: ProofItem[] = [];
  events.forEach((e, i) => {
    if (e.type === "figure" && e.images?.length) {
      out.push({ key: `f${i}`, i, kind: e.kind === "compare" && e.images.length === 2 ? "compare" : "shown", images: e.images,
        caption: e.caption ?? "", tool: e.kind === "compare" ? "compare_images" : "show_image", at: e.at });
    } else if (e.type === "tool" && e.id && e.name && isShowTool(e.name)) {
      const d = done.get(e.id);
      if (!d?.images?.length) return;
      out.push({ key: `t${i}`, i, kind: "shown", images: d.images, caption: d.clip?.notes ?? "", tool: toolWord(e.name), at: e.at, clip: d.clip });
    }
  });
  return out;
}

/** For each picture the agent looked at, by event index, the note it wrote next:
 *  what it made of them. `skip` is words that are the turn's answer, which aren't a
 *  note about a picture, and which the answer box already says. */
export function lookedNotes(events: Ev[], skip: (text: string) => boolean = () => false): Map<number, string> {
  const done = new Map<string, Ev>();
  for (const e of events) if (e.type === "tool_done" && e.id) done.set(e.id, e);
  const out = new Map<number, string>();
  let waiting: number[] = [];
  events.forEach((e, i) => {
    if (e.type === "tool" && e.id && e.name && !isShowTool(e.name) && done.get(e.id)?.images?.length) waiting.push(i);
    else if (e.type === "text" && e.text?.trim()) {
      if (!skip(e.text)) for (const j of waiting) out.set(j, e.text.trim());
      waiting = [];
    }
  });
  return out;
}

/** A note as the one or two lines beside a strip. */
export function noteLine(text: string, max = 280): string {
  const line = text.replace(/`|\*\*/g, "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The file a path names, without the prefix the bridge puts on a figure's copy
 *  (gateway_tools._figure: fig-<ms>-<n>-name.png). */
const fileOf = (p: string) => (p.split("/").pop() ?? p).replace(/^fig-\d+-\d+-/, "");

/** Local pictures an answer's Markdown draws itself. A remote one can't be a copy of a
 *  file on this machine, so it isn't counted. */
export function answerImages(md: string): Set<string> {
  const out = new Set<string>();
  const body = md.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  for (const m of body.matchAll(/!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^)\s]+))/g)) {
    const url = m[1] ?? m[2];
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) out.add(fileOf(url));
  }
  return out;
}

/** The proofs less what the answer already draws, so no picture shows twice. A
 *  before/after loses nothing unless both halves are drawn: half a comparison isn't one. */
export function withoutAnswered(items: ProofItem[], answer: string): ProofItem[] {
  const drawn = answerImages(answer);
  if (!drawn.size) return items;
  return items.flatMap((p) => {
    const left = p.images.filter((im) => !drawn.has(fileOf(im)));
    if (!left.length) return [];
    if (left.length === p.images.length || p.kind === "compare") return [p];
    return [{ ...p, images: left }];
  });
}
