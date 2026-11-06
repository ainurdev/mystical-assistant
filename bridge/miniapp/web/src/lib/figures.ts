// Pictures in a turn come in two kinds, and they want opposite treatment.
//
// A picture the agent looked at (a Read of a PNG, a screenshot it took to check its
// work) is the agent's evidence. It stays quiet in the steps fold, beside whatever the
// agent said next, because that's what it concluded from it. A picture it's showing you
// (a `figure` event, or what Attach and Record return) is the result: drawn large with
// the answer, with a caption saying what it proves. Pure.

export type Ev = {
  type: string; name?: string; id?: string; summary?: string; text?: string; result?: string;
  kind?: string; images?: string[]; caption?: string;
};
export type Clipped = { images?: string[]; is_error?: boolean; clip?: { notes?: string } };

/** The file a chapterless clip comes from, as the words under it when no note says more. */
const baseName = (s: string): string => {
  const clean = (s || "").trim().split(/[?#]/)[0].replace(/\/+$/, "");
  return (clean.split("/").pop() || clean).slice(0, 80);
};

/** A call whose whole point is to put something in front of you. */
export const isShowTool = (name: string | undefined): boolean => /__(Attach|Record)$/.test(name ?? "");

export type Figure<C> = { at: number; kind: "shown" | "compare"; images: string[]; caption: string; clip?: C };

/** Everything this turn is showing you, in order. */
export function figuresOf<D extends Clipped>(
  events: Ev[], doneOf: (e: Ev) => D | undefined,
): Figure<D["clip"]>[] {
  const out: Figure<D["clip"]>[] = [];
  events.forEach((e, at) => {
    if (e.type === "figure" && e.images?.length) {
      out.push({ at, kind: e.kind === "compare" && e.images.length >= 2 ? "compare" : "shown",
                 images: e.images, caption: e.caption ?? "" });
    } else if (e.type === "tool" && isShowTool(e.name)) {
      const d = doneOf(e);
      if (d?.images?.length) {
        out.push({ at, kind: "shown", images: d.images, caption: d.clip?.notes || baseName(e.summary ?? ""), clip: d.clip });
      }
    }
  });
  return out;
}

/** What the agent said right after looking: the next words before its next call. The
 *  answer doesn't count, since the answer draws itself. */
export function nextNote(events: Ev[], after: number): string {
  const answer = new Set(events.flatMap((e) => (e.type === "result" ? [(e.result ?? "").trim()] : [])));
  for (let i = after + 1; i < events.length; i++) {
    const e = events[i];
    if (e.type === "text" || (e.type === "thinking" && e.text)) {
      const text = (e.text ?? "").trim();
      return answer.has(text) ? "" : text;
    }
    if (e.type === "tool" || e.type === "result" || e.type === "steer" || e.type === "stopped" || e.type === "error") return "";
  }
  return "";
}
