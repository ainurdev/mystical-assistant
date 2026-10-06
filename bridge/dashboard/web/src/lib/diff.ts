export interface DiffRow {
  ln: string;
  mark: string;
  text: string;
  kind: "add" | "del" | "ctx" | "hunk";
}

/** Parse a unified diff into display rows. `ln` is the working tree's line
 *  number. Hunk headers reset it, and a deleted line gets none: it isn't in
 *  the file any more, so a review note can't cite it. Everything outside a
 *  hunk (diff/index/---/+++ headers, "Binary files differ") and git's
 *  "\ No newline at end of file" marker is dropped. */
export function parseDiff(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let newLn = 0;
  let inHunk = false;
  for (const line of text.replace(/\n$/, "").split("\n")) {
    if (line.startsWith("@@")) {
      const m = /\+(\d+)/.exec(line);
      newLn = m ? parseInt(m[1], 10) : 0;
      inHunk = true;
      rows.push({ ln: "", mark: "", text: line, kind: "hunk" });   // its text carries the @@
    } else if (line.startsWith("diff ")) {
      inHunk = false;            // the next file's headers
    } else if (!inHunk || line.startsWith("\\")) {
      continue;
    } else if (line.startsWith("+")) {
      rows.push({ ln: String(newLn++), mark: "+", text: line.slice(1), kind: "add" });
    } else if (line.startsWith("-")) {
      rows.push({ ln: "", mark: "-", text: line.slice(1), kind: "del" });
    } else {
      rows.push({
        ln: String(newLn++),
        mark: "",
        text: line.startsWith(" ") ? line.slice(1) : line,
        kind: "ctx",
      });
    }
  }
  return rows;
}
