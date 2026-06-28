# Visual Element Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Design" mode that loads the running project in a resizable breakpoint frame, lets the user click real elements / drop pins, annotate each, and sends the set — with source `file:line` — to Claude through the existing run pipeline.

**Architecture:** A standalone, dev-only Vite plugin (`tools/selector-plugin/`) stamps `data-mloc="file:line:col"` onto JSX and injects an in-page **agent** that highlights elements and `postMessage`s captures out. A framework-agnostic **controller** (same package) drives the handshake + tray state. Each surface (Dashboard first, Mini App second) gets thin, app-styled view components that mount an `<iframe>` of the preview URL and wire submission to that surface's existing run path. A backend screenshot endpoint attaches a breakpoint capture by default (graceful if it fails).

**Tech Stack:** TypeScript, React 19, Vite 6, Vitest + jsdom (new, package-local only), `@babel/parser`/`traverse`/`generator`/`types`, esbuild, Python stdlib (`http.server`, `subprocess`), `chrome-headless-shell`.

## Global Constraints

- The selector agent + Vite plugin are **dev-only** — `apply: 'serve'` and gated so they never enter a production bundle.
- **No DB schema change. No new run path.** Submission reuses `api.run` (dashboard `/local/run`, miniapp `/api/run`) and the existing base64-image attach pipeline.
- The preview Cloudflare tunnel is **unchanged**; the agent is served by the target project's own Vite dev server (same-origin to the page).
- `postMessage` validates **origin + per-session nonce** in both directions.
- Single source of truth for the wire contract: `tools/selector-plugin/src/protocol.ts`, imported by both the agent and the host.
- The two web apps already duplicate UI per surface — **follow that convention**: shared *logic* lives in the package; *view* components are per-app.
- TS settings in the web apps: `verbatimModuleSyntax: true` (use `import type` for types), `strict`, `noUnusedLocals`, `noUnusedParameters`. Shared package modules imported by the apps must be clean under these.
- Frontend "tests" for app-level view components follow the repo convention: `npm run build` (tsc typecheck) + manual harness. Real unit tests live in the package (Vitest).

---

## File Structure

**New package — `tools/selector-plugin/`** (installed into target projects; our apps alias into its `src/`):
- `src/protocol.ts` — wire contract: types + constants (no deps; host + agent share).
- `src/capture.ts` — pure DOM→payload: `cssPath`, `readMloc`, `captureElement`, `capturePin`.
- `src/composePrompt.ts` — pure tray→Claude prompt string.
- `src/controller.ts` — framework-agnostic host controller (handshake, mode, tray state, pub/sub). No React, no DOM-layout deps; injectable `win` for tests.
- `src/agent.ts` — in-page runtime (overlay, hover/click/pin, postMessage). Built to `dist/agent.global.js`.
- `src/jsx-loc.ts` — Babel source-location transform (stamps `data-mloc`).
- `src/vite-plugin.ts` — the Vite plugin (transform + HTML inject + dev framing headers).
- `index.ts` — host entry (re-exports protocol, composePrompt, controller).
- `plugin.ts` — plugin entry (re-exports `mysticalSelector`).
- `build.mjs` — esbuild bundles `src/agent.ts` → `dist/agent.global.js`.
- `package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md`.
- `test/capture.test.ts`, `test/composePrompt.test.ts`, `test/jsxLoc.test.ts`, `test/controller.test.ts`, `test/agent.test.ts`.

**Dashboard (first target) — `bridge/dashboard/web/src/`:**
- `components/design/PreviewFrame.tsx` — iframe + breakpoint toolbar + scale-to-fit.
- `components/design/SelectionTray.tsx` — tray rows with note fields.
- `components/design/useSelector.ts` — thin React wrapper over the controller.
- `components/design/DesignView.tsx` — assembles the above + prompt box; calls `onSubmit`.
- `App.tsx` — add `"design"` to the `view` union and mount `DesignView`.
- `api.ts` — add `screenshot(width)`.

**Mini App (second target) — `bridge/miniapp/web/src/`:** parallel `components/design/*`, a `routes/design.tsx`, a tab entry, `lib/api.ts` `screenshot`, and `lib/chat.tsx` exposing `runPrompt`.

**Backend:**
- `bridge/screenshot.py` — headless capture helper.
- `bridge/dashboard/server.py`, `bridge/miniapp/server.py` — `/…/preview/screenshot` route.
- `tests/test_screenshot.py` — pytest.

**Config (both apps):** `vite.config.ts` + `tsconfig.app.json` gain a `@selector` alias → `tools/selector-plugin/src`.

---

# Phase 1 — Selector engine (standalone package)

### Task 1: Scaffold the package + wire contract

**Files:**
- Create: `tools/selector-plugin/package.json`
- Create: `tools/selector-plugin/tsconfig.json`
- Create: `tools/selector-plugin/vitest.config.ts`
- Create: `tools/selector-plugin/src/protocol.ts`
- Test: `tools/selector-plugin/test/protocol.test.ts`

**Interfaces:**
- Produces: all types/constants in `protocol.ts` (consumed by every later task).

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "vite-plugin-mystical-selector",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "index.ts",
  "exports": {
    ".": "./index.ts",
    "./plugin": "./plugin.ts",
    "./agent": "./dist/agent.global.js"
  },
  "scripts": {
    "build": "node build.mjs",
    "test": "vitest run"
  },
  "devDependencies": {
    "@babel/generator": "^7.25.0",
    "@babel/parser": "^7.25.0",
    "@babel/traverse": "^7.25.0",
    "@babel/types": "^7.25.0",
    "esbuild": "^0.24.0",
    "jsdom": "^25.0.0",
    "typescript": "^5.7.2",
    "vite": "^6.0.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "verbatimModuleSyntax": true,
    "jsx": "react-jsx"
  },
  "include": ["src", "test", "build.mjs"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "jsdom", include: ["test/**/*.test.ts"] },
});
```

- [ ] **Step 4: Write `src/protocol.ts`**

```ts
export const PROTOCOL_VERSION = 1;
export const HOST_SOURCE = "mystical-selector-host";
export const AGENT_SOURCE = "mystical-selector-agent";

export type Mode = "idle" | "select" | "pin";

export interface ElementCapture {
  kind: "element";
  id: string;
  mloc: string | null; // "src/Hero.tsx:42:7" or null
  selector: string;
  tag: string;
  idAttr: string | null;
  classList: string[];
  text: string;
  outerHTML: string;
  rect: { x: number; y: number; w: number; h: number };
  styles: Record<string, string>;
}

export interface PinCapture {
  kind: "pin";
  id: string;
  mloc: string | null;
  nearestSelector: string | null;
  nearestTag: string | null;
  point: { x: number; y: number };
}

