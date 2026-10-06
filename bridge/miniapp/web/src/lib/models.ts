export interface ModelOption {
  id: string; // full model id (e.g. "claude-opus-4-8"), or a short CLI alias
  label: string;
}

// Shown only until /api/state delivers the live list (Anthropic Models API, via
// bridge/models.py) — or if that API/token is unavailable and the backend serves
// its own fallback. This is a pre-load safety net, not the source of truth.
const FALLBACK: ModelOption[] = [
  { id: "opus", label: "Opus 4.8" },
  { id: "sonnet", label: "Sonnet 4.6" },
  { id: "haiku", label: "Haiku 4.5" },
  { id: "fable", label: "Fable 5" },
];

export function modelOptions(models?: ModelOption[]): ModelOption[] {
  return models && models.length ? models : FALLBACK;
}

/** "claude-fable-5-1" -> "fable": the first id segment after `claude-`, so a
 *  full id and its CLI alias share a family. By id, not label: the server's
 *  alias fallback says "Fable", the live list "Claude Fable 5.1". */
export function familyOf(id: string): string {
  return id.replace(/^claude-/, "").split("-")[0];
}

/**
 * The model to show when `pick` isn't one the server offers, or null to leave it
 * be. Nothing snaps until the server's own list is in: snapping against the
 * pre-load FALLBACK is what turned every stored full id into Opus on reload. A
 * pick then keeps its family — the alias list a cold Models API cache serves and
 * the full-id list once it warms name the same models — and only a family the
 * server doesn't offer falls to Opus, then to the first model.
 */
export function snapModel(pick: string, list?: ModelOption[]): string | null {
  if (!list?.length || list.some((m) => m.id === pick)) return null;
  const of = (f: string) => list.find((m) => familyOf(m.id) === f);
  return (of(familyOf(pick)) ?? of("opus") ?? list[0]).id;
}

/**
 * The model + mode the composer shows for a session. One that has run from a
 * composer has a model and carries both picks; one that hasn't (fresh, or
 * started by the bot or VS Code) starts from this phone's — or a new session
 * would quietly show the bridge's new-session mode over the one you keep
 * picking. A phone mode of "" (the retired "Session default") defers to the
 * session's own.
 */
export function runPicks(
  s: { model?: string | null; permission_mode?: string | null },
  device: { model: string; perm: string },
): { model: string; perm: string } {
  return s.model
    ? { model: s.model, perm: s.permission_mode || device.perm }
    : { model: device.model, perm: device.perm || s.permission_mode || "" };
}
