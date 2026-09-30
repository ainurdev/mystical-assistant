// Run: node --experimental-strip-types src/lib/rivendelltasks.check.ts  (from web/)
//
// What a RIVENDELL card says. Two things break quietly: a due date read in the
// wrong shape (Teamwork sends 20261002 as often as 2026-10-02) turning a late
// task into no date at all, and a request state mapped to the wrong action —
// OPEN SESSION with no session to open, or IMPLEMENT on a task already queued.
import { cardState, dueLabel, initials } from "./rivendelltasks.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const eq = (got: unknown, want: unknown, what: string) =>
  ok(JSON.stringify(got) === JSON.stringify(want), `${what} — got ${JSON.stringify(got)}`);

// Wednesday 2026-09-30, mid-afternoon local time.
const today = new Date(2026, 8, 30, 15, 0);

eq(dueLabel(null, today), null, "no due date, no label");
eq(dueLabel("soon", today), null, "an unreadable date is no label, not NaN");
eq(dueLabel("2026-09-28", today), { text: "2d late", tone: "late" }, "two days past is late");
eq(dueLabel("20260928", today), { text: "2d late", tone: "late" }, "Teamwork's compact form reads the same");
eq(dueLabel("2026-09-30T23:00:00Z", today)?.text, "due today", "an ISO stamp counts by its calendar day");
eq(dueLabel("2026-10-02", today), { text: "due Fri", tone: "soon" }, "this week names the weekday");
eq(dueLabel("2026-10-09", today), { text: "due Oct 9", tone: "" }, "further out names the date, quietly");

const t = (implementation: unknown, session_id: string | null = null) =>
  ({ implementation, session_id }) as never;
const req = (status: string, createdAt = "2026-09-30T14:48:00", completedAt: string | null = null) =>
  ({ id: "r1", status, createdAt, completedAt });

eq(cardState(t(null), today).action, "implement", "never implemented: IMPLEMENT");
eq(cardState(t(req("CANCELLED")), today).action, "implement", "a cancelled request is as good as none");
eq(cardState(t(req("PENDING")), today), { line: "◷ QUEUED", tone: "warn", action: null },
  "queued: say so, offer nothing (a second click would queue a second run)");
eq(cardState(t(req("IN_PROGRESS")), today), { line: "● RUNNING · 12m", tone: "acc", action: null },
  "running elsewhere: no session to open");
eq(cardState(t(req("IN_PROGRESS"), "s1"), today).action, "open", "running here: OPEN SESSION");
eq(cardState(t(req("COMPLETED", "2026-09-30T10:00:00", "2026-09-30T13:00:00")), today),
  { line: "✓ DONE · 2h ago", tone: "ok", action: "again" }, "done: its age from completion, RUN AGAIN");
eq(cardState(t(req("FAILED", "2026-09-30T14:59:40", "2026-09-30T14:59:50")), today),
  { line: "✕ FAILED · just now", tone: "err", action: "retry" }, "failed a moment ago: RETRY");

eq(initials("Mahdi Pourismaiel"), "MP", "two names, two letters");
eq(initials("erfan"), "E", "one name, one letter, upper-cased");
eq(initials("  "), "?", "no name is a question mark, not an empty circle");
