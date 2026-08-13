// Run: node bridge/dashboard/web/src/lib/bootsteps.check.ts
import {
  BOOT_CEIL_MS,
  BOOT_FLOOR_MS,
  bootProgress,
  bootReady,
  count,
  initialBootSteps,
  markStep,
} from "./bootsteps.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

const fresh = initialBootSteps();
ok(fresh.length === 5, "five lines, one per startup fetch");
ok(fresh.every((s) => s.phase === "wait"), "nothing is OK before it has answered");
ok(bootProgress(fresh) === 0, "an untouched boot shows no progress");

// A step that answered moves the bar; the others stay waiting.
const one = markStep(fresh, "sessions", "ok", "12 CHATS");
ok(bootProgress(one) === 0.2, "one of five answering is a fifth of the bar");
ok(one.find((s) => s.key === "sessions")?.detail === "12 CHATS", "the line carries what came back");
ok(fresh.every((s) => s.phase === "wait"), "marking doesn't mutate the array it was handed");

// The reason first-answer-wins exists: these feeds are polls. Re-marking must
// not churn the array, or every 3s tick re-renders the dashboard behind the intro.
ok(markStep(one, "sessions", "ok", "13 CHATS") === one, "a settled line ignores the next poll, same array");
ok(markStep(one, "nope" as never, "ok", "x") === one, "an unknown key is a no-op, same array");

// A failed fetch still counts as answered — a dead bridge must not hang the intro.
const failed = markStep(one, "git", "fail", "OFFLINE");
ok(bootProgress(failed) === 0.4, "a failure advances the bar like a success");
ok(markStep(failed, "git", "ok", "3 REPOS") === failed, "and a later success can't overwrite it");

const all = ["bridge", "projects", "git", "auth"].reduce(
  (s, k) => markStep(s, k as never, "ok", "OK"), one);
ok(bootProgress(all) === 1, "every line answered fills the bar");

// Exit rules: all-answered plus the floor, or the ceiling regardless.
ok(!bootReady(all, BOOT_FLOOR_MS - 1), "answering instantly still lets the emblem finish drawing");
ok(BOOT_FLOOR_MS < BOOT_CEIL_MS, "the floor is a floor, not the ceiling");
ok(bootReady(all, BOOT_FLOOR_MS), "past the floor with everything in, the intro leaves");
ok(!bootReady(one, BOOT_CEIL_MS - 1), "a slow bridge holds the intro open");
ok(bootReady(one, BOOT_CEIL_MS), "…but only to the ceiling — a hang can't trap you");
ok(bootReady(fresh, BOOT_CEIL_MS), "even with nothing answered at all");

ok(count(0, "REPO") === "NONE", "zero says NONE, not 0 REPOS");
ok(count(1, "REPO") === "1 REPO", "one is singular");
ok(count(12, "CHAT") === "12 CHATS", "more than one is plural");

console.log("bootsteps.check passed");
