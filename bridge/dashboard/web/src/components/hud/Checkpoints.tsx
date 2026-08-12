import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from "react";
import { api } from "../../api";
import type { Turn } from "../../chat";
import { fmtElapsed, marksOf, toneOf, type Mark } from "../../lib/checkpoints";
import type { TranscriptNav } from "../Transcript";
import { SteerIcon } from "../Composer";

/** Index of the last checkpoint scrolled past — "where am I" in the transcript.
 *  Prefers the virtualizer's row offsets (an unmounted mark has no DOM rect);
 *  falls back to DOM rects per mark — full-mount mode, or the mark's turn not
 *  in the rendered list at all. */
function activeIndex(marks: Mark[], root: HTMLElement | null,
                     nav?: TranscriptNav | null): number {
  if (!root) return 0;
  const scrollTop = root.scrollTop + 8;
  const top = root.getBoundingClientRect().top + 8;
  let idx = 0;
  marks.forEach((m, i) => {
    const rowTop = nav?.turnTop(m.turnId);
    if (rowTop != null) {
      if (rowTop <= scrollTop) idx = i;
      return;
    }
    const el = document.getElementById(m.id);
    if (el && el.getBoundingClientRect().top <= top) idx = i;
  });
  return idx;
}

function jump(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Header button + dropdown listing this session's checkpoints (each prompt, each
 *  question asked and each steer sent mid-turn), so a long session can be
 *  navigated without scrolling. Type to filter, ↑↓ to move, Enter to jump. */
export function Checkpoints({
  turns, scrollRef, project, branch, nav, onJump,
}: {
  turns: Turn[];
  scrollRef?: RefObject<HTMLDivElement | null>;
  /** Virtualized-transcript navigation; absent -> plain getElementById jumps. */
  nav?: MutableRefObject<TranscriptNav | null>;
  /** Jump handler that can auto-load turns hidden behind the tail cut. */
  onJump?: (m: Mark) => void;
  /** Project + branch for the "since this checkpoint" git lookup. */
  project?: string | null;
  branch?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  // sha -> drift between that commit and the tree now, fetched as rows are picked.
  const [drift, setDrift] = useState<Map<string, { add: number; del: number }>>(new Map());
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const items = useMemo(() => marksOf(turns), [turns]);
  const shown = q ? items.filter((m) => m.label.toLowerCase().includes(q.toLowerCase())) : items;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  // Open onto where you are, not onto turn 1.
  useLayoutEffect(() => {
    if (!open) return;
    setQ("");
    setSel(activeIndex(items, scrollRef?.current ?? null, nav?.current));
  }, [open]);

  // Keep the selected row in view (opening deep in a long session, or arrowing).
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-sel="1"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, sel, q]);

  // The picked row's drift, one git call per distinct commit, cached.
  const cur = shown[sel];
  useEffect(() => {
    const sha = cur?.sha;
    if (!open || !sha || !project || drift.has(sha)) return;
    let live = true;
    void api.since(project, sha, branch || undefined)
      .then((r) => {
        if (live && r.ok)
          setDrift((m) => new Map(m).set(sha, { add: r.add, del: r.del }));
      })
      .catch(() => {});
    return () => { live = false; };
  }, [open, cur?.sha, project, branch]);

  if (!items.length) return null;

  const pick = (i: number) => {
    const m = shown[i];
    if (!m) return;
    if (onJump) onJump(m);
    else jump(m.id);
    setOpen(false);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { setOpen(false); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, shown.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); pick(sel); }
  };

  const waiting = items.filter((m) => m.waiting).length;

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
          gap: 5,
          border: `1px solid color-mix(in srgb, var(--acc) ${open ? 45 : 25}%, transparent)`,
          background: open || hover ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent",
          color: open || hover ? "var(--txb)" : "var(--txm)",
          fontFamily: "inherit",
          fontSize: "var(--t9)",
          letterSpacing: 1,
          padding: "3px 6px",
          display: "flex",
          alignItems: "center",
        }}
      >
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 6h10M4 12h10M4 18h10" />
          <path d="M18 4v16l3-3" />
        </svg>
        {items.length}
        {waiting > 0 && (
          <span title={`${waiting} waiting on you`} style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--purple)", boxShadow: "0 0 6px var(--purple)" }} />
        )}
      </button>

      {open && (
        <div
          onKeyDown={onKey}
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            zIndex: 60,
            width: 330,
            border: "1px solid color-mix(in srgb, var(--acc) 40%, transparent)",
            background: "color-mix(in srgb, var(--panel2) 99%, transparent)",
            boxShadow: "0 16px 44px var(--shadow-pop)",
            animation: "mslide .16s ease both",
          }}
        >
          <div style={{ padding: "11px 11px 7px", fontSize: "var(--t9)", letterSpacing: 2, color: "var(--acc)" }}>
            CHECKPOINTS
          </div>
          <input
            autoFocus
            value={q}
            onChange={(e) => { setQ(e.target.value); setSel(0); }}
            placeholder="filter…"
            style={{
              appearance: "none", width: "100%", boxSizing: "border-box",
              border: 0, borderTop: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)",
              background: "transparent", fontFamily: "inherit", fontSize: "var(--t115)",
              color: "var(--tx)", padding: "7px 11px", outline: "none",
            }}
          />
          <div ref={listRef} style={{ maxHeight: 340, overflowY: "auto" }}>
            {shown.map((m, i) => {
              const sub = m.kind !== "prompt";
              const tone = toneOf(m);
              const d = m.sha ? drift.get(m.sha) : undefined;
              return (
                <button
                  key={m.id}
                  data-sel={i === sel ? "1" : undefined}
                  onClick={() => pick(i)}
                  onMouseEnter={() => setSel(i)}
                  style={{
                    appearance: "none",
                    cursor: "pointer",
                    border: 0,
                    borderTop: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)",
                    borderLeft: `2px solid ${i === sel ? tone : "transparent"}`,
                    background: i === sel ? "var(--ac-12)" : "transparent",
                    fontFamily: "inherit",
                    width: "100%",
                    textAlign: "left",
                    display: "flex",
                    gap: 8,
                    padding: sub ? "7px 11px 7px 26px" : "7px 11px",
                  }}
                >
                  <span style={{ flex: "none", fontSize: "var(--t9)", letterSpacing: 1, color: tone, marginTop: 2 }}>
                    {m.kind === "question" ? "?" : m.kind === "steer" ? <SteerIcon size={10} /> : m.n}
                  </span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ fontSize: "var(--t115)", lineHeight: 1.45, color: "var(--tx)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere" }}>
                      {m.label}
                    </span>
                    {(m.kind === "prompt" || m.waiting) && (
                      <span style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 3, fontSize: "var(--t9)", letterSpacing: .5, color: "var(--txd)" }}>
                        {m.waiting && <span style={{ color: "var(--purple)" }}>WAITING</span>}
                        {m.failed && <span style={{ color: "var(--err)" }}>FAILED</span>}
                        {m.stopped && <span>STOPPED</span>}
                        {m.status === "running" && !m.waiting && <span style={{ color: "var(--warn)" }}>RUNNING</span>}
                        {!!m.tools && <span>{m.tools} tools</span>}
                        {m.elapsed != null && <span>{fmtElapsed(m.elapsed)}</span>}
                        {d && (d.add || d.del) ? (
                          <span title={`working tree vs ${m.sha?.slice(0, 7)} — this checkpoint's commit`}>
                            <span style={{ color: "var(--ok)" }}>+{d.add}</span>{" "}
                            <span style={{ color: "var(--err)" }}>−{d.del}</span> since
                          </span>
                        ) : null}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
            {!shown.length && (
              <div style={{ padding: "10px 11px", fontSize: "var(--t11)", color: "var(--txd)" }}>no match</div>
            )}
          </div>
        </div>
      )}
    </span>
  );
}

