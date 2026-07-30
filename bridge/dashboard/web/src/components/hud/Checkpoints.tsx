import { useEffect, useRef, useState } from "react";
import type { Turn } from "../../chat";

/** Anchor id for a checkpoint: a turn's prompt, or a question card inside it. */
export function ckId(turnId: string, requestId?: string): string {
  return `ck-${turnId}${requestId ? `-${requestId}` : ""}`;
}

interface Mark {
  id: string;
  label: string;
  question: boolean;
}

function marksOf(turns: Turn[]): Mark[] {
  const out: Mark[] = [];
  for (const t of turns) {
    const prompt = (t.prompt || "").trim();
    if (prompt) out.push({ id: ckId(t.id), label: prompt, question: false });
    for (const e of t.events)
      if (e.type === "question")
        out.push({
          id: ckId(t.id, e.request_id),
          label: e.questions[0]?.header || e.questions[0]?.question || "question",
          question: true,
        });
  }
  return out;
}

/** Header button + dropdown listing this session's checkpoints (each prompt and
 *  each question asked), so a long session can be navigated without scrolling. */
export function Checkpoints({ turns }: { turns: Turn[] }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const items = marksOf(turns);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  if (!items.length) return null;

  const jump = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setOpen(false);
  };

  let n = 0;
  return (
    <span ref={wrapRef} style={{ position: "relative", flex: "none", display: "flex" }}>
      <button
        onClick={() => setOpen(!open)}
        title="checkpoints — jump to a prompt or question"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          appearance: "none",
          cursor: "pointer",
          border: `1px solid color-mix(in srgb, var(--acc) ${open ? 45 : 25}%, transparent)`,
          background: open || hover ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent",
          color: open || hover ? "var(--txb)" : "var(--txm)",
          fontFamily: "inherit",
          padding: "3px 6px",
          display: "flex",
          alignItems: "center",
        }}
      >
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 6h10M4 12h10M4 18h10" />
          <path d="M18 4v16l3-3" />
        </svg>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            zIndex: 60,
            width: 330,
            maxHeight: 340,
            overflowY: "auto",
            border: "1px solid color-mix(in srgb, var(--acc) 40%, transparent)",
            background: "color-mix(in srgb, var(--panel2) 99%, transparent)",
            boxShadow: "0 16px 44px var(--shadow-pop)",
            animation: "mslide .16s ease both",
          }}
        >
          <div style={{ padding: "11px 11px 7px", fontSize: 9, letterSpacing: 2, color: "var(--acc)" }}>
            CHECKPOINTS
          </div>
          {items.map((m) => {
            if (!m.question) n++;
            return (
              <button
                key={m.id}
                onClick={() => jump(m.id)}
                className="hover:bg-[var(--ac-12)]"
                style={{
                  appearance: "none",
                  cursor: "pointer",
                  border: 0,
                  borderTop: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)",
                  background: "transparent",
                  fontFamily: "inherit",
                  width: "100%",
                  textAlign: "left",
                  display: "flex",
                  gap: 8,
                  padding: m.question ? "7px 11px 7px 26px" : "7px 11px",
                }}
              >
                <span style={{ flex: "none", fontSize: 9, letterSpacing: 1, color: m.question ? "var(--purple)" : "var(--acc)", marginTop: 2 }}>
                  {m.question ? "?" : n}
                </span>
                <span style={{ minWidth: 0, fontSize: 11.5, lineHeight: 1.45, color: "var(--tx)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere" }}>
                  {m.label}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}
