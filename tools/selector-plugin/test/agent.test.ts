import { describe, it, expect, vi, beforeEach } from "vitest";
import { installAgent } from "../src/agent";
import { HOST_SOURCE } from "../src/protocol";

beforeEach(() => {
  document.body.innerHTML = `<button id="b">Hi</button>`;
});

function withParent() {
  const posted: unknown[] = [];
  // jsdom window.parent is the window itself; spy on postMessage.
  const spy = vi.spyOn(window, "postMessage").mockImplementation((m: unknown) => posted.push(m));
  return { posted, spy };
}

describe("agent cursor", () => {
  it("sets a crosshair cursor while armed and restores it on idle", () => {
    installAgent(window);
    const send = (type: string, mode: string) =>
      window.dispatchEvent(new MessageEvent("message", {
        data: { source: HOST_SOURCE, nonce: "n1", type, mode },
        origin: "http://localhost",
      }));
    send("init", "idle");          // handshake: registers nonce "n1"
    send("setMode", "select");
    expect(document.body.style.cursor).toBe("crosshair");
    send("setMode", "idle");
    expect(document.body.style.cursor).toBe("");
  });
});

describe("agent hover tooltip", () => {
  it("pins a floating label with tag + id while selecting", () => {
    installAgent(window);
    const send = (type: string, mode: string) =>
      window.dispatchEvent(new MessageEvent("message", {
        data: { source: HOST_SOURCE, nonce: "n1", type, mode },
        origin: "http://localhost",
      }));
    send("init", "idle");
    send("setMode", "select");
    const btn = document.getElementById("b")!;
    document.elementFromPoint = () => btn; // jsdom has no layout engine
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 5, clientY: 5, bubbles: true }));
    const chip = Array.from(document.querySelectorAll("[data-mystical-overlay]"))
      .find((n) => (n.textContent ?? "").includes("button"));
    expect(chip).toBeTruthy();
    expect(chip!.textContent).toContain("button");
    expect(chip!.textContent).toContain("#b");
  });
});

describe("agent handshake", () => {
  it("announces ready on load", () => {
    const { posted } = withParent();
    installAgent(window);
    window.dispatchEvent(new Event("DOMContentLoaded"));
    expect(posted.some((m) => (m as { type?: string }).type === "ready")).toBe(true);
  });
  it("ignores host messages with the wrong nonce", () => {
    installAgent(window);
    const ev = new MessageEvent("message", {
      data: { source: HOST_SOURCE, nonce: "WRONG", type: "setMode", mode: "select" },
      origin: "http://localhost",
    });
    window.dispatchEvent(ev);
    // No throw, mode unchanged — agent stays idle (no overlay element created).
    expect(document.querySelector("[data-mystical-overlay]")).toBeNull();
  });
});
