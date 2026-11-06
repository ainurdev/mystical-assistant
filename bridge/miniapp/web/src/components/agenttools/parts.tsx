import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { ApiError } from "../../lib/api";
import { errorWords, stateWord, type CellState } from "../../lib/agenttools";
import { telegramBack } from "../../lib/telegram";

/* What every AGENT TOOLS pane is made of: 44 px targets (.stoggle alone is 36 by 21), the
   sheet and confirm, and the three states a read can be in besides loaded. */

// Telegram's back arrow is one button, and each layer that showed it would hide it again on
// the way out. So one callback closes whichever layer is on top.
const layers: (() => void)[] = [];
let undoBack: (() => void) | null = null;

export function useBackLayer(close: () => void, active = true) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!active) return;
    const fn = () => latest.current();
    layers.push(fn);
    undoBack ??= telegramBack(() => layers[layers.length - 1]?.());
    return () => {
      layers.splice(layers.indexOf(fn), 1);
      if (!layers.length) { undoBack?.(); undoBack = null; }
    };
  }, [active]);
}

export const messageOf = (e: unknown) =>
  e instanceof ApiError ? errorWords(e.status, e.message) : e instanceof Error ? e.message : "That didn't work.";

/** Changes in flight and what went wrong, by row. A row draws the value it's heading for and
 *  falls back on its own if the change fails: nothing here touches the query cache. */
export function useAct(refresh: () => Promise<unknown>) {
  const [pending, setPending] = useState<Record<string, boolean | null>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const run = async (key: string, target: boolean | null, call: () => Promise<unknown>) => {
    setPending((p) => ({ ...p, [key]: target }));
    setErrors(({ [key]: _gone, ...rest }) => rest);
    try {
      await call();
      await refresh();
    } catch (e) {
      setErrors((x) => ({ ...x, [key]: messageOf(e) }));
    } finally {
      setPending(({ [key]: _gone, ...rest }) => rest);
    }
  };
  return { pending, errors, run };
}

export function Sw({ on, busy, label, onFlip }: { on: boolean; busy?: boolean; label: string; onFlip: () => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} aria-busy={busy || undefined}
      disabled={busy} onClick={onFlip} className="atv-sw">
      <span className="stoggle" data-on={on ? "" : undefined}><i /></span>
    </button>
  );
}

export function Btn({ children, danger, primary, full, disabled, onClick, ariaLabel }: {
  children: ReactNode; danger?: boolean; primary?: boolean; full?: boolean; disabled?: boolean; onClick: () => void; ariaLabel?: string;
}) {
  return (
    <button type="button" className="atv-btn" data-danger={danger || undefined} data-primary={primary || undefined}
      data-full={full || undefined} disabled={disabled} onClick={onClick} aria-label={ariaLabel}>
      {children}
    </button>
  );
}

export const StateTag = ({ state }: { state: CellState }) => (
  <span className="atv-tag" data-state={state}>{stateWord(state)}</span>
);

export const Loading = ({ what }: { what: string }) => <div className="atv-note" role="status">reading {what}…</div>;

export const Empty = ({ children }: { children: ReactNode }) => <div className="atv-empty">{children}</div>;

export function Fail({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="atv-err" role="alert">
      <div>{messageOf(error)}</div>
      {onRetry && <div className="mt-2"><Btn onClick={onRetry}>TRY AGAIN</Btn></div>}
    </div>
  );
}

export const RowError = ({ text }: { text?: string }) => (text ? <div className="atv-err" role="alert">{text}</div> : null);

export function Filter({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={label} aria-label={label}
      className="atv-input" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
  );
}

/** A bottom sheet over the view. Portalled like every sheet here, tall content scrolls inside it. */
export function Sheet({ title, onClose, children, footer }: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode;
}) {
  useBackLayer(onClose);
  return createPortal(
    <div className="fixed inset-0 z-[55] flex flex-col justify-end bg-black/50" onClick={onClose}>
      <div role="dialog" aria-label={title} className="atv-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 pl-3.5 pr-1">
          <span className="min-w-0 flex-1 truncate text-[10px] tracking-[2px] text-[var(--brand-soft)]">{title.toUpperCase()}</span>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-11 w-11 flex-none items-center justify-center"><X size={16} aria-hidden /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3.5 pb-3">{children}</div>
        {footer && <div className="flex-none space-y-1.5 border-t border-border px-3.5 pt-2.5 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Says what happens and asks once. A failure stays in the sheet, next to the button that caused it. */
export function Confirm({ title, body, ok, danger, onOk, onCancel }: {
  title: string; body: ReactNode; ok: string; danger?: boolean; onOk: () => Promise<void> | void; onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await onOk();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  return (
    <Sheet title={title} onClose={onCancel} footer={
      <>
        <Btn full primary={!danger} danger={danger} disabled={busy} onClick={() => void go()}>{busy ? "WORKING…" : ok}</Btn>
        <Btn full disabled={busy} onClick={onCancel}>CANCEL</Btn>
      </>
    }>
      <div className="atv-confirm">{body}</div>
      {error ? <Fail error={error} /> : null}
    </Sheet>
  );
}
