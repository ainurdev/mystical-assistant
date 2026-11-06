import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Ban, Check, ChevronDown, CircleCheck, CircleX, FileText, KeyRound, ScrollText, ShieldAlert, X } from "lucide-react";
import { api, type RunEvent } from "../api";
import { checksLine } from "../lib/receipt";
import { Markdown } from "./Markdown";
import { Spinner } from "./ui";

/* The rows and cards for what the bridge's own tools record (bridge/gateway_tools.py,
   bridge/rules.py). All of them draw only while Settings ▸ Experimental is on. */

/** run_checks' result: pass or fail, the numbers, how they stand against the known
 *  failures, and the output behind the chevron. New failures stay in view: they're
 *  the reason you'd look. */
export function ChecksRow({ ev }: { ev: Extract<RunEvent, { type: "checks" }> }) {
  const [open, setOpen] = useState(false);
  const shown = ev.new.slice(0, 5);
  return (
    <div>
      <button type="button" className="zrow ma-checks" data-err={ev.ok ? undefined : ""} aria-expanded={open} onClick={() => setOpen((o) => !o)}
        title={ev.command} style={{ ["--m" as string]: ev.ok ? "var(--ok)" : "var(--err)" }}>
        <i className="ax-bar" aria-hidden>{ev.ok ? <CircleCheck size={14} /> : <CircleX size={14} />}</i>
        <span className="ax-tagcell"><span className="ax-tag">CHECKS</span></span>
        <span className="zo">{ev.ok ? "Passed" : "Failed"} · {checksLine(ev)}</span>
        <span className="ax-stat">{ev.ms >= 1000 ? `${(ev.ms / 1000).toFixed(1)}s` : null}</span>
        <span className="ax-chev"><ChevronDown size={12} aria-hidden className={`transition-transform duration-200 ${open ? "" : "-rotate-90"}`} /></span>
      </button>
      {shown.length > 0 && (
        <ul className="ma-new">
          {shown.map((t) => <li key={t}>{t}</li>)}
          {ev.new.length > shown.length && <li className="more">{ev.new.length - shown.length} more</li>}
        </ul>
      )}
      {open && (
        <div className="ma-out">
          <div className="ma-out-cmd">$ {ev.command}</div>
          {ev.known.length > 0 && <div className="ma-out-known">Already known: {ev.known.join(", ")}</div>}
          {ev.tail && <pre>{ev.tail}</pre>}
          {ev.log && <div className="ma-out-log">Full output: {ev.log}</div>}
        </div>
      )}
    </div>
  );
}

/** A rule of yours acted on a call: quiet, unless it stopped it. */
export function RuleRow({ ev }: { ev: Extract<RunEvent, { type: "rule" }> }) {
  const blocked = ev.decision === "blocked";
  return (
    <div role="note" className="zrow ma-rule" data-err={blocked ? "" : undefined} title={ev.why}
      style={{ ["--m" as string]: blocked ? "var(--err)" : "var(--txl)" }}>
      <i className="ax-bar" aria-hidden><ShieldAlert size={14} /></i>
      <span className="ax-tagcell"><span className="ax-tag">RULE</span></span>
      <span className="zo">
        <span className="ma-rule-h">{blocked ? "Blocked by rule" : `Rule ${ev.decision}`}: {ev.rule}</span>
        {ev.tool && <span className="ma-rule-t"> · {ev.tool}</span>}
        {ev.why && <span className="ma-rule-w"> · {ev.why}</span>}
      </span>
    </div>
  );
}

function fmtBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

