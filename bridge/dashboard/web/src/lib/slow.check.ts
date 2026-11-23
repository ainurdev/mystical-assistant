// Run: node bridge/dashboard/web/src/lib/slow.check.ts
// The slow-spot rules (lib/slow.ts): the limits, and the caps (lib/reports.ts).
import assert from "node:assert/strict";
import type { ErrorEvent } from "@sentry/browser";
import { frameSpot, inputSpot, startupSpot } from "./slow.ts";
import { options } from "./reports.ts";

// input: over 100 ms to the next paint, a click or a key only, named by its control and never its text
const button = { tagName: "BUTTON", textContent: "Delete Elvou", getAttribute: (n: string) => (n === "data-ctx-type" ? "session" : null) };
assert.equal(inputSpot({ name: "click", duration: 100, target: button }), null);
const slow = inputSpot({ name: "click", duration: 104, target: button })!;
assert.equal(slow.name, "input: click");
assert.equal(slow.context.control, "button [session]");
assert.ok(!JSON.stringify(slow).includes("Elvou"));
assert.equal(inputSpot({ name: "keydown", duration: 300 })!.name, "input: keydown");
assert.equal(inputSpot({ name: "mouseover", duration: 300 }), null);
assert.equal(inputSpot({ name: "pointerenter", duration: 300 }), null);

// frame: over 150 ms, with the longest scripts it names, and the input it came after where there was one
assert.equal(frameSpot({ duration: 150 }), null);
const frame = frameSpot({ duration: 208, scripts: [
  { invoker: "TimerHandler:setTimeout", sourceURL: "http://127.0.0.1:8790/assets/index-a.js", sourceFunctionName: "tick", duration: 12 },
  { invoker: "BUTTON.onclick", sourceURL: "http://127.0.0.1:8790/assets/index-a.js", sourceFunctionName: "hold", duration: 190.4 },
] })!;
assert.equal(frame.name, "frame");
assert.equal(frame.ms, 208);
assert.deepEqual(frame.context.scripts, [
  "BUTTON.onclick hold @ http://127.0.0.1:8790/assets/index-a.js (190 ms)",
  "TimerHandler:setTimeout tick @ http://127.0.0.1:8790/assets/index-a.js (12 ms)",
]);
assert.equal(frameSpot({ duration: 200 }, "click on button")!.context.after, "click on button");

// start-up: once the four timed marks are in; rows and the turn never read earlier than the shell
const marks = { "script loaded": 80.2, "shell painted": 3100, "sidebar rows painted": 900 };
assert.equal(startupSpot(marks, true), null);
const start = startupSpot({ ...marks, "first turn painted": 3400.6 }, true)!;
assert.equal(start.name, "start-up: page");
assert.deepEqual(start.context, { marks: { "script loaded": 80, "shell painted": 3100, "sidebar rows painted": 3100, "first turn painted": 3401 }, intro: true });
assert.equal(start.ms, 3401);

// caps: the same slow spot by name once in 10 minutes, a crash once a minute, 100 reports an hour
let now = 1_000_000;
const realNow = Date.now;
Date.now = () => now;
try {
  const opts = options({ on: true, dsn: "http://k@127.0.0.1:1/1", os: "macos" }, "", "", "http://127.0.0.1:8790");
  const send = (message: string, kind?: string) =>
    opts.beforeSend!({ type: undefined, message, tags: kind ? { kind } : {} } as ErrorEvent, { originalException: new Error(message) });
  assert.ok(send("input: click", "slow spot"));
  assert.ok(send("frame", "slow spot"));
  now += 9 * 60_000;
  assert.equal(send("input: click", "slow spot"), null);
  now += 60_001;
  assert.ok(send("input: click", "slow spot"));
  assert.ok(send("boom"));
  now += 60_001;
  assert.ok(send("boom"));            // a crash waits a minute, not ten

  // 5 sent so far this hour; 95 more distinct ones pass, the 101st doesn't, and an hour on it does
  for (let i = 0; i < 95; i++) assert.ok(send(`crash ${i}`), `report ${i}`);
  assert.equal(send("one too many"), null);
  now += 3_600_000;
  assert.ok(send("one too many"));
} finally { Date.now = realNow; }

console.log("slow.check: ok");
