import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Castle, ListTodo, Play } from "lucide-react";
import type { RivendellLink, RivendellTask, RivendellTasks as TasksAnswer } from "../../api";
import { api } from "../../api";
import { openSettings } from "../../lib/opensettings";
import {
  cardState, closeCode, dueLabel, groupTasks, initials, linkChip, resultBits, since, testText,
  type CardTone, type LinkTone,
} from "../../lib/rivendelltasks";
import { hhmm } from "../../lib/surfaces";
import { askConfirm } from "../ui/Ask";

const POLL_MS = 10_000;

const TONE: Record<CardTone, string> = {
  warn: "var(--warn)", acc: "var(--acc)", ok: "var(--ok)", err: "var(--err)", "": "var(--txl)",
};
const LINK_TONE: Record<LinkTone, string> = {
  ok: "var(--ok)", warn: "var(--warn)", err: "var(--err)", off: "var(--txd)",
};
// A checks word's colour, by its glyph (lib/rivendelltasks resultBits).
const CHECK_TONE: Record<string, string> = { "✓": "var(--ok)", "✕": "var(--err)", "◷": "var(--warn)" };

const toolBtn = {
  appearance: "none", cursor: "pointer", background: "transparent", color: "var(--txm)",
  border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)", fontFamily: "inherit",
  fontSize: "var(--t95)", lineHeight: 1.3, padding: "2px 6px",
} as const;

/** RIVENDELL — the open Rivendell tasks for the open session's repo, as cards,
 *  with what this bridge knows about each one's run: the question it is held
 *  on (NEEDS YOU, answered right here, resuming the same session), what it is
 *  doing, what came back. IMPLEMENT is Rivendell's own "Implement using AI":
 *  the request comes back to this bridge and runs through the PLUGINS queue
 *  like any other. The link's state sits beside the project name; a rejected
 *  token pauses the tab behind a banner and dims the cards to what was last
 *  known. Polls while showing — request states change with no dashboard event
 *  to announce it. Design: docs/superpowers/specs/rivendell-tasks-tab.md, then
 *  docs/superpowers/specs/rivendell-channel.md. */