/** A report's text, in a panel over the chat. */
function ReportPanel({ session, path, title, onClose }: { session: string; path: string; title: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const shut = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let live = true;
    api.chatReport(session, path).then((r) => { if (live) setText(r.text); }, (e: Error) => { if (live) setErr(e.message || "failed"); });
    return () => { live = false; };
  }, [session, path]);
  useEffect(() => {
    shut.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="agm-scrim" onClick={onClose}>
      <div className="ma-report" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="ma-report-head">
          <ScrollText size={14} strokeWidth={2} aria-hidden />
          <b>{title}</b>
          <span className="ma-report-path" title={path}>{path}</span>
          <button ref={shut} type="button" className="ma-link" onClick={onClose} aria-label="Close the report"><X size={15} aria-hidden /></button>
        </div>
        <div className="ma-report-body">
          {err ? <p className="ma-report-err">The report can't be read: {err}. It may have moved or been deleted.</p>
            : text === null ? <p className="ma-report-wait"><Spinner className="h-3 w-3 border" /> Reading…</p>
            : <Markdown className="leading-relaxed">{text}</Markdown>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** show_report: a card rather than a wall of pasted Markdown. */
export function ReportCard({ ev, session }: { ev: Extract<RunEvent, { type: "report" }>; session?: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ml-[var(--rail)]">
      <button type="button" className="ma-rep" onClick={() => setOpen(true)} disabled={!session} title={ev.path}>
        <FileText size={16} strokeWidth={1.8} aria-hidden />
        <span className="ma-rep-t">
          <b>{ev.title}</b>
          {ev.summary && <span>{ev.summary}</span>}
        </span>
        <span className="ma-rep-m">{fmtBytes(ev.bytes)}</span>
        <span className="ma-rep-go">Open</span>
      </button>
      {open && session && <ReportPanel session={session} path={ev.path} title={ev.title} onClose={() => setOpen(false)} />}
    </div>
  );
}

type SecretRespond = (requestId: string, opts: { answers: { value: string }[] }) => unknown;

/** The form a secret is typed into, in the dock or in the turn. The value lives in this
 *  component's state and nowhere else: not a draft, not localStorage, and it's a plain
 *  block rather than a <form> so a password manager has no submit to offer saving.
 *  It goes straight to the respond route, and the turn only ever hears whether it came. */
export function SecretForm({ requestId, name, onRespond, autoFocus }: {
  requestId: string; name: string; onRespond: SecretRespond; autoFocus?: boolean;
}) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState<"save" | "decline" | null>(null);
  const [failed, setFailed] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (autoFocus) input.current?.focus(); }, [autoFocus]);
  useEffect(() => {
    // "answer below", from where it was asked. The box takes focus too, so this waits a tick.
    const f = () => setTimeout(() => input.current?.focus(), 0);
    window.addEventListener("ask:focus", f);
    return () => window.removeEventListener("ask:focus", f);
  }, []);
  async function send(how: "save" | "decline") {
    if (sending || (how === "save" && !value)) return;
    setSending(how);
    setFailed(false);
    const res = await onRespond(requestId, { answers: how === "save" ? [{ value }] : [] });
    if (res === false) { setSending(null); setFailed(true); return; }
    setValue("");
  }
  return (
    <>
      <input
        ref={input}
        className="ma-input ma-secret-in"
        type="password"
        name={`mystical-card-${requestId}`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void send("save"); } }}
        autoComplete="new-password"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-1p-ignore=""
        data-lpignore="true"
        data-form-type="other"
        aria-label={`Value for ${name}`}
        placeholder={`Paste ${name}`}
        disabled={!!sending}
      />
      <div className="ad-acts">
        <button type="button" className="ad-btn" data-pri="" disabled={!!sending || !value} onClick={() => void send("save")}>
          {sending === "save" ? <Spinner className="h-3 w-3 border" /> : <Check size={13} strokeWidth={2.6} aria-hidden />}Save
        </button>
        <button type="button" className="ad-btn" disabled={!!sending} onClick={() => void send("decline")}>
          {sending === "decline" ? <Spinner className="h-3 w-3 border" /> : <Ban size={13} strokeWidth={2.2} aria-hidden />}Decline
        </button>
        <span className="ad-aside">goes straight to this project's .env, not through the chat</span>
      </div>
      {failed && <p className="ad-err">That didn't reach the bridge. Try again.</p>}
    </>
  );
}

/** request_secret, waiting, where the prompt box can't take it (a card in the turn). */
export function SecretCard({ ev, onRespond }: { ev: Extract<RunEvent, { type: "secret_request" }>; onRespond: SecretRespond }) {
  return (
    <div className="ma-secret">
      <div className="ma-secret-h"><KeyRound size={13} strokeWidth={2.2} aria-hidden /><span>Needs a secret</span><b>{ev.name}</b></div>
      {ev.why && <p>{ev.why}</p>}
      <SecretForm requestId={ev.request_id} name={ev.name} onRespond={onRespond} />
    </div>
  );
}

/** After: only that it was saved or declined. The value was never in this chat. */
export function SecretRecord({ name, why, given, stale }: { name: string; why?: string; given?: boolean; stale?: boolean }) {
  const word = given === true ? "saved" : given === false ? "declined" : stale ? "not answered" : "waiting";
  return (
    <div className="ma-secret-rec" data-given={given === true ? "" : undefined} title={why}>
      <KeyRound size={12} strokeWidth={2.2} aria-hidden />
      <b>{name}</b><span>{word}</span>
    </div>
  );
}
