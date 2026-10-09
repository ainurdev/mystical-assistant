import type { AccountInfo, UsageBucket, UsageInfo } from "./api";

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

/** bridge accounts.DEFAULT_SLOT: the ambient ~/.claude login. */
export const DEFAULT_SLOT = 1;

/** The Claude login an agent and account run on: the account's slot, or the
 *  default login when it names none (bridge profiles.claude_slot). null for
 *  another agent, which spends no Claude quota. */
export function loginSlot(agent = "claude", account = ""): number | null {
  if (agent !== "claude") return null;
  return /^\d+$/.test(account) ? Number(account) : DEFAULT_SLOT;
}

/** The login the open session spends: the bridge's `slot`, which follows a
 *  turn the fallback ladder moved to another account. A bridge older than that
 *  field gives only the profile's login. No session open: the default login. */
export function spendingSlot(s?: { slot?: number | null; agent?: string; account?: string } | null): number | null {
  if (!s) return DEFAULT_SLOT;
  return s.slot !== undefined ? s.slot : loginSlot(s.agent, s.account);
}

/** One login's meter as the usage payload the footer and modelRows read. */
export function loginUsage(a: AccountInfo): UsageInfo {
  return { available: !!(a.five_hour || a.seven_day), five_hour: a.five_hour, seven_day: a.seven_day,
           limits: a.limits };
}

/** What a login has left, for a picker row: the tighter window's unspent share
 *  (bridge accounts.headroom) with that window's severity. null when the meter
 *  doesn't read or the login is switched off. */
export function loginLeft(a?: AccountInfo | null): { left: number; severity?: string } | null {
  if (!a || a.disabled || a.left === null) return null;
  const tight = [a.five_hour, a.seven_day].reduce<UsageBucket | null>(
    (t, b) => (b && (t === null || b.percent > t.percent) ? b : t), null);
  return { left: a.left, severity: tight?.severity };
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

/** "claude-fable-5-1" -> "fable": the first id segment after `claude-`, so a
 *  full id and its CLI alias share a family. By id, not label — family() below
 *  reads labels, which differ between the server's alias fallback ("Fable")
 *  and the live list ("Claude Fable 5.1"). */
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
 * The model, mode and effort the composer shows for a session. Bound to a
 * profile `p`: per knob, one set by hand in the session (its `overrides`), else
 * the profile's, else this device's pick for a knob the profile leaves unset
 * (read off the profile itself: the brief's mode is never blank, the bridge
 * fills its default in). Bound but `p` not loaded: the brief's own values —
 * they're the effective ones, where this device's would be pinned as
 * overrides by the next send. Unbound: one that has run from a composer has a
 * model and carries its picks, no effort being Auto; one that hasn't (fresh,
 * or started by the bot or VS Code) starts from this device's — or a new
 * session would quietly show the bridge's new-session mode over the one you
 * keep picking. A device mode of "" (the retired "Session" option) defers to
 * the session's own. A brief with no effort field (an older bridge) keeps
 * this device's effort.
 */
export function runPicks(
  s: { model?: string | null; permission_mode?: string | null; effort?: string | null; overrides?: string[];
       profile_id?: string | null },
  device: { model: string; perm: string; effort: string },
  p?: { model: string; mode: string; effort: string } | null,
): { model: string; perm: string; effort: string } {
  if (p) {
    const own = (k: string) => !!s.overrides?.includes(k);
    return {
      model: (own("model") && s.model) || p.model || device.model,
      perm: (own("permission_mode") && s.permission_mode) || p.mode || device.perm || s.permission_mode || "",
      effort: (own("effort") && s.effort) || p.effort || device.effort,
    };
  }
  if (s.profile_id)
    return { model: s.model || device.model, perm: s.permission_mode || device.perm || "", effort: s.effort || "" };
  return s.model
    ? { model: s.model, perm: s.permission_mode || device.perm,
        effort: s.effort === undefined ? device.effort : s.effort || "" }
    : { model: device.model, perm: device.perm || s.permission_mode || "", effort: s.effort || device.effort };
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
