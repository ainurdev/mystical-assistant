import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Castle, ListTodo, Play, SquarePen } from "lucide-react";
import type {
  RivendellLink, RivendellTask, RivendellTaskDetail, RivendellTasks as TasksAnswer, RivendellTodolist,
} from "../../api";
import { api } from "../../api";
import { openSettings } from "../../lib/opensettings";
import {
  cardState, closeCode, dueLabel, groupTasks, initials, linkChip, nextUp, resultBits, sentryPrompt, since,
  splitTitle, testText, workPrompt, type CardTone, type LinkTone,
} from "../../lib/rivendelltasks";
import { hhmm } from "../../lib/surfaces";
import { Markdown } from "../Markdown";

const POLL_MS = 10_000;
const LATER_KEY = "mystical:rivendell-later";   // "closed" while LATER is folded

const TONE: Record<CardTone, string> = {
  warn: "var(--warn)", acc: "var(--acc)", ok: "var(--ok)", err: "var(--err)", "": "var(--txl)",
};
const LINK_TONE: Record<LinkTone, string> = {
  ok: "var(--ok)", warn: "var(--warn)", err: "var(--err)", off: "var(--txd)",
};
// A checks word's colour, by its glyph (lib/rivendelltasks resultBits).
const CHECK_TONE: Record<string, string> = { "✓": "var(--ok)", "✕": "var(--err)", "◷": "var(--warn)" };
// NEXT UP's priority letter.
const PRIO: Record<string, string> = { high: "var(--warn)", medium: "var(--acc)", low: "var(--txl)" };

const mix = (c: string, pct: number) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;

const toolBtn = {
  appearance: "none", cursor: "pointer", background: "transparent", color: "var(--txm)",
  border: `1px solid ${mix("var(--acc)", 20)}`, fontFamily: "inherit",
  fontSize: "var(--t95)", lineHeight: 1.3, padding: "2px 6px",
} as const;

type Peek = { state: "loading" } | { state: "ok"; d: RivendellTaskDetail } | { state: "err"; msg: string };

const key = (t: Pick<RivendellTask, "instance_id" | "id">) => `${t.instance_id}|${t.id}`;
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");

/** RIVENDELL — the open Rivendell tasks for the open session's repo, as quiet
 *  cards grouped by what each needs from you: NEEDS YOU (a run held on a
 *  question, answered right here), RUNNING, DONE, then YOURS and TEAM, and
 *  LATER (the team's "deferred" marker, folded). At rest a card is its code and
 *  title with a small ▶; a click opens it in place — the task's spec, read off
 *  Rivendell (and the GitHub issue its description defers to) — with the two
 *  ways to start it: IMPLEMENT, Rivendell's own unattended "Implement using AI"
 *  (confirmed inline, with an optional note this bridge adds to the run), or
 *  WORK ON IT, a normal session here with the task in its composer. NEXT UP
 *  heads the list when Rivendell has made the project a todolist. The link's
 *  state sits beside the project name; a rejected token pauses the tab behind a
 *  banner and dims the cards to what was last known. Polls while showing —
 *  request states change with no dashboard event to announce it. Design:
 *  docs/superpowers/specs/rivendell-tasks-tab.md, rivendell-channel.md, then
 *  .mystical/design-drafts/rivendell-tab-v2/ (variant B). */
