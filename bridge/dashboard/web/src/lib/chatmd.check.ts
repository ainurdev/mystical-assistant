// Run: node bridge/dashboard/web/src/lib/chatmd.check.ts
import { chatToMarkdown } from "./chatmd.ts";
import type { Turn } from "../chat.ts";

function turn(prompt: string, events: Turn["events"]): Turn {
  return { id: "t", prompt, events, status: "done", pending: [] };
}

const md = chatToMarkdown([
  turn("fix the parser", [
    { type: "tool", name: "Read", id: "1", summary: "a.ts" },
    { type: "tool", name: "Read", id: "2", summary: "b.ts" },
    { type: "tool", name: "Edit", id: "3", summary: "a.ts" },
    { type: "text", text: "Found it — the lexer ate the newline." },
    { type: "result", result: "Fixed in a.ts.", cost: 0.01, elapsed: 900 },
  ]),
], "session one");

// The prompt heads the section, prose survives, tools collapse to one trace line.
console.assert(md.startsWith("# session one\n"), "title missing");
console.assert(md.includes("## fix the parser"), "prompt not a heading");
console.assert(md.includes("_used Read ×2 · Edit_"), `tool trace wrong:\n${md}`);
console.assert(md.includes("Found it — the lexer ate the newline."), "text dropped");
console.assert(md.includes("Fixed in a.ts."), "result dropped");
// No triple newlines, and it ends with exactly one.
console.assert(!/\n{3}/.test(md), "blank line run");
console.assert(md.endsWith("\n") && !md.endsWith("\n\n"), "trailing newlines");

// An empty session is empty, not "undefined".
console.assert(chatToMarkdown([]).trim() === "", "empty session should be empty");

console.log("chatmd ok");
