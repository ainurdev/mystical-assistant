import { useCallback, useEffect, useState } from "react";
import { autoCall, autoGet } from "../lib/readapi";
import { Dialog } from "./DesignSystem";

// Your automations (bridge/automations.py): all of them, switchable, with a form for new ones.
// They aren't a project's or a chat's, so this looks the same wherever you open it. Same file in
// both apps; onOpen is each one's way into a chat.

type Check = { kind: "none" | "command" | "script"; command?: string; script?: string };
type Trigger =
  | { kind: "timer"; every: number; check: Check }
  | { kind: "daily"; count: number; start: string; end: string }
  | { kind: "once"; at: string }
  | { kind: "path"; paths: string[] }
  | { kind: "telegram"; command: string };
type Run = { at: number; why: string; session_id: string; status: string };
type Auto = {
  id: string; name: string; prompt: string; project: string; mode: string; chat: "new" | "same"; trigger: Trigger; enabled: boolean;
  next_at: number | null; running: boolean; runs: Run[]; note: string;
};
type Listing = { automations: Auto[]; projects: string[] };

const errorOf = (e: unknown) => (e instanceof Error ? e.message : "That didn't work.");
const clock = (sec: number) => new Date(sec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const when = (sec: number) => {
  const d = new Date(sec * 1000), now = new Date();
  return d.toDateString() === now.toDateString() ? clock(sec) : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${clock(sec)}`;
};

/** A trigger in words, as the list says it. */
export function triggerWords(t: Trigger): string {
  if (t.kind === "timer") {
    const every = t.every % 1440 === 0 ? `${t.every / 1440} day${t.every === 1440 ? "" : "s"}` : t.every % 60 === 0 ? `${t.every / 60} hour${t.every === 60 ? "" : "s"}` : `${t.every} minute${t.every === 1 ? "" : "s"}`;
    return `Every ${every}${t.check.kind === "none" ? "" : ", if its check says yes"}`;
  }
  if (t.kind === "daily") return t.count === 1 ? `Daily at ${t.start}` : `${t.count} times a day, ${t.start} to ${t.end}`;
  if (t.kind === "once") {
    const d = new Date(t.at);
    return `Once, on ${d.toLocaleDateString([], { month: "short", day: "numeric", ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }) })} at ${t.at.slice(11)}`;
  }
  if (t.kind === "path") return `When ${t.paths.length === 1 ? t.paths[0] : `${t.paths.length} paths`} change${t.paths.length === 1 ? "s" : ""}`;
  return `When you send /${t.command}`;
}

const MODES: { id: string; label: string; note: string }[] = [
  { id: "plan", label: "Read only", note: "It looks and reports, and can't change anything." },
  { id: "acceptEdits", label: "Edit, ask for the rest", note: "It can edit files. Anything riskier waits and asks you on Telegram." },
  { id: "bypassPermissions", label: "Fully automatic", note: "It never stops to ask. A bad prompt or a hostile file could do damage before you see it." },
];
const KINDS: { id: Trigger["kind"]; label: string }[] = [
  { id: "timer", label: "Timer" }, { id: "daily", label: "Times a day" }, { id: "once", label: "Once" }, { id: "path", label: "File or folder" }, { id: "telegram", label: "Telegram" },
];

type Draft = { id?: string; name: string; prompt: string; project: string; mode: string; chat: "new" | "same"; kind: Trigger["kind"]; every: number; unit: number; check: Check["kind"]; command: string; script: string; count: number; start: string; end: string; at: string; paths: string; word: string };

/** Tomorrow at nine, in the form a datetime-local input takes. */
const tomorrow = () => {
  const d = new Date(Date.now() + 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T09:00`;
};

const blank = (project: string): Draft => ({ name: "", prompt: "", project, mode: "acceptEdits", chat: "new", kind: "timer", every: 10, unit: 1, check: "none", command: "", script: "", count: 3, start: "09:00", end: "18:00", at: tomorrow(), paths: "", word: "" });

