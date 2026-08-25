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

// --- the widget grammar ---------------------------------------------------
// One shape per kind of work. Same all-or-nothing rule as everything above: a
// half-drawn instrument reads as a bug, a paragraph reads as a sentence, so a
// row that isn't the promised shape drops the whole field back to text.

export type DiffFile = { file: string; add?: number; del?: number; hunk?: string };
export type Output = { cmd?: string; text: string; ok?: boolean };
export type MapNode = { id: string; label: string; state?: "ok" | "warn" | "bad" };
export type MapEdge = { from: string; to: string; label?: string };
export type Graph = { nodes: MapNode[]; edges: MapEdge[] };
export type Tone = "good" | "warn" | "bad" | "flat";
export type ChainStep = { label: string; body: string; meta?: string; tone: Tone };
export type Bar = { label: string; value: number };
export type Stat = { label: string; value: string };
export type Table = { cols: string[]; rows: string[][] };
export type Idea = { title: string; note?: string; picked: boolean };
export type Meter = { label: string; pct: number };
export type PlanOp = "add" | "change" | "drop";
export type PlanRow = { op: PlanOp; text: string };
export type Source = { title: string; url?: string; badge?: string; stale: boolean };
export type Claim = { text: string; cites: number[] };
export type Question = { topic: string; ask: string; options: string[]; answer?: string };

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** Unified-diff line → its colour. Headers (---/+++) would otherwise read as a
 *  whole-file add/delete, so they stay muted. Lives here rather than beside its
 *  first caller (CommitGraph) because a card's `diff` field draws the same lines
 *  and the Mini App has no commit graph to borrow it from. */
export function diffColor(l: string): string {
  if (l.startsWith("@@")) return "var(--acc)";
  if (/^(\+\+\+|---|diff |index |new file|deleted file|similarity|rename )/.test(l)) return "var(--txl)";
  if (l.startsWith("+")) return "var(--ok)";
  if (l.startsWith("-")) return "var(--err)";
  return "var(--txd)";
}

/** Files a turn edited, with the hunk when the model showed its work. The hunk
 *  is a plain unified fragment — CommitGraph already knows how to colour those. */
export const asDiff = (v: unknown): DiffFile[] | null =>
  rows(v, (o) => {
    const file = str(o.file) || str(o.path);
    if (!file) return null;
    return { file, add: num(o.add), del: num(o.del), hunk: str(o.hunk) || undefined };
  });

/** What a command printed. A bare string is the common case — the model has the
 *  output and nothing else to say about it. */
export const asOutput = (v: unknown): Output | null => {
  if (typeof v === "string") return v.trim() ? { text: v } : null;
  if (!isObj(v)) return null;
  const text = typeof v.text === "string" ? v.text : "";
  if (!text.trim()) return null;
  return {
    text,
    cmd: str(v.cmd) || undefined,
    ok: typeof v.ok === "boolean" ? v.ok : undefined,
  };
};

/** A topology or a pipeline: boxes and what connects them. Edges pointing at a
 *  node that was never declared are dropped rather than drawn into space. */
export const asGraph = (v: unknown): Graph | null => {
  if (!isObj(v)) return null;
  const nodes = rows(v.nodes, (o) => {
    const id = str(o.id) || str(o.label);
    if (!id) return null;
    const st = str(o.state).toLowerCase();
    return {
      id,
      label: str(o.label) || id,
      state: st === "ok" || st === "warn" || st === "bad" ? st : undefined,
    } as MapNode;
  });
  if (!nodes) return null;
  const seen = new Set(nodes.map((n) => n.id));
  const edges = (Array.isArray(v.edges) ? v.edges : [])
    .filter(isObj)
    .map((o) => ({ from: str(o.from), to: str(o.to), label: str(o.label) || undefined }))
    .filter((e) => seen.has(e.from) && seen.has(e.to));
  return { nodes, edges };
};

const tone = (v: unknown): Tone => {
  const t = str(v).toLowerCase();
  return t === "good" || t === "warn" || t === "bad" ? t : "flat";
};

/** How a fix was reached, in order: symptom, cause, fix, proof. The order IS the
 *  argument, which is why this is a list and not four fields. */
