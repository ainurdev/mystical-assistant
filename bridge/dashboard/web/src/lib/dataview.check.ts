// node --experimental-strip-types src/lib/dataview.check.ts
import assert from "node:assert/strict";
import { chartSheet, delimited, domain, fmt, matches, overdue, sorted, sumOf, ticks, type ChartEv, type Col } from "./dataview.ts";

const t = ticks(0, 87);
assert.equal(t[0], 0);
assert.ok(t[t.length - 1] >= 87 && t.length <= 8, String(t));
assert.deepEqual(ticks(0, 0).slice(0, 1), [0]);
const neg = ticks(-30, 40);
assert.ok(neg[0] <= -30 && neg.includes(0), String(neg));

const rows = [{ a: 2, b: "x" }, { a: null, b: "item 10" }, { a: 10, b: "item 9" }];
assert.deepEqual(sorted(rows, "a", 1).map((r) => r.a), [2, 10, null]);
assert.deepEqual(sorted(rows, "a", -1).map((r) => r.a), [10, 2, null]);        // blanks last both ways
assert.deepEqual(sorted(rows, "b", 1).map((r) => r.b), ["item 9", "item 10", "x"]);
assert.equal(sorted(rows, null, 1), rows);

const cols: Col[] = [{ key: "a", label: "A", type: "number" }, { key: "b", label: "B, b", type: "text" }];
assert.equal(matches(rows[1], cols, "ITEM"), true);
assert.equal(matches(rows[0], cols, "item"), false);
assert.deepEqual(sumOf(rows, cols, { a: 12 }), { a: 12 });
assert.equal(delimited(cols, [{ a: -1, b: "=HYPERLINK(1)" }], ","), '"B, b"'.replace(/^/, "A,") + "\n-1,'=HYPERLINK(1)");
assert.equal(delimited(cols, [{ a: 1, b: 'say "hi", ok' }], ",").split("\n")[1], '1,"say ""hi"", ok"');
assert.equal(delimited(cols, [{ a: 1, b: "a\tb" }], "\t").split("\n")[1], "1\ta b");

assert.match(fmt(1234.5, "money", "EUR"), /1.234|1,234/);
assert.equal(fmt(12, "percent"), "12%");
assert.equal(fmt(null), "");
assert.match(fmt(1234.5, "money", "NOPE!"), /1.234.50|1,234.50/);        // a bad code still reads

const chart = (over: Partial<ChartEv>): ChartEv => ({ type: "data", view: "chart", title: "T", kind: "bar", format: "number",
  series: [{ key: "n", label: "N" }, { key: "m", label: "M" }], points: [{ x: "a", n: 80, m: 90 }, { x: "b", n: 85, m: null }], ...over });
assert.deepEqual(domain(chart({})), [0, 90]);                            // bars from zero
assert.deepEqual(domain(chart({ kind: "line" })), [80, 90]);             // a line may zoom
assert.deepEqual(domain(chart({ kind: "bar_stacked" })), [0, 170]);
assert.deepEqual(domain(chart({ points: [{ x: "a", n: -5, m: 3 }] })), [-5, 3]);
assert.deepEqual(domain(chart({ points: [] })), [0, 1]);
const burn = chartSheet(chart({ kind: "burndown", ideal: [10, 0] }));
assert.deepEqual(burn.columns.map((c) => c.label), ["", "N", "M", "Ideal"]);
assert.equal(burn.rows[1].__ideal, 0);

assert.equal(overdue("2026-01-01", "To do", "2026-11-07"), true);
assert.equal(overdue("2026-01-01", "Done", "2026-11-07"), false);
assert.equal(overdue("2027-01-01", "To do", "2026-11-07"), false);
assert.equal(overdue(null, "To do"), false);
console.log("dataview ok");
