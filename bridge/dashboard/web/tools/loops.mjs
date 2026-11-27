// The loop guard: every endless animation in the dashboard's stylesheets and components must be
// cheap to run. One that moves only transform or opacity runs smooth: WebKit hands it to the
// compositor, and the page does nothing a frame. Stepping one takes it back from the compositor, so
// the page redraws at every step: it reads as laggy and costs more than smooth (2026-11-27, a window
// on the display: a spinner 4.2% of a core stepped, 2.5% smooth, 1.9% with nothing running). Blinks
// (steps(1), step-start/end) are on/off by design. A loop on anything else (box-shadow,
// background-position, a custom property, an SVG shape's transform) makes WebKit redraw 60 times a
// second (17-21% of a core at rest, 2026-11-23 study), so it is stepped (an indicator, about 8 updates
// a second), a listed scene that the still rule pauses (lib/still.ts sets :root[data-still]), the
// nyan cat's sky, or part of the boot intro. A one-shot animation that holds its end (`forwards` or
// `both`) costs a restyle every frame for as long as it holds, so an entrance ends on the element's
// own resting style and fills `backwards`. tools/loops.check.mjs runs it on fixtures and the real tree.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// ---- the lists ----------------------------------------------------------------------------------

// Scenes: smooth, paused under :root[data-still]. CSS ones by their exact selector, which the still
// rule in index.css must name too; inline ones by file + keyframe, and their element must carry the
// `still-scene` class (the still rule's catch-all for inline styles).
export const SCENES = [
  ".sweep",                     // the CRT sweep
  ".home-emblem .ring",         // HOME's emblem ring
  ".home-rune",                 // HOME's sky
];
export const SCENES_INLINE = [
  ["components/hud/Terminal.tsx", "introspin"],    // the fresh-session scene
  ["components/hud/Terminal.tsx", "introspinr"],
  ["components/hud/Terminal.tsx", "twinkle"],
  ["components/hud/Terminal.tsx", "eyeblink"],
  ["components/hud/Terminal.tsx", "quoteglow"],
  ["components/hud/Terminal.tsx", "caretbreath"],
  ["components/hud/Terminal.tsx", "awaitsweep"],
  ["components/hud/Terminal.tsx", "bob"],
  ["components/hud/Strip.tsx", "introspin"],       // the caption's emblem ring
  ["components/hud/RuneSpirit.tsx", "twinkle"],    // the rune spirit
];
// The nyan cat keeps its exact glide (the user's call, 2026-11-23): smooth, never paused.
export const NYAN = [".nyan-ride", ".nyan-trail", ".nyan-star", ".nyan-sky"];
// The boot intro is untouched: its files, and its scenes' CSS prefixes.
export const INTRO_FILES = ["components/hud/BootIntro.tsx", "components/hud/BootScenes.tsx", "components/hud/BootFire.ts"];
export const INTRO_PREFIXES = [".kd-", ".dd-", ".boot-"];   // .boot-: the intro's exit title swap (BootIntro)
// Exits may hold their end: each ends in its element's removal, a frame or two later.
export const EXITS = ["backdropOut", "modalOut", "ctxOut", "freshleave", "quoteout", "clg-bar"];
// What the compositor runs: keyframes that move only these. Tailwind's spin and pulse, which no
// stylesheet here defines, are two such.
const COMPOSITOR = new Set(["transform", "opacity", "translate", "rotate", "scale", "animation-timing-function"]);
const TAILWIND = { spin: "to { transform: rotate(360deg); }", pulse: "50% { opacity: .5; }" };
// An SVG shape inside an <svg> gets no layer of its own in WebKit, so turning one repaints (2026-11-27:
// ten turning circles 4.0-6.9% of a core, ten turning <svg>s 1.9-3.2%).
// shortcut: only an inline style's tag shows a shape; a stylesheet rule that turns one (.home-emblem .ring)
// passes as composited, so list it as a scene; read the markup if one slips through.
const SVG_SHAPE = /^<(circle|ellipse|g|line|path|polygon|polyline|rect|text|use)\b/;

// ---- parsing ------------------------------------------------------------------------------------

const TIME = /^-?(\d*\.)?\d+m?s$/;
const KEYWORDS = new Set(["infinite", "linear", "ease", "ease-in", "ease-out", "ease-in-out", "step-start", "step-end",
  "alternate", "alternate-reverse", "normal", "reverse", "forwards", "backwards", "both", "none", "running", "paused"]);

