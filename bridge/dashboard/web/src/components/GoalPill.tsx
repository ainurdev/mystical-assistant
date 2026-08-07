import { useState } from "react";
import type { Goal } from "../api";

/** The session's active objective, above the composer. Clicking clears it — the
 *  loop is the bridge's, so this is a readout with one escape hatch, not a form.
 *  Set a goal with `/goal <objective>` (or let the model call CreateGoal). */
export function GoalPill({
  goal,
  maxIter = 10,
  onClear,
}: {
  goal?: Goal | null;
  maxIter?: number;
  onClear: () => void;
}) {
  const [hov, setHov] = useState(false);
  if (!goal) return null;
  const active = goal.state === "active";
  const blocked = goal.state === "blocked";
  // Amber when it stopped for you, accent while it's still working itself.
  const tint = blocked ? "var(--warn, #e8b339)" : active ? "var(--acc)" : "var(--txm)";
  const label = active
    ? `goal · ${goal.iter}/${maxIter}`
    : blocked ? "goal blocked" : "goal complete";
  return (
    <div
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      title={goal.note ? `${goal.objective}\n\n${goal.note}` : goal.objective}
      style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center",
               gap: 8, maxWidth: "100%", border: `1px solid color-mix(in srgb, ${tint} 38%, transparent)`,
               background: `color-mix(in srgb, ${tint} ${active ? 8 : 4}%, transparent)`,
               color: tint, fontSize: "var(--t11)", letterSpacing: 0.5,
               padding: "4px 12px", borderRadius: 999 }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: tint,
                     flex: "0 0 auto",
                     animation: active ? "mpulse 2.4s infinite" : "none" }} />
      <span style={{ flex: "0 0 auto" }}>{label}</span>
      <span style={{ color: "var(--txm)", overflow: "hidden",
                     textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {goal.objective}
      </span>
      {hov && (
        <button
          onClick={onClear}
          title="clear this goal"
          style={{ appearance: "none", cursor: "pointer", border: "none",
                   background: "none", color: "var(--txm)", font: "inherit",
                   padding: 0, flex: "0 0 auto" }}
        >
          ✕
        </button>
      )}
    </div>
  );
}
