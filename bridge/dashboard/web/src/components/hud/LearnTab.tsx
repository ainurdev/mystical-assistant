import { useCallback, useEffect, useState } from "react";
import { api, type Lesson } from "../../api";
import { Markdown } from "../Markdown";
import { ago } from "../../lib/surfaces";

/* LEARN tab — the lessons written after this repo's turns (bridge/learn.py),
   read as a list on the left and the selected one rendered on the right. Also
   where a single repo opts out, without touching the global switch.

   Same component serves the right sidebar (LearnPanel), where the sidebar is
   too narrow for two columns and the list stacks above the lesson instead. */

const mono: React.CSSProperties = {
  fontFamily: "'JetBrains Mono',monospace", fontSize: 11,
};

const btn: React.CSSProperties = {
  appearance: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 9.5,
  letterSpacing: 1.5, padding: "4px 10px", background: "transparent",
  color: "var(--txm)", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)",
};

export function LearnTab({ project, compact }: { project: string; compact?: boolean }) {
  const [list, setList] = useState<Lesson[] | null>(null);
  const [repoOn, setRepoOn] = useState(true);
  const [sel, setSel] = useState("");
  const [body, setBody] = useState("");
  const [err, setErr] = useState(false);

  const load = useCallback(() => {
    api.lessons(project).then((r) => {
      setErr(false);
      setList(r.lessons);
      setRepoOn(r.repo_enabled);
      // Newest lesson opens by default — it's the turn you just watched finish.
      setSel((cur) => (cur && r.lessons.some((l) => l.file === cur) ? cur : r.lessons[0]?.file ?? ""));
    }).catch(() => { setErr(true); setList(null); });
  }, [project]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!sel) { setBody(""); return; }
    let live = true;
    api.lesson(project, sel)
      .then((r) => { if (live) setBody(r.body); })
      .catch(() => { if (live) setBody("_could not read this lesson._"); });
    return () => { live = false; };
  }, [project, sel]);

  const toggleRepo = () => {
    const next = !repoOn;
    setRepoOn(next);   // optimistic: the switch should not lag the click
    api.setLessonsForRepo(project, next)
      .then((r) => setRepoOn(r.repo_enabled))
      .catch(() => setRepoOn(!next));
  };

  if (err) {
    return (
      <div style={{ ...mono, color: "var(--txm)", display: "flex", alignItems: "center", gap: 10 }}>
        <span>failed to load lessons.</span>
        <button onClick={load} style={btn}>RETRY</button>
      </div>
    );
  }
  if (!list) return <div style={{ ...mono, color: "var(--txd)" }}>loading…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "none", flexWrap: "wrap" }}>
        <span style={{ ...mono, color: "var(--txm)" }}>
          {list.length ? `${list.length} LESSON${list.length === 1 ? "" : "S"}` : "NO LESSONS YET"}
        </span>
        {!repoOn && <span style={{ ...mono, color: "var(--warn, orange)" }}>OFF FOR THIS REPO</span>}
        <span style={{ flex: 1 }} />
        <button onClick={toggleRepo} style={btn}
          title={repoOn ? "stop writing lessons for this repo" : "write lessons for this repo again"}>
          {repoOn ? "DISABLE HERE" : "ENABLE HERE"}
        </button>
        <button onClick={load} style={btn}>REFRESH</button>
      </div>

      {list.length === 0 ? (
        <div style={{ ...mono, color: "var(--txd)", whiteSpace: "pre-wrap" }}>
          {repoOn
            ? "A lesson is written here after each turn that builds something —\nwhat changed, the idea behind it, and where to look.\nKeep working; the first one lands when the next turn finishes."
            : "Lessons are off for this repo. Enable here to start writing them again."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: compact ? "column" : "row", gap: 12, flex: 1, minHeight: 0 }}>
          <div className="mscroll" style={compact
            ? { maxHeight: "45%", flex: "none", overflowY: "auto",
                borderBottom: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", paddingBottom: 6 }
            : { width: 220, flex: "none", overflowY: "auto",
                borderRight: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", paddingRight: 8 }}>
            {list.map((l) => (
              <button key={l.file} onClick={() => setSel(l.file)}
                style={{ display: "block", width: "100%", textAlign: "left", appearance: "none",
                  border: 0, borderLeft: `2px solid ${sel === l.file ? "var(--acc)" : "transparent"}`,
                  cursor: "pointer", fontFamily: "inherit", padding: "7px 9px", marginBottom: 2,
                  background: sel === l.file ? "color-mix(in srgb, var(--acc) 7%, transparent)" : "transparent",
                  color: sel === l.file ? "var(--txb)" : "var(--txl)", fontSize: 11, lineHeight: 1.35 }}>
                {l.title}
                <span style={{ display: "block", ...mono, fontSize: 9, color: "var(--txd)", marginTop: 3 }}>
                  {l.file.slice(0, 4)} · {ago(l.at)} ago
                </span>
              </button>
            ))}
          </div>
          <div className="mscroll" style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
            <Markdown>{body}</Markdown>
          </div>
        </div>
      )}
    </div>
  );
}

/** Right-sidebar panel — the active session's repo, no project modal needed. */
export function LearnPanel({ project }: { project: string | null }) {
  return (
    <div className="panel" style={{ border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)",
      background: "color-mix(in srgb, var(--panel) 86%, transparent)",
      display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px" }}>
        <span style={{ fontSize: 10.5, letterSpacing: 2.5, color: "var(--txl)" }}>LEARN</span>
        <span style={{ fontSize: 9.5, letterSpacing: 1.5, color: "var(--acc)", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {project ? project.split("/").pop() : "NO PROJECT"}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, padding: 11 }}>
        {project
          ? <LearnTab key={project} project={project} compact />
          : <div style={{ ...mono, color: "var(--txd)" }}>No project selected.</div>}
      </div>
    </div>
  );
}
