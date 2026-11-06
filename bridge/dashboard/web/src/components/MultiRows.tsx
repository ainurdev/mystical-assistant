import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeftRight, ChevronDown, ChevronRight, GitMerge, MessageCircle, UserPlus } from "lucide-react";
import { openSession } from "../lib/devicerun";
import { hhmm } from "../lib/surfaces";
import { mergeLine, rowTags, statusWord, type Frame } from "../lib/multi";
import { useMemberRow } from "../lib/multistore";
import { Markdown } from "./Markdown";

/* The transcript's rows for a multi-agent chat (RunStream). All of them are one
   line unless you open them: a one-agent chat draws none, and a many-agent one
   should still read as your conversation. */

/** A small state mark: a helper's copy of the code (lib/multi rowTags). */
export function RowTag({ text, tone, title }: { text: string; tone: string; title: string }) {
  return <span className="ma-tag" data-tone={tone} title={title}>{text}</span>;
}

/** What a non-Claude agent told you on the way (lib/dossier zonesWithSaid): its
 *  newest note on show, older ones behind a count. `ending`: this note is all the
 *  turn left, because it was stopped or cut off, and it says so. */
export function SaidTier({ count, latest, older, ending, reveal = 0 }: {
  /** Changes when a note in here was asked for: the earlier ones open. */
  reveal?: number;
  count: number;
  latest: ReactNode;
  older: () => ReactNode;
  ending?: "stopped" | "cut" | null;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (reveal) setOpen(true); }, [reveal]);
  const earlier = count - 1;
  return (
    <section className="ma-said" aria-label="Said to you">
      <div className="ma-said-head">
        <MessageCircle size={12} strokeWidth={1.8} aria-hidden />
        <span>{ending === "stopped" ? "Last note before it was stopped" : ending === "cut" ? "Last note · the turn was cut off with no answer" : "Said to you"}</span>
        {earlier > 0 && (
          <button type="button" className="ma-said-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? <ChevronDown size={11} aria-hidden /> : <ChevronRight size={11} aria-hidden />}
            {earlier} earlier
          </button>
        )}
      </div>
      {open && earlier > 0 && <div className="ma-said-older">{older()}</div>}
      {latest}
    </section>
  );
}

/** A ⇄ message: from another agent, so never drawn as something you typed. */
export function IncomingNote({ frame, at }: { frame: Frame; at?: number }) {
  const who = frame.kind === "agent" ? `${frame.from} ${frame.verb}` : frame.kind === "brief" ? "Brief from the main agent" : "From Mystical";
  return (
    <div className="ma-in" role="note">
      <div className="ma-in-head">
        <ArrowLeftRight size={12} strokeWidth={1.8} aria-hidden />
        <span>{who}</span>
        {at !== undefined && <span className="ma-in-at">{hhmm(at)}</span>}
      </div>
      <Markdown className="leading-relaxed">{frame.body}</Markdown>
    </div>
  );
}

/** The chat moved to another provider. */
export function SwitchLine({ to, from, turns, whole }: { to: string; from?: string; turns?: number; whole?: boolean }) {
  const what = turns === undefined ? ""
    : whole ? `${turns} turn${turns === 1 ? "" : "s"} carried over` : `the newest ${turns} turn${turns === 1 ? "" : "s"} carried over, the rest in a file`;
  return (
    <div role="note" className="zrow text-muted-2 ma-line" style={{ ["--m" as string]: "var(--txm)" }}
      title={[from && `From ${from}`, what].filter(Boolean).join(" · ") || undefined}>
      <i className="ax-bar" aria-hidden><ArrowLeftRight size={14} /></i>
      <span className="zo flex items-center gap-3">
        <span className="flex-none text-[length:var(--t10)] uppercase tracking-[2px]">Switched to {to}</span>
        <span aria-hidden className="flex-1 border-t border-dashed border-border" />
      </span>
    </div>
  );
}

/** A helper's changes moved. */
export function MergeLine({ name, state }: { name: string; state: string }) {
  return (
    <div role="note" className="ma-mline" data-state={state}>
      <GitMerge size={12} strokeWidth={1.8} aria-hidden />
      <span>{mergeLine(name, state)}</span>
    </div>
  );
}

/** Whom the box below is talking to, on a helper's session, and the way back. */
export function TalkingPill({ sessionId, name, provider, chatTitle, onBack }: {
  sessionId: string; name: string; provider?: string; chatTitle: string; onBack: () => void;
}) {
  const row = useMemberRow(sessionId);
  return (
    <span className="ma-talk">
      <span>Talking to <b>{name}</b>{provider ? ` · ${provider}` : ""}{row ? ` · ${row.needs ? "needs you" : statusWord(row.status)}` : ""}</span>
      {row && rowTags(row).map((t) => <RowTag key={t.text} {...t} />)}
      <button type="button" className="ma-link" onClick={onBack} title={`Back to ${chatTitle}`}>back to chat</button>
    </span>
  );
}

/** A helper started: its name and what it was asked, with its live status from the
 *  tree. It opens that agent, in the main pane, with a path back here. */
export function DelegationRow({ sessionId, name, brief, agent, profile, write }: {
  sessionId: string; name: string; brief?: string; agent?: string; profile?: string | null; write?: boolean;
}) {
  const row = useMemberRow(sessionId);
  const running = row?.status === "running";
  return (
    <button type="button" className="ma-deleg" data-live={running || undefined} data-needs={row?.needs || undefined}
      title={brief} onClick={() => openSession(sessionId)}>
      <UserPlus size={13} strokeWidth={1.8} aria-hidden />
      <span className="ma-deleg-name">{name}</span>
      <span className="ma-deleg-meta">{[agent, profile, write ? "own copy" : "read only"].filter(Boolean).join(" · ")}</span>
      {brief && <span className="ma-deleg-brief">{brief.replace(/\s+/g, " ")}</span>}
      {row && rowTags(row).map((t) => <RowTag key={t.text} {...t} />)}
      <span className="ma-deleg-state">{row?.needs ? "needs you" : row ? statusWord(row.status) : ""}</span>
      <ChevronRight size={12} aria-hidden />
    </button>
  );
}
