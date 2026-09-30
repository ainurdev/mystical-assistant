import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Castle, ListTodo, Play } from "lucide-react";
import type { RivendellTask, RivendellTasks as TasksAnswer } from "../../api";
import { api } from "../../api";
import { openSettings } from "../../lib/opensettings";
import { cardState, dueLabel, initials, type CardTone } from "../../lib/rivendelltasks";
import { askConfirm } from "../ui/Ask";

const POLL_MS = 10_000;

const TONE: Record<CardTone, string> = {
  warn: "var(--warn)", acc: "var(--acc)", ok: "var(--ok)", err: "var(--err)", "": "var(--txl)",
};

const toolBtn = {
  appearance: "none", cursor: "pointer", background: "transparent", color: "var(--txm)",
  border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)", fontFamily: "inherit",
  fontSize: "var(--t95)", lineHeight: 1.3, padding: "2px 6px",
} as const;

/** RIVENDELL — the open Rivendell tasks for the open session's repo, as cards.
 *  IMPLEMENT is Rivendell's own "Implement using AI": the request comes back
 *  to this bridge and runs through the PLUGINS queue like any other, so a card
 *  only shows where that request is. Polls while the tab is showing — request
 *  states change with no dashboard event to announce it (same as the queue).
 *  Design: docs/superpowers/specs/rivendell-tasks-tab.md. */
