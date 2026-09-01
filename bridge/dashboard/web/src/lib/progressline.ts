// A long job's redraw lines, upgraded to one drawn bar.
//
// The carrier is the line a tool already prints — `[====   ] 33% Downloading
// x86_64-36_r07.zip` — rather than a `widget:` fence, because this same text has
// to stay readable on the two surfaces that don't draw it. An ASCII bar reads
// fine in Telegram; a JSON payload doesn't.
//
// ponytail: repaints when a message lands, not on its own. A bar that follows a
// job with nobody talking needs live tool output, and the bridge only records a
// tool's output once it has finished (bridge/transcript_jsonl.py tool_done).

export type Progress = { pct: number; label: string };

// Two or more fill characters, so a citation like `[1] 50%` is not a bar.
const BAR = /\[[#=█▓▒░.\-\s]{2,}\]/;
const PCT = /(\d{1,3})\s*%/;

/** The bar a line is drawing, or null when it isn't drawing one. The label is
 *  whatever text the line carries either side of the bar — sdkmanager writes it
 *  in front, our own monitor writes it behind. */
export function parseProgress(line: string): Progress | null {
  if (!BAR.test(line)) return null;
  const pct = PCT.exec(line);
  if (!pct) return null;
  const label = line.replace(BAR, " ").replace(PCT, " ").replace(/\s{2,}/g, " ").trim();
  return { pct: Math.min(100, Number(pct[1])), label };
}

/** A block's lines with each run of bars collapsed to the one it ended on, so
 *  forty redraws of the same download read as the one state that is current.
 *  Lines that aren't bars survive in place — they are the step headings. */
export function collapseProgress(text: string): (string | Progress)[] {
  const out: (string | Progress)[] = [];
  for (const line of text.split("\n")) {
    const p = parseProgress(line);
    if (!p) {
      out.push(line);
      continue;
    }
    const last = out[out.length - 1];
    if (last !== undefined && typeof last !== "string") out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}
