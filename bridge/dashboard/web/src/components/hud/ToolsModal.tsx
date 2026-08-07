import { useEffect, useState } from "react";
import { api, type Toolsets } from "../../api";

/* TOOLS & MCP modal — per-session switches for the built-in tools and the MCP
   servers this machine has configured. Off means the deny rule goes to
   `claude --disallowedTools`, which drops the tool from the model's context
   entirely, so switching a chatty server off buys back its schema tokens. */

const BOX = (on: boolean) => ({
  appearance: "none" as const,
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: "var(--t85)",
  letterSpacing: 1,
  padding: "4px 9px",
  flex: "none" as const,
  border: `1px solid color-mix(in srgb, ${on ? "var(--ok)" : "var(--txd)"} 40%, transparent)`,
  background: on ? "color-mix(in srgb, var(--ok) 12%, transparent)" : "transparent",
  color: on ? "var(--ok)" : "var(--txd)",
});

const LABEL = { fontSize: "var(--t9)", letterSpacing: 1.5, color: "var(--txl)", margin: "0 0 9px" };

export function ToolsModal({
  title,
  disabled,
  onChange,
  onClose,
}: {
  title: string;
  disabled: string[];
  onChange: (rules: string[]) => void;
  onClose: () => void;
}) {
  const [sets, setSets] = useState<Toolsets | null>(null);
  const [saved, setSaved] = useState(false);
  const off = new Set(disabled);

  const saveDefault = () => {
    void api.setToolsetDefault(disabled).then((r) => {
      setSets((s) => (s ? { ...s, default: r.default } : s));
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    }).catch(() => {});
  };

  useEffect(() => {
    let live = true;
    void api.toolsets().then((r) => { if (live) setSets(r); }).catch(() => {});
    return () => { live = false; };
  }, []);

  const toggle = (rule: string) => {
    const next = new Set(off);
    if (next.has(rule)) next.delete(rule);
    else next.add(rule);
    onChange([...next].sort());
  };

  const row = (key: string, name: string, hint: string, rule: string, dim?: boolean) => {
    const on = !off.has(rule);
    return (
      <div key={key}
        style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderBottom: "1px solid color-mix(in srgb, var(--acc) 7%, transparent)", opacity: on ? 1 : 0.55 }}>
        <span style={{ width: 6, height: 6, background: on ? "var(--ok)" : "var(--txd)", flex: "none" }} />
        <span style={{ fontSize: "var(--t12)", color: "var(--txb)", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
        <span style={{ fontSize: "var(--t9)", color: dim ? "var(--warn)" : "var(--txd)", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{hint}</span>
        <span style={{ flex: 1 }} />
        <button onClick={() => toggle(rule)} style={BOX(on)} title={rule}>
          {on ? "ON" : "OFF"}
        </button>
      </div>
    );
  };

  const box = { border: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", marginBottom: 16 };

  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "color-mix(in srgb, var(--panel3) 74%, transparent)", zIndex: 94, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "9vh", animation: "backdropIn .2s ease both" }}>
      <div onClick={(e) => e.stopPropagation()} className="panel"
        style={{ width: 560, maxWidth: "94vw", maxHeight: "80vh", display: "flex", flexDirection: "column", border: "1px solid color-mix(in srgb, var(--acc) 40%, transparent)", background: "color-mix(in srgb, var(--panel2) 98%, transparent)", boxShadow: "0 0 60px var(--shadow-modal)", animation: "mslide .2s ease both" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "14px 18px", borderBottom: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", flex: "none" }}>
          <span style={{ fontSize: "var(--t95)", letterSpacing: 2.5, color: "var(--txl)" }}>TOOLS</span>
          <span style={{ fontSize: "var(--t15)", color: "var(--txb)", letterSpacing: ".5px", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</span>
          <span style={{ flex: 1 }} />
          <button onClick={saveDefault} title="new sessions start with these switches"
            style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: "transparent", color: saved ? "var(--ok)" : "var(--txm)", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1.5, padding: "6px 10px" }}>
            {saved ? "SAVED ✓" : "SAVE AS DEFAULT"}
          </button>
          {off.size > 0 && (
            <button onClick={() => onChange([])}
              style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: "transparent", color: "var(--txm)", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1.5, padding: "6px 10px" }}>
              ALL ON
            </button>
          )}
          <button onClick={onClose}
            style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: "transparent", color: "var(--txm)", fontFamily: "inherit", fontSize: "var(--t95)", letterSpacing: 1.5, padding: "6px 12px" }}>ESC ✕</button>
        </div>
        <div className="mscroll" style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "14px 18px" }}>
          <div style={{ fontSize: "var(--t9)", letterSpacing: 1.5, color: "var(--txl)", marginBottom: 14 }}>
            OFF applies to this session's next turn · a switched-off tool leaves the model's context, so its schema stops costing tokens
          </div>

          <div style={LABEL}>BUILT-IN TOOLS</div>
          <div style={box}>
            {(sets?.builtins ?? []).map((b) => row(b.rule, b.label, b.hint, b.rule))}
          </div>

          <div style={LABEL}>
            MCP SERVERS{sets ? ` · ${sets.servers.filter((s) => !off.has(s.rule)).length}/${sets.servers.length} ON` : ""}
            {/* All 17 on measured ~263k tokens of schemas against a 200k window,
                so the count is the number that matters most on this screen. */}
            {sets && sets.servers.every((s) => !off.has(s.rule)) && sets.servers.length > 6 && (
              <span style={{ color: "var(--warn)" }}> · every server on can exceed the context window</span>
            )}
          </div>
          <div style={box}>
            {sets === null && (
              <div style={{ padding: "11px 12px", fontSize: "var(--t11)", color: "var(--txd)" }}>reading `claude mcp list`…</div>
            )}
            {sets?.servers.length === 0 && (
              <div style={{ padding: "11px 12px", fontSize: "var(--t11)", color: "var(--txd)" }}>no MCP servers configured</div>
            )}
            {(sets?.servers ?? []).map((s) =>
              row(s.rule, s.name, s.ok ? "" : s.status, s.rule, !s.ok))}
          </div>
        </div>
      </div>
    </div>
  );
}
