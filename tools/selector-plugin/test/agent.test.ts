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
