import type { Question } from "../api";
import type { Turn } from "../chat";
import { askBack, type AskBack } from "./askback.ts";

/** What the open session waits on you for, docked on the prompt box
 *  (components/AskDock; .mystical/design-drafts/response-cards, C · DOCK). One
 *  at a time: the turn's first open card, or — once a turn is done — the
 *  question its answer ended on. The transcript keeps a marker where it was
 *  asked, so the dock is the only place it can be answered. */
export type Docked =
  | { kind: "question"; turnId: string; requestId: string; questions: Question[]; at?: number; of: number }
  | { kind: "permission"; turnId: string; requestId: string; tool: string; summary: string; detail?: string; at?: number; of: number }
  | { kind: "prose"; turnId: string; ask: AskBack; at?: number };

/** `prose` is off where a reply makes no sense: a job whose answer is drawn as
 *  its artifact, or a turn whose ask you already dropped. */
export function docked(turns: Turn[], prose: boolean): Docked | null {
  const last = turns[turns.length - 1];
  if (!last) return null;
  if (last.status === "running") {
    const ids = new Set(last.pending.map((p) => p.request_id));
    const open = last.events.filter((e) => (e.type === "question" || e.type === "permission") && ids.has(e.request_id));
    const e = open[0];
    if (e?.type === "question")
      return { kind: "question", turnId: last.id, requestId: e.request_id, questions: e.questions, at: e.at, of: open.length };
    if (e?.type === "permission")
      return { kind: "permission", turnId: last.id, requestId: e.request_id, tool: e.tool_name, summary: e.summary, detail: e.detail, at: e.at, of: open.length };
    return null;
  }
  if (!prose || last.status !== "done") return null;
  const res = [...last.events].reverse().find((e) => e.type === "result");
  // Same exclusions as the answer box (RunStream FinalResult): an error, or the
  // CLI's "Unknown command:" that exits clean, asks nothing.
  if (res?.type !== "result" || res.is_error || res.result.startsWith("Unknown command:")) return null;
  const ask = askBack(res.result);
  return ask ? { kind: "prose", turnId: last.id, ask, at: res.at } : null;
}

/** A question as the dock reads it: the last sentence ending in "?" is the ask,
 *  what comes before it is context, what follows it a hint ("Pick any, or
 *  none."). Claude front-loads context, so the ask was the line people missed. */
export function splitAsk(q: string): { ctx: string; ask: string; tail: string } {
  const parts = q.match(/[^.!?\n]+(?:[.!?]+["')\]]*|\n+|$)\s*/g) ?? [q];
  let at = -1;
  parts.forEach((p, i) => { if (/\?["')\]]*\s*$/.test(p)) at = i; });
  if (at < 0) return { ctx: "", ask: q.trim(), tail: "" };
  return { ctx: parts.slice(0, at).join("").trim(), ask: parts[at].trim(), tail: parts.slice(at + 1).join("").trim() };
}

/** "waiting · 2m" for a card asked at epoch seconds `at`. */
export function waited(at: number | undefined, now = Date.now() / 1000): string {
  if (!at) return "";
  const s = Math.max(0, Math.round(now - at));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}
