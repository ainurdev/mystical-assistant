// Drive a page and report what it did: node drive.mjs <spec.json> <outdir>
// The bridge's drive_page tool (bridge/gateway_tools.py). Real mouse and key events over
// CDP, so a page's own handlers fire as they do for a person, and a page holding SSE open
// doesn't hang it the way chrome's --screenshot does (see bridge-eyes). Prints one JSON
// line: {shots: [{path, label}], console: [...], exceptions: [...], failed: [...], log: [...]}.
//
// spec: {url, width, height, mobile, scale, wait, steps: [
//   {click: "text or /regex/"} | {tap_at: [x, y]} | {type: "text"} | {key: "Enter"}
//   | {wait: ms} | {scroll: pixels} | {eval: "js"} | {shot: "label"} ]}
import fs from "node:fs/promises";
import os from "node:os";
import { spawn } from "node:child_process";

const [specPath, outDir] = process.argv.slice(2);
const spec = JSON.parse(await fs.readFile(specPath, "utf8"));
const home = os.homedir();
const shells = (await fs.readdir(`${home}/.cache/ms-playwright`))
  .filter((d) => d.startsWith("chromium_headless_shell-"))
  .sort((a, b) => +b.split("-")[1] - +a.split("-")[1]);
if (!shells.length) { console.log(JSON.stringify({ error: "no headless chrome is installed" })); process.exit(0); }
const BIN = `${home}/.cache/ms-playwright/${shells[0]}/chrome-headless-shell-linux64/chrome-headless-shell`;
const width = spec.width || 1280, height = spec.height || 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = await fs.mkdtemp(`${os.tmpdir()}/drive-`);
const port = 9700 + (process.pid % 250);
const proc = spawn(BIN, ["--headless", "--no-sandbox", "--hide-scrollbars", `--window-size=${width},${height}`,
  `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, "about:blank"],
  { stdio: "ignore", env: { ...process.env, LD_LIBRARY_PATH: `${home}/.cache/ms-playwright:${process.env.LD_LIBRARY_PATH ?? ""}` } });
const out = { shots: [], console: [], exceptions: [], failed: [], log: [] };
const finish = async (code = 0) => {
  console.log(JSON.stringify(out));
  try { proc.kill(); await sleep(200); await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  process.exit(code);
};
let tab;
for (let i = 0; i < 40 && !tab; i++) {
  await sleep(250);
  try { tab = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page"); } catch {}
}
if (!tab) { out.error = "chrome never opened its debug port"; await finish(); }
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0;
const waiting = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (waiting.has(m.id)) { waiting.get(m.id)(m.result ?? {}); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") out.exceptions.push(String(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? "").slice(0, 400));
  if (m.method === "Runtime.consoleAPICalled" && (m.params.type === "error" || m.params.type === "warning"))
    out.console.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`.slice(0, 400));
  if (m.method === "Network.responseReceived" && m.params.response.status >= 400)
    out.failed.push(`${m.params.response.status} ${m.params.response.url}`.slice(0, 300));
  if (m.method === "Network.loadingFailed" && !m.params.canceled)
    out.failed.push(`${m.params.errorText} ${m.params.requestId}`.slice(0, 200));
};
const send = (method, params = {}) => new Promise((r) => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: spec.scale || (spec.mobile ? 2 : 1), mobile: !!spec.mobile });
await send("Page.navigate", { url: spec.url });
await sleep(spec.wait ?? 2500);
const mouse = async (x, y) => {
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
    await send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: type === "mouseMoved" ? 0 : 1 });
};
const shot = async (label) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  if (!data) return;
  const path = `${outDir}/shot-${out.shots.length + 1}.png`;
  await fs.writeFile(path, Buffer.from(data, "base64"));
  out.shots.push({ path, label });
};
for (const s of spec.steps || []) {
  if (s.click !== undefined) {
    const expr = `(()=>{const q=${JSON.stringify(String(s.click))};const m=q.match(/^\\/(.*)\\/([a-z]*)$/);const re=m?new RegExp(m[1],m[2]):null;
      const hit=(e)=>{const t=(e.innerText||e.value||e.getAttribute('aria-label')||e.title||'').trim();return re?re.test(t):t===q||t.includes(q)};
      const els=[...document.querySelectorAll('button,a,[role=button],[role=tab],[role=menuitem],[role=option],input,select,label,summary')].filter(e=>e.getBoundingClientRect().width>0&&hit(e));
      const e=els.sort((a,b)=>(a.innerText||'').length-(b.innerText||'').length)[0];if(!e)return null;e.scrollIntoView({block:'center'});const b=e.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2,t:(e.innerText||'').trim().slice(0,60)}})()`;
    const v = (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.value;
    if (!v) { out.log.push(`click: nothing on the page matches ${JSON.stringify(s.click)}`); continue; }
    await mouse(v.x, v.y);
    out.log.push(`clicked "${v.t}"`);
    await sleep(s.after ?? 600);
  } else if (s.tap_at) {
    await mouse(+s.tap_at[0], +s.tap_at[1]);
    await sleep(s.after ?? 600);
  } else if (s.type !== undefined) {
    await send("Input.insertText", { text: String(s.type) });
    await sleep(200);
  } else if (s.key) {
    for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: s.key, code: s.key, windowsVirtualKeyCode: s.key === "Enter" ? 13 : s.key === "Escape" ? 27 : s.key === "Tab" ? 9 : 0 });
    await sleep(300);
  } else if (s.wait) {
    await sleep(Math.min(+s.wait, 20000));
  } else if (s.scroll !== undefined) {
    await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: width / 2, y: height / 2, deltaX: 0, deltaY: +s.scroll });
    await sleep(400);
  } else if (s.eval) {
    const r = await send("Runtime.evaluate", { expression: String(s.eval), awaitPromise: true, returnByValue: true });
    out.log.push(`eval: ${JSON.stringify(r.result?.value ?? r.exceptionDetails?.exception?.description ?? null)}`.slice(0, 800));
  } else if (s.shot !== undefined) {
    await shot(String(s.shot));
  }
}
if (!out.shots.length || spec.steps?.at(-1)?.shot === undefined) await shot("final");
ws.close();
await finish();
