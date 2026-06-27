import { describe, it, expect, beforeEach } from "vitest";
import { cssPath, readMloc, captureElement } from "../src/capture";

beforeEach(() => {
  document.body.innerHTML = `
    <main>
      <section class="hero">
        <button class="btn btn-cta" id="go" data-mloc="src/Hero.tsx:42:7">Get started</button>
      </section>
    </main>`;
});

describe("cssPath", () => {
  it("prefers an id when present", () => {
    const el = document.getElementById("go")!;
    expect(cssPath(el)).toBe("#go");
  });
  it("builds an nth-of-type chain without ids", () => {
    const el = document.querySelector(".hero")!;
    expect(cssPath(el)).toBe("main > section");
  });
});

describe("readMloc", () => {
  it("reads the nearest data-mloc", () => {
    const el = document.getElementById("go")!;
    expect(readMloc(el)).toBe("src/Hero.tsx:42:7");
  });
  it("returns null when none exists", () => {
    expect(readMloc(document.querySelector(".hero")!)).toBeNull();
  });
});

describe("captureElement", () => {
  it("serializes tag, classes, text, mloc", () => {
    const cap = captureElement(document.getElementById("go")!, "x1");
    expect(cap).toMatchObject({
      kind: "element", id: "x1", tag: "button",
      idAttr: "go", classList: ["btn", "btn-cta"],
      text: "Get started", mloc: "src/Hero.tsx:42:7",
    });
    expect(cap.outerHTML.length).toBeLessThanOrEqual(500);
  });
});
