// The intro's boot log, wired to the five fetches the dashboard actually waits
// on at startup. Every line is one real request; the bar is how many of them
// have answered. Nothing here is on a timer — a fast bridge shows a fast boot.

export type BootPhase = "wait" | "ok" | "fail";

export interface BootStep {
  key: string; // BootKey at startup; the restart overlay reuses the log with its own keys
  label: string;
  phase: BootPhase;
  detail: string; // right-hand column: "OK", "12 REPOS", "OFFLINE"…
}

export type BootKey = "bridge" | "projects" | "sessions" | "git" | "auth" | "chat";

const LABELS: { key: BootKey; label: string }[] = [
  { key: "bridge", label: "ESTABLISHING BRIDGE" },
  { key: "projects", label: "CLAUDE PROJECTS" },
  { key: "sessions", label: "CONVERSATION STORE" },
  { key: "git", label: "GIT WORKTREES" },
  { key: "auth", label: "AUTH · CLAUDE LOGIN" },
  // Last on purpose: it can't even start until CONVERSATION STORE answers and
  // names the chat to reopen. Without it the wipe uncovers an empty transcript
  // that fills in a few hundred ms later — the whole point of the gate.
  { key: "chat", label: "RESTORING TRANSCRIPT" },
];

export function initialBootSteps(): BootStep[] {
  return LABELS.map((s) => ({ ...s, phase: "wait" as const, detail: "" }));
}

/** First answer wins. The loads that feed these lines are polls (3s/5s/10s/60s),
 *  so without this the intro would keep rewriting settled lines — and hand back
 *  a fresh array every tick, re-rendering the whole dashboard behind it. */
export function markStep(steps: BootStep[], key: BootKey, phase: "ok" | "fail", detail: string): BootStep[] {
  const i = steps.findIndex((s) => s.key === key);
  if (i < 0 || steps[i].phase !== "wait") return steps;
  const next = steps.slice();
  next[i] = { ...steps[i], phase, detail };
  return next;
}

/** 0..1 — the share of steps that have answered, either way. */
export function bootProgress(steps: BootStep[]): number {
  if (!steps.length) return 1;
  return steps.filter((s) => s.phase !== "wait").length / steps.length;
}

export const BOOT_FLOOR_MS = 1600; // the emblem finishes drawing and the last log line lands at ~1.5s
export const BOOT_CEIL_MS = 8000; // a bridge that hangs must not trap you here

/** Whether the intro should start its exit: everything answered and the opening
 *  animation has landed, or we've waited long enough that it no longer matters. */
export function bootReady(steps: BootStep[], elapsedMs: number): boolean {
  if (elapsedMs >= BOOT_CEIL_MS) return true;
  return bootProgress(steps) === 1 && elapsedMs >= BOOT_FLOOR_MS;
}

/** Set by the restart just before it reloads: the intro is already on screen in
 *  the outgoing document, so the next one continues it instead of replaying. */
export const BOOT_CONTINUE = "boot-continue";

/** "12 REPOS" / "1 REPO" / "NONE" — the count is the point, so zero says so. */
export function count(n: number, noun: string): string {
  if (n <= 0) return "NONE";
  return `${n} ${noun}${n === 1 ? "" : "S"}`;
}
