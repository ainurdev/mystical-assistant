// Before/after geometry of one dashboard state across window sizes. A selector that shrank or went
// missing is flagged and the exit status is 1, so a regression in one band of widths can't scroll
// past unread in a table of rects (.claude/skills/bridge-eyes/MAC.md).
// usage: node macos/eyes/compare.mjs <before> <after> '<sel>[,<sel>…]' ['<step js>']
//   before, after: a dist folder (served read-only over the live bridge, roserve.mjs) or a URL.
//   step: runs in the page after boot, inside an async function, so `await` works.
// env: SIZES=WxH,… replaces the sizes below; SHOTS=<dir> keeps the captures; DPR (1); WAIT=<ms> boot
//      wait (6000); AS_USER=0 drops Mystical.app's settings and window size (user.mjs).
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url"; import { promisify } from "node:util";
import { serve } from "./roserve.mjs";
import { userPreload, userWindow } from "./user.mjs";

// a, b: [x, y, w, h] before and after. Narrower is a shrink, and so is shorter at the same width;
// shorter but wider is text reflowing into the room, shown but not flagged.
const FLAGS = ["SHRANK", "GONE", "MISSING IN BOTH"];
const classify = (a, b) => (!b ? (a ? "GONE" : "MISSING IN BOTH") : !a ? "new"
  : b[2] < a[2] || (b[3] < a[3] && b[2] === a[2]) ? "SHRANK" : b[3] < a[3] ? "reflowed" : "");
// Self-check, on the miss this script exists for (Settings at 700×600 lost 6px of width) and on a
// Settings page that grew 13px wider and so 19px shorter.
if (classify([21, 42, 658, 516], [24, 24, 652, 552]) !== "SHRANK" || classify([300, 142, 661, 1687], [293, 112, 674, 1668]) !== "reflowed"
  || classify([0, 0, 9, 9], [5, 5, 9, 9]) !== "") throw new Error("classify is broken");

const here = path.dirname(fileURLToPath(import.meta.url));
const [beforeArg, afterArg, selArg, step = ""] = process.argv.slice(2);
if (!selArg) { console.error("usage: node macos/eyes/compare.mjs <before> <after> '<sel>[,<sel>…]' ['<step js>']"); process.exit(2); }
const sels = selArg.split(",").map(s => s.trim()).filter(Boolean);
const { DPR = "1", WAIT = "6000", SHOTS } = process.env;
const asUser = process.env.AS_USER !== "0";

// Either side of the CSS breakpoints (600, 640, 760, 860/900, 1900), plus the user's own window.
let sizes = (process.env.SIZES || "390x844,601x700,700x600,800x600,1024x768,1920x1080,2560x1440").split(",").map(s => s.split("x").map(Number));
const win = asUser && !process.env.SIZES ? userWindow() : null;
if (win && !sizes.some(([w, h]) => w === win[0] && h === win[1])) sizes = [...sizes, win].sort((a, b) => a[0] - b[0]);

function dashToken() {
  if (process.env.DASH_TOKEN) return process.env.DASH_TOKEN;
  // .env lives in the main checkout only, and its value is quoted: quoted, every POST is a 401.
  const common = execFileSync("git", ["-C", here, "rev-parse", "--path-format=absolute", "--git-common-dir"]).toString().trim();
  const env = path.join(path.dirname(common), ".env");
  const m = fs.existsSync(env) ? fs.readFileSync(env, "utf8").match(/^DASH_TOKEN=(.*)$/m) : null;
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
}

async function origin(arg) {
  if (/^https?:\/\//.test(arg)) return arg.replace(/\/+$/, "");
  if (!fs.existsSync(path.join(arg, "index.html"))) throw new Error(`${arg}: not a dashboard build (no index.html)`);
  const s = await serve(arg, 0);
  return `http://127.0.0.1:${s.address().port}`;
}

const run = promisify(execFile);
const token = encodeURIComponent(dashToken());
const preload = [asUser ? userPreload() : "", process.env.PRELOAD || ""].filter(Boolean).join("\n");
const measureJs = `(async () => {
  ${step};
  await new Promise(r => setTimeout(r, 1500));
  return ${JSON.stringify(sels)}.map(s => { const e = document.querySelector(s); if (!e) return null;
    const b = e.getBoundingClientRect(); return [b.x, b.y, b.width, b.height].map(Math.round); });
})()`;

async function measure(base, [w, h], side) {
  const out = SHOTS ? path.join(SHOTS, `${side}-${w}x${h}.png`) : path.join(os.tmpdir(), `eyes-${process.pid}-${side}.png`);
  const { stdout } = await run(process.execPath, [path.join(here, "cdp.mjs"), `${base}/?skipboot=1&token=${token}`, out, w, h, WAIT, measureJs, 300, DPR],
    { env: { ...process.env, PRELOAD: preload, EVAL_MAX: "1000000" }, maxBuffer: 1 << 24 });
  if (!SHOTS) fs.rmSync(out, { force: true });
  const line = stdout.split("\n").find(l => l.startsWith("eval: "));
  const rects = line ? JSON.parse(line.slice(6)) : null;
  if (!Array.isArray(rects)) throw new Error(`${side} ${w}x${h}: the step or a selector threw: ${line ?? stdout}`);
  return rects;
}

const fmt = r => (r ? `${r[0]},${r[1]} ${r[2]}×${r[3]}` : "—");
const flagged = [];
try {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const [before, after] = await Promise.all([origin(beforeArg), origin(afterArg)]);
  console.log(`${"size".padEnd(10)} ${"selector".padEnd(20)} ${"before".padEnd(18)} ${"after".padEnd(18)}    Δw    Δh`);
  for (const size of sizes) {
    const [a, b] = await Promise.all([measure(before, size, "before"), measure(after, size, "after")]);
    sels.forEach((sel, i) => {
      const flag = classify(a[i], b[i]);
      const [dw, dh] = a[i] && b[i] ? [b[i][2] - a[i][2], b[i][3] - a[i][3]] : ["", ""];
      if (FLAGS.includes(flag)) flagged.push(`${size.join("x")} ${sel}: ${flag}`);
      console.log(`${size.join("x").padEnd(10)} ${sel.padEnd(20)} ${fmt(a[i]).padEnd(18)} ${fmt(b[i]).padEnd(18)} ${String(dw).padStart(5)} ${String(dh).padStart(5)}  ${flag}`.trimEnd());
    });
  }
} catch (e) {
  console.error(String(e.message ?? e));
  process.exit(2);
}
if (flagged.length) { console.log(`\n${flagged.length} flagged (shrank or missing in after): decide whether each is meant.\n${flagged.join("\n")}`); process.exit(1); }
console.log("\nnothing shrank or went missing.");
process.exit(0);
