// node --experimental-strip-types src/lib/panzoom.check.ts
import assert from "node:assert/strict";
import { clampView, fitView, MAX_K, startView, zoomAt } from "./panzoom.ts";

// Zooming keeps the point under the pointer where it was.
const v = { k: 1, x: 10, y: 20 };
const z = zoomAt(v, 2, 110, 70);
assert.deepEqual([(110 - z.x) / z.k, (70 - z.y) / z.k], [(110 - v.x) / v.k, (70 - v.y) / v.k]);

// Never past MAX_K, never smaller than the whole drawing fits (or a fifth), and some of it stays on screen.
assert.equal(clampView({ k: 99, x: 0, y: 0 }, 1000, 500, 400, 300).k, MAX_K);
assert.equal(clampView({ k: 0.001, x: 0, y: 0 }, 1000, 500, 400, 300).k, 0.2);
const far = clampView({ k: 1, x: -99999, y: 99999 }, 1000, 500, 400, 300);
assert.ok(far.x + 1000 >= 60 && far.y <= 300 - 60, JSON.stringify(far));

// Fit shows all of it, centred, and doesn't blow a small drawing up.
const f = fitView(2000, 500, 500, 400);
assert.equal(f.k, 0.25);
assert.equal(f.y, (400 - 500 * 0.25) / 2);
assert.equal(fitView(100, 50, 500, 400).k, 1);

// In a chat it opens as it always did: full size when it fits, down to 0.8 when it doesn't.
assert.equal(startView(300, 200, 600, 200, false).k, 1);
assert.equal(startView(300, 200, 600, 200, false).x, 150);
assert.equal(startView(2000, 400, 600, 300, false).k, 0.8);
assert.equal(startView(2000, 400, 600, 300, true).k, 0.3);
console.log("panzoom ok");
