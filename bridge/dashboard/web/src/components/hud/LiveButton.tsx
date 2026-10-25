import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Circle, Clock, LoaderCircle, Monitor, RefreshCw, Server, Smartphone, TriangleAlert, X } from "lucide-react";
import { api, type LiveInfo, type LivePart } from "../../api";
import { notify } from "./Notifications";
import { ago } from "../../lib/surfaces";
import { watchRestart } from "../../lib/restart";
import { popPlace } from "../../lib/prchip";
import { commitsOf, popFor, verb } from "../../lib/golive";

// The right rail's ⟳, over the changelog. It shows only when the code on disk isn't the
// code running: a web app built before its latest change, or a bridge launched before its
// latest Python (bridge/selfupdate.py live(), docs/superpowers/specs/go-live.md). Its card
// lists each part that's behind, with its commits and what it needs (REBUILD, RESTART).
// Going live runs those steps from here, one request each, so each one ticks: the apps'
// builds, then the bridge's restart behind the boot screen (watchRestart). With only the
// apps changed, it's a reload instead. With turns running, AFTER N TURNS hands the same
// steps to the bridge (selfupdate.after) for when those turns end. A commit that lands
// pops out of the icon once. Self-contained (polls, owns its popover) like UpdateButton.
const POLL_MS = 30_000;  // git only, no network: a merge lights it within the half minute
const QUEUED_MS = 4_000; // while a wait is on, so its restart is met by the boot screen
const SEEN = "golive-seen"; // the newest commit time it has popped for or seen
const DONE = "golive-done"; // what a rebuild-only reload went live with, told after it

type Step = { key: string; name: string; act: LivePart["act"]; state: "wait" | "now" | "ok" | "bad"; secs?: number; t0?: number };
type Run = { steps: Step[]; err?: { name: string; output: string } };

