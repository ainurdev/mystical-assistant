// A Rivendell job's answer read as the thing it is, for components/JobViews.
// Each parser follows its kind's template on Rivendell (main f4a3b169) and
// gives null when the answer doesn't fit, so the box falls back to markdown:
// review and implement have no contract at all (a custom prompt can change
// them), the rest have one the model can still miss. The prompt is Rivendell's
// own text for the job (turn 1), read for what the answer leaves out: a
// summary's period, a video's length and screens, a question, the brief's
// other side.

/** The first `{` to the last `}` of an answer, as rivendell_jobs.headline reads one. */
function jsonOf(text: string): Record<string, unknown> | null {
  const raw = text ?? "";
  const i = raw.indexOf("{"), j = raw.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  try {
    const v = JSON.parse(raw.slice(i, j + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch { return null; }
}
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strs = (v: unknown): string[] => list(v).map(str).filter(Boolean);
const bullet = /^\s*[-*•]\s+(?:\[[ xX]\]\s+)?/;

/** "1:02:03" / "4:05" -> milliseconds; NaN when it isn't a clock. */
export function clockMs(t: string): number {
  const p = t.trim().split(":").map(Number);
  if (p.length < 2 || p.length > 3 || p.some((n) => !Number.isFinite(n))) return NaN;
  return p.reduce((a, n) => a * 60 + n, 0) * 1000;
}
/** 755000 -> "12:35", 3725000 -> "1:02:05". */
export function clockOf(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

/** A markdown text cut at its `## ` headings: what came before the first is the "" part. */
export function partsOf(md: string): { title: string; body: string }[] {
  const out: { title: string; body: string[] }[] = [{ title: "", body: [] }];
  for (const line of md.split("\n")) {
    const h = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) out.push({ title: h[1].trim(), body: [] });
    else out[out.length - 1].body.push(line);
  }
  return out.map((p) => ({ title: p.title, body: p.body.join("\n").trim() })).filter((p) => p.title || p.body);
}
const bulletsOf = (md: string): string[] =>
  md.split("\n").filter((l) => bullet.test(l)).map((l) => l.replace(bullet, "").trim()).filter(Boolean);

// ── MEETING BRIEF ─────────────────────────────────────────────────────────────
export type BriefKind = "done" | "progress" | "next" | "ask";
export interface BriefItem { text: string; who: string | null; refs: string[] }
export interface Brief { lead: string; sections: { kind: BriefKind; items: BriefItem[] }[]; projects: { name: string; items: BriefItem[] }[] }
const BRIEF_KINDS: BriefKind[] = ["done", "progress", "next", "ask"];

/** `{lead, sections[{kind, items}], projects[{name, items}]}` (brief-result.ts). A
 *  section of a kind Rivendell would refuse is dropped here, not the brief. */
export function parseBrief(text: string): Brief | null {
  const b = jsonOf(text);
  const lead = str(b?.lead);
  if (!b || !lead) return null;
  const items = (v: unknown): BriefItem[] => list(v).flatMap((it) => {
    const o = (it ?? {}) as Record<string, unknown>;
    const t = str(o.text), who = str(o.who);
    return t ? [{ text: t, who: who && !/^(null|none)$/i.test(who) ? who : null, refs: strs(o.refs).map((r) => r.replace(/^\[|\]$/g, "")) }] : [];
  });
  const sections = list(b.sections).flatMap((s) => {
    const o = (s ?? {}) as Record<string, unknown>;
    const kind = o.kind as BriefKind;
    return BRIEF_KINDS.includes(kind) ? [{ kind, items: items(o.items) }] : [];
  }).filter((s) => s.items.length).sort((x, y) => BRIEF_KINDS.indexOf(x.kind) - BRIEF_KINDS.indexOf(y.kind));
  const projects = list(b.projects).map((p) => {
    const o = (p ?? {}) as Record<string, unknown>;
    return { name: str(o.name), items: items(o.items) };
  }).filter((p) => p.name && p.items.length);
  return { lead, sections, projects };
}

/** Whom the ASK section is for: the client named in the prompt, else "them". */
export function otherSide(prompt: string): string {
  const m = /questions and decisions for (.+?), each one/.exec(prompt ?? "");
  return m && !/^the others/i.test(m[1]) ? m[1] : "them";
}

// ── PROJECT SUMMARY ───────────────────────────────────────────────────────────
export interface Summary { forward: string[]; attention: string[]; period: { label: string; from: string; to: string } | null }
// shortcut: the template puts progress first and trouble after but marks neither, so the split
// falls at the first bullet with trouble words and no done words; a list it misreads stays one list.
const TROUBLE = /\b(fail\w*|errors?|late|overdue|block\w*|waiting|stuck|down|broke\w*|crash\w*|risks?|regress\w*|missed|unpaid)\b/i;
const DONE = /\b(fixed|resolved|merged|shipped|released|closed|finished|completed|landed|recovered)\b/i;

/** 3–6 markdown bullets and nothing else (project-summary-prompt.template.ts). */
export function parseSummary(text: string, prompt = ""): Summary | null {
  const lines = (text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const bullets = lines.filter((l) => bullet.test(l)).map((l) => l.replace(bullet, "").trim());
  if (!bullets.length || bullets.length !== lines.length) return null;
  const k = bullets.findIndex((b) => TROUBLE.test(b) && !DONE.test(b));
  const at = k < 0 ? bullets.length : k;
  const m = /The period is (.+?): (.+?) to (.+?) \(/.exec(prompt ?? "");
  return { forward: bullets.slice(0, at), attention: bullets.slice(at), period: m ? { label: m[1], from: m[2], to: m[3] } : null };
}

// ── MEETING NOTES ─────────────────────────────────────────────────────────────
export interface Notes {
  summary: string;
  topics: { title: string; body: string }[];
  decisions: string[];
  actions: { title: string; description: string; owner: string }[];
}

/** `{notes: "## Summary … ## <topic> … ## Decisions", actionItems[…]}` (meeting-notes-prompt.template.ts). */
export function parseNotes(text: string): Notes | null {
  const n = jsonOf(text);
  const md = str(n?.notes);
  if (!n || !md) return null;
  const parts = partsOf(md);
  const sum = parts.find((p) => /^summary$/i.test(p.title)) ?? parts.find((p) => !p.title);
  const dec = parts.find((p) => /^decisions?$/i.test(p.title));
  const actions = list(n.actionItems).flatMap((a) => {
    const o = (a ?? {}) as Record<string, unknown>;
    const title = str(o.title);
    return title ? [{ title, description: str(o.description), owner: str(o.ownerName) }] : [];
  });
  return {
    summary: sum?.body ?? "",
    topics: parts.filter((p) => p.title && p !== sum && p !== dec),
    decisions: dec ? bulletsOf(dec.body) : [],
    actions,
  };
}

// ── VIDEO ─────────────────────────────────────────────────────────────────────
export interface Video {
  summary: string;
  chapters: { ms: number; title: string }[];
  keyPoints: string[];
  screens: { index: number; caption: string; ms?: number; path?: string }[];
  /** The recording's length, from the prompt; 0 when it doesn't say. */
  length: number;
}
/** "File: Contract.mov (13:40)." — both video templates open with it. Rivendell often
 *  says "(length unknown)", so the transcript's last "m:ss  text" line stands in. */
export function fileOf(prompt: string): { name: string; length: number } | null {
  const m = /File: (.+?) \(([^)]*)\)\./.exec(prompt ?? "");
  if (!m) return null;
  const said = clockMs(m[2]);
  const stamps = [...(prompt ?? "").matchAll(/^(\d+:\d{2}(?::\d{2})?)  \S/gm)].map((s) => clockMs(s[1]));
  return { name: m[1], length: said || (stamps.length ? Math.max(...stamps) : 0) };
}

/** The TRANSCRIBE answer `{summary, chapters[{timeMs,title}], keyPoints, screens[{index,caption}]}`.
 *  The bridge's SCREENS list in the prompt ("1. 0:41 — /…/screens/1.jpg") gives each screen its moment and picture. */
export function parseVideo(text: string, prompt = ""): Video | null {
  const v = jsonOf(text);
  if (!v) return null;
  const chapters = list(v.chapters).flatMap((c) => {
    const o = (c ?? {}) as Record<string, unknown>;
    return typeof o.timeMs === "number" && Number.isFinite(o.timeMs) && str(o.title) ? [{ ms: o.timeMs, title: str(o.title) }] : [];
  }).sort((a, b) => a.ms - b.ms);
  const summary = str(v.summary);
  if (!summary && !chapters.length) return null;
  const listed = new Map<number, { ms: number; path: string }>();
  for (const m of (prompt ?? "").matchAll(/^(\d+)\. (\d+:\d{2}(?::\d{2})?) — (.+)$/gm)) listed.set(+m[1], { ms: clockMs(m[2]), path: m[3].trim() });
  const screens = list(v.screens).flatMap((s) => {
    const o = (s ?? {}) as Record<string, unknown>;
    if (typeof o.index !== "number" || !Number.isInteger(o.index)) return [];
    const at = listed.get(o.index);
    return [{ index: o.index, caption: str(o.caption), ms: at?.ms, path: at?.path }];
  });
  return { summary, chapters, keyPoints: strs(v.keyPoints), screens, length: fileOf(prompt)?.length ?? 0 };
}

/** The ASK step's question, between "Question:" and the template's last line. */
export function questionOf(prompt: string): string {
  return /\nQuestion:\n([\s\S]*?)\n\nAnswer in markdown\./.exec(prompt ?? "")?.[1].trim() ?? "";
}

/** An ASK answer's m:ss moments as `#t=` links, which Markdown draws as timecode
 *  chips; inline code and existing links are left as they are. */
export function withTimecodes(md: string): string {
  return (md ?? "").split(/(`[^`\n]*`|\[[^\]\n]*\]\([^)\n]*\))/).map((part, i) =>
    i % 2 ? part : part.replace(/(?<![\w:./])(\d{1,2}:\d{2}(?::\d{2})?)(?![\w:])/g, (t) => `[${t}](#t=${clockMs(t) / 1000})`)).join("");
}

// ── REVIEW ────────────────────────────────────────────────────────────────────
export type Tone = "ok" | "warn" | "err";
export interface Finding { n: number; title: string; refs: string[]; body: string; fix: string }
export interface Review {
  verdict: { text: string; tone: Tone } | null;
  intro: string;
  groups: { title: string; findings: Finding[]; body: string }[];
}

/** The review's verdict, only when it states one: "**Verdict: approve with changes.**". */
function verdictOf(text: string): { text: string; tone: Tone } | null {
  const v = text.trim().replace(/\.$/, "").toLowerCase();
  if (!v || v.length > 40) return null;
  const tone: Tone = /request|reject|block|do not merge|don't merge/.test(v) ? "err" : /with|minor|nits?|but|after/.test(v) ? "warn" : "ok";
  return { text: v, tone };
}

/** Free markdown (review-prompt.template.ts has no contract), read for the shape
 *  reviews here take: `## Section`, then `1. **Title.** \`file:line\`` with
 *  indented bullets and a `**Fix:**` one. No numbered finding, no view. */
export function parseReview(md: string): Review | null {
  const lines = (md ?? "").split("\n");
  let verdict: Review["verdict"] = null;
  const intro: string[] = [];
  const groups: { title: string; findings: Finding[]; body: string[] }[] = [];
  let cur: Finding | null = null;
  const group = () => groups[groups.length - 1];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^#\s/.test(line) && !groups.length && !intro.some(Boolean)) continue;     // "# Review: …" repeats the plate
    // "**Verdict: approve.** …" or "**Verdict:** approve. …"
    const v = /^\*\*Verdict:\s*([^*]+?)\*\*\s*(.*)$/i.exec(line) ?? /^\*\*Verdict:?\*\*:?\s*([^.]+)\.?\s*(.*)$/i.exec(line);
    if (v && !verdict && !groups.length) {
      verdict = verdictOf(v[1]);
      if (v[2]) intro.push(v[2]);
      continue;
    }
    const h = /^#{2,3}\s+(.+?)\s*$/.exec(line);
    const f = /^(?:#{3,4}\s+)?(\d+)[.)]\s+\*\*(.+?)\*\*\s*(.*)$/.exec(line);
    if (f) {
      if (!groups.length) groups.push({ title: "", findings: [], body: [] });
      // Code spans that open the line ("`a.ts:3` and `b.ts`", "`a.ts:3`: …") are its refs; a sentence stays the body.
      const lead = /^((?:`[^`]+`\s*(?:,|and|&)?\s*)+)(?:[:—–-]\s+|$)/.exec(f[3]);
      cur = { n: +f[1], title: f[2].trim().replace(/[.:]$/, ""), refs: lead ? [...lead[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]) : [],
        body: (lead ? f[3].slice(lead[0].length) : f[3]).trim(), fix: "" };
      group().findings.push(cur);
      continue;
    }
    if (h) { groups.push({ title: h[1], findings: [], body: [] }); cur = null; continue; }
    if (cur && (/^\s+\S/.test(line) || (line === "" && cur))) {
      const fix = /^\s*(?:[-*]\s+)?\*\*Fix:?\*\*:?\s*(.*)$/i.exec(line);
      if (fix) cur.fix = fix[1];
      else if (line) cur.body += (cur.body ? "\n" : "") + line.replace(/^\s{2,4}/, "");
      continue;
    }
    cur = null;
    if (groups.length) group().body.push(line);
    else intro.push(line);
  }
  if (!groups.some((g) => g.findings.length)) return null;
  return { verdict, intro: intro.join("\n").trim(), groups: groups.map((g) => ({ ...g, body: g.body.join("\n").trim() })) };
}

// ── IMPLEMENT ─────────────────────────────────────────────────────────────────
export interface Impl {
  pr: { url: string; repo: string; number: number } | null;
  branch: string;
  tasks: { key: string; name: string; done: boolean; why: string }[];
  open: string[];
  body: string;
}

/** The summary the template asks for: the branch, the PR link, one line per task
 *  (a batch: done or skipped, with the reason) and the open questions. What
 *  isn't one of those stays the body. No PR and no task line, no view. */
export function parseImpl(md: string, repo?: string): Impl | null {
  const text = md ?? "";
  const urls = [...text.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g)];
  const hit = urls.find((u) => repo && u[1].toLowerCase() === repo.toLowerCase()) ?? urls[0];
  const pr = hit ? { url: hit[0], repo: hit[1], number: +hit[2] } : null;
  const branch = /\bbranch(?: name)?:?\**:?\s*`([^`\s]+)`/i.exec(text)?.[1] ?? "";
  const tasks: Impl["tasks"] = [];
  const open: string[] = [];
  const body: string[] = [];
  let inOpen = false;
  for (const line of text.split("\n")) {
    const label = /^(?:#{2,4}\s+|\*\*)?\s*(open (?:questions?|points?)|notable decisions|decisions and open questions)\b/i.test(line.replace(/^[-*]\s+/, ""));
    if (label) { inOpen = true; continue; }
    if (inOpen) {
      if (bullet.test(line)) { open.push(line.replace(bullet, "").trim()); continue; }
      if (!line.trim()) continue;
      inOpen = false;
    }
    const key = /\b([A-Z][A-Z0-9]+-\d+)\b/.exec(line)?.[1];
    const st = /\b(done|skipped)\b/i.exec(line);
    if (bullet.test(line) && key && st) {
      const skipped = st[1].toLowerCase() === "skipped";
      const why = skipped ? /\bskipped\b\W*(.*)$/i.exec(line)?.[1].replace(/^[(:]\s*|\)$/g, "").trim() ?? "" : "";
      const name = line.replace(bullet, "").replace(/\[?\b[A-Z][A-Z0-9]+-\d+\b\]?/, "").replace(/[—–:-]?\s*\b(done|skipped)\b[\s\S]*$/i, "")
        .replace(/\*\*/g, "").replace(/^[\s—–:-]+|[\s—–:,-]+$/g, "");
      tasks.push({ key, name, done: !skipped, why });
      continue;
    }
    body.push(line);
  }
  if (!pr && !tasks.length) return null;
  return { pr, branch, tasks, open, body: body.join("\n").replace(/\n{3,}/g, "\n\n").trim() };
}

// ── TASK DESCRIPTION ──────────────────────────────────────────────────────────
export interface TaskDesc { context: string; goal: string; scope: string[]; criteria: string[]; out: string[]; questions: string[]; words: number }

/** The fixed `## ` sections (task-description-prompt.template.ts); two or more of them, or no view. */
export function parseTaskDesc(md: string): TaskDesc | null {
  const parts = partsOf(md ?? "");
  const get = (re: RegExp) => parts.find((p) => re.test(p.title))?.body;
  const known = [/^context$/i, /^goal$/i, /^scope$/i, /^acceptance criteria$/i, /^out of scope$/i, /^open questions$/i];
  if (parts.filter((p) => known.some((re) => re.test(p.title))).length < 2) return null;
  return {
    context: get(known[0]) ?? "",
    goal: get(known[1]) ?? "",
    scope: bulletsOf(get(known[2]) ?? ""),
    criteria: bulletsOf(get(known[3]) ?? ""),
    out: bulletsOf(get(known[4]) ?? ""),
    questions: bulletsOf(get(known[5]) ?? ""),
    words: (md ?? "").split(/\s+/).filter((w) => /\w/.test(w)).length,
  };
}

// ── CHANGELOG ─────────────────────────────────────────────────────────────────
export interface ChangeRef { label: string; url?: string }
export interface Changelog {
  version: string;
  date: string;
  summary: string;
  groups: { name: string; entries: { text: string; breaking: boolean; refs: ChangeRef[] }[] }[];
}
const REF = /\[([^\]]+)\]\(([^)\s]+)\)|(#\d+)|`?\b([0-9a-f]{7,40})\b`?/g;

/** `## <version> — <date>`, a summary, then `### Added` / `### Fixed` … bullets
 *  ending in their refs "([#42](url), [`a1b2c3d`](url))" (changelog-prompt.template.ts). */
export function parseChangelog(md: string): Changelog | null {
  const lines = (md ?? "").split("\n");
  const top = lines.findIndex((l) => /^##\s+\S/.test(l));
  if (top < 0) return null;
  const head = lines[top].replace(/^##\s+/, "").trim();
  const hm = /^(.+?)\s+[—–-]\s+(\d{4}-\d{2}-\d{2})$/.exec(head);
  const groups: Changelog["groups"] = [];
  const summary: string[] = [];
  for (const line of lines.slice(top + 1)) {
    const g = /^###\s+(.+?)\s*$/.exec(line);
    if (g) { groups.push({ name: g[1], entries: [] }); continue; }
    const cur = groups[groups.length - 1];
    if (!cur) { if (line.trim()) summary.push(line.trim()); continue; }
    if (bullet.test(line)) {
      let text = line.replace(bullet, "").trim();
      const breaking = /^\*\*Breaking:?\*\*:?\s*/i.test(text);
      text = text.replace(/^\*\*Breaking:?\*\*:?\s*/i, "");
      const tail = /\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$/.exec(text);
      let refs: ChangeRef[] = [];
      if (tail) {
        refs = [...tail[1].matchAll(REF)].map((m) => (m[1] ? { label: m[1].replace(/`/g, ""), url: m[2] } : { label: m[3] ?? m[4] }));
        const rest = tail[1].replace(REF, "").replace(/[\s,]/g, "");
        if (refs.length && !rest) text = text.slice(0, tail.index).trim();
        else refs = [];
      }
      cur.entries.push({ text, breaking, refs });
    } else if (line.trim() && cur.entries.length) {
      cur.entries[cur.entries.length - 1].text += " " + line.trim();
    }
  }
  const kept = groups.filter((g) => g.entries.length);
  if (!kept.length) return null;
  // A breaking change leads its section, as the template orders it.
  for (const g of kept) g.entries.sort((a, b) => Number(b.breaking) - Number(a.breaking));
  return { version: hm ? hm[1] : head, date: hm ? hm[2] : "", summary: summary.join(" "), groups: kept };
}
