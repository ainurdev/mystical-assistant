import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeftRight, TriangleAlert } from "lucide-react";
import type { HandoffPreview } from "../lib/multistore";

/* Moving a chat to another provider (plan decision 1). It costs something and
   can't be taken back into the same session, so it gets a moment of its own,
   styled as the limit card is: from and to, what goes, and two ways to send it.
   A Claude account change copies nothing and never comes here. */

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `${n}`);

export function SwitchDialog({ preview, running, onSend, onCancel }: {
  preview: HandoffPreview;
  /** A turn is running: nothing can move until it ends. */
  running: boolean;
  onSend: (scope: "whole" | "recent") => Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  // A disabled button can't take focus: during a turn, Cancel holds it.
  useEffect(() => { (running ? cancel : first).current?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);
  const send = (scope: "whole" | "recent") => {
    setBusy(true);
    setError(null);
    onSend(scope).catch((e: Error) => { setError(e.message); setBusy(false); });
  };
  const { from, to, resumes, turns, tokens, budget, fits, recent } = preview;
  const blocked = running || busy;
  const why = running ? "A turn is running. This can change once it finishes." : undefined;
  return createPortal(
    <div className="agm-scrim" onClick={onCancel}>
      <div className="dlimit ma-switch" role="dialog" aria-modal="true" aria-labelledby="ma-switch-title" onClick={(e) => e.stopPropagation()}>
        <div className="dlimit-head" id="ma-switch-title">
          <ArrowLeftRight size={14} strokeWidth={2} aria-hidden />
          <span>Switch this chat · {from} → {to}</span>
        </div>
        <p className="dlimit-lead">
          {resumes
            ? <><b>{to}</b> picks up its own session here and is told what happened since it left.</>
            : <><b>{to}</b> starts a new session here and reads this chat as its history.</>}
        </p>
        <div className="ma-switch-facts">
          <span><b>{turns}</b> turn{turns === 1 ? "" : "s"}{resumes ? " since it left" : ""}</span>
          <span><b>~{fmt(tokens)}</b> tokens</span>
          <span>room for <b>{fmt(budget)}</b></span>
        </div>
        {!fits && (
          <p className="ma-switch-warn">
            <TriangleAlert size={13} strokeWidth={2} aria-hidden />
            <span>That's more than {to} can take at once. The newest part goes in, and everything stays in a file it can open.</span>
          </p>
        )}
        <p className="dlimit-sub ma-switch-note">Your prompts, its answers, its notes and the names of its tools go in the message. Tool output stays in a file in this project. What's sent goes to {to}'s vendor.</p>
        {why && <p className="dlimit-sub ma-switch-why" role="status">{why}</p>}
        {error && <p className="ma-switch-err" role="alert">{error}</p>}
        <div className="dlimit-acts">
          <button ref={first} type="button" className="dlimit-btn" data-strong disabled={blocked} title={why} onClick={() => send("whole")}>Send whole chat</button>
          {turns > recent && <button type="button" className="dlimit-btn" disabled={blocked || recent < 1} title={why ?? (recent < 1 ? "No turns to send" : undefined)} onClick={() => send("recent")}>Last {recent || 5} turn{recent === 1 ? "" : "s"} only</button> }
          <button ref={cancel} type="button" className="dlimit-btn" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>,
    document.querySelector("[data-theme]") ?? document.body,
  );
}