export const asChain = (v: unknown): ChainStep[] | null =>
  rows(v, (o) => {
    const label = str(o.label);
    if (!label) return null;
    return {
      label,
      body: str(o.body),
      meta: str(o.meta) || undefined,
      tone: tone(o.tone),
    };
  });

export const asChart = (v: unknown): Bar[] | null =>
  rows(v, (o) => {
    const n = num(o.value);
    return str(o.label) && n !== undefined ? { label: str(o.label), value: n } : null;
  });

/** Headline numbers. The value stays a string — "61.4M" and "$12.40" are the
 *  model's formatting, and re-deriving it here would only ever lose information. */
export const asStats = (v: unknown): Stat[] | null =>
  rows(v, (o) => {
    const value = str(o.value) || (num(o.value) !== undefined ? String(o.value) : "");
    return str(o.label) && value ? { label: str(o.label), value } : null;
  });

export const asTable = (v: unknown): Table | null => {
  if (!isObj(v) || !Array.isArray(v.cols) || !Array.isArray(v.rows)) return null;
  const cols = v.cols.map((c) => (typeof c === "string" ? c : String(c ?? "")));
  if (!cols.length || !v.rows.length) return null;
  const out: string[][] = [];
  for (const r of v.rows) {
    if (!Array.isArray(r)) return null;
    out.push(cols.map((_, i) => flatten(r[i] ?? "")));
  }
  return { cols, rows: out };
};

export const asIdeas = (v: unknown): Idea[] | null =>
  rows(v, (o) => (str(o.title)
    ? { title: str(o.title), note: str(o.note) || undefined, picked: o.picked === true }
    : null));

/** 0-100, however it arrived: 12, "12", "12%". */
export const asMeters = (v: unknown): Meter[] | null =>
  rows(v, (o) => {
    const raw = typeof o.pct === "string" ? Number(o.pct.replace("%", "")) : o.pct;
    const n = num(raw);
    if (!str(o.label) || n === undefined || n < 0) return null;
    return { label: str(o.label), pct: Math.min(100, n) };
  });

const OPS: Record<string, PlanOp> = {
  add: "add", "+": "add", create: "add", new: "add",
  change: "change", "~": "change", edit: "change", modify: "change",
  drop: "drop", "-": "drop", remove: "drop", delete: "drop",
};

/** What applying a plan would add, change and drop — the three verbs infra work
 *  actually has, so the sign carries the meaning without a legend. */
export const asPlan = (v: unknown): PlanRow[] | null =>
  rows(v, (o) => {
    const op = OPS[str(o.op).toLowerCase()];
    return op && str(o.text) ? { op, text: str(o.text) } : null;
  });

export const asSources = (v: unknown): Source[] | null =>
  rows(v, (o) => {
    const title = str(o.title) || str(o.url);
    if (!title) return null;
    return {
      title,
      url: str(o.url) || undefined,
      badge: str(o.badge) || undefined,
      stale: o.stale === true,
    };
  });

/** What the answer amounts to, each line carrying the sources it rests on. An
 *  uncited claim still draws — it just doesn't get to look sourced. */
export const asClaims = (v: unknown): Claim[] | null =>
  rows(v, (o) => {
    if (!str(o.text)) return null;
    const cites = (Array.isArray(o.cites) ? o.cites : [])
      .map((c) => (typeof c === "number" ? c : Number(c)))
      .filter((c) => Number.isInteger(c) && c > 0);
    return { text: str(o.text), cites };
  });

/** One question per concept — the shape a run pauses in when the brief is too
 *  thin to act on. An answered one keeps its answer so the card reads as a
 *  transcript rather than a form that forgot what you typed. */
export const asIntake = (v: unknown): Question[] | null =>
  rows(v, (o) => {
    const ask = str(o.ask) || str(o.question);
    if (!ask) return null;
    return {
      topic: str(o.topic) || str(o.name),
      ask,
      options: (Array.isArray(o.options) ? o.options : []).map(str).filter(Boolean),
      answer: str(o.answer) || undefined,
    };
  });

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
