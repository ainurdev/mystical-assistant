import { useEffect, useRef, useState, type CSSProperties } from "react";

/* The HUD's own confirm/prompt, so a destructive answer isn't asked for in the
   browser's own chrome (which ignores the theme and lands wherever the OS puts
   it). Same shape as window.confirm/window.prompt — await the answer instead of
   reading it back — so a call site swaps one word.
   ponytail: one mounted host and a module-level handoff, not a provider tree. */
type Ask = {
  kind: "confirm" | "prompt";
  text: string;
  value: string;
  done: (v: boolean | string | null) => void;
};

let host: ((a: Ask) => void) | null = null;

export function askConfirm(text: string): Promise<boolean> {
  if (!host) return Promise.resolve(window.confirm(text)); // asked before the HUD mounted
  return new Promise((done) => host?.({ kind: "confirm", text, value: "", done: done as Ask["done"] }));
}

export function askPrompt(text: string, value = ""): Promise<string | null> {
  if (!host) return Promise.resolve(window.prompt(text, value));
  return new Promise((done) => host?.({ kind: "prompt", text, value, done: done as Ask["done"] }));
}

const btn: CSSProperties = {
  appearance: "none", cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t95)",
  letterSpacing: 1.5, padding: "7px 16px",
};

export function AskDialog() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [val, setVal] = useState("");
  const [hov, setHov] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    host = (a) => { setVal(a.value); setAsk(a); };
    return () => { host = null; };
  }, []);
  useEffect(() => { if (ask?.kind === "prompt") input.current?.select(); }, [ask]);

  if (!ask) return null;
  const close = (v: boolean | string | null) => { ask.done(v); setAsk(null); setHov(""); };
  const accept = () => close(ask.kind === "prompt" ? val : true);
  const cancel = () => close(ask.kind === "prompt" ? null : false);
  const hp = (k: string) => ({ onMouseEnter: () => setHov(k), onMouseLeave: () => setHov("") });

  return (
    <div onClick={cancel}
      style={{ position: "fixed", inset: 0, background: "color-mix(in srgb, var(--panel3) 74%, transparent)", zIndex: 96, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "22vh", animation: "backdropIn .2s ease both" }}>
      <div role="dialog" aria-modal onClick={(e) => e.stopPropagation()} className="panel"
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.stopPropagation(); cancel(); }
          if (e.key === "Enter") { e.preventDefault(); accept(); }
        }}
        style={{ width: 460, maxWidth: "94vw", border: "1px solid color-mix(in srgb, var(--acc) 40%, transparent)", background: "color-mix(in srgb, var(--panel2) 98%, transparent)", boxShadow: "0 0 60px var(--shadow-modal)", animation: "mslide .2s ease both" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "12px 18px", borderBottom: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)" }}>
          <span style={{ fontSize: "var(--t95)", letterSpacing: 2.5, color: "var(--txl)" }}>{ask.kind === "prompt" ? "INPUT" : "CONFIRM"}</span>
        </div>
        <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 13 }}>
          <div style={{ fontSize: "var(--t125)", color: "var(--txb)", lineHeight: 1.6, wordBreak: "break-word" }}>{ask.text}</div>
          {ask.kind === "prompt" && (
            <input ref={input} autoFocus value={val} onChange={(e) => setVal(e.target.value)}
              style={{ appearance: "none", width: "100%", border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)", background: "color-mix(in srgb, var(--panel3) 60%, transparent)", color: "var(--txb)", fontFamily: "inherit", fontSize: "var(--t125)", padding: "8px 11px", outline: "none" }} />
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 9 }}>
            <button onClick={cancel} {...hp("no")}
              style={{ ...btn, border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: hov === "no" ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent", color: "var(--txm)" }}>CANCEL</button>
            <button onClick={accept} autoFocus={ask.kind === "confirm"} {...hp("yes")}
              style={{ ...btn, border: "1px solid color-mix(in srgb, var(--acc) 45%, transparent)", background: hov === "yes" ? "color-mix(in srgb, var(--acc) 20%, transparent)" : "color-mix(in srgb, var(--acc) 8%, transparent)", color: "var(--txb)" }}>OK</button>
          </div>
        </div>
      </div>
    </div>
  );
}
