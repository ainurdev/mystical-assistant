import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { api, PUSHED_EVENT, type PrStatus } from "../../api";
import { TONE, chipLabel, commentsMessage, duration, failureMessage, freshPings, pingText, reviewItems, stateLine } from "../../lib/prchip";
import { initials } from "../../lib/rivendelltasks";
import { hairline } from "../../lib/shell";
import { ago } from "../../lib/surfaces";
import { askConfirm } from "../ui/Ask";
import { notify } from "./Notifications";

/** The branch's PR in the chat header's caption row, and its popover
 *  (review loop B/C, docs/superpowers/specs/review-loop.md).
 *
 *  It polls GET /local/github/pr/status every 60s while this tab is visible,
 *  on focus, and a few seconds after any dashboard push (api.ts fires
 *  PUSHED_EVENT). Every failure is silent. A bridge still on pre-restart code
 *  404s the route, and gh may be missing or signed out. Neither draws a chip
 *  or raises a toast. The bell rings for the alerts the bridge pinged
 *  Telegram about (`pinged`), once per browser: the last set seen is kept in
 *  localStorage. */

const POLL_MS = 60_000;
const AFTER_PUSH_MS = 8_000;   // GitHub needs a moment to see the new head and queue its checks
const SEEN = (project: string, branch: string) => `pr-pinged:${project}@${branch}`;

function ringBell(project: string, branch: string, s: PrStatus) {
  let seen: string[] = [];
  try { seen = JSON.parse(localStorage.getItem(SEEN(project, branch)) ?? "[]"); } catch { /* first look */ }
  if (s.pr) for (const k of freshPings(seen, s.pinged)) notify(k.startsWith("failing:") ? "error" : "info", pingText(s.pr, k));
  try { localStorage.setItem(SEEN(project, branch), JSON.stringify(s.pinged)); } catch { /* full: may ring again */ }
}

/** "just now", "3m ago": `ago` speaks epoch seconds, gh speaks ISO. */
const since = (sec: number) => { const a = ago(sec); return !a || a === "now" ? "just now" : `${a} ago`; };
const sinceIso = (iso: string) => since(Date.parse(iso) / 1000);

