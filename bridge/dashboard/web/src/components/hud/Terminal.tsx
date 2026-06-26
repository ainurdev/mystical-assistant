import { useEffect, useState, type ReactNode, type RefObject } from "react";
import type { AnswerSelection, EnrichedSession, SessionBrief } from "../../api";
import type { Turn } from "../../chat";
import { surfaceFor, projectTint } from "../../lib/surfaces";
import { Transcript } from "../Transcript";
import { HistoryView } from "../HistoryView";

const FRESH_QUOTES = [
  "the prompt is blank, the potential is not.",
  "speak, and I shall translate intent into diffs.",
  "idle, but never asleep — what shall we ship?",
  "every great commit starts with an empty line.",
  "no tasks queued; the oracle grows restless.",
  "feed me an error and watch the sparks fly.",
  "a quiet terminal is a dangerous thing. let us fix that.",
  "ready to conjure — name your bug.",
];

function basename(rel: string | null | undefined): string | null {
  if (!rel) return null;
  const clean = rel.replace(/\/+$/, "");
  if (clean === "" || clean === "/") return "/";
  return clean.split("/").pop() || clean;
}

/** The empty-session intro: the mystical assistant face + a rotating quote. */
function FreshState({ project }: { project: string | null }) {
  const [qi, setQi] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setQi((q) => q + 1), 7200);
    return () => clearInterval(id);
  }, []);
  return (
    <div style={{ height: "100%", minHeight: 330, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20, textAlign: "center", animation: "mfadeup .5s ease both" }}>
      <div style={{ position: "relative", width: 150, height: 150, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <svg viewBox="0 0 100 100" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible", opacity: 0.5 }}>
          <circle cx="50" cy="50" r="46" fill="none" stroke="#7fe9d8" strokeWidth="1" strokeDasharray="5 9" style={{ transformOrigin: "50px 50px", animation: "introspin 11s linear infinite" }} />
          <circle cx="50" cy="50" r="38" fill="none" stroke="rgba(185,166,255,.4)" strokeWidth="1" strokeDasharray="3 13" style={{ transformOrigin: "50px 50px", animation: "introspinr 16s linear infinite" }} />
        </svg>
        <div style={{ position: "relative", width: 92, height: 92, borderRadius: "50%", border: "1.5px solid rgba(127,233,216,.5)", background: "radial-gradient(circle at 50% 36%,rgba(127,233,216,.16),rgba(7,13,13,.6))", boxShadow: "0 0 28px rgba(127,233,216,.18),inset 0 0 22px rgba(127,233,216,.1)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, animation: "bob 4.5s ease-in-out infinite" }}>
          <div style={{ display: "flex", gap: 16 }}>
            <span style={{ width: 9, height: 13, background: "#7fe9d8", borderRadius: 3, boxShadow: "0 0 8px #7fe9d8", animation: "eyeblink 5s infinite" }} />
            <span style={{ width: 9, height: 13, background: "#7fe9d8", borderRadius: 3, boxShadow: "0 0 8px #7fe9d8", animation: "eyeblink 5s infinite" }} />
          </div>
          <div style={{ width: 22, height: 10, border: "2px solid #7fe9d8", borderTop: 0, borderRadius: "0 0 14px 14px", opacity: 0.85 }} />
        </div>
        <span style={{ position: "absolute", top: 4, right: 8, color: "#b9a6ff", fontSize: 13, animation: "twinkle 3s infinite" }}>✦</span>
        <span style={{ position: "absolute", bottom: 10, left: 4, color: "#7fe9d8", fontSize: 10, animation: "twinkle 4s infinite .5s" }}>✦</span>
        <span style={{ position: "absolute", top: 26, left: -2, color: "#8fd9a8", fontSize: 9, animation: "twinkle 3.5s infinite 1s" }}>+</span>
      </div>
      <div style={{ maxWidth: 450 }}>
        <div style={{ fontSize: 9.5, letterSpacing: 3, color: "#3c544f", marginBottom: 13 }}>
          {(basename(project) || "WORKSPACE").toUpperCase()} · FRESH SESSION
        </div>
        <div style={{ fontSize: 16, lineHeight: 1.55, color: "#cfe9e3", fontStyle: "italic", minHeight: 50 }}>
          <span key={qi} style={{ display: "inline-block", animation: "quotein .75s cubic-bezier(.2,.85,.25,1) both, quoteglow 7.2s ease-in-out infinite" }}>
            “{FRESH_QUOTES[qi % FRESH_QUOTES.length]}”
          </span>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 9, color: "#6f938d", fontFamily: "'JetBrains Mono',monospace", fontSize: 12 }}>
        <span style={{ color: "#b9a6ff" }}>~ ❯</span>
        <span style={{ letterSpacing: 2, background: "linear-gradient(90deg,#3c544f 0%,#3c544f 28%,#9fe9dd 50%,#3c544f 72%,#3c544f 100%)", backgroundSize: "200% 100%", WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent", color: "transparent", animation: "awaitsweep 3s linear infinite" }}>awaiting your command</span>
        <span style={{ width: 7, height: 14, background: "#7fe9d8", display: "inline-block", boxShadow: "0 0 8px rgba(127,233,216,.7)", animation: "caretbreath 1.5s ease-in-out infinite" }} />
      </div>
    </div>
  );
}

export function Terminal({
  view, onView, selected, activeProject, branch, turns, activeId, onRespond,
  error, scrollRef, contentRef, composer, onOpenFromHistory, liveTurns, trailingWorking,
}: {
  view: "chat" | "history";
  onView: (v: "chat" | "history") => void;
  selected: SessionBrief | null;
  activeProject?: string | null;
  branch?: string | null;
  model: string;
  turnCount: number;
  turns: Turn[];
  activeId: string | null;
  onRespond: (requestId: string, opts: { behavior?: "allow" | "deny"; answers?: AnswerSelection[] }) => void;
  error: string | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  composer: ReactNode;
  onOpenFromHistory: (s: EnrichedSession) => void;
  liveTurns?: Set<string>;
  trailingWorking?: boolean;
}) {
  const surf = surfaceFor(selected?.origin);
  const sessionProject = selected?.project ?? activeProject ?? null;
  const tint = projectTint(sessionProject);
  const projectLabel = basename(sessionProject);
  const empty = view === "chat" && turns.length === 0;

  return (
    <div
      className="panel"
      data-ctx-type="terminal"
      style={{ border: "1px solid rgba(127,233,216,.2)", background: "rgba(7,13,13,.6)", display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0, overflow: "hidden", animation: "enterZoom .65s cubic-bezier(.2,.8,.2,1) both .12s" }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "8px 14px", flex: "none", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11, minWidth: 0, overflow: "hidden" }}>
          <span title="active project" style={{ display: "flex", alignItems: "center", gap: 5, flex: "none", fontSize: 9, letterSpacing: 1, color: tint.color, border: `1px solid ${tint.border}`, padding: "2px 7px" }}>
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: tint.color }} />
            {projectLabel || "—"}
          </span>
          {branch && (
            <span title="session branch" style={{ display: "flex", alignItems: "center", gap: 4, flex: "none", fontSize: 9, letterSpacing: ".5px", color: "#a78bf0", border: "1px solid rgba(185,166,255,.28)", padding: "2px 7px" }}>
              <span style={{ color: "#b9a6ff" }}>⎇</span>{branch}
            </span>
          )}
          <span style={{ fontSize: 11, letterSpacing: ".5px", color: "#9fc7c0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {selected?.title || "new session"}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 9, flex: "none" }}>
          <span style={{ fontSize: 9, letterSpacing: 1, color: surf.color, border: `1px solid ${surf.color}`, padding: "2px 7px" }}>
            {surf.label.toUpperCase()}
          </span>
          <div style={{ display: "flex" }}>
            {(["chat", "history"] as const).map((v) => (
              <button key={v} onClick={() => onView(v)}
                style={{ appearance: "none", cursor: "pointer", border: `1px solid ${view === v ? "#7fe9d8" : "rgba(127,233,216,.16)"}`, background: view === v ? "rgba(127,233,216,.08)" : "transparent", color: view === v ? "#dff8f2" : "#3c544f", fontFamily: "inherit", fontSize: 9, letterSpacing: 1.5, padding: "3px 8px" }}>
                {v === "chat" ? "CHAT" : "HIST"}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div style={{ height: 1, background: "linear-gradient(90deg,#7fe9d8,rgba(127,233,216,.05))", transformOrigin: "left", animation: "drawline .8s ease both .15s", flex: "none" }} />

      {view === "history" ? (
        <div style={{ minHeight: 0, flex: 1, overflowY: "auto" }}>
          <HistoryView onOpen={onOpenFromHistory} />
        </div>
      ) : (
        <>
          <div ref={scrollRef} className="mscroll" style={{ flex: 1, minHeight: 0, padding: "16px 18px", fontFamily: "'JetBrains Mono',monospace", fontSize: 13, lineHeight: 1.6, overflowWrap: "break-word" }}>
            <div ref={contentRef}>
              {empty ? (
                <FreshState project={sessionProject} />
              ) : (
                <Transcript turns={turns} activeId={activeId} onRespond={onRespond} liveTurns={liveTurns} trailingWorking={trailingWorking} />
              )}
              {error && (
                <div style={{ marginTop: 8, border: "1px solid rgba(224,137,122,.3)", background: "rgba(224,137,122,.06)", padding: "4px 8px", fontSize: 12, color: "#e0897a" }}>
                  {error}
                </div>
              )}
            </div>
          </div>
          {composer}
        </>
      )}
    </div>
  );
}
