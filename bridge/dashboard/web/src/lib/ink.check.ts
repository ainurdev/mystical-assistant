// Run: node bridge/dashboard/web/src/lib/ink.check.ts
import { hexToOklch, inkCss, liftInk, oklchToHex } from "./ink.ts";

const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) < eps;

const [L, C, H] = hexToOklch("#ff0000");
console.assert(near(L, 0.628) && near(C, 0.2577) && near(H, 29.23, 0.1), "sRGB red in OKLCH", L, C, H);
for (const hex of ["#1d2b64", "#ff5b1f", "#f7c531", "#18a874", "#ffffff", "#000000"]) {
  console.assert(oklchToHex(...hexToOklch(hex)) === hex, "round trip", hex);
}

const navy = liftInk("#1d2b64", false);
console.assert(navy !== null && near(hexToOklch(navy)[0], 0.65), "navy is lifted to L .65 on a dark ground", navy);
console.assert(near(hexToOklch(navy!)[2], hexToOklch("#1d2b64")[2], 2), "and keeps its hue", navy);
console.assert(liftInk("#ff5b1f", false) === null, "orange already reads on a dark ground");
const yellow = liftInk("#f7c531", true);
console.assert(yellow !== null && near(hexToOklch(yellow)[0], 0.55), "yellow is darkened on paper", yellow);
console.assert(liftInk("#1d2b64", true) === null, "navy reads on paper");
console.assert(liftInk("var(--acc)", false) === null, "a theme ink is never lifted");
console.assert(/^#[0-9a-f]{6}$/.test(oklchToHex(0.95, 0.3, 140)), "out of gamut still makes a hex");

console.assert(inkCss("#1d2b64") === "oklch(from #1d2b64 clamp(var(--ink-lo), l, var(--ink-hi)) c h)", "hex -> relative colour");
console.assert(inkCss("var(--ok)") === "var(--ok)", "theme ink passes through");
console.log("ink.check ok");
