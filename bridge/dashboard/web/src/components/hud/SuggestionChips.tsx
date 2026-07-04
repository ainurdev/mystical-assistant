import { useEffect, useState } from "react";
import { api } from "../../api";

/** Memory-grounded prompt ideas for a fresh session. Auto-fetched per project (the
 *  server caches by memory version, so repeat opens are cheap). Clicking a chip
 *  loads it into the composer for review — it does not send. */
export function SuggestionChips({
  project,
  onPick,
}: {
  project: string | null;
  onPick?: (text: string) => void;
}) {
  const [chips, setChips] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    setChips([]);
    if (!project) return;
    void api
      .memorySuggest(project)
      .then((r) => {
        if (live) setChips(r.suggestions.slice(0, 3));
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      live = false;
    };
  }, [project]);

  if (!chips.length) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", padding: "0 16px 12px", maxWidth: 560, margin: "0 auto" }}>
      {chips.map((c, i) => (
        <button
          key={i}
          onClick={() => onPick?.(c)}
          style={{ appearance: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12, lineHeight: 1.4, textAlign: "left", padding: "7px 11px", borderRadius: 8, border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: "color-mix(in srgb, var(--acc) 7%, transparent)", color: "var(--txh)" }}
        >
          {c}
        </button>
      ))}
    </div>
  );
}
