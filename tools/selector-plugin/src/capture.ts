import type { ElementCapture, PinCapture } from "./protocol";

const MAX_TEXT = 120;
const MAX_HTML = 500;
const STYLE_KEYS = ["color", "backgroundColor", "fontSize", "fontWeight", "display", "padding", "margin"];

function trunc(s: string, n: number): string {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export function cssPath(el: Element): string {
  if (el.id) return `#${el.id}`;
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1 && node.tagName !== "BODY" && node.tagName !== "HTML") {
    if (node.id) {
      parts.unshift(`#${node.id}`);
      break;
    }
    const tag = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    if (parent) {
      const sibs = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
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

export function readMloc(el: Element): string | null {
  const found = el.closest("[data-mloc]");
  return found ? found.getAttribute("data-mloc") : null;
}

export function captureElement(el: Element, id: string): ElementCapture {
  const rect = el.getBoundingClientRect();
  const styles: Record<string, string> = {};
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
    styles,
  };
}

export function capturePin(el: Element | null, point: { x: number; y: number }, id: string): PinCapture {
  return {
    kind: "pin",
    id,
    mloc: el ? readMloc(el) : null,
    nearestSelector: el ? cssPath(el) : null,
    nearestTag: el ? el.tagName.toLowerCase() : null,
    point,
  };
}
