import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { ExternalLink, ListTodo, Play, RefreshCw, SquarePen } from "lucide-react";
import type { RivendellLink, RivendellTask, RivendellTaskDetail, SessionBrief } from "../../api";
import { api } from "../../api";
import { queryClient, rail, reread } from "../../lib/queries";
import { openSettings } from "../../lib/opensettings";
import { RivendellIcon } from "../../lib/rivendellicon";
import {
  cardState, closeCode, dueLabel, groupTasks, inProgress, initials, linkChip, nextUp, resultBits, sentryPrompt, since,
  splitTitle, taskSession, testText, workPrompt, type CardTone, type LinkTone,
} from "../../lib/rivendelltasks";
import { hhmm } from "../../lib/surfaces";
import { Markdown } from "../Markdown";
import { deck, liveSkips } from "../../lib/deck";
import { TabKick } from "./TabKick";

const POLL_MS = 10_000;
const EVERY_MS = 30_000;   // the everywhere view asks Rivendell once per project
const LATER_KEY = "mystical:rivendell-later";   // "closed" while LATER is folded

const TONE: Record<CardTone, string> = {
  warn: "var(--warn)", acc: "var(--acc)", ok: "var(--ok)", err: "var(--err)", "": "var(--txl)",
};
const LINK_TONE: Record<LinkTone, string> = {
  ok: "var(--ok)", warn: "var(--warn)", err: "var(--err)", off: "var(--txd)",
};
// A task's project, by its order on the tab (everywhere view): theme tokens only.
const PROJECT_TONE = ["var(--purple-h)", "var(--ok)", "var(--acc)", "var(--warn)", "var(--txm)"];
// Rivendell's priority, as the row's small mark.
const PRIORITY_TONE: Record<string, string> = { high: "var(--err)", medium: "var(--warn)" };
// A checks word's colour, by its glyph (lib/rivendelltasks resultBits).
const CHECK_TONE: Record<string, string> = { "✓": "var(--ok)", "✕": "var(--err)", "◷": "var(--warn)" };

const mix = (c: string, pct: number) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;

const toolBtn = {
  appearance: "none", cursor: "pointer", background: "transparent", color: "var(--txm)",
  border: `1px solid ${mix("var(--acc)", 20)}`, fontFamily: "inherit",
  fontSize: "var(--t95)", lineHeight: 1.3, padding: "2px 6px",
} as const;

type Peek = { state: "loading" } | { state: "ok"; d: RivendellTaskDetail } | { state: "err"; msg: string };

// Skips live per project, with the next-up order they were made under (lib/deck liveSkips).
type Stored = { sig: string; at: Record<string, number> };
const readSkips = (project: string | null): Stored | null => {
  try { return JSON.parse(localStorage.getItem(`rv-skip:${project}`) ?? "null") as Stored | null; } catch { return null; }
};

const key = (t: Pick<RivendellTask, "instance_id" | "id">) => `${t.instance_id}|${t.id}`;
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");

/** RIVENDELL — the open Rivendell tasks for the open session's repo, led by
 *  what needs you: NEEDS YOU (a run held on a question, answered right here; a
 *  failed run, RETRY), then MOVING (In progress on the board, running, or
 *  finished with a PR, each with the session working it), then UP NEXT, your
 *  queue numbered in deck order (todolist order, skips) whose #1 stands open
 *  with its actions, then TEAM, DONE, LATER (the team's "deferred" marker,
 *  folded) as 30px rows. Flat: no fills, a rule only beside what asks you.
 *  A row opens in place into its card — the task's spec, read off Rivendell
 *  (and the GitHub issue its description defers to) — with the two ways to
 *  start it: IMPLEMENT, Rivendell's own unattended "Implement using AI"
 *  (confirmed inline, with an optional note this bridge adds to the run), or
 *  WORK ON IT, a normal session with the task in its composer. In a checkout no
 *  project links, the bridge answers with every project's tasks (`everywhere`)
 *  and the tab keeps yours, grouped by project; WORK ON IT opens the session in
 *  the task's own checkout. A rejected token pauses the tab behind a banner and
 *  dims the cards to what was last known. Polls while showing — request states
 *  change with no dashboard event to announce it. Design:
 *  docs/superpowers/specs/rivendell-tasks-tab.md, rivendell-channel.md, then
 *  .mystical/design-drafts/rivendell-reimagine/ (A · INBOX), then
 *  rivendell-tab-v3/a-flat.html (A · IN FLIGHT, flat). */
