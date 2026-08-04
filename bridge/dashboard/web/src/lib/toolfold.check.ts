// Run: node bridge/dashboard/web/src/lib/toolfold.check.ts
import { foldChips, runsOf } from "./toolfold.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

const t = (type: string) => ({ type });
const none = () => false;

// tool_done between chips must not break the run.
{
  const evs = [t("tool"), t("tool_done"), t("tool"), t("tool_done"), t("tool"), t("tool_done")];
  const { folds, headOf } = foldChips(evs, none);
  ok(folds.get(0)?.join() === "0,2,4", "three chips separated by tool_done fold into one");
  ok([...headOf.keys()].join() === "2,4", `only the tail is swallowed: ${[...headOf.keys()]}`);
  ok([...headOf.values()].every((h) => h === 0), "every swallowed row points back at the head");
}

// Two chips stay as they are; text breaks a run.
{
  const evs = [t("tool"), t("tool"), t("text"), t("tool"), t("tool"), t("tool")];
  const { folds, headOf } = foldChips(evs, none);
  ok(folds.size === 1 && folds.has(3), "a run of two is left alone, a run of three folds");
  ok(!headOf.has(1), "the pair is untouched");
  ok(headOf.get(4) === 3 && headOf.get(5) === 3, "the trailing run folds into index 3");
}

// A blocky tool (Bash terminal / edit diff) splits the run around it.
{
  const evs = [t("tool"), t("tool"), t("tool"), t("tool"), t("tool")];
  const { folds } = foldChips(evs, (i) => i === 2);
  ok(folds.size === 0, "two chips either side of a block are both too short to fold");
  const wide = foldChips([...evs, t("tool")], (i) => i === 2).folds;
  ok(wide.size === 1 && wide.get(3)?.length === 3, "the longer side folds, the block stays out");
}

// Opening a fold must bring back every row it swallowed, not just the first.
{
  const evs = [t("tool"), t("tool_done"), t("tool"), t("tool_done"), t("tool"), t("tool_done"), t("tool")];
  const { folds, headOf } = foldChips(evs, none);
  const members = folds.get(0) ?? [];
  ok(members.length === 4, `the whole run is one fold: ${members}`);
  ok(members.slice(1).every((i) => headOf.get(i) === 0), "each member resolves to the same head");
}

// Bash runs (one terminal window per run): pairs count, a lone command doesn't,
// and prose between two commands means two windows.
{
  const bash = [0, 1, 4];
  const evs = [t("tool"), t("tool"), t("tool_done"), t("text"), t("tool")];
  const { folds, headOf } = runsOf(evs, (i) => (bash.includes(i) ? "bash" : null), 2);
  ok(folds.get(0)?.join() === "0,1", "two back-to-back commands share one window");
  ok(headOf.get(1) === 0 && !headOf.has(4), "the second command is drawn by the first, the lone one is not");
  ok(folds.size === 1, "a single command after prose stays its own window");
}

// A different key breaks the run: two MCP servers back to back are two cards.
{
  const keys = ["mcp:teamwork", "mcp:teamwork", "mcp:github", "mcp:github"];
  const evs = keys.map(() => t("tool"));
  const { folds } = runsOf(evs, (i) => keys[i], 2);
  ok(folds.get(0)?.join() === "0,1" && folds.get(2)?.join() === "2,3", "each key gets its own run");
  ok(folds.size === 2, "the two servers never share a card");
}

console.log("\nall toolfold checks passed");