const lineAt = (src, i) => src.slice(0, i).split("\n").length;

/** Split on commas outside parentheses. */
function splitTop(s) {
  const out = []; let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}

const nameOf = a => a.replace(/\([^)]*\)/g, "()").split(/\s+/)
  .find(w => !KEYWORDS.has(w) && !TIME.test(w) && !w.includes("(") && !/^[\d.]+$/.test(w)) ?? "";

/** One `animation` shorthand value → its endless items: {name, stepped, text}. */
export function endless(value) {
  return splitTop(value).filter(a => /\binfinite\b/.test(a))
    .map(a => ({ name: nameOf(a), stepped: /\bsteps\(|\bstep-(start|end)\b/.test(a), text: a }));
}

/** steps(1) and step-start/end: a blink, on/off by design. */
const blink = text => /\bsteps\(\s*1\s*[,)]|\bstep-(start|end)\b/.test(text);

/** A keyframes body moves only what the compositor runs (no body known: no). */
export function composited(body) {
  const props = [...(body ?? "").matchAll(/([\w-]+)\s*:/g)].map(m => m[1]);
  return props.length > 0 && props.every(p => COMPOSITOR.has(p));
}

/** One `animation` shorthand value → its one-shot items that hold their end: {name, text}. */
export function holds(value) {
  return splitTop(value).filter(a => !/\binfinite\b/.test(a) && /\b(forwards|both)\b/.test(a)).map(a => ({ name: nameOf(a), text: a }));
}

/** A stylesheet → { loops: [{selector, name, stepped, text}], keyframes: {name: body}, rules: [{selector, body}] } */
export function parseCss(src) {
  src = src.replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, " "));
  const keyframes = {};
  // pull @keyframes blocks out first (they nest one level)
  src = src.replace(/@(?:-webkit-)?keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g, (_, n, body) => {
    keyframes[n] = body; return _.replace(/[^\n]/g, " ");
  });
  const rules = [], loops = [], held = [];
  for (const m of src.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim().replace(/\s+/g, " "), body = m[2];
    rules.push({ selector, body });
    for (const d of body.matchAll(/(?:^|;)\s*(animation|--animate-[\w-]+)\s*:([^;]+)/g)) {
      const line = lineAt(src, m.index + m[1].length + 1 + d.index + d[0].indexOf(d[1]));
      for (const l of endless(d[2])) loops.push({ selector, prop: d[1], line, ...l });
      for (const h of holds(d[2])) held.push({ selector, line, ...h });
    }
    if (/animation-fill-mode\s*:[^;]*\b(forwards|both)\b/.test(body)) held.push({ selector, name: "", text: body.trim() });
    // longhands: an endless count, stepped when the same rule's timing steps
    if (/animation-iteration-count\s*:[^;]*infinite/.test(body)) {
      const name = body.match(/animation-name\s*:\s*([\w-]+)/)?.[1] ?? "";
      const timing = body.match(/animation-timing-function\s*:([^;]*)/)?.[1] ?? "";
      loops.push({ selector, prop: "animation-iteration-count", name, stepped: /\bsteps\(|\bstep-(start|end)\b/.test(timing), text: timing.trim() });
    }
  }
  return { loops, keyframes, rules, held };
}

/** The JSX opening tag that holds position `at`, scanned with brace depth so `=>` and `{a > b}` don't end it. */
export function tagAround(src, at) {
  let start = at;
  while (start > 0 && !(src[start] === "<" && /[A-Za-z]/.test(src[start + 1] ?? ""))) start--;
  let depth = 0, i = start, quote = "";
  for (; i < src.length; i++) {
    const ch = src[i];
    if (quote) { if (ch === quote && src[i - 1] !== "\\") quote = ""; continue; }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0 && src[i - 1] !== "=") break;
  }
  return src.slice(start, i + 1);
}

/** A component → every endless loop in a string literal, plus endless WAAPI calls. Tailwind's animate-*
 *  classes need no look: theirs are composited, and an --animate-* override is a stylesheet loop. */
