// Run: node --experimental-strip-types src/lib/rivendelltasks.check.ts  (from web/)
//
// What a RIVENDELL card says. Two things break quietly: a due date read in the
// wrong shape (Teamwork sends 20261002 as often as 2026-10-02) turning a late
// task into no date at all, and a request state mapped to the wrong action —
// OPEN SESSION with no session to open, or IMPLEMENT on a task already queued.
import { cardState, closeCode, dueLabel, groupTasks, initials, linkAlertText, linkChip, resultBits, testText } from "./rivendelltasks.ts";

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

import type { RivendellStatus } from "../api";

// --- the channel (docs/superpowers/specs/rivendell-channel.md) ---
const nowS = today.getTime() / 1000;
const st = (s: Partial<RivendellStatus>) => ({ state: "off", ...s }) as RivendellStatus;

eq(linkChip(st({ state: "connected", last_event_at: nowS - 12 * 60 }), today), { label: "LINKED · 12m", tone: "ok" },
  "linked names the time since the last job");
eq(linkChip(st({ state: "connected" }), today), { label: "LINKED", tone: "ok" }, "no job seen since the restart: just LINKED");
eq(linkChip(st({ state: "connecting" }), today), { label: "CONNECTING…", tone: "warn" }, "dialing");
eq(linkChip(st({ state: "error", attempt: 3, retry_at: nowS + 20 }), today), { label: "RETRY 3 · 20s", tone: "warn" },
  "retrying counts the attempt and the wait");
eq(linkChip(st({ state: "auth_error" }), today), { label: "TOKEN REJECTED", tone: "err" }, "a rejected token is its own red state");
eq(linkChip(undefined, today), { label: "OFF", tone: "off" }, "no worker: OFF");

eq(closeCode("token rejected by gateway (4401 Invalid or revoked token)"), "4401", "the gateway's close code");
eq(closeCode("token rejected at handshake: HTTP/1.1 401 Unauthorized"), "401", "a proxy's status");
eq(closeCode("connection refused"), null, "no code, no badge");

eq(resultBits({ wall_s: 38 * 60, tokens: { in: 1_150_000, out: 50_000 },
  pr: { number: 128, url: "https://github.com/a/b/pull/128", checks: "pass" }, outcome: null }),
  { pr: { label: "PR #128", url: "https://github.com/a/b/pull/128", checks: "✓ checks" }, rest: "38m · 1.20M tok", outcome: null },
  "done: PR, checks, time, tokens");
eq(resultBits({ wall_s: 1260, tokens: null, pr: null,
  outcome: { code: "timeout", label: "KILLED AS HUNG", detail: "no output for 30 min" } })?.outcome,
  "KILLED AS HUNG — no output for 30 min", "failed: the transcript's own outcome label");
eq(resultBits(null), null, "no session here: no line");

const tk = (id: string, mine: boolean, asks = false) => ({ id, mine,
  run: asks ? { ask: { job_id: "j", request_id: "q", at: null, question: "?", header: "h", options: [], simple: true } } : null }) as never;
const g = groupTasks([tk("a", true), tk("b", false, true), tk("c", false)]);
eq([g.needs, g.mine, g.team].map((x: { id: string }[]) => x.map((t) => t.id)), [["b"], ["a"], ["c"]],
  "a question jumps the list; the rest stay mine / team");

ok(linkAlertText({ name: "production", status: st({ state: "auth_error" }) }).includes("refused this bridge's token"),
  "the bell names a rejected token");
ok(linkAlertText({ name: "production", status: st({ state: "error" }) }).includes("unreachable"),
  "and an outage");

eq(testText(null), "never tested", "no test yet");
eq(testText({ ok: true, rtt_ms: 182, detail: "", at: 1 }), "✓ round trip 182 ms", "a pong");
eq(testText({ ok: false, rtt_ms: null, detail: "no pong in 5s", at: 1 }), "✕ no pong in 5s", "no pong");
eq(testText({ ok: null, rtt_ms: null, detail: "re-dialing with the saved token", at: 1 }),
  "↻ re-dialing with the saved token", "a parked token re-dials");