function fromAuto(a: Auto): Draft {
  const d = { ...blank(a.project), id: a.id, name: a.name, prompt: a.prompt, mode: a.mode, chat: a.chat, kind: a.trigger.kind };
  const t = a.trigger;
  if (t.kind === "timer") {
    const unit = t.every % 1440 === 0 ? 1440 : t.every % 60 === 0 ? 60 : 1;
    return { ...d, every: t.every / unit, unit, check: t.check.kind, command: t.check.command ?? "", script: t.check.script ?? "" };
  }
  if (t.kind === "daily") return { ...d, count: t.count, start: t.start, end: t.end };
  if (t.kind === "once") return { ...d, at: t.at };
  if (t.kind === "path") return { ...d, paths: t.paths.join("\n") };
  return { ...d, word: t.command };
}

function toTrigger(d: Draft): Trigger {
  if (d.kind === "timer") return { kind: "timer", every: d.every * d.unit, check: { kind: d.check, command: d.command, script: d.script } };
  if (d.kind === "daily") return { kind: "daily", count: d.count, start: d.start, end: d.end };
  if (d.kind === "once") return { kind: "once", at: d.at };
  if (d.kind === "path") return { kind: "path", paths: d.paths.split("\n").map((p) => p.trim()).filter(Boolean) };
  return { kind: "telegram", command: d.word };
}

