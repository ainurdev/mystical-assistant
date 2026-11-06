// The filter in an open WORK zone. Pure: which rows each choice keeps. RunStream builds
// only the rows that pass, a chapter still builds its own only while open, so a filter
// costs no more than the zone did.

export type RowFilter = "all" | "failures" | "edits" | "pictures" | "messages" | "rules";

export const ROW_FILTERS: { f: RowFilter; label: string }[] = [
  { f: "all", label: "all" }, { f: "failures", label: "failures" }, { f: "edits", label: "edits" },
  { f: "pictures", label: "pictures" }, { f: "messages", label: "messages" }, { f: "rules", label: "rules" },
];

/** `cat` is the row's step kind (RunStream catOf), `recovered` a failure later made
 *  good: quiet in the zone, but "failures" is where you'd go looking for it. */
export function rowMatches(
  f: RowFilter,
  e: { type: string; text?: string; error?: boolean; ok?: boolean; decision?: string },
  done: { is_error?: boolean; recovered?: boolean; images?: string[]; patch?: string[] } | undefined,
  cat?: string,
): boolean {
  if (f === "all") return true;
  switch (f) {
    case "failures":
      if (e.type === "tool") return !!done?.is_error || !!done?.recovered;
      if (e.type === "log") return !!e.error;
      if (e.type === "checks") return e.ok === false;
      return e.type === "rule" && e.decision === "blocked";
    case "edits": return e.type === "tool" && (cat === "edit" || cat === "write");
    case "pictures": return e.type === "tool" && !!done?.images?.length;
    case "messages": return (e.type === "text" || e.type === "thinking") && !!e.text;
    case "rules": return e.type === "rule";
  }
}