export function parseTsx(src) {
  const loops = [], waapi = [], held = [];
  for (const m of src.matchAll(/(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
    const text = m[2], flat = text.replace(/\$\{[^}]*\}/g, "0");   // a template's ${…} stands in as 0
    if (/\binfinite\b/.test(flat) && /(\d*\.)?\d+m?s\b/.test(flat) && !/[{};]/.test(flat))
      for (const l of endless(flat)) loops.push({ line: lineAt(src, m.index), ...l, tag: tagAround(src, m.index) });
    if (/\b(forwards|both)\b/.test(flat) && /(\d*\.)?\d+m?s\b/.test(flat) && !/[{};]/.test(flat))
      for (const h of holds(flat)) held.push({ line: lineAt(src, m.index), ...h });
  }
  for (const m of src.matchAll(/iterations\s*:\s*Infinity/g)) waapi.push(lineAt(src, m.index));
  return { loops, waapi, held };
}

// ---- the rules ----------------------------------------------------------------------------------

const STILL = ":root[data-still]";

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(css|tsx?)$/.test(n) && !/\.check\.ts$/.test(n)) out.push(p);
  }
  return out;
}

/** Every rule broken in a tree of sources: `files` maps a path under src/ to its text. Returns messages. */
export function audit(files) {
  const bad = [], keyframes = { ...TAILWIND }, cssLoops = [], still = new Set();
  const hold = (h, where) => { if (!EXITS.includes(h.name)) bad.push(`${where}: "${h.text}" holds its end; end on the resting style and fill backwards`); };
  for (const [path, text] of Object.entries(files)) {
    if (!path.endsWith(".css")) continue;
    const css = parseCss(text);
    Object.assign(keyframes, css.keyframes);
    for (const l of css.loops) cssLoops.push({ path, ...l });
    for (const h of css.held) if (!INTRO_PREFIXES.some(p => h.selector.includes(p))) hold(h, `${path}:${h.line} ${h.selector}`);
    for (const r of css.rules)
      if (/animation-play-state\s*:\s*paused/.test(r.body))
        for (const s of splitTop(r.selector)) if (s.startsWith(STILL + " ")) still.add(s.slice(STILL.length + 1));
  }
  const intro = sel => INTRO_PREFIXES.some(p => sel.includes(p));
  const layout = (name, where) => {
    if (/(^|[;{\s])(left|margin-left)\s*:/.test(keyframes[name] ?? "")) bad.push(`${where}: endless ${name} animates left/margin-left; move it with transform`);
  };
  // a loop the compositor would run must not step: it reads as laggy and costs more (the header)
  const onLayer = (l, where) => {
    if (l.stepped) bad.push(`${where}: "${l.text}" steps a loop on transform/opacity, which takes it off the compositor; give it its easing back`);
  };
  const smooth = l => `endless smooth loop "${l.text}" repaints every frame; move it onto transform/opacity, step it (steps(duration × 8)) or list it as a scene`;
  for (const l of cssLoops) {
    const where = `${l.path}:${l.line} ${l.selector}`;
    if (intro(l.selector)) continue;
    layout(l.name, where);
    if (blink(l.text)) continue;
    if (SCENES.includes(l.selector)) {
      if (!still.has(l.selector)) bad.push(`${where}: listed scene, but the still rule (${STILL} … paused) doesn't name it`);
      continue;
    }
    if (composited(keyframes[l.name])) { onLayer(l, where); continue; }
    if (l.stepped || NYAN.includes(l.selector)) continue;
    bad.push(`${where}: ${smooth(l)}`);
  }
  for (const [path, text] of Object.entries(files)) {
    if (path.endsWith(".css") || INTRO_FILES.includes(path)) continue;
    const t = parseTsx(text);
    for (const h of t.held) hold(h, `${path}:${h.line}`);
    for (const at of t.waapi) bad.push(`${path}:${at}: endless Web Animation; step it or drop it`);
    for (const l of t.loops) {
      layout(l.name, `${path}:${l.line}`);
      if (blink(l.text)) continue;
      // first, as an inline scene is known by file + keyframe only: an indicator on the same keyframe is no scene
      if (composited(keyframes[l.name]) && !SVG_SHAPE.test(l.tag)) { onLayer(l, `${path}:${l.line}`); continue; }
      if (l.stepped) continue;
      if (SCENES_INLINE.some(([f, n]) => f === path && n === l.name)) {
        if (!/\bstill-scene\b/.test(l.tag)) bad.push(`${path}:${l.line}: listed scene "${l.name}" without the still-scene class`);
        continue;
      }
      bad.push(`${path}:${l.line}: ${smooth(l)}`);
    }
  }
  return bad;
}

/** The real tree: every stylesheet and component under src/. */
export function readTree(root) {
  const src = join(root, "src"), files = {};
  for (const p of walk(src)) files[relative(src, p)] = readFileSync(p, "utf8");
  return files;
}
