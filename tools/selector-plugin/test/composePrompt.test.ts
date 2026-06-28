import { describe, it, expect } from "vitest";
import { composePrompt } from "../src/composePrompt";
import type { ElementCapture, PinCapture } from "../src/protocol";

const el: ElementCapture = {
  kind: "element", id: "1", mloc: "src/Hero.tsx:42:7", selector: "main > section > button",
  tag: "button", idAttr: null, classList: ["btn-cta"], text: "Get started",
  outerHTML: "<button>…</button>", rect: { x: 0, y: 0, w: 10, h: 10 }, styles: {},
};
const pin: PinCapture = {
  kind: "pin", id: "2", mloc: null, nearestSelector: "footer", nearestTag: "footer",
  point: { x: 320, y: 980 },
};

describe("composePrompt", () => {
  it("includes source, note, instruction and breakpoint", () => {
    const out = composePrompt({
      project: "acme/site", width: 375,
      items: [{ capture: el, note: "make it blue" }, { capture: pin, note: "add signup" }],
      instruction: "tighten the hero",
    });
    expect(out).toContain("acme/site");
    expect(out).toContain("375px");
    expect(out).toContain("source: src/Hero.tsx:42:7");
    expect(out).toContain("note: make it blue");
    expect(out).toContain("PIN");
    expect(out).toContain("(320, 980)");
    expect(out).toContain("tighten the hero");
  });
  it("omits the source line when mloc is absent", () => {
    const out = composePrompt({
      project: null, width: 768,
      items: [{ capture: { ...el, mloc: null }, note: "" }], instruction: "x",
    });
    expect(out).not.toContain("source:");
    expect(out).toContain("selector: main > section > button");
  });
});
