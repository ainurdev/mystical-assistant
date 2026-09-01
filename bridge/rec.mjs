// Screen-record a page: shot2.mjs's chrome+CDP skeleton, but Page.startScreencast
// instead of one captureScreenshot, JPEG frames piped into Playwright's ffmpeg.
//
// Output is VP8/webm, not mp4, because that bundled ffmpeg is built
// --disable-everything: mjpeg in, libvpx out, webm muxed. No h264, no concat
// demuxer. So real timing is kept by duplicating the last frame to fill each
// gap -- screencast only emits frames on *change*, and a fixed rate over
// change-only frames renders a 5s wait as instant, which makes the video lie
// about the thing it was recorded to verify.
//
// usage: node rec.mjs <url> <out.webm> <w> <h> <settleMs> [seedJSON] [asyncJS] [fps]
//   asyncJS runs with awaitPromise, so an async IIFE with awaits between clicks
//   is the whole step language -- same param, same contract as shot2.mjs.
const [url, out, w = 1280, h = 800, settleMs = 3000, seed = "{}", evalJs = "", fps = 10] =
  process.argv.slice(2);
const { spawn } = await import("node:child_process");
const fs = await import("node:fs/promises");
const os = await import("node:os");

const PW = `${os.homedir()}/.cache/ms-playwright`;
const dirs = await fs.readdir(PW);
const CHROME = dirs.filter(d => d.startsWith("chromium_headless_shell-"))
  .sort((a, b) => +b.split("-")[1] - +a.split("-")[1])[0];
const BIN = `${PW}/${CHROME}/chrome-headless-shell-linux64/chrome-headless-shell`;
const FF = `${PW}/${dirs.filter(d => d.startsWith("ffmpeg-"))
  .sort((a, b) => +b.split("-")[1] - +a.split("-")[1])[0]}/ffmpeg-linux`;

const PORT = 9333 + (process.pid % 500);
const dir = await fs.mkdtemp(`${os.tmpdir()}/cdp-`);
const proc = spawn(BIN, ["--headless", "--no-sandbox", "--hide-scrollbars", "--force-device-scale-factor=1",
  `--window-size=${w},${h}`, `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, "about:blank"],
  { env: { ...process.env, LD_LIBRARY_PATH: `${PW}:${process.env.LD_LIBRARY_PATH ?? ""}` }, stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = async () => { proc.kill(); await fs.rm(dir, { recursive: true, force: true }); };

let tab;
for (let i = 0; i < 40 && !tab; i++) {
  await sleep(250);
  try { tab = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === "page"); } catch {}
}
if (!tab) { await cleanup(); throw new Error("chrome never opened its debug port"); }

const ff = spawn(FF, ["-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-c:v", "mjpeg",
  "-r", String(fps), "-i", "pipe:0", "-y", "-an", "-c:v", "libvpx", "-b:v", "2M", "-crf", "20",
  "-deadline", "realtime", "-cpu-used", "4", out], { stdio: ["pipe", "ignore", "inherit"] });
ff.stdin.on("error", () => {});  // ffmpeg dying mid-record must not kill us with EPIPE
const done = new Promise(r => ff.on("close", r));

const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const waiting = new Map();

let frames = 0, written = 0, last = null, t0f = 0;
// Hold the video clock to the wall clock: pad with the last frame when nothing
// changed, drop when chrome outruns fps (it emits ~50/s). Absolute target, not
// per-gap, so rounding cannot drift over a long recording.
const catchUp = until => {
  const target = Math.round((until - t0f) * fps / 1000);
  while (last && written < target) { ff.stdin.write(last); written++; }
};

ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id !== undefined) return waiting.get(m.id)?.(m.result ?? m.error);
  if (m.method !== "Page.screencastFrame") return;
  const now = Date.now();
  // Wall clock, not metadata.timestamp: always present, and the emit lag is
  // well under one output frame.
  if (!t0f) t0f = now;
  catchUp(now);
  last = Buffer.from(m.params.data, "base64"); frames++;
  // ponytail: no backpressure handling -- node buffers the pipe, and a minute
  // of 1280x800 jpegs is tens of MB. Add a drain wait if you record for hours.
  send("Page.screencastFrameAck", { sessionId: m.params.sessionId });
};
const send = (method, params = {}) => new Promise(r => {
  const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params }));
});

await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: +w, height: +h, deviceScaleFactor: 1, mobile: false });
const seedSrc = `try { const s = ${seed}; for (const k in s) localStorage.setItem(k, typeof s[k] === "string" ? s[k] : JSON.stringify(s[k])); } catch (e) {}`;
await send("Page.addScriptToEvaluateOnNewDocument", { source: seedSrc });

const t0 = Date.now();
await send("Page.startScreencast", { format: "jpeg", quality: 80, maxWidth: +w, maxHeight: +h, everyNthFrame: 1 });
await send("Page.navigate", { url });
await sleep(+settleMs);
if (evalJs) {
  const r = await send("Runtime.evaluate", { expression: evalJs, awaitPromise: true, returnByValue: true });
  console.log("eval:", JSON.stringify(r?.result?.value ?? r).slice(0, 400));
}
await send("Page.stopScreencast");
catchUp(Date.now());
if (last && !written) { ff.stdin.write(last); written++; }
// The final frame, written out as a still. It is already in hand, so this costs
// no second decode -- and it is what lets a caller that cannot watch video (the
// model) still see how the page ended up.
const still = `${out.replace(/\.[^./]+$/, "")}.jpg`;
if (last) await fs.writeFile(still, last);
ws.close();
ff.stdin.end();
const code = await done;
await cleanup();

const secs = (Date.now() - t0) / 1000;
if (!frames) { console.error(`no frames in ${secs}s -- the page never painted`); process.exit(1); }
if (frames === 1) console.error(`warning: 1 frame in ${secs}s -- nothing moved, this is a still`);
if (code !== 0) { console.error(`ffmpeg exited ${code}`); process.exit(1); }
const kb = (await fs.stat(out)).size / 1024 | 0;
console.log(`${out} ${kb}KB  ${frames} frames -> ${written} @${fps}fps  ${secs.toFixed(1)}s  still:${still}`);
process.exit(0);
