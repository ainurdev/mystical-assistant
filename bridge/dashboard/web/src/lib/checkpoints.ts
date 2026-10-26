import type { Turn } from "../chat";
import { limitNudge } from "./limit.ts";

/** Anchor id for a checkpoint: a turn's prompt, or a question/steer inside it. */
export function ckId(turnId: string, key?: string): string {
  return `ck-${turnId}${key ? `-${key}` : ""}`;
}

/** Anchor key for a steer, which carries no request id of its own. */
export function steerKey(index: number): string {
  return `steer${index}`;
}

/** Why the bridge sent a turn of its own to carry the work on (bridge/limits.py
 *  and ladder.py for a limit, recovery.py for a restart, runner.py
 *  RESUME_NUDGE for an error), or null for words you wrote. */
export type Resume = "limit" | "restart" | "error";
export function resumeOf(prompt: string | null | undefined): Resume | null {
  if (!prompt?.startsWith("⏮ ")) return null;
  return limitNudge(prompt) ? "limit" : prompt.includes("bridge restart") ? "restart" : "error";
}

/** What hangs under a turn in the TURNS tab, in transcript order. `key` is the
 *  ckId anchor inside `turnId`, so a tap lands on the ask itself. */
export type Sub =
  | { kind: "question"; turnId: string; key: string; label: string; pick: string | null; note: string | null; open: boolean }
  | { kind: "steer"; turnId: string; key: string; label: string }
  | { kind: "resume"; turnId: string; why: Resume; at: number | null };

/** One of your turns, with the bridge's resumes of it folded in: the tab's row. */
export interface TurnRow {
  id: string;                  // your prompt's turn — where a tap on the row lands
  n: number;                   // 1-based, your prompts only
  prompt: string;              // one line
  answer: string;              // the first line of the chain's last answer, "" when none
  started: number | null;
  ended: number | null;        // when the chain's last turn did; null while it runs
  secs: number | null;         // the parts summed; null when no part is known
  parts: number[];             // each turn's time in the chain, for the stacked bar
  status: Turn["status"];      // the chain's last turn: did the work finish
  outcome: string | null;      // why it failed, when its last turn did
  stopped: boolean;
  model: string | null;
  tools: number;
  waiting: "question" | "permission" | null;
  resumes: Resume[];
  subs: Sub[];
  ids: string[];               // every turn in the chain, for "which row am I reading"
}

const firstLine = (text: string) => text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
// The head of an answer as a line of plain text: its markdown marks would print raw.
const clean = (line: string) => line.replace(/^(#+|>|[-*+]|\d+[.)])\s+/, "").replace(/\*\*|__|`/g, "").trim();
// An option's "(Recommended)" is the model's tag on it, not part of what you chose.
const chosen = (label: string | null | undefined) => label ? label.replace(/\s*\(Recommended\)\s*$/i, "") : null;

/** A turn's outline: off its events when the chat holds them (current, and live
 *  while it runs), else off the bridge's summary (transcript_page.summarize). */
function outline(t: Turn) {
  let answer = "", tools = 0, ended: number | null = null, ran: number | null = null;
  let failed = t.status === "error", stopped = false;
  const subs: Sub[] = [];
  if (!t.events.length && t.sum) {
    for (const m of t.sum.marks)
      subs.push(m.kind === "steer"
        ? { kind: "steer", turnId: t.id, key: steerKey(m.i), label: m.label }
        : { kind: "question", turnId: t.id, key: m.id, label: m.label, pick: chosen(m.pick), note: m.note, open: false });
    return { answer: clean(t.sum.answer), tools: t.sum.tools, ended: t.sum.ended, ran, failed, stopped, subs };
  }
  const open = new Set(t.pending.filter((p) => p.kind === "question").map((p) => p.request_id));
  const asks = new Map<string, Extract<Sub, { kind: "question" }>>();
  let prose = "";
  // Counted as RunStream counts them for its anchors: without AskUserQuestion's
  // own tool row, which the question card stands in for.
  t.events.filter((e) => !(e.type === "tool" && e.name === "AskUserQuestion")).forEach((e, i) => {
    if (e.at != null) ended = e.at;
    if (e.type === "tool") tools++;
    else if (e.type === "text") prose = clean(firstLine(e.text)) || prose;
    else if (e.type === "result") {
      const line = clean(firstLine(e.result));
      if (line) answer = line;
      ran = e.elapsed;
      if (e.is_error) failed = true;
    } else if (e.type === "error") failed = true;
    else if (e.type === "stopped") stopped = true;
    else if (e.type === "question") {
      const q = e.questions[0];
      const s = { kind: "question" as const, turnId: t.id, key: e.request_id, label: q?.header || q?.question || "question",
                  pick: null as string | null, note: null as string | null, open: open.has(e.request_id) };
      asks.set(e.request_id, s);
      subs.push(s);
    } else if (e.type === "question_answered") {
      const s = asks.get(e.request_id);
      if (s) { s.pick = chosen(e.answers[0]?.labels[0]); s.note = e.answers[0]?.notes || null; }
    } else if (e.type === "steer") subs.push({ kind: "steer", turnId: t.id, key: steerKey(i), label: e.text });
  });
  // A native session's turns never carry a result: their answer is their prose.
  return { answer: answer || prose, tools, ended, ran, failed, stopped, subs };
}

/** How long a turn ran: the bridge's own figure, its result's, from its start to
 *  its last event when it was killed, or to `now` while it runs. */
function spanOf(t: Turn, o: ReturnType<typeof outline>, now: number): number | null {
  if (t.status === "running" && t.started != null) return Math.max(0, now - t.started);
  const s = t.elapsed ?? o.ran ?? (o.ended != null && t.started != null ? o.ended - t.started : null);
  return s == null ? null : Math.max(0, s);
}

/** The TURNS tab's rows: your prompts, numbered, each with the bridge's resumes
 *  of it — and any turn with no words of yours — folded in, the way the
 *  transcript joins a limit's resume to the turn it carries on. */
export function turnRows(turns: Turn[], now = Date.now() / 1000): TurnRow[] {
  const rows: TurnRow[] = [];
  for (const t of turns) {
    const o = outline(t);
    const secs = spanOf(t, o, now);
    const end = t.status === "running" ? null
      : t.started != null && secs != null ? t.started + secs : o.ended;
    const prompt = (t.prompt || "").replace(/\s+/g, " ").trim();
    const why = resumeOf(prompt);
    const waiting = t.pending[0]?.kind ?? null;
    const row = rows[rows.length - 1];
    if (row && (why || !prompt)) {
      if (why) { row.subs.push({ kind: "resume", turnId: t.id, why, at: t.started ?? null }); row.resumes.push(why); }
      row.subs.push(...o.subs);
      row.ids.push(t.id);
      row.parts.push(secs ?? 0);
      if (secs != null) row.secs = (row.secs ?? 0) + secs;
      row.tools += o.tools;
      if (o.answer) row.answer = o.answer;
      row.ended = end;
      row.status = o.failed ? "error" : t.status;
      row.outcome = o.failed ? t.outcome?.label ?? null : null;
      row.stopped = o.stopped;
      row.waiting = waiting;
      continue;
    }
    rows.push({
      id: t.id, n: rows.length + 1, prompt, answer: o.answer, started: t.started ?? null, ended: end,
      secs, parts: [secs ?? 0], status: o.failed ? "error" : t.status, outcome: o.failed ? t.outcome?.label ?? null : null,
      stopped: o.stopped, model: t.model ?? null, tools: o.tools, waiting, resumes: [], subs: o.subs, ids: [t.id],
    });
  }
  return rows;
}

export function fmtElapsed(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