const ICON = { dashboard: Monitor, miniapp: Smartphone, bridge: Server };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function LiveButton({ onFeed }: { onFeed: (texts: string[], project?: string, fresh?: boolean) => void }) {
  const [info, setInfo] = useState<LiveInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [pop, setPop] = useState<{ subject: string; fresh: number; restart: boolean; total: number } | null>(null);
  const [hov, setHov] = useState("");
  const [now, setNow] = useState(() => Date.now() / 1000);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const queuedRef = useRef(false);

  async function load() {
    try {
      setInfo(await api.live());
      setNow(Date.now() / 1000);
    } catch {
      // A wait's restart is underway: meet it with the boot screen, which reloads into the new build.
      if (queuedRef.current) { queuedRef.current = false; void watchRestart("GO LIVE"); }
    }
  }

  const queued = !!info?.queued;
  useEffect(() => { queuedRef.current = queued; }, [queued]);
  useEffect(() => {
    void load();
    const id = setInterval(load, queued ? QUEUED_MS : POLL_MS);
    const focus = () => void load();
    window.addEventListener("focus", focus);
    return () => { clearInterval(id); window.removeEventListener("focus", focus); };
  }, [queued]);

  // What a rebuild-only reload went live with: said once the new page is up.
  useEffect(() => {
    const done = sessionStorage.getItem(DONE);
    if (done) { sessionStorage.removeItem(DONE); notify("info", done); }
  }, []);

  // A commit that isn't live and is newer than any it has seen pops out of the icon, once.
  // The first look after this ships only takes note: what was behind already isn't news.
  useEffect(() => {
    if (!info?.parts.length) return;
    const newest = commitsOf(info.parts)[0];
    if (!newest) return;
    const seen = Number(localStorage.getItem(SEEN) || 0);
    if (newest.at > seen) localStorage.setItem(SEEN, String(newest.at));
    if (!seen || open || run) return;
    const p = popFor(info.parts, seen);
    if (p) setPop({ subject: p.newest.subject, fresh: p.fresh, total: info.commits,
                    restart: info.parts.some((x) => x.act === "restart") });
  }, [info]);
  useEffect(() => { if (open) setPop(null); }, [open]);

  // Seconds tick only while a step is running.
  const ticking = !!run?.steps.some((s) => s.state === "now");
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, [ticking]);

  // Closes the way UPDATE's does: a press outside it, or Escape; never mid-run.
  const busy = !!run && !run.err;
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

  async function goLive() {
    if (!info) return;
    const parts = info.parts;
    let steps: Step[] = parts.map((p) => ({ key: p.key, name: p.name, act: p.act, state: "wait" }));
    const mark = (key: string, s: Partial<Step>, err?: Run["err"]) => {
      steps = steps.map((x) => (x.key === key ? { ...x, ...s } : x));
      setRun({ steps, err });
    };
    setRun({ steps });
    if (info.queued || info.error) await api.liveAfter(true).catch(() => { /* the run below is what counts */ });
    for (const p of parts) {
      if (p.act !== "rebuild") continue;
      setNow(Date.now() / 1000);
      mark(p.key, { state: "now", t0: Date.now() / 1000 });
      const r = await api.liveBuild(p.key).catch((e: Error) => e);
      // No answer at all: the bridge went away mid-build (another tab's restart). Ride it back.
      if (r instanceof TypeError) { await watchRestart("GO LIVE"); setRun(null); return; }
      if (r instanceof Error) return mark(p.key, { state: "bad" }, { name: p.name, output: r.message });
      if (!r.ok) return mark(p.key, { state: "bad", secs: r.seconds }, { name: p.name, output: r.output });
      mark(p.key, { state: "ok", secs: r.seconds });
    }
    if (parts.some((p) => p.act === "restart")) {
      mark("bridge", { state: "now", t0: Date.now() / 1000 });
      try {
        await api.restart();
      } catch (e) {
        return mark("bridge", { state: "bad" }, { name: "Bridge", output: (e as Error).message });
      }
      await watchRestart("GO LIVE");   // reloads into the new build; returns only if it never came back
      setRun(null);
      setOpen(false);
      return;
    }
    if (parts.some((p) => p.key === "dashboard")) {
      sessionStorage.setItem(DONE, "live — the dashboard is on its new build");
      location.reload();
      return;
    }
    notify("info", "live — the Mini App is rebuilt");
    setRun(null);
    setOpen(false);
    void load();
  }

  async function wait() {
    await api.liveAfter().catch((e: Error) => notify("error", e.message));
    await load();
  }

  async function drop() {
    await api.liveAfter(true).catch(() => { /* gone with the next poll anyway */ });
    setRun(null);
    await load();
  }

  // The build broke: hand it to Claude in a new session in the bridge's own checkout,
  // the way UPDATE's FIX WITH CLAUDE does.
  function fix(err: { name: string; output: string }) {
    onFeed([
      `Going live failed: the ${err.name} build in \`${info?.path || "the mystical-assistant repo"}\` broke, so ` +
      `nothing restarted. Work out what breaks it and fix it, commit the fix, then tell me to press ⟳ on the ` +
      `right rail to go live.\n\nIt said:\n${err.output}`,
    ], info?.project, true);
    setOpen(false);
    void drop();
  }

  if (!info?.repo) return null;
  const parts = info.parts;
  const err = run?.err ?? info.error ?? null;
  if (!parts.length && !info.queued && !err && !run) return null;

  const restart = parts.some((p) => p.act === "restart");
  const turns = info.turns ?? [];
  const waitable = restart && turns.length > 0;
  const view = err ? "failed" : run ? "going" : info.queued ? "queued" : "peek";
  const going = !!info.queued && (!!info.queued.restarting || !info.queued.turns.length);   // the wait is over: too late to cancel
  const done = run ? run.steps.filter((s) => s.state === "ok").length : 0;
  const ring = run && !run.err ? (done + 0.5) / run.steps.length : 0;
  const tone = err ? "var(--err)" : "var(--acc)";
  const title = view === "failed" ? "Didn't go live" : view === "going" ? "Going live"
    : view === "queued" ? "Going live after the turns" : "Not live yet";

  const rect = open ? btnRef.current?.getBoundingClientRect() : undefined;
  const place = rect && { ...popPlace(rect, window.innerHeight),
                          right: Math.max(8, Math.min(window.innerWidth - rect.right, window.innerWidth - 428)) };
  const at = pop && !open ? btnRef.current?.getBoundingClientRect() : undefined;
  const out = at && { right: window.innerWidth - at.left + 10, bottom: Math.max(8, window.innerHeight - at.bottom - 4) };
  const hp = (k: string) => ({ onMouseEnter: () => setHov(k), onMouseLeave: () => setHov("") });
  // UPDATE's footer buttons: ghost (LATER), line (AFTER N TURNS), pri (the go).
  const btn = (k: string, kind: "ghost" | "line" | "pri", flex: number) => ({
    flex, appearance: "none" as const, cursor: busy || going ? "wait" : "pointer", fontFamily: "inherit", fontSize: "var(--t105)",
    letterSpacing: 1.5, padding: 10, opacity: busy || going ? 0.55 : 1,
    border: kind === "pri" ? "1px solid var(--acc)" : `1px solid color-mix(in srgb, var(--acc) ${kind === "line" ? 45 : 25}%, transparent)`,
    background: kind === "pri" ? `color-mix(in srgb, var(--acc) ${hov === k ? 28 : 16}%, transparent)`
      : hov === k ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "transparent",
    color: kind === "ghost" ? "var(--tx)" : "var(--acc)",
  });
  const age = (t: number) => { const a = ago(t, now); return a === "now" ? "" : a; };

  const label = `Go live — ${info.commits ? plural(info.commits, "commit") : "changes"} on disk aren't running yet`;
  const railBtn = (
    <button
      ref={btnRef}
      onClick={() => setOpen((o) => !o)}
      title={view === "queued" ? "Goes live when the running turns end" : err ? `${err.name} didn't build` : label}
      aria-label="Go live"
      aria-expanded={open}
      {...hp("btn")}
      className={`relative flex h-[38px] items-center justify-center border-l-2 border-transparent hover:bg-accent${out ? " clg-lit" : ""}`}
      style={{ appearance: "none", cursor: "pointer", color: tone }}
    >
      {run && !run.err && (
        <svg className="gl-ring" viewBox="0 0 32 32" aria-hidden>
          <circle className="bg" cx="16" cy="16" r="14" />
          <circle className="fg" cx="16" cy="16" r="14" strokeDasharray={`${ring * 88} 88`} />
        </svg>
      )}
      <RefreshCw size={18} strokeWidth={1.8} aria-hidden className={busy || going ? "gl-ic gl-spin" : "gl-ic"} />
      {busy || going ? null
        : err ? <span className="gl-pill bad">!</span>
        : info.queued ? <span className="gl-pill q"><Clock size={10} strokeWidth={2.2} /></span>
        : info.commits ? <span className="gl-pill">{info.commits > 99 ? "99+" : info.commits}</span>
        : <span className="gl-dot" />}
    </button>
  );

  const lead = (
    <div className="gl-lead">
      {info.commits ? <><b>{plural(info.commits, "commit")}</b> {info.commits === 1 ? "is" : "are"} on disk but not running.</>
        : <><b>Edits on disk</b> aren't running yet.</>}
      {info.running && info.disk && info.running !== info.disk && <> <i>{info.running} → {info.disk}</i></>}
    </div>
  );

  const block = (p: LivePart) => {
    const Icon = ICON[p.key];
    return (
      <div key={p.key} className="gl-part">
        <div className="gl-ph">
          <Icon size={14} strokeWidth={1.8} />
          <span className="n">{p.name}</span>
          <span className="m">{p.unknown ? (p.act === "restart" ? "can't tell what it runs" : "built before builds kept a stamp")
            : !p.since ? "" : p.act === "restart" ? `up ${age(p.since) || "<1m"}`
            : age(p.since) ? `built ${age(p.since)} ago` : "built just now"}</span>
          <span className="sp" />
          <span className={`gl-tag${p.act === "restart" ? " rs" : ""}`}>{p.act === "restart" ? "RESTART" : "REBUILD"}</span>
        </div>
        <div className="gl-cm">
          {p.commits.slice(0, 4).map((c) => <div key={c.sha}><b>{c.sha}</b>{c.subject}</div>)}
          {p.commits.length > 4 && <div className="more">+ {plural(p.commits.length - 4, "more commit")}</div>}
          {p.dirty > 0 && <div className="more">+ {plural(p.dirty, "uncommitted file")}</div>}
          {!p.commits.length && !p.dirty && <div className="more">{p.unknown ? (p.act === "restart" ? "a restart records what it runs" : "rebuilding it records what it's built from") : plural(p.files, "file") + " changed"}</div>}
        </div>
      </div>
    );
  };

  const builds = parts.filter((p) => p.act === "rebuild").map((p) => `the ${p.name === "Dashboard" ? "dashboard" : p.name}`).join(" and ");
  const how = restart ? `${builds ? `Builds ${builds}, restarts` : "Restarts"} the bridge, then reloads this page.`
    : parts.some((p) => p.key === "dashboard") ? `Builds ${builds}, then reloads this page.`
    : `Builds ${builds}. Nothing restarts.`;

  const stepRow = (s: Step) => {
    const secs = s.state === "now" && s.t0 ? Math.max(0, Math.round(now - s.t0)) : s.secs;
    const d = s.state === "ok" ? `built · ${secs ?? 0} s`
      : s.state === "bad" ? (s.act === "restart" ? "didn't restart" : `build failed${secs ? ` · ${secs} s` : ""}`)
      : s.state === "now" ? (s.act === "restart" ? "restarting…" : `building · ${secs ?? 0} s`)
      : s.act === "restart" ? (err ? "not restarted" : `restarts next${turns.length ? ` · ${plural(turns.length, "turn")} resume` : ""}`)
      : err ? "not built" : "next";
    return (
      <div key={s.key} className={`gl-step ${s.state}`}>
        {s.state === "ok" ? <Check size={15} strokeWidth={1.8} /> : s.state === "bad" ? <X size={15} strokeWidth={1.8} />
          : s.state === "now" ? <LoaderCircle size={15} strokeWidth={1.8} className="gl-spin" /> : <Circle size={15} strokeWidth={1.8} />}
        <span className="n">{s.name}</span>
        <span className="d">{d}</span>
        {s.state === "now" && s.act === "rebuild" && <span className="bar" />}
      </div>
    );
  };

  const tail = (out: string) => out.trim().split("\n").slice(-12).join("\n");

  return (
    <>
      {railBtn}

      {/* A commit that isn't live, out of the icon: the changelog's own callout, 8 s (its bar's
          animation is the clock, so hover holds it). Its click opens the card. */}
      {pop && out && createPortal(
        <div className="clg-co gl-co" style={out} role="status" onClick={() => { setPop(null); setOpen(true); }}>
          <div className="in">
            <div className="clg-co-h">
              <RefreshCw size={13} strokeWidth={1.8} className="clg-ic" />
              <span className="v">NOT LIVE YET</span>
              <span className="w">just now</span>
            </div>
            <div className="clg-co-t">A change on disk needs a {pop.restart ? "restart" : "rebuild"}</div>
            <div className="clg-co-b">{pop.subject}</div>
            <div className="clg-co-f">
              <span>{pop.fresh} new · {pop.total} not live</span>
              <span style={{ flex: 1 }} />
              <span className="go">Go live ›</span>
            </div>
            <span className="bar" onAnimationEnd={(e) => { if (e.animationName === "clg-bar") setPop(null); }} />
          </div>
          <button className="x" title="dismiss" aria-label="dismiss" onClick={(e) => { e.stopPropagation(); setPop(null); }}>×</button>
        </div>,
        document.querySelector("[data-theme]") ?? document.body,
      )}

      {/* UPDATE's popover frame, off the button: portalled into the themed container so
          position:fixed escapes any animated ancestor. */}
      {open && place && createPortal(
        <div ref={popRef} className="mscroll"
          style={{ position: "fixed", ...place, width: 420, maxWidth: "92vw", overflowY: "auto", zIndex: 96, border: "1px solid color-mix(in srgb, var(--acc) 40%, transparent)", background: "color-mix(in srgb, var(--panel2) 99%, transparent)", boxShadow: "0 14px 40px var(--shadow-pop)", animation: "mslide .16s ease both" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "15px 18px", borderBottom: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)" }}>
            <span style={{ fontSize: "var(--t13)", color: "var(--txb)", letterSpacing: ".5px" }}>{title}</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t95)", color: "var(--txf)" }}>⎇ {info.branch}</span>
          </div>
          <div style={{ padding: "16px 18px" }}>
            {view === "peek" && <>
              {lead}
              {parts.map(block)}
              {waitable && (
                <div className="gl-turns"><TriangleAlert size={13} strokeWidth={1.8} />
                  <span><b>{plural(turns.length, "turn")} running.</b> The restart stops them; they resume after.</span></div>
              )}
              <div className="upd-how">{how}</div>
            </>}
            {view === "going" && run && <>
              <div className="gl-steps">{run.steps.map(stepRow)}</div>
              <div className="upd-how">{restart ? "Nothing runs the new code until the restart. The boot screen covers the few seconds it's down."
                : "The page reloads once the build is done."}</div>
            </>}
            {view === "queued" && info.queued && <>
              <div className="gl-lead">
                {!going
                  ? <>Rebuilds and restarts once {info.queued.turns.length === 1 ? "this turn ends" : `these ${info.queued.turns.length} turns end`}; nothing is cut.</>
                  : <>The turns are done. Going live…</>}
                {info.commits > 0 && <> <i>{plural(info.commits, "commit")}</i></>}
              </div>
              <div className="gl-wl">
                {info.queued.turns.map((t) => (
                  <div key={t.id}><LoaderCircle size={13} strokeWidth={1.8} className="gl-spin" /><span className="t">{t.title}</span><span className="e">{age(t.started) || "<1m"}</span></div>
                ))}
              </div>
              <div className="upd-how">A turn that starts meanwhile doesn't hold it up; it stops for the restart and resumes, like any restart.</div>
            </>}
            {view === "failed" && err && <>
              {run && <div className="gl-steps">{run.steps.map(stepRow)}</div>}
              <div className="gl-err"><div className="h">{err.name.toUpperCase()}</div><pre>{tail(err.output) || "the build failed"}</pre></div>
              <div className="gl-calm">Nothing restarted. This page and the bridge still run the code they had.</div>
            </>}
          </div>
          <div style={{ display: "flex", gap: 9, padding: "0 18px 16px" }}>
            {view === "peek" && <>
              <button className="upd-btn" onClick={() => setOpen(false)} {...hp("later")} style={btn("later", "ghost", waitable ? 0.8 : 1)}>LATER</button>
              {waitable && (
                <button className="upd-btn" onClick={() => void wait()} {...hp("wait")} style={btn("wait", "line", 1.2)}>
                  AFTER {turns.length} TURN{turns.length === 1 ? "" : "S"}</button>
              )}
              <button className="upd-btn" onClick={() => void goLive()} {...hp("go")} style={btn("go", "pri", waitable ? 0.8 : 1.3)}>
                {waitable ? "NOW" : verb(parts)}</button>
            </>}
            {view === "going" && <>
              <button className="upd-btn" disabled style={btn("later", "ghost", 1)}>LATER</button>
              <button className="upd-btn" disabled style={btn("go", "pri", 1.3)}>
                {run?.steps.some((s) => s.act === "restart" && s.state === "now") ? "RESTARTING…" : "BUILDING…"}</button>
            </>}
            {view === "queued" && <>
              <button className="upd-btn" onClick={() => void drop()} disabled={going} {...hp("cancel")} style={btn("cancel", "ghost", 1)}>CANCEL</button>
              <button className="upd-btn" onClick={() => void goLive()} disabled={going} {...hp("go")} style={btn("go", "pri", 1.3)}>
                {going ? "GOING LIVE…" : "GO LIVE NOW"}</button>
            </>}
            {view === "failed" && err && <>
              <button className="upd-btn" onClick={() => { setOpen(false); void drop(); }} {...hp("close")} style={btn("close", "ghost", 1)}>CLOSE</button>
              <button className="upd-btn" onClick={() => fix(err)} {...hp("fix")} style={btn("fix", "pri", 1.4)}>▸ FIX WITH CLAUDE</button>
            </>}
          </div>
        </div>,
        document.querySelector("[data-theme]") ?? document.body,
      )}
    </>
  );
}
