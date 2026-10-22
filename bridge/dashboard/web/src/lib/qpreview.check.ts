// Run: node bridge/dashboard/web/src/lib/qpreview.check.ts
import { optionKey, parsePreview, staged } from "./qpreview.ts";

const p = parsePreview("![In the box](/up/j/r-1-a1.png)\n![Sent](</up/j/r-2-a3.png>)\n\nthe chip sits in your words");
console.assert(p.shots.length === 2, `two shots: ${JSON.stringify(p.shots)}`);
console.assert(p.shots[0].path === "/up/j/r-1-a1.png" && p.shots[0].alt === "In the box", "first shot");
console.assert(p.shots[1].path === "/up/j/r-2-a3.png" && p.shots[1].alt === "Sent", "angle-bracket path");
console.assert(p.text === "the chip sits in your words", `text left: ${JSON.stringify(p.text)}`);

const ascii = parsePreview("┌──┐\n│A │\n└──┘\n![web](https://x/y.png)");
console.assert(ascii.shots.length === 0, "only absolute local paths are shots");
console.assert(ascii.text.startsWith("┌──┐"), "an ASCII mockup stays text");
console.assert(parsePreview(undefined).shots.length === 0 && parsePreview("").text === "", "empty");

const a = optionKey("A · TOKEN (Recommended)", 2);
console.assert(a.key === "A" && a.name === "TOKEN" && a.rec, `own letter wins: ${JSON.stringify(a)}`);
const b = optionKey("Use a header band", 1);
console.assert(b.key === "B" && b.name === "Use a header band" && !b.rec, `position: ${JSON.stringify(b)}`);
const c = optionKey("2) Rail", 0);
console.assert(c.key === "2" && c.name === "Rail", `numbered: ${JSON.stringify(c)}`);
console.assert(optionKey("A plugin's command", 0).name === "A plugin's command", "'A ' is a word, not a key");

const q = (multiSelect: boolean, preview?: string) =>
  ({ question: "?", header: "H", multiSelect, options: [{ label: "A" }, { label: "B", preview }] });
console.assert(staged(q(false, "![x](/a.png)")), "a preview stages it");
console.assert(!staged(q(true, "![x](/a.png)")), "multiSelect never stages (the CLI's rule)");
console.assert(!staged(q(false, "  ")) && !staged(q(false)), "no preview, no stage");

console.log("qpreview.check ok");
