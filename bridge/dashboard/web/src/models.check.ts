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

const DEV = { model: "claude-opus-5-5", perm: "default", effort: "medium" };
const ran = runPicks({ model: "claude-fable-5-1", permission_mode: "bypassPermissions" }, DEV);
ok(ran.model === "claude-fable-5-1" && ran.perm === "bypassPermissions", "a session that has run carries both picks");
const fresh = runPicks({ model: null, permission_mode: "bypassPermissions" }, DEV);
ok(fresh.model === "claude-opus-5-5" && fresh.perm === "default",
  "a session that never ran starts from this device's picks, not the bridge's mode");
const legacy = runPicks({ model: null, permission_mode: "bypassPermissions" }, { ...DEV, model: "opus", perm: "" });
ok(legacy.perm === "bypassPermissions", 'a device mode of "" (the retired Session option) defers to the session');
const old = runPicks({}, { ...DEV, model: "opus", perm: "" });
ok(old.model === "opus" && old.perm === "", "an older bridge's brief (no fields) leaves this device's picks");

// Effort is the session's now (spec profiles-and-acp-agents.md, "Writes keep
// the profile live"): its own wins, and this device's pick only seeds a session
// that never ran. Once one has, no effort on it is Auto and stays Auto — a pick
// made since in another session must not seep in and get pinned by the next send.
ok(runPicks({ model: "claude-fable-5-1", effort: "high" }, DEV).effort === "high", "the session's effort wins");
ok(runPicks({ model: null, effort: null }, DEV).effort === "medium", "a session that never ran starts from this device's effort");
ok(runPicks({ model: "claude-fable-5-1", effort: null }, { ...DEV, effort: "low" }).effort === "",
  "Auto on a session that has run stays Auto, whatever this device picked since");
ok(runPicks({ model: "claude-fable-5-1" }, DEV).effort === "medium",
  "an older bridge's brief (no effort field at all) keeps this device's effort");
ok(old.effort === "medium", "an older bridge's brief (no fields) -> this device's");

// Bound, but the profile list isn't in (it failed to load, or lags the poll):
// the brief's values are already the effective ones, so they show — this
// device's would get pinned as overrides by the next send.
const unloaded = runPicks({ profile_id: "p_x", model: null, permission_mode: "plan", effort: null, overrides: [] }, DEV);
ok(unloaded.perm === "plan" && unloaded.effort === "" && unloaded.model === "claude-opus-5-5",
  "bound to a profile that isn't loaded: the brief's mode and effort, this device's model only as there is none");

// Bound to a profile: a knob set by hand in the session, else the profile's,
// else this device's. The brief's mode is never blank (the bridge fills its
// default in), so only `overrides` says whether it is the session's own.
const PROF = { model: "claude-fable-5-1", mode: "plan", effort: "" };
const bound = runPicks({ model: "claude-fable-5-1", permission_mode: "plan", effort: null, overrides: [] }, DEV, PROF);
ok(bound.model === "claude-fable-5-1" && bound.perm === "plan" && bound.effort === "medium",
  "a bound session shows its profile, and this device's pick where the profile sets nothing");
const blank = runPicks({ model: null, permission_mode: "auto", effort: null, overrides: [] }, DEV,
  { model: "", mode: "", effort: "" });
ok(blank.model === "claude-opus-5-5" && blank.perm === "default",
  "a profile that sets nothing shows this device's picks, not the bridge's default mode");
ok(runPicks({ permission_mode: "auto", overrides: [] }, { ...DEV, perm: "" }, { model: "", mode: "", effort: "" }).perm
  === "auto", 'with no mode anywhere else, a device mode of "" still defers to the session\'s');
const own = runPicks({ model: "claude-opus-5-5", permission_mode: "acceptEdits", effort: "low",
  overrides: ["model", "permission_mode", "effort"] }, DEV, PROF);
ok(own.model === "claude-opus-5-5" && own.perm === "acceptEdits" && own.effort === "low",
  "a knob set by hand in the session beats its profile");
const seed = runPicks({ model: null, permission_mode: "bypassPermissions", effort: null, overrides: [] }, DEV,
  { model: "claude-fable-5-1", mode: "plan", effort: "max" });
ok(seed.model === "claude-fable-5-1" && seed.perm === "plan" && seed.effort === "max",
  "a session bound before its first turn starts from the profile, not what it was created with");
console.log("models.check: all ok");
