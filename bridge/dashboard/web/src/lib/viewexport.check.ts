// node --experimental-strip-types src/lib/viewexport.check.ts /tmp/out.xlsx : writes a file for the Python check too
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { excelDate, xlsx } from "./viewexport.ts";
import { flatten, layoutFlow, nodePath, wrap, type FlowEv } from "./dataview.ts";

assert.equal(excelDate("2026-11-07"), 46333);
assert.equal(excelDate("1970-01-01"), 25569);
assert.equal(excelDate("2026-11"), null);

const out = process.argv[2];
const bytes = xlsx("Invoices / 2026", [
  { key: "who", label: "Client", type: "text" }, { key: "amt", label: "Amount", type: "money", currency: "EUR" },
  { key: "on", label: "Due", type: "date" }, { key: "cov", label: "Paid", type: "progress" },
], [{ who: "=SUM(1) & <co>", amt: 1000.5, on: "2026-11-07", cov: 50 }, { who: "B\u0001c", amt: null, on: "2026-11", cov: null }], { amt: 1000.5 });
assert.equal(bytes[0], 0x50);
if (out) writeFileSync(out, bytes);

assert.deepEqual(wrap("one two three four", 8, 2), ["one two", "three…"]);

const flow = (edges: [string, string][], ids = ["a", "b", "c", "d"]): FlowEv => ({ type: "data", view: "diagram", kind: "flow", title: "T", groups: [], direction: "",
  nodes: ids.map((id) => ({ id, label: id, note: "", shape: "process", group: "" })), edges: edges.map(([from, to]) => ({ from, to, label: "" })) });
const line = layoutFlow(flow([["a", "b"], ["b", "c"], ["c", "d"]]), "right");
const at = (l: typeof line, id: string) => l.nodes.find((n) => n.id === id)!;
assert.ok(at(line, "a").x < at(line, "b").x && at(line, "b").x < at(line, "c").x);
const down = layoutFlow(flow([["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"]]), "down");
assert.equal(at(down, "b").y, at(down, "c").y);
assert.ok(at(down, "d").y > at(down, "b").y);
const loop = layoutFlow(flow([["a", "b"], ["b", "c"], ["c", "a"], ["d", "d"]]), "right");        // a cycle ends
assert.equal(loop.arrows.length, 4);
assert.ok(loop.arrows.some((a) => a.back));
for (const n of [...line.nodes, ...down.nodes, ...loop.nodes]) {
  assert.ok(n.x >= 0 && n.y >= 0 && Number.isFinite(n.x + n.y), JSON.stringify(n));
  assert.ok(nodePath(n).startsWith("M"));
}
assert.ok(down.width > 0 && down.height > 0);

assert.deepEqual(flatten(flow([["a", "b"]])).rows, [{ from: "a", label: "", to: "b" }]);
console.log("viewexport ok");
