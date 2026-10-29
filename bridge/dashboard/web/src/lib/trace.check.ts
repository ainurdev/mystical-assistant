// Run: node src/lib/trace.check.ts  (from web/)
import { byFile, defSpan, importSource, navBack, navFwd, navPush, NAV0, rankDefs, signature, wordAt } from "./trace.ts";

let n = 0;
const eq = (got: unknown, want: unknown, what: string) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`FAIL: ${what}\n  got  ${g}\n  want ${w}`);
  n++;
};

// wordAt: either side of the cursor, identifiers only
eq(wordAt("  const content = tidy(raw);", 10), { word: "content", from: 8, to: 15 }, "cursor at a word's start");
eq(wordAt("  const content = tidy(raw);", 15)?.word, "content", "cursor right after a word");
eq(wordAt("a = $el.x", 5)?.word, "$el", "$ is part of a JS name");
eq(wordAt("x = 42;", 5), null, "a number is not a name");
eq(wordAt("a + b", 2), null, "an operator is not a name");

// importSource: ES imports resolved against the file list
const files = ["src/lib/editorctx.ts", "src/lib/tabs.ts", "src/components/Markdown.tsx", "src/components/hud/EditorTab.tsx",
  "src/lib/symbols.ts", "src/ui/index.ts", "bridge/git.py", "bridge/dashboard/server.py", "bridge/__init__.py", "bridge/fmt.py"];
const from = "src/components/hud/EditorTab.tsx";
const ts = [
  'import "./side-effect.css";',
  'import { useEffect } from "react";',
  'import { registerEditor } from "../../lib/editorctx";',
  "import {",
  "  nextFocus, previewTabs as pt,",
  "  type TreeRow,",
  '} from "../../lib/tabs";',
  'import Markdown from "../Markdown";',
  'import * as ui from "../../ui";',
  'import { symbolsIn } from "../../lib/symbols.ts";',
].join("\n");
eq(importSource(ts, "registerEditor", from, files), "src/lib/editorctx.ts", "named import");
eq(importSource(ts, "pt", from, files), "src/lib/tabs.ts", "aliased name in a multi-line import");
eq(importSource(ts, "TreeRow", from, files), "src/lib/tabs.ts", "type-only name");
eq(importSource(ts, "Markdown", from, files), "src/components/Markdown.tsx", "default import, extension found");
eq(importSource(ts, "ui", from, files), "src/ui/index.ts", "namespace import of a folder index");
eq(importSource(ts, "symbolsIn", from, files), "src/lib/symbols.ts", "import that names its .ts extension");
eq(importSource(ts, "useEffect", from, files), null, "a package has nothing to open");
eq(importSource(ts, "previewTabs", from, files), null, "the original name of an alias is not in scope");
eq(importSource(ts, "missing", from, files), null, "not imported at all");

const py = ["from bridge import git", "from . import fmt", "from .git import (", "    grep,", "    read_file as rf,", ")", "import os"].join("\n");
eq(importSource(py, "git", "bridge/dashboard/server.py", files), "bridge/__init__.py", "from package import name → the package");
eq(importSource(py, "fmt", "bridge/dashboard/server.py", files), null, "relative `from . import` of a sibling that isn't there");
eq(importSource(py, "rf", "bridge/x.py", files), "bridge/git.py", "relative module, parenthesised names, alias");
eq(importSource(py, "os", "bridge/x.py", files), null, "stdlib import");

// rankDefs: import source, then this file, then the nearest path
const hits = [
  { path: "src/other/far.ts", line: 3, text: "function save() {" },
  { path: "src/components/hud/near.ts", line: 9, text: "function save() {" },
  { path: from, line: 552, text: "async function save() {" },
  { path: "src/lib/editorctx.ts", line: 39, text: "export function save() {" },
  { path: from, line: 552, text: "async function save() {" },
];
eq(rankDefs(hits, from, "src/lib/editorctx.ts").map((h) => `${h.path}:${h.line}`),
  ["src/lib/editorctx.ts:39", `${from}:552`, "src/components/hud/near.ts:9", "src/other/far.ts:3"], "ranked and deduped");

// defSpan + signature: the comment above, the body under, capped
const src = [
  "const a = 1;",
  "/** Returns the unregister. A box rebuilt under the same id",
  " *  replaces the old entry. */",
  "export function registerEditor(id: string): () => void {",
  "  editors.set(id, entry);",
  "",
  "  return () => {};",
  "}",
  "",
  "export const treeKey = (p: string, b: string) => `${p}\\n${b}`;",
  "export const next = 2;",
  "def handle(self, req):",
  "    if req:",
  "        return 1",
  "    return 0",
  "def other():",
].join("\n").split("\n");
eq(defSpan(src, 4), [2, 8], "doc comment + body + closing brace");
eq(defSpan(src, 10), [10, 10], "a one-liner is one line");
eq(defSpan(src, 12), [12, 15], "python body by indentation");
eq(defSpan(src, 4, 3), [2, 5], "capped at max lines, trailing blank dropped");
eq(signature(src, 4), { sig: "function registerEditor(id: string): () => void", doc: "Returns the unregister. A box rebuilt under the same id replaces the old entry." }, "signature + doc");
eq(signature(src, 12).sig, "def handle(self, req)", "python signature drops the colon");
const block = ["", "  /* The two save-time fixups VS Code does by default, both overridable per", "     project through .editorconfig. */", "  function tidy(text: string): string {", "    return text;", "  }"];
eq(signature(block, 4), { sig: "function tidy(text: string): string", doc: "The two save-time fixups VS Code does by default, both overridable per project through .editorconfig." }, "a block comment whose lines don't start with *");
eq(defSpan(block, 4), [2, 6], "the block comment belongs to the span");

// nav: push forgets forward, back/forward swap ends
let nav = navPush(NAV0, { path: "a.ts", line: 10 });
nav = navPush(nav, { path: "a.ts", line: 11 });   // near the last one: not a new step
eq(nav.back.length, 1, "a jump from where you just were adds nothing");
nav = navPush(nav, { path: "b.ts", line: 5 });
let to; [nav, to] = navBack(nav, { path: "c.ts", line: 1 });
eq(to, { path: "b.ts", line: 5 }, "back returns the last place");
[nav, to] = navFwd(nav, { path: "b.ts", line: 5 });
eq(to, { path: "c.ts", line: 1 }, "forward returns where back left");
eq(navPush(nav, { path: "d.ts", line: 1 }).fwd, [], "a new jump drops the forward stack");
eq(navBack(NAV0, { path: "a", line: 1 })[1], null, "nothing to go back to");

eq(byFile(hits.slice(0, 3)).map(([p, l]) => `${p}:${l.length}`), ["src/other/far.ts:1", "src/components/hud/near.ts:1", `${from}:1`], "byFile keeps first-seen order");

console.log(`trace.check: ${n} ok`);
