import { describe, it, expect } from "vitest";
import { createSelectorController } from "../src/controller";
import { AGENT_SOURCE } from "../src/protocol";

function setup() {
  const posted: any[] = [];
  const iframe = { contentWindow: { postMessage: (m: any) => posted.push(m) } } as unknown as HTMLIFrameElement;
  const listeners: ((e: MessageEvent) => void)[] = [];
  const win = {
    addEventListener: (_t: string, cb: any) => listeners.push(cb),
    removeEventListener: (_t: string, cb: any) => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); },
  } as unknown as Window;
  const ctrl = createSelectorController({ iframe, iframeOrigin: "https://preview.test", nonce: "N", win });
  const emit = (data: any, origin = "https://preview.test") => listeners.forEach((l) => l({ data, origin } as MessageEvent));
  return { ctrl, posted, emit };
}

describe("controller", () => {
  it("sends init after the agent reports ready", () => {
    const { ctrl, posted, emit } = setup();
    emit({ source: AGENT_SOURCE, type: "ready", version: 1 });
    expect(ctrl.getState().ready).toBe(true);
    expect(posted.some((m) => m.type === "init" && m.nonce === "N")).toBe(true);
  });
  it("collects captures into the tray", () => {
    const { ctrl, emit } = setup();
    emit({ source: AGENT_SOURCE, type: "captured", capture: { kind: "element", id: "c1", tag: "button", classList: [], text: "Go", selector: "button", idAttr: null, mloc: null, outerHTML: "", rect: { x: 0, y: 0, w: 0, h: 0 }, styles: {} } });
    expect(ctrl.getState().items).toHaveLength(1);
  });
  it("rejects messages from a foreign origin", () => {
    const { ctrl, emit } = setup();
    emit({ source: AGENT_SOURCE, type: "captured", capture: { kind: "pin", id: "p", point: { x: 1, y: 2 }, mloc: null, nearestSelector: null, nearestTag: null } }, "https://evil.test");
    expect(ctrl.getState().items).toHaveLength(0);
  });
  it("edits notes and removes items, producing a fresh state object", () => {
    const { ctrl, emit } = setup();
    const before = ctrl.getState();
    emit({ source: AGENT_SOURCE, type: "captured", capture: { kind: "pin", id: "p1", point: { x: 0, y: 0 }, mloc: null, nearestSelector: null, nearestTag: null } });
    ctrl.setNote("p1", "hello");
    expect(ctrl.getState().items[0].note).toBe("hello");
    ctrl.remove("p1");
    expect(ctrl.getState().items).toHaveLength(0);
    expect(ctrl.getState()).not.toBe(before);
  });
});
