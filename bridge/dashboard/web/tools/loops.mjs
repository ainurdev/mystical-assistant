// The loop guard: every endless animation in the dashboard's stylesheets and components must be
// stepped (an indicator, about 8 updates a second), a listed scene that the still rule pauses
// (lib/still.ts sets :root[data-still]), the nyan cat's glide, or part of the boot intro. A smooth
// endless loop makes WebKit redraw the page 60 times a second (17-21% of a core at rest, 2026-11-23
// study); 30 stepped loops cost nothing. tools/loops.check.mjs runs it on fixtures and the real tree.
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
export const INTRO_PREFIXES = [".kd-", ".dd-"];

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

/** One `animation` shorthand value → its endless items: {name, stepped, text}. */
export function endless(value) {
  return splitTop(value).filter(a => /\binfinite\b/.test(a)).map(a => {
    const words = a.replace(/\([^)]*\)/g, "()").split(/\s+/);
    const name = words.find(w => !KEYWORDS.has(w) && !TIME.test(w) && !w.includes("(") && !/^[\d.]+$/.test(w)) ?? "";
    return { name, stepped: /\bsteps\(|\bstep-(start|end)\b/.test(a), text: a };
  });
}

/** A stylesheet → { loops: [{selector, name, stepped, text}], keyframes: {name: body}, rules: [{selector, body}] } */
export function parseCss(src) {
  src = src.replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, " "));
  const keyframes = {};
  // pull @keyframes blocks out first (they nest one level)
  src = src.replace(/@(?:-webkit-)?keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g, (_, n, body) => {
    keyframes[n] = body; return _.replace(/[^\n]/g, " ");
  });
  const rules = [], loops = [];
  for (const m of src.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim().replace(/\s+/g, " "), body = m[2];
    rules.push({ selector, body });
    for (const d of body.matchAll(/(?:^|;)\s*(animation|--animate-[\w-]+)\s*:([^;]+)/g))
      for (const l of endless(d[2])) loops.push({ selector, prop: d[1], line: lineAt(src, m.index + m[1].length + 1 + d.index + d[0].indexOf(d[1])), ...l });
    // longhands: an endless count with no stepped timing in the same rule
    if (/animation-iteration-count\s*:[^;]*infinite/.test(body) && !/animation-timing-function\s*:[^;]*step/.test(body)) {
      const name = body.match(/animation-name\s*:\s*([\w-]+)/)?.[1] ?? "";
      loops.push({ selector, prop: "animation-iteration-count", name, stepped: false, text: body.trim() });
    }
  }
  return { loops, keyframes, rules };
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

/** A component → every endless loop in a string literal, plus Tailwind animate-* classes and endless WAAPI calls. */
export function parseTsx(src) {
  const loops = [], classes = new Set(), waapi = [];
  for (const m of src.matchAll(/(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
    const text = m[2], flat = text.replace(/\$\{[^}]*\}/g, "0");   // a template's ${…} stands in as 0
    if (/\binfinite\b/.test(flat) && /(\d*\.)?\d+m?s\b/.test(flat) && !/[{};]/.test(flat))
      for (const l of endless(flat)) loops.push({ line: lineAt(src, m.index), ...l, tag: tagAround(src, m.index) });
    for (const c of text.matchAll(/(?:^|[\s:])animate-([a-z][\w-]*)/g)) if (c[1] !== "none") classes.add(c[1]);
  }
  for (const m of src.matchAll(/iterations\s*:\s*Infinity/g)) waapi.push(lineAt(src, m.index));
  return { loops, classes: [...classes], waapi };
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
  const bad = [], keyframes = {}, cssLoops = [], themed = {}, still = new Set();
  for (const [path, text] of Object.entries(files)) {
    if (!path.endsWith(".css")) continue;
    const css = parseCss(text);
    Object.assign(keyframes, css.keyframes);
    for (const l of css.loops) cssLoops.push({ path, ...l });
    for (const r of css.rules)
      if (/animation-play-state\s*:\s*paused/.test(r.body))
        for (const s of splitTop(r.selector)) if (s.startsWith(STILL + " ")) still.add(s.slice(STILL.length + 1));
  }
  const intro = sel => INTRO_PREFIXES.some(p => sel.includes(p));
  const layout = (name, where) => {
    if (/(^|[;{\s])(left|margin-left)\s*:/.test(keyframes[name] ?? "")) bad.push(`${where}: endless ${name} animates left/margin-left; move it with transform`);
  };
  for (const l of cssLoops) {
    if (l.prop.startsWith("--animate-")) { themed[l.prop.slice(10)] = l; }
    const where = `${l.path}:${l.line} ${l.selector}`;
    if (intro(l.selector)) continue;
    layout(l.name, where);
    if (l.stepped || l.prop.startsWith("--animate-")) continue;
    if (NYAN.includes(l.selector)) continue;
    if (SCENES.includes(l.selector)) {
      if (!still.has(l.selector)) bad.push(`${where}: listed scene, but the still rule (${STILL} … paused) doesn't name it`);
      continue;
    }
    bad.push(`${where}: endless smooth loop "${l.text}"; step it (steps(duration × 8)) or list it as a scene`);
  }
  for (const [path, text] of Object.entries(files)) {
    if (path.endsWith(".css") || INTRO_FILES.includes(path)) continue;
    const t = parseTsx(text);
    for (const at of t.waapi) bad.push(`${path}:${at}: endless Web Animation; step it or drop it`);
    for (const c of t.classes) {
      const th = themed[c];
      if (!th) bad.push(`${path}: animate-${c} has no --animate-${c} override; Tailwind's is smooth`);
      else if (!th.stepped) bad.push(`${path}: --animate-${c} is smooth; step it`);
    }
    for (const l of t.loops) {
      layout(l.name, `${path}:${l.line}`);
      if (l.stepped) continue;
      if (SCENES_INLINE.some(([f, n]) => f === path && n === l.name)) {
        if (!/\bstill-scene\b/.test(l.tag)) bad.push(`${path}:${l.line}: listed scene "${l.name}" without the still-scene class`);
        continue;
      }
      bad.push(`${path}:${l.line}: endless smooth loop "${l.text}"; step it (steps(duration × 8)) or list it as a scene`);
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
