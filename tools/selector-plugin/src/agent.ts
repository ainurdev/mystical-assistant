import { AGENT_SOURCE, PROTOCOL_VERSION, isHostMessage } from "./protocol";
import type { AgentMessage, Mode } from "./protocol";
import { captureElement, capturePin, cssPath } from "./capture";

export function installAgent(win: Window = window): void {
  let mode: Mode = "idle";
  let nonce = "";
  let parentOrigin = "*";
  let counter = 0;
  let overlay: HTMLDivElement | null = null;
  let savedCursor: string | null = null;
  function applyCursor() {
    const body = win.document.body;
    if (!body) return;
    if (mode !== "idle") {
      if (savedCursor === null) savedCursor = body.style.cursor;
      body.style.cursor = "crosshair";
    } else if (savedCursor !== null) {
      if (body.style.cursor === "crosshair") body.style.cursor = savedCursor;
      savedCursor = null;
    }
  }

  const post = (msg: AgentMessage) => win.parent.postMessage(msg, parentOrigin);

  function ensureOverlay(): HTMLDivElement {
    if (overlay) return overlay;
    const d = win.document.createElement("div");
    d.setAttribute("data-mystical-overlay", "");
    Object.assign(d.style, {
      position: "fixed", pointerEvents: "none", zIndex: "2147483647",
      border: "2px solid #3b82f6", background: "rgba(59,130,246,0.12)",
      borderRadius: "2px", transition: "all 40ms linear", display: "none",
    } as CSSStyleDeclaration);
    win.document.body.appendChild(d);
    overlay = d;
    return d;
  }
  function moveOverlay(el: Element | null) {
    const o = ensureOverlay();
    if (!el) { o.style.display = "none"; return; }
    const r = el.getBoundingClientRect();
    Object.assign(o.style, { display: "block", left: r.x + "px", top: r.y + "px", width: r.width + "px", height: r.height + "px" });
  }
  function targetAt(x: number, y: number): Element | null {
    const el = win.document.elementFromPoint(x, y);
    if (!el || el === overlay) return null;
    return el;
  }

  function onMove(e: MouseEvent) {
    if (mode === "idle") return;
    const el = targetAt(e.clientX, e.clientY);
    moveOverlay(el);
    post({ source: AGENT_SOURCE, type: "hover", label: el ? `${el.tagName.toLowerCase()} · ${cssPath(el)}` : null });
  }
  function onClick(e: MouseEvent) {
    if (mode === "idle") return;
    e.preventDefault();
    e.stopPropagation();
    const el = targetAt(e.clientX, e.clientY);
    const id = `c${++counter}`;
    if (mode === "pin") {
      post({ source: AGENT_SOURCE, type: "captured", capture: capturePin(el, { x: e.clientX, y: e.clientY }, id) });
    } else if (el) {
      post({ source: AGENT_SOURCE, type: "captured", capture: captureElement(el, id) });
    }
  }

  win.addEventListener("message", (e: MessageEvent) => {
    if (!nonce) {
      // First valid init sets the session nonce + origin.
      const d = e.data as { source?: string; type?: string; nonce?: string; parentOrigin?: string; mode?: Mode };
      if (d && d.source === "mystical-selector-host" && d.type === "init" && typeof d.nonce === "string") {
        nonce = d.nonce;
        parentOrigin = d.parentOrigin || e.origin || "*";
        mode = d.mode ?? "idle";
        applyCursor();
      }
      return;
    }
    if (!isHostMessage(e.data, nonce)) return;
    const msg = e.data;
    if (msg.type === "setMode") { mode = msg.mode; applyCursor(); }
    else if (msg.type === "clear") moveOverlay(null);
    else if (msg.type === "highlight") moveOverlay(msg.selector ? win.document.querySelector(msg.selector) : null);
    if (mode === "idle") moveOverlay(null);
  });

  win.addEventListener("mousemove", onMove, true);
  win.addEventListener("click", onClick, true);

  const announce = () => post({ source: AGENT_SOURCE, type: "ready", version: PROTOCOL_VERSION });
  if (win.document.readyState === "loading") win.addEventListener("DOMContentLoaded", announce);
  else announce();
}

// Auto-install when delivered as a script into a page.
if (typeof window !== "undefined") installAgent(window);