export function PrChip({ project, branch, sessionId, title, inWorktree, busy, onSend, onArchive }: {
  project: string;
  branch: string;
  sessionId: string;
  title: string;
  /** The session runs in a linked worktree, so REMOVE WORKTREE applies. */
  inWorktree: boolean;
  /** A turn is running: removing its tree would pull it out from under it. */
  busy: boolean;
  onSend: (text: string) => void;
  onArchive: () => void;
}) {
  const [snap, setSnap] = useState<PrStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [hov, setHov] = useState("");
  const chipRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const hp = (k: string) => ({ onMouseEnter: () => setHov(k), onMouseLeave: () => setHov("") });

  useEffect(() => {
    setSnap(null);
    setOpen(false);
    let live = true;
    let later = 0;
    const load = (force = false) => {
      if (document.visibilityState !== "visible") return;
      api.prStatus(project, branch, sessionId, force)
        .then((s) => { if (!live) return; setSnap(s); ringBell(project, branch, s); })
        .catch(() => { /* no chip: a pre-restart bridge (404) or offline. Never a toast. */ });
    };
    const onVisible = () => { if (document.visibilityState === "visible") load(true); };
    const onPushed = (e: Event) => {
      const d = (e as CustomEvent<{ project: string; branch: string }>).detail;
      if (d.project !== project || (d.branch && d.branch !== branch)) return;
      window.clearTimeout(later);
      later = window.setTimeout(() => load(true), AFTER_PUSH_MS);
    };
    load();
    const id = window.setInterval(() => load(), POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener(PUSHED_EVENT, onPushed);
    return () => {
      live = false;
      window.clearInterval(id);
      window.clearTimeout(later);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener(PUSHED_EVENT, onPushed);
    };
  }, [project, branch, sessionId]);

  // Closes on a click outside or on Esc. The Esc listener bubbles on document,
  // so the HUD's confirm dialog takes Esc first, and App's window handler
  // (which closes overlays) never sees this one.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!chipRef.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const pr = snap?.pr;
  if (!pr || !snap) return null;
  const tone = TONE[pr.status];
  const lab = chipLabel(pr);

  function send(text: string) { onSend(text); setOpen(false); }

  async function archive() {
    if (await askConfirm(`Archive “${title || "this session"}”? It leaves the sessions list. HISTORY keeps it.`)) onArchive();
  }

  async function removeWorktree() {
    const wts = await api.worktrees(project).catch(() => null);
    const w = wts?.worktrees.find((x) => x.branch === branch && !x.is_main);
    if (!w) { notify("info", `No linked worktree holds ${branch}.`); return; }
    if (!(await askConfirm(`Remove the worktree at ${w.path}? Uncommitted changes in it are deleted. The branch stays.`))) return;
    const r = await api.worktreeRemove(project, w.path, branch, false)
      .catch((e: Error) => ({ ok: false, output: e.message }));
    notify(r.ok ? "info" : "error", r.ok ? `Removed the ${branch} worktree.` : `Remove failed: ${r.output}`);
  }

  const rect = chipRef.current?.getBoundingClientRect();
  const top = (rect?.bottom ?? 0) + 8;
  const left = Math.max(8, Math.min((rect?.left ?? 0) - 40, window.innerWidth - 438));
  const sect: CSSProperties = { borderTop: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", padding: "8px 12px 10px" };
  const head: CSSProperties = { display: "flex", alignItems: "center", gap: 8, fontSize: "var(--t85)", letterSpacing: 1.6, color: "var(--txl)", marginBottom: 6 };
  const wide = (ink: string, k: string): CSSProperties => ({
    width: "100%", marginTop: 9, appearance: "none", cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t95)", letterSpacing: 1.4,
    padding: "8px 9px", border: `1px solid ${ink}`, color: ink,
    background: `color-mix(in srgb, ${ink} ${hov === k ? 18 : 10}%, transparent)`,
  });
  const spin = (size: number): CSSProperties => ({
    width: size, height: size, flex: "none", borderRadius: "50%", display: "inline-block",
    border: "1.5px solid color-mix(in srgb, var(--acc) 30%, transparent)", borderTopColor: "var(--acc)",
    animation: "introspin 1s linear infinite",
  });
  const items = reviewItems(pr);

  return (
    <>
      <span style={hairline(9)} />
      <button ref={chipRef} onClick={() => setOpen((o) => !o)} title={`PR #${pr.number}: checks and review`} {...hp("chip")}
        style={{ display: "inline-flex", alignItems: "center", gap: 5, flex: "none", height: 12, boxSizing: "border-box", padding: "0 5px", appearance: "none", cursor: "pointer", border: `1px solid ${tone.border}`, background: tone.bg, color: tone.fg, fontFamily: "var(--mono)", fontSize: "var(--t9)", letterSpacing: ".6px", lineHeight: 1, filter: hov === "chip" || open ? "brightness(1.2)" : undefined }}>
        <span style={{ color: tone.num }}>⇡ #{pr.number}</span>
        {lab.spin && <span aria-hidden style={spin(7)} />}
        {lab.text}
        <span aria-hidden style={{ opacity: 0.7 }}>▾</span>
      </button>
      {open && createPortal(
        <div ref={popRef} className="mscroll"
          style={{ position: "fixed", top, left, width: 430, maxHeight: `calc(100vh - ${top + 16}px)`, overflowY: "auto", zIndex: 80, fontFamily: "var(--mono)", border: "1px solid color-mix(in srgb, var(--acc) 40%, transparent)", background: "color-mix(in srgb, var(--panel2) 99%, transparent)", boxShadow: "0 14px 40px var(--shadow-pop)", animation: "mslide .16s ease both" }}>
          <div style={{ padding: "10px 12px 8px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--t9)", letterSpacing: 1.3 }}>
              <span style={{ color: tone.ink }}>{tone.glyph}</span>
              <span style={{ color: "var(--txb)" }}>PR #{pr.number}</span>
              <span style={{ color: "var(--txl)" }}>· {stateLine(pr)}{pr.state === "MERGED" && pr.merged_at ? ` · ${sinceIso(pr.merged_at)}` : ""}</span>
              <span style={{ flex: 1 }} />
              <a href={pr.url} target="_blank" rel="noreferrer" {...hp("gh")} style={{ color: hov === "gh" ? "var(--txb)" : "var(--txm)", textDecoration: "none" }}>GITHUB ↗</a>
            </div>
            <div style={{ fontSize: "var(--t12)", color: "var(--txb)", margin: "5px 0 3px" }}>{pr.title}</div>
            {pr.state === "OPEN" && (
              <div style={{ fontSize: "var(--t95)", color: "var(--txl)", display: "flex", flexWrap: "wrap", gap: 6 }}>
                <span style={{ color: "var(--purple-d)" }}>⎇ {pr.head} → {pr.base}</span>·
                <span style={{ color: "var(--ok)" }}>+{pr.additions}</span><span style={{ color: "var(--err)" }}>−{pr.deletions}</span>·
                <span>opened {sinceIso(pr.created)}</span>
              </div>
            )}
          </div>

          {pr.state === "OPEN" && pr.total > 0 && (
            <div style={sect}>
              <div style={head}>
                CHECKS <span style={{ color: "var(--txh)" }}>{pr.passed + pr.failed}/{pr.total}</span>
                {pr.failed > 0 && <span style={{ color: "var(--err)" }}>· {pr.failed} FAILING</span>}
                <span style={{ marginLeft: "auto", letterSpacing: ".5px" }}>↻ {since(snap.checked)}</span>
              </div>
              {pr.checks.map((c) => (
                <div key={`${c.workflow}/${c.name}`}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--t105)", padding: "3px 0" }}>
                    <span style={{ width: 12, flex: "none", display: "flex", justifyContent: "center", color: c.state === "fail" ? "var(--err)" : "var(--ok)" }}>
                      {c.state === "run" ? <span aria-hidden style={spin(9)} /> : c.state === "fail" ? "✕" : "✓"}
                    </span>
                    <span style={{ flex: 1, minWidth: 0, color: c.state === "fail" ? "var(--err-hi)" : "var(--txh)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</span>
                    <span style={{ color: "var(--txl)", fontSize: "var(--t95)", flex: "none" }}>{duration(c.started, c.completed, Date.now())}</span>
                    {c.url && <a href={c.url} target="_blank" rel="noreferrer" {...hp(`log:${c.name}`)}
                      style={{ flex: "none", fontSize: "var(--t85)", letterSpacing: 1, textDecoration: "none", padding: "1px 5px", border: "1px solid color-mix(in srgb, var(--acc) 22%, transparent)", color: hov === `log:${c.name}` ? "var(--txb)" : "var(--txm)" }}>LOG ▸</a>}
                  </div>
                  {c.state === "fail" && c.log && (
                    <div style={{ margin: "3px 0 7px 20px", borderLeft: "2px solid color-mix(in srgb, var(--err) 50%, transparent)", background: "color-mix(in srgb, var(--err) 5%, transparent)", padding: "4px 9px", fontSize: "var(--t95)", lineHeight: 1.55, color: "var(--txd)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                      {c.log.split("\n").slice(-6).join("\n")}
                    </div>
                  )}
                </div>
              ))}
              {pr.failed > 0 && <button onClick={() => send(failureMessage(pr))} {...hp("sendfail")} style={wide("var(--err)", "sendfail")}>SEND FAILURE TO AGENT ▸</button>}
            </div>
          )}

          {pr.state === "OPEN" && (pr.review || pr.requested.length > 0 || pr.reviews.some((r) => r.state === "APPROVED")) && (
            <div style={sect}>
              {pr.review ? (
                <>
                  <div style={head}>REVIEW · <span style={{ color: "var(--txh)" }}>{pr.review.by.toUpperCase()}</span> · {items.length} COMMENT{items.length === 1 ? "" : "S"} · {sinceIso(pr.review.at)}</div>
                  {items.map((c, i) => (
                    <div key={i} style={{ borderLeft: "2px solid color-mix(in srgb, var(--warn) 60%, transparent)", background: "color-mix(in srgb, var(--warn) 5%, transparent)", padding: "5px 9px", marginBottom: 6, fontSize: "var(--t105)", lineHeight: 1.45, color: "var(--txh)" }}>
                      {c.path && <span style={{ display: "block", fontSize: "var(--t9)", letterSpacing: ".4px", color: "var(--warn)", marginBottom: 1 }}>{c.path.split("/").pop()}{c.line ? `:${c.line}` : ""}</span>}
                      <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{c.body}</span>
                    </div>
                  ))}
                  {items.length > 0 && <button onClick={() => send(commentsMessage(pr))} {...hp("sendrev")} style={wide("var(--warn)", "sendrev")}>SEND {items.length} COMMENT{items.length === 1 ? "" : "S"} TO AGENT ▸</button>}
                </>
              ) : (
                <>
                  <div style={head}>REVIEW</div>
                  {pr.requested.map((who) => (
                    <div key={who} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--t105)", color: "var(--txd)", padding: "2px 0" }}>
                      <span style={{ width: 18, height: 18, borderRadius: "50%", flex: "none", display: "grid", placeItems: "center", fontSize: "var(--t75)", color: "var(--txb)", background: "color-mix(in srgb, var(--txl) 40%, transparent)" }}>{initials(who.replace(/[-_.]/g, " "))}</span>
                      requested from {who} · no review yet
                    </div>
                  ))}
                  {pr.reviews.filter((r) => r.state === "APPROVED").map((r) => (
                    <div key={r.by} style={{ fontSize: "var(--t105)", color: "var(--ok)", padding: "2px 0" }}>✓ approved by {r.by}</div>
                  ))}
                </>
              )}
            </div>
          )}

          {pr.state === "MERGED" && (
            <div style={sect}>
              <div style={{ fontSize: "var(--t105)", color: "var(--txd)", lineHeight: 1.5, marginBottom: 9 }}>
                This branch's work is in <span style={{ color: "var(--txh)" }}>{pr.base}</span>. The session and its worktree can go.
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => void archive()} {...hp("arch")} style={{ ...wide("var(--purple)", "arch"), marginTop: 0, flex: 1, color: "var(--purple-h)" }}>ARCHIVE SESSION</button>
                {inWorktree && (
                  <button onClick={() => void removeWorktree()} disabled={busy} title={busy ? "a turn is running in it" : undefined} {...hp("rmwt")}
                    style={{ ...wide("var(--txm)", "rmwt"), marginTop: 0, flex: 1, background: "transparent", opacity: busy ? 0.45 : 1, cursor: busy ? "not-allowed" : "pointer" }}>REMOVE WORKTREE</button>
                )}
              </div>
              <div style={{ marginTop: 9, fontSize: "var(--t95)", color: "var(--txl)" }}>Each asks first. Nothing is archived or removed on its own.</div>
            </div>
          )}

          <div style={{ borderTop: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)", padding: "6px 12px", fontSize: "var(--t85)", letterSpacing: 1, color: "var(--txg)" }}>
            CHECKED EVERY 60S WHILE THE SESSION IS OPEN · VIA gh
          </div>
        </div>,
        document.querySelector("[data-theme]") ?? document.body,
      )}
    </>
  );
}
