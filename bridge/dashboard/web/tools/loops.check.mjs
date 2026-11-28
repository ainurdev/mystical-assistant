// The loop guard (tools/loops.mjs) on planted fixtures and on the real tree.
// node --test tools/loops.check.mjs   (from web/; `npm run check` runs it)
import assert from "node:assert/strict";
import { test } from "node:test";
import { audit, readTree } from "./loops.mjs";

const STILL = ":root[data-still] .sweep, :root[data-still] .still-scene { animation-play-state: paused !important; }";
const base = { "index.css": `${STILL}\n@keyframes spin { to { transform: rotate(1turn); } }\n@keyframes fade { 50% { opacity: .3; } }\n@keyframes glow { to { box-shadow: 0 0 6px red; } }\n@keyframes slide { to { left: 50%; } }` };
const run = extra => audit({ ...base, ...extra });

test("an endless smooth loop that repaints fails in a stylesheet", () => {
  const bad = run({ "x.css": ".a {\n  color: red;\n  animation: glow 1s linear infinite;\n}" });
  assert.equal(bad.length, 1);
  assert.match(bad[0], /x\.css:3 \.a: endless smooth loop "glow 1s linear infinite" repaints/);
});

test("an endless smooth loop that repaints fails in an inline style, with or without a timing word", () => {
  for (const anim of ["glow 1s linear infinite", "glow 2.4s infinite", "glow 1s ease-in-out 0.2s infinite"]) {
    const bad = run({ "components/X.tsx": `export const X = () => <i style={{ animation: "${anim}" }} />;` });
    assert.equal(bad.length, 1, anim);
    assert.match(bad[0], /components\/X\.tsx:1: endless smooth loop/);
  }
  assert.equal(run({ "components/X.tsx": "const GLOW = `glow ${d}s linear infinite`;" }).length, 1, "a template");
});

test("the longhand and the endless Web Animation fail too", () => {
  assert.equal(run({ "x.css": ".a { animation-name: glow; animation-iteration-count: infinite; }" }).length, 1);
  assert.equal(run({ "components/X.tsx": "el.animate(k, { duration: 900, iterations: Infinity });" }).length, 1);
});

test("a smooth loop on transform or opacity passes, and a stepped one that repaints", () => {
  assert.deepEqual(run({
    "x.css": ".a { animation: spin 1s linear infinite; } .b { animation: fade 2s ease-in-out infinite, glow 1s steps(8) infinite; }",
    "components/X.tsx": "<i style={{ animation: `spin .9s linear ${d}s infinite` }} /><i style={{ animation: `glow .9s steps(7) ${d}s infinite` }} />",
  }), []);
});

test("a stepped loop on transform or opacity fails: stepping takes it off the compositor", () => {
  const bad = run({ "x.css": ".a { animation: spin 1s steps(8) infinite; }", "components/X.tsx": '<i style={{ animation: "fade 2s steps(16) infinite" }} />' });
  assert.equal(bad.length, 2);
  assert.match(bad[0], /x\.css:1 \.a: "spin 1s steps\(8\) infinite" steps a loop on transform\/opacity/);
  assert.match(bad[1], /components\/X\.tsx:1: "fade 2s steps\(16\) infinite" steps a loop/);
  assert.equal(run({ "x.css": ".a { animation-name: spin; animation-iteration-count: infinite; animation-timing-function: steps(8); }" }).length, 1, "the longhand");
});

test("a blink passes", () => {
  assert.deepEqual(run({
    "x.css": ".a { animation: fade 1s step-end infinite, fade .2s steps(1, end) infinite; }",
    "components/X.tsx": '<i style={{ animation: "fade 1s steps(1) infinite" }} />',
  }), []);
});

test("turning an SVG shape repaints, turning the <svg> does not", () => {
  assert.match(run({ "components/X.tsx": '<circle style={{ animation: "spin 2s linear infinite" }} />' })[0], /repaints every frame/);
  assert.deepEqual(run({ "components/X.tsx": '<svg style={{ animation: "spin 2s linear infinite" }} />' }), []);
});

test("a one-shot animation that fills backwards or not at all passes", () => {
  assert.deepEqual(run({ "x.css": ".a { animation: spin 1s linear backwards .2s; }", "components/X.tsx": '<i style={{ animation: "spin 1s linear" }} />' }), []);
});

test("a one-shot animation that holds its end fails, unless it is an exit or the intro's", () => {
  assert.match(run({ "x.css": ".a {\n  animation: spin 1s linear both;\n}" })[0], /x\.css:2 \.a: "spin 1s linear both" holds its end/);
  assert.equal(run({ "x.css": ".a { animation-name: spin; animation-fill-mode: forwards; }" }).length, 1, "the longhand");
  assert.equal(run({ "components/X.tsx": '<i style={{ animation: `mslide .16s ease ${d}ms forwards` }} />' }).length, 1, "inline");
  assert.deepEqual(run({
    "x.css": ".a { animation: modalOut .28s ease-in forwards; } .bootleaving .kd-sheet { animation: kdsheet .55s ease .3s forwards; }",
    "components/X.tsx": '<i style={{ animation: closing ? "ctxOut .165s ease both" : "ctxIn .2s backwards" }} />',
    "components/hud/BootIntro.tsx": '<i style={{ animation: "tickfade .5s ease both .9s" }} />',
  }), []);
});

test("a listed scene passes only under the still rule", () => {
  assert.deepEqual(run({ "y.css": ".sweep { animation: spin 8s linear infinite; }" }), []);
  const bad = audit({ "y.css": ".sweep { animation: spin 8s linear infinite; }" });
  assert.match(bad[0], /listed scene, but the still rule/);
});

test("a listed inline scene passes only with the still-scene class", () => {
  const scene = cls => ({ "components/hud/Strip.tsx": `<circle ${cls} style={{ transformOrigin: "50px 50px", animation: "introspin 14s linear infinite" }} onClick={() => a > b} />` });
  assert.deepEqual(run(scene('className="still-scene"')), []);
  assert.match(run(scene(""))[0], /without the still-scene class/);
  // listed by file + keyframe, so the same keyframe elsewhere is still an indicator
  assert.equal(run({ "components/hud/Other.tsx": '<i className="still-scene" style={{ animation: "introspin 14s linear infinite" }} />' }).length, 1);
});

test("the intro passes as it is", () => {
  assert.deepEqual(run({
    "components/hud/BootIntro.tsx": '<i style={{ animation: "radar 3.4s ease-out infinite" }} />',
    "x.css": ".kd-runes > g { animation: introspin 30s linear infinite; }",
  }), []);
});

test("an endless loop that moves left fails even when stepped", () => {
  const bad = run({ "x.css": ".a { animation: slide 1s steps(8) infinite; }" });
  assert.match(bad[0], /animates left\/margin-left/);
});

test("Tailwind's animate-spin runs as it is; a stepped --animate-spin fails", () => {
  const tw = '<i className="h-4 animate-spin motion-reduce:animate-none" />';
  assert.deepEqual(run({ "components/X.tsx": tw }), []);
  assert.deepEqual(audit({ "components/X.tsx": tw, "t.css": "@theme { --animate-pulse: pulse 2s linear infinite; }" }), [], "Tailwind's own keyframes");
  assert.match(audit({ "t.css": "@theme { --animate-spin: spin 1s steps(8) infinite; }" })[0], /steps a loop on transform\/opacity/);
});

test("the real tree passes", () => {
  assert.deepEqual(audit(readTree(new URL("..", import.meta.url).pathname)), []);
});
