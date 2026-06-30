import { AGENT_SOURCE, PROTOCOL_VERSION, isHostMessage } from "./protocol";
import type { AgentMessage, Mode } from "./protocol";
import { captureElement, capturePin, cssPath } from "./capture";

export function installAgent(win: Window = window): void {
  let mode: Mode = "idle";
  let nonce = "";
  let parentOrigin = "*";
  let counter = 0;
  let overlay: HTMLDivElement | null = null;
  let label: HTMLDivElement | null = null;
  let savedCursor: string | null = null;
  function applyCursor() {
    const body = win.document.body;
    if (!body) return;
    if (mode !== "idle") {
      if (savedCursor === null) savedCursor = body.style.cursor;
      body.style.cursor = "crosshair";
    } else if (savedCursor !== null) {
      body.style.cursor = savedCursor;
      savedCursor = null;
    }
  }

  const post = (msg: AgentMessage) => win.parent.postMessage(msg, parentOrigin);

  function ensureOverlay(): HTMLDivElement {
    if (overlay) return overlay;
    const d = win.document.createElement("div");
    d.setAttribute("data-mystical-overlay", "");
    Object.assign(d.style, {
      position: "fixed", pointerEvents: "none", zIndex: "2147483646",
      border: "1.5px solid #7fe9d8", background: "rgba(127,233,216,0.10)",
      borderRadius: "3px", boxShadow: "0 0 0 1px rgba(7,13,13,0.5)",
      transition: "all 50ms ease-out", display: "none",
    } as CSSStyleDeclaration);
    win.document.body.appendChild(d);
    overlay = d;
    return d;
  }

  // A floating inspector chip (tag · #id · .class · WxH) pinned to the element.
  function ensureLabel(): HTMLDivElement {
    if (label) return label;
    const d = win.document.createElement("div");
    d.setAttribute("data-mystical-overlay", "");
    Object.assign(d.style, {
      position: "fixed", pointerEvents: "none", zIndex: "2147483647",
      display: "none", maxWidth: "340px", boxSizing: "border-box",
      padding: "3px 8px", borderRadius: "5px",
      background: "rgba(8,13,16,0.96)", border: "1px solid rgba(127,233,216,0.28)",
      boxShadow: "0 4px 14px rgba(0,0,0,0.45)",
      font: "500 11px/1.5 ui-monospace,'JetBrains Mono',SFMono-Regular,Menlo,monospace",
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", letterSpacing: ".02em",
    } as CSSStyleDeclaration);
    win.document.body.appendChild(d);
    label = d;
    return d;
  }
  function chip(text: string, color: string, opacity = 1): HTMLSpanElement {
    const s = win.document.createElement("span");
    s.textContent = text;
    s.style.color = color;
    if (opacity !== 1) s.style.opacity = String(opacity);
    return s;
  }
  function fillLabel(el: Element, r: DOMRect) {
    const lab = ensureLabel();
    lab.textContent = "";
    lab.appendChild(chip(el.tagName.toLowerCase(), "#7fe9d8"));
    if (el.id) lab.appendChild(chip(`#${el.id}`, "#e6c07b"));
    if (el.classList.length) {
      const more = el.classList.length > 1 ? `+${el.classList.length - 1}` : "";
      lab.appendChild(chip(`.${el.classList[0]}${more}`, "#9fb6d0"));
    }
    const dim = chip(`${Math.round(r.width)}×${Math.round(r.height)}`, "#dff8f2", 0.5);
    dim.style.marginLeft = "6px";
    lab.appendChild(dim);
    lab.style.display = "block";
    // Pin above the element's top-left; flip below when there's no room above,
    // and clamp horizontally so the chip stays on-screen.
    const lh = lab.offsetHeight || 22;
    const lw = lab.offsetWidth || 0;
    let top = r.top - lh - 6;
    if (top < 4) top = Math.min(r.bottom + 6, win.innerHeight - lh - 4);
    let left = Math.max(4, r.left);
    if (left + lw > win.innerWidth - 4) left = Math.max(4, win.innerWidth - lw - 4);
    lab.style.left = left + "px";
    lab.style.top = top + "px";
  }

  function moveOverlay(el: Element | null) {
    const o = ensureOverlay();
    const lab = ensureLabel();
    if (!el) { o.style.display = "none"; lab.style.display = "none"; return; }
    const r = el.getBoundingClientRect();
    Object.assign(o.style, { display: "block", left: r.x + "px", top: r.y + "px", width: r.width + "px", height: r.height + "px" });
    fillLabel(el, r);
  }
  function targetAt(x: number, y: number): Element | null {
    const el = win.document.elementFromPoint(x, y);
    if (!el || el === overlay || el === label) return null;
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
if (typeof window !== "undefined" && !(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.VITEST) {
  installAgent(window);
}
