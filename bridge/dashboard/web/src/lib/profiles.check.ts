// Run: node bridge/dashboard/web/src/lib/profiles.check.ts
// The one-time move of the browser-only profiles onto the bridge: what each old
// entry becomes, and that the old list is dropped only once every POST settled.
// A slip here loses someone's saved profiles, so pin it.
import { describe, importLegacy, type Profile, type ProfileWrite } from "./profiles.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const eq = (got: unknown, want: unknown, what: string) =>
  ok(JSON.stringify(got) === JSON.stringify(want), `${what} — got ${JSON.stringify(got)}`);

const P = (kw: Partial<Profile>): Profile => ({
  id: "p", name: "P", agent: "claude", account: "", model: "", mode: "", effort: "", tools: null, ...kw,
});
eq(describe(P({ account: "2", model: "claude-fable-5-1", mode: "acceptEdits", effort: "high", tools: ["a", "b", "c"] })),
  "A2 · FABLE-5-1 · ACCEPT EDITS · HIGH · 3 OFF", "describe names every knob the profile sets");
eq(describe(P({})), "DEFAULTS", "a profile that sets nothing says so");
eq(describe(P({ tools: [] })), "0 OFF", "an empty deny list is a setting too (everything on)");
eq(describe(P({ agent: "codex", account: "a_12ab34cd", model: "gpt-5.5" })), "◇ CODEX · GPT-5.5",
  "another agent leads with its name, not its account id");

const box = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => box.get(k) ?? null,
  removeItem: (k: string) => { box.delete(k); },
};
box.set("hud-profiles", JSON.stringify([
  { id: "1", name: "Work", model: "claude-opus-5-5", perm: "plan", effort: "high", ponytail: "lite",
    agent: "claude:2", disabledTools: ["mcp__x", 7] },
  { id: "2", name: "Free", model: "", perm: "", effort: "", agent: "opencode:groq", disabledTools: [] },
  { id: "3", name: "Gone", agent: "claude:9" },
  { id: "4", name: "  " },
]));
const sent: ProfileWrite[] = [];
let keyWhilePosting: string | undefined;
const landed = await importLegacy([P({ name: "Work" })], async (body) => {
  sent.push(body);
  keyWhilePosting = box.get("hud-profiles");
  if (body.account === "9") throw new Error("no usable Claude account in slot '9'");
});
eq(sent[0], { action: "create", name: "Work (old)", agent: "claude", account: "2", model: "claude-opus-5-5",
  mode: "plan", effort: "high", tools: ["mcp__x"] },
  "an entry maps onto a Claude profile: its login slot, its mode, its tool switches; a clash is marked");
eq([sent[1].account, sent[1].tools], ["", []], "a free-agent pick becomes the default login");
ok(sent.length === 3, "a nameless entry is skipped, the rest are all sent");
ok(landed, "any that landed says so, so the list reloads");
ok(keyWhilePosting !== undefined && !box.has("hud-profiles"), "the old list goes only after every POST settled");
ok(!(await importLegacy([], async () => {})), "once per page: a second mount imports nothing");
console.log("profiles.check: all ok");