export function RivendellTasks({ project, onOpenSession }: {
  project: string | null;
  onOpenSession: (id: string) => void;
}) {
  const [data, setData] = useState<TasksAnswer | null>(null);
  const [fail, setFail] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  // task id -> the request IMPLEMENT just created, shown QUEUED until the list
  // catches up with it; task id -> why IMPLEMENT (or an answer) failed.
  const [queued, setQueued] = useState<Record<string, string>>({});
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [hov, setHov] = useState("");
  // TEST LINK on the TOKEN REJECTED banner: the connection being tested, and
  // what each test said.
  const [testing, setTesting] = useState("");
  const [tested, setTested] = useState<Record<string, string>>({});

  const load = useCallback((): Promise<void> => {
    if (!project) return Promise.resolve();
    return api.rivendellTasks(project)
      .then((r) => {
        setData(r); setFail(null); setNow(new Date());
        // Once the list has shown a request, the list is the truth about it.
        const listed = new Set(r.tasks.map((t) => t.implementation?.id));
        setQueued((q) => Object.fromEntries(Object.entries(q).filter(([, rid]) => !listed.has(rid))));
      })
      .catch((e: Error) => setFail(e.message));
  }, [project]);

  // A chain, not an interval: the next poll is set when this one has answered,
  // so a slow answer (a Rivendell that is slow to list) never stacks polls.
  useEffect(() => {
    let alive = true;
    let t: ReturnType<typeof setTimeout> | undefined;
    const tick = () => void load().finally(() => { if (alive) t = setTimeout(tick, POLL_MS); });
    tick();
    return () => { alive = false; clearTimeout(t); };
  }, [load]);

  const unbusy = (id: string) => setBusy((b) => { const n = new Set(b); n.delete(id); return n; });

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
      unbusy(t.id);
    }
  }

  /** NEEDS YOU, answered from the card: the session's own answer route, so it
   *  resumes the same run exactly as its QuestionCard would. */
  async function answer(t: RivendellTask, label: string) {
    const ask = t.run?.ask;
    if (!ask) return;
    setBusy((b) => new Set(b).add(t.id));
    setErrs((m) => { const n = { ...m }; delete n[t.id]; return n; });
    try {
      await api.respond(ask.job_id, { request_id: ask.request_id, answers: [{ header: ask.header, labels: [label] }] });
      load();
    } catch (e) {
      setErrs((m) => ({ ...m, [t.id]: (e as Error).message }));
    } finally {
      unbusy(t.id);
    }
  }

  async function test(iid: string) {
    setTesting(iid);
    try {
      setTested((m) => ({ ...m, [iid]: "" }));
      const r = await api.rivendellTest(iid);
      setTested((m) => ({ ...m, [iid]: testText(r) }));
      load();
    } catch (e) {
      setTested((m) => ({ ...m, [iid]: `✕ ${(e as Error).message}` }));
    } finally {
      setTesting("");
    }
  }

  const projects = data?.projects ?? [];
  const links = data?.links ?? [];
  const names = [...new Set(projects.map((p) => p.name))].join(" · ") || links.map((l) => l.instance).join(" · ");

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
          {links.map((l) => <Chip key={l.instance_id} link={l} now={now} />)}
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
    const paused = links.filter((l) => l.state === "auth_error").map((l) => (
      <Paused key={l.instance_id} link={l} testing={testing === l.instance_id}
        note={tested[l.instance_id]} onTest={() => void test(l.instance_id)} />
    ));
    const err = data.errors[0];
    if (!data.tasks.length && err) {
      if (err.error === "token_rejected") {
        return paused.length ? paused : <Empty title="Rivendell refused the token" text="Mint a new one in Rivendell under Profile → API tokens (LLM), then paste it into the connection." settings />;
      }
      if (err.error === "not_deployed") return <Empty title="This Rivendell can't list tasks yet" text="Its API is older than this tab. The task routes arrive with its next deploy." />;
      return <Empty title={err.error === "unreachable" ? "Rivendell is unreachable" : "Rivendell said no"} text={err.detail} />;
    }
    if (!projects.length) return <>{paused}<Empty title="No Rivendell project links this repo" text={<>Nothing in Rivendell links <code style={{ color: "var(--purple-h)" }}>{data.slug}</code>. Link it to a project there and its tasks show up here.</>} /></>;
    if (!data.tasks.length) return <>{paused}<Empty icon={<ListTodo size={26} strokeWidth={1.3} />} title="No open tasks" text={`Every task of ${names} is done.`} /></>;
    const g = groupTasks(data.tasks);
    const last = data.tasks.some((t) => t.stale) ? " · LAST KNOWN" : "";
    return (
      <>
        {paused}
        {data.errors.filter((e) => e.error !== "token_rejected").map((e) => (
          <div key={e.instance_id} style={{ margin: "6px 12px 0", fontSize: "var(--t9)", color: "var(--warn)" }}>⚠ {e.instance}: {e.detail}</div>
        ))}
        {g.needs.length > 0 && <Section label="NEEDS YOU" n={g.needs.length} color="var(--warn)" />}
        {g.needs.map(card)}
        {g.mine.length > 0 && <Section label={`YOURS${last}`} n={g.mine.length} />}
        {g.mine.map(card)}
        {g.team.length > 0 && <Section label={`TEAM${last}`} n={g.team.length} />}
        {g.team.map(card)}
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
    const frozen = !!t.stale;                 // last known: nothing new may start from it
    const on = hov === id;
    const ask = t.run?.ask ?? null;
    const live = req?.status === "IN_PROGRESS" && !ask ? t.run?.live ?? null : null;
    const res = req?.status === "COMPLETED" || req?.status === "FAILED" ? resultBits(t.run?.result) : null;
    const asked = ask?.at ? since(ask.at, now) : "";
    const act = (label: ReactNode, run: () => void, tone: "primary" | "ghost" | "err" | "warn", off = false) => {
      const c = tone === "err" ? "var(--err)" : tone === "warn" ? "var(--warn)" : "var(--acc)";
      const strong = tone === "primary" || tone === "warn";
      return (
        <button
          disabled={working || off}
          onClick={(e) => { e.stopPropagation(); run(); }}
          style={{
            appearance: "none", cursor: working || off ? "default" : "pointer", fontFamily: "inherit",
            fontSize: "var(--t9)", letterSpacing: 1, padding: "5px 9px", whiteSpace: "nowrap",
            display: "inline-flex", alignItems: "center", gap: 5, opacity: working || off ? 0.5 : 1,
            border: `1px solid color-mix(in srgb, ${c} ${strong ? 45 : tone === "err" ? 40 : 22}%, transparent)`,
            background: strong ? `color-mix(in srgb, ${c} 12%, transparent)` : "transparent",
            color: tone === "primary" ? "var(--txb)" : tone === "ghost" ? "var(--txm)" : c,
          }}
        >{working ? "…" : label}</button>
      );
    };
    const href = t.url ?? t.htmlUrl;
    const row = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 8, minHeight: 25 } as const;
    return (
      <div
        key={id}
        onClick={() => href && window.open(href, "_blank", "noopener")}
        onMouseEnter={() => setHov(id)} onMouseLeave={() => setHov("")}
        title={t.url ? "Open in Rivendell" : t.htmlUrl ? "Open in Teamwork" : undefined}
        style={{
          margin: "0 8px 8px", padding: "9px 10px 10px", cursor: href ? "pointer" : "default",
          border: `1px solid color-mix(in srgb, ${ask ? "var(--warn)" : "var(--acc)"} ${ask ? 45 : on ? 24 : 12}%, transparent)`,
          background: "color-mix(in srgb, var(--panel2) 70%, transparent)", opacity: frozen ? 0.55 : 1,
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
        {ask && (
          <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 9, padding: "2px 0 2px 10px", borderLeft: "2px solid var(--warn)", cursor: "default" }}>
            <div style={{ fontSize: "var(--t9)", letterSpacing: 1.5, color: "var(--warn)" }}>
              ◆ ASKS{asked ? ` · ${asked === "now" ? "just now" : `${asked} ago`}` : ""}
            </div>
            <div style={{ marginTop: 5, fontSize: "var(--t105)", lineHeight: 1.5, color: "var(--txh)" }}>{ask.question}</div>
            {ask.simple && ask.options.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                {ask.options.map((o, i) => <span key={o}>{act(o, () => void answer(t, o), i === 0 ? "warn" : "ghost")}</span>)}
              </div>
            )}
          </div>
        )}
        {live && (
          <div style={{ marginTop: 8, padding: "6px 8px", background: "color-mix(in srgb, var(--acc) 6%, transparent)", fontSize: "var(--t9)" }}>
            <div title={live.line} style={{ color: "var(--txm)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>› {live.line}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5, color: "var(--txl)", letterSpacing: 1 }}>
              {live.todos && (
                <span aria-hidden style={{ display: "inline-flex", gap: 2 }}>
                  {Array.from({ length: Math.min(live.todos.total, 12) }, (_, i) => (
                    <span key={i} style={{ width: 10, height: 4, background: i < live.todos!.done ? "var(--acc)" : "color-mix(in srgb, var(--acc) 18%, transparent)" }} />
                  ))}
                </span>
              )}
              <span>{[live.todos && `${live.todos.done}/${live.todos.total} TODOS`, `${live.steps} STEPS`].filter(Boolean).join(" · ")}</span>
            </div>
          </div>
        )}
        {res && (res.pr || res.rest || res.outcome) && (
          <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", alignItems: "center", gap: "2px 8px", fontSize: "var(--t9)", color: "var(--txl)" }}>
            {res.outcome && <span style={{ color: "var(--err)" }}>{res.outcome}</span>}
            {res.pr && (
              <a href={res.pr.url} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}
                style={{ color: "var(--txb)", textDecoration: "none" }}>↑ {res.pr.label} ↗</a>
            )}
            {res.pr?.checks && <span style={{ color: CHECK_TONE[res.pr.checks[0]] }}>{res.pr.checks}</span>}
            {res.rest && <span>{res.rest}</span>}
          </div>
        )}
        {ask ? (
          <div style={row}>
            <span style={{ fontSize: "var(--t9)", letterSpacing: 1, color: "var(--warn)" }}>◆ NEEDS YOU · PAUSED</span>
            {t.session_id && act("OPEN SESSION ›", () => onOpenSession(t.session_id!), "ghost")}
          </div>
        ) : (st.line || st.action) && (
          <div style={row}>
            <span style={{ fontSize: "var(--t9)", letterSpacing: 1, color: TONE[st.tone] }}>{st.line}</span>
            {st.action === "implement" && act(<><Play size={9} strokeWidth={2.4} />IMPLEMENT</>, () => void implement(t), "primary", frozen)}
            {st.action === "open" && t.session_id && act("OPEN SESSION ›", () => onOpenSession(t.session_id!), "ghost")}
            {st.action === "again" && act("RUN AGAIN", () => void implement(t), "ghost", frozen)}
            {st.action === "retry" && act("RETRY", () => void implement(t), "err", frozen)}
          </div>
        )}
        {errs[t.id] && <div style={{ marginTop: 6, fontSize: "var(--t9)", color: "var(--err)" }}>{errs[t.id]}</div>}
      </div>
    );
  }
}

