// Run: node --experimental-strip-types src/lib/deviceruns.check.ts  (from web/)
//
// What Settings › Plugins › DEVICE RUNS says about this device: STATE's
// right-hand text, and the buttons the SETUP row holds. Things that go wrong
// quietly: a teammate's run in progress reads "idle", the text blames Xcode when
// only the iOS runtime is missing, and a device with anything of Set up's on it
// (a setup cut short, sharing off) is left with no way to remove it.
import type { RivendellDevice } from "../api.ts";
import { setupActions, stateText } from "./deviceruns.ts";
import { hhmm } from "./surfaces.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const eq = (got: unknown, want: unknown, what: string) =>
  ok(JSON.stringify(got) === JSON.stringify(want), `${what} — got ${JSON.stringify(got)}`);

type State = RivendellDevice["share"]["state"];
/** This device in `state`, with anything of Set up's on it or not (share_state's
 *  `installed`), and Xcode there or not. */
const dev = (state: State, installed: boolean, more: Partial<RivendellDevice> = {}, xcode = true) => ({
  share: { state, installed, checks: [{ key: "xcode", label: "XCODE 27.0", ok: xcode }, { key: "user", label: "USER MYSTICALRUNS", ok: installed }] },
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
eq(stateText(dev("XCODE_MISSING", true, {}, false)), "not shared until Xcode is installed", "no Xcode");
eq(stateText(dev("XCODE_MISSING", true)), "not shared until an iOS Simulator runtime is installed",
  "Xcode without an iOS runtime: the runtime is what's missing");
eq(stateText(dev("OFF", true)), "not shared", "switched off");
eq(stateText(dev("OFF", true, { running: true })), "running now", "a run still going after sharing went off is running now");

// The SETUP row: SET UP for a device that needs it, REMOVE whenever anything of Set
// up's is here, sharing on or off
eq(setupActions(dev("READY", true)), ["remove"], "ready: remove");
eq(setupActions(dev("OFF", true)), ["remove"], "set up and not shared: remove");
eq(setupActions(dev("XCODE_MISSING", true)), ["remove"], "set up and Xcode gone: remove");
eq(setupActions(dev("NEEDS_SETUP", false)), ["setup"], "nothing here yet, Xcode there: set up");
eq(setupActions(dev("NEEDS_SETUP", true)), ["setup", "remove"],
  "a setup cut short, or the wall on old ports: set up again, or remove what's there");
eq(setupActions(dev("OFF", false)), [], "nothing here and not shared: no row");
eq(setupActions(dev("XCODE_MISSING", false)), [], "nothing here and no Xcode: set up waits for Xcode");
eq(setupActions({ share: { state: "NOT_MAC", checks: [], installed: false } }), [], "off macOS: no setup at all");
