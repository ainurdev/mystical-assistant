import { useState, type ReactNode } from "react";
import { api } from "../api";
import {
  asChecks, asCommands, asConfidence, asFiles, asFindings, asScreens,
  flatten, triagePrompt, type Finding,
} from "../lib/cardfields";
import { ImageLightbox, ZoomButton } from "./ImageLightbox";

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
// Mirrors bridge/miniapp/web/src/components/FlowFields.tsx (the ONE difference
// is Shot: this side can put a URL in an <img>, the Mini App's auth lives in a
// header). Keep them in sync.

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
      {zoom && <ImageLightbox src={zoom} onClose={() => setZoom(null)} />}
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

/** The one thing this file does differently from its Mini App twin: the
 *  dashboard is same-origin, so the URL goes straight in an <img>. */
function Shot({ path, onZoom }: { path: string; onZoom: (src: string) => void }) {
  const [gone, setGone] = useState(false);
  const src = api.attachmentUrl(path);
  if (gone) return <span className="flc-gone">{path.split("/").pop()}</span>;
  return (
    <ZoomButton onOpen={() => onZoom(src)}>
      <img src={src} alt={path} onError={() => setGone(true)} />
    </ZoomButton>
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
