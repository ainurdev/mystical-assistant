import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  BellRing, ChevronDown, ChevronLeft, ChevronRight, FolderOpen, FolderTree, History, Plus, Puzzle, Search, SquarePen, X,
} from "lucide-react";
import { rootRoute } from "./root";
import { api, type ProjectMark, type SessionBrief, type SessionState } from "../lib/api";
import { useChat } from "../lib/chat";
import { usePersistentState } from "../lib/persistentState";
import { telegramBack } from "../lib/telegram";
import { FolderNavigator } from "../components/FolderNavigator";
import { SurfaceBadge } from "../components/SurfaceBadge";
import { Skeleton } from "../components/ui";

/* CHATS — the dashboard's sidebar as a screen of its own (its
   components/hud/SessionsPanel). The header's title opens it and back returns
   to the chat you were in; the bottom bar's CHATS tab is the same screen.

   The same four views as the desktop, one tap apart:
     ATTENTION  every chat in lanes by what it needs: NEEDS YOU, WORKING,
                WAITING, PARKED, then the idle tail
     PROJECTS   each repo with its chats, newest started first, a + to start one
     PLUGINS    Rivendell's jobs, teammates' runs and shares (when there are any)
     HISTORY    every chat, last used first, and the archive
   Nothing here switches the bridge until you open a chat or start one: the
   rows open in their own repo (openSessionInProject), and a project's + mints
   the chat there first (newChatIn).

   It replaced a sheet that listed one repo's chats behind a folder walk, and
   then a chip-row picker; both were a second, smaller copy of what the
   dashboard already lays out well. */

type Mode = "attention" | "projects" | "plugins" | "history";
type Lane = "ask" | "work" | "wait" | "parked" | "idle";

const LANES: { k: Lane; label: string; tint: string }[] = [
  { k: "ask", label: "NEEDS YOU", tint: "var(--warn)" },
  { k: "work", label: "WORKING", tint: "var(--ok)" },
  { k: "wait", label: "WAITING", tint: "var(--purple)" },
  { k: "parked", label: "PARKED", tint: "var(--info)" },
  { k: "idle", label: "IDLE", tint: "var(--txd)" },
];

/** Server state → lane, dot colour, filled? — the dashboard's grammar: a
 *  filled dot is something happening, a ring is at rest. */
const SV: Record<SessionState, { lane: Lane; c: string; fill: boolean; t: string }> = {
  working: { lane: "work", c: "var(--ok)", fill: true, t: "working" },
  checking: { lane: "work", c: "var(--ok)", fill: true, t: "checking your prompt" },
  awaiting: { lane: "ask", c: "var(--warn)", fill: true, t: "waiting on your answer" },
  asking: { lane: "ask", c: "var(--warn)", fill: true, t: "asking you a question" },
  live: { lane: "idle", c: "var(--info)", fill: false, t: "live in another window" },
  parked: { lane: "parked", c: "var(--info)", fill: true, t: "parked — resumes on its own" },
  waiting: { lane: "wait", c: "var(--purple)", fill: true, t: "waiting on another session" },
  idle: { lane: "idle", c: "var(--txl)", fill: false, t: "" },
};

const IDLE_CAP = 8; // ATTENTION's idle tail, folded
const PROJ_ROWS = 3; // a project's chats before "N more"
const HIST_CAP = 40; // HISTORY rows before "show more"

/** When a chat was started: rows hold their place while turns start and end
 *  (the dashboard's sidebar sorts the same way). Older payloads lack it. */
const start = (s?: SessionBrief) => (s ? s.created ?? s.updated : 0);
const byStart = (a: SessionBrief, b: SessionBrief) => start(b) - start(a);

/** A chat a plugin or a teammate brought, not one of yours (PLUGINS). */
const isPlugin = (s: SessionBrief) =>
  !!s.job || /^(rivendell|team:|device:)/.test(s.origin ?? "");

const PROJ_PALETTE = [
  "var(--acc)", "var(--purple)", "var(--ok)", "var(--info)", "var(--warn)", "var(--err)",
  "color-mix(in srgb, var(--purple), var(--err))",
  "color-mix(in srgb, var(--ok), var(--info))",
  "color-mix(in srgb, var(--warn), var(--err))",
  "color-mix(in srgb, var(--info), var(--purple))",
  "color-mix(in srgb, var(--ok), var(--warn))",
  "color-mix(in srgb, var(--acc), var(--purple))",
];
const dirName = (rel: string) => rel.replace(/\/+$/, "").split("/").pop() || rel || "proj";
/** The dashboard's hashed project colour (lib/surfaces hashTint), so a repo
 *  wears the same colour on both surfaces. */
