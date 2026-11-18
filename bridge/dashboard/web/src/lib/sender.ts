/** Who sent a turn's prompt when you didn't type it. The bridge records it on
 *  the turn (store turns.sent_by: 'telegram', 'miniapp', 'mystical:<kind>', with
 *  the sender's why); a turn from before that is recognised by its words, the
 *  way the dashboard always had to. Mystical's own prompts draw as a one-line
 *  note on the spine (PromptBubble's MysticalNote, SIGIL), never as yours.
 *  Goals, the council, limit carry-ons and the restart seam keep their own
 *  stamps, so they are no note here. */
import { limitNudge } from "./limit.ts";

const LABELS: Record<string, string> = {
  mcp: "MCP loaded", nudge: "Nudge", wait: "Wait over", resume: "Resumed", automation: "Automation",
  chat: "From a chat", step: "Next step", device: "Device run", ticket: "Ticket", work: "Work list",
  job: "Rivendell", api: "Run API",
};

/** line: the prompt's first line, its bridge tag dropped. */
export interface MysticalNote { kind: string; label: string; line: string; why: string | null }

// shortcut: the sniffing only knows the notes the bridge sent before turns recorded a
// sender (2026-11-18); drop it once no session that old is opened.
function sniff(p: string): string | null {
  if (p.startsWith("[mystical] MCP loaded")) return "mcp";
  if (p.startsWith("[mystical] ")) return "nudge";
  if (p.startsWith("⧖ ") || p.startsWith("Mystical stopped what you were waiting on")) return "wait";
  if (p.startsWith("[from the chat \"")) return "chat";
  if (p.startsWith("⏮ ") && !limitNudge(p)) return "resume";
  // bridge/paths.py's next step: build-here's order, and the compact before a step
  if (/^\/mattpocock-skills:implement Work in .* on branch .*, and commit there\.$/.test(p)
    || /^\/compact Keep the decisions so far; the next step is [\w-]+\.$/.test(p)) return "step";
  return null;
}

/** The note a turn's prompt draws as, or null when the words are yours (or keep a stamp of their own). */
export function mysticalNote(t: { prompt: string; sent_by?: string | null; sent_why?: string | null }): MysticalNote | null {
  const p = t.prompt.replace(/^No path for this message\.\s*/, "");
  const kind = t.sent_by ? (t.sent_by.startsWith("mystical:") ? t.sent_by.slice(9) : null) : sniff(p);
  if (!kind) return null;
  const line = p.replace(/^(\[mystical\]|⧖|⏮)\s+/, "").split("\n")[0];
  return { kind, label: LABELS[kind] ?? "Mystical", line, why: t.sent_why || null };
}

/** The tag a prompt you sent from elsewhere wears beside You. */
export const viaTag = (sentBy: string | null | undefined): string | null =>
  sentBy === "telegram" ? "via Telegram" : sentBy === "miniapp" ? "via Mini App" : sentBy === "browser" ? "via Mystical browser" : null;
