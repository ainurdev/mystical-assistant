export interface DiffRow {
  ln: string;
  mark: string;
  text: string;
  kind: "add" | "del" | "ctx" | "hunk";
}

/** Parse a unified diff into display rows. Tracks the new-file line number for
 *  context/added lines; hunk headers reset it. Header lines (diff/index/---/+++)
 *  are dropped except the @@ hunk line. */
export function parseDiff(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let newLn = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@")) {
      const m = /\+(\d+)/.exec(line);
      newLn = m ? parseInt(m[1], 10) : 0;
      rows.push({ ln: "", mark: "@@", text: line, kind: "hunk" });
    } else if (
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("similarity ") ||
      line.startsWith("rename ") ||
      line.startsWith("\\ No newline")
    ) {
      continue;
    } else if (line.startsWith("+")) {
      rows.push({ ln: String(newLn++), mark: "+", text: line.slice(1), kind: "add" });
    } else if (line.startsWith("-")) {
      rows.push({ ln: "", mark: "-", text: line.slice(1), kind: "del" });
    } else if (line.length > 0 || rows.length > 0) {
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
