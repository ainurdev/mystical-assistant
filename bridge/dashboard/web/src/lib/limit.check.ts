// Run: node bridge/dashboard/web/src/lib/limit.check.ts
// The limit sentence's window and refill, the bridge's carry-on turns, and the
// login a dry one hands over to.
import type { AccountInfo } from "../api.ts";
import { limitNudge, limitResets, limitWindow, loginName, otherLogin, span } from "./limit.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const eq = (got: unknown, want: unknown, what: string) =>
  ok(JSON.stringify(got) === JSON.stringify(want), `${what} — got ${JSON.stringify(got)}`);

// --- the window ---------------------------------------------------------------
eq(limitWindow("You've hit your session limit · resets 12:30am (Asia/Yerevan)"), "5-hour", "session is the 5-hour window");
eq(limitWindow("You've hit your weekly limit · resets Oct 28, 4pm (Asia/Yerevan)"), "weekly", "weekly");
eq(limitWindow("You've hit your Opus limit · resets Oct 28, 4pm"), "Opus", "a model's own cap keeps its name");
eq(limitWindow("You've hit your Fable 5 limit"), "Fable 5", "a model with a number in it");
eq(limitWindow("You've hit your org's monthly usage limit"), "monthly", "an org's monthly cap");
eq(limitWindow("Claude AI usage limit reached|1729000000"), "", "an old CLI doesn't say");
eq(limitWindow("You've reached your usage limit"), "", "neither does a bare usage limit");

// --- the refill ---------------------------------------------------------------
eq(limitResets("You've hit your session limit · resets 12:30am (Asia/Yerevan)"), { h: 0, m: 30 }, "12:30am is half past midnight");
eq(limitResets("resets 4pm (Asia/Yerevan)"), { h: 16, m: 0 }, "an hour with no minutes");
eq(limitResets("resets 12pm"), { h: 12, m: 0 }, "noon");
eq(limitResets("You've hit your weekly limit · resets Oct 28, 4pm (Asia/Yerevan)"), { h: 16, m: 0, day: "Oct 28" }, "a date rides along");
eq(limitResets("Claude AI usage limit reached|1729000000"), null, "no refill in the sentence");

// --- the bridge's carry-on turns ----------------------------------------------
const ACCOUNT = "⏮ Your previous turn was cut off because the Claude usage limit was reached — not by the user. It has been resumed on another account. Review your recent transcript and continue exactly where you left off; finish the task you were doing. Don't start over.";
const RESET = "⏮ Your previous turn was cut off because the Claude usage limit was reached — not by the user. The limit has reset. Review your recent transcript and continue exactly where you left off; finish the task you were doing. Don't start over.";
const RESTART = "⏮ You were interrupted mid-task by a bridge restart — not by the user. Review your recent transcript and continue exactly where you left off; finish the task you were doing. Don't start over.";
eq(limitNudge(ACCOUNT), "account", "another login took the work");
eq(limitNudge(RESET), "reset", "the window refilled");
eq(limitNudge(RESTART), null, "a restart's nudge isn't a limit's");
eq(limitNudge("the usage limit was reached, can you check?"), null, "your own words never are");
eq(limitNudge(null), null, "no prompt");

// --- the login to offer -------------------------------------------------------
const acct = (slot: number, left: number | null, more: Partial<AccountInfo> = {}) =>
  ({ slot, email: `a${slot}@x.y`, alias: null, disabled: false, default: slot === 1, left, resets_at: null,
     five_hour: null, seven_day: null, ...more }) as AccountInfo;
eq(otherLogin([acct(1, 0), acct(2, 85), acct(3, 40)], 1)?.slot, 2, "the one with the most left");
eq(otherLogin([acct(1, 0), acct(2, null), acct(3, 40)], 1)?.slot, 3, "a known meter beats an unreadable one");
eq(otherLogin([acct(1, 0), acct(2, null)], 1)?.slot, 2, "an unreadable meter is the last resort, not a skip");
eq(otherLogin([acct(1, 0), acct(2, 0)], 1), null, "nobody has room");
eq(otherLogin([acct(1, 0), acct(2, 85, { disabled: true }), acct(3, 50, { logged_in: false } as Partial<AccountInfo>)], 1), null,
  "a switched-off or signed-out login is never offered");
eq(loginName(acct(2, 85, { alias: "work" }), 2), "work", "an alias wins");
eq(loginName(acct(2, 85), 2), "a2@x.y", "then the email");
eq(loginName(undefined, 2), "account 2", "then the slot");

// --- spans --------------------------------------------------------------------
eq([span(43 * 60), span(103 * 60), span(26 * 3600), span(-5)], ["43m", "1h 43m", "1d 2h", "0m"], "minutes, hours, days");