export function RivendellTasks({ project, onOpenSession }: {
  project: string | null;
  onOpenSession: (id: string) => void;
}) {
  const [data, setData] = useState<TasksAnswer | null>(null);
  const [fail, setFail] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  // task id -> the request IMPLEMENT just created, shown QUEUED until the list
  // catches up with it; task id -> why IMPLEMENT failed.
  const [queued, setQueued] = useState<Record<string, string>>({});
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [hov, setHov] = useState("");

  const load = useCallback(() => {
    if (!project) return;
    api.rivendellTasks(project)
      .then((r) => {
        setData(r); setFail(null); setNow(new Date());
        // Once the list has shown a request, the list is the truth about it.
        const listed = new Set(r.tasks.map((t) => t.implementation?.id));
        setQueued((q) => Object.fromEntries(Object.entries(q).filter(([, rid]) => !listed.has(rid))));
      })
      .catch((e: Error) => setFail(e.message));
  }, [project]);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  async function implement(t: RivendellTask) {
    const yes = await askConfirm(
      `Implement “${t.name}” with AI? It runs on this bridge without permission prompts, ` +
      "pushes a branch and opens a pull request; the result is posted to the task in Rivendell.");
    if (!yes) return;
    setBusy((b) => new Set(b).add(t.id));
    setErrs((m) => { const n = { ...m }; delete n[t.id]; return n; });
    try {
      const r = await api.rivendellImplement(t.instance_id, t.id);
      setQueued((q) => ({ ...q, [t.id]: r.request.id }));
      load();
    } catch (e) {
      setErrs((m) => ({ ...m, [t.id]: (e as Error).message }));
    } finally {
      setBusy((b) => { const n = new Set(b); n.delete(t.id); return n; });
    }
  }

  const projects = data?.projects ?? [];
  const names = [...new Set(projects.map((p) => p.name))].join(" · ");

  return (
    <div className="panel" style={{ border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", background: "color-mix(in srgb, var(--panel) 86%, transparent)", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px" }}>
        <span style={{ fontSize: "var(--t105)", letterSpacing: 2.5, color: "var(--txl)" }}>RIVENDELL</span>
        <span style={{ display: "flex", gap: 6 }}>
          {projects[0]?.url && (
            <button style={toolBtn} title="Open the project in Rivendell"
              onClick={() => window.open(projects[0].url, "_blank", "noopener")}>↗</button>
          )}
          <button style={toolBtn} title="refresh" onClick={load}>⟳</button>
        </span>
      </div>
      <div style={{ height: 1, background: "linear-gradient(90deg,var(--acc),transparent)" }} />
      {names && (
        <div className="swapin" style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 12px 2px", fontSize: "var(--t95)", color: "var(--purple-h)", minWidth: 0 }}>
          <span style={{ color: "var(--purple)", flex: "none" }}>◆</span>
          <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{names}</span>
          <span style={{ marginLeft: "auto", flex: "none", color: "var(--txl)" }}>{data?.tasks.length ?? 0} OPEN</span>
        </div>
      )}
      <div className="mscroll" style={{ flex: 1, minHeight: 0, padding: "4px 0 10px" }}>
        {body()}
      </div>
    </div>
  );

  function body(): ReactNode {
    // A dashboard built from newer code than the running bridge: the route is
    // missing, and the catch-all answers 404 "not found" (see SpendPanel).
    if (fail === "not found") return <Empty title="The bridge needs a restart" text="This dashboard is newer than the running bridge, which can't list Rivendell tasks yet." />;
    if (fail) return <Empty title="Couldn't read the task list" text={fail} />;
    if (!data) return [100, 100, 60].map((w, i) => <div key={i} style={{ height: 30, margin: "8px 12px", width: `calc(${w}% - 24px)`, background: "color-mix(in srgb, var(--acc) 7%, transparent)" }} />);
    if (data.slug === null) return <Empty title="No GitHub origin" text="This checkout has no GitHub origin remote, so there is no repo to look up in Rivendell." />;
    if (data.instances === 0) return <Empty title="Rivendell connection is off" text="Switch a Rivendell connection on, and this repo's tasks show up here." settings />;
    const err = data.errors[0];
    if (!data.tasks.length && err) {
      if (err.error === "token_rejected") return <Empty title="Rivendell refused the token" text="Mint a new one in Rivendell under Profile → API tokens (LLM), then paste it into the connection." settings />;
      if (err.error === "not_deployed") return <Empty title="This Rivendell can't list tasks yet" text="Its API is older than this tab. The task routes arrive with its next deploy." />;
      return <Empty title={err.error === "unreachable" ? "Rivendell is unreachable" : "Rivendell said no"} text={err.detail} />;
    }
    if (!projects.length) return <Empty title="No Rivendell project links this repo" text={<>Nothing in Rivendell links <code style={{ color: "var(--purple-h)" }}>{data.slug}</code>. Link it to a project there and its tasks show up here.</>} />;
    if (!data.tasks.length) return <Empty icon={<ListTodo size={26} strokeWidth={1.3} />} title="No open tasks" text={`Every task of ${names} is done.`} />;
    const mine = data.tasks.filter((t) => t.mine);
    const team = data.tasks.filter((t) => !t.mine);
    return (
      <>
        {data.errors.map((e) => (
          <div key={e.instance_id} style={{ margin: "6px 12px 0", fontSize: "var(--t9)", color: "var(--warn)" }}>⚠ {e.instance}: {e.detail}</div>
        ))}
        {mine.length > 0 && <Section label="YOURS" n={mine.length} />}
        {mine.map(card)}
        {team.length > 0 && <Section label="TEAM" n={team.length} />}
        {team.map(card)}
      </>
    );
  }

  function card(t: RivendellTask) {
    const id = `${t.instance_id}|${t.id}`;
    const just = queued[t.id];
    const req = just && t.implementation?.id !== just
      ? { id: just, status: "PENDING" as const, createdAt: now.toISOString(), completedAt: null }
      : t.implementation;
    const st = cardState({ implementation: req, session_id: t.session_id }, now);
    const due = dueLabel(t.dueDate, now);
    const working = busy.has(t.id);
    const on = hov === id;
    const act = (label: ReactNode, run: () => void, tone: "primary" | "ghost" | "err") => (
      <button
        disabled={working}
        onClick={(e) => { e.stopPropagation(); run(); }}
        style={{
          appearance: "none", cursor: working ? "default" : "pointer", fontFamily: "inherit",
          fontSize: "var(--t9)", letterSpacing: 1, padding: "5px 9px", whiteSpace: "nowrap",
          display: "inline-flex", alignItems: "center", gap: 5, opacity: working ? 0.5 : 1,
          border: `1px solid color-mix(in srgb, ${tone === "err" ? "var(--err)" : "var(--acc)"} ${tone === "primary" ? 45 : tone === "err" ? 40 : 22}%, transparent)`,
          background: tone === "primary" ? "color-mix(in srgb, var(--acc) 12%, transparent)" : "transparent",
          color: tone === "primary" ? "var(--txb)" : tone === "err" ? "var(--err)" : "var(--txm)",
        }}
      >{working ? "…" : label}</button>
    );
    return (
      <div
        key={id}
        onClick={() => t.htmlUrl && window.open(t.htmlUrl, "_blank", "noopener")}
        onMouseEnter={() => setHov(id)} onMouseLeave={() => setHov("")}
        title={t.htmlUrl ? "Open in Teamwork" : undefined}
        style={{
          margin: "0 8px 8px", padding: "9px 10px 10px", cursor: t.htmlUrl ? "pointer" : "default",
          border: `1px solid color-mix(in srgb, var(--acc) ${on ? 24 : 12}%, transparent)`,
          background: "color-mix(in srgb, var(--panel2) 70%, transparent)",
          transition: "border-color .13s ease", animation: "mfadeup .35s ease both",
        }}
      >
        <div style={{ fontSize: "var(--t115)", lineHeight: 1.4, color: "var(--txh)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{t.name}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 4, fontSize: "var(--t9)", color: "var(--txl)", whiteSpace: "nowrap", minWidth: 0 }}>
          {t.assignees.length > 0 && (
            <span title={t.assignees.map((a) => a.name).join(", ")} style={{ display: "inline-flex", flex: "none" }}>
              {t.assignees.slice(0, 3).map((a, i) => (
                <span key={a.id} style={{
                  width: 15, height: 15, borderRadius: "50%", marginLeft: i ? -3 : 0, display: "inline-flex",
                  alignItems: "center", justifyContent: "center", fontSize: "var(--t7)", color: "var(--acc-on)",
                  background: t.mine && i === 0 ? "var(--acc)" : "var(--txm)", border: "1px solid var(--panel)",
                }}>{initials(a.name)}</span>
              ))}
            </span>
          )}
          {[t.column && <span key="c" style={{ color: "var(--txd)" }}>{t.column}</span>,
            due && <span key="d" style={{ color: due.tone === "late" ? "var(--err)" : due.tone === "soon" ? "var(--warn)" : undefined }}>{due.text}</span>]
            .filter(Boolean)
            .flatMap((el, i) => (i ? [<span key={`s${i}`}>·</span>, el] : [el]))}
        </div>
        {(st.line || st.action) && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 8, minHeight: 25 }}>
            <span style={{ fontSize: "var(--t9)", letterSpacing: 1, color: TONE[st.tone] }}>{st.line}</span>
            {st.action === "implement" && act(<><Play size={9} strokeWidth={2.4} />IMPLEMENT</>, () => void implement(t), "primary")}
            {st.action === "open" && t.session_id && act("OPEN SESSION ›", () => onOpenSession(t.session_id!), "ghost")}
            {st.action === "again" && act("RUN AGAIN", () => void implement(t), "ghost")}
            {st.action === "retry" && act("RETRY", () => void implement(t), "err")}
          </div>
        )}
        {errs[t.id] && <div style={{ marginTop: 6, fontSize: "var(--t9)", color: "var(--err)" }}>{errs[t.id]}</div>}
      </div>
    );
  }
}

