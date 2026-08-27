import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { api } from "../lib/api";
import { idiomFor, type ToolStyle, type ToolWidgetSpec } from "../lib/toolwidget";
import {
  asChain, asChart, asChecks, asClaims, asCommands, asConfidence, asDiff, asFiles,
  asFindings, asGraph, asIdeas, asIntake, asMeters, asOutput, asPlan, asScreens,
  asSources, asStats, asTable,
  diffColor, flatten, triagePrompt,
  type Bar, type Claim, type ChainStep, type DiffFile, type Finding, type Graph,
  type Idea, type Meter, type Output, type PlanRow, type Question, type Source,
  type Stat, type Table,
} from "../lib/resultfields";
import { ImageLightbox } from "./ImageLightbox";

// The widgets a typed stage's card is made of. Which one draws is the flow's
// call, not this file's: bridge/flows/*.json declares a field's type and
// flow.catalog() ships it. A value that isn't the shape its type promised falls
// through to text — the turn's work is still good, and a half-drawn board is
// worse than a sentence.
//
// Styling lives in index.css under .flc-*, the way .agb-* does: these are HUD
// instruments, not cards with utility classes on them, and the two surfaces
// share the markup while each stylesheet gives it its own idiom (square and
// bracketed on the desktop, rounded on the phone).
//
// Mirrors bridge/dashboard/web/src/components/ResultWidgets.tsx (the ONE difference
// is Shot: the dashboard can put a URL in an <img>, here the auth lives in a
// header so the bytes come through the API). Keep them in sync.

/** One field of a card. `send` is absent on a card the session has already moved
 *  past — history stays readable, but you can't act on it twice. */
export function ResultField({ name, type, value, send, onOpenFile }: {
  name: string;
  type: string;
  value: unknown;
  send?: (text: string) => void;
  onOpenFile?: (path: string, line?: number) => void;
}) {
  const widget = drawWidget(type, value, send, onOpenFile);
  // A one-liner keeps its label beside it; an instrument gets the label above
  // and the full width under it.
  if (!widget) {
    return (
      <div className="flc-f" data-inline="">
        <dt className="flc-lab">{name.toUpperCase()}</dt>
        <dd className="flc-val">{flatten(value)}</dd>
      </div>
    );
  }
  return (
    <div className="flc-f">
      <dt className="flc-lab">{name.toUpperCase()}</dt>
      <dd className="flc-wide">{widget}</dd>
    </div>
  );
}

/** Draw one widget for a declared type, with no label or frame around it — the
 *  caller owns the chrome (ToolWidget draws the instrument frame; ResultField
 *  draws a labelled row). Null when the value isn't the shape the type promised,
 *  which is the caller's cue to fall back to text. */
export function drawWidget(
  type: string,
  value: unknown,
  send?: (text: string) => void,
  onOpenFile?: (path: string, line?: number) => void,
): ReactNode {
  switch (type) {
    case "checks": {
      const rows = asChecks(value);
      return rows && <CheckBoard rows={rows} send={send} />;
    }
    case "findings": {
      const rows = asFindings(value);
      return rows && <FindingsTriage rows={rows} send={send} onOpenFile={onOpenFile} />;
    }
    case "commands": {
      const rows = asCommands(value);
      return rows && <CommandManifest rows={rows} />;
    }
    case "files": {
      const rows = asFiles(value);
      return rows && <FileChips rows={rows} onOpenFile={onOpenFile} />;
    }
    case "screens": {
      const rows = asScreens(value);
      return rows && <ScreenGallery rows={rows} send={send} />;
    }
    case "confidence": {
      const n = asConfidence(value);
      return n === null ? null : <ConfidenceMeter value={n} />;
    }
    case "verdict":
      return typeof value === "string" || typeof value === "boolean"
        ? <VerdictBanner value={value} /> : null;
    case "draft":
      return typeof value === "string" && value.trim()
        ? <DraftBox text={value} send={send} /> : null;
    case "diff": {
      const rows = asDiff(value);
      return rows && <DiffStat rows={rows} onOpenFile={onOpenFile} />;
    }
    case "output": {
      const out = asOutput(value);
      return out && <OutputBlock out={out} />;
    }
    case "map": {
      const g = asGraph(value);
      return g && <NodeMap graph={g} />;
    }
    case "chain": {
      const steps = asChain(value);
      return steps && <CauseChain steps={steps} />;
    }
    case "chart": {
      const bars = asChart(value);
      return bars && <BarChart bars={bars} />;
    }
    case "stats": {
      const tiles = asStats(value);
      return tiles && <StatTiles tiles={tiles} />;
    }
    case "table": {
      const t = asTable(value);
      return t && <DataTable table={t} />;
    }
    case "ideas": {
      const rows = asIdeas(value);
      return rows && <IdeaScatter rows={rows} send={send} />;
    }
    case "meters": {
      const rows = asMeters(value);
      return rows && <MeterBank rows={rows} />;
    }
    case "plan": {
      const rows = asPlan(value);
      return rows && <PlanApply rows={rows} />;
    }
    case "sources": {
      const rows = asSources(value);
      return rows && <SourceList rows={rows} />;
    }
    case "claims": {
      const rows = asClaims(value);
      return rows && <ClaimList rows={rows} />;
    }
    case "intake": {
      const rows = asIntake(value);
      return rows && <IntakeGrid rows={rows} send={send} />;
    }
    default:
      return null;
  }
}

