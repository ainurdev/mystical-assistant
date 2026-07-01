import { useEffect, useState } from "react";
import { api, type LearningItem } from "../../api";
import { Markdown } from "../Markdown";

type Mode = "explain" | "quiz" | "exercise" | "grade";

export function TeacherTab({ project }: { project: string }) {
  const [items, setItems] = useState<LearningItem[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState("");
  const [answer, setAnswer] = useState("");
  const sel = items.find((i) => i.id === openId) ?? null;

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const r = await api.learningItems(project);
        if (live) setItems(r.items);
      } catch {
        /* ignore */
      }
    };
    void tick();
    const id = setInterval(tick, 5000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [project]);

  const run = async (mode: Mode, user_answer?: string) => {
    if (!sel) return;
    setBusy(true);
    setOutput("");
    try {
      const r = await api.learningTeach({ item_id: sel.id, mode, user_answer });
      setOutput(r.text);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "300px 1fr", gap: 0, border: "1px solid rgba(127,233,216,.12)" }}>
      <div className="mscroll" style={{ borderRight: "1px solid rgba(127,233,216,.12)", padding: 9, minHeight: 0 }}>
        {items.length === 0 && (
          <div style={{ fontSize: 11, color: "#3c544f", padding: 6 }}>No review items yet.</div>
        )}
        {items.map((it: LearningItem) => {
          const on = it.id === openId;
          return (
            <div
              key={it.id}
              onClick={() => { setOpenId(it.id); setOutput(""); setAnswer(""); }}
              style={{ border: `1px solid ${on ? "rgba(127,233,216,.4)" : "rgba(127,233,216,.12)"}`, borderLeft: `2px solid ${on ? "#7fe9d8" : "transparent"}`, padding: "9px 10px", marginBottom: 7, cursor: "pointer", background: on ? "rgba(127,233,216,.08)" : "transparent" }}
            >
              <div style={{ fontSize: 12, color: "#cfe9e3", lineHeight: 1.35 }}>{it.title}</div>
              <div style={{ fontSize: 9.5, color: "#3c544f", marginTop: 5 }}>
                mastery {it.mastery}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0, padding: 14 }}>
        {!sel ? (
          <div style={{ margin: "auto", fontSize: 11, letterSpacing: 1.5, color: "#3c544f" }}>SELECT AN ITEM</div>
        ) : (
          <div className="mscroll" style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0, overflowY: "auto" }}>
            <div>
              <div style={{ fontSize: 15, color: "#dff8f2" }}>{sel.title}</div>
              {sel.why_it_matters && (
                <div style={{ fontSize: 12, color: "#8fb3ac", marginTop: 6 }}>{sel.why_it_matters}</div>
              )}
              {sel.code_snippet && (
                <pre style={{ fontSize: 11, color: "#bfe6de", background: "rgba(7,13,13,.6)", padding: 10, marginTop: 8, overflowX: "auto" }}>{sel.code_snippet}</pre>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {(["explain", "quiz", "exercise"] as Mode[]).map((m) => (
                <button key={m} disabled={busy} onClick={() => run(m)}
                  style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(127,233,216,.3)", background: "rgba(127,233,216,.06)", color: "#dff8f2", fontFamily: "inherit", fontSize: 10, letterSpacing: 1, padding: "7px 12px", textTransform: "uppercase" }}>
                  {m}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <textarea value={answer} onChange={(e) => setAnswer(e.target.value)}
                placeholder="Explain it back in your own words…"
                style={{ width: "100%", boxSizing: "border-box", background: "rgba(7,13,13,.6)", border: "1px solid rgba(127,233,216,.18)", outline: "none", color: "#dff8f2", fontFamily: "inherit", fontSize: 12, padding: "7px 9px" }} rows={3} />
              <button disabled={busy || !answer.trim()} onClick={() => run("grade", answer)}
                style={{ appearance: "none", cursor: "pointer", border: "1px solid #8fd9a8", background: "rgba(143,217,168,.12)", color: "#dff8f2", fontFamily: "inherit", fontSize: 10, letterSpacing: 1, padding: "8px 13px", alignSelf: "flex-start" }}>
                GRADE MY UNDERSTANDING
              </button>
            </div>
            {busy && <div style={{ fontSize: 11, color: "#6f938d" }}>Thinking…</div>}
            {output && (
              <div style={{ fontSize: 12, color: "#bfe6de", lineHeight: 1.6 }}>
                <Markdown>{output}</Markdown>
              </div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => api.learningItem(sel.id, "reviewed")}
                style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(127,233,216,.25)", background: "transparent", color: "#9fc7c0", fontFamily: "inherit", fontSize: 10, letterSpacing: 1, padding: "7px 12px" }}>
                MARK REVIEWED
              </button>
              <button onClick={() => { void api.learningItem(sel.id, "archive"); setOpenId(null); }}
                style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(127,233,216,.25)", background: "transparent", color: "#9fc7c0", fontFamily: "inherit", fontSize: 10, letterSpacing: 1, padding: "7px 12px" }}>
                ARCHIVE
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
