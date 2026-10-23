import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, FolderOpen, Search, SquarePen, X } from "lucide-react";
import { api, needsYou, type SessionBrief, type SessionState } from "../lib/api";
import { useChat } from "../lib/chat";
import { FolderNavigator } from "./FolderNavigator";
import { SurfaceBadge } from "./SurfaceBadge";

function ago(sec: number | null): string {
  if (!sec) return "";
  const s = Math.max(0, Date.now() / 1000 - sec);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// The states you can act on sort first — blocked mid-turn, then ended on a
// question — and only then what is running.
const ORDER: Record<SessionState, number> = {
  awaiting: 0, asking: 1, working: 2, checking: 3, waiting: 4, parked: 5, live: 6, idle: 7,
};
const DOT: Record<SessionState, string> = {
  awaiting: "bg-amber-400", asking: "bg-amber-400/60", working: "bg-emerald-400",
  checking: "bg-emerald-400/60", waiting: "bg-fuchsia-300/70", parked: "bg-sky-400/60", live: "bg-sky-400",
  idle: "bg-[var(--tg-hint)]/40",
};

interface Row {
  id: string;
  title: string;
  label: string | null;
  state: SessionState;
  project: string | null; // set only for chats living in another project
  origin: string | null;
  job?: SessionBrief["job"];
  when: number | null;
}

function Dot({ state }: { state: SessionState }) {
  return (
    <span className="relative flex h-1.5 w-1.5 shrink-0">
      {state === "working" || state === "awaiting" ? (
        <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${DOT[state]}`} />
      ) : null}
      <span className={`inline-flex h-1.5 w-1.5 rounded-full ${DOT[state]}`} />
    </span>
  );
}

/** A repo's display name: its last path segment ("/org/app" → "app"). */
const nameOf = (rel: string) => rel.replace(/\/+$/, "").split("/").pop() || rel;

/** How many chats a project shows before SHOW ALL. */
const PAGE = 20;

/** The whole header identity control: which project, which chat, and every chat
 *  you could switch to — one button, one sheet.
 *
 *  The sheet is one decision, read top to bottom:
 *    search       a chat or a repo by name, across the machine
 *    the repos    a chip per git repo, last used first. A chip only changes
 *                 which repo's chats you are LOOKING at; nothing switches
 *                 until you open a chat or start one there.
 *    NEEDS YOU    machine-wide — the only chats blocked on you, so never hidden
 *    RUNNING      machine-wide
 *    CHATS        the looked-at repo's, newest first
 *    NEW CHAT IN  that repo, pinned under the list where the thumb is.
 *  It replaces a sheet that showed only the active repo's chats, where changing
 *  repo meant walking a folder tree to "Use this folder" — five taps and a
 *  reload of the wrong list before you could even see the other repo's chats.
 *  The folder walk stays, behind the last chip, for a folder that isn't a repo. */
export function ChatSwitcher() {
  const [open, setOpen] = useState(false);
  const { sessions, sessionId, selectSession, openSessionInProject, newChatIn } = useChat();
  // Both queries share the header's caches — no extra polling.
  const { data } = useQuery({
    queryKey: ["running"],
    queryFn: () => api.getRunning(),
    refetchInterval: 4000,
  });
  const { data: state } = useQuery({
    queryKey: ["state"],
    queryFn: () => api.getState(),
    refetchInterval: 5000,
  });
  const project = state?.project?.rel ?? null;
  const projectName = state?.project?.name ?? null;
  const status = data?.status ?? {};

  const current = sessions.find((s) => s.id === sessionId);
  const curState: SessionState = (sessionId && status[sessionId]?.state) || "idle";
  // The checkout this chat runs in — a worktree session is not on the repo's
  // current branch, and that difference is worth a word in the header.
  const branch = current?.branch ?? "";
  // Two worktrees can sit on one branch, so the branch alone doesn't say which
  // tree this chat is committing into. The name only shows for a linked one —
  // and only when it differs from the branch, or it just repeats it.
  const worktree = current?.worktree && current.worktree !== branch ? current.worktree : "";
  const waitingN = Object.values(status).filter((st) => needsYou(st.state)).length;
  const liveN = Object.values(status).filter((st) => st.state === "working" || st.state === "checking").length;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Project and chats"
        className="flex min-w-0 flex-1 items-center gap-2 px-1 py-1 text-left active:opacity-70"
      >
        <Dot state={curState} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="chead-title truncate text-[13px] font-semibold text-foreground-bright">
            {current?.title || "New chat"}
          </span>
          <span className="truncate text-[10px] tracking-wider text-[var(--tg-hint)]">
            {(projectName ?? "NO PROJECT").toUpperCase()}
            {branch ? ` · ${branch.toUpperCase()}` : ""}
            {worktree ? ` ⧉${worktree.toUpperCase()}` : ""}
            {liveN > 0 ? ` · ${liveN} LIVE` : ""}
            {waitingN > 0 ? ` · ${waitingN} WAITING` : ""}
          </span>
        </span>
        <ChevronDown size={13} className="shrink-0 text-[var(--tg-hint)]" aria-hidden />
      </button>

      {open && (
        <SwitchSheet
          project={project}
          sessionId={sessionId}
          liveSessions={sessions}
          status={status}
          onClose={() => setOpen(false)}
          onOpen={(row) => {
            setOpen(false);
            if (row.id === sessionId) return;
            if (row.project && row.project !== project) void openSessionInProject(row.project, row.id);
            else selectSession(row.id);
          }}
          onNew={(proj) => {
            setOpen(false);
            void newChatIn(proj);
          }}
        />
      )}
    </>
  );
}

function SwitchSheet({
  project, sessionId, liveSessions, status, onClose, onOpen, onNew,
}: {
  project: string | null;
  sessionId: string | null;
  liveSessions: SessionBrief[];
  status: Record<string, { state: SessionState; label?: string | null }>;
  onClose: () => void;
  onOpen: (row: Row) => void;
  onNew: (project: string) => void;
}) {
  const [q, setQ] = useState("");
  const [viewed, setViewed] = useState<string | null>(project);
  const [folders, setFolders] = useState(false);
  const [all, setAll] = useState(false);
  // Every chat on the machine, for the other repos and for search. The active
  // repo's own list (liveSessions) is fresher — it has a chat minted a second
  // ago — so it wins where both have one.
  const hist = useQuery({ queryKey: ["history", false], queryFn: () => api.getHistory(false) });
  const repos = useQuery({ queryKey: ["projects", ""], queryFn: () => api.getProjects("") });

  const rows = useMemo(() => {
    const by = new Map<string, Row>();
    for (const s of hist.data?.sessions ?? []) {
      // A chat that never ran is an abandoned draft: a list of "New chat" rows
      // is noise between the chats you'd actually go back to. The open one and
      // anything live still show.
      if (!s.turn_count && s.id !== sessionId && (status[s.id]?.state ?? "idle") === "idle") continue;
      by.set(s.id, {
        id: s.id, title: s.title || "New chat", label: status[s.id]?.label ?? null,
        state: status[s.id]?.state ?? "idle", project: s.project, origin: s.origin ?? null,
        when: s.last_activity || s.updated,
      });
    }
    const drafts = new Set((hist.data?.sessions ?? []).filter((s) => !s.turn_count).map((s) => s.id));
    for (const s of liveSessions) {
      const was = by.get(s.id);
      if (!was && drafts.has(s.id)) continue;
      by.set(s.id, {
        id: s.id, title: s.title || "New chat", label: status[s.id]?.label ?? null,
        state: status[s.id]?.state ?? "idle", project: s.project || project, origin: s.origin ?? null,
        job: s.job ?? null, when: Math.max(s.updated, was?.when ?? 0),
      });
    }
    return [...by.values()].sort((a, b) => ORDER[a.state] - ORDER[b.state] || (b.when ?? 0) - (a.when ?? 0));
  }, [hist.data, liveSessions, status, project, sessionId]);

  // Repos: the ones with chats, last used first, then every other git repo by
  // name. The active one is always there, even with no chat yet.
  const projects = useMemo(() => {
    const last = new Map<string, number>();
    for (const r of rows) if (r.project) last.set(r.project, Math.max(last.get(r.project) ?? 0, r.when ?? 0));
    if (project && !last.has(project)) last.set(project, Infinity);
    const used = [...last.keys()].sort((a, b) => (last.get(b) ?? 0) - (last.get(a) ?? 0));
    const rest = (repos.data?.projects ?? []).filter((p) => !last.has(p)).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    return [...used, ...rest];
  }, [rows, repos.data, project]);

  const needle = q.trim().toLowerCase();
  const hit = (r: Row) => r.title.toLowerCase().includes(needle) || (r.project ?? "").toLowerCase().includes(needle);
  const shownRepos = needle ? projects.filter((p) => p.toLowerCase().includes(needle)) : projects;
  const blocked = rows.filter((r) => needsYou(r.state));
  const running = rows.filter((r) => r.state === "working" || r.state === "checking" || r.state === "live" || r.state === "parked" || r.state === "waiting");
  const here = rows.filter((r) => r.project === viewed && !blocked.includes(r) && !running.includes(r));
  const found = needle ? rows.filter(hit) : [];
  const waitingIn = (p: string) => blocked.filter((r) => r.project === p).length;

  function Section({ label, tone, list, cap }: { label: string; tone?: "warn"; list: Row[]; cap?: boolean }) {
    if (!list.length) return null;
    const shown = cap && !all ? list.slice(0, PAGE) : list;
    return (
      <div className="space-y-1.5">
        <div className={`sw-label ${tone === "warn" ? "text-amber-400" : ""}`}>{label}</div>
        {shown.map((r) => (
          <ChatRow key={r.id} r={r} on={r.id === sessionId} other={r.project !== viewed} onOpen={onOpen} />
        ))}
        {cap && !all && list.length > PAGE && (
          <button type="button" onClick={() => setAll(true)} className="sw-more">
            Show all {list.length}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="sw-sheet fixed inset-0 z-50 flex flex-col bg-[var(--tg-bg)]" role="dialog" aria-modal="true" aria-label="Project and chats">
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <label className="sw-search flex min-w-0 flex-1 items-center gap-2">
          <Search size={15} className="shrink-0 text-[var(--tg-hint)]" aria-hidden />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search chats and repos"
            className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-[var(--tg-hint)]"
          />
          {q && (
            <button type="button" onClick={() => setQ("")} aria-label="Clear search" className="p-1 text-[var(--tg-hint)]">
              <X size={14} />
            </button>
          )}
        </label>
        <button type="button" onClick={onClose} aria-label="Close" className="sw-close">
          <X size={18} />
        </button>
      </div>

      {/* The repos. A chip shows that repo's chats below; it doesn't switch. */}
      <div className="sw-repos flex gap-1.5 overflow-x-auto px-3 pb-2.5">
        {shownRepos.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => { setViewed(p); setAll(false); setFolders(false); setQ(""); }}
            aria-pressed={viewed === p && !needle}
            className="sw-chip"
            title={p}
          >
            {p === project && <span className="sw-here" aria-label="active repo" />}
            <span className="truncate">{nameOf(p)}</span>
            {waitingIn(p) > 0 && <span className="sw-badge">{waitingIn(p)}</span>}
          </button>
        ))}
        {!needle && (
          <button type="button" onClick={() => setFolders((v) => !v)} aria-pressed={folders} className="sw-chip sw-chip-ghost">
            <FolderOpen size={13} aria-hidden /> Other folder…
          </button>
        )}
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-3 pb-3 pt-1">
        {folders && !needle && (
          <FolderNavigator onSelected={() => { setFolders(false); onClose(); }} />
        )}
        {needle ? (
          found.length ? (
            <Section label={`${found.length} MATCHING`} list={found} />
          ) : (
            <div className="pt-8 text-center text-sm text-[var(--tg-hint)]">
              No chat matches “{q.trim()}”.{shownRepos.length ? " Tap a repo above to see its chats." : ""}
            </div>
          )
        ) : (
          <>
            <Section label={`NEEDS YOU · ${blocked.length}`} tone="warn" list={blocked} />
            <Section label={`RUNNING · ${running.length}`} list={running} />
            {viewed && (here.length ? (
              <Section label={`CHATS · ${nameOf(viewed).toUpperCase()}`} list={here} cap />
            ) : hist.isLoading ? (
              <div className="pt-4 text-center text-sm text-[var(--tg-hint)]">Loading…</div>
            ) : (
              <div className="sw-empty">
                No chats in <b>{nameOf(viewed)}</b> yet.
              </div>
            ))}
          </>
        )}
      </div>

      {viewed && !needle && (
        <div className="sw-foot px-3 pb-3 pt-2">
          <button type="button" onClick={() => onNew(viewed)} className="sw-new">
            <SquarePen size={15} aria-hidden />
            <span className="truncate">New chat in {nameOf(viewed)}</span>
          </button>
        </div>
      )}
    </div>
  );
}

function ChatRow({ r, on, other, onOpen }: { r: Row; on: boolean; other: boolean; onOpen: (r: Row) => void }) {
  const waiting = needsYou(r.state);
  return (
    <button
      type="button"
      onClick={() => onOpen(r)}
      className="sw-row flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
      data-on={on ? "" : undefined}
      data-wait={waiting ? "" : undefined}
    >
      <Dot state={r.state} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-[var(--txb)]">{r.title}</div>
        <div className="truncate text-[11px] text-[var(--tg-hint)]">
          {other && r.project ? <span className="sw-proj">{nameOf(r.project)}</span> : null}
          {other && r.project ? " · " : ""}
          {r.label ?? ago(r.when)}
        </div>
      </div>
      <SurfaceBadge origin={r.origin} job={r.job} />
      {on ? (
        <span className="sw-tag">OPEN</span>
      ) : waiting ? (
        <span className="sw-tag sw-tag-warn">ANSWER →</span>
      ) : null}
    </button>
  );
}
