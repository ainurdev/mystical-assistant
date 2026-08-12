import { useMemo, useState } from "react";
import { List, X } from "lucide-react";
import { useChat, type Turn } from "../lib/chat";

/* CHECKPOINTS — every prompt in this chat as one list, so a long conversation is
   navigable without scrolling through it. A turn that asked you something shows
   up as its own amber mark: the sheet is also where an unanswered question is
   found again after you have scrolled away. Everything here is derived from the
   transcript already in memory — no endpoint, no poll. */

interface Mark {
  turnId: string;
  n: number | null;      // prompt number; null for a question mark
  kind: "prompt" | "question";
  text: string;
  meta: string;
  tone: "" | "waiting" | "running" | "failed";
}

function turnMarks(turn: Turn, n: number): Mark[] {
  const tools = turn.events.filter((e) => e.type === "tool").length;
  const result = turn.events.find((e) => e.type === "result");
  const bits: string[] = [];
  if (turn.status === "running") bits.push("RUNNING");
  else if (turn.status === "error") bits.push("FAILED");
  if (tools) bits.push(`${tools} TOOL${tools === 1 ? "" : "S"}`);
  if (result && result.type === "result") {
    if (result.elapsed) bits.push(`${result.elapsed.toFixed(0)}S`);
  }
  const marks: Mark[] = [
    {
      turnId: turn.id,
      n,
      kind: "prompt",
      text: turn.prompt || "(no prompt)",
      meta: bits.join(" · "),
      tone: turn.status === "running" ? "running" : turn.status === "error" ? "failed" : "",
    },
  ];
  // A question the turn asked — answered ones stay (they are checkpoints too),
  // the open one wears the amber and sorts nowhere: it keeps its place in time.
  const open = new Set(turn.pending.map((p) => p.request_id));
  for (const e of turn.events) {
    if (e.type !== "question") continue;
    marks.push({
      turnId: turn.id,
      n: null,
      kind: "question",
      text: e.questions[0]?.question ?? "Question",
      meta: open.has(e.request_id) ? "WAITING ON YOU" : "ANSWERED",
      tone: open.has(e.request_id) ? "waiting" : "",
    });
  }
  return marks;
}

const TONE: Record<Mark["tone"], string> = {
  "": "text-[var(--tg-hint)]",
  waiting: "text-amber-400",
  running: "text-amber-400",
  failed: "text-[var(--danger)]",
};

/** Header button: how many marks, and whether one of them wants you. */
export function CheckpointsButton() {
  const [open, setOpen] = useState(false);
  const { turns, pending } = useChat();
  const waiting = pending.some((p) => p.kind === "question");

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Checkpoints"
        className="flex shrink-0 items-center gap-1.5 border border-border-bright/60 px-2 py-1.5 text-[var(--tg-hint)] active:opacity-70"
      >
        <List size={13} aria-hidden />
        <span className="text-[10px] tracking-wider">{turns.length}</span>
        {waiting && (
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shadow-[0_0_6px_var(--warning)]" />
        )}
      </button>
      {open && <CheckpointsSheet turns={turns} onClose={() => setOpen(false)} />}
    </>
  );
}

function CheckpointsSheet({ turns, onClose }: { turns: Turn[]; onClose: () => void }) {
  const [filter, setFilter] = useState("");
  const marks = useMemo(
    () => turns.flatMap((t, i) => turnMarks(t, i + 1)),
    [turns],
  );
  const q = filter.trim().toLowerCase();
  const shown = q ? marks.filter((m) => m.text.toLowerCase().includes(q)) : marks;
  const waiting = marks.filter((m) => m.tone === "waiting").length;

  function jump(m: Mark) {
    onClose();
    document.getElementById(`turn-${m.turnId}`)?.scrollIntoView({ block: "start" });
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/50" onClick={onClose}>
      <div
        className="flex max-h-[78%] flex-col border-t border-border-bright bg-[var(--tg-bg)] shadow-[0_-16px_44px_rgba(0,0,0,0.6)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-center pb-0.5 pt-2">
          <span className="h-1 w-9 rounded-full bg-[var(--ac-22)]" />
        </div>
        <div className="flex items-center gap-2 px-3.5 py-2">
          <span className="text-[9.5px] tracking-[2px] text-[var(--brand-soft)]">CHECKPOINTS</span>
          <span className="text-[9.5px] tracking-wider text-[var(--tg-hint)]">
            {marks.length} MARK{marks.length === 1 ? "" : "S"}
            {waiting ? ` · ${waiting} WAITING` : ""}
          </span>
          <button onClick={onClose} aria-label="Close" className="ml-auto">
            <X size={16} />
          </button>
        </div>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter…"
          className="border-t border-border bg-transparent px-3.5 py-1.5 text-xs outline-none placeholder:text-[var(--tg-hint)]"
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {shown.length === 0 && (
            <div className="p-6 text-center text-xs text-[var(--tg-hint)]">
              {marks.length ? "Nothing matches." : "No marks in this chat yet."}
            </div>
          )}
          {shown.map((m, i) => (
            <button
              key={`${m.turnId}-${i}`}
              onClick={() => jump(m)}
              className={`flex w-full gap-2 border-t border-border px-3.5 py-2.5 text-left active:opacity-70 ${
                m.tone === "waiting"
                  ? "border-l-2 border-l-amber-400 bg-[var(--ac-06)] pl-6"
                  : "border-l-2 border-l-transparent"
              } ${m.kind === "question" && m.tone !== "waiting" ? "pl-6" : ""}`}
            >
              <span
                className={`mt-0.5 shrink-0 text-[9.5px] tracking-wider ${
                  m.kind === "question" ? "text-amber-400" : "text-[var(--brand-soft)]"
                }`}
              >
                {m.kind === "question" ? "?" : m.n}
              </span>
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 block text-[11.5px] leading-snug">{m.text}</span>
                {m.meta && (
                  <span className={`mt-0.5 block text-[9px] tracking-wide ${TONE[m.tone]}`}>
                    {m.meta}
                  </span>
                )}
              </span>
              {m.tone === "waiting" && (
                <span className="shrink-0 self-center border border-amber-400/50 px-2 py-1 text-[9px] tracking-[1.5px] text-amber-400">
                  ANSWER →
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
