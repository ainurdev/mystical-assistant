import { test } from "node:test";
import assert from "node:assert/strict";
import { carryPresets, flowRuns, saveRun } from "./flowruns.ts";
import { presetFor } from "./kinds.ts";

const cfg = [
  { id: "build", run: { model: "claude-sonnet-5-5", mode: "plan", effort: "low", trim: "lite", style: "Explanatory" } },
  { id: "ask", run: { model: "claude-haiku-5-5", mode: "", effort: "medium", trim: "", style: "" } },
];

test("a flow's preset is its bridge default, then this session's edits", () => {
  const saved = flowRuns(cfg);
  assert.deepEqual(presetFor("build", saved), { model: "claude-sonnet-5-5", perm: "plan", effort: "low", ponytail: "lite", style: "Explanatory" });
  assert.deepEqual(presetFor("build", saved, { effort: "max", style: "" }),
    { model: "claude-sonnet-5-5", perm: "plan", effort: "max", ponytail: "lite", style: "" });
});

test("a flow with no style follows the session's", () => {
  assert.equal(presetFor("ask", flowRuns(cfg)).style, "");
});

test("before the bridge answers, the built-in preset holds", () => {
  assert.deepEqual(presetFor("fix", flowRuns(undefined)), { model: "claude-opus-5-5", perm: "bypassPermissions", effort: "max", ponytail: "", style: "" });
});

test("Save as writes every run row to the flow's bridge default", () => {
  assert.deepEqual(saveRun("fix", { model: "m", perm: "plan", effort: "high", ponytail: "off", style: "Learning" }),
    { flow: "fix", key: "run", value: { model: "m", mode: "plan", effort: "high", trim: "off", style: "Learning" } });
});

test("saved kind presets are sent once, then dropped", async () => {
  const sent: unknown[] = [];
  let dropped = 0;
  await carryPresets({ build: { model: "m" } }, async (b) => { sent.push(b); }, () => { dropped++; });
  assert.deepEqual(sent, [{ presets: { build: { model: "m" } } }]);
  assert.equal(dropped, 1);
});

test("a browser with no saved presets sends nothing", async () => {
  let calls = 0;
  await carryPresets({}, async () => { calls++; }, () => { calls++; });
  await carryPresets(undefined, async () => { calls++; }, () => { calls++; });
  assert.equal(calls, 0);
});

test("presets stay in the browser when the bridge didn't take them", async () => {
  let dropped = 0;
  await carryPresets({ ask: { effort: "max" } }, async () => { throw new Error("404"); }, () => { dropped++; }).catch(() => {});
  assert.equal(dropped, 0);
});
