// One headless Google Chrome capture, driven over CDP: bridge-eyes' shot.mjs for the Mac.
// usage: node macos/eyes/cdp.mjs <url> <out.png|out.jpg> <w> <h> <waitMs> [evalJs] [wait2Ms] [dpr=2] [full=0|1]
// full=1 grows the viewport to the page's scrollHeight before the capture. CLIP=x,y,w,h (css px) crops.
const [url, out, w = 1280, h = 800, waitMs = 3000, evalJs = "", wait2 = 1500, dpr = 2, full = "0"] = process.argv.slice(2);
const { spawn } = await import("node:child_process");
const fs = await import("node:fs/promises");
const os = await import("node:os");
const BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const dir = await fs.mkdtemp(`${os.tmpdir()}/cdp-`);
// Port 0: Chrome picks a free port and writes it to DevToolsActivePort, so two runs never share a Chrome.
const proc = spawn(BIN, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
  `--window-size=${w},${h}`, "--remote-debugging-port=0", `--user-data-dir=${dir}`, "about:blank"], { stdio: "ignore" });
// Chrome writes its profile until it has exited: remove it sooner and the folder (up to ~170 MB) stays behind.
const exited = new Promise(r => proc.once("exit", r));
const quit = async () => { proc.kill(); await exited; await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let tab;
for (let i = 0; i < 60 && !tab; i++) {
  await sleep(250);
  try {
    const port = (await fs.readFile(`${dir}/DevToolsActivePort`, "utf8")).split("\n")[0];
    tab = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === "page");
  } catch {}
}
if (!tab) { await quit(); throw new Error("chrome never opened its debug port"); }
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const waiting = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (waiting.has(m.id)) waiting.get(m.id)(m.result ?? m.error); };
const send = (method, params = {}) => new Promise(r => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
await send("Page.enable"); await send("Runtime.enable");
// UA=<string> fakes a user agent (e.g. Mystical.app's "MysticalMac/1.0"); PRELOAD=<js> runs before every document's own scripts.
if (process.env.UA) await send("Network.enable").then(() => send("Network.setUserAgentOverride", { userAgent: process.env.UA }));
if (process.env.PRELOAD) await send("Page.addScriptToEvaluateOnNewDocument", { source: process.env.PRELOAD });
await send("Emulation.setDeviceMetricsOverride", { width: +w, height: +h, deviceScaleFactor: +dpr, mobile: false });
await send("Page.navigate", { url });
await sleep(+waitMs);
if (evalJs) { const r = await send("Runtime.evaluate", { expression: evalJs, awaitPromise: true, returnByValue: true }); console.log("eval:", JSON.stringify(r?.result?.value ?? r).slice(0, +(process.env.EVAL_MAX || 600))); await sleep(+wait2); }
if (full === "1") {
  const r = await send("Runtime.evaluate", { expression: "Math.ceil(document.documentElement.scrollHeight)", returnByValue: true });
  await send("Emulation.setDeviceMetricsOverride", { width: +w, height: r.result.value, deviceScaleFactor: +dpr, mobile: false });
  await sleep(400);
}
const jpg = /\.jpe?g$/i.test(out);
const clip = process.env.CLIP ? (([x, y, width, height]) => ({ x, y, width, height, scale: 1 }))(process.env.CLIP.split(",").map(Number)) : undefined;
const { data } = await send("Page.captureScreenshot", { ...(jpg ? { format: "jpeg", quality: 84 } : { format: "png" }), ...(clip ? { clip, captureBeyondViewport: true } : {}) });
await fs.writeFile(out, Buffer.from(data, "base64"));
ws.close(); await quit();
console.log(`${out} ${(Buffer.from(data, "base64").length / 1024 | 0)}KB`);
process.exit(0);
