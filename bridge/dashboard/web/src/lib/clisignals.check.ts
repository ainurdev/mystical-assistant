// Run: node bridge/dashboard/web/src/lib/clisignals.check.ts
// Claude Code's own signals as the dashboard tells them: background tasks after
// an answer, a retry's live line, a login's meter tone, freshness and running-low
// window, and the seam where a turn a bridge restart cut was carried on.
import type { SessionStatus, TimedEvent } from "../api.ts";
import type { Turn } from "../chat.ts";
import type { Window } from "../models.ts";
import { CONTINUED } from "./checkpoints.ts";
import {
  bgView, freshness, lowWindow, meterTone, readAgo, retries, retrying, retryLine, retryWhy, seamOf, windowWord,
} from "./clisignals.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const eq = (got: unknown, want: unknown, what: string) =>
  ok(JSON.stringify(got) === JSON.stringify(want), `${what} — got ${JSON.stringify(got)}`);

// --- row 1: background --------------------------------------------------------
const bg = (over: Partial<SessionStatus>): SessionStatus =>
  ({ state: "background", kind: null, source: "bridge", label: "answered — 2 in background", since: 1300, ...over });
const tasks = [
  { id: "a", type: "shell" as const, desc: "watch-mode run", since: 1000 },
  { id: "b", type: "agent" as const, desc: "e2e on Postgres 16", since: 1100 },
];
eq(bgView(bg({ bg: tasks, peak: 2 })), { n: 2, desc: "e2e on Postgres 16", frac: 0, oldest: 1000, since: 1300 },
  "two live of two: the newest task's words, an empty bar, the oldest's age, the answer's clock");
eq(bgView(bg({ bg: tasks.slice(0, 1), peak: 4 }))?.frac, 0.75, "one left of four that ran: the bar is three quarters");
eq(bgView(bg({ bg: tasks, peak: undefined }))?.frac, 0, "no peak from the bridge: the live count stands in");
eq(bgView(bg({ bg: [] })), null, "nothing listed: nothing to say");
eq(bgView({ ...bg({ bg: tasks }), state: "working" }), null, "a working session is not a background one");
eq(bgView(null), null, "no status");

// --- row 2: retries -----------------------------------------------------------
const retry = (attempt: number, at?: number, error = "overloaded", delay_ms = 30_000): TimedEvent =>
  ({ type: "retry", attempt, max: 10, delay_ms, error, ...(at === undefined ? {} : { at }) });
const text: TimedEvent = { type: "text", text: "on it", at: 100 };
eq(retrying([text, retry(1, 200), retry(2, 230)])?.since, 200, "a run of retries counts from its first");
eq(retrying([text, retry(1, 200), retry(2, 230)])?.e.attempt, 2, "the line reads the newest try");
eq(retrying([retry(1, 200), text]), null, "anything after the retry means a try got through");
eq(retrying([]), null, "no events");
eq(retries([retry(1, 1), text, retry(2, 2), retry(3, 3)]), 3, "every retry in the turn counts for the plate");
eq(retryLine(retry(3, 100) as never, 106), { what: "try 3 of 10", note: "API overloaded · next try in 24 s", left: 24, frac: 0.8 },
  "try, why, and the seconds to the next one; the ring holds what's left of the wait");
eq(retryLine(retry(3, 100) as never, 140).note, "API overloaded · trying again", "past the wait it is trying again");
eq(retryLine(retry(3, 100) as never, 140).frac, 0, "and the ring is empty");
eq(retryLine({ ...retry(1, undefined, "connection", 2000), max: 0 } as never, 500),
  { what: "try 1", note: "no response · next try in 2 s", left: 2, frac: 1 }, "an unstamped retry counts from now; no max, no 'of'");
eq(["overloaded", "overloaded_error", "http_529", "rate_limit", "server_error", "http_502", "connection", "http_400", "weird_thing", ""].map(retryWhy),
  ["API overloaded", "API overloaded", "API overloaded", "rate limited", "server error", "server error", "no response", "HTTP 400", "weird thing", "request failed"],
  "the CLI's error classes in plain words");

// --- rows 2 and 3: the meter --------------------------------------------------
eq([meterTone(37, "normal"), meterTone(9, "warning"), meterTone(9, "normal", "allowed_warning"), meterTone(0, "normal"),
    meterTone(4, "exceeded"), meterTone(40, "normal", "rejected")],
  ["var(--acc)", "var(--warn)", "var(--warn)", "var(--err)", "var(--err)", "var(--err)"],
  "accent, amber at the warning, red when spent or refused");
