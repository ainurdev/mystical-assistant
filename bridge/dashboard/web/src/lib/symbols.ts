import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";

/* Definitions worth jumping to, for the EDITOR's `@` outline. The language's
   own parser already worked these out, so read them off the syntax tree rather
   than re-guessing with a regex — that gets Python `def`, PHP methods, Rust
   `impl` blocks and the rest right per grammar, including nesting, and never
   fires inside a string or a comment.

   Lezer grammars name their definition nodes consistently enough for one
   pattern to cover every language CodeMirror ships; symbols.check.ts pins the
   node names for Python, PHP and TypeScript. */
const DEF_NODE = /(Function|Class|Method|Interface|Type|Enum|Struct|Trait|Impl|Namespace|Module|Record|Property)\w*(Definition|Declaration|Item)$/;
const NAME_NODE = /(Definition|Identifier|Name)$/;

export interface Symbol {
  name: string;
  kind: string;
  line: number;
}

export function symbolsIn(state: EditorState): Symbol[] {
  // Big files are only parsed as far as the viewport; ask for the whole doc,
  // and fall back to the partial tree if that blows the time budget.
  const tree = ensureSyntaxTree(state, state.doc.length, 5000) ?? syntaxTree(state);
  const out: Symbol[] = [];
  tree.iterate({
    enter: (n) => {
      const isVar = n.name === "VariableDeclaration";
      if (!isVar && !DEF_NODE.test(n.name)) return;
      // `const x = 1` is not an outline entry; `const f = () => {}` is.
      if (isVar && !/=>|\bfunction\b/.test(state.doc.sliceString(n.from, Math.min(n.to, n.from + 240)))) return;
      let name = "";
      for (let c = n.node.firstChild; c; c = c.nextSibling) {
        if (NAME_NODE.test(c.name)) { name = state.doc.sliceString(c.from, c.to); break; }
      }
      if (!name) return;
      out.push({
        name,
        kind: isVar ? "const" : n.name.replace(/(Definition|Declaration|Item)$/, "").toLowerCase(),
        line: state.doc.lineAt(n.from).number,
      });
    },
  });
  return out;
}