export function RivendellTasks({ project, onOpenSession, onWorkOn }: {
  project: string | null;
  onOpenSession: (id: string) => void;
  /** A new session in this project, `text` left in its composer (not sent). */
  onWorkOn: (text: string) => void;
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
  // The card opened in place, the one whose IMPLEMENT is asking, its note, and
  // every peek fetched so far (kept until ⟳).
  const [open, setOpen] = useState("");
  const [armed, setArmed] = useState("");
  const [note, setNote] = useState("");
  const [peeks, setPeeks] = useState<Record<string, Peek>>({});
  const [todo, setTodo] = useState<RivendellTodolist | null>(null);
  const [todoTick, setTodoTick] = useState(0);
  const [laterOpen, setLaterOpen] = useState(() => localStorage.getItem(LATER_KEY) !== "closed");
  const cards = useRef(new Map<string, HTMLDivElement>());
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

  // NEXT UP: read once per set of projects (and on ⟳), not on every poll — a
  // todolist changes when Rivendell regenerates it, not while you watch. The
  // first project with open items wins; a bridge without the route has none.
  const projectsKey = (data?.projects ?? []).map((p) => `${p.instance_id}|${p.id}`).join(",");
  useEffect(() => {
    if (!projectsKey) { setTodo(null); return; }
    let alive = true;
    Promise.all(projectsKey.split(",").map((s) => {
      const [iid, pid] = s.split("|");
      return api.rivendellTodolist(iid, pid).then((r) => r.todolist).catch(() => null);
    })).then((ls) => { if (alive) setTodo(ls.find((l) => l && l.items.length) ?? null); });
    return () => { alive = false; };
  }, [projectsKey, todoTick]);

  const unbusy = (id: string) => setBusy((b) => { const n = new Set(b); n.delete(id); return n; });

  function refresh() {
    setPeeks({});
    setTodoTick((n) => n + 1);
    void load();
  }

  async function fetchPeek(t: RivendellTask): Promise<RivendellTaskDetail | null> {
    const id = key(t);
    setPeeks((m) => ({ ...m, [id]: { state: "loading" } }));
    try {
      const d = await api.rivendellTask(t.instance_id, t.id);
      setPeeks((m) => ({ ...m, [id]: { state: "ok", d } }));
      return d;
    } catch (e) {
      setPeeks((m) => ({ ...m, [id]: { state: "err", msg: (e as Error).message } }));
      return null;
    }
  }

  /** A click on a card: open it in place, or close it again. */
  function toggle(t: RivendellTask) {
    const id = key(t);
    if (open === id) { setOpen(""); setArmed(""); return; }
    setOpen(id); setArmed("");
    if (!peeks[id]) void fetchPeek(t);
  }

  /** ▶, RUN AGAIN, RETRY: open the card with IMPLEMENT's confirm showing. */
  function arm(t: RivendellTask) {
    const id = key(t);
    setOpen(id); setArmed(id); setNote("");
    if (!peeks[id]) void fetchPeek(t);
  }

  /** NEXT UP names a task: open its card where it sits, and bring it into view. */
  function reveal(taskId: string, andArm = false) {
    const t = data?.tasks.find((x) => x.id === taskId);
    if (!t) return;
    if (splitTitle(t.name).later && !laterOpen) setLater(true);
    if (andArm) arm(t); else if (open !== key(t)) toggle(t);
    // To the top: the card grows once its spec arrives, and "nearest" would
    // leave that growth (and the confirm) below the fold.
    requestAnimationFrame(() => cards.current.get(key(t))?.scrollIntoView({ block: "start", behavior: "smooth" }));
  }

  function setLater(on: boolean) {
    setLaterOpen(on);
    localStorage.setItem(LATER_KEY, on ? "open" : "closed");
  }

  async function implement(t: RivendellTask) {
    setBusy((b) => new Set(b).add(t.id));
    setErrs((m) => { const n = { ...m }; delete n[t.id]; return n; });
    try {
      const r = await api.rivendellImplement(t.instance_id, t.id, note.trim());
      setQueued((q) => ({ ...q, [t.id]: r.request.id }));
      setArmed(""); setNote("");
      void load();
    } catch (e) {
      setErrs((m) => ({ ...m, [t.id]: (e as Error).message }));
    } finally {
      unbusy(t.id);
    }
  }

  async function workOn(t: RivendellTask) {
    const p = peeks[key(t)];
    onWorkOn(workPrompt(t, p?.state === "ok" ? p.d : await fetchPeek(t)));
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
      void load();
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
      void load();
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
    <div className="panel" style={{ border: `1px solid ${mix("var(--acc)", 16)}`, background: "color-mix(in srgb, var(--panel) 86%, transparent)", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px" }}>
        <span style={{ fontSize: "var(--t105)", letterSpacing: 2.5, color: "var(--txl)" }}>RIVENDELL</span>
        <span style={{ display: "flex", gap: 6 }}>
          {projects[0]?.url && (
            <button style={toolBtn} title="Open the project in Rivendell"
              onClick={() => window.open(projects[0].url, "_blank", "noopener")}>↗</button>
          )}
          <button style={toolBtn} title="refresh" onClick={refresh}>⟳</button>
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
    if (!data) return [100, 100, 60].map((w, i) => <div key={i} style={{ height: 30, margin: "8px 12px", width: `calc(${w}% - 24px)`, background: mix("var(--acc)", 7) }} />);
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
    // IMPLEMENT's request shows QUEUED (and groups as RUNNING) before the list has caught up with it.
    const tasks = data.tasks.map((t) => queued[t.id] && t.implementation?.id !== queued[t.id]
      ? { ...t, implementation: { id: queued[t.id], status: "PENDING" as const, createdAt: now.toISOString(), completedAt: null } }
      : t);
    const g = groupTasks(tasks);
    const last = data.tasks.some((t) => t.stale) ? " · LAST KNOWN" : "";
    const showCol = new Set(data.tasks.map((t) => t.column).filter(Boolean)).size > 1;
    const targets = [...new Set(g.later.map((t) => splitTitle(t.name).later))];
    const laterLabel = targets.length === 1 && targets[0] !== "later" ? `LATER · ${targets[0]!.toUpperCase()}` : "LATER";
    const card = (later: boolean) => (t: RivendellTask) => cardView(t, later, showCol);
    return (
      <>
        {paused}
        {data.errors.filter((e) => e.error !== "token_rejected").map((e) => (
          <div key={e.instance_id} style={{ margin: "6px 12px 0", fontSize: "var(--t9)", color: "var(--warn)" }}>⚠ {e.instance}: {e.detail}</div>
        ))}
        {nextUpView(new Set(data.tasks.map((t) => t.id)))}
        {g.needs.length > 0 && <Section label="NEEDS YOU" n={g.needs.length} color="var(--warn)" />}
        {g.needs.map(card(false))}
        {g.running.length > 0 && <Section label={`RUNNING${last}`} n={g.running.length} />}
        {g.running.map(card(false))}
        {g.done.length > 0 && <Section label={`DONE${last}`} n={g.done.length} />}
        {g.done.map(card(false))}
        {g.mine.length > 0 && <Section label={`YOURS${last}`} n={g.mine.length} />}
        {g.mine.map(card(false))}
        {g.team.length > 0 && <Section label={`TEAM${last}`} n={g.team.length} />}
        {g.team.map(card(false))}
        {g.later.length > 0 && (
          <Section label={laterLabel} n={g.later.length} onClick={() => setLater(!laterOpen)} chev={laterOpen ? "▾" : "▸"} />
        )}
        {laterOpen && g.later.map(card(true))}
      </>
    );
  }

  function nextUpView(openIds: Set<string>): ReactNode {
    const rows = nextUp(todo, openIds);
    if (!rows.length) return null;
    const pr = todo?.progress;
    return (
      <>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "10px 12px 6px", fontSize: "var(--t9)", letterSpacing: 1.8, color: "var(--txl)" }}>
          <span>NEXT UP</span>
          <span style={{ letterSpacing: 0.4, color: "var(--txg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            Rivendell’s todolist{todo?.generatedAt ? ` · ${day(todo.generatedAt)}` : ""}
          </span>
          {pr && <span style={{ marginLeft: "auto", flex: "none", letterSpacing: 0.6 }}>{pr.done}/{pr.total} DONE</span>}
        </div>
        <div style={{ margin: "0 8px 6px", padding: "2px 10px", border: `1px solid ${mix("var(--acc)", 12)}`, background: "color-mix(in srgb, var(--panel3) 80%, transparent)" }}>
          {rows.map((i, n) => (
            <div key={i.id} onClick={() => i.tasks[0] && reveal(i.tasks[0])}
              title={i.tasks.length ? "Show the task" : i.title}
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "6px 0", minHeight: 30,
                borderTop: n ? `1px solid ${mix("var(--acc)", 7)}` : "none", cursor: i.tasks.length ? "pointer" : "default",
              }}>
              <span style={{ flex: "none", width: 10, fontFamily: "var(--mono)", fontSize: "var(--t9)", color: PRIO[i.priority ?? ""] ?? "var(--txl)" }}>
                {(i.priority ?? "·")[0].toUpperCase()}
              </span>
              <span style={{ flex: 1, minWidth: 0, fontSize: "var(--t11)", color: "var(--txh)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{i.title}</span>
              {i.tasks.length === 1 && (
                <IconBtn title="Implement it — asks first" onClick={() => reveal(i.tasks[0], true)}><Play size={8} strokeWidth={2.6} /></IconBtn>
              )}
              {i.tasks.length > 1 && <span style={{ flex: "none", fontSize: "var(--t85)", letterSpacing: 1, color: "var(--txm)" }}>{i.tasks.length} TASKS ›</span>}
              {!i.tasks.length && i.sentry && (
                <Btn tone="ghost" onClick={() => onWorkOn(sentryPrompt(i.title, i.sentry!))} title={`Work on ${i.sentry.label ?? "the Sentry issue"} in a new session`}>FIX IT</Btn>
              )}
            </div>
          ))}
        </div>
      </>
    );
  }

  function cardView(t: RivendellTask, later: boolean, showCol: boolean) {
    const id = key(t);
    const req = t.implementation;
    const st = cardState({ implementation: req, session_id: t.session_id }, now);
    const due = dueLabel(t.dueDate, now);
    const working = busy.has(t.id);
    const frozen = !!t.stale;                 // last known: nothing new may start from it
    const on = hov === id;
    const isOpen = open === id;
    const isArmed = armed === id;
    const folded = later && !isOpen;
    const ask = t.run?.ask ?? null;
    const live = req?.status === "IN_PROGRESS" && !ask ? t.run?.live ?? null : null;
    const res = req?.status === "COMPLETED" || req?.status === "FAILED" ? resultBits(t.run?.result) : null;
    const asked = ask?.at ? since(ask.at, now) : "";
    const idle = st.action === "implement";
    const { code, title } = splitTitle(t.name);
    const href = t.url ?? t.htmlUrl;
    const meta = [
      t.assignees.length > 0 && (
        <span key="a" title={t.assignees.map((a) => a.name).join(", ")} style={{ display: "inline-flex", flex: "none" }}>
          {t.assignees.slice(0, 3).map((a, i) => (
            <span key={a.id} style={{
              width: 15, height: 15, borderRadius: "50%", marginLeft: i ? -3 : 0, display: "inline-flex",
              alignItems: "center", justifyContent: "center", fontSize: "var(--t7)", color: "var(--acc-on)",
              background: t.mine && i === 0 ? "var(--acc)" : "var(--txm)", border: "1px solid var(--panel)",
            }}>{initials(a.name)}</span>
          ))}
        </span>
      ),
      showCol && t.column && <span key="c" style={{ color: "var(--txd)" }}>{t.column}</span>,
      due && <span key="d" style={{ color: due.tone === "late" ? "var(--err)" : due.tone === "soon" ? "var(--warn)" : undefined }}>{due.text}</span>,
    ].filter(Boolean);
    const action = (label: ReactNode, run: () => void, tone: "primary" | "ghost" | "err" | "warn", off = false) =>
      <Btn tone={tone} off={working || off} onClick={run}>{working ? "…" : label}</Btn>;
    const row = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 8, minHeight: 25 } as const;
    const tone = ask ? "var(--warn)" : "var(--acc)";
    return (
      <div
        key={id}
        ref={(el) => { if (el) cards.current.set(id, el); else cards.current.delete(id); }}
        onClick={() => toggle(t)}
        onMouseEnter={() => setHov(id)} onMouseLeave={() => setHov("")}
        style={{
          margin: "0 8px 6px", padding: folded ? "6px 10px" : "8px 8px 9px 10px", cursor: "pointer",
          border: `1px solid ${mix(tone, ask ? 50 : isOpen ? 55 : on ? 30 : 12)}`,
          background: ask ? mix("var(--warn)", 4) : isOpen ? mix("var(--acc)", 6) : "color-mix(in srgb, var(--panel2) 70%, transparent)",
          opacity: frozen || folded ? 0.55 : 1, transition: "border-color .13s ease, background .13s ease",
          animation: "mfadeup .35s ease both",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {folded ? (
              <div style={{ fontSize: "var(--t105)", lineHeight: 1.45, color: "var(--txh)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {code && <span style={{ fontFamily: "var(--mono)", fontSize: "var(--t9)", color: "var(--txl)", marginRight: 7 }}>{code}</span>}{title}
              </div>
            ) : (
              <>
                {code && <div style={{ fontFamily: "var(--mono)", fontSize: "var(--t85)", lineHeight: 1, color: "var(--txl)", marginBottom: 5 }}>{code}</div>}
                <div style={{ fontSize: "var(--t115)", lineHeight: 1.45, color: isOpen ? "var(--txb)" : "var(--txh)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{title}</div>
              </>
            )}
          </div>
          {idle && !folded && !isArmed && !frozen && !isOpen && (
            // The ▶'s 22px is all the title ever gives up: under the pointer the
            // labelled button grows leftwards over the title's tail, so the
            // title never re-wraps on hover.
            <span style={{ position: "relative", flex: "none", width: 22, height: 22 }}>
              <span style={{ position: "absolute", top: 0, right: 0 }}>
                {on ? (
                  <Btn tone="primary" onClick={() => arm(t)} title="Implement it with AI — asks first"
                    style={{ height: 22, padding: "0 8px", background: "color-mix(in srgb, var(--acc) 16%, var(--panel2))" }}>
                    <Play size={9} strokeWidth={2.4} />IMPLEMENT
                  </Btn>
                ) : (
                  <IconBtn title="Implement it with AI — asks first" onClick={() => arm(t)}><Play size={9} strokeWidth={2.4} /></IconBtn>
                )}
              </span>
            </span>
          )}
        </div>
        {meta.length > 0 && !folded && (
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 5, fontSize: "var(--t9)", color: "var(--txl)", whiteSpace: "nowrap", minWidth: 0 }}>
            {meta.flatMap((el, i) => (i ? [<span key={`s${i}`}>·</span>, el] : [el]))}
          </div>
        )}
        {isOpen && peekView(t, idle, frozen, href, isArmed)}
        {ask && (
          <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 9, padding: "2px 0 2px 10px", borderLeft: "2px solid var(--warn)", cursor: "default" }}>
            <div style={{ fontSize: "var(--t9)", letterSpacing: 1.5, color: "var(--warn)" }}>
              ◆ ASKS{asked ? ` · ${asked === "now" ? "just now" : `${asked} ago`}` : ""}
            </div>
            <div style={{ marginTop: 5, fontSize: "var(--t105)", lineHeight: 1.5, color: "var(--txh)" }}>{ask.question}</div>
            {ask.simple && ask.options.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                {ask.options.map((o, i) => <span key={o}>{action(o, () => void answer(t, o), i === 0 ? "warn" : "ghost")}</span>)}
              </div>
            )}
          </div>
        )}
        {live && (
          <div style={{ marginTop: 8, padding: "6px 8px", background: mix("var(--acc)", 6), fontSize: "var(--t9)" }}>
            <div title={live.line} style={{ color: "var(--txm)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>› {live.line}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5, color: "var(--txl)", letterSpacing: 1 }}>
              {live.todos && (
                <span aria-hidden style={{ display: "inline-flex", gap: 2 }}>
                  {Array.from({ length: Math.min(live.todos.total, 12) }, (_, i) => (
                    <span key={i} style={{ width: 10, height: 4, background: i < live.todos!.done ? "var(--acc)" : mix("var(--acc)", 18) }} />
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
        {isArmed ? armedView(t, working) : ask ? (
          <div style={row}>
            <span style={{ fontSize: "var(--t9)", letterSpacing: 1, color: "var(--warn)" }}>◆ NEEDS YOU · PAUSED</span>
            {t.session_id && action("OPEN SESSION ›", () => onOpenSession(t.session_id!), "ghost")}
          </div>
        ) : st.line && (
          <div style={row}>
            <span style={{ fontSize: "var(--t9)", letterSpacing: 1, color: TONE[st.tone] }}>{st.line}</span>
            {st.action === "open" && t.session_id && action("OPEN SESSION ›", () => onOpenSession(t.session_id!), "ghost")}
            {st.action === "again" && action("RUN AGAIN", () => arm(t), "ghost", frozen)}
            {st.action === "retry" && action("RETRY", () => arm(t), "err", frozen)}
          </div>
        )}
        {errs[t.id] && <div style={{ marginTop: 6, fontSize: "var(--t9)", color: "var(--err)" }}>{errs[t.id]}</div>}
      </div>
    );
  }

  /** The card opened in place: what the task asks for — the spec its
   *  description defers to, or the description — and the ways to start it. */
  function peekView(t: RivendellTask, idle: boolean, frozen: boolean, href: string | null, isArmed: boolean) {
    const p = peeks[key(t)];
    const d = p?.state === "ok" ? p.d : null;
    const text = d ? (d.spec?.body || d.description || "").trim() : "";
    const est = d?.estimateMinutes ? (d.estimateMinutes >= 60 ? `est ${Math.round(d.estimateMinutes / 6) / 10}h` : `est ${d.estimateMinutes}m`) : "";
    const facts = d ? [d.tasklist, [d.createdBy, day(d.createdAt)].filter(Boolean).join(", "), est].filter(Boolean) as string[] : [];
    return (
      <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 8, cursor: "default" }}>
        {(!p || p.state === "loading") && [92, 70].map((w) => (
          <div key={w} style={{ height: 9, margin: "6px 0", width: `${w}%`, background: mix("var(--acc)", 8) }} />
        ))}
        {p?.state === "err" && <div style={{ fontSize: "var(--t9)", color: "var(--err)" }}>Couldn't read the task: {p.msg}</div>}
        {d && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--t85)", letterSpacing: 1.5, color: "var(--txl)" }}>
              <span>{d.spec ? "SPEC" : "DESCRIPTION"}</span>
              {d.spec && (
                <a href={d.spec.url} target="_blank" rel="noopener" style={{ color: "var(--purple-h)", letterSpacing: 0.6, textDecoration: "none" }}>
                  GitHub #{d.spec.number}{d.spec.state === "CLOSED" ? " · closed" : ""} ↗
                </a>
              )}
            </div>
            <div style={{ marginTop: 5, paddingLeft: 9, borderLeft: `2px solid ${mix("var(--acc)", 35)}`, fontSize: "var(--t105)", lineHeight: 1.55, color: "var(--txm)", maxHeight: "17em", overflow: "auto" }}>
              {text ? <Markdown breaks className="rv-peek">{text}</Markdown> : <span style={{ color: "var(--txg)" }}>No description in Rivendell.</span>}
            </div>
            {(facts.length > 0 || d.tags.length > 0) && (
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "3px 7px", marginTop: 7, fontSize: "var(--t9)", color: "var(--txl)" }}>
                {facts.flatMap((f, i) => (i ? [<span key={`s${i}`}>·</span>, <span key={f}>{f}</span>] : [<span key={f}>{f}</span>]))}
                {d.tags.map((g) => (
                  <span key={g.name} style={{ padding: "0 5px", border: `1px solid ${mix(g.color || "var(--txl)", 45)}`, color: "var(--txm)", letterSpacing: 0.4 }}>{g.name}</span>
                ))}
              </div>
            )}
          </>
        )}
        {!isArmed && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 9 }}>
            {idle && !frozen && <Btn tone="primary" onClick={() => arm(t)}><Play size={9} strokeWidth={2.4} />IMPLEMENT</Btn>}
            <Btn tone="ghost" onClick={() => void workOn(t)} title="A new session here, with this task in its composer">
              <SquarePen size={10} strokeWidth={2.2} />WORK ON IT
            </Btn>
            {href && (
              <button style={{ ...toolBtn, marginLeft: "auto" }} title={t.url ? "Open in Rivendell" : "Open in Teamwork"}
                onClick={() => window.open(href, "_blank", "noopener")}>↗</button>
            )}
          </div>
        )}
      </div>
    );
  }

  /** IMPLEMENT, asking first: what the run will do, and an optional note this
   *  bridge adds to Rivendell's prompt (bridge/rivendell.py implement). */
  function armedView(t: RivendellTask, working: boolean) {
    const go = () => void implement(t);
    return (
      <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 9, padding: "8px 9px 9px", cursor: "default", border: `1px solid ${mix("var(--acc)", 38)}`, background: mix("var(--acc)", 6) }}>
        <div style={{ fontSize: "var(--t85)", letterSpacing: 1.2, lineHeight: 1.5, color: "var(--txm)" }}>
          <span style={{ color: "var(--txb)" }}>RUNS ON ITS OWN</span> · NO PERMISSION PROMPTS · PUSHES A BRANCH · OPENS A PR · POSTS THE RESULT TO THE TASK
        </div>
        <label style={{ display: "block", marginTop: 7 }}>
          <span style={{ display: "block", fontSize: "var(--t8)", letterSpacing: 1.3, color: "var(--txl)", marginBottom: 3 }}>NOTE FOR THE RUN · OPTIONAL</span>
          <textarea
            autoFocus value={note} rows={3} onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. copy the TeamLeader module; secrets go in .env"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go(); }
              if (e.key === "Escape") { e.stopPropagation(); setArmed(""); }
            }}
            style={{
              display: "block", width: "100%", boxSizing: "border-box", resize: "vertical", padding: "6px 7px",
              background: "var(--panel3)", color: "var(--txh)", border: `1px solid ${mix("var(--acc)", 30)}`,
              fontFamily: "inherit", fontSize: "var(--t105)", lineHeight: 1.5, outline: "none",
            }}
          />
        </label>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
          <Btn tone="solid" off={working} onClick={go} title="Start it (Ctrl+Enter)">
            {working ? "…" : <><Play size={9} strokeWidth={2.4} />START RUN</>}
          </Btn>
          <Btn tone="ghost" onClick={() => setArmed("")}>CANCEL</Btn>
          <span style={{ marginLeft: "auto", fontSize: "var(--t8)", letterSpacing: 1.2, color: "var(--txl)", textAlign: "right" }}>QUEUES IF BUSY</span>
        </div>
      </div>
    );
  }
}

