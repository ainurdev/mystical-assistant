// CDP screenshot: works on pages that hold SSE/WebSocket open (the dashboard),
// where chrome's --screenshot never fires. usage: node shot.mjs <url> <out.png> [w] [h] [waitMs]
const [url, out, w = 1280, h = 800, waitMs = 3000] = process.argv.slice(2);
const { spawn } = await import("node:child_process");
const fs = await import("node:fs/promises");
const os = await import("node:os");

const CHROME = (await fs.readdir(`${os.homedir()}/.cache/ms-playwright`))
  .filter(d => d.startsWith("chromium_headless_shell-"))
  .sort((a, b) => +b.split("-")[1] - +a.split("-")[1])[0];
const BIN = `${os.homedir()}/.cache/ms-playwright/${CHROME}/chrome-headless-shell-linux64/chrome-headless-shell`;
const PORT = 9333 + (process.pid % 500);
const dir = await fs.mkdtemp(`${os.tmpdir()}/cdp-`);

const proc = spawn(BIN, ["--headless", "--no-sandbox", "--hide-scrollbars",
  "--force-device-scale-factor=1", `--window-size=${w},${h}`,
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, "about:blank"],
  { env: { ...process.env, LD_LIBRARY_PATH: `${os.homedir()}/.cache/ms-playwright:${process.env.LD_LIBRARY_PATH ?? ""}` },
    stdio: "ignore" });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let tab;
for (let i = 0; i < 40 && !tab; i++) {
  await sleep(250);
  try { tab = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === "page"); } catch {}
}
if (!tab) { proc.kill(); throw new Error("chrome never opened its debug port"); }

const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const waiting = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (waiting.has(m.id)) waiting.get(m.id)(m.result); };
const send = (method, params = {}) => new Promise(r => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });

await send("Page.enable");
await send("Page.navigate", { url });
await sleep(+waitMs);                       // fixed settle — load never fires with SSE open
const { data } = await send("Page.captureScreenshot", { format: "png" });
await fs.writeFile(out, Buffer.from(data, "base64"));
ws.close(); proc.kill(); await fs.rm(dir, { recursive: true, force: true });
console.log(`${out} ${(Buffer.from(data, "base64").length / 1024 | 0)}KB`);
process.exit(0);
