// A profile is a named snapshot of how a run is configured: the composer's run
// knobs (which live in HudSettings) plus the tools and MCP servers a session has
// switched off (which live on the session row). Applying one writes both.
//
// Kept in localStorage next to the settings it snapshots — a profile is a
// preference, not state the bridge needs to know about.

export interface Profile {
  id: string;
  name: string;
  model: string;
  effort: string;
  perm: string;
  ponytail: string;
  agent: string;
  disabledTools: string[];
}

const KEY = "hud-profiles";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function loadProfiles(): Profile[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((p) => p && typeof p === "object" && str(p.id) && str(p.name))
      .map((p): Profile => ({
        id: str(p.id),
        name: str(p.name),
        model: str(p.model),
        effort: str(p.effort),
        perm: str(p.perm),
        ponytail: str(p.ponytail),
        agent: str(p.agent),
        disabledTools: Array.isArray(p.disabledTools) ? p.disabledTools.filter((t: unknown) => typeof t === "string") : [],
      }));
  } catch {
    return [];
  }
}

export function saveProfiles(profiles: Profile[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(profiles));
  } catch { /* quota / private mode — profiles just don't persist */ }
}

/** "OPUS · PLAN · HIGH · 3 OFF" — the one line that says what applying it does. */
export function describe(p: Profile): string {
  const bits = [p.model || "default", p.perm || "session", p.effort || "auto"];
  if (p.ponytail) bits.push(`ponytail ${p.ponytail}`);
  if (p.agent) bits.push(p.agent);
  if (p.disabledTools.length) bits.push(`${p.disabledTools.length} off`);
  return bits.join(" · ").toUpperCase();
}