/** Commands that were run and what they said. A failing row is the one thing on
 *  a verify card worth touching, so it — and only it — is a button. */
function CheckBoard({ rows, send }: { rows: { cmd: string; ok: boolean; note?: string }[]; send?: (t: string) => void }) {
  return (
    <ul className="flc-checks">
      {rows.map((r, i) => (
        <li key={i} data-ok={r.ok ? "" : undefined} data-bad={r.ok ? undefined : ""}>
          <i className="flc-glyph" aria-hidden>{r.ok ? "✓" : "✗"}</i>
          {r.ok || !send ? (
            <span className="flc-cmd">{r.cmd}</span>
          ) : (
            <button
              type="button"
              className="flc-cmd flc-again"
              title="send this back to be fixed"
              onClick={() => send(`\`${r.cmd}\` is still failing. Fix the cause and run it again.`)}
            >
              {r.cmd}
            </button>
          )}
          {r.note && <span className="flc-note">{r.note}</span>}
        </li>
      ))}
    </ul>
  );
}

/** What a chore will do, or did. Numbered because order is the whole point of
 *  reading one before it runs. */
function CommandManifest({ rows }: { rows: { cmd: string; status?: string }[] }) {
  const glyph: Record<string, string> = { ok: "✓", fail: "✗", pending: "·" };
  return (
    <ol className="flc-cmds">
      {rows.map((r, i) => (
        <li key={i} data-state={r.status ?? "none"}>
          <i className="flc-n" aria-hidden>{String(i + 1).padStart(2, "0")}</i>
          <span className="flc-cmd">{r.cmd}</span>
          {r.status && <i className="flc-glyph" aria-hidden>{glyph[r.status]}</i>}
        </li>
      ))}
    </ol>
  );
}

function FileChips({ rows, onOpenFile }: {
  rows: { path: string; add?: number; del?: number }[];
  onOpenFile?: (path: string, line?: number) => void;
}) {
  return (
    <div className="flc-chips">
      {rows.map((f) => {
        const body = (
          <>
            <span className="flc-path">{f.path}</span>
            {(f.add !== undefined || f.del !== undefined) && (
              <span className="flc-stat">
                {f.add ? <b>+{f.add}</b> : null}
                {f.del ? <i>−{f.del}</i> : null}
              </span>
            )}
          </>
        );
        return onOpenFile ? (
          <button key={f.path} type="button" className="flc-chip" title="open in the editor"
                  onClick={() => onOpenFile(f.path)}>
            {body}
          </button>
        ) : (
          <span key={f.path} className="flc-chip">{body}</span>
        );
      })}
    </div>
  );
}

/** What a review or a probe turned up — and, while the card is live, which of it
 *  you believe. Dropping is the point: an untriaged list of twelve is a report
 *  nobody acts on. */
