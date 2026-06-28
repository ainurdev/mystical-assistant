"use strict";
(() => {
  // src/protocol.ts
  var PROTOCOL_VERSION = 1;
  var HOST_SOURCE = "mystical-selector-host";
  var AGENT_SOURCE = "mystical-selector-agent";
  function isHostMessage(d, nonce) {
    return !!d && typeof d === "object" && d.source === HOST_SOURCE && d.nonce === nonce;
  }

  // src/capture.ts
  var MAX_TEXT = 120;
  var MAX_HTML = 500;
  var STYLE_KEYS = ["color", "backgroundColor", "fontSize", "fontWeight", "display", "padding", "margin"];
  function trunc(s, n) {
    s = s.replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n) + "\u2026" : s;
  }
  function cssPath(el) {
    if (el.id) return `#${el.id}`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node.tagName !== "BODY" && node.tagName !== "HTML") {
      if (node.id) {
        parts.unshift(`#${node.id}`);
        break;
      }
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sibs.length > 1) {
          parts.unshift(`${tag}:nth-of-type(${sibs.indexOf(node) + 1})`);
        } else {
          parts.unshift(tag);
        }
      } else {
        parts.unshift(tag);
      }
      node = parent;
    }
    return parts.join(" > ");
  }
  function readMloc(el) {
    const found = el.closest("[data-mloc]");
    return found ? found.getAttribute("data-mloc") : null;
  }
  function captureElement(el, id) {
    const rect = el.getBoundingClientRect();
    const styles = {};
    const cs = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
    if (cs) for (const k of STYLE_KEYS) styles[k] = cs.getPropertyValue(k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()));
    return {
      kind: "element",
      id,
      mloc: readMloc(el),
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      idAttr: el.id || null,
      classList: Array.from(el.classList),
      text: trunc(el.textContent ?? "", MAX_TEXT),
      outerHTML: trunc(el.outerHTML, MAX_HTML),
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      styles
    };
  }
  function capturePin(el, point, id) {
    return {
      kind: "pin",
      id,
      mloc: el ? readMloc(el) : null,
      nearestSelector: el ? cssPath(el) : null,
      nearestTag: el ? el.tagName.toLowerCase() : null,
      point
    };
  }

  // src/agent.ts
  function installAgent(win = window) {
    let mode = "idle";
    let nonce = "";
    let parentOrigin = "*";
    let counter = 0;
    let overlay = null;
    const post = (msg) => win.parent.postMessage(msg, parentOrigin);
    function ensureOverlay() {
      if (overlay) return overlay;
      const d = win.document.createElement("div");
      d.setAttribute("data-mystical-overlay", "");
      Object.assign(d.style, {
        position: "fixed",
        pointerEvents: "none",
        zIndex: "2147483647",
        border: "2px solid #3b82f6",
        background: "rgba(59,130,246,0.12)",
        borderRadius: "2px",
        transition: "all 40ms linear",
        display: "none"
      });
      win.document.body.appendChild(d);
      overlay = d;
      return d;
    }
    function moveOverlay(el) {
      const o = ensureOverlay();
      if (!el) {
        o.style.display = "none";
        return;
      }
      const r = el.getBoundingClientRect();
      Object.assign(o.style, { display: "block", left: r.x + "px", top: r.y + "px", width: r.width + "px", height: r.height + "px" });
    }
    function targetAt(x, y) {
      const el = win.document.elementFromPoint(x, y);
      if (!el || el === overlay) return null;
      return el;
    }
    function onMove(e) {
      if (mode === "idle") return;
      const el = targetAt(e.clientX, e.clientY);
      moveOverlay(el);
      post({ source: AGENT_SOURCE, type: "hover", label: el ? `${el.tagName.toLowerCase()} \xB7 ${cssPath(el)}` : null });
    }
    function onClick(e) {
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
    win.addEventListener("message", (e) => {
      if (!nonce) {
        const d = e.data;
        if (d && d.source === "mystical-selector-host" && d.type === "init" && typeof d.nonce === "string") {
          nonce = d.nonce;
          parentOrigin = d.parentOrigin || e.origin || "*";
          mode = d.mode ?? "idle";
        }
        return;
      }
      if (!isHostMessage(e.data, nonce)) return;
      const msg = e.data;
      if (msg.type === "setMode") mode = msg.mode;
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
  if (typeof window !== "undefined") installAgent(window);
})();
