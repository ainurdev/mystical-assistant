import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDownToLine, ChevronRight } from "lucide-react";
import { api, type Notice, type UpdateInfo } from "../../api";
import { notify } from "./Notifications";
import { Bullets, Meta } from "./ChangelogButton";
import { ago } from "../../lib/notices";
import { watchRestart } from "../../lib/restart";
import { popPlace } from "../../lib/prchip";

// The platform's own checkout, both directions: pull the commits waiting
// upstream (then rebuild + restart the bridge), or ship the work sitting here —
// commit it with a message Claude writes from the diff, then push. Two looks:
// `rail` is the right rail's UPDATE icon above ⌘K, always present — quiet when
// there is nothing to do, a count of incoming commits when there is (an amber
// dot for unshipped local work alone); `badge` is the labelled chip SETTINGS
// shows when an update is waiting. Before an update is taken, its popover leads
// with what it brings (bridge/whatsnew.py preview: a headline and bullets), and the
// rail's button is where that news pops out.
// ponytail: self-contained (polls + owns its popover) like NotificationCenter, so
// the Strip stays a dumb header.
const POLL_MS = 300_000; // 5 min — new commits are not a live-tail concern

export function UpdateButton({ onFeed, variant = "badge" }: {
  onFeed: (texts: string[], project?: string, fresh?: boolean) => void;
  variant?: "badge" | "rail";
}) {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<"" | "updating" | "restarting" | "shipping" | "checking">("");
  const [err, setErr] = useState("");
  const [failed, setFailed] = useState<"pull" | "build" | "ship">("pull");
  const [hov, setHov] = useState("");
  const [fresh, setFresh] = useState<Notice | null>(null);   // the waiting update, popped out of the rail button
  const [commitsOpen, setCommitsOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const busy = phase !== "";

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try { const u = await api.update(); if (live) setInfo(u); } catch { /* ignore */ }
    };
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => { live = false; clearInterval(id); };
  }, []);

  // The rail's button is where a waiting update pops out (hud:update-pop, from the
  // bell's poll) and what the changelog's Update now and an OS banner open (hud:update).
  useEffect(() => {
    if (variant !== "rail") return;
    const pop = (e: Event) => { setFresh((e as CustomEvent<Notice>).detail); void load(); };
    const show = () => { setFresh(null); void load().then(() => setOpen(true)); };
    window.addEventListener("hud:update-pop", pop);
    window.addEventListener("hud:update", show);
    return () => { window.removeEventListener("hud:update-pop", pop); window.removeEventListener("hud:update", show); };
  }, [variant]);

  // However the popover opened, the pop has done its job: it doesn't come back when it shuts.
  useEffect(() => { if (open) setFresh(null); }, [open]);

  // Release notes you opened are read: the changelog's dot needn't keep them.
  const comingId = open && info?.coming && !info.coming.read ? info.coming.id : null;
  useEffect(() => {
    if (comingId !== null) void api.noticesRead([comingId]).catch(() => { /* next poll */ });
  }, [comingId]);

  // Closes the way the PR chip's popover does: a press outside it, or Escape —
  // unless a pull or push is mid-flight, when it stays until that lands.
  useEffect(() => {
    if (!open || busy) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!btnRef.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open, busy]);

  async function load() {
    try { setInfo(await api.update()); } catch { /* ignore */ }
  }

  // Pull + rebuild happen inside this one request (tens of seconds); the bridge
  // only restarts once it answers ok.
  async function apply() {
    setPhase("updating");
    setErr("");
    try {
      const r = await api.applyUpdate();
      if (!r.ok) {
        setPhase("");
        setFailed(r.pulled ? "build" : "pull");
        setErr(r.output || "git pull failed");
        return;
      }
    } catch (e) {
      setPhase("");
      setFailed("pull");
      setErr((e as Error).message);
      return;
    }
    setPhase("restarting");
    void waitForRestart();
  }

  // Commit (message generated server-side from the diff) + push, in one request.
  // Slow — a headless model call — so the button says COMMITTING while it runs.
  async function ship() {
    setPhase("shipping");
    setErr("");
    try {
      const r = await api.publishUpdate();
      if (!r.ok) {
        setPhase("");
        setFailed("ship");
        setErr(r.output || "commit/push failed");
        return;
      }
      notify("info", r.message ? `pushed — ${r.message.split("\n")[0]}` : "pushed");
    } catch (e) {
      setPhase("");
      setFailed("ship");
      setErr((e as Error).message);
      return;
    }
    setPhase("");
    setOpen(false);
    await load();
  }

  // Escape hatch when git refuses (diverged history, rejected push…) or a build
  // breaks after the pull landed: hand the failure to Claude rather than making
  // the user go find a terminal — in a new session in the bridge's own checkout,
  // not whichever session is open (it may be another repo, or a worktree of this one).
  function fixWithClaude() {
    const where = info?.path || "the mystical-assistant repo";
    const pending = info?.behind ?? 0;
    onFeed([
      failed === "ship"
        ? `Committing and pushing the platform's own work in \`${where}\` failed. Work out ` +
          `what blocks it and fix it, then commit the changes with a good message and push.` +
          `\n\ngit said:\n${err}`
        : failed === "build"
        ? `Updating the platform failed after the pull landed: \`git pull --ff-only\` in the ` +
          `bridge's own checkout (${where}) brought the new commits in, then a web build broke. ` +
          `Work out why and fix it, then rebuild and restart so the update goes live.` +
          `\n\nThe update said:\n${err}`
        : `Updating the platform failed: \`git pull --ff-only\` in the bridge's own checkout ` +
          `(${where}) refused. Work out what blocks it and fix it, then pull the ${pending} ` +
          `pending commit${pending === 1 ? "" : "s"}. Don't discard my source changes — ` +
          `generated bundles under dist/ are safe to reset.\n\ngit said:\n${err}`,
    ], info?.project, true);
    setOpen(false);
    setErr("");
  }

  // The bridge is re-execing: the boot intro comes back up and waits it out,
  // then reloads into the new build. Only returns if it never came back.
  async function waitForRestart() {
    await watchRestart("PULLED");
    setPhase("");
    setOpen(false);
  }

  async function recheck() {
    setPhase("checking");
    await load();
    setPhase("");
  }

  if (!info || !info.repo) return null;
  // A bridge process older than this bundle answers without the fields it
  // predates; `dirty + undefined` is NaN, which is falsy and reads as IN SYNC —
  // the one wrong answer this button must never give. Default every field.
  const incoming = info.behind ?? 0;
  const local = (info.dirty ?? 0) + (info.ahead ?? 0);
  const tone = incoming ? "var(--ok)" : local ? "var(--warn)" : "var(--txf)";
  const label = phase === "checking" ? "CHECKING…"
    : incoming && local ? `SYNC ${incoming}↓ ${local}↑`
    : incoming ? `UPDATE ${incoming}`
    : local ? `SHIP ${local}`
    : hov === "btn" ? "RECHECK" : "IN SYNC";
  const title = incoming && local
    ? `${incoming} commit${incoming === 1 ? "" : "s"} upstream, ${local} of yours to ship`
    : incoming ? `${incoming} new commit${incoming === 1 ? "" : "s"} on ${info.branch}'s upstream`
    : local ? `${info.dirty} uncommitted change${info.dirty === 1 ? "" : "s"}, ` +
              `${info.ahead} unpushed commit${info.ahead === 1 ? "" : "s"}`
    : `${info.branch} is in sync with its upstream — click to check again`;
  const hp = (k: string) => ({ onMouseEnter: () => setHov(k), onMouseLeave: () => setHov("") });

  const onClick = () => (incoming || local ? setOpen((o) => !o) : void recheck());
  // Where the popover sits: under the button, or above it when the button is
  // low on the screen (the rail's is), flush with its right edge and on screen.
  const rect = open ? btnRef.current?.getBoundingClientRect() : undefined;
  const pop = rect && { ...popPlace(rect, window.innerHeight),
                        right: Math.max(8, Math.min(window.innerWidth - rect.right, window.innerWidth - 428)) };
  // The pop sits left of the rail, its notch on the button, like the changelog's.
  const at = fresh && !open && variant === "rail" ? btnRef.current?.getBoundingClientRect() : undefined;
  const out = at && { right: window.innerWidth - at.left + 10, bottom: Math.max(8, window.innerHeight - at.bottom - 4) };
  const coming = info.coming ?? null;
  const commitList = (
    <div style={{ marginTop: 10, maxHeight: 150, overflowY: "auto", borderLeft: "2px solid color-mix(in srgb, var(--acc) 30%, transparent)", padding: "2px 0 2px 10px" }}>
      {(info.commits ?? []).map((c) => (
        <div key={c.sha} style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t10)", color: "var(--txm)", padding: "2px 0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          <span style={{ color: "var(--acc)" }}>{c.sha}</span> {c.subject}
        </div>
      ))}
    </div>
  );
  // Sized and lit like the rail's tab buttons, so it reads as one more of them;
  // the count is the same filled pill a tab's badge is, in the update's green.
  const railBtn = (
    <button
      ref={btnRef}
      onClick={onClick}
      title={phase === "checking" ? "Checking for updates…" : `Update — ${title}`}
      aria-label="Update the platform"
      {...hp("btn")}
      className={`relative flex h-[38px] items-center justify-center border-l-2 border-transparent hover:bg-accent${out ? " clg-lit" : ""}`}
      style={{
        appearance: "none", cursor: "pointer",
        color: incoming ? "var(--ok)" : local ? "var(--warn)" : hov === "btn" ? "var(--acc)" : "var(--muted-2)",
        opacity: phase === "checking" ? 0.5 : 1,
      }}
    >
      <ArrowDownToLine size={18} strokeWidth={1.8} aria-hidden />
      {incoming > 0 ? (
        <span
          className="absolute right-[3px] top-[1px] h-[15px] min-w-[15px] rounded-full px-[3px] text-center text-[length:var(--t7)] leading-[15px]"
          style={{ background: "var(--ok)", color: "var(--acc-on)" }}
        >{incoming > 99 ? "99+" : incoming}</span>
      ) : local > 0 ? (
        <span className="absolute right-[5px] top-[4px] h-[8px] w-[8px] rounded-full" style={{ background: "var(--warn)" }} />
      ) : null}
    </button>
  );

  return (
    <>
      {variant === "rail" ? railBtn : <button
        ref={btnRef}
        onClick={onClick}
        title={title}
        {...hp("btn")}
        style={{
          appearance: "none", cursor: "pointer", flex: "none",
          height: 24, padding: "0 9px", boxSizing: "border-box",
          border: `1px solid color-mix(in srgb, ${tone} 34%, transparent)`,
          // No fill at rest: the border already says button, and beside the
          // cap's neutral readouts the tone alone is loud enough.
          background: hov === "btn" ? `color-mix(in srgb, ${tone} 12%, transparent)` : "transparent",
          color: tone, fontFamily: "var(--mono)", fontSize: "var(--t95)", letterSpacing: 1.4,
          display: "flex", alignItems: "center", gap: 6,
          opacity: incoming || local ? 1 : 0.75,
        }}
      >
        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}>
          {incoming ? <path d="M12 3v12M7 10l5 5 5-5M4 20h16" />
            : local ? <path d="M12 21V9M7 14l5-5 5 5M4 4h16" />
            : <path d="M20 6L9 17l-5-5" />}
        </svg>
        {/* The count reads as the ledger's value, not part of the verb — and a
            narrow cap drops the verb (index.css); the title still says it. */}
        <span className="trim">
          {phase !== "checking" && incoming && !local ? <><span className="shipword">UPDATE </span><span style={{ color: "var(--txm)", letterSpacing: ".4px" }}>{incoming}</span></>
            : phase !== "checking" && local && !incoming ? <><span className="shipword">SHIP </span><span style={{ color: "var(--txm)", letterSpacing: ".4px" }}>{local}</span></>
            : label}
        </span>
      </button>}

      {/* What a waiting update brings, out of the rail button: the changelog's own
          callout, 8 s (its bar's animation is the clock, so hover holds it). */}
      {fresh && out && createPortal(
        <div key={fresh.id} className="clg-co" style={out} role="status" onClick={() => { setFresh(null); setOpen(true); }}>
          <div className="in">
            <div className="clg-co-h">
              <ArrowDownToLine size={13} strokeWidth={1.8} className="clg-ic" />
              <span className="v">{fresh.verb}</span>
              <span className="w">{ago(fresh.at, Date.now() / 1000)}</span>
            </div>
            <div className="clg-co-t">{fresh.title}</div>
            <div className="clg-co-b">{fresh.body.split("\n").filter(Boolean).map((l) => l.split(" — ")[0]).join(" · ")}</div>
            <div className="clg-co-f">
              <span>{`${Number(fresh.meta.commits) || 0} commit${fresh.meta.commits === 1 ? "" : "s"}`}</span>
              <span style={{ flex: 1 }} />
              <span className="go">See what's coming ›</span>
            </div>
            <span className="bar" onAnimationEnd={(e) => { if (e.animationName === "clg-bar") setFresh(null); }} />
          </div>
          <button className="x" title="dismiss" aria-label="dismiss" onClick={(e) => { e.stopPropagation(); setFresh(null); }}>×</button>
        </div>,
        document.querySelector("[data-theme]") ?? document.body,
      )}

      {/* A popover off the button, the way the PR chip's opens — not a modal in
          the middle of the screen, so the mouse stays where it clicked. Portalled
          into the themed container so position:fixed escapes any animated
          ancestor, and so it stacks over SETTINGS when the badge opens it. */}
      {open && pop && (incoming > 0 || local > 0 || err !== "" || busy) && createPortal(
        <div ref={popRef} className="mscroll"
          style={{ position: "fixed", ...pop, width: 420, maxWidth: "92vw", overflowY: "auto", zIndex: 96, border: "1px solid color-mix(in srgb, var(--acc) 40%, transparent)", background: "color-mix(in srgb, var(--panel2) 99%, transparent)", boxShadow: "0 14px 40px var(--shadow-pop)", animation: "mslide .16s ease both" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "15px 18px", borderBottom: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)" }}>
            <span style={{ fontSize: "var(--t13)", color: "var(--txb)", letterSpacing: ".5px" }}>
              {incoming && local ? "Sync platform" : incoming ? "Update ready" : "Ship your changes"}
            </span>
            <span style={{ flex: 1 }} />
            <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t95)", color: "var(--txf)" }}>⎇ {info.branch}</span>
          </div>
          <div style={{ padding: "16px 18px" }}>
            {local > 0 && (
              <>
                <div style={{ fontSize: "var(--t9)", letterSpacing: 1.5, color: "var(--warn)", marginBottom: 7 }}>YOURS ↑</div>
                <div style={{ fontSize: "var(--t125)", color: "var(--txh)", lineHeight: 1.6 }}>
                  {info.dirty > 0
                    ? `Commits ${info.dirty} change${info.dirty === 1 ? "" : "s"} with a message written from the diff, then pushes`
                    : "Pushes"}
                  {info.ahead > 0 && ` ${info.ahead} unpushed commit${info.ahead === 1 ? "" : "s"}`}
                  {info.dirty > 0 && info.ahead === 0 && " it"}.
                </div>
                <div style={{ marginTop: 10, maxHeight: 150, overflowY: "auto", borderLeft: "2px solid color-mix(in srgb, var(--warn) 30%, transparent)", padding: "2px 0 2px 10px" }}>
                  {(info.files ?? []).map((f) => (
                    <div key={f.path} style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t10)", color: "var(--txm)", padding: "2px 0", display: "flex", gap: 7, whiteSpace: "nowrap" }}>
                      <span style={{ color: "var(--warn)", flex: "none" }}>{f.status}</span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{f.path}</span>
                      <span style={{ flex: 1 }} />
                      <span style={{ color: "var(--ok)", flex: "none" }}>+{f.add}</span>
                      <span style={{ color: "var(--err)", flex: "none" }}>−{f.del}</span>
                    </div>
                  ))}
                  {(info.outgoing ?? []).map((c) => (
                    <div key={c.sha} style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t10)", color: "var(--txm)", padding: "2px 0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      <span style={{ color: "var(--warn)" }}>{c.sha}</span> {c.subject}
                    </div>
                  ))}
                  {info.outgoing && info.ahead > info.outgoing.length && (
                    <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t10)", color: "var(--txf)", padding: "2px 0" }}>
                      … {info.ahead - info.outgoing.length} more
                    </div>
                  )}
                </div>
              </>
            )}
            {incoming > 0 && (coming ? (
              <div className="upd-pv" style={{ marginTop: local > 0 ? 18 : 0 }}>
                <div className="upd-lab">WHAT'S COMING</div>
                <div className="clg-ht">{coming.title}</div>
                <Bullets body={coming.body} />
                <div className="upd-row">
                  <Meta r={coming} />
                  <span style={{ flex: 1 }} />
                  <button className="upd-fold" aria-expanded={commitsOpen} onClick={() => setCommitsOpen((v) => !v)}>
                    {commitsOpen ? "Hide" : "Show"} the commits
                    <ChevronRight size={11} strokeWidth={1.8} style={{ transform: commitsOpen ? "rotate(90deg)" : undefined }} />
                  </button>
                </div>
                {commitsOpen && commitList}
                <div className="upd-how">PULL &amp; RESTART pulls them, rebuilds the dashboard and restarts the bridge. Running turns pick up where they were.</div>
              </div>
            ) : (
              <>
                <div style={{ fontSize: "var(--t9)", letterSpacing: 1.5, color: "var(--ok)", marginTop: local > 0 ? 18 : 0, marginBottom: 7 }}>THEIRS ↓</div>
                <div style={{ fontSize: "var(--t125)", color: "var(--txh)", lineHeight: 1.6 }}>
                  Pulls {incoming} new commit{incoming === 1 ? "" : "s"}, rebuilds the dashboard and restarts the
                  bridge. Running turns are resumed automatically; dev servers and the tunnel come
                  back with it.
                </div>
                {commitList}
              </>
            ))}
            {incoming > 0 && info.dirty > 0 && (
              <div style={{ marginTop: 12, border: "1px solid color-mix(in srgb, var(--warn) 35%, transparent)", background: "color-mix(in srgb, var(--warn) 6%, transparent)", color: "var(--warn)", fontSize: "var(--t105)", letterSpacing: ".3px", padding: "8px 11px", display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ flex: "none" }}>⚠</span>
                <span>A fast-forward pull refuses on a dirty tree — commit &amp; push first.</span>
              </div>
            )}
            {err && (
              <div style={{ marginTop: 12, border: "1px solid color-mix(in srgb, var(--err) 40%, transparent)", background: "color-mix(in srgb, var(--err) 7%, transparent)", padding: "9px 11px" }}>
                <div style={{ fontSize: "var(--t9)", letterSpacing: 1.5, color: "var(--err)", marginBottom: 6 }}>{failed === "ship" ? "PUSH FAILED" : "UPDATE FAILED"}</div>
                <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t95)", color: "var(--txm)", whiteSpace: "pre-wrap", maxHeight: 150, overflowY: "auto" }}>{err}</div>
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 9, padding: "0 18px 16px" }}>
            <button className="upd-btn" onClick={() => setOpen(false)} disabled={busy} {...hp("cancel")}
              style={{ flex: 1, appearance: "none", cursor: busy ? "not-allowed" : "pointer", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: hov === "cancel" ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "transparent", color: "var(--tx)", fontFamily: "inherit", fontSize: "var(--t105)", letterSpacing: 1.5, padding: 10, opacity: busy ? 0.5 : 1 }}>{incoming > 0 ? "LATER" : "CANCEL"}</button>
            {err ? (
              <button className="upd-btn" onClick={fixWithClaude} {...hp("fix")}
                style={{ flex: 1.4, appearance: "none", cursor: "pointer", border: "1px solid var(--acc)", background: hov === "fix" ? "color-mix(in srgb, var(--acc) 28%, transparent)" : "color-mix(in srgb, var(--acc) 16%, transparent)", color: "var(--acc)", fontFamily: "inherit", fontSize: "var(--t105)", letterSpacing: 1.5, padding: 10 }}>
                ▸ FIX WITH CLAUDE</button>
            ) : (
              <>
                {local > 0 && (
                  <button className="upd-btn" onClick={() => void ship()} disabled={busy} {...hp("ship")}
                    style={{ flex: 1.3, appearance: "none", cursor: busy ? "wait" : "pointer", border: "1px solid var(--warn)", background: hov === "ship" ? "color-mix(in srgb, var(--warn) 28%, transparent)" : "color-mix(in srgb, var(--warn) 16%, transparent)", color: "var(--warn)", fontFamily: "inherit", fontSize: "var(--t105)", letterSpacing: 1.5, padding: 10, opacity: busy ? 0.7 : 1 }}>
                    {phase === "shipping" ? "COMMITTING…" : info.dirty > 0 ? "COMMIT & PUSH" : "PUSH"}</button>
                )}
                {incoming > 0 && (
                  <button className="upd-btn" onClick={() => void apply()} disabled={busy} {...hp("go")}
                    style={{ flex: 1.3, appearance: "none", cursor: busy ? "wait" : "pointer", border: "1px solid var(--ok)", background: hov === "go" ? "color-mix(in srgb, var(--ok) 28%, transparent)" : "color-mix(in srgb, var(--ok) 16%, transparent)", color: "var(--ok)", fontFamily: "inherit", fontSize: "var(--t105)", letterSpacing: 1.5, padding: 10, opacity: busy ? 0.7 : 1 }}>
                    {phase === "updating" ? "UPDATING…" : phase === "restarting" ? "RESTARTING…" : "PULL & RESTART"}</button>
                )}
              </>
            )}
          </div>
        </div>,
        document.querySelector("[data-theme]") ?? document.body,
      )}
    </>
  );
}
