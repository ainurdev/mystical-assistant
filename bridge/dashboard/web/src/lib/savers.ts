// Savers as the dashboard draws them (design: .mystical/design-drafts/cli-signals,
// row 6; bridge/savers.py): the tag a prompt wears in a session that drew a
// trial's saver, and what a card's floor says. Pure.
import type { Saver } from "../api";

/** The saver a session drew in a trial, as its prompts' tag names it. */
const TAG: Record<string, string> = { concise: "Concise", subagent_effort: "Subagent effort", trim_tests: "Trim tests" };
export const saverTag = (key: string) => `${TAG[key] ?? key.replace(/_/g, " ")} · trial`;

/** What a card's floor says when no trial is running or kept: the fact of it. */
const FACT: Record<string, string> = {
  concise: "Claude Code's built-in Concise style",
  subagent_effort: "your own turns keep their effort",
  trim_tests: "pytest · vitest · jest · go test",
};

/** A delta as the floor prints it: "−41%" (a real minus), "+12%", "±0%". */
export const pct = (n: number) => (n < 0 ? `−${-n}%` : n > 0 ? `+${n}%` : "±0%");

/** A card's floor. Left: a running trial's progress (with the bar's fill), "kept
 *  after a trial" for one switched ON after it, else the saver's fact. Right:
 *  what the trial found, measured in what the saver is for (words for Concise,
 *  tokens for the rest); `good` when the saver's half came out lower, null
 *  while a half has nothing to compare. `untried`: no trial ever ran. */
export function saverFoot(s: Saver): {
  left: string; bar: number | null; delta: string | null; good: boolean | null; unit: string; untried: boolean;
} {
  const t = s.trial, n = t?.n ?? 0;
  const d = t ? (s.key === "concise" ? t.words : t.tokens) : null;
  return {
    left: s.mode === "trial" ? (n < s.target ? `trial · ${n} of ${s.target} sessions` : `trial done · ${n} sessions`)
      : s.mode === "on" && t ? "kept after a trial" : FACT[s.key] ?? s.hint,
    bar: s.mode === "trial" ? Math.min(1, n / Math.max(1, s.target)) : null,
    delta: d == null ? null : pct(d),
    good: d == null || d === 0 ? null : d < 0,
    unit: s.key === "concise" ? "words" : "tokens a turn",
    untried: !t,
  };
}
