export interface ModelOption {
  id: string; // full model id (e.g. "claude-opus-4-8"), or a short CLI alias
  label: string;
}

/** One entry in the AGENT picker: a Claude login, or a free-agent provider. */
export interface AgentOption {
  id: string; // 'claude:<slot>' | 'opencode:<provider>' — a turn's runtime tag
  short: string; // for the composer chip
  label: string; // for the dropdown row and the status bar
  free: boolean; // true = not Claude, so no subscription quota applies
  def: boolean; // the ambient ~/.claude login
  left: number | null; // % of this account's tighter usage window unspent
}

// Shown only until /local/state delivers the live list (Anthropic Models API,
// via bridge/models.py) — or if that API/token is unavailable and the backend
// serves its own fallback. This is a pre-load safety net, not the source.
const FALLBACK: ModelOption[] = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
  { id: "fable", label: "Fable" },
];

export function modelOptions(models?: ModelOption[]): ModelOption[] {
  return models && models.length ? models : FALLBACK;
}

/** "Claude Opus 4.8" -> "opus". Everything after the family word is version. */
function family(label: string): string {
  const words = label.replace(/claude/i, "").trim().split(/[\s-]+/);
  return (words[0] || label).toLowerCase();
}

/**
 * One entry per family — the newest, plus `keep` (the current selection) even
 * when it is an older release. Pickers show this by default; the SHOW ALL
 * switch in settings hands back the full list.
 *
 * ponytail: "newest" is the API's own ordering (/v1/models is newest-first),
 * not a version parse. Sort here if that ever stops holding.
 */
export function latestPerFamily(models: ModelOption[], keep?: string): ModelOption[] {
  const seen = new Set<string>();
  return models.filter((m) => {
    const f = family(m.label);
    if (m.id === keep) {
      seen.add(f);
      return true;
    }
    if (seen.has(f)) return false;
    seen.add(f);
    return true;
  });
}
