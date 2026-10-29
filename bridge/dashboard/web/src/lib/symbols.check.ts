// Run: node --experimental-strip-types src/lib/symbols.check.ts  (from web/)
//
// The outline reads definition nodes off the syntax tree, so the node-name
// patterns in EditorTab have to actually match what each grammar emits. This
// pins that per language — a lezer upgrade that renames a node fails here.
import { EditorState } from "@codemirror/state";
import { enclosing, symbolsIn } from "./symbols.ts";
import { langFor } from "./langfor.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

const cases: { file: string; src: string; want: string[] }[] = [
  {
    file: "a.py",
    src: [
      "import os",
      "",
      "def top_level(a, b):",
      "    return a",
      "",
      "async def fetch(url):",
      "    pass",
      "",
      "class Thing:",
      "    def method(self):",
      "        if True:",       // `if` must not be mistaken for a definition
      "            pass",
      "",
      "NOT_A_DEF = 3",
    ].join("\n"),
    want: ["top_level", "fetch", "Thing", "method"],
  },
  {
    file: "a.php",
    src: [
      "<?php",
      "namespace App\\Http;",
      "",
      "class Kernel extends HttpKernel {",
      "    public function handle($r) { return 1; }",
      "    private static function boot() {}",
      "}",
      "",
      "function helper(int $x): int { return $x; }",
    ].join("\n"),
    want: ["Kernel", "handle", "boot", "helper"],
  },
  {
    file: "a.ts",
    src: [
      "export function plain() {}",
      "export const arrow = (x: number) => x + 1;",
      "const notAFn = 42;",           // plain value — not an outline entry
      "const ref = useRef<() => void>(() => {});",   // a value whose type mentions =>
      "class Box { render() {} }",
      "interface Shape { n: number }",
    ].join("\n"),
    want: ["plain", "arrow", "Box", "render", "Shape"],
  },
];

for (const { file, src, want } of cases) {
  const desc = langFor(file);
  ok(!!desc, `${file} → language detected (${desc?.name})`);
  const state = EditorState.create({ doc: src, extensions: [await desc!.load()] });
  const got = symbolsIn(state).map((s) => s.name);
  ok(
    want.every((w) => got.includes(w)),
    `${file} outline has ${want.join(", ")} (got ${got.join(", ") || "nothing"})`,
  );
  ok(!got.includes("notAFn") && !got.includes("NOT_A_DEF") && !got.includes("ref"), `${file} skips plain values`);
}

// Nesting: the breadcrumbs, the sticky header and OUTLINE's indent read depth
// and the from/to range, and `enclosing` answers "which function am I in".
{
  const src = ["class Box {", "  render() {", "    return 1;", "  }", "}", "function after() {}"].join("\n");
  const state = EditorState.create({ doc: src, extensions: [await langFor("b.ts")!.load()] });
  const syms = symbolsIn(state);
  const render = syms.find((s) => s.name === "render");
  ok(syms.find((s) => s.name === "Box")?.depth === 0 && render?.depth === 1 && syms.find((s) => s.name === "after")?.depth === 0,
    `depth: Box 0, render 1, after 0 (got ${syms.map((s) => `${s.name}:${s.depth}`).join(" ")})`);
  const inside = src.indexOf("return");
  ok(enclosing(state, inside).map((s) => s.name).join(">") === "Box>render", "enclosing at `return` is Box > render");
  ok(enclosing(state, src.indexOf("after")).map((s) => s.name).join(">") === "after", "enclosing at `after` is after alone");
}

console.log("all ok");
