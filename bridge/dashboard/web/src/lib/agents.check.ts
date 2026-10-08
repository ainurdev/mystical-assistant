// Run: node bridge/dashboard/web/src/lib/agents.check.ts
// How an agent turn's badge reads, and that an agent session's pickers come
// from the agent's own options — never Claude's lists or this device's Claude
// picks, which the bridge would refuse on an agent turn.
import type { AcpAgentsInfo } from "../api.ts";
import { agentLabel, agentPickers, NO_PICKS, runtimeBadge, sendPicks, setAgentLabels } from "./agents.ts";
import { runPicks } from "../models.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const eq = (got: unknown, want: unknown, what: string) =>
ok(JSON.stringify(got) === JSON.stringify(want), `${what} — got ${JSON.stringify(got)}`);

// --- runtime label --------------------------------------------------------------
eq(runtimeBadge("acp:codex").text, "◇ CODEX", "before the presets load, the id upper-cased");
setAgentLabels([{ id: "codex", label: "Codex" }, { id: "gemini", label: "Gemini CLI" }]);
eq(runtimeBadge("acp:gemini").text, "◇ GEMINI CLI", "the preset's label once known");
eq(runtimeBadge("acp:newthing").text, "◇ NEWTHING", "an id no preset names falls back to itself");
ok(runtimeBadge("acp:codex").agent, "an acp tag is an agent turn");
eq(runtimeBadge("claude:2"), { text: "⇄ ACCOUNT 2", agent: false, title: "Ran on another Claude account after a usage limit" },
  "another Claude login keeps its badge");
eq(agentLabel("opencode"), "OPENCODE", "agentLabel upper-cases");

// --- option selection -------------------------------------------------------------
const info: AcpAgentsInfo = {
  presets: [], accounts: [],
  options: {
    "codex|": { model: [{ value: "gpt-5.5", name: "GPT-5.5" }], mode: [{ value: "auto", name: "Auto" }], effort: [] },
    "codex|a_1": { model: [{ value: "o4", name: "o4" }], mode: [], effort: [{ value: "high", name: "High" }] },
  },
};
eq(agentPickers("claude", "", info), null, "a Claude session gets no agent pickers (its own lists apply)");
eq(agentPickers(undefined, undefined, info), null, "an older bridge's brief (no agent) is Claude");
const m = agentPickers("codex", "", info)!;
eq(m.model, [{ id: "", label: "AGENT DEFAULT" }, { id: "gpt-5.5", label: "GPT-5.5" }], "machine login: its models, AGENT DEFAULT first");
eq(m.effort, null, "no thought_level advertised: the effort picker hides");
eq(m.label, "CODEX", "the chip names the agent");
const a = agentPickers("codex", "a_1", info)!;
eq([a.model?.[1].id, a.mode, a.effort?.[1].id], ["o4", null, "high"], "options are per account, not per agent");
eq(agentPickers("gemini", "", info), { agent: "gemini", label: "GEMINI CLI", model: null, mode: null, effort: null },
  "never tested: every picker hides (the chip still shows)");

// The device's Claude picks never reach an agent session: blanks run the agent's default.
const device = { model: "claude-opus-5-5", perm: "acceptEdits", effort: "high" };
eq(runPicks({ agent: "codex", profile_id: "p" } as never, NO_PICKS, { model: "", mode: "", effort: "" }),
  { model: "", perm: "", effort: "" }, "agent profile that sets nothing: all agent defaults");
eq(runPicks({ profile_id: "p" }, NO_PICKS, { model: "o4", mode: "auto", effort: "" }),
  { model: "o4", perm: "auto", effort: "" }, "an agent profile's own ids show through");
eq(runPicks({ profile_id: "p" }, device, { model: "", mode: "", effort: "" }).model, "claude-opus-5-5",
  "(contrast) a Claude session does fall back to the device's model");
// Which runs carry the composer's picks (App send()).
ok(sendPicks("claude", undefined) && sendPicks(undefined, undefined), "Claude to Claude: the picks go");
ok(sendPicks("codex", "codex"), "the open agent session: its own picks go");
ok(!sendPicks("codex", undefined), "a Claude model never goes to an agent session");
ok(!sendPicks("claude", "codex"), "an agent's ids never go to a Claude session");
ok(!sendPicks("opencode", "codex"), "nor one agent's ids to another");
ok(!sendPicks("codex", "codex", true), "a session minted for this prompt on an agent runs on its profile's");
ok(sendPicks("claude", undefined, true), "a fresh Claude session still gets this device's picks");
ok(!sendPicks("codex", undefined, true), "the create-then-send path: an agent-default new session gets no Claude model");
console.log("agents.check: all ok");
