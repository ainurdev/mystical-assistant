// node --experimental-strip-types src/lib/docparts.check.ts
import assert from "node:assert/strict";
import { byGroup, docParts, outlinePrompt, writePrompt, type DocPage } from "./docparts.ts";

const parts = docParts('# Title\n\ntext\n\n```view\n{"type":"data","view":"stats","title":"T","items":[]}\n```\n\nmore');
assert.equal(parts.length, 3);
assert.equal((parts[1] as { view: { title: string } }).view.title, "T");
assert.match((parts[2] as { md: string }).md, /more/);
assert.deepEqual(docParts("only words").length, 1);
assert.match((docParts("```view\nnot json\n```")[0] as { md: string }).md, /not json/);
const p = (id: string, group: string): DocPage => ({ id, title: id, group, summary: "", sources: [], written: false, changed: [] });
assert.deepEqual(byGroup([p("a", "One"), p("b", "Two"), p("c", "One")]).map((g) => [g.group, g.pages.length]), [["One", 2], ["Two", 1]]);
assert.match(outlinePrompt("docs"), /location "docs"/);
assert.match(outlinePrompt("hidden"), /Don't write any pages yet/);
assert.match(writePrompt(["a"]), /docs page "a"/);
assert.match(writePrompt(["a", "b"]), /a, b/);
console.log("docparts ok");
