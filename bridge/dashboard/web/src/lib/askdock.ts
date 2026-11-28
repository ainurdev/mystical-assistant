import type { AllowScope, Question } from "../api";
import type { Turn } from "../chat";
import { askBack, type AskBack } from "./askback.ts";

/** What the open session waits on you for, docked on the prompt box
 *  (components/AskDock; .mystical/design-drafts/response-cards, C · DOCK). One
 *  at a time: the turn's first open card, or — once a turn is done — the
 *  question its answer ended on. The transcript keeps a marker where it was
 *  asked, so the dock is the only place it can be answered. */
export type Docked =
  | { kind: "question"; turnId: string; requestId: string; questions: Question[]; at?: number; of: number }
  | { kind: "permission"; turnId: string; requestId: string; tool: string; summary: string; detail?: string; scopes?: AllowScope[]; at?: number; of: number }
  | { kind: "secret"; turnId: string; requestId: string; name: string; why: string; at?: number; of: number }
  | { kind: "prose"; turnId: string; ask: AskBack; at?: number };

/** `prose` is off where a reply makes no sense: a job whose answer is drawn as
 *  its artifact, or a turn whose ask you already dropped. */
export function docked(turns: Turn[], prose: boolean): Docked | null {
  const last = turns[turns.length - 1];
  if (!last) return null;
  if (last.status === "running") {
    const ids = new Set(last.pending.map((p) => p.request_id));
    const open = last.events.filter((e) => (e.type === "question" || e.type === "permission" || e.type === "secret_request") && ids.has(e.request_id));
    const e = open[0];
    if (e?.type === "question")
      return { kind: "question", turnId: last.id, requestId: e.request_id, questions: e.questions, at: e.at, of: open.length };
    if (e?.type === "permission")
      return { kind: "permission", turnId: last.id, requestId: e.request_id, tool: e.tool_name, summary: e.summary, detail: e.detail, scopes: e.scopes, at: e.at, of: open.length };
    if (e?.type === "secret_request")
      return { kind: "secret", turnId: last.id, requestId: e.request_id, name: e.name, why: e.why, at: e.at, of: open.length };
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

// A sentence ends at . ! ? then the end or a space and a word that isn't lower case: "8.4", "index.ts" and "e.g. the" go on.
const sentences = (q: string) => q.match(/(?:[^.!?\n]|[.!?](?![.!?]*["')\]]*(?:\s+[^a-z\s]|\s*$)))+(?:[.!?]+["')\]]*|\n+|$)\s*/g) ?? [q];

/** A question as the dock reads it: the last sentence ending in "?" is the ask,
 *  what comes before it is context, what follows it a hint ("Pick any, or
 *  none."). Claude front-loads context, so the ask was the line people missed. */
export function splitAsk(q: string): { ctx: string; ask: string; tail: string } {
  const parts = sentences(q);
  let at = -1;
  parts.forEach((p, i) => { if (/\?["')\]]*\s*$/.test(p)) at = i; });
  if (at < 0) return { ctx: "", ask: q.trim(), tail: "" };
  return { ctx: parts.slice(0, at).join("").trim(), ask: parts[at].trim(), tail: parts.slice(at + 1).join("").trim() };
}

export type DescBlock = { p: string } | { items: { mark: string; text: string }[] };

// A list marker at the start, after a sentence or clause end, or on its own line:
// "#38:", "1." / "1)", "A:" / "A)", and "- " / "* " / "•" lines.
const MARK = /(?<=^|[.!?:;]\s+|\n)[ \t]*(#\d+:|\d+[.)]|[A-Z][:)]|[-*•])[ \t]+/g;
const kindOf = (m: string) => m[0] === "#" ? "#" : /\d/.test(m[0]) ? "1" : /[A-Z]/.test(m[0]) ? "A" : "•";

/** The text around the ask, as the dock's rail draws it (.mystical/design-drafts/
 *  ask-description, B · RAIL): an enumeration Claude ran into one line ("#38: …
 *  #18: …") becomes one item each, prose a paragraph per two sentences. A list
 *  needs two markers of one kind, and 1, 2, 3 / A, B, C in order, so "since v2.
 *  Then 7. fails" stays prose. */
export function descBlocks(text: string): DescBlock[] {
  return text.split(/\n[ \t]*\n/).map((x) => x.trim()).filter(Boolean).flatMap((para): DescBlock[] => {
    const all = [...para.matchAll(MARK)];
    const kind = all[0] && kindOf(all[0][1]);
    const ms = all.filter((m) => kindOf(m[1]) === kind);
    const seq = kind === "1" ? ms.every((m, i) => parseInt(m[1]) === parseInt(ms[0][1]) + i)
      : kind === "A" ? ms.every((m, i) => m[1].charCodeAt(0) === ms[0][1].charCodeAt(0) + i) : true;
    if (ms.length < 2 || !seq) {
      const ss = sentences(para);
      const out: DescBlock[] = [];
      for (let i = 0; i < ss.length; i += 2) {
        // A lone last sentence joins the paragraph before it.
        const n = ss.length - i === 3 ? 3 : 2;
        out.push({ p: ss.slice(i, i + n).join("").trim() });
        i += n - 2;
      }
      return out;
    }
    const lead = para.slice(0, ms[0].index).trim();
    const items = ms.map((m, i) => ({
      mark: kind === "•" ? "•" : m[1].replace(/[:.)]$/, ""),
      text: para.slice(m.index! + m[0].length, ms[i + 1]?.index ?? para.length).replace(/\s*\n\s*/g, " ").trim(),
    }));
    return lead ? [{ p: lead }, { items }] : [{ items }];
  });
}

export type DescBit = { t: string } | { code: string } | { b: string } | { crumb: true } | { gloss: string };

/** One line of the rail: `code` and short quoted literals (a digit or symbol in
 *  them: "name · 18-01-4", never a quoted sentence) as chips, **bold**,
 *  a "›" crumb, and the English gloss after a crumb path ("Proces › Betalen
 *  (process › payment)") dimmed. Any other "(…)" is the sentence's own. */
export function descInline(s: string): DescBit[] {
  const out: DescBit[] = [];
  const text = (t: string) => { const l = out[out.length - 1]; if (l && "t" in l) l.t += t; else out.push({ t }); };
  let at = 0;
  for (const m of s.matchAll(/`([^`\n]+)`|\*\*([^*\n]+)\*\*|(?<=^|[\s(])"([^"\n]{1,40})"(?!\w)|(?<=^|[\s(])“([^”\n]{1,40})”|\s*›\s*|\([^()\n]*\)/g)) {
    if (m.index! > at) text(s.slice(at, m.index));
    at = m.index! + m[0].length;
    const [w, code, b, q1, q2] = m;
    const l = out[out.length - 1], l2 = out[out.length - 2];
    const quoted = q1 ?? q2;
    if (code || (quoted && /[^\p{L}\s'’,.!?]/u.test(quoted))) out.push({ code: (code ?? quoted)! });
    else if (b) out.push({ b });
    else if (w.trim() === "›") out.push({ crumb: true });
    else if (w.includes("›") || (l && "t" in l && /^\S+\s*$/.test(l.t) && l2 && "crumb" in l2)) out.push({ gloss: w });
    else text(w);
  }
  if (at < s.length) text(s.slice(at));
  return out;
}

/** "waiting · 2m" for a card asked at epoch seconds `at`. */
export function waited(at: number | undefined, now = Date.now() / 1000): string {
  if (!at) return "";
  const s = Math.max(0, Math.round(now - at));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}
