// A hud-card field's declared type is a rendering contract: the flow says
// "checks", the model emits rows, the card draws a board. The model can miss —
// bridge/flow.py deliberately does NOT nudge for a wrong shape, because the work
// in that turn is still good. So every guard here answers "is this the shape it
// promised?" and a `null` means one thing: render it as text instead.
//
// Mirrors bridge/miniapp/web/src/lib/cardfields.ts. Keep them in sync.

export type Check = { cmd: string; ok: boolean; note?: string };
export type Finding = {
  file: string; line?: number; severity: "high" | "med" | "low"; note: string;
};
export type Command = { cmd: string; status?: "ok" | "fail" | "pending" };
export type Screen = { path: string; caption?: string };
export type FileRef = { path: string; add?: number; del?: number };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Every row of `v` mapped through `row`, or null if any row isn't the shape.
 *  All-or-nothing on purpose: half a board and half a paragraph reads as a bug. */
function rows<T>(v: unknown, row: (o: Record<string, unknown>) => T | null): T[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: T[] = [];
  for (const item of v) {
    const r = isObj(item) ? row(item) : null;
    if (!r) return null;
    out.push(r);
  }
  return out;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export const asChecks = (v: unknown): Check[] | null =>
  rows(v, (o) => (str(o.cmd) && typeof o.ok === "boolean"
    ? { cmd: str(o.cmd), ok: o.ok, note: str(o.note) || undefined } : null));

export const asFindings = (v: unknown): Finding[] | null =>
  rows(v, (o) => {
    const sev = str(o.severity).toLowerCase();
    if (!str(o.file)) return null;
    return {
      file: str(o.file),
      line: typeof o.line === "number" && o.line > 0 ? o.line : undefined,
      severity: sev === "high" || sev === "low" ? sev : "med",
      note: str(o.note),
    };
  });

export const asCommands = (v: unknown): Command[] | null =>
  rows(v, (o) => {
    const st = str(o.status).toLowerCase();
    if (!str(o.cmd)) return null;
    return {
      cmd: str(o.cmd),
      status: st === "ok" || st === "fail" || st === "pending" ? st : undefined,
    };
  });

export const asScreens = (v: unknown): Screen[] | null =>
  rows(v, (o) => (str(o.path)
    ? { path: str(o.path), caption: str(o.caption) || undefined } : null));

/** Paths, with the diffstat when the model bothered to count. A plain list of
 *  strings is the common case; objects are how a diffstat arrives. */
export const asFiles = (v: unknown): FileRef[] | null => {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: FileRef[] = [];
  for (const item of v) {
    if (typeof item === "string" && item.trim()) { out.push({ path: item.trim() }); continue; }
    if (isObj(item) && str(item.path)) {
      out.push({
        path: str(item.path),
        add: typeof item.add === "number" ? item.add : undefined,
        del: typeof item.del === "number" ? item.del : undefined,
      });
      continue;
    }
    return null;
  }
  return out;
};

/** 0-1, however the model wrote it: 0.8, "0.8", 80 (a percentage). */
export const asConfidence = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim().replace("%", "")) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return n > 1 ? (n <= 100 ? n / 100 : null) : n;
};

/** Any card value as one line — the text fallback, and what the handoff prompt
 *  and the bot's render_card both need. Mirrors flow._flat in Python. */
export function flatten(v: unknown): string {
  if (typeof v === "boolean") return v ? "✓" : "✗";
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v)) return v.map(flatten).join(", ");
  if (isObj(v)) {
    return Object.values(v)
      .filter((x) => x !== null && x !== undefined && x !== "")
      .map(flatten)
      .join(" ");
  }
  return String(v);
}

/** The first prompt of a handed-off session: a report card, restated as a brief.
 *  Composed here rather than server-side because the card is already in the
 *  client's hands, and the new session must open on a plain message like any
 *  other (bridge/flowtype.py classifies the first one — a preset stype skips it). */
export function handoffPrompt(
  card: { stage: string; summary: string; fields?: Record<string, unknown> },
  fromLabel: string,
): string {
  const lines = [`[from ${fromLabel} ${card.stage.toUpperCase()}] ${card.summary}`];
  for (const [name, value] of Object.entries(card.fields ?? {})) {
    lines.push(`${name.toUpperCase()}: ${flatten(value)}`);
  }
  return lines.join("\n");
}

/** What a triage sends back: the findings worth acting on, and the ones the
 *  reader threw out, so the next turn doesn't quietly resurrect them. */
export function triagePrompt(findings: Finding[], dropped: Set<number>): string {
  const at = (f: Finding) => `${f.file}${f.line ? `:${f.line}` : ""} — ${f.note}`;
  const keep = findings.filter((_, i) => !dropped.has(i));
  const drop = findings.filter((_, i) => dropped.has(i));
  const lines = [`Triage: keeping ${keep.length}, dropping ${drop.length}.`];
  if (keep.length) lines.push("KEEP:", ...keep.map((f) => `- ${at(f)}`));
  if (drop.length) lines.push("DROP (not real / not worth it):", ...drop.map((f) => `- ${at(f)}`));
  lines.push("Carry only the kept findings forward.");
  return lines.join("\n");
}
