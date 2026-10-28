import { useEffect, useState } from "react";
import { api, type AvailablePlugin, type PluginAction, type PluginsInfo } from "../../api";

/* Claude Code plugins, for SETTINGS ▸ Skills (SkillsFold.tsx). It was the HUD
   half of SkillsTab.tsx; the project window's SKILLS tab went when the session
   header's ⊞ PROJECT did, and SETTINGS ▸ Skills shows the skills themselves. */

const LABEL = { fontSize: "var(--t85)", letterSpacing: 1.5, color: "var(--txl)" } as const;

/* PLUGINS — the catalog installs one SKILL.md, which is why it can only carry
   single-file skills. A plugin is the whole bundle (multi-file skills, agents,
   MCP servers) installed and versioned by Claude Code itself, so everything
   here is a relay to `claude plugin`. Machine-wide, hence no project scope. */
export function PluginsView() {
  const [info, setInfo] = useState<PluginsInfo | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [src, setSrc] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    let live = true;
    void api.plugins()
      .then((d) => { if (live) setInfo(d); })
      .catch((e: Error) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, []);

  async function act(key: string, action: PluginAction, id: string,
                     extra?: { scope?: string; enabled?: boolean }) {
    if (busy) return;
    setBusy(key); setErr("");
    try {
      const r = await api.pluginAct(action, id, extra);
      setInfo({ marketplaces: r.marketplaces, installed: r.installed, available: r.available });
      if (!r.ok && r.error) setErr(r.error);
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy("");
  }

  const needle = q.trim().toLowerCase();
  const available = (info?.available ?? []).filter(
    (p) => !needle || `${p.name} ${p.id} ${p.description}`.toLowerCase().includes(needle));

  return (
    <>
      {err && <div style={{ fontSize: "var(--t10)", color: "var(--err)", marginBottom: 9 }}>{err}</div>}
      {!info && !err && <div style={{ fontSize: "var(--t105)", color: "var(--txl)" }}>Reading plugins…</div>}
      {info && (
        <>
          <div style={{ ...LABEL, display: "flex", alignItems: "center", gap: 7, margin: "0 0 7px" }}>
            <span>MARKETPLACES · {info.marketplaces.length}</span>
            <span style={{ flex: 1, height: 1, background: "color-mix(in srgb, var(--acc) 10%, transparent)" }} />
          </div>
          {info.marketplaces.map((m) => (
            <div key={m.name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 9px", marginBottom: 4, border: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", background: "color-mix(in srgb, var(--panel2) 30%, transparent)" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: "var(--t11)", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace" }}>{m.name}</div>
                {m.repo && <div style={{ fontSize: "var(--t9)", color: "var(--txd)", marginTop: 2 }}>{m.repo}</div>}
              </div>
              <button onClick={() => void act(`m:${m.name}`, "market/remove", m.name)} disabled={!!busy} title="remove this marketplace"
                style={{ appearance: "none", cursor: busy ? "default" : "pointer", border: "1px solid color-mix(in srgb, var(--err) 25%, transparent)", background: "transparent", color: "var(--err)", fontFamily: "inherit", fontSize: "var(--t10)", lineHeight: 1, padding: "4px 6px", flex: "none", opacity: busy ? 0.4 : 0.6 }}>✕</button>
            </div>
          ))}
          <form onSubmit={(e) => { e.preventDefault(); const s = src.trim(); if (s) { setSrc(""); void act("add", "market/add", s); } }}
            style={{ display: "flex", gap: 5, margin: "6px 0 12px" }}>
            <input value={src} onChange={(e) => setSrc(e.target.value)} placeholder="owner/repo, url or path"
              style={{ flex: 1, minWidth: 0, boxSizing: "border-box", background: "color-mix(in srgb, var(--panel2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t10)", padding: "6px 8px" }} />
            <button type="submit" disabled={!!busy || !src.trim()}
              style={{ appearance: "none", cursor: busy || !src.trim() ? "default" : "pointer", flex: "none", border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)", background: "color-mix(in srgb, var(--acc) 10%, transparent)", color: "var(--txb)", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1, padding: "5px 10px", opacity: busy || !src.trim() ? 0.45 : 1 }}
            >{busy === "add" ? "CLONING…" : "+ ADD"}</button>
          </form>

          <div style={{ ...LABEL, display: "flex", alignItems: "center", gap: 7, margin: "0 0 7px" }}>
            <span>INSTALLED · {info.installed.length}</span>
            <span style={{ flex: 1, height: 1, background: "color-mix(in srgb, var(--acc) 10%, transparent)" }} />
          </div>
          {info.installed.length === 0 && (
            <div style={{ fontSize: "var(--t105)", color: "var(--txl)", padding: "2px 2px 10px" }}>No plugins installed.</div>
          )}
          {info.installed.map((p) => (
            <div key={p.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 9px", marginBottom: 5, border: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", background: "color-mix(in srgb, var(--panel2) 35%, transparent)", opacity: p.enabled ? 1 : 0.55 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: "var(--t115)", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.id}</div>
                <div style={{ fontSize: "var(--t9)", color: "var(--txd)", marginTop: 3 }}>
                  v{p.version} · {p.scope}
                  {/* Each MCP server a plugin brings costs context on every turn. */}
                  {p.mcp.length > 0 && <span style={{ color: "var(--warn)" }}> · {p.mcp.length} MCP</span>}
                </div>
              </div>
              <button onClick={() => void act(`p:${p.id}`, "enable", p.id, { enabled: !p.enabled })} disabled={!!busy}
                title={p.enabled ? "disable" : "enable"}
                style={{ appearance: "none", cursor: busy ? "default" : "pointer", border: `1px solid ${p.enabled ? "var(--ok)" : "color-mix(in srgb, var(--acc) 22%, transparent)"}`, background: p.enabled ? "color-mix(in srgb, var(--ok) 12%, transparent)" : "transparent", color: p.enabled ? "var(--ok)" : "var(--txm)", fontFamily: "inherit", fontSize: "var(--t85)", letterSpacing: 1, padding: "4px 6px", flex: "none" }}>{p.enabled ? "✓ ON" : "OFF"}</button>
              <button onClick={() => void act(`p:${p.id}`, "update", p.id)} disabled={!!busy} title="update to the latest version"
                style={{ appearance: "none", cursor: busy ? "default" : "pointer", border: "1px solid color-mix(in srgb, var(--acc) 22%, transparent)", background: "transparent", color: "var(--txm)", fontFamily: "inherit", fontSize: "var(--t85)", letterSpacing: 1, padding: "4px 6px", flex: "none" }}>↻</button>
              <button onClick={() => void act(`p:${p.id}`, "uninstall", p.id)} disabled={!!busy} title="uninstall"
                style={{ appearance: "none", cursor: busy ? "default" : "pointer", border: "1px solid color-mix(in srgb, var(--err) 25%, transparent)", background: "transparent", color: "var(--err)", fontFamily: "inherit", fontSize: "var(--t10)", lineHeight: 1, padding: "4px 6px", flex: "none", opacity: busy ? 0.4 : 0.6 }}>✕</button>
            </div>
          ))}

          <div style={{ ...LABEL, display: "flex", alignItems: "center", gap: 7, margin: "11px 0 7px" }}>
            <span>AVAILABLE · {info.available.length}</span>
            <span style={{ flex: 1, height: 1, background: "color-mix(in srgb, var(--acc) 10%, transparent)" }} />
          </div>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search plugins…"
            style={{ width: "100%", boxSizing: "border-box", background: "color-mix(in srgb, var(--panel2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t10)", padding: "6px 8px", marginBottom: 8 }} />
          <div className="mscroll" style={{ maxHeight: 360, overflowY: "auto", paddingRight: 2 }}>
            {available.slice(0, 80).map((p: AvailablePlugin) => (
              <div key={p.id} style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: "9px 10px", marginBottom: 5, border: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", background: "color-mix(in srgb, var(--panel2) 30%, transparent)" }}>
                <div style={{ flex: 1, minWidth: 130 }}>
                  <div style={{ fontSize: "var(--t115)", color: "var(--txb)" }}>{p.name}</div>
                  <div style={{ fontSize: "var(--t95)", color: "var(--txd)", marginTop: 3, lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{p.description}</div>
                  <div style={{ fontSize: "var(--t85)", color: "var(--txf)", marginTop: 4 }}>{p.marketplace}</div>
                </div>
                <button onClick={() => void act(`p:${p.id}`, "install", p.id, { scope: "user" })} disabled={!!busy}
                  style={{ appearance: "none", cursor: busy ? "default" : "pointer", flex: "none", marginTop: 1, border: "1px solid color-mix(in srgb, var(--acc) 22%, transparent)", background: "transparent", color: "var(--txm)", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1, padding: "4px 7px", opacity: busy ? 0.45 : 1 }}
                >{busy === `p:${p.id}` ? "…" : "+ INSTALL"}</button>
              </div>
            ))}
            {available.length > 80 && (
              <div style={{ ...LABEL, padding: "4px 2px" }}>{available.length - 80} MORE — NARROW THE SEARCH</div>
            )}
            {available.length === 0 && (
              <div style={{ fontSize: "var(--t105)", color: "var(--txl)", padding: "4px 2px" }}>
                {info.marketplaces.length ? "No plugin matches that." : "Add a marketplace to see plugins."}
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