function Section({ label, n }: { label: string; n: number }) {
  return (
    <div style={{ display: "flex", gap: 8, padding: "10px 12px 6px", fontSize: "var(--t9)", letterSpacing: 1.8, color: "var(--txl)" }}>
      <span>{label}</span><span style={{ color: "var(--txg)" }}>{n}</span>
    </div>
  );
}

function Empty({ title, text, icon, settings }: { title: string; text: ReactNode; icon?: ReactNode; settings?: boolean }) {
  return (
    <div style={{ padding: "26px 16px", display: "flex", flexDirection: "column", alignItems: "center", gap: 10, textAlign: "center" }}>
      <span style={{ color: "var(--txg)" }}>{icon ?? <Castle size={26} strokeWidth={1.3} />}</span>
      <div style={{ fontSize: "var(--t115)", color: "var(--txh)" }}>{title}</div>
      <div style={{ fontSize: "var(--t10)", lineHeight: 1.55, color: "var(--txl)", maxWidth: 240 }}>{text}</div>
      {settings && (
        <button onClick={() => openSettings("plugins")} style={{ ...toolBtn, fontSize: "var(--t9)", letterSpacing: 1, padding: "5px 10px" }}>
          SETTINGS ▸ PLUGINS ›
        </button>
      )}
    </div>
  );
}
