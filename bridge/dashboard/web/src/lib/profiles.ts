// A profile is a named, server-side bundle (bridge/profiles.py): which agent
// and account run a session, and with what model, mode, effort and tool
// switches. A session is bound to one rather than stamped from it, so an edit
// reaches every session using it, on every surface, from its next turn —
// except a knob set by hand in that session. It replaced a browser-only list
// (localStorage "hud-profiles") whose APPLY copied values once; importLegacy()
// moves those onto the bridge.

export interface Profile {
  id: string;
  name: string;
  agent: string; // "claude", or an ACP preset id ("codex"); fixed once created
  account: string; // Claude: a login slot as a string; an agent: its account id. "" = the default login
  model: string; // "" = not set, so the composer's pick applies
  mode: string; // permission mode; "" = not set
  effort: string; // "" = not set
  tools: string[] | null; // deny rules; null = the bridge's defaults
}

export interface ProfilesInfo {
  profiles: Profile[];
  project_defaults: Record<string, string>; // project rel -> the profile its new sessions get
}

/** POST /local/profiles: create, or update / delete by id. */
export type ProfileWrite = Partial<Profile> & { action: "create" | "update" | "delete" };

const NAME_MAX = 32; // bridge/profiles.py NAME_MAX

/** "A2 · FABLE-5-1 · ACCEPT EDITS · HIGH · 3 OFF" — what a session bound to it
 *  runs with. A knob the profile leaves unset is left out. Another agent leads
 *  with "◇ CODEX" (its account ids mean nothing on a row). */
export function describe(p: Profile): string {
  const bits = [p.agent !== "claude" ? `◇ ${p.agent}` : p.account && `A${p.account}`, p.model.replace(/^claude-/, ""),
    p.mode.replace(/([a-z])([A-Z])/g, "$1 $2"), p.effort, p.tools && `${p.tools.length} off`];
  return (bits.filter(Boolean).join(" · ") || "defaults").toUpperCase();
}

const LEGACY = "hud-profiles";
let imported = false; // StrictMode runs a mount effect twice in dev: import once

/** Move the browser-only profiles onto the bridge, once: `write` (the POST)
 *  each, then forget them. Best-effort and silent — one the bridge refuses (a
 *  login since removed, say) is dropped. Resolves whether any landed, so the
 *  caller knows to reload the list. */
export async function importLegacy(
  existing: Profile[], write: (body: ProfileWrite) => Promise<unknown>,
): Promise<boolean> {
  if (imported) return false;
  imported = true;
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(LEGACY) || "null");
  } catch {
    return false;
  }
  if (!Array.isArray(raw)) return false;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const taken = new Set(existing.map((p) => p.name));
  const settled = await Promise.allSettled(
    raw.filter((p) => p && typeof p === "object" && str(p.name).trim()).map((p) => {
      const name = str(p.name).trim().slice(0, NAME_MAX);
      return write({
        action: "create",
        // Names are unique on the bridge: a clash keeps both, the import marked.
        name: taken.has(name) ? `${name.slice(0, NAME_MAX - 6)} (old)` : name,
        agent: "claude",
        account: /^claude:(\d+)$/.exec(str(p.agent))?.[1] ?? "",
        model: str(p.model),
        mode: str(p.perm),
        effort: str(p.effort),
        tools: Array.isArray(p.disabledTools)
          ? p.disabledTools.filter((t: unknown): t is string => typeof t === "string") : null,
      });
    }),
  );
  try {
    localStorage.removeItem(LEGACY);
  } catch { /* private mode: it just stays behind, unread */ }
  return settled.some((r) => r.status === "fulfilled");
}