const w = (tag: string, left: number, severity = "normal"): Window =>
  ({ tag, name: tag, left, severity, resets: "", resets_at: null });
eq(lowWindow([w("5H", 9, "warning"), w("WK", 60)])?.tag, "5H", "the window the CLI marks low");
eq(lowWindow([w("5H", 40), w("WK", 12, "warning")])?.tag, "WK", "the weekly one when it's the low one");
eq(lowWindow([w("5H", 40), w("WK", 30)], "allowed_warning")?.tag, "WK", "a turn's warning names the tightest window");
eq(lowWindow([w("5H", 40), w("WK", 30)]), null, "nothing low");
eq(lowWindow([w("5H", 0, "exceeded"), w("WK", 30, "warning")]), null, "a spent window is the out pill's, not this one's");
eq([windowWord(w("5H", 1)), windowWord(w("WK", 1))], ["5-hour", "weekly"], "how the pill names a window");
eq([readAgo(1000, 1030), readAgo(1000, 1000 + 6 * 60 + 5), readAgo(1000, 1000 + 7300), readAgo(1000, 1000 + 2 * 86400)],
  ["just now", "6 min ago", "2 h ago", "2 d ago"], "how long ago a meter was read");
const acct = (over: object) => ({ left: 63, disabled: false, live: false, read_at: 1000, ...over });
eq(freshness(acct({ live: true }), 2000, null), { k: "live", text: "live" }, "a running turn reports it: live");
eq(freshness(acct({ live: true }), 2000, 0), { k: "live", text: "live" }, "live stays live through a Check now");
eq(freshness(acct({}), 1360, null), { k: "ago", text: "6 min ago" }, "idle: when it was read");
eq(freshness(acct({ left: null, read_at: null }), 1360, null), { k: "checking", text: "checking" }, "no reading yet: checking");
eq(freshness(acct({}), 1360, 60)?.k, "checking", "the menu's fresh=60 is redoing a 6-minute-old reading");
eq(freshness(acct({}), 1030, 60)?.k, "ago", "a reading younger than the threshold isn't redone");
eq(freshness(acct({ disabled: true }), 1360, null), null, "a switched-off login says nothing");

// --- row 7: the seam ----------------------------------------------------------
const turn = (id: string, prompt: string, over: Partial<Turn> = {}): Turn =>
  ({ id, prompt, events: [], status: "done", pending: [], started: 1000, ...over });
const cut = turn("a", "bump the pin", { status: "error", events: [{ type: "tool", name: "Bash", summary: "pytest", at: 1400 }] });
const at = (t: number): TimedEvent => ({ type: "thinking", ms: 900, at: t });
eq(seamOf(cut, turn("b", CONTINUED, { started: 1500, status: "running", events: [] })),
  { k: "picking", at: 1500, lead: "Bridge restarted at", rest: "Claude Code is picking the turn back up…" },
  "running with nothing back yet: picking up");
eq(seamOf(cut, turn("b", CONTINUED, { started: 1500, status: "running", events: [at(1509)] })),
  { k: "carried", at: 1500, lead: "Bridge restarted at", rest: "Claude Code picked the turn up 9 s later" },
  "its first event, 9 s after the restart");
eq(seamOf(cut, turn("b", CONTINUED, { started: 1500, events: [at(1650)] }))?.rest,
  "Claude Code picked the turn up 3 min later", "a slow pick-up in minutes");
eq(seamOf(cut, turn("b", CONTINUED, { started: 1500, events: [{ type: "resume", declined: true, at: 1560 }] })),
  { k: "declined", at: 1400, lead: "Cut by a bridge restart at", rest: "Claude Code didn't pick it up" },
  "declined: the time is the cut's");
eq(seamOf(cut, turn("b", CONTINUED, { started: 1400 + 7 * 3600, events: [{ type: "resume", declined: true }] }))?.rest,
  "too old for Claude Code to carry on (over 6 h)", "cut more than 6 h before: too old");
eq(seamOf(cut, turn("b", CONTINUED, { started: 1500, status: "done", events: [] }))?.k, "declined",
  "ended with nothing said: not picked up");
eq(seamOf(turn("x", "go", { started: 900 }), turn("b", CONTINUED, { started: 1500, events: [{ type: "resume", declined: true }] }))?.at,
  900, "a cut turn with no events times from its start");
eq(seamOf(cut, turn("b", "bump the pin again")), null, "your own prompt is no seam");
