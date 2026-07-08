import { useCallback, useEffect, useRef, useState } from "react";
import { api, type GraphState } from "../../api";

/* MAP tab — the project's graphify knowledge graph (graph.html) inline, with
   staleness header, build/refresh, and a one-line explain query. */

const mono: React.CSSProperties = {
  fontFamily: "'JetBrains Mono',monospace", fontSize: 11, whiteSpace: "pre-wrap",
};

export function MapTab({ project }: { project: string }) {
  const [st, setSt] = useState<GraphState | null>(null);
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState("");
  const [asking, setAsking] = useState(false);
  const [gen, setGen] = useState(0); // bump to reload the iframe after a rebuild
  const timer = useRef<number | null>(null);

  const load = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    api.graphState(project).then((s) => {
      setSt((prev) => {
        if (prev?.building && !s.building) setGen((g) => g + 1);
        return s;
      });
      if (s.building) timer.current = window.setTimeout(load, 1500);
    }).catch(() => setSt(null));
  }, [project]);

  useEffect(() => {
    load();
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [load]);

  const build = () => { api.graphUpdate(project).then(() => load()); };
  const ask = () => {
    const q = query.trim();
    if (!q || asking) return;
    setAsking(true);
    api.graphExplain(project, q)
      .then((r) => setAnswer(r.text))
      .catch((e) => setAnswer(String(e)))
      .finally(() => setAsking(false));
  };

  if (!st) return <div style={{ ...mono, color: "var(--txd)" }}>loading…</div>;
  if (!st.available) {
    return <div style={{ ...mono, color: "var(--txm)" }}>
      graphify is not installed on the bridge machine.{"\n"}pipx install graphifyy
    </div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "none" }}>
        <span style={{ ...mono, color: "var(--txm)" }}>
          {st.exists ? `BUILT @${st.built_commit ?? "?"}` : "NO MAP YET"}
        </span>
        {st.stale && <span style={{ ...mono, color: "var(--warn, orange)" }}>STALE</span>}
        {st.building && <span style={{ ...mono, color: "var(--acc)" }}>BUILDING…</span>}
        <span style={{ flex: 1 }} />
        <button onClick={build} disabled={st.building}
          style={{ appearance: "none", cursor: st.building ? "default" : "pointer",
            border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)",
            background: "transparent", color: "var(--txm)", fontFamily: "inherit",
            fontSize: 9.5, letterSpacing: 1.5, padding: "4px 10px",
            opacity: st.building ? 0.5 : 1 }}>
          {st.exists ? "REFRESH" : "BUILD MAP"}
        </button>
      </div>
      <div style={{ display: "flex", gap: 8, flex: "none" }}>
        <input value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask()}
          placeholder="explain a file / class / concept…"
          style={{ ...mono, flex: 1, background: "transparent", color: "var(--txb)",
            border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)",
            padding: "5px 8px", outline: "none" }} />
        <button onClick={ask} disabled={asking || !st.exists}
          style={{ appearance: "none", cursor: "pointer", border:
            "1px solid color-mix(in srgb, var(--acc) 25%, transparent)",
            background: "transparent", color: "var(--txm)", fontFamily: "inherit",
            fontSize: 9.5, letterSpacing: 1.5, padding: "4px 10px" }}>
          {asking ? "…" : "EXPLAIN"}
        </button>
      </div>
      {answer && (
        <div className="mscroll" style={{ ...mono, color: "var(--txl)", flex: "none",
          maxHeight: 160, overflowY: "auto", border:
          "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", padding: 8 }}>
          {answer}
        </div>
      )}
      {st.exists ? (
        <iframe key={gen} src={api.graphHtmlUrl(project)} title="project map"
          style={{ flex: 1, minHeight: 340, width: "100%", border:
            "1px solid color-mix(in srgb, var(--acc) 12%, transparent)",
            background: "#0a0a0a" }} />
      ) : (
        <div style={{ ...mono, color: "var(--txd)" }}>
          Build the map to explore this project as an interactive graph.
        </div>
      )}
    </div>
  );
}
