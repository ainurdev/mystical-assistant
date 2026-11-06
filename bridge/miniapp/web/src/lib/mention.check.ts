// Run: node bridge/miniapp/web/src/lib/mention.check.ts
import { atQuery, insertName, isWholeName, rankNames } from "./mention.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

ok(atQuery("hello", 5) === null, "no @, no query");
ok(atQuery("@", 1)?.q === "", "a bare @ opens the list");
ok(atQuery("ask @ki", 7)?.q === "ki" && atQuery("ask @ki", 7)?.start === 4, "mid-sentence");
ok(atQuery("mail foo@bar", 12) === null, "an address isn't a mention");
ok(atQuery("@@x", 3) === null, "a doubled @ isn't a mention");
ok(atQuery("@Work Op", 8)?.q === "Work Op", "a name can hold a space");
ok(atQuery("@a\nb", 4) === null, "a new line closes it");
ok(atQuery("@ki rest", 3)?.q === "ki", "the caret decides, not the end of the draft");
ok(atQuery("@" + "x".repeat(50), 51) === null, "a very long run isn't a name");

const ps = [{ name: "Work Opus" }, { name: "Kimi" }, { name: "Opus Fast" }, { name: "Pikimi" }];
const names = (q: string) => rankNames(ps, q).map((p) => p.name).join(",");
ok(names("ki") === "Kimi,Pikimi", "start of name before anywhere");
ok(names("op") === "Opus Fast,Work Opus", "start of name before a later word");
ok(names("") === "Kimi,Opus Fast,Pikimi,Work Opus", "empty offers all, alphabetical");
ok(names("work opus ") === "", "a finished mention closes the list");
ok(isWholeName("Kimi", "kimi") && !isWholeName("Kimi", "ki"), "whole name");

{
  const r = insertName("ask @ki now", { start: 4, q: "ki" }, 7, "Kimi");
  ok(r.text === "ask @Kimi now", r.text);
  ok(r.caret === 10, "caret after the space");
}
