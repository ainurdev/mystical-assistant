import { useState, type ReactNode } from "react";
import { api } from "../api";
import {
  asChecks, asCommands, asConfidence, asFiles, asFindings, asScreens,
  flatten, triagePrompt, type Finding,
} from "../lib/cardfields";
import { Button } from "./ui";
import { ImageLightbox, ZoomButton } from "./ImageLightbox";

// The widgets a typed stage's card is made of. Which one draws is the flow's
// call, not this file's: bridge/flows/*.json declares a field's type and
// flow.catalog() ships it. A value that isn't the shape its type promised falls
// through to text — the turn's work is still good, and a half-drawn board is
// worse than a sentence.
//
// Mirrors bridge/miniapp/web/src/components/FlowFields.tsx (the ONE difference
// is Shot: this side can put a URL in an <img>, the Mini App's auth lives in a
// header). Keep them in sync.

const LABEL = "text-[10px] tracking-[0.15em] text-muted-foreground";

/** One field of a card. `send` is absent on a card the session has already moved
 *  past — history stays readable, but you can't act on it twice. */
export function CardField({ name, type, value, send, onOpenFile }: {
  name: string;
  type: string;
  value: unknown;
  send?: (text: string) => void;
  onOpenFile?: (path: string, line?: number) => void;
}) {
  const widget = draw(type, value, send, onOpenFile);
  if (!widget) {
    return (
      <div className="flex gap-2 text-xs">
        <dt className={"shrink-0 " + LABEL}>{name.toUpperCase()}</dt>
        <dd className="min-w-0 break-words">{flatten(value)}</dd>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <div className={LABEL}>{name.toUpperCase()}</div>
      {widget}
    </div>
  );
}

function draw(
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
    default:
      return null;
  }
}

/** Commands that were run and what they said. A failing row is the one thing on
 *  a verify card worth touching, so it — and only it — is a button. */
