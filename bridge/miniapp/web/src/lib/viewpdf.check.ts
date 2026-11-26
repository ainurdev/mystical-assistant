// node --experimental-strip-types src/lib/viewpdf.check.ts [out.pdf]  (writes the PDF for a reader to open)
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { pdfFromJpeg } from "./viewpdf.ts";

// A 1×1 JPEG is enough to check the frame around it.
const jpg = Uint8Array.from(atob("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA="), (c) => c.charCodeAt(0));
const pdf = pdfFromJpeg(jpg, 800, 400, "Café · 流れ (draft)");
const text = new TextDecoder("latin1").decode(pdf);
assert.ok(text.startsWith("%PDF-1.4"));
assert.ok(text.trimEnd().endsWith("%%EOF"));
// Every offset in the index lands on the object it names, and startxref on the index.
const xref = +/startxref\n(\d+)/.exec(text)![1];
assert.equal(text.slice(xref, xref + 4), "xref");
const rows = text.slice(xref).split("\n").slice(3, 9);
rows.forEach((r, i) => assert.equal(text.slice(+r.slice(0, 10), +r.slice(0, 10) + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`));
// A page the picture's size at 96 dpi, drawn at 2x: 800×400 px is 300×150 pt.
assert.match(text, /\/MediaBox \[0 0 300 150\]/);
// A title in any script, as UTF-16.
assert.match(text, /\/Title <FEFF00430061006600E9/);
if (process.argv[2]) writeFileSync(process.argv[2], pdf);
console.log("viewpdf ok");
