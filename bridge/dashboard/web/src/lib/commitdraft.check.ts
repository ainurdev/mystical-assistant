// Run: node bridge/dashboard/web/src/lib/commitdraft.check.ts
import { draftKey, getDraft, patchDraft, subscribeDraft, watched } from "./commitdraft.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

const k = draftKey("repo", "feat/x");
ok(k === "repo@feat/x", "the key is the worktree, not the session");
ok(draftKey(null) === "@", "no project still keys");
ok(getDraft(k).msg === "" && !getDraft(k).gen, "an unknown worktree is an empty box");
ok(getDraft(k) === getDraft(k), "an unknown worktree's snapshot is stable (useSyncExternalStore needs that)");

// The reported bug: GENERATE started, the panel was switched away from, and the
// result landed in an unmounted component.
patchDraft(k, { gen: true });
ok(!watched(k), "nothing is showing the box yet");
let ticks = 0;
const off = subscribeDraft(k, () => { ticks++; });
ok(watched(k), "a mounted panel is watching");
ok(getDraft(k).gen, "…and sees the GENERATE still running");
patchDraft(k, { gen: false, msg: "feat: x" });
ok(ticks === 1, "the panel hears each change once");
ok(getDraft(k).msg === "feat: x" && !getDraft(k).gen, "the result lands in the box");
off();
ok(!watched(k), "unmounted: a finished GENERATE has to say so from the bell");
patchDraft(k, { msg: "" });
ok(ticks === 1, "an unmounted panel hears nothing");
ok(getDraft(draftKey("repo", "main")).msg === "", "another branch of the same repo is its own box");
