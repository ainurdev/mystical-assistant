// Reading a framed message. The bridge delivers channel messages as prompts or
// steers beginning with ⇄ (bridge/channel.py _frame, _brief_prompt), so what looks
// like something you typed may be another agent talking. These strings are that
// module's own wording: a frame it stops writing falls through to the generic note.
// Pure.

export const FRAME = "⇄";

export type Framed = {
  /** Your own words sent through the channel: draw them as yours. */
  own: boolean;
  /** Who it came from, as the channel names them. */
  from: string;
  /** What kind of message this is, for the note's label. */
  label: string;
  body: string;
};

export function parseFrame(text: string | null | undefined): Framed | null {
  if (!text || !text.startsWith(FRAME)) return null;
  const rest = text.slice(FRAME.length).trimStart();

  const own = rest.match(/^From the user, sent to you directly:\s*([\s\S]*)$/);
  if (own) return { own: true, from: "you", label: "YOU", body: own[1].trim() };

  const said = rest.match(/^(.+?) (says|reports back)\.[^\n]*\n\n([\s\S]*)$/);
  if (said) {
    return { own: false, from: said[1], label: said[2] === "says" ? "MESSAGE" : "REPORT", body: said[3].trim() };
  }

  const brief = rest.match(/^You were started as a helper[\s\S]*?\n\nYour brief:\n([\s\S]*)$/);
  if (brief) return { own: false, from: "main", label: "BRIEF", body: brief[1].trim() };

  if (/^(This chat was running on|You are back in this chat)/.test(rest)) {
    return { own: false, from: "Mystical", label: "HANDED OVER", body: rest.split("\n\n")[0].trim() };
  }
  return { own: false, from: "another agent", label: "MESSAGE", body: rest.trim() };
}
