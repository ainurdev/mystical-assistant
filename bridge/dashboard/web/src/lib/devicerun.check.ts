// Run: node --experimental-strip-types src/lib/devicerun.check.ts  (from web/)
//
// A teammate's device run on this device, as the dashboard draws it: which
// sessions are one, the DEVICE RUNS row's figure, the plate's status tab, and
// the event Settings' OPEN › sends. Things that go wrong quietly: a Rivendell
// run counted as a device run, the elapsed time read off `updated` (which a
// refused prompt or an archive moves), a stopped run marked ✓, and a finished
// plate still saying RUNNING.
import type { SessionBrief } from "../api.ts";
import { isDeviceRun, openSession, plateStatus, rowAge } from "./devicerun.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const eq = (got: unknown, want: unknown, what: string) =>
  ok(JSON.stringify(got) === JSON.stringify(want), `${what} — got ${JSON.stringify(got)}`);

const now = 1_800_000_000;
type Device = NonNullable<SessionBrief["device"]>;
const dev: Device = { request: "r1", instance: "fd495085", by: "Erfan Besharat", repo: "ainurhq/ibgroups_operations",
  sha: "04dac9b1e2f3", pr: 81, task: null, outcome: null };
/** A device run's session that started `ago` seconds back and was last touched `touched` seconds back. */
const run = (ago: number, touched: number, outcome: Device["outcome"] = null): SessionBrief => ({
  id: "s1", title: "Build and run the iOS app", project: "/", created: now - ago, updated: now - touched,
  archived: 0, origin: "device-run:fd495085", device: { ...dev, outcome },
});

// Which sessions are a teammate's device run
ok(isDeviceRun("device-run:fd495085"), "a device run's origin");
ok(!isDeviceRun("rivendell:prod") && !isDeviceRun("dashboard") && !isDeviceRun("device-runner"),
  "a Rivendell run, your own session, a lookalike prefix: not device runs");
ok(!isDeviceRun(null) && !isDeviceRun(undefined), "no origin (an older session): not a device run");

// The row's figure: the elapsed time while it runs, ✓ / ✕ and the age after
eq(rowAge(run(24 * 60, 5), true, now), { text: "24m", tone: "run" }, "running: elapsed since it was created, not since it was last touched");
eq(rowAge(run(40 * 60, 3600, "done"), false, now), { text: "✓ 1h", tone: "ok" }, "done: ✓ and the row's age");
eq(rowAge(run(3 * 86400, 2 * 86400, "failed"), false, now), { text: "✕ 2d", tone: "bad" }, "failed: ✕");
eq(rowAge(run(600, 120, "stopped"), false, now), { text: "✕ 2m", tone: "bad" }, "stopped by the owner: ✕, never ✓");
eq(rowAge(run(600, 120), false, now), { text: "2m", tone: "idle" }, "not working, no outcome yet: the plain age");

// The plate's status tab
eq(plateStatus(true, null, 0), "RUNNING · LOW PRIORITY", "running");
eq(plateStatus(false, "done", 33), "DONE · 33 MIN", "done, with how long it ran");
eq(plateStatus(false, "failed", 4), "FAILED · 4 MIN", "failed");
eq(plateStatus(false, "stopped", 12), "STOPPED · 12 MIN", "stopped");
eq(plateStatus(false, null, 3), "RUNNING · LOW PRIORITY", "no outcome yet (the bridge hasn't closed it): still running");

// OPEN ›: one window event App listens for
const w = new EventTarget();
(globalThis as { window?: EventTarget }).window = w;
let got: unknown = null;
w.addEventListener("hud:open-session", (e) => { got = (e as CustomEvent).detail; });
openSession("s1");
eq(got, "s1", "openSession sends hud:open-session with the session's id");
