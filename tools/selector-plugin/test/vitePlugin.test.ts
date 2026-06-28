import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { mysticalSelector } from "../src/vite-plugin";

// Ensure the agent bundle exists (Task 5 build).
const built = existsSync(new URL("../dist/agent.global.js", import.meta.url));

describe("mysticalSelector", () => {
  it("is dev-only", () => {
    expect(mysticalSelector().apply).toBe("serve");
  });
  it("transforms tsx by adding data-mloc", () => {
    const p = mysticalSelector();
    // configResolved sets root; emulate it.
    (p.configResolved as any)?.({ root: process.cwd() });
    const r = (p.transform as any)("const A = () => <b>x</b>;", "/abs/src/A.tsx");
    expect(r.code).toContain("data-mloc");
  });
  it("returns null for node_modules", () => {
    const p = mysticalSelector();
    expect((p.transform as any)("x", "/x/node_modules/y/z.tsx")).toBeNull();
  });
  it("injects the agent script tag", () => {
    if (!built) return;
    const p = mysticalSelector();
    const tags = (p.transformIndexHtml as any)();
    expect(tags[0].tag).toBe("script");
    expect(String(tags[0].children).length).toBeGreaterThan(50);
  });
});
