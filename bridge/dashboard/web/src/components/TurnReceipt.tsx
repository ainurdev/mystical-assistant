import { useState } from "react";
import { Check, ChevronDown, CircleX, ExternalLink, FileDiff, GitCommitHorizontal, GitPullRequest, Upload, X } from "lucide-react";
import { fmtTokens } from "../lib/week";
import { runtimeBadge } from "../lib/agents";
import { wall } from "../lib/surfaces";
import type { Receipt, ReceiptFile } from "../lib/receipt";

/* A finished turn's receipt (lib/receipt): one row by the answer, built only from what
   the tools recorded, and under it any failure nothing made good. */

const DIFF_MAX = 200;

const lineTone = (l: string) => (l.startsWith("@@") ? "hunk" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : undefined);

function FileRow({ f }: { f: ReceiptFile }) {
  const [open, setOpen] = useState(false);
  const cut = f.path.lastIndexOf("/");
  const has = f.patch.length > 0;
  return (
    <li>
      <button type="button" className="ma-rc-file" aria-expanded={has ? open : undefined} disabled={!has} onClick={() => setOpen((o) => !o)} title={f.path}>
        <span className="ma-rc-path"><span className="d">{f.path.slice(0, cut + 1)}</span><b>{f.path.slice(cut + 1)}</b></span>
        {f.edits > 1 && <span className="n">×{f.edits}</span>}
        {has && <span className="add">+{f.add}</span>}
        {has && <span className="del">−{f.del}</span>}
        {has && <ChevronDown size={11} aria-hidden className={open ? "rotate-180" : ""} />}
      </button>
      {open && (
        <div className="ma-rc-diff">
          {f.patch.slice(0, DIFF_MAX).map((l, i) => <div key={i} data-t={lineTone(l)}>{l || " "}</div>)}
          {f.patch.length > DIFF_MAX && <div className="ma-rc-more">{f.patch.length - DIFF_MAX} more lines in the work above</div>}
        </div>
      )}
    </li>
  );
}

export function TurnReceipt({ r, onJump }: { r: Receipt; onJump: (i: number) => void }) {
  const [open, setOpen] = useState(false);
  const last = r.checks[r.checks.length - 1];
  const failedChecks = !!last && !last.ok;
  const n = r.files.length;
  const words = r.commits.length ? `${r.commits.length} commit${r.commits.length === 1 ? "" : "s"}` : "";
  const badge = r.runtime ? runtimeBadge(r.runtime) : null;
  const opens = n > 0 || r.checks.length > 1 || (last?.fresh.length ?? 0) > 0 || r.commits.length > 0;
  return (
    <div className="ma-rc" role="group" aria-label="What this turn did">
      <div className="ma-rc-row">
        {opens ? (
          <button type="button" className="ma-rc-cell ma-rc-open" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={open ? "Hide the details" : "Show the details"}>
            <ChevronDown size={11} aria-hidden className={open ? "" : "-rotate-90"} />
            {n > 0 ? <><FileDiff size={12} aria-hidden />{n} file{n === 1 ? "" : "s"}</> : "details"}
          </button>
        ) : null}
        {last && (
          <span className="ma-rc-cell" data-tone={failedChecks ? "err" : "ok"} title={last.command}>
            {failedChecks ? <X size={12} strokeWidth={2.6} aria-hidden /> : <Check size={12} strokeWidth={2.6} aria-hidden />}
            {last.line}
          </span>
        )}
        {words && <span className="ma-rc-cell" title={r.commits.map((c) => c.subject).filter(Boolean).join("\n")}><GitCommitHorizontal size={12} aria-hidden />{words}</span>}
        {r.pushed.length > 0 && <span className="ma-rc-cell" title="Pushed"><Upload size={12} aria-hidden />pushed{r.pushed[0] ? ` ${r.pushed.join(", ")}` : ""}</span>}
        {r.prs.map((p) => (
          <a key={p.url} className="ma-rc-cell ma-rc-pr" href={p.url} target="_blank" rel="noreferrer" title={p.url}>
            <GitPullRequest size={12} aria-hidden />PR{p.n ? ` #${p.n}` : ""}<ExternalLink size={10} aria-hidden />
          </a>
        ))}
        <span className="ma-rc-gap" />
        {r.secs != null && <span className="ma-rc-cell ma-rc-q" title="Wall time">{wall(r.secs)}</span>}
        {r.tokens != null && <span className="ma-rc-cell ma-rc-q" title="Tokens this turn spent">{fmtTokens(r.tokens)} TOK</span>}
        {badge && <span className="ma-rc-cell ma-rc-q" title={badge.title}>{badge.text}</span>}
      </div>
      {open && (
        <div className="ma-rc-body">
          {n > 0 && <ul className="ma-rc-files">{r.files.map((f) => <FileRow key={f.path} f={f} />)}</ul>}
          {(r.checks.length > 1 || (last?.fresh.length ?? 0) > 0) && (
            <ul className="ma-rc-list">
              {r.checks.map((c, i) => (
                <li key={i} data-tone={c.ok ? "ok" : "err"}>
                  <code title={c.command}>{c.command}</code> <span>{c.line}</span>
                  {c.fresh.length > 0 && <ul className="ma-rc-new">{c.fresh.map((t) => <li key={t}>{t}</li>)}</ul>}
                </li>
              ))}
            </ul>
          )}
          {r.commits.length > 0 && (
            <ul className="ma-rc-list">
              {r.commits.map((c, i) => <li key={i}>{c.sha && <code>{c.sha}</code>} {c.subject}{c.branch ? <span className="ma-rc-q"> on {c.branch}</span> : null}</li>)}
            </ul>
          )}
        </div>
      )}
      {r.unresolved.map((f) => (
        <div key={f.id} className="ma-rc-fail" role="note">
          <CircleX size={13} aria-hidden />
          <span className="ma-rc-fail-t">
            <b title={f.what}>{f.what.replace(/\s+/g, " ") || f.name}</b>
            {f.text && <span>{f.text}</span>}
          </span>
          <button type="button" className="ma-link" onClick={() => onJump(f.i)}>show</button>
        </div>
      ))}
    </div>
  );
}
