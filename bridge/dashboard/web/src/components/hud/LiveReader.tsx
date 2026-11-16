import { useEffect, useState } from "react";
import { Check, Circle, LoaderCircle, Monitor, RefreshCw, Server, Smartphone, TriangleAlert, X, type LucideIcon } from "lucide-react";
import { api, type LiveInfo, type LivePart } from "../../api";
import { notify } from "./Notifications";
import { ago } from "../../lib/surfaces";
import { watchRestart } from "../../lib/restart";
import { commitsOf, verb } from "../../lib/golive";

// GO LIVE, read in the changelog (ChangelogButton's pinned row): what's on disk but not
// running. A web app built before its latest change, or a bridge launched before its
// latest Python (bridge/selfupdate.py live(), docs/superpowers/specs/go-live.md). The
// stage draws each part that's behind and what it needs (REBUILD, RESTART). Going live
// runs those steps from here, one request each, so each one ticks: the apps' builds,
// then the bridge's restart behind the boot screen (watchRestart). With only the apps
// changed, it's a reload instead. With turns running, AFTER N TURNS hands the same steps
// to the bridge (selfupdate.after) for when those turns end. The hub polls; this reads.
export const DONE = "golive-done"; // what a rebuild-only reload went live with, told after it (the hub says it)

type Step = { key: string; name: string; act: LivePart["act"]; state: "wait" | "now" | "ok" | "bad"; secs?: number; t0?: number };
type Run = { steps: Step[]; err?: { name: string; output: string } };

export const PART_ICON: Record<LivePart["key"], LucideIcon> = { dashboard: Monitor, miniapp: Smartphone, bridge: Server };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** A reader's stage for a job: its parts in a row, each lit by its state. The changelog's
 *  picture box, drawn — so Go live / Update / Ship read like any change. */
