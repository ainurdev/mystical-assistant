/* A brand colour that still reads as text on the ground it sits on.

   A project's tile keeps its brand colour as it is. Its name and branch print
   in the same hue, with the lightness clamped into the range the ground can
   carry: OKLCH L between --ink-lo and --ink-hi (index.css; dark grounds lift
   it, paper darkens it). The page does that in CSS with inkCss(), so a theme
   switch re-inks every name without a re-render. liftInk() is the same sum in
   JS, so the mark editor can say what a colour will look like. */

export const INK = { dark: { lo: 0.65, hi: 1 }, light: { lo: 0, hi: 0.55 } };

const HEX = /^#[0-9a-f]{6}$/i;

/** The CSS a project's colour prints in: a hex brand colour, clamped to what
 *  the ground can carry. Theme inks (var(--acc) …) already are, so they pass. */
export function inkCss(color: string): string {
  return HEX.test(color) ? `oklch(from ${color} clamp(var(--ink-lo), l, var(--ink-hi)) c h)` : color;
}

const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGam = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** [L, C, H°] of an sRGB colour (0-255 channels). */
export function rgbToOklch(r8: number, g8: number, b8: number): [number, number, number] {
  const r = toLin(r8 / 255), g = toLin(g8 / 255), b = toLin(b8 / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360];
}

export function hexToOklch(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return rgbToOklch((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

function oklchToLinear(L: number, C: number, H: number): [number, number, number] {
  const a = C * Math.cos((H * Math.PI) / 180), b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
          -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
          -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

/** An OKLCH colour as #rrggbb. Out of gamut, chroma gives way first and the hue
 *  and lightness hold, which is what CSS does with the same colour. */
export function oklchToHex(L: number, C: number, H: number): string {
  const inside = (c: number) => oklchToLinear(L, c, H).every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  let c = C;
  if (!inside(c)) {
    let lo = 0, hi = C;
    for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (inside(mid)) lo = mid; else hi = mid; }
    c = lo;
  }
  return "#" + oklchToLinear(L, c, H)
    .map((v) => Math.round(Math.min(1, Math.max(0, toGam(Math.min(1, Math.max(0, v))))) * 255).toString(16).padStart(2, "0"))
    .join("");
}

/** What a hex brand colour prints as on a dark or light ground, or null when
 *  it already reads there as it is. */
export function liftInk(hex: string, light: boolean): string | null {
  if (!HEX.test(hex)) return null;
  const [L, C, H] = hexToOklch(hex);
  const { lo, hi } = light ? INK.light : INK.dark;
  if (L >= lo && L <= hi) return null;
  return oklchToHex(Math.min(hi, Math.max(lo, L)), C, H);
}
