// Run: node --experimental-strip-types src/lib/deviceruns.check.ts  (from web/)
//
// What Settings › Plugins › DEVICE RUNS says about this device: STATE's
// right-hand text, and the button the SETUP row holds. Two things go wrong
// quietly: a teammate's run in progress reads "idle", and a device that is set
// up while it isn't shared is left with no way to remove it.
import type { RivendellDevice } from "../api.ts";
import { setupAction, stateText } from "./deviceruns.ts";
import { hhmm } from "./surfaces.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const eq = (got: unknown, want: unknown, what: string) =>
  ok(JSON.stringify(got) === JSON.stringify(want), `${what} — got ${JSON.stringify(got)}`);

type State = RivendellDevice["share"]["state"];
/** This device in `state`, its hidden user set up or not (share_state's "user" check). */
const dev = (state: State, setUp: boolean, more: Partial<RivendellDevice> = {}) => ({
  share: { state, checks: [{ key: "xcode", label: "XCODE 27.0", ok: true }, { key: "user", label: "USER MYSTICALRUNS", ok: setUp }] },
  running: false,
  last_run: null,
  ...more,
});
const at = new Date(2026, 9, 16, 11, 40).getTime() / 1000;
const last = { at, by: "Mahdi", task: "NR-29" };

// STATE's right-hand text
eq(stateText(dev("READY", true, { last_run: last })), `idle · last run ${hhmm(at)}, Mahdi, NR-29`, "ready: idle, and the last run");
eq(stateText(dev("READY", true)), "idle", "ready with no run yet: idle");
eq(stateText(dev("READY", true, { last_run: { at, by: "", task: null } })), `idle · last run ${hhmm(at)}`,
  "a last run with no name or task leaves them out");
eq(stateText(dev("READY", true, { running: true, last_run: last })), "running now", "a run in progress is running now, not idle");
eq(stateText(dev("NEEDS_SETUP", false)), "not shared until it is set up", "needs setup");
eq(stateText(dev("XCODE_MISSING", true)), "not shared until Xcode is installed", "no Xcode");
eq(stateText(dev("OFF", true)), "not shared", "switched off");
eq(stateText(dev("OFF", true, { running: true })), "running now", "a run still going after sharing went off is running now");

// The SETUP row: REMOVE whenever the hidden user is set up, sharing on or off
eq(setupAction(dev("READY", true)), "remove", "ready: remove");
eq(setupAction(dev("OFF", true)), "remove", "set up and not shared: remove");
eq(setupAction(dev("XCODE_MISSING", true)), "remove", "set up and Xcode gone: remove");
eq(setupAction(dev("NEEDS_SETUP", false)), "setup", "not set up, Xcode there: set up");
eq(setupAction(dev("OFF", false)), null, "not set up and not shared: no button");
eq(setupAction(dev("XCODE_MISSING", false)), null, "not set up and no Xcode: set up waits for Xcode");
eq(setupAction({ share: { state: "NOT_MAC", checks: [] } }), null, "off macOS: no setup at all");