export type FlowNode = { key: string; icon: LucideIcon; name: string; tag: string; tone: string; state?: Step["state"] | "next" };
export function Flow({ chip, nodes, bad }: { chip: string; nodes: FlowNode[]; bad?: boolean }) {
  return (
    <div className="clg-stage rl-flow">
      <span className={`clg-chip${bad ? " bad" : ""}`}><b>{chip}</b></span>
      {nodes.map((n, i) => {
        const Ic = n.state === "ok" ? Check : n.state === "bad" ? X : n.icon;
        return (
          <div key={n.key} className="rl-step">
            {i > 0 && <i className={`rl-wire${n.state === "ok" || n.state === "now" ? " lit" : ""}`} style={{ ["--t" as string]: n.tone }} />}
            <div className={`rl-n ${n.state ?? ""}`} style={{ ["--t" as string]: n.tone }}>
              <span className="o">{n.state === "now" ? <LoaderCircle size={22} strokeWidth={1.8} className="gl-spin" /> : <Ic size={22} strokeWidth={1.8} />}</span>
              <b>{n.name}</b>
              <small>{n.tag}</small>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function LiveReader({ info, reload, onFeed, onBusy, onClose }: {
  info: LiveInfo;
  reload: () => Promise<void>;
  onFeed: (texts: string[], project?: string, fresh?: boolean) => void;
  onBusy: (busy: boolean) => void;
  onClose: () => void;
}) {
  const [run, setRun] = useState<Run | null>(null);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const busy = !!run && !run.err;
  useEffect(() => { onBusy(busy); }, [busy]);
  useEffect(() => () => onBusy(false), []);

  // Seconds tick only while a step is running.
  const ticking = !!run?.steps.some((s) => s.state === "now");
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, [ticking]);

  async function goLive() {
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
      onClose();
      return;
    }
    if (parts.some((p) => p.key === "dashboard")) {
      sessionStorage.setItem(DONE, "live — the dashboard is on its new build");
      location.reload();
      return;
    }
    notify("info", "live — the Mini App is rebuilt");
    setRun(null);
    onClose();
    void reload();
  }

  async function wait() {
    await api.liveAfter().catch((e: Error) => notify("error", e.message));
    await reload();
  }

  async function drop() {
    await api.liveAfter(true).catch(() => { /* gone with the next poll anyway */ });
    setRun(null);
    await reload();
  }

  // The build broke: hand it to Claude in a new session in the bridge's own checkout,
  // the way UPDATE's FIX WITH CLAUDE does.
  function fix(err: { name: string; output: string }) {
    onFeed([
      `Going live failed: the ${err.name} build in \`${info.path || "the mystical-assistant repo"}\` broke, so ` +
      `nothing restarted. Work out what breaks it and fix it, commit the fix, then tell me to open the ` +
      `changelog on the right rail and press Go live.\n\nIt said:\n${err.output}`,
    ], info.project, true);
    onClose();
    void drop();
  }

  const parts = info.parts;
  const err = run?.err ?? info.error ?? null;
  const restart = parts.some((p) => p.act === "restart");
  const turns = info.turns ?? [];
  const waitable = restart && turns.length > 0;
  const view = err ? "failed" : run ? "going" : info.queued ? "queued" : "peek";
  const going = !!info.queued && (!!info.queued.restarting || !info.queued.turns.length);   // the wait is over: too late to cancel
  const age = (t: number) => { const a = ago(t, now); return a === "now" ? "" : a; };
  const title = view === "failed" ? "Didn't go live" : view === "going" ? "Going live"
    : view === "queued" ? "Going live after the turns"
    : info.commits ? `${plural(info.commits, "commit")} ${info.commits === 1 ? "isn't" : "aren't"} running` : "Edits on disk aren't running";

  // The stage: each part that's behind, then the page's reload when there is one.
  const stepOf = (k: string) => run?.steps.find((s) => s.key === k)?.state;
  const nodes: FlowNode[] = parts.map((p) => ({
    key: p.key, icon: PART_ICON[p.key], name: p.name, tag: p.act === "restart" ? "RESTART" : "REBUILD",
    tone: p.act === "restart" ? "var(--warn)" : "var(--acc)", state: stepOf(p.key),
  }));
  if (restart || parts.some((p) => p.key === "dashboard"))
    nodes.push({ key: "reload", icon: RefreshCw, name: "Reload", tag: "THIS PAGE", tone: "var(--txl)", state: "next" });
  const chip = view === "failed" ? "DIDN'T GO LIVE" : view === "going" ? "GOING LIVE"
    : view === "queued" ? `WAITS ON ${plural(info.queued?.turns.length ?? 0, "TURN")}` : `NEEDS ${verb(parts)}`;

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
  const commits = commitsOf(parts);
  const dirty = Math.max(0, ...parts.map((p) => p.dirty));
  const tail = (out: string) => out.trim().split("\n").slice(-12).join("\n");

  return (
    <div className="clg-read mscroll">
      <Flow chip={chip} nodes={nodes} bad={view === "failed"} />
      <div className="clg-t">
        <div className="h">
          <b>{title}</b>
          {view === "peek" && <span className="clg-tag">LIVE</span>}
          <span className="tm">{info.running && info.disk && info.running !== info.disk ? `${info.running} → ${info.disk}` : `⎇ ${info.branch ?? ""}`}</span>
        </div>
        {view === "peek" && <div className="gl-cm rl-cm">
          {commits.slice(0, 4).map((c) => <div key={c.sha}><b>{c.sha}</b>{c.subject}</div>)}
          {commits.length > 4 && <div className="more">+ {plural(commits.length - 4, "more commit")}</div>}
          {dirty > 0 && <div className="more">+ {plural(dirty, "uncommitted file")}</div>}
          {parts.filter((p) => p.unknown).map((p) => <div key={p.key} className="more">{p.name}: {p.act === "restart" ? "a restart records what it runs" : "rebuilding it records what it's built from"}</div>)}
          {!commits.length && !dirty && !parts.some((p) => p.unknown) && <div className="more">{plural(Math.max(0, ...parts.map((p) => p.files)), "file")} changed</div>}
        </div>}
        {(view === "going" || (view === "failed" && run)) && run && <div className="gl-steps">{run.steps.map(stepRow)}</div>}
        {view === "queued" && info.queued && <>
          <div className="x">{!going
            ? <>Rebuilds and restarts once {info.queued.turns.length === 1 ? "this turn ends" : `these ${info.queued.turns.length} turns end`}; nothing is cut.</>
            : <>The turns are done. Going live…</>}</div>
          <div className="gl-wl">
            {info.queued.turns.map((t) => (
              <div key={t.id}><LoaderCircle size={13} strokeWidth={1.8} className="gl-spin" /><span className="t">{t.title}</span><span className="e">{age(t.started) || "<1m"}</span></div>
            ))}
          </div>
        </>}
        {view === "failed" && err && <>
          <div className="gl-err"><div className="h">{err.name.toUpperCase()}</div><pre>{tail(err.output) || "the build failed"}</pre></div>
          <div className="gl-calm">Nothing restarted. This page and the bridge still run the code they had.</div>
        </>}
      </div>
      <div className="clg-acts">
        {view === "peek" && <>
          {waitable && <button onClick={() => void wait()}>After {plural(turns.length, "turn")}</button>}
          <button className="pri" onClick={() => void goLive()}><RefreshCw size={12} strokeWidth={1.8} />{waitable ? "Go live now" : cap(verb(parts))}</button>
          {waitable && <span className="rl-warn"><TriangleAlert size={12} strokeWidth={1.8} />{plural(turns.length, "turn")} resume after</span>}
        </>}
        {view === "going" && <button className="pri" disabled>
          <LoaderCircle size={12} strokeWidth={1.8} className="gl-spin" />{run?.steps.some((s) => s.act === "restart" && s.state === "now") ? "Restarting…" : "Building…"}</button>}
        {view === "queued" && <>
          <button onClick={() => void drop()} disabled={going}>Cancel the wait</button>
          <button className="pri" onClick={() => void goLive()} disabled={going}>{going ? "Going live…" : "Go live now"}</button>
        </>}
        {view === "failed" && err && <>
          <button onClick={() => void drop()}>Dismiss</button>
          <button className="pri" onClick={() => fix(err)}>▸ Fix with Claude</button>
        </>}
      </div>
      <div className="clg-mline"><span>{view === "going" && restart ? "The boot screen covers the few seconds it's down." : how}</span></div>
    </div>
  );
}

const cap = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();
