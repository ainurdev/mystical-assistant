import { useEffect, useRef, useState } from "react";

/* The HUD's own confirm/prompt, so a destructive answer isn't asked for in the
   browser's own chrome (which ignores the theme and lands wherever the OS puts
   it). Same shape as window.confirm/window.prompt — await the answer instead of
   reading it back — so a call site swaps one word, and names its action: the
   button says "Delete", never OK, and an ask that destroys work says `danger`.
   ponytail: one mounted host and a module-level handoff, not a provider tree. */
type Ask = {
  kind: "confirm" | "prompt";
  text: string;
  value: string;
  ok: string;
  danger: boolean;
  done: (v: boolean | string | null) => void;
};

let host: ((a: Ask) => void) | null = null;

export function askConfirm(text: string, { ok = "OK", danger = false }: { ok?: string; danger?: boolean } = {}): Promise<boolean> {
  if (!host) return Promise.resolve(window.confirm(text)); // asked before the HUD mounted
  return new Promise((done) => host?.({ kind: "confirm", text, value: "", ok, danger, done: done as Ask["done"] }));
}

export function askPrompt(text: string, value = "", ok = "OK"): Promise<string | null> {
  if (!host) return Promise.resolve(window.prompt(text, value));
  return new Promise((done) => host?.({ kind: "prompt", text, value, ok, danger: false, done: done as Ask["done"] }));
}

export function AskDialog() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [val, setVal] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    host = (a) => { setVal(a.value); setAsk(a); };
    return () => { host = null; };
  }, []);
  useEffect(() => { if (ask?.kind === "prompt") input.current?.select(); }, [ask]);

  if (!ask) return null;
  const close = (v: boolean | string | null) => { ask.done(v); setAsk(null); };
  const accept = () => close(ask.kind === "prompt" ? val : true);
  const cancel = () => close(ask.kind === "prompt" ? null : false);
  // The question is the title; whatever follows its last "? " explains it.
  const m = ask.text.match(/^(.*\?)\s+(.+)$/s);

  return (
    <div onClick={cancel}
      style={{ position: "fixed", inset: 0, background: "color-mix(in srgb, var(--panel3) 74%, transparent)", zIndex: 96, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "22vh", animation: "backdropIn .2s ease both" }}>
      <div role="dialog" aria-modal aria-labelledby="ask-title" onClick={(e) => e.stopPropagation()} className="panel ask"
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); cancel(); } }}
        style={{ width: 460, maxWidth: "94vw", border: "1px solid color-mix(in srgb, var(--acc) 40%, transparent)", background: "color-mix(in srgb, var(--panel2) 98%, transparent)", boxShadow: "0 0 60px var(--shadow-modal)", animation: "mslide .2s ease both" }}>
        <div style={{ padding: "18px 18px 16px", display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ wordBreak: "break-word" }}>
            <div id="ask-title" style={{ fontSize: "var(--t13)", fontWeight: 600, color: "var(--txh)", lineHeight: 1.45 }}>{m ? m[1] : ask.text}</div>
            {m && <div style={{ marginTop: 6, fontSize: "var(--t12)", color: "var(--txm)", lineHeight: 1.55 }}>{m[2]}</div>}
          </div>
          {ask.kind === "prompt" && (
            <input ref={input} autoFocus value={val} onChange={(e) => setVal(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); accept(); } }}
              style={{ appearance: "none", width: "100%", border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)", background: "color-mix(in srgb, var(--panel3) 60%, transparent)", color: "var(--txb)", fontFamily: "inherit", fontSize: "var(--t125)", padding: "8px 11px", outline: "none" }} />
          )}
          {/* Enter presses whichever button has the focus; on a destructive ask that's Cancel. */}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 9 }}>
            <button className="act-alt neutral caps" onClick={cancel} autoFocus={ask.kind === "confirm" && ask.danger}>Cancel</button>
            <button className={`act-pri caps${ask.danger ? " danger" : ""}`} onClick={accept} autoFocus={ask.kind === "confirm" && !ask.danger}>{ask.ok}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