/** The connection beside the project name (lib/rivendelltasks linkChip). */
function Chip({ link, now }: { link: RivendellLink; now: Date }) {
  const c = linkChip(link, now);
  const color = LINK_TONE[c.tone];
  return (
    <span title={link.detail || c.label} style={{
      flex: "none", display: "inline-flex", alignItems: "center", gap: 5, padding: "1px 6px",
      fontSize: "var(--t85)", letterSpacing: 1, color, border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`,
    }}>
      {c.tone === "ok" && <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, boxShadow: `0 0 6px ${color}` }} />}
      {c.tone === "warn" && "◌"}{c.tone === "err" && "✕"}
      <span>{c.label}</span>
    </span>
  );
}

/** TOKEN REJECTED: nothing Rivendell sends can arrive and IMPLEMENT can't start
 *  until the token is replaced. REPLACE TOKEN opens Settings ▸ PLUGINS editing
 *  this connection; TEST LINK re-dials it once (a 4401 can be Rivendell's own
 *  hiccup, and a parked worker never retries by itself). */
function Paused({ link, testing, note, onTest }: { link: RivendellLink; testing: boolean; note?: string; onTest: () => void }) {
  const code = closeCode(link.detail);
  const at = link.down_since ?? link.since;
  const btn = (c: string) => ({
    appearance: "none", cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1.5,
    padding: "6px 10px", background: "transparent", color: c, border: `1px solid color-mix(in srgb, ${c} 45%, transparent)`,
  }) as const;
  return (
    <div style={{ margin: "8px 8px 6px", padding: "10px 11px", borderLeft: "2px solid var(--err)", background: "color-mix(in srgb, var(--err) 7%, transparent)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: "var(--t9)", letterSpacing: 1.5 }}>
        <span style={{ color: "var(--err)" }}>✕ JOBS ARE PAUSED</span>
        <span style={{ color: "var(--txl)", letterSpacing: 0.5 }}>{[at ? `since ${hhmm(at)}` : "", code].filter(Boolean).join(" · ")}</span>
      </div>
      <div style={{ marginTop: 6, fontSize: "var(--t10)", lineHeight: 1.55, color: "var(--txm)" }}>
        Rivendell refused this bridge's token, so nothing it sends can arrive, and IMPLEMENT can't start.
        Mint a new LLM token in Rivendell ▸ Profile ▸ API tokens.
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 9 }}>
        <button style={btn("var(--err)")} onClick={() => openSettings("plugins", link.instance_id)}>REPLACE TOKEN ▸</button>
        <button style={{ ...btn("var(--txm)"), opacity: testing ? 0.5 : 1 }} disabled={testing} onClick={onTest}>
          {testing ? "TESTING…" : "TEST LINK"}
        </button>
      </div>
      {note && <div style={{ marginTop: 6, fontSize: "var(--t9)", color: "var(--txl)" }}>{note}</div>}
    </div>
  );
}

function Section({ label, n, color }: { label: string; n: number; color?: string }) {
  return (
    <div style={{ display: "flex", gap: 8, padding: "10px 12px 6px", fontSize: "var(--t9)", letterSpacing: 1.8, color: color ?? "var(--txl)" }}>
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
