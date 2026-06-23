import type { ReactNode, RefObject } from "react";
import type { AnswerSelection, EnrichedSession, SessionBrief } from "../../api";
import type { Turn } from "../../chat";
import { surfaceFor } from "../../lib/surfaces";
import { Transcript } from "../Transcript";
import { HistoryView } from "../HistoryView";

export function Terminal({
  view,
  onView,
  selected,
  turns,
  activeId,
  onRespond,
  error,
  scrollRef,
  composer,
  onOpenFromHistory,
}: {
  view: "chat" | "history";
  onView: (v: "chat" | "history") => void;
  selected: SessionBrief | null;
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
  composer: ReactNode;
  onOpenFromHistory: (s: EnrichedSession) => void;
}) {
  const surf = surfaceFor(selected?.origin);
  return (
    <div
      className="panel flex min-h-0 min-w-0 flex-col overflow-hidden border border-border-bright bg-card"
      style={{ animation: "boot .55s ease both .1s" }}
    >
      <div className="flex min-w-0 flex-none items-center justify-between gap-2.5 px-3.5 py-2">
        <div className="flex min-w-0 items-center gap-3 overflow-hidden">
          <span className="flex-none text-[10.5px] tracking-[2.5px] text-muted-2">TERMINAL</span>
          <span className="flex-none text-[11px] text-primary">claude@bridge</span>
          <span className="truncate text-[10px] tracking-[1px] text-muted-2">
            · {selected?.title || "new session"}
          </span>
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
                  borderColor: view === v ? "#7fe9d8" : "rgba(127,233,216,.16)",
                  background: view === v ? "rgba(127,233,216,.08)" : "transparent",
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
        style={{ background: "linear-gradient(90deg,#7fe9d8,rgba(127,233,216,.05))", animation: "drawline .8s ease both .15s" }}
      />

      {view === "history" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <HistoryView onOpen={onOpenFromHistory} />
        </div>
      ) : (
        <>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-[18px] py-4 font-mono text-[13px] leading-relaxed">
            <Transcript turns={turns} activeId={activeId} onRespond={onRespond} />
            {error && (
              <div className="mt-2 border border-[rgba(224,137,122,.3)] bg-[rgba(224,137,122,.06)] px-2 py-1 text-[12px] text-danger">
                {error}
              </div>
            )}
            <div className="mt-2.5 flex gap-[9px] text-muted-foreground">
              <span className="text-violet">~ ❯</span>
              <span
                className="inline-block h-4 w-[9px] bg-primary"
                style={{ animation: "caret 1.05s steps(1) infinite" }}
              />
            </div>
          </div>
          {composer}
        </>
      )}
    </div>
  );
}
