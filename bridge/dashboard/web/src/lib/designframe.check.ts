// node --experimental-strip-types src/lib/designframe.check.ts
import assert from "node:assert/strict";
import { commentsMessage, frameDoc, remixMessage, type DesignBoard, type DesignComment } from "./designframe.ts";

const doc = frameDoc("<!doctype html><html><head><title>x</title></head><body><h1>Hi</h1></body></html>");
assert.ok(doc.indexOf("Content-Security-Policy") < doc.indexOf("<title>"), "the CSP comes before anything it governs");
assert.ok(doc.indexOf("__mysticalFrame") > doc.indexOf("<h1>"));
assert.match(doc, /default-src 'none'/);
assert.match(frameDoc("<h1>bare</h1>"), /^<!doctype html><html><head><meta[^>]+Content-Security-Policy/);
assert.match(frameDoc("<html><body>x</body></html>"), /<html><head><meta/);
assert.doesNotMatch(frameDoc('<head><meta http-equiv="refresh" content="0;url=https://x.io"></head>'), /refresh/);
assert.doesNotMatch(frameDoc("<head><META HTTP-EQUIV=refresh content='0'></head>"), /refresh/i);

const board: DesignBoard = { id: "b", title: "Home", updated: 0, pages: [{ name: "A", file: ".mystical/design/b/a.html" }, { name: "B", file: "b.html" }] };
const c = (over: Partial<DesignComment>): DesignComment => ({ id: "1", kind: "comment", page: "A", text: "too heavy", x: 10, y: 20, status: "open", ...over });
const msg = commentsMessage(board, [
  c({ about: 'h1 "Welcome"', selector: "main > h1", styles: { fontSize: "48px" } }),
  c({ id: "2", kind: "draw", text: "", about: "div" }),
  c({ id: "3", kind: "tweak", text: "", about: "p", changes: [{ prop: "font-size", from: "16px", to: "18px" }] }),
  c({ id: "4", status: "sent", text: "old news" }),
  c({ id: "5", page: "B", text: "and here" }),
], "Focus on the header");
assert.match(msg, /Focus on the header/);
assert.match(msg, /On h1 "Welcome" \[main > h1\] \(now fontSize 48px\): too heavy/);
assert.match(msg, /I drew around div \(no comment/);
assert.match(msg, /Apply these exact values to p: font-size: 16px → 18px/);
assert.doesNotMatch(msg, /old news/);
assert.match(msg, /Page "B" \(b\.html\):\n1\. On at 10,20: and here/);
assert.match(remixMessage(board, { Layout: "A", Colour: "B" }, "keep it calm"), /- Layout from "A"\n- Colour from "B"\nkeep it calm/);
console.log("designframe ok");
