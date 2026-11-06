import { useEffect, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Ban, Check, ChevronDown, CircleSlash, FileText, KeyRound, ScrollText, X } from "lucide-react";
import { api, ApiError, type SecretAnswer } from "../lib/api";
import { testWords } from "../lib/bashkind";
import { useChat } from "../lib/chat";
import { shortTime } from "../lib/receipt";
import { Markdown } from "./Markdown";
import { Button, Card, Spinner } from "./ui";

/* What the Mystical tools put in a transcript (bridge/gateway_tools.py, bridge/rules.py):
   a recorded test run, a report, a request for a key, a rule that fired. */

const NEW_SHOWN = 5;

/** A run_checks result, compared with the failures already known. `ok` is the bridge's
 *  reading: seven failures it already knew about is still a pass. */
export function ChecksRow({ ev }: { ev: {
  command: string; ok: boolean; code: number; ms: number;
  passed: number | null; failed: number | null; skipped: number | null;
  new: string[]; known: string[]; log: string; tail: string;
} }) {
  const [open, setOpen] = useState(false);
  const counts = testWords({
    ...(ev.passed != null ? { passed: ev.passed } : {}),
    ...(ev.failed != null ? { failed: ev.failed } : {}),
    ...(ev.skipped != null ? { skipped: ev.skipped } : {}),
  });
  const said = counts || (ev.ok ? "passed" : `exit code ${ev.code}`);
  const quietFails = ev.ok && ev.known.length > 0;
  return (
    <div className="ck" data-ok={ev.ok ? "" : undefined}>
      <button type="button" className="ck-row" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {ev.ok
          ? <Check size={12} className="flex-none" style={{ color: "var(--ok)" }} aria-hidden />
          : <X size={12} className="flex-none" style={{ color: "var(--err)" }} aria-hidden />}
        <span className="ck-tag">{ev.ok ? "CHECKS" : "CHECKS FAILED"}</span>
        <span className="min-w-0 flex-1 truncate">{said}</span>
        {ev.ms >= 1000 && <span className="flex-none text-[10px] text-[var(--muted-2)]">{shortTime(ev.ms / 1000)}</span>}
        <ChevronDown size={12} aria-hidden className={`flex-none ${open ? "" : "-rotate-90"}`} />
      </button>
      {quietFails && <div className="ck-sub">All {ev.known.length} failures were already known, none are new.</div>}
      {ev.new.length > 0 && (
        <div className="ck-new">
          <div>{ev.new.length} new failure{ev.new.length === 1 ? "" : "s"}</div>
          {(open ? ev.new : ev.new.slice(0, NEW_SHOWN)).map((n) => <code key={n}>{n}</code>)}
          {!open && ev.new.length > NEW_SHOWN && <span>+{ev.new.length - NEW_SHOWN} more</span>}
        </div>
      )}
      {open && (
        <div className="ck-more">
          <code className="break-all">{ev.command}</code>
          {ev.known.length > 0 && !quietFails && <div className="ck-sub !px-0">{ev.known.length} already known</div>}
          {ev.log && <div className="ck-sub !px-0">Full output: {ev.log}</div>}
          {ev.tail && <pre>{ev.tail}</pre>}
        </div>
      )}
    </div>
  );
}

const sizeOf = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

/** A report, full screen. Portaled to <body>: a transcript row is translateY'd, which
 *  would make position:fixed resolve against the row (see ImageLightbox). */