/** The tab's labelled button. `primary` is the accent action, `solid` the
 *  one that commits (START RUN), `warn` a NEEDS YOU answer, `err` RETRY. */
function Btn({ tone, off = false, onClick, title, style: extra, children }: {
  tone: "primary" | "solid" | "ghost" | "err" | "warn"; off?: boolean; onClick: () => void; title?: string;
  style?: CSSProperties; children: ReactNode;
}) {
  const c = tone === "err" ? "var(--err)" : tone === "warn" ? "var(--warn)" : "var(--acc)";
  const strong = tone === "primary" || tone === "solid" || tone === "warn";
  const style: CSSProperties = {
    appearance: "none", cursor: off ? "default" : "pointer", fontFamily: "inherit",
    fontSize: "var(--t9)", letterSpacing: 1, padding: "5px 9px", whiteSpace: "nowrap", flex: "none",
    display: "inline-flex", alignItems: "center", gap: 5, opacity: off ? 0.5 : 1,
    border: `1px solid ${tone === "solid" ? c : mix(c, strong ? 45 : tone === "err" ? 40 : 22)}`,
    background: strong ? mix(c, tone === "solid" ? 22 : 12) : "transparent",
    color: tone === "primary" || tone === "solid" ? "var(--txb)" : tone === "ghost" ? "var(--txm)" : c,
    ...extra,
  };
  return <button disabled={off} title={title} style={style} onClick={(e) => { e.stopPropagation(); onClick(); }}>{children}</button>;
}

