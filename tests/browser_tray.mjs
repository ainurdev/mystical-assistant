// The Mystical browser's comment tray (bridge/browser_ext/content.js) in headless Chrome for Testing, over raw CDP:
// real mouse and keys (isTrusted, as a person's are), and the tray read through its closed shadow root the way
// DevTools reads one, which a page's script can't. No packages: Node's own WebSocket and fetch.
// tests/test_browser_tray.py serves the pages and site_browser's loopback server, and asserts on what this prints.
// usage: node tests/browser_tray.mjs <pick|page|send> <site base url> <extension dir> <chrome binary>
// Prints {"check": <scenario>, ...what it saw} as one JSON line, or {"check": "error"|"no-chrome", "error": ...} and exits 1.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";

const [scenario, base, ext, bin] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, ms = 10000) {
  for (const end = Date.now() + ms; ; await sleep(100)) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
  }
}

let ws, n = 0;
const waiting = new Map();
const cdp = (method, params = {}, sessionId) => new Promise((ok, no) => {
  waiting.set(++n, { ok, no, method });
  ws.send(JSON.stringify({ id: n, method, params, sessionId }));
});

async function tab(path) {        // a new tab on the site, once its tray is drawn
  const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  const t = { s: (method, params) => cdp(method, params, sessionId), root: null };
  await t.s("Emulation.setFocusEmulationEnabled", { enabled: true });
  await t.s("Page.navigate", { url: base + path });
  await until(`the tray on ${path}`, () => has(t, ".tab"));
  return t;
}

