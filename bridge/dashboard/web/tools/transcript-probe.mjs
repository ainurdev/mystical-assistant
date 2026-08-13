// Transcript cost probe — the acceptance instrument for
// docs/superpowers/specs/2026-08-12-transcript-virtualization-design.md.
//
// Drives the dashboard over raw CDP (no puppeteer/playwright modules in this
// env): opens 127.0.0.1:8790, search-filters the session list, clicks into the
// named session, then reports open cost (settle time, DOM nodes, heap, script/
// layout/style time) and scroll cost (frame times over a harsh 800px-step sweep
// to the top — pessimistic, but identical run to run, so ratios hold).
//
// Usage:
//   LD_LIBRARY_PATH=$HOME/.cache/ms-playwright:$LD_LIBRARY_PATH \
//    $HOME/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell \
//    --headless --no-sandbox --disable-gpu --hide-scrollbars --window-size=1512,950 \
//    --remote-debugging-port=9333 --user-data-dir=/tmp/probe-prof about:blank &
//   node tools/transcript-probe.mjs "<session title fragment>" "<label>"
//
//   THROTTLE=4    4x CPU throttle (the mid-range-phone stand-in in the spec)
//   CDP_PORT      chrome's debug port (default 9333)
//   DASH_URL      dashboard origin (default http://127.0.0.1:8790)
//
// GET-only by design: it browses the live dashboard, it must never answer
// permission prompts or send prompts. Kill only the chrome you launched for it.
const PORT = process.env.CDP_PORT || 9333;
const BASE = process.env.DASH_URL || 'http://127.0.0.1:8790';
const TARGET = process.argv[2];          // session title fragment to click
const LABEL = process.argv[3] || TARGET;

const j = async (p, o) => (await fetch(`http://127.0.0.1:${PORT}${p}`, o)).json();

const list = await j('/json/list');
let page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const waiters = new Map();
const send = (method, params = {}) => new Promise(res => {
  const i = ++id; waiters.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
});
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m.result); waiters.delete(m.id); }
};
await new Promise(r => ws.onopen = r);

const evalJS = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r?.result?.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

await send('Page.enable'); await send('Runtime.enable'); await send('Performance.enable');
const rate = Number(process.env.THROTTLE || 1);
if (rate > 1) await send('Emulation.setCPUThrottlingRate', { rate });
await send('Page.navigate', { url: `${BASE}/?token=devtest&skipboot=1` });
await sleep(3500);
await evalJS('document.body.click()');   // splash skip, harmless if absent
await sleep(2500);

const metrics = async () => Object.fromEntries(
  (await send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));

// The session list is itself virtualized, so filter it down first via search.
await evalJS(`(() => {
  const inp = [...document.querySelectorAll('input')]
    .find(i => i.type !== 'checkbox' && i.offsetParent !== null);
  if (!inp) return 'no input';
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  set.call(inp, ${JSON.stringify(TARGET)});
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  return 'typed';
})()`);
await sleep(1200);
const clicked = await evalJS(`(() => {
  const hit = [...document.querySelectorAll('button,[role=button],div,li,a')]
    .filter(e => e.textContent && e.textContent.includes(${JSON.stringify(TARGET)})
                 && e.offsetParent !== null)
    .sort((a,b) => a.textContent.length - b.textContent.length)[0];
  if (!hit) return null;
  hit.click();
  return hit.textContent.slice(0,80);
})()`);
if (!clicked) { console.log(JSON.stringify({ label: LABEL, error: 'row not found' })); process.exit(1); }

const before = await metrics();
const t0 = Date.now();
// Wait for the transcript DOM to stop growing (2 consecutive equal samples).
let last = -1, stable = 0, settled = null, nodes = 0;
for (let i = 0; i < 120; i++) {
  await sleep(250);
  nodes = await evalJS('document.getElementsByTagName("*").length');
  if (nodes === last) { if (++stable >= 2) { settled = Date.now() - t0 - 500; break; } }
  else { stable = 0; last = nodes; }
}
const after = await metrics();

// Scroll cost: jump to top of the transcript, sample long-frame count.
const scroll = await evalJS(`(async () => {
  const el = [...document.querySelectorAll('*')]
    .filter(e => e.scrollHeight > e.clientHeight + 400 && e.clientHeight > 200)
    .sort((a,b) => b.scrollHeight - a.scrollHeight)[0];
  if (!el) return null;
  const H = el.scrollHeight, frames = [];
  let prev = performance.now();
  const tick = () => { const n = performance.now(); frames.push(n - prev); prev = n; };
  let raf = true; const loop = () => { if (!raf) return; tick(); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  for (let y = H; y >= 0; y -= 800) { el.scrollTop = y; await new Promise(r => setTimeout(r, 30)); }
  raf = false;
  frames.sort((a,b) => a-b);
  return { scrollHeight: H, frames: frames.length,
           p50: +frames[frames.length>>1].toFixed(1),
           p95: +frames[Math.floor(frames.length*0.95)].toFixed(1),
           worst: +frames[frames.length-1].toFixed(1),
           over50ms: frames.filter(f => f > 50).length };
})()`);

console.log(JSON.stringify({
  label: LABEL, clicked, throttle: rate,
  settleMs: settled,
  domNodes: after.Nodes, domNodesAdded: after.Nodes - before.Nodes,
  heapMB: +(after.JSHeapUsedSize / 1048576).toFixed(1),
  heapAddedMB: +((after.JSHeapUsedSize - before.JSHeapUsedSize) / 1048576).toFixed(1),
  layoutMs: +((after.LayoutDuration - before.LayoutDuration) * 1000).toFixed(0),
  styleMs: +((after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000).toFixed(0),
  scriptMs: +((after.ScriptDuration - before.ScriptDuration) * 1000).toFixed(0),
  scroll,
}, null, 1));
process.exit(0);
