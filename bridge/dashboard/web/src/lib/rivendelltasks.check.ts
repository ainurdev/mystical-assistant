// Run: node --experimental-strip-types src/lib/rivendelltasks.check.ts  (from web/)
//
// What a RIVENDELL card says. Two things break quietly: a due date read in the
// wrong shape (Teamwork sends 20261002 as often as 2026-10-02) turning a late
// task into no date at all, and a request state mapped to the wrong action —
// OPEN SESSION with no session to open, or IMPLEMENT on a task already queued.
import { cardState, closeCode, dueLabel, groupTasks, initials, linkAlertText, linkChip, nextUp, resultBits, sentryPrompt, splitTitle, testText, workPrompt } from "./rivendelltasks.ts";

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

const tk = (id: string, mine: boolean, asks = false, status: string | null = null, name = id) => ({ id, mine, name,
  implementation: status ? { id: `r-${id}`, status, createdAt: "x", completedAt: null } : null,
  run: asks ? { ask: { job_id: "j", request_id: "q", at: null, question: "?", header: "h", options: [], simple: true } } : null }) as never;
const g = groupTasks([tk("a", true), tk("b", false, true, "IN_PROGRESS"), tk("c", false), tk("d", false, false, "PENDING"),
  tk("e", true, false, "IN_PROGRESS"), tk("f", false, false, "COMPLETED"), tk("h", true, false, "FAILED"),
  tk("i", false, false, "CANCELLED"), tk("j", false, false, null, "T28 — Cashflow ⏸️ (deferred to Phase 3)"),
  tk("k", false, false, "IN_PROGRESS", "T29 — Sync ⏸️ (deferred to Phase 3)")]);
eq([g.needs, g.running, g.done, g.mine, g.team, g.later].map((x: { id: string }[]) => x.map((t) => t.id)),
  [["b"], ["d", "e", "k"], ["f"], ["a", "h"], ["c", "i"], ["j"]],
  "by what each needs from you: a question, then runs in flight, then finished ones; a failed run stays with " +
  "its owner (RETRY); a deferred task waits in LATER — unless a run is already on it");

eq(splitTitle("T26 — Moneybird OAuth + connection storage"),
  { code: "T26", title: "Moneybird OAuth + connection storage", later: null }, "the code gets its own line");
eq(splitTitle("T28 — Cashflow data model + 12-week forecast service ⏸️ (deferred to Phase 3)"),
  { code: "T28", title: "Cashflow data model + 12-week forecast service", later: "Phase 3" },
  "the deferred marker sends it to LATER and leaves the title");
eq(splitTitle("Werkprogramma Financieel tab ↔️ Moneybird (invoices)"),
  { code: null, title: "Werkprogramma Financieel tab ↔ Moneybird (invoices)", later: null },
  "an emoji arrow reads as text, not a colour tile");
eq(splitTitle("Werkprogramma: next/back buttons navigate between module tabs").code, null,
  "a word before a colon is not a code");
eq(splitTitle("PR-12 – fix the build").code, "PR-12", "a hyphenated code and an en dash");
eq(splitTitle("Pause sync ⏸️").later, "later", "a bare ⏸ still defers");
eq(splitTitle("Investigate (deferred) jobs").later, null, "only a trailing marker defers");
eq(splitTitle("Bulk export (deferred)").later, "later", "a trailing (deferred) defers without the glyph");

const todo = { generatedAt: null, progress: null, items: [
  { id: "1", title: "Webhook", priority: "high", links: [{ type: "TASK", id: "t14", label: null, url: null }] },
  { id: "2", title: "Auto review", priority: "high", links: [{ type: "TASK", id: "t19", label: null, url: null },
    { type: "TASK", id: "gone", label: null, url: null }, { type: "TASK", id: "t28", label: null, url: null }] },
  { id: "3", title: "Prisma error", priority: "high", links: [{ type: "SENTRY_ISSUE", id: "o:9", label: "BACKEND-9", url: "https://s/9" }] },
  { id: "4", title: "Fourth", priority: "medium", links: [] },
] };
const nu = nextUp(todo, new Set(["t14", "t19", "t28"]));
eq(nu.map((i) => [i.id, i.tasks, i.sentry?.url ?? null]), [["1", ["t14"], null], ["2", ["t19", "t28"], null], ["3", [], "https://s/9"]],
  "the first three open items, each with the tasks it names that are open here, or its Sentry issue");
eq(nextUp(null, new Set()), [], "no todolist, no rows");

const task = { name: "T26 — Moneybird OAuth ⏸️", url: "https://rv/tasks/t26", htmlUrl: "https://tw/50998944" };
const spec = { number: 43, url: "https://github.com/o/r/issues/43", title: null, state: null, body: null };
eq(workPrompt(task, { description: "see #43", tasklist: null, createdBy: null, createdAt: null, estimateMinutes: null, tags: [], spec }),
  "Rivendell task: T26 — Moneybird OAuth ⏸\nSpec: https://github.com/o/r/issues/43\nTeamwork: https://tw/50998944 · Rivendell: https://rv/tasks/t26\n\n",
  "WORK ON IT names the task, where its spec lives and where it is tracked");
ok(workPrompt(task, { description: "Do the thing.", tasklist: null, createdBy: null, createdAt: null, estimateMinutes: null, tags: [], spec: null })
  .includes("\n\nDo the thing.\n"), "with no spec link, the description itself goes in");
ok(workPrompt(task, null).startsWith("Rivendell task: "), "and it still works before the peek has loaded");
eq(sentryPrompt("Prisma error", { label: "BACKEND-9", url: "https://s/9" }),
  "Sentry issue BACKEND-9: https://s/9\nOn Rivendell's todolist: Prisma error\n\n", "FIX IT names the issue and why");

ok(linkAlertText({ name: "production", status: st({ state: "auth_error" }) }).includes("refused this bridge's token"),
  "the bell names a rejected token");
ok(linkAlertText({ name: "production", status: st({ state: "error" }) }).includes("unreachable"),
  "and an outage");

eq(testText(null), "never tested", "no test yet");
eq(testText({ ok: true, rtt_ms: 182, detail: "", at: 1 }), "✓ round trip 182 ms", "a pong");
eq(testText({ ok: false, rtt_ms: null, detail: "no pong in 5s", at: 1 }), "✕ no pong in 5s", "no pong");
eq(testText({ ok: null, rtt_ms: null, detail: "re-dialing with the saved token", at: 1 }),
  "↻ re-dialing with the saved token", "a parked token re-dials");
