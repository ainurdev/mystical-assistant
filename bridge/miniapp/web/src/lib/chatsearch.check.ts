// Run: node --experimental-strip-types --no-warnings src/lib/chatsearch.check.ts
import { dedupeHits, markParts } from "./chatsearch.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

const d = dedupeHits([
  { turn: "a", kind: "text", seq: 1, snippet: "same" },
  { turn: "a", kind: "result", seq: 2, snippet: "same" },
  { turn: "b", kind: "text", seq: 3, snippet: "same" },
  { turn: "a", kind: "text", seq: 4, snippet: "other" },
]);
ok(d.map((h) => h.seq).join() === "1,3,4", "the same words in one turn list once");

const shape = (t: string, q: string) => markParts(t, q).map((p) => (p.hit ? `[${p.text}]` : p.text)).join("");
ok(shape("Fix the Bug in bug.py", "bug") === "Fix the [Bug] in [bug].py", "every match, any case");
ok(shape("nothing", "zz") === "nothing", "no match");
ok(shape("abc", "") === "abc", "no query");
ok(shape("bug", " bug ") === "[bug]", "query trimmed");
