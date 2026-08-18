import type { UsageInfo } from "./api";

export interface ModelOption {
  id: string; // full model id (e.g. "claude-opus-4-8"), or a short CLI alias
  label: string;
}

/** A composer-picker row: the model plus how much of it is left to spend. */
export interface ModelRow extends ModelOption {
  group?: string;   // heading of the usage pool it draws from; unset when usage is unknown
  left?: number;    // % unspent of its tightest window (min across pools)
  severity?: string; // that window's severity: normal | warning | critical | exceeded
  title?: string;   // every window that applies, for the row's tooltip
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

/** "2026-08-19T12:00:00+00:00" -> "Tue 15:30" in the viewer's clock. */
function resetAt(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime())
    ? ` (resets ${d.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })})`
    : "";
}

interface Window { tag: string; name: string; left: number; severity: string; resets: string }

/**
 * Picker rows with the "Claude " prefix dropped and, when the usage meter is
 * readable, sorted into the pool each model draws from: everything shares
 * the 5-hour session and the all-models week; a model with its own weekly
 * cap (a `weekly_scoped` limit — Fable here, Sonnet/Opus on other plans)
 * also gets that, and forms its own group. A row's `left` is the tightest
 * of its windows — the same "headroom" rule the account fallback uses.
 */
export function modelRows(models: ModelOption[], usage?: UsageInfo | null): ModelRow[] {
  const short = models.map((m) => ({ id: m.id, label: m.label.replace(/^Claude /, "") }));
  if (!usage?.available) return short;
  const win = (tag: string, name: string, b: { percent: number; severity: string; resets_at: string | null }): Window =>
    ({ tag, name, left: Math.max(0, 100 - Math.round(b.percent)), severity: b.severity, resets: resetAt(b.resets_at) });
  const shared: Window[] = [];
  if (usage.five_hour) shared.push(win("5H", "5h session", usage.five_hour));
  if (usage.seven_day) shared.push(win("WK", "week, all models", usage.seven_day));
  const scoped = (usage.limits ?? []).filter((l) => l.scope?.model && typeof l.percent === "number");
  const heading = (name: string, ws: Window[]) =>
    ws.length ? `${name} · ${ws.map((w) => `${w.tag} ${w.left}%`).join(" · ")} LEFT` : name;
  const ALL = heading("ALL MODELS", shared);

  const rows = short.map((m, i) => {
    const own = scoped.filter((l) => l.scope!.model!.id === models[i].id
      || (l.scope!.model!.display_name ?? "").toLowerCase() === family(models[i].label));
    // ponytail: every scoped limit seen so far is weekly ("WK"); split on kind if a session-scoped one ever appears
    const ownWins = own.map((l) => win("WK", `week, ${l.scope!.model!.display_name ?? "this model"} only`, l));
    const wins = [...shared, ...ownWins];
    const tight = wins.reduce<Window | null>((a, w) => (a === null || w.left < a.left ? w : a), null);
    return {
      ...m,
      group: own.length ? heading(`${(own[0].scope!.model!.display_name ?? family(models[i].label)).toUpperCase()} ONLY`, ownWins) : ALL,
      left: tight?.left,
      severity: tight?.severity,
      title: tight ? `${tight.left}% left — tightest of: ${wins.map((w) => `${w.name} ${w.left}%${w.resets}`).join(" · ")}` : undefined,
    };
  });
  // Pools are contiguous, the shared one first; JS sort is stable, so the
  // API's newest-first order survives inside each pool.
  const order = [ALL, ...new Set(rows.map((r) => r.group))];
  return rows.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
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