function hashTint(rel: string): string {
  const base = dirName(rel);
  let h = 0;
  for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) >>> 0;
  return PROJ_PALETTE[h % PROJ_PALETTE.length];
}
function initials(name: string): string {
  const w = name.split(/[\s/_.-]+/).filter(Boolean);
  return (w.length > 1 ? w[0][0] + w[1][0] : (w[0] ?? "?").slice(0, 2)).toUpperCase();
}

function ago(sec: number | null | undefined): string {
  if (!sec) return "";
  const s = Math.max(0, Date.now() / 1000 - sec);
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** A project's tile: its logo, or its initials on its colour. */
function Tile({ rel, name, mark }: { rel: string; name: string; mark?: ProjectMark }) {
  const [src, setSrc] = useState<string | null>(null);
  const logo = mark?.kind === "logo" ? mark.logo : undefined;
  useEffect(() => {
    if (!logo) return;
    let on = true;
    api.projectLogo(logo).then((u) => on && setSrc(u)).catch(() => {});
    return () => { on = false; };
  }, [logo]);
  const pc = mark?.color || hashTint(rel);
  return (
    <b className="sb-tile" aria-hidden data-logo={src ? "" : undefined} style={{ "--pc": pc } as CSSProperties}>
      {src ? <img src={src} alt="" draggable={false} /> : initials(name)}
    </b>
  );
}

function ChatsPage() {
  const navigate = useNavigate();
  const { sessionId, selectSession, openSessionInProject, newChatIn } = useChat();
  const [mode, setMode] = usePersistentState<Mode>("ma-side-mode", "projects");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set()); // projects showing every chat
  const [idleAll, setIdleAll] = useState(false);
  const [histAll, setHistAll] = useState(false);
  const [archived, setArchived] = useState(false);
  const [adding, setAdding] = useState(false);

  const all = useQuery({ queryKey: ["sessions-all"], queryFn: () => api.listAllSessions(), refetchInterval: 5000 });
  const arch = useQuery({ queryKey: ["history", true], queryFn: () => api.getHistory(true), enabled: archived });
  const running = useQuery({ queryKey: ["running"], queryFn: () => api.getRunning(), refetchInterval: 4000 });
  const repos = useQuery({ queryKey: ["projects", ""], queryFn: () => api.getProjects(""), staleTime: 60_000 });
  const { data: state } = useQuery({ queryKey: ["state"], queryFn: () => api.getState(), refetchInterval: 5000 });
  const active = state?.project?.rel ?? null;
  const status = running.data?.status ?? {};
  const names = repos.data?.names ?? {};
  const marks = repos.data?.marks ?? {};
  const hidden = new Set(repos.data?.hidden ?? []);
  const nameOf = (rel: string) => names[rel] || dirName(rel);

  // Back is the chat you came from: Telegram's own arrow, and the one here.
  const back = () => void navigate({ to: "/" });
  useEffect(() => telegramBack(back), []); // eslint-disable-line react-hooks/exhaustive-deps

  const view = (s: SessionBrief) => SV[status[s.id]?.state ?? "idle"] ?? SV.idle;
  // A chat that never ran has no title yet: an abandoned draft is noise in
  // every list but its own (the open one, or one that's somehow live).
  const sessions = useMemo(() => (all.data?.sessions ?? []).filter((s) =>
    s.title || s.id === sessionId || view(s).lane !== "idle"),
  [all.data, sessionId, status]); // eslint-disable-line react-hooks/exhaustive-deps

  const needle = q.trim().toLowerCase();
  const hit = (s: SessionBrief) => !needle
    || (s.title ?? "").toLowerCase().includes(needle)
    || (s.branch ?? "").toLowerCase().includes(needle)
    || nameOf(s.project).toLowerCase().includes(needle);
  const shown = sessions.filter(hit);
  const asks = sessions.filter((s) => view(s).lane === "ask").length;
  const plugins = sessions.filter(isPlugin);

  function openChat(s: SessionBrief) {
    if (s.id !== sessionId) {
      if (s.project && s.project !== active) void openSessionInProject(s.project, s.id);
      else selectSession(s.id);
    }
    back();
  }
  function newIn(rel: string) {
    void newChatIn(rel);
    back();
  }

  const row = (s: SessionBrief, showProj: boolean) => (
    <Row key={s.id} s={s} v={view(s)} on={s.id === sessionId} proj={showProj ? nameOf(s.project) : ""}
      tint={marks[s.project]?.color || hashTint(s.project)} label={status[s.id]?.label ?? null} onOpen={openChat} />
  );

  // ---- PROJECTS: each repo with its chats, newest started first.
  const groups = useMemo(() => {
    const by = new Map<string, SessionBrief[]>();
    for (const s of shown) {
      if (isPlugin(s) || hidden.has(s.project)) continue;
      by.set(s.project, [...(by.get(s.project) ?? []), s]);
    }
    for (const list of by.values()) list.sort(byStart);
    // the active repo heads the list even with nothing in it yet
    if (active && !needle && !by.has(active)) by.set(active, []);
    return [...by.entries()].sort((a, b) =>
      (a[0] === active ? -1 : b[0] === active ? 1 : 0) || start(b[1][0]) - start(a[1][0]));
  }, [shown, active, needle, hidden]);

  const TABS: { k: Mode; icon: typeof BellRing; label: string; n?: number }[] = [
    { k: "attention", icon: BellRing, label: "Attention", n: asks },
    { k: "projects", icon: FolderTree, label: "Projects" },
    ...(plugins.length ? [{ k: "plugins" as Mode, icon: Puzzle, label: "Plugins" }] : []),
    { k: "history", icon: History, label: "History" },
  ];
  const m: Mode = mode === "plugins" && !plugins.length ? "projects" : mode;

  return (
    <div className="sb pb-6">
      <div className="sb-top">
        <button type="button" onClick={back} className="sb-back" aria-label="Back to the chat">
          <ChevronLeft size={18} aria-hidden />
          <span>Chat</span>
        </button>
        <span className="sb-word glow"><b>Mystical</b> Assistant</span>
      </div>

      <div className="sb-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.k} type="button" role="tab" aria-selected={m === t.k} aria-label={t.label} onClick={() => setMode(t.k)}>
            <t.icon size={16} aria-hidden />
            {t.n ? <span className="sb-n">{t.n}</span> : null}
          </button>
        ))}
      </div>

      <label className="sb-search">
        <Search size={14} aria-hidden />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, branch or project" />
        {q && <button type="button" onClick={() => setQ("")} aria-label="Clear search"><X size={14} /></button>}
      </label>

      {all.isLoading ? (
        <div className="space-y-2 pt-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : m === "projects" ? (
        <div className="space-y-4">
          {!needle && (
            <button type="button" className="sb-add" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>
              <Plus size={15} aria-hidden /> Add project
            </button>
          )}
          {adding && !needle && (
            <AddProject repos={(repos.data?.projects ?? []).filter((r) => !hidden.has(r) && !groups.some(([g]) => g === r))}
              nameOf={nameOf} marks={marks} onPick={newIn} onFolder={() => { setAdding(false); back(); }} />
          )}
          {groups.map(([rel, list]) => {
            const full = open.has(rel) || !!needle;
            // the open chat stays in view in its project, folded or not
            // the newest few, plus any chat that isn't idle: a busy one started
            // long ago would otherwise sit behind "N more" (the dashboard's rule)
            const head = full ? list : list.filter((s, i) => i < PROJ_ROWS || view(s).lane !== "idle");
            const cur = list.find((s) => s.id === sessionId);
            const rows = cur && !head.includes(cur) ? [...head, cur] : head;
            const more = list.length - rows.length;
            return (
              <section key={rel} className="sb-proj">
                <div className="sb-phead">
                  <Tile rel={rel} name={nameOf(rel)} mark={marks[rel]} />
                  <span className="sb-pname">{nameOf(rel)}</span>
                  {rel === active && <span className="sb-active" title="active project">active</span>}
                  <button type="button" className="sb-pnew" onClick={() => newIn(rel)} aria-label={`New chat in ${nameOf(rel)}`}>
                    <SquarePen size={15} aria-hidden />
                  </button>
                </div>
                <div className="sb-rail">
                  {rows.map((s) => row(s, false))}
                  {!list.length && <div className="sb-none">No chats yet — the pen starts one.</div>}
                  {more > 0 && (
                    <button type="button" className="sb-more" onClick={() => setOpen((o) => new Set(o).add(rel))}>
                      {more} more <ChevronDown size={12} aria-hidden />
                    </button>
                  )}
                  {open.has(rel) && list.length > PROJ_ROWS && !needle && (
                    <button type="button" className="sb-more" onClick={() => setOpen((o) => { const n = new Set(o); n.delete(rel); return n; })}>
                      show fewer
                    </button>
                  )}
                </div>
              </section>
            );
          })}
          {needle && !groups.length && <Empty>No chat matches “{q.trim()}”.</Empty>}
        </div>
      ) : m === "attention" ? (
        <div className="space-y-4">
          {!asks && !needle && <Empty>Nothing needs you right now.</Empty>}
          {LANES.map((l) => {
            const list = shown.filter((s) => view(s).lane === l.k).sort(byStart);
            if (!list.length) return null;
            const cap = l.k === "idle" && !idleAll && !needle ? list.slice(0, IDLE_CAP) : list;
            return (
              <section key={l.k}>
                <div className="sb-lane" style={{ "--lt": l.tint } as CSSProperties}>
                  {l.label} <span>{list.length}</span>
                </div>
                <div className="space-y-px">{cap.map((s) => row(s, true))}</div>
                {cap.length < list.length && (
                  <button type="button" className="sb-more" onClick={() => setIdleAll(true)}>
                    {list.length - cap.length} more <ChevronDown size={12} aria-hidden />
                  </button>
                )}
              </section>
            );
          })}
        </div>
      ) : m === "plugins" ? (
        <div className="space-y-px">
          {plugins.filter(hit).sort(byStart).map((s) => row(s, true))}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="sb-seg" role="group" aria-label="Which chats">
            <button type="button" aria-pressed={!archived} onClick={() => setArchived(false)}>Recent</button>
            <button type="button" aria-pressed={archived} onClick={() => setArchived(true)}>Archived</button>
          </div>
          {archived ? (
            arch.isLoading ? <Skeleton className="h-12 w-full" /> : (
              <div className="space-y-px">
                {(arch.data?.sessions ?? []).filter((s) => !needle || (s.title ?? "").toLowerCase().includes(needle)).map((s) => (
                  <Row key={s.id} s={{ ...s, title: s.title } as SessionBrief} v={SV.idle} on={s.id === sessionId}
                    proj={nameOf(s.project)} tint={hashTint(s.project)} label={null}
                    onOpen={(x) => openChat({ ...x, project: s.project })} />
                ))}
                {!arch.data?.sessions.length && <Empty>Nothing archived.</Empty>}
              </div>
            )
          ) : (
            <div className="space-y-px">
              {[...shown].sort((a, b) => b.updated - a.updated).slice(0, histAll || needle ? undefined : HIST_CAP).map((s) => row(s, true))}
              {!histAll && !needle && shown.length > HIST_CAP && (
                <button type="button" className="sb-more" onClick={() => setHistAll(true)}>
                  {shown.length - HIST_CAP} more <ChevronDown size={12} aria-hidden />
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="sb-empty">{children}</div>;
}

/** One chat: its state dot, title, and where it is — project (in the lanes,
 *  which mix repos), branch, worktree — with how long since it moved. */
function Row({ s, v, on, proj, tint, label, onOpen }: {
  s: SessionBrief; v: (typeof SV)[SessionState]; on: boolean; proj: string; tint: string;
  label: string | null; onOpen: (s: SessionBrief) => void;
}) {
  const wt = s.worktree && s.worktree !== s.branch ? s.worktree : "";
  return (
    <button type="button" className="sb-row" data-on={on ? "" : undefined} onClick={() => onOpen(s)}
      style={{ "--pc": tint } as CSSProperties}>
      <span className="sb-dot" data-work={v.lane === "work" ? "" : undefined}
        style={{ background: v.fill ? v.c : "transparent", borderColor: v.c }} title={v.t} />
      <span className="min-w-0 flex-1">
        <span className="sb-title">{s.title || "New chat"}</span>
        <span className="sb-meta">
          {proj && <span className="sb-mproj">{proj}</span>}
          {s.branch && <span>⎇ {s.branch.split("/").pop()}</span>}
          {wt && <span>⧉ {wt}</span>}
          {label && v.lane !== "idle" && <span className="sb-mlabel">{label}</span>}
        </span>
      </span>
      <SurfaceBadge origin={s.origin ?? null} job={s.job ?? null} />
      <span className="sb-ago">{on ? "open" : ago(s.updated)}</span>
    </button>
  );
}

/** ADD PROJECT: the git repos with no chat yet — a tap starts one there — and
 *  the folder walk for a folder that isn't a repo. */
function AddProject({ repos, nameOf, marks, onPick, onFolder }: {
  repos: string[]; nameOf: (r: string) => string; marks: Record<string, ProjectMark>;
  onPick: (rel: string) => void; onFolder: () => void;
}) {
  const [folders, setFolders] = useState(false);
  return (
    <div className="sb-addbox">
      {repos.length ? (
        <div className="space-y-px">
          {[...repos].sort((a, b) => nameOf(a).localeCompare(nameOf(b))).map((r) => (
            <button key={r} type="button" className="sb-arow" onClick={() => onPick(r)}>
              <Tile rel={r} name={nameOf(r)} mark={marks[r]} />
              <span className="min-w-0 flex-1 truncate">{nameOf(r)}</span>
              <span className="sb-ago">{r}</span>
              <ChevronRight size={14} aria-hidden />
            </button>
          ))}
        </div>
      ) : (
        <div className="sb-none">Every repo here already has a chat.</div>
      )}
      <button type="button" className="sb-more" onClick={() => setFolders((v) => !v)} aria-expanded={folders}>
        <FolderOpen size={13} aria-hidden /> A folder that isn't a repo…
      </button>
      {folders && <FolderNavigator onSelected={onFolder} />}
    </div>
  );
}

export const chatsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chats",
  component: ChatsPage,
});