export function RivendellTasks({ project, sessions, onOpenSession, onWorkOn }: {
  project: string | null;
  /** the dashboard's sessions, to find the one working each MOVING task */
  sessions: SessionBrief[];
  onOpenSession: (id: string) => void;
  /** A new session, `text` left in its composer (not sent): in `dir` (the
   *  task's own checkout, everywhere view) or else this project. */
  onWorkOn: (text: string, dir?: string | null) => void;
}) {
  // TEAM reads the same key (lib/queries). TanStack never stacks a poll on one still out, so a
  // slow Rivendell doesn't pile them up.
  const tasksKey = rail.rivendellTasks({ project: project ?? "" });
  const q = useQuery({ ...tasksKey, enabled: !!project, refetchInterval: (qq) => (qq.state.data?.everywhere ? EVERY_MS : POLL_MS) });
  const data = q.data ?? null;
  const fail = q.error?.message ?? null;
  const now = new Date(q.dataUpdatedAt || Date.now());
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
  const [laterOpen, setLaterOpen] = useState(() => localStorage.getItem(LATER_KEY) !== "closed");
  const [teamOpen, setTeamOpen] = useState(false);   // TEAM starts folded: the tab is about yours
  const [stored, setStored] = useState(() => readSkips(project));
  const cards = useRef(new Map<string, HTMLDivElement>());
  // TEST LINK on the TOKEN REJECTED banner: the connection being tested, and
  // what each test said.
  const [testing, setTesting] = useState("");
  const [tested, setTested] = useState<Record<string, string>>({});

  const load = () => reread(tasksKey.queryKey);
  // Once the list has shown a request, the list is the truth about it.
  useEffect(() => {
    if (!data) return;
    const listed = new Set(data.tasks.map((t) => t.implementation?.id));
    setQueued((qd) => Object.fromEntries(Object.entries(qd).filter(([, rid]) => !listed.has(rid))));
  }, [data]);

  // NEXT UP: read once per set of projects (and on ⟳), not on every poll — a
  // todolist changes when Rivendell regenerates it, not while you watch. The
  // first project with open items wins; a bridge without the route has none.
  const todos = useQueries({ queries: (data?.everywhere ? [] : data?.projects ?? []).map((p) => rail.rivendellTodolist({ instance_id: p.instance_id, project_id: p.id })) });
  const todo = todos.map((t) => t.data?.todolist).find((l) => l && l.items.length) ?? null;

  const unbusy = (id: string) => setBusy((b) => { const n = new Set(b); n.delete(id); return n; });

  function refresh() {
    setPeeks({});
    void reread([rail.rivendellTask.route]);
    void reread([rail.rivendellTodolist.route]);
    void load();
  }

  async function fetchPeek(t: RivendellTask): Promise<RivendellTaskDetail | null> {
    const id = key(t);
    setPeeks((m) => ({ ...m, [id]: { state: "loading" } }));
    try {
      const d = await queryClient.fetchQuery(rail.rivendellTask({ instance_id: t.instance_id, task_id: t.id }));
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

  // The panel is not remounted when the session's project changes: read that project's skips.
  useEffect(() => { setStored(readSkips(project)); }, [project]);

  function skip(t: RivendellTask) {
    const next = { sig: nextSig, at: { ...skips, [t.id]: Date.now() } };
    setStored(next);
    localStorage.setItem(`rv-skip:${project}`, JSON.stringify(next));
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
    } catch (e) {
      setErrs((m) => ({ ...m, [t.id]: (e as Error).message }));
    } finally {
      unbusy(t.id);
    }
  }

  async function workOn(t: RivendellTask) {
    const p = peeks[key(t)];
    onWorkOn(workPrompt(t, p?.state === "ok" ? p.d : await fetchPeek(t)), t.project_dir);
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
    } catch (e) {
      setTested((m) => ({ ...m, [iid]: `✕ ${(e as Error).message}` }));
    } finally {
      setTesting("");
    }
  }

  const projects = data?.projects ?? [];
  const links = data?.links ?? [];
  const names = [...new Set(projects.map((p) => p.name))].join(" · ") || links.map((l) => l.instance).join(" · ");
  // IMPLEMENT's request shows QUEUED (and groups as RUNNING) before the list has caught up with it.
  const yours = data?.everywhere;
  const tasks = (data?.tasks ?? []).filter((t) => !yours || t.mine || t.session_id).map((t) => queued[t.id] && t.implementation?.id !== queued[t.id]
    ? { ...t, implementation: { id: queued[t.id], status: "PENDING" as const, createdAt: now.toISOString(), completedAt: null } }
    : t);
  const g = groupTasks(tasks);
  // MOVING: running, finished with a PR to check (one without is just DONE), or In progress on the board.
  const review = g.done.filter((t) => resultBits(t.run?.result)?.pr);
  const boardMoving = [...g.mine, ...g.team].filter((t) => inProgress(t.column));
  const moving = [...g.running, ...review, ...boardMoving];
  const nextIds = nextUp(todo, new Set(tasks.map((t) => t.id)), 50).flatMap((i) => i.tasks);
  const nextSig = nextIds.join(",");
  const skips = liveSkips(stored, nextSig, now.getTime());
  const line = deck([...g.mine, ...g.team].filter((t) => !boardMoving.includes(t)), nextIds, skips, now.getTime());
  // UP NEXT is yours; in a linked repo the team's open tasks follow under TEAM.
  const queue = yours ? line : line.filter((t) => t.mine);
  const top = queue[0] ?? null;
  const projectNames = [...new Set(tasks.map((t) => t.projectName))];
  const dot = (t: RivendellTask) => yours && (
    <span title={t.projectName} style={{ width: 7, height: 7, borderRadius: 2, flex: "none", display: "inline-block",
      background: PROJECT_TONE[projectNames.indexOf(t.projectName) % PROJECT_TONE.length] }} />
  );
  const c = linkChip(links[0], now);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <TabKick name={yours ? "YOURS · EVERYWHERE" : names || "RIVENDELL"}
        chip={links.length > 0 && !yours && <span style={{ flex: "none", fontSize: "var(--t9)", letterSpacing: 1, padding: "0 6px", border: "1px solid currentColor", borderRadius: 8, whiteSpace: "nowrap", color: LINK_TONE[c.tone] }}>{c.label}</span>}
        tools={<>
          {!yours && projects[0]?.url && (
            <button className="gp-ib" title="Open the project in Rivendell" aria-label="Open the project in Rivendell"
              onClick={() => window.open(projects[0].url, "_blank", "noopener")}><ExternalLink size={13} aria-hidden /></button>
          )}
          <button className="gp-ib" title="refresh" aria-label="Refresh" onClick={refresh}><RefreshCw size={13} aria-hidden /></button>
        </>} />
      <div className="mscroll" style={{ flex: 1, minHeight: 0, padding: "4px 0 10px" }}>
        {body()}
      </div>
    </div>
  );

  function body(): ReactNode {
    // A dashboard built from newer code than the running bridge: the route is
    // missing, and the catch-all answers 404 "not found".
    if (fail === "not found") return <Empty title="The bridge needs a restart" text="This dashboard is newer than the running bridge, which can't list Rivendell tasks yet." />;
    if (fail) return <Empty title="Couldn't read the task list" text={fail} />;
    if (!data) return [100, 100, 60].map((w, i) => <div key={i} style={{ height: 30, margin: "8px 12px", width: `calc(${w}% - 24px)`, background: mix("var(--acc)", 7) }} />);
    if (data.slug === null && !yours) return <Empty title="No GitHub origin" text="This checkout has no GitHub origin remote, so there is no repo to look up in Rivendell." />;
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
    if (!projects.length && !yours) return <>{paused}<Empty title="No Rivendell project links this repo" text={<>Nothing in Rivendell links <code style={{ color: "var(--purple-h)" }}>{data.slug}</code>. Link it to a project there and its tasks show up here.</>} /></>;
    const here = (project ?? "").split("/").pop() || "This repo";
    const note = yours && (
      <div style={{ margin: "2px 12px 4px", fontSize: "var(--t95)", lineHeight: 1.45, color: "var(--txl)" }}>
        <b style={{ color: "var(--txm)" }}>{here}</b> isn't on a board. Starting a task opens its own repo.
      </div>
    );
    if (!tasks.length) return <>{paused}{note}<Empty icon={<ListTodo size={26} strokeWidth={1.3} />} title={yours ? "Nothing is yours" : "No open tasks"}
      text={yours ? "No open task in any Rivendell project is assigned to you." : `Every task of ${names} is done.`} /></>;
    const last = data.tasks.some((t) => t.stale) ? " · LAST KNOWN" : "";
    const targets = [...new Set(g.later.map((t) => splitTitle(t.name).later))];
    const laterLabel = targets.length === 1 && targets[0] !== "later" ? `LATER · ${targets[0]!.toUpperCase()}` : "LATER";
    // Todolist items that name no open task but a Sentry issue: FIX IT, as before.
    const sentry = nextUp(todo, new Set(tasks.map((t) => t.id))).filter((i) => !i.tasks.length && i.sentry);
    const needs = [...g.needs, ...g.failed];
    const quiet = g.done.filter((t) => !review.includes(t));
    const team = yours ? [] : line.filter((t) => !t.mine);
    return (
      <>
        {paused}
        {data.errors.filter((e) => e.error !== "token_rejected").map((e) => (
          <div key={e.instance_id} style={{ margin: "6px 12px 0", fontSize: "var(--t9)", color: "var(--warn)" }}>⚠ {e.instance}: {e.detail}</div>
        ))}
        {note}
        {needs.length > 0 && <Section label="◆ NEEDS YOU" n={needs.length} color="var(--warn)" />}
        {needs.map((t) => cardView(t))}
        {moving.length > 0 && <Section label={`● Moving${last}`} n={moving.length} />}
        {moving.map(movingView)}
        {(queue.length > 0 || sentry.length > 0) && <Section label={`▶ Up next${last}`} n={queue.length} />}
        {queue.map((t, i) => cardView(t, { row: true, num: i + 1 }))}
        {sentry.map((i) => (
          <div key={i.id} className="dk-then" style={{ cursor: "default" }}>
            <span title={i.title}>{i.title}</span>
            <Btn tone="ghost" onClick={() => onWorkOn(sentryPrompt(i.title, i.sentry!))} title={`Work on ${i.sentry!.label ?? "the Sentry issue"} in a new session`}>FIX IT</Btn>
          </div>
        ))}
        {team.length > 0 && <Section label={`TEAM${last}`} n={team.length} onClick={() => setTeamOpen(!teamOpen)} chev={teamOpen ? "▾" : "▸"} />}
        {teamOpen && team.map((t) => cardView(t, { row: true }))}
        {quiet.length > 0 && <Section label={`DONE${last}`} n={quiet.length} />}
        {quiet.map((t) => cardView(t, { row: true }))}
        {g.later.length > 0 && (
          <Section label={laterLabel} n={g.later.length} onClick={() => setLater(!laterOpen)} chev={laterOpen ? "▾" : "▸"} />
        )}
        {laterOpen && g.later.map((t) => cardView(t, { row: true, later: true }))}
      </>
    );
  }

  /** A MOVING task: its state, its title, and the session working it (open ›),
   *  or WORK ON IT when no session here carries it. */
  function movingView(t: RivendellTask): ReactNode {
    const req = t.implementation;
    const todos = req?.status === "IN_PROGRESS" ? t.run?.live?.todos ?? null : null;
    const pr = req?.status === "COMPLETED" ? resultBits(t.run?.result)?.pr ?? null : null;
    const s = taskSession(t, sessions);
    const [state, tone] = req?.status === "PENDING" ? ["Queued", "var(--acc)"]
      : req?.status === "IN_PROGRESS" ? [todos ? `Running · step ${todos.done} of ${todos.total}` : "Running", "var(--acc)"]
      : pr ? [`↑ ${pr.label}${pr.checks ? ` · ${pr.checks}` : ""}`, "var(--ok)"]
      : ["In progress", "var(--acc)"];
    const { code, title } = splitTitle(t.name);
    const link = { appearance: "none", cursor: "pointer", background: "none", border: 0, padding: 0, fontFamily: "inherit", fontSize: "var(--t95)", fontWeight: 700, color: "var(--acc)", flex: "none" } as const;
    return (
      <div key={key(t)} style={{ margin: "0 12px", padding: "4px 0 12px", opacity: t.stale ? 0.55 : 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: "var(--t85)", color: "var(--txl)" }}>
          {dot(t)}<span style={{ fontFamily: "var(--mono)" }}>{code || t.key}</span>
          <span className="caps" style={{ marginLeft: "auto", fontSize: "var(--t8)", letterSpacing: 1, color: tone }}>{state}</span>
        </div>
        <div title={t.name} style={{ marginTop: 4, fontSize: "var(--t11)", lineHeight: 1.4, color: "var(--txh)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{title}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 6, fontSize: "var(--t95)", color: "var(--txm)", minWidth: 0 }}>
          <span aria-hidden style={{ width: 6, height: 6, borderRadius: "50%", flex: "none", ...(s ? { background: pr ? "var(--ok)" : req ? "var(--acc)" : "var(--txm)" } : { border: "1.5px solid var(--txl)" }) }} />
          {s ? (
            <button type="button" onClick={() => onOpenSession(s.id)} title="Open the session" style={{ ...link, flex: 1, minWidth: 0, textAlign: "left", fontWeight: 400, color: "var(--txm)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {s.title || "Untitled session"}
            </button>
          ) : <span style={{ flex: 1, color: "var(--txl)" }}>No session on it here</span>}
          {todos && (
            <span aria-hidden style={{ display: "inline-flex", gap: 2, flex: "none" }}>
              {Array.from({ length: Math.min(todos.total, 12) }, (_, i) => (
                <span key={i} style={{ width: 9, height: 3, borderRadius: 1, background: i < todos.done ? "var(--acc)" : mix("var(--acc)", 22) }} />
              ))}
            </span>
          )}
          {pr ? <a href={pr.url} target="_blank" rel="noopener" style={{ ...link, textDecoration: "none" }}>Review PR ↗</a>
            : s ? <button type="button" style={link} onClick={() => onOpenSession(s.id)} aria-label="Open the session">›</button>
            : <button type="button" style={link} onClick={() => void workOn(t)} title="A new session, with this task in its composer">Work on it ›</button>}
        </div>
      </div>
    );
  }

  /** A task: a full card (NEEDS YOU), or a `row`, one 30px line that opens into
   *  the card. UP NEXT numbers its rows (`num`); #1 stands open with its actions. */
  function cardView(t: RivendellTask, o: { row?: boolean; num?: number; later?: boolean } = {}) {
    const { row: asRow = false, num, later = false } = o;
    const first = num === 1;
    const id = key(t);
    const req = t.implementation;
    const st = cardState({ implementation: req, session_id: t.session_id }, now);
    const due = dueLabel(t.dueDate, now);
    const working = busy.has(t.id);
    const frozen = !!t.stale;                 // last known: nothing new may start from it
    const on = hov === id;
    const isOpen = open === id;
    const isArmed = armed === id;
    const folded = asRow && !isOpen && !first;
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
      due && <span key="d" style={{ color: due.tone === "late" ? "var(--err)" : due.tone === "soon" ? "var(--warn)" : undefined }}>{due.text}</span>,
    ].filter(Boolean);
    const action = (label: ReactNode, run: () => void, tone: "primary" | "ghost" | "err" | "warn", off = false) =>
      <Btn tone={tone} off={working || off} onClick={run}>{working ? "…" : label}</Btn>;
    const row = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 8, minHeight: 25 } as const;
    const n = num != null && <span style={{ width: 14, flex: "none", textAlign: "right", fontFamily: "var(--mono)", fontSize: "var(--t85)", color: first ? "var(--acc)" : "var(--txg)" }}>{num}</span>;
    const pri = PRIORITY_TONE[t.priority ?? ""];
    const needsYou = !asRow && (!!ask || req?.status === "FAILED");
    return (
      <div
        key={id}
        ref={(el) => { if (el) cards.current.set(id, el); else cards.current.delete(id); }}
        onClick={() => toggle(t)}
        onMouseEnter={() => setHov(id)} onMouseLeave={() => setHov("")}
        style={{
          // Flat: no fills, no frames; only what asks you keeps a rule beside it.
          margin: needsYou ? "0 12px 8px" : "0 12px", padding: folded ? 0 : needsYou ? "6px 0 10px 10px" : "6px 0 10px", cursor: "pointer",
          minHeight: folded ? 30 : undefined, display: folded ? "flex" : undefined, alignItems: "center",
          borderLeft: needsYou ? `2px solid ${ask ? "var(--warn)" : "var(--err)"}` : undefined,
          opacity: frozen || (later && !isOpen) ? 0.55 : 1,
          animation: "mfadeup .35s ease backwards",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {folded ? (
              <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: "var(--t105)", lineHeight: 1.45, color: on ? "var(--txb)" : "var(--txh)" }}>
                {n}{dot(t)}
                {(code || t.key) && <span style={{ flex: "none", fontFamily: "var(--mono)", fontSize: "var(--t9)", color: "var(--txl)" }}>{code || t.key}</span>}
                <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</span>
                {due && due.tone && !on && <span style={{ flex: "none", fontSize: "var(--t9)", color: due.tone === "late" ? "var(--err)" : "var(--warn)" }}>{due.text}</span>}
                {pri && !on && <span title={`${t.priority} priority`} style={{ width: 3, height: 13, borderRadius: 2, flex: "none", background: pri }} />}
              </div>
            ) : (
              <>
                {(code || t.key || n) && (
                  <div style={{ display: "flex", alignItems: "center", gap: 7, fontFamily: "var(--mono)", fontSize: "var(--t85)", lineHeight: 1, color: "var(--txl)", marginBottom: 5 }}>
                    {n}{dot(t)}{code || t.key}
                  </div>
                )}
                <div style={{ fontSize: "var(--t115)", lineHeight: 1.45, color: isOpen ? "var(--txb)" : "var(--txh)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{title}</div>
              </>
            )}
          </div>
          {idle && !(later && folded) && !(folded && !on) && !isArmed && !frozen && !isOpen && !first && (
            // The ▶'s 22px is all the title ever gives up: under the pointer the
            // labelled button grows leftwards over the title's tail, so the
            // title never re-wraps on hover.
            <span style={{ position: "relative", flex: "none", width: 22, height: 22 }}>
              <span style={{ position: "absolute", top: 0, right: 0 }}>
                {on ? (
                  <Btn tone="primary" onClick={() => arm(t)} title="Implement it with AI — asks first"
                    style={{ height: 22, padding: "0 8px", background: "var(--panel)" }}>
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
        {first && !isOpen && !isArmed && (
          <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 9, cursor: "default" }}>
            {idle && !frozen && <Btn tone="primary" onClick={() => arm(t)} title="Implement it with AI — asks first"><Play size={9} strokeWidth={2.4} />Implement</Btn>}
            <Btn tone="ghost" onClick={() => void workOn(t)} title="A new session, with this task in its composer"><SquarePen size={10} strokeWidth={2.2} />Work on it</Btn>
            {queue.length > 1 && <Btn tone="ghost" onClick={() => skip(t)} title="Next task; this one comes back after a day">Skip ›</Btn>}
          </div>
        )}
        {isOpen && peekView(t, idle, frozen, href, isArmed)}
        {ask && (
          <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 9, cursor: "default" }}>
            <div style={{ fontSize: "var(--t9)", letterSpacing: 1.5, color: "var(--warn)" }}>
              ◆ ASKS{asked ? ` · ${asked === "now" ? "just now" : `${asked} ago`}` : ""}
            </div>
            <div style={{ marginTop: 5, fontSize: "var(--t105)", lineHeight: 1.5, color: "var(--txm)", fontStyle: "italic" }}>{ask.question}</div>
            {ask.simple && ask.options.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                {ask.options.map((o, i) => <span key={o}>{action(o, () => void answer(t, o), i === 0 ? "warn" : "ghost")}</span>)}
              </div>
            )}
          </div>
        )}
        {live && (
          <div style={{ marginTop: 8, fontSize: "var(--t9)" }}>
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
      <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 9, cursor: "default" }}>
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
    // Flat: no fills; only a card's main action (and RETRY) wears an outline.
    border: `1px solid ${tone === "ghost" ? "transparent" : tone === "solid" ? c : mix(c, strong ? 70 : 45)}`,
    background: "transparent",
    color: tone === "solid" ? "var(--txb)" : tone === "ghost" ? "var(--txm)" : c,
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
      background: "transparent", color: "var(--txm)", border: 0,
    }}>{children}</button>
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
      <span className="caps">{label}</span><span style={{ color: "var(--txg)" }}>{n}</span>
      {chev && <span style={{ marginLeft: "auto", color: "var(--txm)" }}>{chev}</span>}
    </div>
  );
}

function Empty({ title, text, icon, settings }: { title: string; text: ReactNode; icon?: ReactNode; settings?: boolean }) {
  return (
    <div style={{ padding: "26px 16px", display: "flex", flexDirection: "column", alignItems: "center", gap: 10, textAlign: "center" }}>
      <span style={{ color: "var(--txg)" }}>{icon ?? <RivendellIcon size={26} strokeWidth={1.3} />}</span>
      <div style={{ fontSize: "var(--t115)", color: "var(--txh)" }}>{title}</div>
      <div style={{ fontSize: "var(--t10)", lineHeight: 1.55, color: "var(--txl)", maxWidth: 240 }}>{text}</div>
      {settings && (
        <button onClick={() => openSettings("plugins")} style={{ ...toolBtn, fontSize: "var(--t9)", letterSpacing: 1, padding: "5px 10px" }}>
          SETTINGS ▸ INTEGRATIONS ›
        </button>
      )}
    </div>
  );
}