/** The transcript's scrollbar (the native one is hidden under it): a draggable
 *  viewport thumb. Drag it or click the track to scroll. Checkpoint ticks used
 *  to live here too — a rect read per mark on every content resize, which is
 *  every frame while streaming or scrolling through unseen history. The header
 *  Checkpoints dropdown is the jump list now. */
export function ScrollRail({
  turns, scrollRef,
}: {
  turns: Turn[];
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const [win, setWin] = useState({ top: 0, h: 1 });
  const railRef = useRef<HTMLDivElement | null>(null);
  // Offset from the thumb's top to where it was grabbed; null when not dragging.
  const grab = useRef<number | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const h = el.scrollHeight || 1;
      setWin({ top: el.scrollTop / h, h: Math.min(1, el.clientHeight / h) });
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollRef, turns.length]);

  /** Where on the rail the pointer is (0..1). */
  const at = (e: React.PointerEvent) => {
    const r = railRef.current?.getBoundingClientRect();
    if (!r?.height) return 0;
    return Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  };

  const scrollTo = (f: number) => {
    const el = scrollRef.current;
    if (el) el.scrollTop = (f - (grab.current ?? win.h / 2)) * el.scrollHeight;
  };

  const onDown = (e: React.PointerEvent) => {
    const f = at(e);
    const onThumb = f >= win.top && f <= win.top + win.h;
    grab.current = onThumb ? f - win.top : win.h / 2;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (!onThumb) scrollTo(f);
    e.preventDefault();
  };

  const onMove = (e: React.PointerEvent) => {
    if (grab.current != null) scrollTo(at(e));
  };

  const end = () => { grab.current = null; };

  if (win.h >= 1) return null; // nothing to scroll

  return (
    <div
      aria-hidden
      ref={railRef}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={end}
      onPointerCancel={end}
      style={{
        position: "absolute", right: 2, top: 8, bottom: 8, width: 12,
        // Above the sticky LAST peek (5) — it spans the full width and was
        // swallowing every click on the top of the rail.
        zIndex: 8,
        cursor: "pointer", touchAction: "none",
      }}
    >
      <div style={{ position: "absolute", inset: 0, borderLeft: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)" }} />
      <div style={{ position: "absolute", left: 1, right: 0, top: `${win.top * 100}%`, height: `${win.h * 100}%`, minHeight: 18, background: "color-mix(in srgb, var(--acc) 11%, transparent)", border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)", transition: grab.current == null ? "top .1s linear" : "none" }} />
    </div>
  );
}
