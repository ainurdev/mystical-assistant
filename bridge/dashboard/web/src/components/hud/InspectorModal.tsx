import { useEffect, useState } from "react";
import { api, type InspectorEntry, type InspectorState } from "../../api";

/* HTTP INSPECTOR — every request a bridge run makes to the Anthropic API, taken
   from the pass-through proxy the child is pointed at. Off by default; a switch
   here lands on the next turn, not the one already running. */

const fmt = (ts: number) =>
  new Date(ts * 1000).toLocaleTimeString([], { hour12: false });

const bytes = (n?: number) =>
  n == null ? "" : n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}K` : `${(n / 1048576).toFixed(1)}M`;

const statusColor = (s?: number) =>
  s == null || s === 0 ? "var(--err)" : s < 300 ? "var(--ok)" : s < 500 ? "var(--warn)" : "var(--err)";

function Row({ e }: { e: InspectorEntry }) {
  const [open, setOpen] = useState(false);
  const u = e.sse?.usage;
  return (
    <div style={{ borderBottom: "1px solid color-mix(in srgb, var(--acc) 8%, transparent)" }}>
      <button onClick={() => setOpen((o) => !o)}
        style={{ appearance: "none", border: 0, background: "transparent", cursor: "pointer", fontFamily: "inherit", width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 9, padding: "7px 11px", color: "inherit" }}>
        <span style={{ fontSize: "var(--t9)", color: "var(--txd)", flex: "none", width: 58 }}>{fmt(e.ts)}</span>
        <span style={{ fontSize: "var(--t95)", letterSpacing: 1, color: statusColor(e.status), flex: "none", width: 30 }}>
          {e.status || "ERR"}
        </span>
        <span style={{ fontSize: "var(--t11)", color: "var(--txb)", minWidth: 0, flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {e.method} {e.path}
        </span>
        {e.request?.model && (
          <span style={{ fontSize: "var(--t85)", letterSpacing: .5, color: "var(--acc)", flex: "none" }}>
            {e.request.model.replace(/^claude-/, "")}
          </span>
        )}
        {!!e.request?.tools && (
          <span style={{ fontSize: "var(--t85)", color: e.request.tools > 100 ? "var(--warn)" : "var(--txd)", flex: "none" }}>
            {e.request.tools} tools
          </span>
        )}
        <span style={{ fontSize: "var(--t9)", color: "var(--txd)", flex: "none" }}>{bytes(e.response_bytes)}</span>
        <span style={{ fontSize: "var(--t9)", color: "var(--txd)", flex: "none", width: 46, textAlign: "right" }}>
          {e.ms}ms
        </span>
      </button>
      {open && (
        <div style={{ padding: "0 11px 10px 69px", fontSize: "var(--t10)", lineHeight: 1.8, color: "var(--txl)" }}>
          {e.request && Object.keys(e.request).length > 0 && (
            <div>
              REQUEST · {e.request.messages} msg · system {e.request.system_chars?.toLocaleString()} chars
              {e.request.stream ? " · stream" : ""}{e.request.thinking ? " · thinking" : ""}
              {e.request.max_tokens ? ` · max ${e.request.max_tokens.toLocaleString()}` : ""}
            </div>
          )}
          {u && (
            <div>
              TOKENS · in {u.input_tokens?.toLocaleString() ?? "?"} · out {u.output_tokens?.toLocaleString() ?? "?"}
              {u.cache_read_input_tokens != null && ` · cache read ${u.cache_read_input_tokens.toLocaleString()}`}
              {u.cache_creation_input_tokens != null && ` · cache write ${u.cache_creation_input_tokens.toLocaleString()}`}
            </div>
          )}
          {e.sse && (
            <div>
              SSE · {Object.entries(e.sse.events).map(([k, v]) => `${k}×${v}`).join(" · ") || "no frames captured"}
              {e.sse.stop_reason ? ` · stop ${e.sse.stop_reason}` : ""}
            </div>
          )}
          {e.ttfb_ms != null && <div>TTFB · {e.ttfb_ms}ms of {e.ms}ms</div>}
          {e.aborted && <div style={{ color: "var(--warn)" }}>ABORTED · the child hung up mid-stream</div>}
          {(e.error || e.body) && (
            <pre style={{ margin: "5px 0 0", whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: "var(--t10)", color: e.error ? "var(--err)" : "var(--txm)", maxHeight: 200, overflow: "auto" }}>
              {e.error || e.body}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function InspectorModal({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<InspectorState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () => { void api.inspector().then((r) => { if (live) setState(r); }).catch(() => {}); };
    load();
    const id = setInterval(load, 2000);
    return () => { live = false; clearInterval(id); };
  }, []);

  const act = (action: "on" | "off" | "clear") => {
    setBusy(true);
    void api.inspectorAction(action)
      .then(() => api.inspector())
      .then(setState)
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  const on = state?.on ?? false;
  const entries = [...(state?.entries ?? [])].reverse();

  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "color-mix(in srgb, var(--panel3) 74%, transparent)", zIndex: 94, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "7vh", animation: "backdropIn .2s ease both" }}>
      <div onClick={(e) => e.stopPropagation()} className="panel"
        style={{ width: 900, maxWidth: "96vw", maxHeight: "84vh", display: "flex", flexDirection: "column", border: "1px solid color-mix(in srgb, var(--acc) 40%, transparent)", background: "color-mix(in srgb, var(--panel2) 98%, transparent)", boxShadow: "0 0 60px var(--shadow-modal)", animation: "mslide .2s ease both" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "14px 18px", borderBottom: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", flex: "none" }}>
          <span style={{ fontSize: "var(--t95)", letterSpacing: 2.5, color: "var(--txl)" }}>HTTP</span>
          <span style={{ fontSize: "var(--t15)", color: "var(--txb)", letterSpacing: ".5px" }}>Inspector</span>
          <span style={{ width: 7, height: 7, background: on ? "var(--ok)" : "var(--txd)", flex: "none", animation: on ? "blink 1.6s steps(1) infinite" : undefined }} />
          <span style={{ fontSize: "var(--t9)", letterSpacing: 1, color: "var(--txd)" }}>
            {on ? `PROXYING · ${entries.length} CALL${entries.length === 1 ? "" : "S"}` : "OFF"}
          </span>
          <span style={{ flex: 1 }} />
          <button disabled={busy} onClick={() => act(on ? "off" : "on")}
            style={{ appearance: "none", cursor: busy ? "wait" : "pointer", border: `1px solid color-mix(in srgb, ${on ? "var(--err)" : "var(--ok)"} 35%, transparent)`, background: "transparent", color: on ? "var(--err)" : "var(--ok)", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1.5, padding: "6px 12px" }}>
            {on ? "STOP" : "START"}
          </button>
          {entries.length > 0 && (
            <button disabled={busy} onClick={() => act("clear")}
              style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: "transparent", color: "var(--txm)", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1.5, padding: "6px 10px" }}>
              CLEAR
            </button>
          )}
          <button onClick={onClose}
            style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: "transparent", color: "var(--txm)", fontFamily: "inherit", fontSize: "var(--t95)", letterSpacing: 1.5, padding: "6px 12px" }}>ESC ✕</button>
        </div>
        <div className="mscroll" style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
          <div style={{ fontSize: "var(--t9)", letterSpacing: 1.5, color: "var(--txl)", padding: "11px 18px", lineHeight: 1.8 }}>
            {on
              ? "Runs started from now on go through a local pass-through proxy — a turn already running keeps talking to the API directly. Credentials are dropped before anything is stored."
              : "START points new runs at a local pass-through proxy in front of api.anthropic.com, so every request, its token accounting and its SSE frames land here. Nothing is rewritten; the cost is one extra localhost hop."}
          </div>
          {entries.length === 0 ? (
            <div style={{ padding: "18px", fontSize: "var(--t11)", color: "var(--txd)" }}>
              {on ? "waiting for the next turn…" : "no calls captured"}
            </div>
          ) : (
            entries.map((e) => <Row key={e.seq} e={e} />)
          )}
        </div>
      </div>
    </div>
  );
}
