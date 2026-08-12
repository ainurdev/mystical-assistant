// Copy of the dashboard's src/lib/askback.ts — same two-app duplication as the
// RunStream/Composer pair. Checked there: dashboard/web/src/lib/askback.check.ts.
/** The model ended its answer with a question in prose instead of an
 *  AskUserQuestion card. Split that question off so the transcript can highlight
 *  it, and guess the replies it was waiting for so answering is one tap. */
export interface AskBack {
  /** Everything before the question — still the body of the result. */
  body: string;
  question: string;
  /** Suggested replies, empty when the question is open-ended. */
  options: string[];
}

// "Want me to X, or Y?" — the only shape we trust enough to split into two
// alternatives. Anything else that opens yes/no-ish gets Yes/No.
const ACT = /^(?:so[,]?\s+)?(?:do you want me to|would you like me to|want me to|should i|shall i|can i|may i)\s+/i;
// A wh-question wants an answer in your own words. Anything else closing a turn
// is a yes/no — including the bare imperatives ("Commit it now?") that no
// auxiliary leads, which used to get no chips at all and had to be typed out.
const OPEN = /^(?:so[,]?\s+)?(?:what|which|where|when|who|whom|whose|why|how)\b/i;
// A chip carrying half a paragraph is worse than no chip.
const MAX_OPT = 64;

/** Start of the last sentence — a sentence end followed by space, or a line
 *  break (a question is often its own bullet or paragraph). */
function questionStart(t: string): number {
  const re = /(?:[.!?:]["'`)\]]*\s+|\n)/g;
  let start = 0;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const end = m.index + m[0].length;
    if (end < t.length) start = end;
  }
  return start;
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
// Chips are plain text — backticks and list bullets are markdown, not an answer.
const alt = (s: string) => s.replace(/`/g, "").replace(/^[-*\s]+/, "").replace(/[\s,.;]+$/, "").trim();

function optionsFor(question: string): string[] {
  const core = question.replace(/\?+\s*$/, "").trim();
  const lead = ACT.exec(core);
  if (lead) {
    const rest = core.slice(lead[0].length);
    const i = rest.toLowerCase().lastIndexOf(" or ");
    if (i > 0) {
      const a = alt(rest.slice(0, i));
      const b = alt(rest.slice(i + 4));
      if (a && b && a.length <= MAX_OPT && b.length <= MAX_OPT) return [cap(a), cap(b)];
    }
    return ["Yes", "No"];
  }
  return OPEN.test(core) ? [] : ["Yes", "No"];
}

export function askBack(text: string): AskBack | null {
  const t = text.replace(/\s+$/, "");
  if (!t.endsWith("?")) return null;
  const cut = questionStart(t);
  // Keep the question's own markdown — it renders; only a list bullet goes.
  const question = t.slice(cut).replace(/^[-*>\s]+/, "").trim();
  // A whole paragraph ending in "?" is rhetorical or a heading, not an ask.
  if (!question.endsWith("?") || question.length > 240) return null;
  return { body: t.slice(0, cut).replace(/\s+$/, ""), question, options: optionsFor(question) };
}
