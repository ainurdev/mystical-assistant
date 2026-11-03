import type { Goal } from "../api";
import type { Turn } from "../chat";

/** Where a goal stands, for its pill and sheet (components/GoalPill).
 *  - working: active, and a turn is running or about to (a nudge lands a beat
 *    after the turn before it ends, so 20 s of quiet is allowed for it);
 *  - stalled: active with nothing running, queued, paused or waiting — a nudge
 *    that errored with nothing left to re-queue it, or the MAX_ITER brake;
 *  - blocked / met: the model's verdict. A met goal shows until you prompt past
 *    it (`seen`); one from before goals carried `at` doesn't show at all.
 *  null = show nothing. */
export type GoalPhase = "working" | "stalled" | "blocked" | "met";

export function goalPhase(goal: Goal, busy: boolean, quietFor: number, max: number): GoalPhase | null {
  if (goal.state === "blocked") return "blocked";
  if (goal.state === "complete") return goal.at && !goal.seen ? "met" : null;
  return !busy && (quietFor > 20 || goal.iter >= max) ? "stalled" : "working";
}

export interface GoalTurn { id: string; secs: number; live: boolean; first: boolean }

/** The turns a goal ran, oldest first: from the one running when it was set
 *  (`first`) to the one that landed its verdict. A running turn counts up to
 *  `now`. null for a goal from before `since` existed. */
export function goalTurns(goal: Goal, turns: Turn[], now: number): GoalTurn[] | null {
  const since = goal.since;
  if (!since) return null;
  return turns
    .flatMap((t) => (t.started == null ? [] : [{ t, start: t.started,
      end: t.started + (t.elapsed ?? (t.status === "running" ? now - t.started : 0)) }]))
    .filter(({ start, end }) => end >= since && (!goal.at || start <= goal.at))
    .sort((a, b) => a.start - b.start)
    .map(({ t, start, end }) => ({ id: t.id, secs: Math.max(0, end - start), live: t.status === "running", first: start < since }));
}

/** 54m · 1.2h, under a bar; and 1h 49m for a total. */
export const barTime = (s: number) => {
  const m = Math.round(s / 60);
  return m < 60 ? `${Math.max(1, m)}m` : `${(m / 60).toFixed(1)}h`;
};
export const spanTime = (s: number) => {
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
