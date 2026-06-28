import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import _generate from "@babel/generator";
import * as t from "@babel/types";

// @babel ESM/CJS interop: the default export is nested under `.default` in ESM.
const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse) as typeof _traverse;
const generate = ((_generate as unknown as { default?: typeof _generate }).default ?? _generate) as typeof _generate;

export function injectLoc(code: string, relPath: string): string {
  let ast;
  try {
    ast = parse(code, { sourceType: "module", plugins: ["jsx", "typescript"] });
  } catch {
    return code; // never break a build over a parse error
  }
  let changed = false;
  traverse(ast, {
    JSXOpeningElement(path) {
      const node = path.node;
      const name = node.name;
      if (t.isJSXIdentifier(name) && name.name === "Fragment") return;
      const has = node.attributes.some(
        (a) => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name, { name: "data-mloc" }),
      );
      if (has) return;
      const line = node.loc?.start.line ?? 0;
      const col = (node.loc?.start.column ?? 0) + 1;
      node.attributes.push(
        t.jsxAttribute(t.jsxIdentifier("data-mloc"), t.stringLiteral(`${relPath}:${line}:${col}`)),
      );
      changed = true;
    },
  });
  if (!changed) return code;
  return generate(ast, { retainLines: true }).code;
}
