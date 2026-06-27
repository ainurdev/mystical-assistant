import { describe, it, expect } from "vitest";
import { injectLoc } from "../src/jsx-loc";

describe("injectLoc", () => {
  it("stamps data-mloc with the element's line", () => {
    const src = `export const A = () => (\n  <button>Hi</button>\n);\n`;
    const out = injectLoc(src, "src/A.tsx");
    expect(out).toMatch(/data-mloc="src\/A\.tsx:2:\d+"/);
  });
  it("does not double-stamp", () => {
    const src = `const A = () => <i data-mloc="x">!</i>;`;
    const out = injectLoc(src, "src/A.tsx");
    expect(out.match(/data-mloc/g)!.length).toBe(1);
  });
  it("leaves non-JSX code valid", () => {
    const src = `export const n = 1 + 2;`;
    expect(injectLoc(src, "src/n.ts")).toContain("1 + 2");
  });
});