function Form({ start, projects, onDone, onClose, onOpen }: { start: Draft; projects: string[]; onDone: () => void; onClose: () => void; onOpen?: (id: string) => void }) {
  const [d, setD] = useState(start);
  const [error, setError] = useState("");
  const [tested, setTested] = useState("");
  const [busy, setBusy] = useState(false);
  const [wanted, setWanted] = useState("");
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await autoCall("save", { id: d.id, name: d.name, prompt: d.prompt, project: d.project, mode: d.mode, chat: d.chat, trigger: toTrigger(d) });
      onDone();
    } catch (e) { setError(errorOf(e)); }
    setBusy(false);
  };
  const test = async () => {
    setTested("Running it…");
    try {
      const r = await autoCall<{ go: boolean; why: string; output: string; error?: string }>("test", { project: d.project, trigger: toTrigger(d) });
      setTested(`${r.go ? "Yes, it would run" : "No, it wouldn't run"} (${r.why}).${r.output ? `\n${r.output.slice(-500)}` : ""}${r.error ? `\n${r.error}` : ""}`);
    } catch (e) { setTested(errorOf(e)); }
  };
  const draftScript = async () => {
    setError("");
    try {
      const r = await autoCall<{ session_id: string }>("script", { project: d.project, description: wanted, path: d.script });
      await autoCall("save", { id: d.id, name: d.name || `Check: ${wanted.slice(0, 40)}`, prompt: d.prompt || wanted, project: d.project, mode: d.mode, chat: d.chat, trigger: toTrigger(d) });
      onDone();
      onOpen?.(r.session_id);
    } catch (e) { setError(errorOf(e)); }
  };
  const mode = MODES.find((m) => m.id === d.mode);
  return (
    <Dialog title={d.id ? "Edit automation" : "New automation"} onClose={onClose}>
      <div className="au-form">
        <label className="ds-f"><span>Name</span><input value={d.name} autoFocus placeholder="Morning weather" onChange={(e) => set({ name: e.target.value })} /></label>
        <label className="ds-f"><span>Project, for the agent to work in</span>
          <select value={d.project} onChange={(e) => set({ project: e.target.value })}>
            <option value="">Pick a project</option>
            {projects.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <div className="ds-f"><span>When</span>
          <div className="ds-chips" role="radiogroup">
            {KINDS.map((k) => <button key={k.id} type="button" role="radio" aria-checked={d.kind === k.id} className="dg-chip" onClick={() => set({ kind: k.id })}>{k.label}</button>)}
          </div>
        </div>
        {d.kind === "timer" ? (
          <>
            <div className="ds-f au-row"><span>Every</span>
              <input type="number" min={1} value={d.every} aria-label="How often" onChange={(e) => set({ every: Math.max(1, Number(e.target.value) || 1) })} />
              <select value={d.unit} aria-label="Unit" onChange={(e) => set({ unit: Number(e.target.value) })}><option value={1}>minutes</option><option value={60}>hours</option><option value={1440}>days</option></select>
            </div>
            <div className="ds-f"><span>Then check first?</span>
              <div className="ds-chips" role="radiogroup">
                {([["none", "No, just run"], ["command", "A command"], ["script", "A script"]] as const).map(([id, label]) => <button key={id} type="button" role="radio" aria-checked={d.check === id} className="dg-chip" onClick={() => set({ check: id })}>{label}</button>)}
              </div>
            </div>
            {d.check === "command" ? <label className="ds-f"><span>Command. Exit 0 means run</span><input value={d.command} placeholder="curl -sf https://example.com/status | grep -q down" onChange={(e) => set({ command: e.target.value })} /></label> : null}
            {d.check === "script" ? (
              <>
                <label className="ds-f"><span>Script file. Exit 0 means run, and what it prints reaches the agent</span><input value={d.script} placeholder="scripts/check-stock.sh" onChange={(e) => set({ script: e.target.value })} /></label>
                <label className="ds-f"><span>Don't have one? Say what it should check, and an agent drafts it with you</span><textarea rows={2} value={wanted} placeholder="Has the AAPL price dropped more than 3% today?" onChange={(e) => setWanted(e.target.value)} /></label>
                <button type="button" className="dg-btn" disabled={!wanted.trim() || !d.script.trim() || !d.project} onClick={() => void draftScript()}>Draft it in a chat</button>
                <small className="au-hint">You go back and forth in that chat, and it saves to the path above when you say so. This automation waits for the file.</small>
              </>
            ) : null}
            {d.check !== "none" ? <button type="button" className="dg-btn au-test" disabled={!d.project} onClick={() => void test()}>Test the check</button> : null}
            {tested ? <pre className="au-tested" role="status">{tested}</pre> : null}
          </>
        ) : null}
        {d.kind === "daily" ? (
          <div className="ds-f au-row"><span>Times a day</span>
            <input type="number" min={1} max={48} value={d.count} aria-label="Times a day" onChange={(e) => set({ count: Math.max(1, Number(e.target.value) || 1) })} />
            <label>from <input type="time" value={d.start} onChange={(e) => set({ start: e.target.value })} /></label>
            {d.count > 1 ? <label>to <input type="time" value={d.end} onChange={(e) => set({ end: e.target.value })} /></label> : null}
          </div>
        ) : null}
        {d.kind === "once" ? (
          <label className="ds-f"><span>Date and time, on this machine's clock</span>
            <input type="datetime-local" value={d.at} onChange={(e) => set({ at: e.target.value })} />
            <small className="au-hint">It runs one time, then switches itself off. If this machine is asleep then, it runs on waking, up to 12 hours late.</small>
          </label>
        ) : null}
        {d.kind === "path" ? <label className="ds-f"><span>Files or folders to watch, one per line, from the project or absolute</span><textarea rows={3} value={d.paths} placeholder={"src/\nnotes/inbox.md"} onChange={(e) => set({ paths: e.target.value })} /></label> : null}
        {d.kind === "telegram" ? <label className="ds-f"><span>Command for the bot. Anything after it reaches the agent</span><input value={d.word} placeholder="standup" onChange={(e) => set({ word: e.target.value })} /></label> : null}
        <label className="ds-f"><span>What should the agent do?</span><textarea rows={4} value={d.prompt} placeholder="Check the forecast and tell me if I need an umbrella." onChange={(e) => set({ prompt: e.target.value })} /></label>
        <label className="ds-f"><span>What may it do?</span>
          <select value={d.mode} onChange={(e) => set({ mode: e.target.value })}>{MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
          <small className="au-hint" data-warn={d.mode === "bypassPermissions" || undefined}>{mode?.note}</small>
        </label>
        <div className="ds-f"><span>Where do runs go?</span>
          <div className="ds-chips" role="radiogroup">
            <button type="button" role="radio" aria-checked={d.chat === "new"} className="dg-chip" onClick={() => set({ chat: "new" })}>A new chat each time</button>
            <button type="button" role="radio" aria-checked={d.chat === "same"} className="dg-chip" onClick={() => set({ chat: "same" })}>One chat that continues</button>
          </div>
          <small className="au-hint">{d.chat === "same" ? "The agent remembers earlier runs, and each run costs more than the last." : "Runs stay independent and cheap."}</small>
        </div>
        {error ? <p className="ds-err" role="alert">{error}</p> : null}
        <div className="ds-do au-save">
          <button type="button" className="dg-send" disabled={busy} onClick={() => void save()}>{d.id ? "Save" : "Create"}</button>
          <button type="button" className="dg-btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Dialog>
  );
}

export function AutomationsPanel({ project, onOpen }: { project?: string | null; onOpen?: (sessionId: string) => void }) {
  const [data, setData] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirm, setConfirm] = useState("");
  const load = useCallback(() => {
    autoGet<Listing>().then((r) => { setData(r); setError(""); }, (e) => setError(errorOf(e)));
  }, []);
  useEffect(() => {
    load();
    const t = window.setInterval(load, 5000);
    return () => window.clearInterval(t);
  }, [load]);
  const act = (path: string, body: Record<string, unknown>) => {
    autoCall<Listing>(path, body).then((r) => { if (r.automations) setData(r); else load(); }, (e) => setError(errorOf(e)));
  };
  return (
    <div className="ds au">
      <div className="au-head">
        <h4 className="ds-h">Automations</h4>
        <button type="button" className="dg-send" disabled={!data} onClick={() => setDraft(blank(project ?? ""))}>New</button>
      </div>
      {error ? <p className="ds-err" role="alert">{error}</p> : null}
      {data && !data.automations.length ? <p className="dg-empty">Nothing yet. An automation runs a prompt on a timer, some times a day, once at a set time, when a file changes, or when you send the bot a command.</p> : null}
      <ul className="au-list">
        {(data?.automations ?? []).map((a) => {
          const last = a.runs[a.runs.length - 1];
          return (
            <li key={a.id} data-off={!a.enabled || undefined}>
              <div className="au-top">
                <b>{a.name}</b>
                <button type="button" className="au-switch" role="switch" aria-checked={a.enabled} aria-label={`${a.name} on or off`} onClick={() => act("toggle", { id: a.id, on: !a.enabled })}><i /></button>
              </div>
              <small>{triggerWords(a.trigger)}</small>
              <small>{a.project}{a.running ? " · running now" : a.next_at ? ` · next at ${when(a.next_at)}` : ""}</small>
              {last ? (
                <small>Last: {when(last.at)}{last.status !== "running" && last.status !== "done" ? ` · ${last.status}` : ""}{onOpen ? <> · <button type="button" className="au-link" onClick={() => onOpen(last.session_id)}>open its chat</button></> : null}</small>
              ) : null}
              {a.note ? <small className="au-note" role="status">⚠ {a.note}</small> : null}
              <div className="au-acts">
                <button type="button" className="dg-btn" disabled={a.running} onClick={() => act("run", { id: a.id })}>Run now</button>
                <button type="button" className="dg-btn" onClick={() => setDraft(fromAuto(a))}>Edit</button>
                {confirm === a.id ? <button type="button" className="dg-btn dg-danger" onClick={() => { setConfirm(""); act("delete", { id: a.id }); }}>Really delete</button>
                  : <button type="button" className="dg-btn" onClick={() => setConfirm(a.id)}>Delete</button>}
              </div>
            </li>
          );
        })}
      </ul>
      {draft ? <Form start={draft} projects={data?.projects ?? []} onOpen={onOpen} onClose={() => setDraft(null)} onDone={() => { setDraft(null); load(); }} /> : null}
    </div>
  );
}