function FindingsTriage({ rows, send, onOpenFile }: {
  rows: Finding[];
  send?: (t: string) => void;
  onOpenFile?: (path: string, line?: number) => void;
}) {
  const [dropped, setDropped] = useState<Set<number>>(new Set());
  const [sent, setSent] = useState(false);
  return (
    <div className="flc-finds">
      <ul>
        {rows.map((f, i) => {
          const off = dropped.has(i);
          return (
            <li key={i} data-sev={f.severity} data-off={off ? "" : undefined}>
              <div className="flc-findhead">
                {send && (
                  <button
                    type="button"
                    className="flc-drop"
                    title={off ? "keep this one" : "drop this one"}
                    onClick={() => setDropped((d) => {
                      const n = new Set(d);
                      if (!n.delete(i)) n.add(i);
                      return n;
                    })}
                  >
                    {off ? "+" : "×"}
                  </button>
                )}
                <span className="flc-sev">{f.severity.toUpperCase()}</span>
                <button
                  type="button"
                  className="flc-at"
                  disabled={!onOpenFile}
                  onClick={() => onOpenFile?.(f.file, f.line)}
                >
                  {f.file}{f.line ? `:${f.line}` : ""}
                </button>
              </div>
              <div className="flc-findnote">{f.note}</div>
            </li>
          );
        })}
      </ul>
      {send && dropped.size > 0 && (
        <button
          type="button"
          className="flc-btn"
          disabled={sent}
          onClick={() => { setSent(true); send(triagePrompt(rows, dropped)); }}
        >
          KEEP {rows.length - dropped.size} · DROP {dropped.size} ▸
        </button>
      )}
    </div>
  );
}

/** Screenshots a design stage produced. On the draft gate they are the thing
 *  being approved, so a note per screen is how you answer without describing
 *  which screen you mean. */
function ScreenGallery({ rows, send }: { rows: { path: string; caption?: string }[]; send?: (t: string) => void }) {
  const [zoom, setZoom] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [sent, setSent] = useState(false);
  const written = Object.entries(notes).filter(([, v]) => v.trim());
  return (
    <div className="flc-gal">
      {zoom && <ImageLightbox src={zoom} alt="screen" onClose={() => setZoom(null)} />}
      <div className="flc-shots">
        {rows.map((s, i) => (
          <figure key={i}>
            <Shot path={s.path} onZoom={setZoom} />
            <figcaption>{s.caption ?? s.path.split("/").pop()}</figcaption>
            {send && (
              <input
                className="flc-in"
                value={notes[i] ?? ""}
                onChange={(e) => setNotes((n) => ({ ...n, [i]: e.target.value }))}
                placeholder="note…"
              />
            )}
          </figure>
        ))}
      </div>
      {send && written.length > 0 && (
        <button
          type="button"
          className="flc-btn"
          disabled={sent}
          onClick={() => {
            setSent(true);
            send(written.map(([i, v]) =>
              `${rows[Number(i)].caption ?? rows[Number(i)].path}: ${v.trim()}`).join("\n"));
          }}
        >
          SEND {written.length} NOTE{written.length > 1 ? "S" : ""} ▸
        </button>
      )}
    </div>
  );
}

/** The one thing this file does differently from its dashboard twin: the Mini
 *  App's auth lives in a header, so the bytes come through the API as a blob
 *  (same shape as RunStream's ToolImage — inlined rather than imported, because
 *  RunStream already imports this file's card). */
function Shot({ path, onZoom }: { path: string; onZoom: (src: string) => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    let url: string | null = null;
    let dead = false;
    api.attachmentUrl(path).then((u) => {
      url = u;
      if (dead) URL.revokeObjectURL(u);
      else setSrc(u);
    }).catch(() => { if (!dead) setGone(true); });
    return () => { dead = true; if (url) URL.revokeObjectURL(url); };
  }, [path]);
  if (gone) return <span className="flc-gone">{path.split("/").pop()}</span>;
  if (!src) return null;
  return (
    <button type="button" className="flc-zoom" onClick={() => onZoom(src)} aria-label={`Open ${path}`}>
      <img src={src} alt={path} />
    </button>
  );
}

/** How sure the answer is, in lamps — the readout this HUD already uses for a
 *  fraction (the composer's context meter), never a progress bar. */
