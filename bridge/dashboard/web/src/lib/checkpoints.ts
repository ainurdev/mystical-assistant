import type { Turn } from "../chat";

/** Anchor id for a checkpoint: a turn's prompt, or a question/steer inside it. */
export function ckId(turnId: string, key?: string): string {
  return `ck-${turnId}${key ? `-${key}` : ""}`;
}

/** Anchor key for a steer, which carries no request id of its own. */
export function steerKey(index: number): string {
  return `steer${index}`;
}

export interface Mark {
  id: string;
  label: string;
  kind: "prompt" | "question" | "steer";
  /** 1-based prompt number; 0 for the question/steer marks nested under one. */
  n: number;
  /** Blocked on a human — an unanswered question or permission. */
  waiting: boolean;
  // Prompt marks only: what the turn did, so the list reads as a run map.
  status?: Turn["status"];
  failed?: boolean;
  stopped?: boolean;
  tools?: number;
  cost?: number | null;
  elapsed?: number | null;
  sha?: string | null;
}

/** Every checkpoint in a session, in transcript order: each prompt, plus the
 *  questions asked and steers sent inside it. Prompt marks carry the turn's
 *  outcome (tools/cost/time/failure) so a jump list doubles as a run map. */
export function marksOf(turns: Turn[]): Mark[] {
  const out: Mark[] = [];
  let n = 0;
  for (const t of turns) {
    const prompt = (t.prompt || "").replace(/\s+/g, " ").trim();
    let tools = 0;
    let cost: number | null = null;
    let elapsed: number | null = null;
    let failed = t.status === "error";
    let stopped = false;
    for (const e of t.events) {
      if (e.type === "tool") tools++;
      else if (e.type === "result") {
        cost = e.cost;
        elapsed = e.elapsed;
        if (e.is_error) failed = true;
      } else if (e.type === "error") failed = true;
      else if (e.type === "stopped") stopped = true;
    }
    const answered = new Set(
      t.events.filter((e) => e.type === "question_answered").map((e) => e.request_id),
    );
    if (prompt) {
      n++;
      out.push({
        id: ckId(t.id), label: prompt, kind: "prompt", n,
        waiting: t.pending.length > 0,
        status: t.status, failed, stopped, tools, cost, elapsed, sha: t.sha ?? null,
      });
    }
    t.events.forEach((e, i) => {
      if (e.type === "question")
        out.push({
          id: ckId(t.id, e.request_id),
          label: e.questions[0]?.header || e.questions[0]?.question || "question",
          kind: "question", n: 0, waiting: !answered.has(e.request_id),
        });
      else if (e.type === "steer")
        out.push({ id: ckId(t.id, steerKey(i)), label: e.text, kind: "steer", n: 0, waiting: false });
    });
  }
  return out;
}

/** Index of the tick nearest position `f` on the rail, or -1 if none is within
 *  `snap`. All three are fractions of the rail's height. Ties go to the lower
 *  tick, so a click in a cluster always lands somewhere. */
export function nearestTick(pos: number[], f: number, snap: number): number {
  let hit = -1;
  let best = snap;
  pos.forEach((p, i) => {
    const d = Math.abs(p - f);
    if (d <= best) { best = d; hit = i; }
  });
  return hit;
}

/** The colour a checkpoint reads as — what needs you first, then what broke. */
export function toneOf(m: Mark): string {
  if (m.waiting) return "var(--purple)";
  if (m.failed) return "var(--err)";
  if (m.status === "running") return "var(--warn)";
  if (m.stopped) return "var(--txd)";
  return m.kind === "steer" ? "var(--violet)" : "var(--acc)";
}

export function fmtCost(c: number): string {
  return `$${c < 1 ? c.toFixed(4) : c.toFixed(2)}`;
}

export function fmtElapsed(s: number): string {
  return s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}
