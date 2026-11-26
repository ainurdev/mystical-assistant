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

// Wires run like traces on a board: straight runs across or down, 45° cuts at the bends only,
// never through a step, and no two arriving at the same point on one.
const board: FlowEv = { ...flow([["s", "a"], ["s", "b"], ["s", "c"], ["s", "t"], ["a", "t"], ["b", "x"], ["x", "t"], ["c", "t"], ["s", "x"], ["t", "s"]],
  ["s", "a", "b", "c", "x", "t"]), clusters: [{ id: "k", label: "Middle", comment: "why", nodes: ["b", "x"] }] };
const pts = (d: string) => [...d.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((m) => [+m[1], +m[2]]);
for (const dir of ["down", "right"] as const) {
  const l = layoutFlow(board, dir);
  assert.equal(l.arrows.length, board.edges.length);
  const ends = new Set<string>();
  for (const a of l.arrows) {
    const p = pts(a.d);
    for (let i = 1; i < p.length; i++) {
      const dx = Math.abs(p[i][0] - p[i - 1][0]), dy = Math.abs(p[i][1] - p[i - 1][1]);
      assert.ok(dx < 0.2 || dy < 0.2 || Math.abs(dx - dy) < 0.2, `${dir} ${a.from}>${a.to}: a slanted run in ${a.d}`);
      for (const n of l.nodes) {   // sample the run: no point strictly inside a step
        for (let t = 0; t <= 1; t += 0.05) {
          const x = p[i - 1][0] + (p[i][0] - p[i - 1][0]) * t, y = p[i - 1][1] + (p[i][1] - p[i - 1][1]) * t;
          assert.ok(!(x > n.x + 1 && x < n.x + n.w - 1 && y > n.y + 1 && y < n.y + n.h - 1), `${dir} ${a.from}>${a.to} runs through ${n.id}`);
        }
      }
    }
    const end = p[p.length - 1].map(Math.round).join(",");
    assert.ok(!ends.has(end), `${dir}: two wires end at ${end}`);
    ends.add(end);
  }
  const [k] = l.clusters;
  assert.equal(k.label, "Middle");
  for (const n of l.nodes) {
    const inside = n.x >= k.x && n.x + n.w <= k.x + k.w && n.y >= k.y && n.y + n.h <= k.y + k.h;
    const apart = n.x + n.w <= k.x || n.x >= k.x + k.w || n.y + n.h <= k.y || n.y >= k.y + k.h;
    assert.ok(k.nodes.includes(n.id) ? inside : apart, `${dir}: ${n.id} and the box`);
  }
  assert.ok(l.arrows.find((a) => a.from === "t" && a.to === "s")!.back);
}

assert.deepEqual(flatten(flow([["a", "b"]])).rows, [{ from: "a", label: "", to: "b" }]);
console.log("viewexport ok");
