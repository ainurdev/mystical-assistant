import { HOST_SOURCE, isAgentMessage } from "./protocol";
import type { Capture, Mode } from "./protocol";

export interface TrayItem {
  capture: Capture;
  note: string;
}
export interface SelectorState {
  ready: boolean;
  mode: Mode;
  hoverLabel: string | null;
  items: TrayItem[];
}
export interface SelectorController {
  getState(): SelectorState;
  subscribe(cb: () => void): () => void;
  setMode(mode: Mode): void;
  setNote(id: string, note: string): void;
  remove(id: string): void;
  clear(): void;
  destroy(): void;
}

export function createSelectorController(opts: {
  iframe: HTMLIFrameElement;
  iframeOrigin: string;
  nonce: string;
  win?: Window;
}): SelectorController {
  const win = opts.win ?? window;
  let state: SelectorState = { ready: false, mode: "idle", hoverLabel: null, items: [] };
  const subs = new Set<() => void>();

  const set = (patch: Partial<SelectorState>) => {
    state = { ...state, ...patch };
    subs.forEach((cb) => cb());
  };
  const send = (msg: Record<string, unknown>) =>
    opts.iframe.contentWindow?.postMessage({ source: HOST_SOURCE, nonce: opts.nonce, ...msg }, opts.iframeOrigin);

  const onMessage = (e: MessageEvent) => {
    if (e.origin !== opts.iframeOrigin) return;
    if (!isAgentMessage(e.data)) return;
    const msg = e.data;
    if (msg.type === "ready") {
      set({ ready: true });
      send({ type: "init", parentOrigin: win.location?.origin ?? "*", mode: state.mode });
    } else if (msg.type === "hover") {
      set({ hoverLabel: msg.label });
    } else if (msg.type === "captured") {
      set({ items: [...state.items, { capture: msg.capture, note: "" }] });
    }
  };
  win.addEventListener("message", onMessage);

  return {
    getState: () => state,
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    setMode(mode) {
      set({ mode });
      send({ type: "setMode", mode });
    },
    setNote(id, note) {
      set({ items: state.items.map((it) => (it.capture.id === id ? { ...it, note } : it)) });
    },
    remove(id) {
      set({ items: state.items.filter((it) => it.capture.id !== id) });
    },
    clear() {
      set({ items: [] });
      send({ type: "clear" });
    },
    destroy() {
      win.removeEventListener("message", onMessage);
      subs.clear();
    },
  };
}