function ReportSheet({ path, title, onClose }: { path: string; title: string; onClose: () => void }) {
  const { sessionId } = useChat();
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: ["chat-report", sessionId, path],
    queryFn: () => api.chatReport(sessionId as string, path),
    enabled: sessionId !== null,
    retry: false,
    staleTime: 0,
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const missing = error instanceof ApiError && error.status === 404;
  return createPortal(
    <div className="rp-sheet" role="dialog" aria-modal="true" aria-label={title}>
      <header className="rp-head">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-[var(--foreground-bright)]">{title}</div>
          <div className="truncate text-[10.5px] text-[var(--muted-2)]">{path}</div>
        </div>
        <button type="button" className="rp-close" aria-label="Close" onClick={onClose}><X size={18} aria-hidden /></button>
      </header>
      <div className="rp-body">
        {isLoading && <div className="flex justify-center py-10"><Spinner /></div>}
        {missing && <p className="rp-empty">This file isn't in the project any more.</p>}
        {error && !missing && (
          <div className="rp-empty">
            <p>Couldn't load the report.</p>
            <button type="button" className="ms-said-more" onClick={() => void refetch()}>TRY AGAIN</button>
          </div>
        )}
        {data && (data.text.trim()
          ? <Markdown className="text-sm leading-normal">{data.text}</Markdown>
          : <p className="rp-empty">This file is empty.</p>)}
      </div>
    </div>,
    document.body,
  );
}

export function ReportCard({ path, title, summary, bytes }: {
  path: string; title: string; summary?: string; bytes?: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="rp-card" onClick={() => setOpen(true)}>
        <FileText size={16} className="mt-0.5 flex-none text-[var(--brand-soft)]" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium leading-snug text-[var(--foreground-bright)]">{title}</span>
          {summary && <span className="mt-0.5 line-clamp-3 block text-[12px] leading-snug text-[var(--tg-hint)]">{summary}</span>}
          <span className="mt-1 flex gap-1.5 text-[10px] text-[var(--muted-2)]">
            <span className="min-w-0 truncate">{path}</span>
            {bytes ? <span className="flex-none">{"·"} {sizeOf(bytes)}</span> : null}
          </span>
        </span>
        <span className="rp-open">READ</span>
      </button>
      {open && <ReportSheet path={path} title={title} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The agent asking for a key. What you type lives in this component's state and goes
 *  to the respond route, and nowhere else: not a draft, not the event log (the bridge
 *  records only whether one was given), not the DOM's value after it's sent. */
export function SecretCard({ name, why, active, given, stale, onAnswer }: {
  name: string;
  why: string;
  active: boolean;
  /** From `secret_answered`. Undefined until it's been answered. */
  given?: boolean;
  stale?: boolean;
  onAnswer: (answers: SecretAnswer[]) => void | Promise<boolean | void>;
}) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState<"save" | "decline" | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { if (!active) setValue(""); }, [active]);

  async function send(which: "save" | "decline") {
    if (sending) return;
    setSending(which);
    setFailed(false);
    const said = await onAnswer(which === "save" ? [{ value: value.trim() }] : []);
    if (said === false) {
      setSending(null);
      setFailed(true);
      return;
    }
    setValue("");
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) void send("save");
  };

  if (given !== undefined || !active) {
    return (
      <div className="sc-done">
        {given === true ? <Check size={13} className="flex-none text-green-400" aria-hidden />
          : given === false ? <X size={13} className="flex-none text-[var(--tg-hint)]" aria-hidden />
          : <CircleSlash size={13} className="flex-none text-amber-400" aria-hidden />}
        <code className="min-w-0 truncate">{name}</code>
        <span className="flex-none">
          {given === true ? "saved" : given === false ? "declined" : stale ? "never answered, the run ended" : "not answered"}
        </span>
      </div>
    );
  }
  return (
    <Card className="chatcard space-y-2 border border-[var(--tg-button)]/30">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <KeyRound size={15} className="shrink-0 text-[var(--brand-soft)]" aria-hidden />
        <span className="min-w-0 break-words">Needs <code className="font-semibold">{name}</code></span>
      </div>
      {why && <div className="text-[13px] leading-snug text-[var(--tg-hint)]">{why}</div>}
      <form className="space-y-2" onSubmit={submit} autoComplete="off">
        <input
          type="password"
          className="sc-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={!!sending}
          placeholder="Paste it here"
          aria-label={`Value for ${name}`}
          autoComplete="new-password"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
        />
        <div className="text-[11px] leading-snug text-[var(--muted-2)]">
          Goes straight to this project's .env. The agent and the chat never see it.
        </div>
        {failed && <div className="text-[11px] text-[var(--err)]">That didn't reach the bridge. Try again.</div>}
        <div className="flex gap-2">
          <Button type="submit" className="flex-1" disabled={!!sending || !value.trim()}>
            {sending === "save" ? <Spinner className="h-3 w-3 border" /> : "Save"}
          </Button>
          <Button type="button" variant="secondary" className="flex-1" disabled={!!sending} onClick={() => void send("decline")}>
            {sending === "decline" ? <Spinner className="h-3 w-3 border" /> : "Decline"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** A rule that fired. Only "blocked" stopped anything. The others (formatted a file,
 *  hid a secret in output, pinged you) get said as what they did. */
export function RuleLine({ rule, decision, tool, why }: {
  rule: string; decision: string; tool?: string; why?: string;
}) {
  const [open, setOpen] = useState(false);
  const blocked = decision === "blocked";
  const words = blocked ? `Blocked by rule: ${rule}` : `Rule: ${rule} · ${decision}`;
  const more = [tool, why].filter(Boolean).join(" · ");
  const body = (
    <>
      {blocked ? <Ban size={12} className="mt-px flex-none" aria-hidden /> : <ScrollText size={12} className="mt-px flex-none" aria-hidden />}
      <span className="min-w-0 flex-1">
        {words}
        {open && <span className="rl-why">{more}</span>}
      </span>
    </>
  );
  const tone = blocked ? "err" : undefined;
  return more
    ? <button type="button" className="rl" data-tone={tone} aria-expanded={open} onClick={() => setOpen((o) => !o)}>{body}</button>
    : <div className="rl" data-tone={tone}>{body}</div>;
}
