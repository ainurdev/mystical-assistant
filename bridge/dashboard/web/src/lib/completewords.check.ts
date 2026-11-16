// Run: node bridge/dashboard/web/src/lib/completewords.check.ts
import { codeWords, isDiskPath, rank, wordAt } from "./completewords.ts";

const eq = (got: unknown, want: unknown, what: string) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`FAIL: ${what} — got ${JSON.stringify(got)}`);
  console.log(`ok - ${what}`);
};

const turns = [
  { prompt: "fix the workrun thing", events: [{ type: "result", result: "I changed `bridge/workrun.py` and the chat_plan tool, plus useRefSession. The end." }] },
  { prompt: "now `merge_item` please", events: [{ type: "text", text: "Running --no-ff merges in WorkPanel and some-long-name here" }] },
];
const words = codeWords(turns);
eq(words.slice(0, 4), ["--no-ff", "WorkPanel", "some-long-name", "merge_item"], "newest first: the last reply, then the prompt before it");
eq(["bridge/workrun.py", "chat_plan", "useRefSession"].every((w) => words.includes(w)), true, "paths, snake_case, camelCase");
eq(["the", "changed", "workrun", "thing", "please", "The"].some((w) => words.includes(w)), false, "no plain words");
eq(codeWords([{ prompt: "a `x` and `has space` and `ok.py`" }]), ["ok.py"], "backticks: one word, long enough");
eq(new Set(codeWords([turns[0], turns[0]])).size, codeWords([turns[0], turns[0]]).length, "each once");

eq(wordAt("see chat_pl", 11), { from: 4, word: "chat_pl" }, "the word at the caret");
eq(wordAt("ask @Work", 9), null, "an @mention is the mention list's");
eq(wordAt("/compa", 6), null, "a leading /command is the command list's");
eq(wordAt("in bridge/wor", 13), { from: 3, word: "bridge/wor" }, "a path mid-line is a word");
eq(wordAt("done. ", 6), null, "nothing after a space");
eq(wordAt("/home/ma", 8), { from: 0, word: "/home/ma" }, "a leading path with a second slash is a path, not a command");
eq(wordAt("see ~/Doc", 9), { from: 4, word: "~/Doc" }, "a home path");
eq(["~/a", "/etc/x", "./x", "../x"].every(isDiskPath) && !isDiskPath("bridge/x"), true, "what goes to the disk, and what the project's list answers");

const files = ["bridge/workrun.py", "bridge/worklist.py", "tests/test_workrun.py", "README.md"];
const r = rank("workr", words, files);
eq(r[0].label, "workrun.py", "a prefix match beats one in the middle");
eq(r.map((o) => o.label).includes("workrun.py"), true, "a file's name");
eq(r.find((o) => o.label === "workrun.py")?.detail, "bridge", "with its folder beside it");
eq(rank("bridge/work", [], files).map((o) => o.label), ["bridge/workrun.py", "bridge/worklist.py"], "a path completes to paths, shortest first");
eq(rank("ch", words, files), [], "two letters is too few");
eq(rank("chat_plan", words, files).some((o) => o.label === "chat_plan"), false, "never the word itself");
eq(rank("panel", words, files)[0].label, "WorkPanel", "inside a word counts, any case");
const syms = [{ name: "useRefSession", file: "src/lib/readapi.tsx" }, { name: "helper_ended", file: "bridge/workrun.py" }];
eq(rank("helper_e", [], files, 40, syms)[0], { label: "helper_ended", detail: "workrun.py", kind: "symbol", boost: 170 }, "a name the code defines, with its file");
eq(rank("useRef", ["useRefSession"], [], 40, syms).length, 1, "a word the chat used and the code defines shows once");
eq(rank("bridge/w", [], ["bridge/x/y.py", "bridge/workrun.py"]).map((o) => o.label).slice(0, 1), ["bridge/workrun.py"], "paths still complete");
eq(rank("bridge/", [], ["bridge/x/y.py"]).some((o) => o.label === "bridge/x/"), true, "and so do their folders");