function CheckBoard({ rows, send }: { rows: { cmd: string; ok: boolean; note?: string }[]; send?: (t: string) => void }) {
  return (
    <ul className="space-y-0.5 font-mono text-xs">
      {rows.map((r, i) => (
        <li key={i} className="flex items-baseline gap-1.5">
          <span className={r.ok ? "text-[var(--ok,#6c9)]" : "text-destructive"} aria-hidden>
            {r.ok ? "✓" : "✗"}
          </span>
          {r.ok || !send ? (
            <span className="min-w-0 break-all">{r.cmd}</span>
          ) : (
            <button
              type="button"
              className="min-w-0 break-all text-left underline decoration-dotted underline-offset-2"
              title="send this back to be fixed"
              onClick={() => send(`\`${r.cmd}\` is still failing. Fix the cause and run it again.`)}
            >
              {r.cmd}
            </button>
          )}
          {r.note && <span className="text-muted-foreground">— {r.note}</span>}
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
    <ol className="space-y-0.5 font-mono text-xs">
      {rows.map((r, i) => (
        <li key={i} className="flex items-baseline gap-1.5">
          <span className="w-3 shrink-0 text-right text-muted-foreground">{i + 1}</span>
          <span className="min-w-0 break-all">{r.cmd}</span>
          {r.status && (
            <span className={r.status === "fail" ? "text-destructive" : "text-muted-foreground"}>
              {glyph[r.status]}
            </span>
          )}
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
    <div className="flex flex-wrap gap-1">
      {rows.map((f) => {
        const stat = f.add !== undefined || f.del !== undefined;
        const body = (
          <>
            <span className="break-all">{f.path}</span>
            {stat && (
              <span className="ml-1 tabular-nums text-muted-foreground">
                {f.add ? `+${f.add}` : ""}{f.del ? ` −${f.del}` : ""}
              </span>
            )}
          </>
        );
        return onOpenFile ? (
          <button
            key={f.path}
            type="button"
            title="open in the editor"
            onClick={() => onOpenFile(f.path)}
            className="border border-border px-1.5 py-0.5 font-mono text-[11px] hover:bg-accent"
          >
            {body}
          </button>
        ) : (
          <span key={f.path} className="border border-border px-1.5 py-0.5 font-mono text-[11px]">
            {body}
          </span>
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
  const sev: Record<string, string> = {
    high: "text-destructive", med: "text-[var(--warn,#c96)]", low: "text-muted-foreground",
  };
  return (
    <div className="space-y-1">
      <ul className="space-y-1">
        {rows.map((f, i) => {
          const off = dropped.has(i);
          return (
            <li key={i} className={"text-xs " + (off ? "opacity-40 line-through" : "")}>
              <div className="flex items-baseline gap-1.5">
                {send && (
                  <button
                    type="button"
                    title={off ? "keep this one" : "drop this one"}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    onClick={() => setDropped((d) => {
                      const n = new Set(d);
                      if (!n.delete(i)) n.add(i);
                      return n;
                    })}
                  >
                    {off ? "＋" : "×"}
                  </button>
                )}
                <span className={"shrink-0 text-[10px] tracking-[0.1em] " + sev[f.severity]}>
                  {f.severity.toUpperCase()}
                </span>
                <button
                  type="button"
                  disabled={!onOpenFile}
                  onClick={() => onOpenFile?.(f.file, f.line)}
                  className={"min-w-0 break-all text-left font-mono text-[11px] " + (onOpenFile ? "underline decoration-dotted underline-offset-2" : "")}
                >
                  {f.file}{f.line ? `:${f.line}` : ""}
                </button>
              </div>
              <div className={"break-words " + (send ? "pl-5" : "pl-1")}>{f.note}</div>
            </li>
          );
        })}
      </ul>
      {send && dropped.size > 0 && (
        <Button
          size="sm"
          variant="outline"
          disabled={sent}
          onClick={() => { setSent(true); send(triagePrompt(rows, dropped)); }}
        >
          KEEP {rows.length - dropped.size} · DROP {dropped.size} ▸
        </Button>
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
    <div className="space-y-1.5">
      {zoom && <ImageLightbox src={zoom} onClose={() => setZoom(null)} />}
      <div className="flex flex-wrap gap-2">
        {rows.map((s, i) => (
          <figure key={i} className="space-y-1">
            <Shot path={s.path} onZoom={setZoom} />
            <figcaption className="max-w-[200px] text-[10px] text-muted-foreground">
              {s.caption ?? s.path.split("/").pop()}
            </figcaption>
            {send && (
              <input
                value={notes[i] ?? ""}
                onChange={(e) => setNotes((n) => ({ ...n, [i]: e.target.value }))}
                placeholder="note…"
                className="w-full max-w-[200px] border border-border bg-transparent px-1 py-0.5 text-[11px]"
              />
            )}
          </figure>
        ))}
      </div>
      {send && written.length > 0 && (
        <Button
          size="sm"
          variant="outline"
          disabled={sent}
          onClick={() => {
            setSent(true);
            send(written.map(([i, v]) =>
              `${rows[Number(i)].caption ?? rows[Number(i)].path}: ${v.trim()}`).join("\n"));
          }}
        >
          SEND {written.length} NOTE{written.length > 1 ? "S" : ""} ▸
        </Button>
      )}
    </div>
  );
}

/** The one thing this file does differently from its Mini App twin: the
 *  dashboard is same-origin, so the URL goes straight in an <img>. */
function Shot({ path, onZoom }: { path: string; onZoom: (src: string) => void }) {
  const [gone, setGone] = useState(false);
  const src = api.attachmentUrl(path);
  if (gone) return <span className="font-mono text-[10px] text-muted-foreground">{path.split("/").pop()}</span>;
  return (
    <ZoomButton onOpen={() => onZoom(src)}>
      <img
        src={src}
        alt={path}
        onError={() => setGone(true)}
        className="h-28 w-auto max-w-[200px] border border-border object-cover"
      />
    </ZoomButton>
  );
}

function ConfidenceMeter({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 border border-border" role="meter" aria-valuenow={pct}>
        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular-nums text-xs text-muted-foreground">{pct}%</span>
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
    <div
      className={"px-2 py-1 text-xs tracking-[0.1em] " + (bad
        ? "bg-destructive/15 text-destructive"
        : good ? "bg-primary/15 text-foreground" : "bg-muted text-muted-foreground")}
    >
      {(bad ? "✗ " : good ? "✓ " : "") + word.toUpperCase()}
    </div>
  );
}

/** Text the model wrote for you to send back — a commit message, a release note.
 *  Editable, because the point of showing it before it lands is changing it. */
function DraftBox({ text, send }: { text: string; send?: (t: string) => void }) {
  const [draft, setDraft] = useState(text);
  const [sent, setSent] = useState(false);
  if (!send) return <pre className="whitespace-pre-wrap font-mono text-xs">{text}</pre>;
  return (
    <div className="space-y-1">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={Math.min(6, draft.split("\n").length + 1)}
        className="w-full resize-y border border-border bg-transparent p-1.5 font-mono text-xs"
      />
      <Button
        size="sm"
        variant="outline"
        disabled={sent || !draft.trim()}
        onClick={() => { setSent(true); send(`Use this exactly:\n\n${draft.trim()}`); }}
      >
        {draft.trim() === text.trim() ? "USE IT ▸" : "USE MY EDIT ▸"}
      </Button>
    </div>
  );
}
