import { describe, it, expect, beforeEach } from "vitest";
import { cssPath, readMloc, captureElement, capturePin } from "../src/capture";

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

  it("truncates long text and outerHTML with an ellipsis", () => {
    const el = document.createElement("div");
    el.textContent = "x".repeat(600);
    document.body.appendChild(el);
    const cap = captureElement(el, "x2");
    expect(cap.text.endsWith("…")).toBe(true);
    expect(cap.text.length).toBe(121);
    expect(cap.outerHTML.endsWith("…")).toBe(true);
    expect(cap.outerHTML.length).toBe(501);
  });
});

describe("capturePin", () => {
  it("captures point and nearest element context", () => {
    const el = document.getElementById("go")!;
    const cap = capturePin(el, { x: 10, y: 20 }, "p1");
    expect(cap).toMatchObject({ kind: "pin", id: "p1", point: { x: 10, y: 20 } });
    expect(cap.nearestSelector).toBe(cssPath(el));
    expect(cap.nearestTag).toBe(el.tagName.toLowerCase());
    expect(cap.mloc).toBe("src/Hero.tsx:42:7");
  });

  it("nulls element fields but keeps the point when el is null", () => {
    const cap = capturePin(null, { x: 5, y: 7 }, "p2");
    expect(cap.nearestSelector).toBeNull();
    expect(cap.nearestTag).toBeNull();
    expect(cap.mloc).toBeNull();
    expect(cap.point).toEqual({ x: 5, y: 7 });
  });
});
