import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, CornerDownRight } from "lucide-react";
import type { ToolStyle } from "../lib/toolwidget";
import { Markdown } from "./Markdown";

/* The transcript's multi-agent rows (RunStream, run.tsx). Each is one line or a
   small note, so they read as things that happened around the conversation. */

/** "Switched to Kimi Code": the seam in a chat that changed provider. */
export function SwitchDivider({ from, to, turns, whole }: { from: string; to: string; turns: number; whole: boolean }) {
  const sent = turns === 0 ? "nothing new to tell it"
    : whole ? `${turns} turn${turns === 1 ? "" : "s"} sent`
    : `newest ${turns} turn${turns === 1 ? "" : "s"} sent`;
  return (
    <div className="ms-rule py-1" role="separator">
      <i aria-hidden />
      <span>{"⇄"} {from.toUpperCase()} {"→"} {to.toUpperCase()} · {sent}</span>
      <i aria-hidden />
    </div>
  );
}

/** A helper started: who, what it was asked, and a way in. */
export function DelegationRow({ name, brief, agent, profile, write, onOpen }: {
  name: string; brief: string; agent: string; profile?: string | null; write?: boolean;
  onOpen?: () => void;
}) {
  const inner = (
    <>
      <CornerDownRight size={13} className="flex-none text-[var(--brand-soft)]" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium text-[var(--foreground-bright)]">{name}</span>
        <span className="block truncate text-[10.5px] tracking-wide text-[var(--muted-2)]">
          {[agent, profile, write ? "own copy" : "read only"].filter(Boolean).join(" · ")}
        </span>
        {brief && <span className="mt-0.5 line-clamp-2 block text-[12px] leading-snug text-[var(--tg-hint)]">{brief}</span>}
      </span>
      {onOpen && <ChevronRight size={14} className="flex-none text-[var(--muted-2)]" aria-hidden />}
    </>
  );
  return onOpen
    ? <button type="button" className="ms-del" onClick={onOpen}>{inner}</button>
    : <div className="ms-del">{inner}</div>;
}

const MERGE_WORD: Record<string, string> = {
  merged: "changes are in your folder, uncommitted",
  conflict: "doesn't apply cleanly, nothing changed",
  undone: "merge taken back out",
  discarded: "copy thrown away",
};

export function MergeLine({ name, state }: { name: string; state: string }) {
  const bad = state === "conflict";
  return (
    <div className="ms-rule py-0.5" style={bad ? { color: "var(--err)" } : undefined}>
      <span className="text-left normal-case tracking-normal">
        {"⎇"} {name}: {MERGE_WORD[state] ?? state}
      </span>
    </div>
  );
}

const CLAMP = 280;

/** Another agent talking in this chat: a note coming in, never your bubble. */
export function IncomingNote({ from, label, body }: { from: string; label: string; body: string }) {
  const [open, setOpen] = useState(false);
  const long = body.length > CLAMP;
  return (
    <div className="ms-note">
      <div className="ms-who">
        <span aria-hidden>{"⇄"}</span>
        <b>{from.toUpperCase()}</b>
        <span className="ml-auto flex-none opacity-70">{label}</span>
      </div>
      <div className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-normal text-[var(--foreground)]">
        {open || !long ? body : `${body.slice(0, CLAMP)}…`}
      </div>
      {long && (
        <button type="button" className="ms-said-more" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "LESS" : "MORE"}
        </button>
      )}
    </div>
  );
}

/** What a non-Claude agent said while it worked (lib/said): the latest showing, the
 *  older behind a count. A turn that ended with no answer says so on its last note,
 *  since that note is all you got. */
export function SaidTier({ notes, end, rail, toolStyle }: {
  notes: string[];
  end: "stopped" | "cut" | null;
  rail: ReactNode;
  toolStyle: ToolStyle;
}) {
  const [open, setOpen] = useState(false);
  if (!notes.length) return null;
  const older = notes.slice(0, -1);
  const bubble = (text: string, key: number) => (
    <div key={key} className="relative -ml-3 flex pl-3">
      {rail}
      <Markdown className="abub min-w-0 max-w-[85%] break-words rounded-2xl rounded-bl-sm border border-border bg-[var(--ac-06)] px-3 py-2 text-sm leading-normal" toolStyle={toolStyle}>
        {text}
      </Markdown>
    </div>
  );
  return (
    <div className="space-y-1.5">
      {older.length > 0 && (
        <button type="button" className="ms-said-more" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <ChevronDown size={11} aria-hidden className={open ? "" : "-rotate-90"} />
          {older.length} EARLIER NOTE{older.length === 1 ? "" : "S"}
        </button>
      )}
      {open && older.map(bubble)}
      <div>
        <div className="ms-said-lab" data-end={end ? "" : undefined}>
          {end === "stopped" ? "STOPPED · ITS LAST NOTE, NO ANSWER"
            : end === "cut" ? "CUT OFF · ITS LAST NOTE, NO ANSWER" : "SAID TO YOU"}
        </div>
        {bubble(notes[notes.length - 1], notes.length)}
      </div>
    </div>
  );
}
