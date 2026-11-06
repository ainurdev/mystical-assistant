import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { HandoffPreview, SwitchScope } from "../lib/api";
import { Banner } from "./ui";

const kilo = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`);

/** Before a provider switch moves history: what goes where, and whether it fits.
 *  Portalled, because the composer's fixed bar is a stacking context the sticky
 *  CHAT | AGENTS bar sits above. */
export function SwitchSheet({ preview: p, busy, error, onPick, onCancel }: {
  preview: HandoffPreview;
  busy: boolean;
  error: string | null;
  onPick: (scope: SwitchScope) => void;
  onCancel: () => void;
}) {
  const btn = "min-h-[46px] w-full text-[11.5px] tracking-[.12em] active:opacity-70 disabled:opacity-40";
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/50" onClick={onCancel}>
      <div
        role="dialog"
        aria-label={`Switch from ${p.from} to ${p.to}`}
        className="mx-auto w-full max-w-screen-sm border-t border-border-bright bg-[var(--tg-bg)] px-3.5 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] shadow-[0_-16px_44px_rgba(0,0,0,0.6)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 py-2">
          <span className="text-[9.5px] tracking-[2px] text-[var(--brand-soft)]">SWITCH AGENT</span>
          <button onClick={onCancel} aria-label="Cancel" className="ml-auto flex h-10 w-10 flex-none items-center justify-center"><X size={16} /></button>
        </div>
        <div className="break-words text-[17px] font-semibold text-[var(--foreground-bright)]">
          {p.from} <span className="text-[var(--brand-soft)]">{"→"}</span> {p.to}
        </div>
        <p className="mt-1 text-[13px] leading-snug text-[var(--tg-hint)]">
          {p.resumes
            ? `${p.to} picks its own session back up and gets what it missed.`
            : `${p.to} starts a new session and gets this chat as text. Tool output goes in a file it can open.`}
        </p>
        <div className="mt-3 grid grid-cols-3 gap-px border border-border bg-[var(--border)] text-center">
          {[["TURNS", `${p.turns}`], ["TOKENS", `~${kilo(p.tokens)}`], ["BUDGET", kilo(p.budget)]].map(([k, v]) => (
            <div key={k} className="bg-[var(--tg-bg)] px-1 py-2">
              <div className="text-[15px] tabular-nums text-[var(--foreground-bright)]" style={k === "TOKENS" && !p.fits ? { color: "var(--warning)" } : undefined}>{v}</div>
              <div className="text-[9px] tracking-[1.5px] text-[var(--muted-2)]">{k}</div>
            </div>
          ))}
        </div>
        {!p.fits && (
          <div className="mt-2 border-l-2 border-[var(--warning)] py-1 pl-2.5 text-[13px] leading-snug text-[var(--warning)]">
            This is too much for {p.to} to take at once. It gets the newest part and the oldest is left out. The file still holds everything.
          </div>
        )}
        {error && <div className="mt-2"><Banner tone="error">{error}</Banner></div>}
        <div className="mt-3 space-y-1.5">
          <button type="button" disabled={busy} onClick={() => onPick("whole")} className={`${btn} bg-primary text-primary-foreground`}>
            SEND WHOLE CHAT
          </button>
          {p.turns > p.recent && (
            <button type="button" disabled={busy} onClick={() => onPick("recent")} className={`${btn} border border-border-bright text-[var(--brand-soft)]`}>
              LAST {p.recent} TURNS ONLY
            </button>
          )}
          <button type="button" disabled={busy} onClick={onCancel} className={`${btn} text-[var(--tg-hint)]`}>CANCEL</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
