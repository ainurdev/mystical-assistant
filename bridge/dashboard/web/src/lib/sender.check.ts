// Run: node bridge/dashboard/web/src/lib/sender.check.ts
// Who sent a turn's prompt: the turn's own sent_by first, the old text sniffing
// for turns from before it was recorded.
import { mysticalNote, viaTag } from "./sender.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const eq = (got: unknown, want: unknown, what: string) =>
  ok(JSON.stringify(got) === JSON.stringify(want), `${what} — got ${JSON.stringify(got)}`);

const MCP = "[mystical] MCP loaded: rivendell. Carry on with what you were doing; those tools are available now.";

// --- recorded ------------------------------------------------------------------
eq(mysticalNote({ prompt: MCP, sent_by: "mystical:mcp", sent_why: "you turned rivendell on" }),
  { kind: "mcp", label: "MCP loaded", line: "MCP loaded: rivendell. Carry on with what you were doing; those tools are available now.", why: "you turned rivendell on" },
  "a recorded sender wins, its [mystical] tag dropped from the line");
eq(mysticalNote({ prompt: "/mattpocock-skills:implement Work in /x on branch b, and commit there.", sent_by: "mystical:step", sent_why: "next is build-here" })?.label,
  "Next step", "a flow's next step");
eq(mysticalNote({ prompt: "x", sent_by: "mystical:brand-new" })?.label, "Mystical", "a kind this page doesn't know still reads as Mystical");
eq(mysticalNote({ prompt: "hi", sent_by: null }), null, "yours is no note");
eq(mysticalNote({ prompt: "hi", sent_by: "telegram" }), null, "Telegram is you");
eq(mysticalNote({ prompt: "No path for this message.\n\n[mystical] Your turn ended while a background command…", sent_by: "mystical:nudge" })?.line,
  "Your turn ended while a background command…", "the bridge's no-path order is not the line");

// --- sniffed (old turns) ---------------------------------------------------------
eq(mysticalNote({ prompt: MCP })?.kind, "mcp", "an old MCP-loaded note");
eq(mysticalNote({ prompt: "[mystical] Your turn ended without StepDone. Anything…" })?.kind, "nudge", "an old ticket nudge");
eq(mysticalNote({ prompt: "⧖ Checks finished: 127 passed\n\nYou were waiting to: report. Carry on." })?.line,
  "Checks finished: 127 passed", "an old wake-up, its hourglass dropped");
eq(mysticalNote({ prompt: "Mystical stopped what you were waiting on: nothing had finished after 10 min" })?.kind, "wait", "an old background wait that ran out");
eq(mysticalNote({ prompt: "[from the chat \"Council\"] look at #3" })?.kind, "chat", "an old note from another chat");
eq(mysticalNote({ prompt: "⏮ Your previous turn was cut off by an error. Continue." })?.kind, "resume", "an old resume");
eq(mysticalNote({ prompt: "⏮ The usage limit was reached and the work resumed on another account." }), null,
  "a limit carry-on keeps its own card");
eq(mysticalNote({ prompt: "[goal 2/5] Ship it\n…" }), null, "a goal keeps its stamp");
eq(mysticalNote({ prompt: "/mattpocock-skills:implement Work in /w/x on branch feat/y, and commit there." })?.kind, "step", "an old build-here step");
eq(mysticalNote({ prompt: "/compact Keep the decisions so far; the next step is build-here." })?.kind, "step", "an old compact before a step");
eq(mysticalNote({ prompt: "/mattpocock-skills:implement the login fix" }), null, "you running the skill yourself is you");

// --- via ---------------------------------------------------------------------------
eq(viaTag("telegram"), "via Telegram", "Telegram");
eq(viaTag("miniapp"), "via Mini App", "Mini App");
eq(viaTag(null), null, "the dashboard says nothing");
eq(viaTag("mystical:mcp"), null, "Mystical's notes aren't via anything");
