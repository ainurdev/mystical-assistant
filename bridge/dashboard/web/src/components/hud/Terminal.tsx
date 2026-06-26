import type { ReactNode, RefObject } from "react";
import type { AnswerSelection, EnrichedSession, SessionBrief } from "../../api";
import type { Turn } from "../../chat";
import { surfaceFor } from "../../lib/surfaces";
import { Transcript } from "../Transcript";
import { HistoryView } from "../HistoryView";
import { RuneSpirit } from "./RuneSpirit";

function basename(rel: string | null | undefined): string | null {
  if (!rel) return null;
  const clean = rel.replace(/\/+$/, "");
  if (clean === "" || clean === "/") return "/";
  return clean.split("/").pop() || clean;
}

export function Terminal({
  view,
  onView,
  selected,
  activeProject,
  turns,
  activeId,
  onRespond,
  error,
  scrollRef,
  contentRef,
  composer,
  onOpenFromHistory,
  liveTurns,
  trailingWorking,
}: {
  view: "chat" | "history";
  onView: (v: "chat" | "history") => void;
  selected: SessionBrief | null;
  activeProject?: string | null;
  model: string;
  turnCount: number;
  turns: Turn[];
  activeId: string | null;
  onRespond: (
    requestId: string,
    opts: { behavior?: "allow" | "deny"; answers?: AnswerSelection[] },
  ) => void;
  error: string | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  composer: ReactNode;
  onOpenFromHistory: (s: EnrichedSession) => void;
  liveTurns?: Set<string>;
  trailingWorking?: boolean;
}) {
  const surf = surfaceFor(selected?.origin);
  // Which project this terminal is bound to, and whether the next message would
  // actually land in a *different* project than the open session belongs to.
  const sessionProject = selected?.project ?? null;
  const projectLabel = basename(sessionProject ?? activeProject);
  const projectPath = sessionProject ?? activeProject ?? undefined;
  const mismatch =
    !!selected && activeProject != null && selected.project !== activeProject;
  return (
    <div
      className="panel flex min-h-0 min-w-0 flex-col overflow-hidden border border-border-bright bg-card"
      style={{ animation: "boot .55s ease both .1s" }}
    >
      <div className="flex min-w-0 flex-none items-center justify-between gap-2.5 px-3.5 py-2">
        <div className="flex min-w-0 items-center gap-3 overflow-hidden">
          <span className="flex-none text-[10.5px] tracking-[2.5px] text-muted-2">TERMINAL</span>
          <span className="flex-none text-[11px] text-primary">claude@bridge</span>
          {projectLabel && (
            <span
              className="max-w-[160px] flex-none truncate text-[11px] tracking-[0.5px] text-foreground-bright"
              title={projectPath}
            >
              ▣ {projectLabel}
            </span>
          )}
          <span className="truncate text-[10px] tracking-[1px] text-muted-2">
            · {selected?.title || "new session"}
          </span>
          {mismatch && (
            <span
              className="flex-none border border-warning px-[6px] py-0.5 text-[9px] tracking-[1px] text-warning"
              title={`This session belongs to "${selected?.project}", but the next message runs in "${activeProject}".`}
            >
              ≠ ACTIVE
            </span>
          )}
        </div>
        <div className="flex flex-none items-center gap-2.5">
          <span
            className="border px-[7px] py-0.5 text-[10px] tracking-[1px]"
            style={{ color: surf.color, borderColor: surf.color }}
          >
            {surf.label.toUpperCase()}
          </span>
          <div className="flex">
            {(["chat", "history"] as const).map((v) => (
              <button
                key={v}
                onClick={() => onView(v)}
                className="border px-2 py-0.5 text-[10px] tracking-[1.5px]"
                style={{
                  color: view === v ? "#dff8f2" : "#3c544f",
                  borderColor: view === v ? "var(--primary)" : "var(--border)",
                  background: view === v ? "var(--accent)" : "transparent",
                }}
              >
                {v === "chat" ? "CHAT" : "HIST"}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div
        className="h-px flex-none origin-left"
        style={{ background: "linear-gradient(90deg,var(--primary),var(--muted))", animation: "drawline .8s ease both .15s" }}
      />

      {view === "history" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <HistoryView onOpen={onOpenFromHistory} />
        </div>
      ) : (
        <>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-[18px] py-4 font-mono text-[13px] leading-relaxed">
            {/* Observed for height changes so the view can follow streamed
                content and the result typing out (see App's stick-to-bottom). */}
            <div ref={contentRef}>
              <Transcript turns={turns} activeId={activeId} onRespond={onRespond} liveTurns={liveTurns} trailingWorking={trailingWorking} />
              {error && (
                <div className="mt-2 border border-[rgba(224,137,122,.3)] bg-[rgba(224,137,122,.06)] px-2 py-1 text-[12px] text-danger">
                  {error}
                </div>
              )}
              {/* Idle "ready" prompt: only beneath an existing conversation, and not
                  while a run is active (the empty state and WorkingIndicator own
                  those cases — otherwise the spirit doubles up / contradicts them). */}
              {turns.length > 0 && !activeId && !trailingWorking && <RuneSpirit />}
            </div>
          </div>
          {composer}
        </>
      )}
    </div>
  );
}
