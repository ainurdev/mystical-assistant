import { EditorState, type Text } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";

/* Definitions worth jumping to, for the EDITOR's `@` outline, its OUTLINE view,
   the breadcrumbs, the sticky header and the status bar's "ƒ save". The
   language's own parser already worked these out, so read them off the syntax
   tree rather than re-guessing with a regex — that gets Python `def`, PHP
   methods, Rust `impl` blocks and the rest right per grammar, including
   nesting, and never fires inside a string or a comment.

   Lezer grammars name their definition nodes consistently enough for one
   pattern to cover every language CodeMirror ships; symbols.check.ts pins the
   node names for Python, PHP and TypeScript. */
const DEF_NODE = /(Function|Class|Method|Interface|Type|Enum|Struct|Trait|Impl|Namespace|Module|Record|Property)\w*(Definition|Declaration|Item)$/;
const NAME_NODE = /(Definition|Identifier|Name)$/;

export interface Symbol {
  name: string;
  kind: string;
  line: number;
  /** The whole definition, as document offsets — what "the function I'm in" is measured against. */
  from: number;
  to: number;
  /** Definitions around this one: 0 at the top level. */
  depth: number;
}

// One walk per document: the outline, the breadcrumbs, the sticky header and
// the status bar all ask on every cursor move. A partial parse isn't kept —
// the finished tree would answer differently.
const memo = new WeakMap<Text, Symbol[]>();

/** `budget`: ms the parser may spend reaching the end of the doc. */
export function symbolsIn(state: EditorState, budget = 5000): Symbol[] {
  const hit = memo.get(state.doc);
  if (hit) return hit;
  // Big files are only parsed as far as the viewport; ask for the whole doc,
  // and fall back to the partial tree if that blows the time budget.
  const full = ensureSyntaxTree(state, state.doc.length, budget);
  const out: Symbol[] = [];
  const open: number[] = [];   // where the definitions we're inside end
  (full ?? syntaxTree(state)).iterate({
    enter: (n) => {
      while (open.length && n.from >= open[open.length - 1]) open.pop();
      const isVar = n.name === "VariableDeclaration";
      if (!isVar && !DEF_NODE.test(n.name)) return;
      // `const x = 1` and `const r = useRef<() => void>()` are not outline
      // entries; `const f = () => {}` is.
      if (isVar && !n.node.getChild("ArrowFunction") && !n.node.getChild("FunctionExpression")) return;
      let name = "";
      for (let c = n.node.firstChild; c; c = c.nextSibling) {
        if (NAME_NODE.test(c.name)) { name = state.doc.sliceString(c.from, c.to); break; }
      }
      if (!name) return;
      out.push({
        name,
        kind: isVar ? "const" : n.name.replace(/(Definition|Declaration|Item)$/, "").toLowerCase(),
        line: state.doc.lineAt(n.from).number,
        from: n.from,
        to: n.to,
        depth: open.length,
      });
      open.push(n.to);
    },
  });
  if (full) memo.set(state.doc, out);
  return out;
}

/** The definitions around `pos`, outermost first. */
export function enclosing(state: EditorState, pos: number, budget?: number): Symbol[] {
  return symbolsIn(state, budget).filter((s) => s.from <= pos && pos <= s.to);
}