export type Capture = ElementCapture | PinCapture;

export type HostMessage =
  | { source: typeof HOST_SOURCE; nonce: string; type: "init"; parentOrigin: string; mode: Mode }
  | { source: typeof HOST_SOURCE; nonce: string; type: "setMode"; mode: Mode }
  | { source: typeof HOST_SOURCE; nonce: string; type: "highlight"; selector: string | null }
  | { source: typeof HOST_SOURCE; nonce: string; type: "clear" };

export type AgentMessage =
  | { source: typeof AGENT_SOURCE; type: "ready"; version: number }
  | { source: typeof AGENT_SOURCE; type: "hover"; label: string | null }
  | { source: typeof AGENT_SOURCE; type: "captured"; capture: Capture };

export function isAgentMessage(d: unknown): d is AgentMessage {
  return !!d && typeof d === "object" && (d as { source?: unknown }).source === AGENT_SOURCE;
}
export function isHostMessage(d: unknown, nonce: string): d is HostMessage {
  return (
    !!d &&
    typeof d === "object" &&
    (d as { source?: unknown }).source === HOST_SOURCE &&
    (d as { nonce?: unknown }).nonce === nonce
  );
}
```

- [ ] **Step 5: Write `test/protocol.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { AGENT_SOURCE, HOST_SOURCE, isAgentMessage, isHostMessage } from "../src/protocol";

describe("protocol guards", () => {
  it("accepts a well-formed agent message", () => {
    expect(isAgentMessage({ source: AGENT_SOURCE, type: "ready", version: 1 })).toBe(true);
  });
  it("rejects a foreign source", () => {
    expect(isAgentMessage({ source: "evil", type: "ready" })).toBe(false);
  });
  it("requires a matching nonce for host messages", () => {
    const msg = { source: HOST_SOURCE, nonce: "abc", type: "clear" };
    expect(isHostMessage(msg, "abc")).toBe(true);
    expect(isHostMessage(msg, "xyz")).toBe(false);
  });
});
```

- [ ] **Step 6: Install + run**

Run: `npm --prefix tools/selector-plugin install && npm --prefix tools/selector-plugin test`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add tools/selector-plugin
git commit -m "feat(selector): scaffold plugin package + wire protocol"
```

---

### Task 2: Pure DOM capture

**Files:**
- Create: `tools/selector-plugin/src/capture.ts`
- Test: `tools/selector-plugin/test/capture.test.ts`

**Interfaces:**
- Consumes: `protocol.ts` types.
- Produces:
  - `cssPath(el: Element): string`
  - `readMloc(el: Element): string | null`
  - `captureElement(el: Element, id: string): ElementCapture`
  - `capturePin(el: Element | null, point: {x:number;y:number}, id: string): PinCapture`

- [ ] **Step 1: Write `test/capture.test.ts`**

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix tools/selector-plugin exec vitest run test/capture.test.ts`
Expected: FAIL — `capture.ts` does not exist.

- [ ] **Step 3: Write `src/capture.ts`**

```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm --prefix tools/selector-plugin exec vitest run test/capture.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/selector-plugin/src/capture.ts tools/selector-plugin/test/capture.test.ts
git commit -m "feat(selector): pure DOM capture (cssPath, mloc, element, pin)"
```

---

### Task 3: Compose the Claude prompt

**Files:**
- Create: `tools/selector-plugin/src/composePrompt.ts`
- Test: `tools/selector-plugin/test/composePrompt.test.ts`

**Interfaces:**
- Consumes: `protocol.ts` types.
- Produces: `composePrompt(input: ComposeInput): string` where
  `ComposeInput = { project: string | null; width: number; items: { capture: Capture; note: string }[]; instruction: string }`.

- [ ] **Step 1: Write `test/composePrompt.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { composePrompt } from "../src/composePrompt";
import type { ElementCapture, PinCapture } from "../src/protocol";

const el: ElementCapture = {
  kind: "element", id: "1", mloc: "src/Hero.tsx:42:7", selector: "main > section > button",
  tag: "button", idAttr: null, classList: ["btn-cta"], text: "Get started",
  outerHTML: "<button>…</button>", rect: { x: 0, y: 0, w: 10, h: 10 }, styles: {},
};
const pin: PinCapture = {
  kind: "pin", id: "2", mloc: null, nearestSelector: "footer", nearestTag: "footer",
  point: { x: 320, y: 980 },
};