const page = (t, expression) => t.s("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }).then((r) => r.result.value);

// fn(root, arg), run on the tray's shadow root: DOM.describeNode pierces a closed root.
async function tray(t, fn, arg) {
  if (!t.root) {
    const { root } = await t.s("DOM.getDocument", { depth: 0 });
    const { nodeId } = await t.s("DOM.querySelector", { nodeId: root.nodeId, selector: "#mystical-comments" });
    if (!nodeId) return null;
    const { node } = await t.s("DOM.describeNode", { nodeId, depth: 1, pierce: true });
    if (!node.shadowRoots?.length) return null;
    t.root = (await t.s("DOM.resolveNode", { backendNodeId: node.shadowRoots[0].backendNodeId })).object.objectId;
  }
  const r = await t.s("Runtime.callFunctionOn", { objectId: t.root, functionDeclaration: `function (a) { return (${fn})(this, a); }`,
    arguments: [{ value: arg }], returnByValue: true, awaitPromise: true }).catch((e) => { t.root = null; throw e; });
  return r.result.value;
}
const has = (t, sel) => tray(t, (r, s) => !!r.querySelector(s), sel);
const note = (t) => tray(t, (r) => r.querySelector(".note")?.textContent || "");

async function clickAt(t, { x, y }) {   // the pointer moves there, presses, lets go
  await t.s("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await t.s("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await t.s("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}
const press = async (t, sel) => clickAt(t, await until(sel, () => tray(t, (r, s) => {      // a tray control
  const b = r.querySelector(s)?.getBoundingClientRect();
  return b?.width ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
}, sel)));
const pick = async (t, sel) => clickAt(t, await page(t,                                    // a page element
  `(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`));

async function keys(t, text) {          // key by key, as a person types: keydown, keypress, input
  for (const ch of text) {
    const k = ch === "\r" ? { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }
      : ch === " " ? { key: " ", code: "Space", windowsVirtualKeyCode: 32 }
      : { key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) };
    await t.s("Input.dispatchKeyEvent", { type: "keyDown", text: ch, ...k });
    await t.s("Input.dispatchKeyEvent", { type: "keyUp", ...k });
  }
}

async function comment(t, sel, words) { // C, a click on sel, the words, Enter; how often the click reached the page
  await t.s("Page.bringToFront");
  await keys(t, "c");
  await until("picking", () => has(t, ".tab.on"));
  await pick(t, sel);
  await until("the comment box", () => has(t, ".box textarea"));
  const pressed = await page(t, "window.hits || 0");
  await keys(t, `${words}\r`);
  await until(`“${words}” pinned`, () => tray(t, (r, w) => !!r.querySelector(".tray")?.textContent.includes(w), words));
  return pressed;
}

const scenarios = {
  async pick() {                        // a pick, then Point again, on a button that counts its presses
    const t = await tab("/btn");
    const byPick = await comment(t, "#b", "fix the cramped menu");
    const pinned = await tray(t, (r) => r.querySelector(".it .w1")?.textContent);
    await press(t, ".it");
    await press(t, "[data-a=repoint]");
    await until("picking again", () => has(t, ".tab.on"));
    await pick(t, "#b");
    const total = await page(t, "window.hits || 0");
    await until("Point again done", async () => !(await has(t, ".tab.on")));
    return { "pressed by the pick": byPick, "pressed by Point again": total - byPick, pinned };
  },
  async page() {                        // the page's own script: no real input, only what any page can do
    const t = await tab("/evil");
    const open = await page(t, `(async () => {
      const open = !!document.getElementById("mystical-comments").shadowRoot;
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true, composed: true }));
      const el = document.getElementById("t"), b = el.getBoundingClientRect();
      const at = { clientX: b.x + 10, clientY: b.y + 10, bubbles: true, cancelable: true, composed: true };
      el.dispatchEvent(new MouseEvent("mousemove", at));
      el.dispatchEvent(new MouseEvent("mousedown", { ...at, button: 0, buttons: 1 }));
      el.dispatchEvent(new MouseEvent("mouseup", { ...at, button: 0 }));
      await new Promise((r) => setTimeout(r, 300));
      return open;
    })()`);
    return { "root open to the page": open, picking: await has(t, ".tab.on"), "comment box": await has(t, ".box") };
  },
  async send() {                        // the bridge holds the Send until /release; another tab pins meanwhile
    const one = await tab("/btn");
    await comment(one, "#b", "make it bigger");
    await press(one, ".send");
    await until("the Send in flight", async () => /Sending/.test(await note(one)));
    const two = await tab("/other");
    await comment(two, "#p", "typed during the send");
    await fetch(`${base}/release`);
    await one.s("Page.bringToFront");
    await until("the first chat", async () => /Started/.test(await note(one)));
    const kept = await tray(one, (r) => r.querySelector(".tray").textContent.includes("typed during the send"));
    if (kept) {
      await press(one, ".send");
      await until("the second chat", async () => /typed during the send/.test(await note(one)));
    }
    return { kept };
  },
};

const dir = await fs.mkdtemp(`${os.tmpdir()}/tray-check-`);
const chrome = spawn(bin, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--window-size=1280,800",
  "--remote-debugging-port=0", `--user-data-dir=${dir}`, `--disable-extensions-except=${ext}`, `--load-extension=${ext}`,
  "about:blank"], { stdio: "ignore" });
const exited = new Promise((r) => { chrome.once("exit", r); chrome.once("error", r); });
let code = 0;
try {
  const port = await until("Chrome's debug port", () => fs.readFile(`${dir}/DevToolsActivePort`, "utf8").then((s) => s.split("\n")[0]), 20000)
    .catch((e) => { throw Object.assign(e, { noChrome: true }); });
  ws = new WebSocket((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data), w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    m.error ? w.no(new Error(`${w.method}: ${m.error.message}`)) : w.ok(m.result);
  };
  console.log(JSON.stringify({ check: scenario, ...(await scenarios[scenario]()) }));
} catch (e) {
  console.log(JSON.stringify({ check: e?.noChrome ? "no-chrome" : "error", error: String(e?.message || e) }));
  code = 1;
} finally {
  ws?.close();
  chrome.kill();
  await exited;
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}
process.exit(code);
