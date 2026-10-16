// Run: node bridge/dashboard/web/src/lib/logoinfo.check.ts
// analyse() only — readLogo/useLogoInfo need a canvas and React.
import { analyse } from "./logoinfo.ts";

/** A w×h RGBA image painted by f(x, y) -> [r, g, b, a]. */
function img(w: number, h: number, f: (x: number, y: number) => number[]): number[] {
  const px: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.push(...f(x, y));
  return px;
}
const S = 16;

// An opaque orange square with a white stripe: fills its tile, orange first.
const square = analyse(img(S, S, (x) => (x > 6 && x < 9 ? [255, 255, 255, 255] : [255, 91, 31, 255])), S, S);
console.assert(square.fill, "an opaque square fills its tile");
console.assert(square.colors[0] === "#ff5b1f", "its brand colour comes first", square.colors);
console.assert(!square.colors.includes("#ffffff"), "white lettering is not a brand colour", square.colors);

// Navy lettering on transparency, with a small red dot: see-through, dark ink.
const navy = analyse(img(S, S, (x, y) => (x < 2 || y < 2 || x > 13 || y > 13 ? [0, 0, 0, 0]
  : x < 4 && y < 4 ? [233, 72, 59, 255] : [29, 43, 100, 255])), S, S);
console.assert(!navy.fill, "transparent edges: not a fill");
console.assert(navy.colors[0] === "#1d2b64" && navy.colors.includes("#e9483b"), "navy, then the red dot", navy.colors);

// A dark square with a teal mark and a coral dot (an app icon on a near-black
// ground): the teal is the colour, not the ground that covers most of it.
const site = analyse(img(S, S, (x, y) => (x > 3 && x < 8 && y > 3 && y < 12 ? [46, 196, 182, 255]
  : x > 10 && x < 13 && y > 3 && y < 6 ? [255, 107, 107, 255] : [34, 34, 59, 255])), S, S);
console.assert(site.fill && site.colors[0] === "#2ec4b6", "a bright mark beats its dark ground", site.colors);

// Yellow bars on transparency: light ink.
const yellow = analyse(img(S, S, (_x, y) => (y % 4 === 0 ? [0, 0, 0, 0] : [247, 197, 49, 255])), S, S);
console.assert(!yellow.fill && yellow.colors[0] === "#f7c531", "yellow bars on see-through: no fill, yellow");

// Black and white only: nothing has colour, so the plainest still comes back.
const mono = analyse(img(S, S, (x) => (x < 8 ? [0, 0, 0, 255] : [255, 255, 255, 255])), S, S);
console.assert(mono.colors.length > 0, "a black-and-white logo still offers a colour");

// Fully transparent: no colours, not dark, not a fill.
const empty = analyse(img(S, S, () => [0, 0, 0, 0]), S, S);
console.assert(!empty.fill && empty.colors.length === 0, "an empty image reads as nothing");
console.log("logoinfo.check ok");
