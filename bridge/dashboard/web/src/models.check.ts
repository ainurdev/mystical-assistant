// Run: node bridge/dashboard/web/src/models.check.ts
// The picker's Opus reset (docs/superpowers/specs/session-run-settings-design.md):
// a stored claude-fable-5-1 snapped to Opus on every reload because the snap ran
// against the pre-load alias FALLBACK. And runPicks: which picks a session shows.
import { familyOf, runPicks, snapModel } from "./models.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const list = (...ids: string[]) => ids.map((id) => ({ id, label: id }));
// What the bridge serves with a cold cache or the Models API down (models._fallback)…
const ALIASES = list("opus", "sonnet", "haiku", "fable");
// …and once it is warm: full ids, newest first.
const LIVE = list("claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5",
  "claude-fable-5", "claude-haiku-4-5-20251001");

ok(familyOf("claude-fable-5-1") === "fable" && familyOf("fable") === "fable", "an id and its alias share a family");
ok(familyOf("claude-haiku-4-5-20251001") === "haiku", "a dated id keeps its family");

ok(snapModel("claude-fable-5-1", undefined) === null, "pre-load: no list, no snap");
ok(snapModel("claude-fable-5-1", []) === null, "an empty list is no list");
ok(snapModel("claude-fable-5-1", LIVE) === null, "an offered pick stays");
ok(snapModel("fable", ALIASES) === null, "an offered alias stays");

ok(snapModel("claude-fable-5-1", ALIASES) === "fable", "full id -> its alias on the fallback list");
ok(snapModel("fable", LIVE) === "claude-fable-5-1", "alias -> the family's newest once the list warms");
ok(snapModel("claude-fable-4-9", LIVE) === "claude-fable-5-1", "a retired release -> its family's newest");

ok(snapModel("claude-mythos-5", LIVE) === "claude-opus-5-5", "a family not offered -> Opus");
ok(snapModel("claude-mythos-5", list("claude-sonnet-5", "claude-haiku-4-5")) === "claude-sonnet-5",
  "no Opus either -> the first model");

const DEV = { model: "claude-opus-5-5", perm: "default" };
const ran = runPicks({ model: "claude-fable-5-1", permission_mode: "bypassPermissions" }, DEV);
ok(ran.model === "claude-fable-5-1" && ran.perm === "bypassPermissions", "a session that has run carries both picks");
const fresh = runPicks({ model: null, permission_mode: "bypassPermissions" }, DEV);
ok(fresh.model === "claude-opus-5-5" && fresh.perm === "default",
  "a session that never ran starts from this device's picks, not the bridge's mode");
const legacy = runPicks({ model: null, permission_mode: "bypassPermissions" }, { model: "opus", perm: "" });
ok(legacy.perm === "bypassPermissions", 'a device mode of "" (the retired Session option) defers to the session');
const old = runPicks({}, { model: "opus", perm: "" });
ok(old.model === "opus" && old.perm === "", "an older bridge's brief (no fields) leaves this device's picks");
console.log("models.check: all ok");
