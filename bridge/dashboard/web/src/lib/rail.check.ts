// Run: node --experimental-strip-types src/lib/rail.check.ts  (from web/)
//
// The right rail's arrangement: the user's order wins, unseen tabs keep their
// app neighbour, hidden ones drop out, and the rail can never end up empty.
import { arrange, clampRightW, moveTo, startTab, toggleHidden } from "./rail.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const T = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (ts: { id: string }[]) => ts.map((t) => t.id).join(" ");
const app = T("turns", "files", "git", "branches", "team", "usage");

ok(ids(arrange(app, [], [])) === "turns files git branches team usage", "no stored order: the app's");
ok(ids(arrange(app, ["git", "turns", "files", "branches", "team", "usage"], [])) === "git turns files branches team usage",
  "the stored order wins");
ok(ids(arrange(app, ["usage", "turns", "files", "git", "branches"], [])) === "usage turns files git branches team",
  "a tab the order never saw follows its app predecessor");
ok(ids(arrange(T("turns", "learn", "git"), ["git", "turns"], [])) === "git turns learn",
  "LEARN switched on lands after its app neighbour, not first or last by accident");
ok(ids(arrange(T("flow", "turns"), ["turns"], [])) === "flow turns", "an unseen first tab stays first");
ok(ids(arrange(app, [], ["branches", "team"])) === "turns files git usage", "hidden tabs drop out");
ok(ids(arrange(app, [], app.map((t) => t.id))) === ids(app), "hiding every tab is refused");
ok(ids(arrange(app, ["gone", "git"], [])) === ids(app), "a stale id in the order costs nothing");

ok(moveTo(["a", "b", "c", "d"], 0, 2).join("") === "bcad", "move down");
ok(moveTo(["a", "b", "c", "d"], 3, 0).join("") === "dabc", "move to the top");
ok(moveTo(["a", "b", "c"], 1, 9).join("") === "acb", "past the end clamps to the end");

ok(clampRightW(100) === 230 && clampRightW(900) === 520 && clampRightW(300.6) === 301, "width clamps and rounds");

// The menu's ON THE RAIL checklist: a click flips one tab, and the last one shown stays.
const all = ["home", "files", "git"];
ok(toggleHidden(all, [], "git").join() === "git", "a shown tab hides");
ok(toggleHidden(all, ["git", "files"], "git").join() === "files", "a hidden tab comes back");
ok(toggleHidden(all, ["home", "files"], "git").join() === "home,files", "the last shown tab can't hide");
ok(toggleHidden(all, ["gone", "home"], "files").join() === "home,files", "a stale id drops out on the way");

// Open here on start: a pinned tab wins over the one you left open, if it still exists.
ok(startTab("git", "files", all) === "git", "the pinned start tab wins");
ok(startTab("", "files", all) === "files", "no pin: the last open tab");
ok(startTab("gone", "files", all) === "files", "a pin to a tab that's gone is ignored");