function ConfidenceMeter({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const lit = Math.round(value * 10);
  return (
    <div className="flc-meter" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <span className="seg" aria-hidden>
        {Array.from({ length: 10 }, (_, i) => <i key={i} data-on={i < lit ? "" : undefined} />)}
      </span>
      <b>{pct}%</b>
    </div>
  );
}

/** A stage's one-word answer, told at a glance: shipped, failing, reproduced. */
function VerdictBanner({ value }: { value: string | boolean }) {
  const word = typeof value === "boolean" ? (value ? "pass" : "fail") : value.trim();
  const w = word.toLowerCase();
  const bad = ["fail", "failed", "no", "broken", "needs_work", "blocked"].includes(w);
  const good = ["pass", "passed", "yes", "ok", "green", "shipped", "reproduced", "done"].includes(w);
  return (
    <div className="flc-verd" data-tone={bad ? "bad" : good ? "good" : "flat"}>
      <i aria-hidden>{bad ? "✗" : good ? "✓" : "▸"}</i>
      {word.toUpperCase()}
    </div>
  );
}

/** Text the model wrote for you to send back — a commit message, a release note.
 *  Editable, because the point of showing it before it lands is changing it. */
function DraftBox({ text, send }: { text: string; send?: (t: string) => void }) {
  const [draft, setDraft] = useState(text);
  const [sent, setSent] = useState(false);
  if (!send) return <pre className="flc-pre">{text}</pre>;
  return (
    <div className="flc-draft">
      <textarea
        className="flc-in"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={Math.min(6, draft.split("\n").length + 1)}
      />
      <button
        type="button"
        className="flc-btn"
        disabled={sent || !draft.trim()}
        onClick={() => { setSent(true); send(`Use this exactly:\n\n${draft.trim()}`); }}
      >
        {draft.trim() === text.trim() ? "USE IT ▸" : "USE MY EDIT ▸"}
      </button>
    </div>
  );
}

// --- the widget grammar ----------------------------------------------------
// Each of these is a kind of work wearing its own shape, which is the whole
// argument: a terminal is never mistaken for a read, a topology never for a
// table. Shape carries the kind, so every one of them stays legible in
// grayscale — colour only ever repeats what the layout already said.

/** Files a turn edited. The hunk is the evidence, so it draws as a diff and not
 *  as a count — a "+38" nobody can check is a claim, not a change. */
function DiffStat({ rows, onOpenFile }: {
  rows: DiffFile[];
  onOpenFile?: (path: string, line?: number) => void;
}) {
  const add = rows.reduce((n, r) => n + (r.add ?? 0), 0);
  const del = rows.reduce((n, r) => n + (r.del ?? 0), 0);
  return (
    <div className="flc-diff">
      <div className="flc-diffhead">
        <span className="flc-lab">{rows.length} FILE{rows.length > 1 ? "S" : ""}</span>
        <i className="flc-rule" aria-hidden />
        <span className="flc-stat">
          {add ? <b>+{add}</b> : null}
          {del ? <i>−{del}</i> : null}
        </span>
      </div>
      {rows.map((r, i) => (
        <div className="flc-dfile" key={i}>
          <div className="flc-dfhead">
            <button
              type="button"
              className="flc-at"
              disabled={!onOpenFile}
              onClick={() => onOpenFile?.(r.file)}
            >
              {r.file}
            </button>
            <i className="flc-rule" aria-hidden />
            <span className="flc-stat">
              {r.add ? <b>+{r.add}</b> : null}
              {r.del ? <i>−{r.del}</i> : null}
            </span>
          </div>
          {r.hunk && (
            <pre className="flc-hunk">
              {r.hunk.split("\n").map((l, j) => (
                <span key={j} style={{ color: diffColor(l) }}>{l || " "}{"\n"}</span>
              ))}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}

/** What a command printed, in the one place the HUD lets type go monospace and
 *  unwrapped. The lamp says pass or fail before you read a line of it. */
function OutputBlock({ out }: { out: Output }) {
  return (
    <div className="flc-out" data-ok={out.ok === true ? "" : undefined} data-bad={out.ok === false ? "" : undefined}>
      {(out.cmd || out.ok !== undefined) && (
        <div className="flc-outhead">
          {out.ok !== undefined && <i className="flc-glyph" aria-hidden>{out.ok ? "✓" : "✗"}</i>}
          {out.cmd && <span className="flc-cmd">{out.cmd}</span>}
        </div>
      )}
      <pre className="flc-pre">{out.text}</pre>
    </div>
  );
}

/** A topology or a pipeline. Laid out in columns by how far a node sits from an
 *  entry point, because "what reaches what" is the only question a map like this
 *  is asked — never "where exactly is it".
 *
 *  ponytail: columns wrap and the connector is a CSS rule between them, so a map
 *  wide enough to wrap leaves a leading dash on the next line, and hop labels are
 *  listed under the map rather than drawn on the edges. Reach for SVG only if a
 *  map ever needs real edge routing — for four boxes it would be all cost. */
function NodeMap({ graph }: { graph: Graph }) {
  const { nodes, edges } = graph;
  // Longest-path depth: a node sits one column right of everything feeding it.
  // Cycles can't extend a path past the node count, which is what bounds this.
  const depth = new Map(nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let moved = false;
    for (const e of edges) {
      const d = (depth.get(e.from) ?? 0) + 1;
      if (d > (depth.get(e.to) ?? 0)) { depth.set(e.to, d); moved = true; }
    }
    if (!moved) break;
  }
  const cols: Graph["nodes"][] = [];
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    (cols[d] ??= []).push(n);
  }
  return (
    <div className="flc-map">
      <div className="flc-mapcols">
        {cols.filter(Boolean).map((col, ci) => (
          <div className="flc-mapcol" key={ci}>
            {col.map((n) => (
              <span className="flc-node" key={n.id} data-state={n.state ?? "none"}>
                {n.state && <i className="flc-lamp" aria-hidden />}
                {n.label}
              </span>
            ))}
          </div>
        ))}
      </div>
      {/* Edges that cross a column say something the layout can't: a hop and its
          cost. Same-column and backward edges are noise here, so they're listed
          rather than drawn. */}
      {edges.some((e) => e.label) && (
        <ul className="flc-hops">
          {edges.filter((e) => e.label).map((e, i) => {
            const a = nodes.find((n) => n.id === e.from), b = nodes.find((n) => n.id === e.to);
            return <li key={i}>{a?.label} <i aria-hidden>→</i> {b?.label} <b>{e.label}</b></li>;
          })}
        </ul>
      )}
    </div>
  );
}

/** How a fix was reached, in order. The rail down the left is the argument:
 *  each step earns the next, and a chain you can't follow is a guess. */
function CauseChain({ steps }: { steps: ChainStep[] }) {
  return (
    <ol className="flc-chain">
      {steps.map((s, i) => (
        <li key={i} data-tone={s.tone}>
          <i className="flc-dot" aria-hidden />
          <div className="flc-step">
            <div className="flc-stephead">
              <b>{i + 1}</b>
              <span className="flc-steplab">{s.label.toUpperCase()}</span>
              <i className="flc-rule" aria-hidden />
              {s.meta && <span className="flc-note">{s.meta}</span>}
            </div>
            {s.body && <div className="flc-stepbody">{s.body}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** A shape over time. Bars, not a line: these are counted things — days, runs,
 *  turns — and a line between them would imply values in the gaps. */
function BarChart({ bars }: { bars: Bar[] }) {
  const peak = Math.max(...bars.map((b) => b.value));
  const last = bars.length - 1;
  return (
    <div className="flc-chart">
      <div className="flc-bars" role="img" aria-label={`${bars.length} bars, peak ${peak}`}>
        {bars.map((b, i) => (
          <span
            key={i}
            className="flc-bar"
            data-peak={i === last || b.value === peak ? "" : undefined}
            style={{ height: `${peak > 0 ? Math.max(2, (b.value / peak) * 100) : 2}%` }}
            title={`${b.label} · ${b.value}`}
          />
        ))}
      </div>
      <div className="flc-axis">
        <span>{bars[0]?.label}</span>
        <i className="flc-rule" aria-hidden />
        <span>{bars[last]?.label}</span>
      </div>
    </div>
  );
}

/** Headline numbers, big enough to read from across the room — the one place in
 *  the card where a value outranks its label. */
function StatTiles({ tiles }: { tiles: Stat[] }) {
  return (
    <div className="flc-tiles">
      {tiles.map((t, i) => (
        <div className="flc-tile" key={i}>
          <span className="flc-lab">{t.label.toUpperCase()}</span>
          <b>{t.value}</b>
        </div>
      ))}
    </div>
  );
}

function DataTable({ table }: { table: Table }) {
  return (
    <table className="flc-table">
      <thead>
        <tr>{table.cols.map((c, i) => <th key={i} data-n={i > 0 ? "" : undefined}>{c.toUpperCase()}</th>)}</tr>
      </thead>
      <tbody>
        {table.rows.map((r, i) => (
          <tr key={i}>{r.map((c, j) => <td key={j} data-n={j > 0 ? "" : undefined}>{c}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}

/** Directions, not answers. Starring is the whole interaction: the point of
 *  asking for four is throwing away three. */
function IdeaScatter({ rows, send }: { rows: Idea[]; send?: (t: string) => void }) {
  const [starred, setStarred] = useState<Set<number>>(
    () => new Set(rows.flatMap((r, i) => (r.picked ? [i] : []))),
  );
  const [sent, setSent] = useState(false);
  return (
    <div className="flc-ideas">
      <div className="flc-stickies">
        {rows.map((r, i) => (
          <div className="flc-sticky" key={i} data-on={starred.has(i) ? "" : undefined}>
            <i className="flc-pin" aria-hidden />
            <div className="flc-stickyhead">
              <span className="flc-n">{String(i + 1).padStart(2, "0")}</span>
              {send ? (
                <button
                  type="button"
                  className="flc-star"
                  title={starred.has(i) ? "unstar" : "star this one"}
                  onClick={() => setStarred((s) => {
                    const n = new Set(s);
                    if (!n.delete(i)) n.add(i);
                    return n;
                  })}
                >
                  {starred.has(i) ? "★" : "☆"}
                </button>
              ) : starred.has(i) && <span className="flc-star" aria-hidden>★</span>}
            </div>
            <b>{r.title}</b>
            {r.note && <span className="flc-note">{r.note}</span>}
          </div>
        ))}
      </div>
      {send && starred.size > 0 && (
        <button
          type="button"
          className="flc-btn"
          disabled={sent}
          onClick={() => {
            setSent(true);
            const keep = rows.filter((_, i) => starred.has(i));
            send(`Take these ${keep.length} forward and drop the rest:\n`
              + keep.map((r) => `- ${r.title}${r.note ? ` — ${r.note}` : ""}`).join("\n"));
          }}
        >
          TAKE {starred.size} FORWARD ▸
        </button>
      )}
    </div>
  );
}

/** Utilisation, as bars — the one reading where "how full" is the actual
 *  question, so the bar is honest rather than decorative. */
function MeterBank({ rows }: { rows: Meter[] }) {
  return (
    <ul className="flc-bank">
      {rows.map((m, i) => (
        <li key={i} data-hot={m.pct >= 90 ? "" : undefined} data-warm={m.pct >= 70 && m.pct < 90 ? "" : undefined}>
          <span className="flc-lab">{m.label.toUpperCase()}</span>
          <span className="flc-track" role="meter" aria-valuenow={Math.round(m.pct)} aria-valuemin={0} aria-valuemax={100}>
            <i style={{ width: `${m.pct}%` }} />
          </span>
          <b>{Math.round(m.pct)}%</b>
        </li>
      ))}
    </ul>
  );
}

/** What applying would do. The verb is the glyph — add, change, drop — so the
 *  blast radius reads before any of the text does. */
function PlanApply({ rows }: { rows: PlanRow[] }) {
  const sign = { add: "+", change: "~", drop: "−" };
  const n = (op: PlanRow["op"]) => rows.filter((r) => r.op === op).length;
  return (
    <div className="flc-plan">
      <div className="flc-planhead">
        <span className="flc-lab">PLAN → APPLY</span>
        <i className="flc-rule" aria-hidden />
        <span className="flc-stat">
          {n("add") ? <b>+{n("add")}</b> : null}
          {n("change") ? <em>~{n("change")}</em> : null}
          {n("drop") ? <i>−{n("drop")}</i> : null}
        </span>
      </div>
      <ul>
        {rows.map((r, i) => (
          <li key={i} data-op={r.op}>
            <i className="flc-glyph" aria-hidden>{sign[r.op]}</i>
            <span>{r.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What the web said, numbered so a claim can point back at one. The number is
 *  the citation key, which is why it is the first thing on the row. */
function SourceList({ rows }: { rows: Source[] }) {
  return (
    <ol className="flc-srcs">
      {rows.map((s, i) => (
        <li key={i} data-stale={s.stale ? "" : undefined}>
          <i className="flc-cite" aria-hidden>{i + 1}</i>
          {s.url ? (
            <a className="flc-path" href={s.url} target="_blank" rel="noreferrer noopener">{s.title}</a>
          ) : (
            <span className="flc-path">{s.title}</span>
          )}
          {s.badge && <span className="flc-badge">{s.badge.toUpperCase()}</span>}
          {s.stale && <span className="flc-badge" data-warn="" title="older than the rest">⚠ DATED</span>}
        </li>
      ))}
    </ol>
  );
}

/** The answer, one line per thing it amounts to, each carrying what it rests
 *  on. A claim with no citation still draws — it just doesn't look sourced. */
function ClaimList({ rows }: { rows: Claim[] }) {
  return (
    <ul className="flc-claims">
      {rows.map((c, i) => (
        <li key={i}>
          <i className="flc-glyph" aria-hidden>◆</i>
          <span>{c.text}</span>
          {c.cites.map((n) => <i className="flc-cite" key={n}>{n}</i>)}
        </li>
      ))}
    </ul>
  );
}

/** One question per concept, asked when the brief is too thin to act on. Options
 *  are taps because the answer is usually one of a few words, and typing it is
 *  the slowest way to say a thing you could point at. */
function IntakeGrid({ rows, send }: { rows: Question[]; send?: (t: string) => void }) {
  const [answers, setAnswers] = useState<Record<number, string>>(
    () => Object.fromEntries(rows.flatMap((r, i) => (r.answer ? [[i, r.answer]] : []))),
  );
  const [sent, setSent] = useState(false);
  const done = Object.values(answers).filter((v) => v.trim()).length;
  return (
    <div className="flc-intake">
      <ul>
        {rows.map((q, i) => (
          <li key={i} data-done={answers[i]?.trim() ? "" : undefined}>
            <div className="flc-qhead">
              <span className="flc-topic">{(q.topic || `Q${i + 1}`).toUpperCase()}</span>
              <span className="flc-ask">{q.ask}</span>
              {answers[i]?.trim() && <span className="flc-ans">{answers[i]} ✓</span>}
            </div>
            {send && !answers[i]?.trim() && (
              q.options.length > 0 ? (
                <div className="flc-opts">
                  {q.options.map((o) => (
                    <button
                      key={o}
                      type="button"
                      className="flc-opt"
                      onClick={() => setAnswers((a) => ({ ...a, [i]: o }))}
                    >
                      {o}
                    </button>
                  ))}
                </div>
              ) : (
                <input
                  className="flc-in"
                  value={answers[i] ?? ""}
                  placeholder="answer…"
                  onChange={(e) => setAnswers((a) => ({ ...a, [i]: e.target.value }))}
                />
              )
            )}
          </li>
        ))}
      </ul>
      {send && done > 0 && (
        <button
          type="button"
          className="flc-btn"
          disabled={sent}
          onClick={() => {
            setSent(true);
            const said = rows
              .map((q, i) => [q, answers[i]?.trim()] as const)
              .filter(([, a]) => a);
            const skipped = rows.filter((_, i) => !answers[i]?.trim());
            send([
              ...said.map(([q, a]) => `${q.topic || q.ask}: ${a}`),
              ...(skipped.length
                ? [`Decide the rest yourself and say what you chose: ${
                    skipped.map((q) => q.topic || q.ask).join(", ")}`]
                : []),
            ].join("\n"));
          }}
        >
          {done === rows.length ? `ANSWER ALL ${done} ▸` : `ANSWER ${done} / ${rows.length} ▸`}
        </button>
      )}
    </div>
  );
}

/** The frame a result wears — chosen by its payload's idiom, not by the tool.
 *
 *  This used to be one frame for every widget, "what changes between them is
 *  the body, never the chrome", which made a four-shot gallery and a two-link
 *  source list the same object at a glance. Now the idiom picks both how much
 *  chrome there is and where it hangs (see lib/toolwidget `Idiom`):
 *
 *    trace   nothing at all — the caller draws it in the row's own stat cell
 *    strip   a hairline and a band, at the text column
 *    ledger  no box: the action grid again, flush left
 *    plate   a framed well, inset to its own gutter
 *    field   a stage that breaks the column and wears the corner brackets
 *
 *  The head is drawn for the three idioms that can carry one. A strip's label
 *  would double the height of a two-chip band, and a trace has no box to put a
 *  label on — both say what they are through the row above them, which already
 *  names the tool.
 *
 *  The OUTPUT STYLE variants stay CSS off `data-tw` and stay orthogonal: style
 *  picks the material (instrument / terminal / note), idiom picks the weight.
 *  Only `plain` is a decision this side, because it means "draw no widget at
 *  all" and the caller has to fall back before it gets here. */
export function ToolWidget({ spec, accent, style, children }: {
  spec: ToolWidgetSpec;
  /** The tool's hue (lib/tools toolAccent), so a widget reads as that tool's
   *  output rather than as a generic card. */
  accent: string;
  style: ToolStyle;
  /** Overrides the widget body — used where the caller already has a richer
   *  renderer (a multi-file edit run) and only wants the frame. */
  children?: ReactNode;
}) {
  // PLAIN is the fourth material, not the absence of one: every payload is
  // forced down to a TRACE — one dense line, no frame, no head. It reads the
  // spec rather than the drawn body on purpose, so a rich renderer handed in
  // as `children` collapses too. You still get no widgets; you get the one
  // line they would have said.
  if (style === "plain") {
    const said = flatten(spec.value);
    if (!said) return null;
    return (
      <div className="tw" data-tw="plain" style={{ "--h": accent } as CSSProperties}>
        <div className="tw-body">
          <span className="tw-tick">{spec.label}{spec.meta ? ` · ${spec.meta}` : ""}</span>
          <span className="tw-said">{said}</span>
        </div>
      </div>
    );
  }
  const body = children ?? drawWidget(spec.type, spec.value);
  if (!body) return null;
  const idiom = idiomFor(spec.type);
  const head = idiom === "plate" || idiom === "field" || idiom === "ledger";
  return (
    <div className="tw" data-tw={style} data-idiom={idiom}
         style={{ "--h": accent } as CSSProperties}>
      {idiom === "plate" && <span className="tw-rail" aria-hidden />}
      {head && (
        <div className="tw-head">
          <span className="tw-name">{spec.label}</span>
          {spec.meta && <span className="tw-meta">{spec.meta}</span>}
          <span className="tw-line" aria-hidden />
        </div>
      )}
      <div className="tw-body">{body}</div>
    </div>
  );
}

/** A widget the model wrote into its own prose, as a ```widget:<type>``` fence
 *  (lib/widgetblock). Same idiom frame as a tool's result, one difference: the
 *  hue is the accent rather than a tool's, because no tool produced it — this
 *  is the assistant speaking, and it is drawn inside the message bubble.
 *
 *  Returns null when the payload isn't the shape the type promised, which is
 *  the caller's cue to draw the code block it would have drawn. That fallback
 *  is the whole safety property: a malformed block costs a nicer rendering,
 *  never the text. */
export function BlockWidget({ type, value }: { type: string; value: unknown }) {
  const body = drawWidget(type, value);
  if (!body) return null;
  const idiom = idiomFor(type);
  const head = idiom === "plate" || idiom === "field" || idiom === "ledger";
  return (
    <div className="tw" data-tw="instrument" data-idiom={idiom} data-said="">
      {idiom === "plate" && <span className="tw-rail" aria-hidden />}
      {head && (
        <div className="tw-head">
          <span className="tw-name">{type.toUpperCase()}</span>
          <span className="tw-line" aria-hidden />
        </div>
      )}
      <div className="tw-body">{body}</div>
    </div>
  );
}