/** The small square ▶ a quiet card wears at rest (and NEXT UP's). */
function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button title={title} aria-label={title} onClick={(e) => { e.stopPropagation(); onClick(); }} style={{
      appearance: "none", cursor: "pointer", flex: "none", width: 22, height: 22, padding: 0,
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      background: "transparent", color: "var(--txm)", border: `1px solid ${mix("var(--acc)", 26)}`,
    }}>{children}</button>
  );
}

/** The connection beside the project name (lib/rivendelltasks linkChip). */
function Chip({ link, now }: { link: RivendellLink; now: Date }) {
  const c = linkChip(link, now);
  const color = LINK_TONE[c.tone];
  return (
    <span title={link.detail || c.label} style={{
      flex: "none", display: "inline-flex", alignItems: "center", gap: 5, padding: "1px 6px",
      fontSize: "var(--t85)", letterSpacing: 1, color, border: `1px solid ${mix(color, 40)}`,
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
    padding: "6px 10px", background: "transparent", color: c, border: `1px solid ${mix(c, 45)}`,
  }) as const;
  return (
    <div style={{ margin: "8px 8px 6px", padding: "10px 11px", borderLeft: "2px solid var(--err)", background: mix("var(--err)", 7) }}>
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

function Section({ label, n, color, onClick, chev }: { label: string; n: number; color?: string; onClick?: () => void; chev?: string }) {
  return (
    <div onClick={onClick} style={{
      display: "flex", gap: 8, padding: "10px 12px 6px", fontSize: "var(--t9)", letterSpacing: 1.8,
      color: color ?? "var(--txl)", cursor: onClick ? "pointer" : "default", userSelect: onClick ? "none" : undefined,
    }}>
      <span>{label}</span><span style={{ color: "var(--txg)" }}>{n}</span>
      {chev && <span style={{ marginLeft: "auto", color: "var(--txm)" }}>{chev}</span>}
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
