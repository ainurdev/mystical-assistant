import { useState } from "react";
import { Check, ChevronDown, ExternalLink, X } from "lucide-react";
import type { Failure } from "../lib/failures";
import { checksWord, receiptChecksOk, receiptLine, type Receipt } from "../lib/receipt";
import { testWords } from "../lib/bashkind";
import { hhmm } from "../lib/utils";

/* What's under a finished turn: anything still broken, then the receipt. Both are read
   off the events (lib/failures, lib/receipt), and neither draws if it has nothing. */

const CLAMP_LINES = 3;

/** A failure nothing later made good. The error is what you came for, so it shows
 *  without a tap; a long one opens. */
function FailureRow({ f }: { f: Failure }) {
  const [open, setOpen] = useState(false);
  const lines = f.error.split("\n");
  const long = lines.length > CLAMP_LINES || f.error.length > 240;
  const shown = open || !long ? f.error : lines.slice(-CLAMP_LINES).join("\n").slice(-240);
  const body = (
    <>
      <span className="rc-fail-what">
        <X size={11} aria-hidden className="flex-none" />
        <span className="min-w-0 truncate">{f.label}</span>
      </span>
      {shown && <span className="rc-fail-err">{shown}</span>}
      {long && <span className="rc-more">{open ? "LESS" : "ALL OF IT"}</span>}
    </>
  );
  return long
    ? <button type="button" className="rc-fail" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{body}</button>
    : <div className="rc-fail">{body}</div>;
}

const FAILS_SHOWN = 4;

export function UnresolvedFailures({ failures }: { failures: Failure[] }) {
  const [all, setAll] = useState(false);
  if (!failures.length) return null;
  const hidden = all ? 0 : Math.max(0, failures.length - FAILS_SHOWN);
  return (
    <div className="rc-fails" role="group" aria-label="Failures not resolved in this turn">
      <div className="rc-lab" style={{ color: "var(--err)" }}>
        STILL FAILING {"·"} {failures.length}
      </div>
      {failures.slice(hidden).map((f) => <FailureRow key={f.at} f={f} />)}
      {hidden > 0 && (
        <button type="button" className="ms-said-more" onClick={() => setAll(true)}>{hidden} EARLIER</button>
      )}
    </div>
  );
}

const fileName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const fileDir = (p: string) => p.slice(0, p.lastIndexOf("/") + 1);

function Details({ r }: { r: Receipt }) {
  return (
    <div className="rc-detail">
      {r.files.length > 0 && (
        <section>
          <div className="rc-lab">FILES CHANGED</div>
          {r.files.map((f) => (
            <div key={f.path} className="rc-file" title={f.path}>
              <span className="rc-dir">{fileDir(f.path)}</span>
              <span className="rc-name">{fileName(f.path)}</span>
              {f.patched && (
                <span className="rc-nums">
                  <span style={{ color: "var(--ok)" }}>+{f.add}</span>{" "}
                  <span style={{ color: "var(--err)" }}>{"−"}{f.del}</span>
                </span>
              )}
            </div>
          ))}
        </section>
      )}
      {r.checks.length > 0 && (
        <section>
          <div className="rc-lab">CHECKS</div>
          {r.checks.map((c) => (
            <div key={c.command} className="rc-check">
              <div className="flex items-start gap-1.5">
                {c.ok
                  ? <Check size={12} className="mt-0.5 flex-none" style={{ color: "var(--ok)" }} aria-label="Passed" />
                  : <X size={12} className="mt-0.5 flex-none" style={{ color: "var(--err)" }} aria-label="Failed" />}
                <code className="min-w-0 break-all">{c.command}</code>
              </div>
              {c.counts && <div className="rc-sub">{testWords(c.counts)}</div>}
              {c.fresh.length > 0 && <div className="rc-sub" style={{ color: "var(--err)" }}>New: {c.fresh.join(", ")}</div>}
              {c.known.length > 0 && <div className="rc-sub">{c.known.length} already known</div>}
              {c.log && <div className="rc-sub">Log: {c.log}</div>}
            </div>
          ))}
        </section>
      )}
      {r.commits.length > 0 && (
        <section>
          <div className="rc-lab">COMMITS</div>
          {r.commits.map((c) => (
            <div key={c.sha} className="rc-commit">
              <code>{c.sha.slice(0, 7)}</code> <span>{c.subject}</span>
              <div className="rc-sub">{c.branch}</div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

export function TurnReceipt({ receipt: r }: { receipt: Receipt }) {
  const [open, setOpen] = useState(false);
  const can = r.files.length > 0 || r.checks.length > 0 || r.commits.length > 0;
  const line = receiptLine(r);
  const checks = checksWord(r.checks);
  const checksOk = receiptChecksOk(r.checks);
  const clock = r.at != null ? hhmm(r.at) : "";
  const parts = (
    <>
      {clock && <span>{clock}</span>}
      {line.map((bit) => (
        <span key={bit} data-tone={bit === checks ? (checksOk ? "ok" : "err") : undefined}>{bit}</span>
      ))}
      {r.agent && <span>{r.agent}</span>}
    </>
  );
  return (
    <div className="rc" data-open={open ? "" : undefined}>
      <div className="rc-top">
        {can ? (
          <button type="button" className="rc-row" aria-expanded={open} aria-label="Turn receipt"
                  onClick={() => setOpen((o) => !o)}>
            <span className="rc-bits">{parts}</span>
            <ChevronDown size={12} aria-hidden className={`mt-0.5 flex-none ${open ? "" : "-rotate-90"}`} />
          </button>
        ) : (
          <div className="rc-row"><span className="rc-bits">{parts}</span></div>
        )}
        {r.prs.map((p) => (
          <a key={p.url} className="rc-pr" href={p.url} target="_blank" rel="noreferrer">
            {p.label} <ExternalLink size={10} aria-hidden />
          </a>
        ))}
      </div>
      {open && <Details r={r} />}
    </div>
  );
}