describe("composePrompt", () => {
  it("includes source, note, instruction and breakpoint", () => {
    const out = composePrompt({
      project: "acme/site", width: 375,
      items: [{ capture: el, note: "make it blue" }, { capture: pin, note: "add signup" }],
      instruction: "tighten the hero",
    });
    expect(out).toContain("acme/site");
    expect(out).toContain("375px");
    expect(out).toContain("source: src/Hero.tsx:42:7");
    expect(out).toContain("note: make it blue");
    expect(out).toContain("PIN");
    expect(out).toContain("(320, 980)");
    expect(out).toContain("tighten the hero");
  });
  it("omits the source line when mloc is absent", () => {
    const out = composePrompt({
      project: null, width: 768,
      items: [{ capture: { ...el, mloc: null }, note: "" }], instruction: "x",
    });
    expect(out).not.toContain("source:");
    expect(out).toContain("selector: main > section > button");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix tools/selector-plugin exec vitest run test/composePrompt.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write `src/composePrompt.ts`**

```ts
import type { Capture } from "./protocol";

export interface ComposeItem {
  capture: Capture;
  note: string;
}
export interface ComposeInput {
  project: string | null;
  width: number;
  items: ComposeItem[];
  instruction: string;
}

function renderItem(item: ComposeItem, i: number): string {
  const c = item.capture;
  const lines: string[] = [];
  if (c.kind === "element") {
    const cls = c.classList.length ? ` class="${c.classList.join(" ")}"` : "";
    lines.push(`[${i + 1}] <${c.tag}${cls}> ${JSON.stringify(c.text)}`);
    if (c.mloc) lines.push(`    source: ${c.mloc}`);
    lines.push(`    selector: ${c.selector}`);
  } else {
    const near = c.nearestTag ? ` near <${c.nearestTag}>` : "";
    lines.push(`[${i + 1}] PIN${near} at (${Math.round(c.point.x)}, ${Math.round(c.point.y)})`);
    if (c.mloc) lines.push(`    source: ${c.mloc}`);
  }
  if (item.note.trim()) lines.push(`    note: ${item.note.trim()}`);
  return lines.join("\n");
}

export function composePrompt(input: ComposeInput): string {
  const where = input.project ? ` on ${input.project}` : "";
  const head = `Visual edit${where} at ${input.width}px. The user selected these in the running app:`;
  const body = input.items.map(renderItem).join("\n");
  return `${head}\n\n${body}\n\nInstruction: ${input.instruction.trim()}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm --prefix tools/selector-plugin exec vitest run test/composePrompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/selector-plugin/src/composePrompt.ts tools/selector-plugin/test/composePrompt.test.ts
git commit -m "feat(selector): compose Claude prompt from tray"
```

---

### Task 4: JSX source-location transform

**Files:**
- Create: `tools/selector-plugin/src/jsx-loc.ts`
- Test: `tools/selector-plugin/test/jsxLoc.test.ts`

**Interfaces:**
- Produces: `injectLoc(code: string, relPath: string): string` — adds `data-mloc="relPath:line:col"` to every JSX opening element that lacks it; skips `Fragment`.

- [ ] **Step 1: Write `test/jsxLoc.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { injectLoc } from "../src/jsx-loc";

describe("injectLoc", () => {
  it("stamps data-mloc with the element's line", () => {
    const src = `export const A = () => (\n  <button>Hi</button>\n);\n`;
    const out = injectLoc(src, "src/A.tsx");
    expect(out).toMatch(/data-mloc="src\/A\.tsx:2:\d+"/);
  });
  it("does not double-stamp", () => {
    const src = `const A = () => <i data-mloc="x">!</i>;`;
    const out = injectLoc(src, "src/A.tsx");
    expect(out.match(/data-mloc/g)!.length).toBe(1);
  });
  it("leaves non-JSX code valid", () => {
    const src = `export const n = 1 + 2;`;
    expect(injectLoc(src, "src/n.ts")).toContain("1 + 2");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix tools/selector-plugin exec vitest run test/jsxLoc.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write `src/jsx-loc.ts`**

```ts
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import _generate from "@babel/generator";
import * as t from "@babel/types";

// @babel ESM/CJS interop: the default export is nested under `.default` in ESM.
const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse) as typeof _traverse;
const generate = ((_generate as unknown as { default?: typeof _generate }).default ?? _generate) as typeof _generate;

export function injectLoc(code: string, relPath: string): string {
  let ast;
  try {
    ast = parse(code, { sourceType: "module", plugins: ["jsx", "typescript"] });
  } catch {
    return code; // never break a build over a parse error
  }
  let changed = false;
  traverse(ast, {
    JSXOpeningElement(path) {
      const node = path.node;
      const name = node.name;
      if (t.isJSXIdentifier(name) && name.name === "Fragment") return;
      const has = node.attributes.some(
        (a) => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name, { name: "data-mloc" }),
      );
      if (has) return;
      const line = node.loc?.start.line ?? 0;
      const col = (node.loc?.start.column ?? 0) + 1;
      node.attributes.push(
        t.jsxAttribute(t.jsxIdentifier("data-mloc"), t.stringLiteral(`${relPath}:${line}:${col}`)),
      );
      changed = true;
    },
  });
  if (!changed) return code;
  return generate(ast, { retainLines: true }).code;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm --prefix tools/selector-plugin exec vitest run test/jsxLoc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/selector-plugin/src/jsx-loc.ts tools/selector-plugin/test/jsxLoc.test.ts
git commit -m "feat(selector): JSX data-mloc source-location transform"
```

---

### Task 5: In-page agent + build

**Files:**
- Create: `tools/selector-plugin/src/agent.ts`
- Create: `tools/selector-plugin/build.mjs`
- Test: `tools/selector-plugin/test/agent.test.ts`

**Interfaces:**
- Consumes: `protocol.ts`, `capture.ts`.
- Produces: `installAgent(win?: Window): void` — wires the agent on a window; auto-runs on import in the browser. Built to `dist/agent.global.js` (IIFE).

- [ ] **Step 1: Write `test/agent.test.ts`** (handshake + mode handling; jsdom has no layout, so we test messaging, not hover geometry)

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { installAgent } from "../src/agent";
import { AGENT_SOURCE, HOST_SOURCE } from "../src/protocol";

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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix tools/selector-plugin exec vitest run test/agent.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write `src/agent.ts`**

```ts
import { AGENT_SOURCE, PROTOCOL_VERSION, isHostMessage } from "./protocol";
import type { AgentMessage, Mode } from "./protocol";
import { captureElement, capturePin, cssPath } from "./capture";

export function installAgent(win: Window = window): void {
  let mode: Mode = "idle";
  let nonce = "";
  let parentOrigin = "*";
  let counter = 0;
  let overlay: HTMLDivElement | null = null;

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

// Auto-install when delivered as a script into a page.
if (typeof window !== "undefined") installAgent(window);
```

- [ ] **Step 4: Write `build.mjs`**

```js
import { build } from "esbuild";

await build({
  entryPoints: ["src/agent.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  outfile: "dist/agent.global.js",
});
console.log("built dist/agent.global.js");
```

- [ ] **Step 5: Run tests, then build the agent bundle**

Run: `npm --prefix tools/selector-plugin exec vitest run test/agent.test.ts`
Expected: PASS (2 tests).
Run: `npm --prefix tools/selector-plugin run build`
Expected: prints `built dist/agent.global.js`; file exists.

- [ ] **Step 6: Commit**

```bash
git add tools/selector-plugin/src/agent.ts tools/selector-plugin/build.mjs tools/selector-plugin/test/agent.test.ts tools/selector-plugin/dist/agent.global.js
git commit -m "feat(selector): in-page agent (overlay, select/pin, postMessage) + esbuild build"
```

---

### Task 6: The Vite plugin

**Files:**
- Create: `tools/selector-plugin/src/vite-plugin.ts`
- Create: `tools/selector-plugin/index.ts`
- Create: `tools/selector-plugin/plugin.ts`
- Create: `tools/selector-plugin/README.md`
- Test: `tools/selector-plugin/test/vitePlugin.test.ts`

**Interfaces:**
- Consumes: `jsx-loc.ts`.
- Produces: `mysticalSelector(opts?: { parentOrigins?: string[] }): Plugin`. `transform` stamps `.jsx/.tsx`; `transformIndexHtml` injects the built agent; dev middleware sets `frame-ancestors`.

- [ ] **Step 1: Write `test/vitePlugin.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { mysticalSelector } from "../src/vite-plugin";

// Ensure the agent bundle exists (Task 5 build).
const built = existsSync(new URL("../dist/agent.global.js", import.meta.url));

describe("mysticalSelector", () => {
  it("is dev-only", () => {
    expect(mysticalSelector().apply).toBe("serve");
  });
  it("transforms tsx by adding data-mloc", () => {
    const p = mysticalSelector();
    // configResolved sets root; emulate it.
    (p.configResolved as any)?.({ root: process.cwd() });
    const r = (p.transform as any)("const A = () => <b>x</b>;", "/abs/src/A.tsx");
    expect(r.code).toContain("data-mloc");
  });
  it("returns null for node_modules", () => {
    const p = mysticalSelector();
    expect((p.transform as any)("x", "/x/node_modules/y/z.tsx")).toBeNull();
  });
  it("injects the agent script tag", () => {
    if (!built) return;
    const p = mysticalSelector();
    const tags = (p.transformIndexHtml as any)();
    expect(tags[0].tag).toBe("script");
    expect(String(tags[0].children).length).toBeGreaterThan(50);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix tools/selector-plugin exec vitest run test/vitePlugin.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write `src/vite-plugin.ts`**

```ts
import type { Plugin } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { injectLoc } from "./jsx-loc";

export interface SelectorOptions {
  parentOrigins?: string[];
}

export function mysticalSelector(opts: SelectorOptions = {}): Plugin {
  let root = process.cwd();
  let agentJs = "";
  const agentPath = fileURLToPath(new URL("../dist/agent.global.js", import.meta.url));
  const loadAgent = () => {
    if (!agentJs) agentJs = readFileSync(agentPath, "utf8");
    return agentJs;
  };
  const frameAncestors = ["'self'", ...(opts.parentOrigins ?? [])].join(" ");

  return {
    name: "vite-plugin-mystical-selector",
    apply: "serve",
    enforce: "pre",
    configResolved(c) {
      root = (c as { root?: string }).root ?? root;
    },
    transform(code, id) {
      const file = id.split("?")[0];
      if (!/\.[jt]sx$/.test(file) || file.includes("node_modules")) return null;
      const rel = path.relative(root, file).split(path.sep).join("/");
      return { code: injectLoc(code, rel), map: null };
    },
    transformIndexHtml() {
      return [{ tag: "script", attrs: { type: "module" }, children: loadAgent(), injectTo: "body" as const }];
    },
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader("Content-Security-Policy", `frame-ancestors ${frameAncestors}`);
        res.removeHeader("X-Frame-Options");
        next();
      });
    },
  };
}
```

- [ ] **Step 4: Write `index.ts`, `plugin.ts`, `README.md`**

`index.ts`:
```ts
export * from "./src/protocol";
export { composePrompt } from "./src/composePrompt";
export type { ComposeInput, ComposeItem } from "./src/composePrompt";
export { createSelectorController } from "./src/controller";
export type { SelectorController, SelectorState, TrayItem } from "./src/controller";
```

`plugin.ts`:
```ts
export { mysticalSelector } from "./src/vite-plugin";
export type { SelectorOptions } from "./src/vite-plugin";
```

`README.md`:
```md
# vite-plugin-mystical-selector

Dev-only Vite plugin for the Mystical Assistant visual element selector.

## Install (in a target project)

1. Add as a dev dependency (from this monorepo path or a published build).
2. Wire it in `vite.config.ts`, dev-only:

```ts
import { mysticalSelector } from "vite-plugin-mystical-selector/plugin";

export default defineConfig({
  plugins: [
    react(),
    mysticalSelector({ parentOrigins: ["https://your-dashboard-origin", "https://t.me"] }),
  ],
});
```

It stamps `data-mloc` on JSX, injects the in-page selector agent, and allows the
dashboard/Mini App to embed the dev server in an iframe. Active only under `vite` dev
(`apply: 'serve'`); never in production builds.
```

> `controller.ts` is created in Task 7; `index.ts` references it now so the host entry is complete. If running tasks out of order, create Task 7 before importing `index.ts`.

- [ ] **Step 5: Run to verify it passes**

Run: `npm --prefix tools/selector-plugin exec vitest run test/vitePlugin.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tools/selector-plugin/src/vite-plugin.ts tools/selector-plugin/index.ts tools/selector-plugin/plugin.ts tools/selector-plugin/README.md tools/selector-plugin/test/vitePlugin.test.ts
git commit -m "feat(selector): Vite plugin (transform, inject agent, dev framing)"
```

---

# Phase 2 — Host controller + Dashboard surface

### Task 7: Framework-agnostic controller + app aliases

**Files:**
- Create: `tools/selector-plugin/src/controller.ts`
- Test: `tools/selector-plugin/test/controller.test.ts`
- Modify: `bridge/dashboard/web/vite.config.ts`, `bridge/dashboard/web/tsconfig.app.json`
- Modify: `bridge/miniapp/web/vite.config.ts`, `bridge/miniapp/web/tsconfig.app.json`

**Interfaces:**
- Consumes: `protocol.ts`.
- Produces:
  - `createSelectorController(opts: { iframe: HTMLIFrameElement; iframeOrigin: string; nonce: string; win?: Window }): SelectorController`
  - `SelectorState = { ready: boolean; mode: Mode; hoverLabel: string | null; items: TrayItem[] }`
  - `TrayItem = { capture: Capture; note: string }`
  - `SelectorController = { getState(): SelectorState; subscribe(cb): () => void; setMode(m): void; setNote(id, note): void; remove(id): void; clear(): void; destroy(): void }`

- [ ] **Step 1: Write `test/controller.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix tools/selector-plugin exec vitest run test/controller.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write `src/controller.ts`**

```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm --prefix tools/selector-plugin exec vitest run test/controller.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the `@selector` alias to both apps**

In `bridge/dashboard/web/vite.config.ts` and `bridge/miniapp/web/vite.config.ts`, add to `resolve.alias` (next to the existing `"@"`):

```ts
      "@selector": fileURLToPath(new URL("../../../tools/selector-plugin/src", import.meta.url)),
```

In `bridge/dashboard/web/tsconfig.app.json` and `bridge/miniapp/web/tsconfig.app.json`, add to `compilerOptions.paths` (next to `"@/*"`):

```json
      "@selector/*": ["../../../tools/selector-plugin/src/*"]
```

- [ ] **Step 6: Verify both apps still typecheck/build**

Run: `npm --prefix bridge/dashboard/web run build && npm --prefix bridge/miniapp/web run build`
Expected: both succeed (alias resolves; nothing imports it yet).

- [ ] **Step 7: Commit**

```bash
git add tools/selector-plugin/src/controller.ts tools/selector-plugin/test/controller.test.ts \
  bridge/dashboard/web/vite.config.ts bridge/dashboard/web/tsconfig.app.json \
  bridge/miniapp/web/vite.config.ts bridge/miniapp/web/tsconfig.app.json
git commit -m "feat(selector): host controller + @selector alias in both apps"
```

---

### Task 8: Dashboard Design surface

**Files:**
- Create: `bridge/dashboard/web/src/components/design/PreviewFrame.tsx`
- Create: `bridge/dashboard/web/src/components/design/SelectionTray.tsx`
- Create: `bridge/dashboard/web/src/components/design/useSelector.ts`
- Create: `bridge/dashboard/web/src/components/design/DesignView.tsx`
- Modify: `bridge/dashboard/web/src/App.tsx` (add `"design"` view + mount)

**Interfaces:**
- Consumes: `@selector` (`createSelectorController`, `composePrompt`, `Mode`, `TrayItem`); dashboard `send(text, images)`; `state.preview.url`.
- Produces: `<DesignView previewUrl onSubmit busy />`.

Breakpoint presets (used verbatim): `[{label:"Mobile",w:375},{label:"Tablet",w:768},{label:"Laptop",w:1280},{label:"Desktop",w:1440}]`.

> The CSS custom properties below (`--accent`, `--panel`, `--bg`, `--border`) are stand-ins for the dashboard's HUD theme tokens. Confirm the real names in `bridge/dashboard/web/src/index.css` / `lib/theme.ts` and match them — wrong var names build fine but render unthemed.

- [ ] **Step 1: Write `useSelector.ts`**

```ts
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createSelectorController, type SelectorController, type SelectorState } from "@selector/controller";

export function useSelector(iframeRef: RefObject<HTMLIFrameElement | null>, iframeOrigin: string | null) {
  const nonce = useMemo(() => `${iframeOrigin ?? ""}|${Math.floor(performance.now())}|${Math.random().toString(36).slice(2)}`, [iframeOrigin]);
  const ctrlRef = useRef<SelectorController | null>(null);
  const [snap, setSnap] = useState<SelectorState>({ ready: false, mode: "idle", hoverLabel: null, items: [] });

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !iframeOrigin) return;
    const ctrl = createSelectorController({ iframe, iframeOrigin, nonce });
    ctrlRef.current = ctrl;
    const unsub = ctrl.subscribe(() => setSnap(ctrl.getState()));
    setSnap(ctrl.getState());
    return () => { unsub(); ctrl.destroy(); ctrlRef.current = null; };
  }, [iframeRef, iframeOrigin, nonce]);

  return {
    state: snap,
    setMode: (m: SelectorState["mode"]) => ctrlRef.current?.setMode(m),
    setNote: (id: string, n: string) => ctrlRef.current?.setNote(id, n),
    remove: (id: string) => ctrlRef.current?.remove(id),
    clear: () => ctrlRef.current?.clear(),
  };
}
```

- [ ] **Step 2: Write `PreviewFrame.tsx`**

```tsx
import { useState, type RefObject } from "react";

const PRESETS = [
  { label: "Mobile", w: 375 },
  { label: "Tablet", w: 768 },
  { label: "Laptop", w: 1280 },
  { label: "Desktop", w: 1440 },
] as const;

export function PreviewFrame({
  url, iframeRef, width, onWidth, mode, onMode, hoverLabel,
}: {
  url: string;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  width: number;
  onWidth: (w: number) => void;
  mode: "idle" | "select" | "pin";
  onMode: (m: "idle" | "select" | "pin") => void;
  hoverLabel: string | null;
}) {
  const [containerW, setContainerW] = useState(0);
  const scale = containerW && width > containerW ? containerW / width : 1;

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {PRESETS.map((p) => (
          <button key={p.w} onClick={() => onWidth(p.w)}
            className={`rounded px-2 py-1 ${width === p.w ? "bg-[var(--accent)] text-black" : "bg-[var(--panel)]"}`}>
            {p.label} <span className="opacity-60">{p.w}</span>
          </button>
        ))}
        <input type="number" value={width} onChange={(e) => onWidth(Number(e.target.value) || width)}
          className="w-20 rounded bg-[var(--panel)] px-2 py-1" />
        <span className="mx-2 opacity-40">|</span>
        <button onClick={() => onMode(mode === "select" ? "idle" : "select")}
          className={`rounded px-2 py-1 ${mode === "select" ? "bg-[var(--accent)] text-black" : "bg-[var(--panel)]"}`}>Select</button>
        <button onClick={() => onMode(mode === "pin" ? "idle" : "pin")}
          className={`rounded px-2 py-1 ${mode === "pin" ? "bg-[var(--accent)] text-black" : "bg-[var(--panel)]"}`}>Pin</button>
        {hoverLabel && <span className="ml-2 truncate font-mono opacity-70">{hoverLabel}</span>}
      </div>
      <div ref={(el) => setContainerW(el?.clientWidth ?? 0)}
        className="relative flex-1 overflow-auto rounded border border-[var(--border)] bg-[var(--bg)]">
        <div style={{ width, transform: `scale(${scale})`, transformOrigin: "top left", height: scale < 1 ? `${100 / scale}%` : "100%" }}>
          <iframe ref={iframeRef} src={url} title="preview"
            style={{ width: "100%", height: "100%", border: "0" }} />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write `SelectionTray.tsx`**

```tsx
import type { TrayItem } from "@selector/controller";

export function SelectionTray({
  items, onNote, onRemove,
}: {
  items: TrayItem[];
  onNote: (id: string, note: string) => void;
  onRemove: (id: string) => void;
}) {
  if (!items.length) return <p className="text-xs opacity-50">Select elements or drop a pin to begin.</p>;
  return (
    <ul className="space-y-2">
      {items.map(({ capture: c, note }) => (
        <li key={c.id} className="rounded border border-[var(--border)] bg-[var(--panel)] p-2 text-xs">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="truncate font-mono">
              {c.kind === "element" ? `<${c.tag}>${c.mloc ? ` · ${c.mloc}` : ""}` : `PIN (${Math.round(c.point.x)},${Math.round(c.point.y)})`}
            </span>
            <button onClick={() => onRemove(c.id)} className="shrink-0 opacity-60 hover:opacity-100">✕</button>
          </div>
          <input value={note} onChange={(e) => onNote(c.id, e.target.value)} placeholder="note (optional)"
            className="w-full rounded bg-[var(--bg)] px-2 py-1 outline-none" />
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 4: Write `DesignView.tsx`**

```tsx
import { useMemo, useRef, useState } from "react";
import { composePrompt } from "@selector/composePrompt";
import { useSelector } from "./useSelector";
import { PreviewFrame } from "./PreviewFrame";
import { SelectionTray } from "./SelectionTray";

export function DesignView({
  previewUrl, project, onSubmit, busy,
}: {
  previewUrl: string | null;
  project: string | null;
  onSubmit: (text: string, images: string[]) => void;
  busy: boolean;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [width, setWidth] = useState(375);
  const [instruction, setInstruction] = useState("");
  const origin = useMemo(() => {
    try { return previewUrl ? new URL(previewUrl).origin : null; } catch { return null; }
  }, [previewUrl]);
  const sel = useSelector(iframeRef, origin);

  if (!previewUrl) {
    return <div className="p-4 text-sm opacity-60">Start the preview tunnel first, then reload Design.</div>;
  }

  const submit = () => {
    if (!instruction.trim() || !sel.state.items.length) return;
    const text = composePrompt({ project, width, items: sel.state.items, instruction });
    onSubmit(text, []); // screenshot attach is layered in Task 9
    sel.clear();
    setInstruction("");
  };

  return (
    <div className="grid h-full grid-cols-[1fr_320px] gap-3 p-3">
      <PreviewFrame url={previewUrl} iframeRef={iframeRef} width={width} onWidth={setWidth}
        mode={sel.state.mode} onMode={sel.setMode} hoverLabel={sel.state.hoverLabel} />
      <div className="flex flex-col gap-2 overflow-y-auto">
        <SelectionTray items={sel.state.items} onNote={sel.setNote} onRemove={sel.remove} />
        <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)}
          placeholder="What should Claude change?" rows={3}
          className="w-full rounded border border-[var(--border)] bg-[var(--panel)] p-2 text-sm outline-none" />
        <button onClick={submit} disabled={busy || !instruction.trim() || !sel.state.items.length}
          className="rounded bg-[var(--accent)] px-3 py-2 text-sm font-medium text-black disabled:opacity-40">
          Send to Claude
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Mount it in `App.tsx`**

Change the view union (line 66):
```ts
  const [view, setView] = useState<"chat" | "history" | "design">("chat");
```
Add a command-palette entry near the existing `view-history` entry (~line 393):
```ts
    { id: "view-design", label: "Go to Design", group: "View", icon: "◐", run: () => setView("design") },
```
Where the main view renders (the `view === "history"` branch, ~line 530), add a sibling branch. Use the existing `state?.preview?.url` and the existing `send`:
```tsx
        {view === "design" && (
          <DesignView
            previewUrl={state?.preview?.url ?? null}
            project={selected?.project ?? state?.project?.rel ?? null}
            onSubmit={(text, images) => { void send(text, images); setView("chat"); }}
            busy={!!active}
          />
        )}
```
Add the import at the top of `App.tsx`:
```ts
import { DesignView } from "./components/design/DesignView";
```
> If `DashState.preview` is not yet typed in dashboard `api.ts`, mirror the miniapp `PreviewInfo` shape (`{ url: string | null; port: number | null }`) onto the dashboard `DashState` so `state.preview.url` typechecks.

- [ ] **Step 6: Verify the dashboard builds**

Run: `npm --prefix bridge/dashboard/web run build`
Expected: success.

- [ ] **Step 7: Manual harness check** (real browser; jsdom can't do layout/iframe)

Run a sample Vite app with the plugin and the dashboard dev server, then:
1. Start the sample app's dev server; start the preview tunnel pointing at it.
2. Open the dashboard, go to Design, toggle **Select**, hover → overlay tracks elements; click → a tray row appears with `<tag> · file:line`.
3. Toggle **Pin**, click empty space → a PIN row appears.
4. Resize via presets → the frame scales.
Document the result in the commit message.

- [ ] **Step 8: Commit**

```bash
git add bridge/dashboard/web/src/components/design bridge/dashboard/web/src/App.tsx bridge/dashboard/web/src/api.ts
git commit -m "feat(selector): Dashboard Design surface (frame, tray, select/pin → Claude)"
```

---

# Phase 3 — Screenshot, Mini App port, setup

### Task 9: Screenshot endpoint + default-on attach

**Files:**
- Create: `bridge/screenshot.py`
- Create: `tests/test_screenshot.py`
- Modify: `bridge/dashboard/server.py` (route + handler)
- Modify: `bridge/dashboard/web/src/api.ts` (`screenshot`)
- Modify: `bridge/dashboard/web/src/components/design/DesignView.tsx` (attach by default, graceful)

**Interfaces:**
- Produces:
  - `screenshot.capture(url: str, width: int, height: int = 900, timeout: int = 20) -> bytes`
  - `screenshot.chrome_cmd(url, width, height, out_path) -> list[str]`
  - Dashboard `POST /local/preview/screenshot { width }` → `{ data_url: string }` or `{ error }`.
  - `api.screenshot(width: number): Promise<{ data_url: string }>`

- [ ] **Step 1: Write `tests/test_screenshot.py`**

```python
import base64
from unittest import mock
from bridge import screenshot


def test_chrome_cmd_includes_window_size_and_url():
    cmd = screenshot.chrome_cmd("https://preview.test", 375, 900, "/tmp/o.png")
    assert any("--window-size=375,900" in c for c in cmd)
    assert cmd[-1] == "https://preview.test"
    assert any("--screenshot=/tmp/o.png" in c for c in cmd)


def test_capture_runs_chrome_and_returns_bytes(tmp_path):
    png = b"\x89PNG\r\n\x1a\n-fake"

    def fake_run(cmd, **kw):
        # find the --screenshot=… arg and write the fake PNG
        for c in cmd:
            if c.startswith("--screenshot="):
                with open(c.split("=", 1)[1], "wb") as f:
                    f.write(png)
        return mock.Mock(returncode=0, stderr=b"")

    with mock.patch("subprocess.run", side_effect=fake_run):
        data = screenshot.capture("https://preview.test", 375)
    assert data == png
```

- [ ] **Step 2: Run to verify it fails**

Run: `python -m pytest tests/test_screenshot.py -q`
Expected: FAIL — `bridge/screenshot.py` missing.

- [ ] **Step 3: Write `bridge/screenshot.py`**

```python
"""Headless-Chrome screenshot of the live preview, for visual context to Claude.

Uses chrome-headless-shell directly (no Playwright module). In this WSL env Chrome
needs an ALSA stub on LD_LIBRARY_PATH; both are configurable via env.
"""

import os
import subprocess
import tempfile

_DEFAULT_CHROME = os.path.expanduser(
    "~/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell"
)
CHROME = os.environ.get("CHROME_HEADLESS_SHELL", _DEFAULT_CHROME)
CHROME_LD = os.environ.get("CHROME_LD_LIBRARY_PATH", os.path.expanduser("~/.cache/ms-playwright"))


def chrome_cmd(url: str, width: int, height: int, out_path: str) -> list[str]:
    return [
        CHROME, "--headless", "--no-sandbox", "--hide-scrollbars",
        "--force-device-scale-factor=1", f"--window-size={width},{height}",
        "--virtual-time-budget=4000", f"--screenshot={out_path}", url,
    ]


def capture(url: str, width: int, height: int = 900, timeout: int = 20) -> bytes:
    env = dict(os.environ)
    if CHROME_LD:
        env["LD_LIBRARY_PATH"] = CHROME_LD + os.pathsep + env.get("LD_LIBRARY_PATH", "")
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, "shot.png")
        proc = subprocess.run(chrome_cmd(url, width, height, out), env=env,
                              capture_output=True, timeout=timeout)
        if not os.path.exists(out):
            raise RuntimeError(f"screenshot failed (rc={proc.returncode}): {proc.stderr[:300]!r}")
        with open(out, "rb") as f:
            return f.read()
```

- [ ] **Step 4: Run to verify it passes**

Run: `python -m pytest tests/test_screenshot.py -q`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the dashboard endpoint**

In `bridge/dashboard/server.py` `do_POST`, next to the existing `/local/preview` route, add:
```python
            if path == "/local/preview/screenshot":
                return self._api_preview_screenshot(body)
```
Add the handler (mirror the `_json` helper used elsewhere in that file; import `base64`, `tunnel`, `screenshot` at the top if not present):
```python
    def _api_preview_screenshot(self, body: dict):
        url = tunnel.tunnel_state().get("url")
        if not url:
            return self._json({"error": "preview not running"}, 409)
        try:
            width = int(body.get("width") or 375)
        except (TypeError, ValueError):
            width = 375
        try:
            png = screenshot.capture(url, width)
        except Exception as e:  # noqa: BLE001
            return self._json({"error": f"{type(e).__name__}: {e}"}, 500)
        data_url = "data:image/png;base64," + base64.b64encode(png).decode()
        return self._json({"data_url": data_url})
```

- [ ] **Step 6: Add the api client method** in `bridge/dashboard/web/src/api.ts` (in the `api` object):
```ts
  screenshot: (width: number) =>
    req<{ data_url: string }>("/local/preview/screenshot", { method: "POST", body: { width } }),
```

- [ ] **Step 7: Attach by default (graceful)** in `DesignView.tsx` — change `submit` to async and fetch the shot, falling back to none:
```tsx
  const submit = async () => {
    if (!instruction.trim() || !sel.state.items.length) return;
    const text = composePrompt({ project, width, items: sel.state.items, instruction });
    let images: string[] = [];
    try {
      const shot = await api.screenshot(width);
      if (shot.data_url) images = [shot.data_url];
    } catch { /* no screenshot: send text-only */ }
    onSubmit(text, images);
    sel.clear();
    setInstruction("");
  };
```
Add `import { api } from "../../api";` at the top of `DesignView.tsx`, and change the button to `onClick={() => void submit()}`.

- [ ] **Step 8: Verify backend + dashboard build**

Run: `python -m pytest tests/test_screenshot.py -q && npm --prefix bridge/dashboard/web run build`
Expected: both pass.

- [ ] **Step 9: Commit**

```bash
git add bridge/screenshot.py tests/test_screenshot.py bridge/dashboard/server.py bridge/dashboard/web/src/api.ts bridge/dashboard/web/src/components/design/DesignView.tsx
git commit -m "feat(selector): headless screenshot attached to visual-edit prompts"
```

---

### Task 10: Mini App port

**Files:**
- Create: `bridge/miniapp/web/src/components/design/PreviewFrame.tsx`, `SelectionTray.tsx`, `useSelector.ts`, `DesignView.tsx`
- Create: `bridge/miniapp/web/src/routes/design.tsx`
- Modify: `bridge/miniapp/web/src/router.tsx` (register route)
- Modify: `bridge/miniapp/web/src/routes/root.tsx` (add tab)
- Modify: `bridge/miniapp/web/src/lib/chat.tsx` (expose `runPrompt`)
- Modify: `bridge/miniapp/web/src/lib/api.ts` (`screenshot`)

**Interfaces:**
- Consumes: `@selector`, miniapp `useChat().runPrompt`, `api.screenshot`, `api.getState().preview.url`.

- [ ] **Step 1: Expose `runPrompt` from the chat context.** In `bridge/miniapp/web/src/lib/chat.tsx`: add `runPrompt: (text: string, attachments: Attachment[]) => Promise<void>;` to `ChatContextValue` (after `send`), and add `runPrompt` to the `value` object (it already exists as a function in scope — reference it directly; its current 3rd `onSent` arg is optional so the 2-arg call typechecks).

- [ ] **Step 2: Add the api client method** in `bridge/miniapp/web/src/lib/api.ts` (in the `api` object):
```ts
  screenshot: (width: number) =>
    request<{ data_url: string }>("/api/preview/screenshot", { method: "POST", body: { width } }),
```
And add the backend route to `bridge/miniapp/server.py` `do_POST` next to `/api/preview`:
```python
            if path == "/api/preview/screenshot":
                return self._api_preview_screenshot(body)
```
plus the same `_api_preview_screenshot` handler as Task 9 Step 5 (import `base64`, `tunnel`, `screenshot` at the top of `bridge/miniapp/server.py` if not present).

- [ ] **Step 3: Create the four `components/design/*` files** mirroring the dashboard ones from Task 8, restyled with Telegram tokens (`var(--tg-bg)`, `var(--tg-secondary-bg)`, `var(--tg-button)`, `var(--tg-button-text)`, `var(--tg-hint)`) and a **single-column** layout (frame on top, tray + prompt below) suited to a phone. `useSelector.ts` is identical to the dashboard's (copy verbatim). `DesignView` calls `runPrompt(text, [{ id: "shot", name: "preview.png", dataUrl }])` instead of `onSubmit`; build the attachment from `api.screenshot(width)` with the same graceful fallback. For touch, set the Select/Pin toggles as large tap targets; element picking uses the same click handler (tap = click).

```tsx
// bridge/miniapp/web/src/components/design/DesignView.tsx
import { useMemo, useRef, useState } from "react";
import { composePrompt } from "@selector/composePrompt";
import { api } from "../../lib/api";
import { useChat } from "../../lib/chat";
import { useSelector } from "./useSelector";
import { PreviewFrame } from "./PreviewFrame";
import { SelectionTray } from "./SelectionTray";

export function DesignView({ previewUrl, project }: { previewUrl: string | null; project: string | null }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [width, setWidth] = useState(375);
  const [instruction, setInstruction] = useState("");
  const { runPrompt, isRunning } = useChat();
  const origin = useMemo(() => {
    try { return previewUrl ? new URL(previewUrl).origin : null; } catch { return null; }
  }, [previewUrl]);
  const sel = useSelector(iframeRef, origin);

  if (!previewUrl) return <p className="text-sm text-[var(--tg-hint)]">Start the preview first, then open Design.</p>;

  const submit = async () => {
    if (!instruction.trim() || !sel.state.items.length) return;
    const text = composePrompt({ project, width, items: sel.state.items, instruction });
    const atts = [];
    try {
      const shot = await api.screenshot(width);
      if (shot.data_url) atts.push({ id: "shot", name: "preview.png", dataUrl: shot.data_url });
    } catch { /* text-only */ }
    await runPrompt(text, atts);
    sel.clear();
    setInstruction("");
  };

  return (
    <div className="flex flex-col gap-3">
      <PreviewFrame url={previewUrl} iframeRef={iframeRef} width={width} onWidth={setWidth}
        mode={sel.state.mode} onMode={sel.setMode} hoverLabel={sel.state.hoverLabel} />
      <SelectionTray items={sel.state.items} onNote={sel.setNote} onRemove={sel.remove} />
      <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={3}
        placeholder="What should Claude change?"
        className="w-full rounded-lg bg-[var(--tg-secondary-bg)] p-2 text-sm outline-none" />
      <button onClick={() => void submit()} disabled={isRunning || !instruction.trim() || !sel.state.items.length}
        className="rounded-lg bg-[var(--tg-button)] px-3 py-2.5 text-sm font-medium text-[var(--tg-button-text)] disabled:opacity-40">
        Send to Claude
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Create `routes/design.tsx`**

```tsx
import { createRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { rootRoute } from "./root";
import { api } from "../lib/api";
import { DesignView } from "../components/design/DesignView";

function DesignPage() {
  const state = useQuery({ queryKey: ["state"], queryFn: () => api.getState(), refetchInterval: 5000 });
  return <DesignView previewUrl={state.data?.preview?.url ?? null} project={state.data?.project?.rel ?? null} />;
}

export const designRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/design",
  component: DesignPage,
});
```

- [ ] **Step 5: Register the route + tab.** In `router.tsx` import `designRoute` and add it to `rootRoute.addChildren([...])`. In `routes/root.tsx`, import an icon (e.g. `MousePointerClick` from `lucide-react`) and add `{ to: "/design", label: "Design", icon: MousePointerClick }` to the `tabs` array.

- [ ] **Step 6: Verify the Mini App builds**

Run: `npm --prefix bridge/miniapp/web run build`
Expected: success.

- [ ] **Step 7: Manual harness check** (real browser, mobile width) — same as Task 8 Step 7 but in the Mini App at 375px; verify tap-select, pin, send.

- [ ] **Step 8: Commit**

```bash
git add bridge/miniapp/web/src/components/design bridge/miniapp/web/src/routes/design.tsx bridge/miniapp/web/src/router.tsx bridge/miniapp/web/src/routes/root.tsx bridge/miniapp/web/src/lib/chat.tsx bridge/miniapp/web/src/lib/api.ts bridge/miniapp/server.py
git commit -m "feat(selector): Mini App Design surface (port of the shared selector)"
```

---

### Task 11: One-tap "Set up selector" action

**Files:**
- Modify: `bridge/dashboard/web/src/components/design/DesignView.tsx`
- Modify: `bridge/miniapp/web/src/components/design/DesignView.tsx`

**Interfaces:**
- Consumes: the same submit/run path (sends a canned setup prompt instead of a visual edit).

The setup prompt is a normal Claude run — no backend endpoint. Canned text (used verbatim):

```
Set up the visual element selector in this project. Add the dev dependency
`vite-plugin-mystical-selector` (it lives in this repo at tools/selector-plugin) and
wire it into the Vite config dev-only:

  import { mysticalSelector } from "vite-plugin-mystical-selector/plugin";
  // plugins: [react(), mysticalSelector({ parentOrigins: ["*"] })]

Then restart the dev server. Keep it dev-only; do not add it to production builds.
```

- [ ] **Step 1: Dashboard** — when `sel.state.items.length === 0`, render a small "Set up selector" button under the tray that calls `onSubmit(SETUP_PROMPT, [])`. Define `SETUP_PROMPT` as a module const with the text above.

```tsx
{!sel.state.items.length && (
  <button onClick={() => onSubmit(SETUP_PROMPT, [])}
    className="rounded border border-[var(--border)] px-2 py-1 text-xs opacity-80">
    Set up selector in this project
  </button>
)}
```

- [ ] **Step 2: Mini App** — same button calling `void runPrompt(SETUP_PROMPT, [])`.

- [ ] **Step 3: Verify both build**

Run: `npm --prefix bridge/dashboard/web run build && npm --prefix bridge/miniapp/web run build`
Expected: both succeed.

- [ ] **Step 4: Commit**

```bash
git add bridge/dashboard/web/src/components/design/DesignView.tsx bridge/miniapp/web/src/components/design/DesignView.tsx
git commit -m "feat(selector): one-tap 'set up selector' canned prompt"
```

---

## Final verification

- [ ] Package unit tests: `npm --prefix tools/selector-plugin test` → all pass.
- [ ] Backend tests: `python -m pytest tests/test_screenshot.py -q` → pass.
- [ ] Both web builds: `npm --prefix bridge/dashboard/web run build && npm --prefix bridge/miniapp/web run build` → succeed.
- [ ] End-to-end (real browser, both surfaces): set up the plugin in a sample Vite app, start its dev server + preview tunnel, select elements + a pin, send → confirm Claude receives the composed prompt with `file:line` and a screenshot, and edits the right source.

---

## Notes / deviations from the spec

- The spec's "shared host core in `bridge/shared/selector/` via Vite alias" is realized as: **framework-agnostic logic in the `tools/selector-plugin` package** (one protocol source, unit-tested) consumed by both apps via the `@selector` alias, with **per-app view components** (`components/design/*`). This matches the repo's existing convention of duplicating view components across the two web apps and avoids a cross-root `tsc -b` arrangement. Behavior is unchanged from the spec.
- Screenshot attach is **best-effort**: if headless capture fails, the visual edit is sent text-only (never blocked).
- The spec's **screenshot-only annotate fallback** (box/pin on a static image for non-Vite projects) is intentionally **deferred** — the spec marks it optional/follow-up. This plan ships the screenshot *endpoint* and the live-selector path; non-Vite projects degrade to selector+text (no `data-mloc`) plus the attached screenshot, which is already useful. A later plan can add the static-image annotate mode.
- Target-project consumption of the plugin: within this monorepo the apps consume the package source via the `@selector` alias, and the agent is the built `dist/agent.global.js`. For an arbitrary target project, the one-tap setup prompt (Task 11) lets Claude wire it from the repo path and run the package build if needed.
