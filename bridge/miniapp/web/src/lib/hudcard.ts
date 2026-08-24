// A typed session's reply ends in a fenced hud-card block. The server parses it
// into a `card` event, which is what the transcript renders — so the raw fence
// is stripped from the prose above it rather than shown twice.
const HUD_CARD_RE = /```hud-card\s*\n[\s\S]*?```\s*$/;

export function stripHudCard(text: string): string {
  return text.replace(HUD_CARD_RE, "").trimEnd();
}
