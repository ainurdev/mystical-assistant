import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, CircleDot, CloudUpload, Ellipsis, FileDiff, LoaderCircle, Minus,
  Plus, RefreshCw, RotateCcw, SquarePen, TriangleAlert, X,
} from "lucide-react";
import { api, type GitFile, type GitStatus } from "../../api";
import { CommitGraph } from "../CommitGraph";
import { ContextMenu, type CtxItem } from "./ContextMenu";
import { askConfirm } from "../ui/Ask";
import { FileIcon } from "../../lib/fileicon";
import { Skeleton } from "../ui";
import { useLoadingPhase } from "../../lib/loadingPhase";
import { draftKey, patchDraft, useDraft, watched } from "../../lib/commitdraft";
import { useAiFeatures } from "../../lib/ai";
import { useStickyFlag } from "../../lib/prefs";
import { notify } from "./Notifications";
import { syncOf } from "../../lib/gitsync";
import { divergedDraft, pushFailedDraft } from "../../lib/pushfailed";
import { ago } from "../../lib/surfaces";

/* GIT — the right rail's one git tab, and the dashboard's only git status
   (the header's git icon went, 2026-10-18): a repo header (branch, ⟳ fetch),
   a readout (to push / to pull / changed, how fresh that is, and the one move
   the state allows), then two folds in VS Code's Source Control shape.
   CHANGES is the working tree with the commit box; GRAPH is the commit graph
   (CommitGraph). Each fold remembers whether it is open.
   The working tree comes from App's per-worktree status poll (sessionGit), so
   the header, the rail badge and the list read the same answer; an op here
   bumps that poll (onGitChanged) instead of running a second one. The commit
   box lives outside this component (lib/commitdraft.ts): the rail rebuilds
   the panel on every tab/session switch, and a GENERATE in flight outlives
   that. Styles under GIT TAB in index.css. */

interface Props {
  project: string | null;
  branch?: string;
  // App's status poll for this worktree; null until its first answer.
  git: GitStatus | null;
  // Re-read the status now — after a commit, a stage, a push.
  onGitChanged: () => void;
  // `changed` lands a dirty file in the editor's diff view, not the file.
  onOpenFile: (path: string, changed: boolean) => void;
  // Bring this panel back — its session, this tab. What a "commit message
  // ready" notification does when clicked, since by then the panel that asked
  // for the message is gone.
  onReveal?: () => void;
  // HANDLE IN A NEW SESSION: a session on the tree that needs it, the draft
  // (git's refusal, or a diverged branch) unsent. The project is named here,
  // not read at click time: this panel outlives a switch to another session.
  onHandOff?: (project: string, branch: string | null | undefined, draft: string) => void;
}

type OpKind = "push" | "publish" | "pull" | "fetch";
// The readout's sync op, in flight or just over: done shows a few seconds,
// failed stays with git's own words until dismissed or retried.
type Op = { kind: OpKind; n: number; phase: "busy" }
  | { kind: OpKind; n: number; phase: "done"; text: string }
  | { kind: OpKind; n: number; phase: "failed"; output: string; project: string; branch?: string };
const FAILED: Record<OpKind, string> = { push: "Push refused", publish: "Publish refused", pull: "Pull failed", fetch: "Fetch failed" };

const ST_COLOR = (s: string) => (s === "A" || s === "?" ? "var(--ok)" : s === "D" ? "var(--err)" : "var(--warn)");
const byPath = (a: GitFile, b: GitFile) => a.path.localeCompare(b.path);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const MOD = /Mac|iP/.test(navigator.platform) ? "⌘" : "Ctrl+";

/* A switch to another worktree rebuilds this panel (RightPanel's scope), so
   the parts that would jump keep their last size out here, by name: the new
   panel glides from the old one's size to its own instead of snapping, and
   while its tree's first status is on the way it holds that size, so a first
   visit moves once, when the answer lands, not out and back in. */
const SIZES = new Map<string, number>();
function useGlide<T extends HTMLElement>(name: string, axis: "height" | "width", hold: boolean, deps: unknown[]) {
  const ref = useRef<T>(null);
  // Every size the part takes, a glide's frames included, so the next glide
  // starts from what is on screen.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { if (el.isConnected) SIZES.set(name, el.getBoundingClientRect()[axis]); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [name, axis]);
  const ran = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Only a panel that replaced another one (RightPanel's data-swap) starts
    // from the last one's size; opened from the rail, it slides in as it is.
    const carry = ran.current || !!el.closest("[data-swap]");
    ran.current = true;
    const running = el.getAnimations();
    const from = running.length ? el.getBoundingClientRect()[axis] : carry ? SIZES.get(name) : undefined;
    for (const a of running) a.cancel();
    el.style[axis] = hold && from !== undefined ? `${from}px` : "";
    el.style.overflow = hold ? "hidden" : "";
    if (hold || from === undefined) return;
    const to = el.getBoundingClientRect()[axis];
    if (Math.abs(to - from) < 1 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.style.overflow = "hidden";
    const a = el.animate([{ [axis]: `${from}px` }, { [axis]: `${to}px` }], { duration: 280, easing: "cubic-bezier(.2,.8,.2,1)" });
    a.onfinish = () => { el.style.overflow = ""; };
    // A switch commits a whole transcript in this same task, and WebKit starts
    // the clock before that work is done; start it on the frame that draws it.
    requestAnimationFrame(() => { if (a.playState === "running") a.startTime = document.timeline.currentTime; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hold, ...deps]);
  return ref;
}

/* A figure that changes rolls to its new value, odometer-style: the old one
   leaves upward as the new one rises into its place. What each slot last
   showed outlives the rebuild too, so a switch rolls from the last tree's
   figures to this one's; null holds that figure while the status loads. */
const SHOWN = new Map<string, string>();
function Roll({ slot, v }: { slot: string; v: string | null }) {
  const ref = useRef<HTMLSpanElement>(null);
  const now = v ?? SHOWN.get(slot) ?? "";
  const [seen, setSeen] = useState<{ now: string; was?: string }>({ now });
  if (seen.now !== now) setSeen({ now, was: seen.now });
  // Mounted by a switch (useGlide's data-swap test): roll from the last tree's figure.
  useLayoutEffect(() => {
    const last = SHOWN.get(slot);
    if (last !== undefined && last !== now && ref.current?.closest("[data-swap]")) setSeen({ now, was: last });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (v !== null) SHOWN.set(slot, v); }, [slot, v]);
  const was = seen.was !== now ? seen.was : undefined;
  return (
    <span ref={ref} className="gp-roll">
      {was !== undefined && <span key={`${was}>${now}`} className="gp-roll-o" aria-hidden>{was}</span>}
      <span key={now} className={was !== undefined ? "gp-roll-i" : undefined}>{now}</span>
    </span>
  );
}

export function GitPanel({ project, branch, git, onGitChanged, onOpenFile, onReveal, onHandOff }: Props) {
  const files = git?.files ?? [];
  // A file is staged when the index half of porcelain's pair moved, and
  // unstaged when the working-tree half did. An old backend sends neither, so
  // everything reads as unstaged. A partially-staged file is in both lists,
  // because it really is.
  const staged = useMemo(
    () => files.filter((f) => (f.x ?? ".") !== "." && f.x !== "?").sort(byPath), [files]);
  const unstaged = useMemo(() => files.filter((f) => (f.y ?? "M") !== ".").sort(byPath), [files]);
  const changed = useMemo(() => new Map(files.map((f) => [f.path, f.status])), [files]);
  const key = draftKey(project, branch);
  const { msg, gen } = useDraft(key);
  const ai = useAiFeatures();   // GENERATE is hidden while commit messages are off
  const setMsg = (m: string) => patchDraft(key, { msg: m });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [op, setOp] = useState<Op | null>(null);
  // Right-clicked row (`staged` says which half, which decides Stage vs
  // Unstage), or the fold head's ⋯ with no path: the "all" actions alone.
  const [ctx, setCtx] = useState<{ x: number; y: number; path: string; staged: boolean } | null>(null);
  // Folds remember being closed — open is the default, so the flag is inverted.
  const [chClosed, setChClosed] = useStickyFlag("git-changes-closed");
  const [grClosed, setGrClosed] = useStickyFlag("git-graph-closed");
  const [branchOnly, setBranchOnly] = useStickyFlag("git-graph-branch-only");
  const [nonce, setNonce] = useState(0);   // the graph re-reads on ⟳
  const ready = git !== null;
  // A clean `git status` answers fast; useLoadingPhase keeps the placeholder
  // from strobing on and off inside one frame budget.
  const skel = useLoadingPhase(!ready);
  const branchName = git?.branch || branch || "";
  const ahead = git?.ahead ?? 0;
  const behind = git?.behind ?? 0;
  // Whatever can resize the readout, the CHANGES fold or the branch pill.
  const rdRef = useGlide<HTMLDivElement>("readout", "height", !ready, [git, op]);
  const chRef = useGlide<HTMLDivElement>("changes", "height", !ready, [git, note, chClosed, grClosed]);
  const brRef = useGlide<HTMLSpanElement>("branch", "width", false, [branchName]);

  async function commit() {
    if (!project || !msg.trim()) return;
    setBusy(true);
    try {
      const r = await api.gitCommit(project, msg.trim(), undefined, branch || undefined);
      setNote(r.ok ? "Committed." : r.output || "Commit failed.");
      if (r.ok) { setMsg(""); onGitChanged(); setNonce((n) => n + 1); }
    } catch (e) { setNote((e as Error).message); }
    finally { setBusy(false); }
  }

  const s = syncOf(git);
  useEffect(() => {
    if (op?.phase !== "done") return;
    const t = setTimeout(() => setOp(null), 4000);
    return () => clearTimeout(t);
  }, [op]);

  // The readout's one move: PUSH, PUBLISH (push() adds -u) or PULL (ff-only).
  async function sync(kind: "push" | "publish" | "pull", n: number) {
    if (!project) return;
    const to = s.kind === "ahead" || s.kind === "behind" ? s.upstream : "origin";
    setBusy(true);
    setOp({ kind, n, phase: "busy" });
    try {
      const r = kind === "pull" ? await api.gitPull(project, branch || undefined) : await api.gitPush(project, branch || undefined);
      setOp(r.ok
        ? { kind, n, phase: "done", text: kind === "pull" ? `Pulled ${plural(n, "commit")} from ${to}`
            : kind === "publish" ? `Published ${branchName} to origin` : `Pushed ${plural(n, "commit")} to ${to}` }
        : { kind, n, phase: "failed", output: r.output || `${FAILED[kind]}.`, project, branch });
    } catch (e) { setOp({ kind, n, phase: "failed", output: (e as Error).message, project, branch }); }
    finally { setBusy(false); onGitChanged(); setNonce((x) => x + 1); }
  }

  // ⟳ fetches first: behind, and the graph's remote rows, as of now.
  async function fetchNow() {
    if (!project) return;
    // No repo, or a bridge not restarted since /local/git/fetch (no fetched_at
    // key): a plain re-read, as ⟳ always was.
    if (s.kind === "none" || git?.fetched_at === undefined) { onGitChanged(); setNonce((x) => x + 1); return; }
    setBusy(true);
    setOp({ kind: "fetch", n: 0, phase: "busy" });
    try {
      const r = await api.gitFetch(project, branch || undefined);
      setOp(r.ok ? null : { kind: "fetch", n: 0, phase: "failed", output: r.output || "Fetch failed.", project, branch });
    } catch (e) { setOp({ kind: "fetch", n: 0, phase: "failed", output: (e as Error).message, project, branch }); }
    finally { setBusy(false); onGitChanged(); setNonce((x) => x + 1); }
  }

  /** Generate the commit message from what's about to be committed — the
   *  staged set once anything is staged, since that's what COMMIT will take.
   *  Runs to the end whether or not this panel is still on screen: the result
   *  goes to the store, and if nothing is showing this worktree's box by then,
   *  the bell says so and clicking it brings the panel back. */
  async function generate() {
    const paths = (staged.length ? staged : unstaged).map((f) => f.path);
    if (!project || !paths.length) return;
    patchDraft(key, { gen: true });
    setNote("");
    let message = "";
    let error = "";
    try {
      const r = await api.commitMessage(project, branch || "", paths);
      message = r.message ?? "";
      if (!message) error = r.error || "Couldn't write a message.";
    } catch (e) { error = (e as Error).message; }
    patchDraft(key, message ? { gen: false, msg: message } : { gen: false });
    if (error) notify("error", `Couldn't write a commit message — ${error}`, onReveal);
    else if (!watched(key)) notify("info", `Commit message ready — ${message.split("\n")[0]}`, onReveal);
  }

  async function gitOp(op: "stage" | "unstage" | "discard", paths: string[]) {
    if (!project || !paths.length) return;
    setBusy(true);
    try {
      const r = await api.gitOp(project, op, paths, branch || undefined);
      setNote(r.ok ? "" : r.output || `${op} failed.`);
    } catch (e) { setNote((e as Error).message); }
    finally { setBusy(false); onGitChanged(); }
  }

  // Discarding an untracked file deletes it: there is no commit to restore from.
  function discard(path: string, untracked: boolean) {
    void askConfirm(untracked
      ? `Delete ${path}? It was never committed, so there is nothing to restore.`
      : `Discard your changes to ${path}? This can't be undone.`)
      .then((yes) => { if (yes) void gitOp("discard", [path]); });
  }

  async function del(path: string) {
    if (!project) return;
    try {
      const r = await api.fileOp(project, "delete", path, undefined, branch || undefined);
      setNote(r.ok ? "" : r.error || "Delete failed.");
    } catch (e) { setNote((e as Error).message); }
    onGitChanged();
  }

  const copyPath = (p: string) => {
    try { void navigator.clipboard?.writeText(p); setNote(`Copied ${p}`); } catch { /* ignore */ }
  };

  /* Row menu. What's offered follows the half the row was clicked in: a staged
     row can only be unstaged (discarding it would throw away work the index is
     already holding), an unstaged one can be staged or discarded. The "all"
     actions close every menu, and are the whole menu behind the fold's ⋯. */
  function ctxItems(t: NonNullable<typeof ctx>): CtxItem[] {
    const items: CtxItem[] = [];
    if (t.path) {
      const untracked = changed.get(t.path) === "?";
      items.push(
        { icon: "▤", label: "Open File", onClick: () => onOpenFile(t.path, false) },
        { icon: "◫", label: "Open Changes", hint: "diff", onClick: () => onOpenFile(t.path, true) },
        { divider: true },
      );
      if (t.staged) {
        items.push({ icon: "−", label: "Unstage Changes", onClick: () => void gitOp("unstage", [t.path]) });
      } else {
        items.push({ icon: "+", label: "Stage Changes", onClick: () => void gitOp("stage", [t.path]) });
        items.push({
          icon: "↺", label: "Discard Changes", danger: true,
          hint: untracked ? "never committed — this deletes it" : undefined,
          onClick: () => discard(t.path, untracked),
        });
      }
      items.push(
        { divider: true },
        { icon: "⧉", label: "Copy Path", onClick: () => copyPath(t.path) },
        {
          icon: "✕", label: "Delete File", danger: true,
          onClick: () => void askConfirm(`Delete ${t.path} from disk?`)
            .then((yes) => { if (yes) void del(t.path); }),
        },
      );
      if (staged.length || unstaged.length) items.push({ divider: true });
    }
    if (unstaged.length)
      items.push({ icon: "+", label: `Stage All Changes (${unstaged.length})`,
        onClick: () => void gitOp("stage", unstaged.map((f) => f.path)) });
    if (staged.length)
      items.push({ icon: "−", label: `Unstage All (${staged.length})`,
        onClick: () => void gitOp("unstage", staged.map((f) => f.path)) });
    if (unstaged.length)
      items.push({
        icon: "↺", label: `Discard All Changes (${unstaged.length})`, danger: true,
        onClick: () => void askConfirm(`Discard every unstaged change in this working tree (${plural(unstaged.length, "file")})? This can't be undone.`)
          .then((yes) => { if (yes) void gitOp("discard", unstaged.map((f) => f.path)); }),
      });
    return items;
  }

  const noCommit = busy || !msg.trim() || !changed.size;

  /* The readout: what a push and a pull would move and what's changed, how
     fresh that is, then the one move this state allows — none on a diverged
     branch, where git would refuse both. Zeros dim; "—" is a count that can't
     exist here (no upstream). Before the status lands, the last figures hold,
     dimmed, and roll to this tree's when it does. */
  const fetching = op?.kind === "fetch" && op.phase === "busy";
  const t = git?.fetched_at ? ago(git.fetched_at) : "";
  const when = !t ? "" : t === "now" ? " · checked just now" : ` · checked ${t} ago`;
  const toPush = s.kind === "ahead" || s.kind === "publish" ? s.n : s.kind === "diverged" ? s.ahead
    : s.kind === "synced" || s.kind === "behind" ? 0 : null;
  const toPull = s.kind === "behind" ? s.n : s.kind === "diverged" ? s.behind
    : s.kind === "synced" || s.kind === "ahead" ? 0 : null;
  const action = s.kind === "ahead" ? { kind: "push" as const, n: s.n }
    : s.kind === "behind" ? { kind: "pull" as const, n: s.n }
    : s.kind === "publish" && s.n > 0 ? { kind: "publish" as const, n: s.n }
    : null;
  const cell = (slot: string, icon: ReactNode, value: number | null, label: string, tone: string) => (
    <div className={`gp-roc ${ready && value ? tone : "z"}`}>
      <b>{icon}<Roll slot={slot} v={ready ? String(value ?? "—") : null} /></b><span>{label}</span>
    </div>
  );
  const warn = s.kind === "diverged" ? "warn" : "";
  const sub = fetching ? <span>checking origin…</span>
    : !ready ? <span>reading the working tree…</span>
    : s.kind === "synced" ? <><Check size={12} strokeWidth={2.4} /><span>up to date with <b>{s.upstream}</b>{when}</span></>
    : s.kind === "ahead" || s.kind === "behind" ? <span><b>{s.upstream}</b>{when}</span>
    : s.kind === "diverged" ? <span>diverged from <b>{s.upstream}</b>{when}</span>
    : s.kind === "publish" ? <span>not on <b>origin</b> yet · only in this checkout</span>
    : s.kind === "local" ? <span>no remote · this repo lives only here</span>
    : <span>detached HEAD · no branch to push</span>;
  const pushy = op?.kind === "push" || op?.kind === "publish";
  const act: ReactNode = op?.phase === "failed" ? (
    <div className="gp-fail" role="alert">
      <div className="gp-failh">
        <TriangleAlert size={14} strokeWidth={2} /><b>{FAILED[op.kind]}</b>
        <button className="gp-ib" title="dismiss" onClick={() => setOp(null)}><X size={12} /></button>
      </div>
      <pre>{op.output}</pre>
      <div className="gp-failbtns">
        {/* Not a retry in disguise: the push goes to a new session on the
            branch, which you send yourself (runner._PUSH_NOTE tells agents the same). */}
        {pushy && onHandOff && (
          <button className="gp-pb tint" title="Handle it in a new session on this branch, with git's message as an unsent draft"
            onClick={() => { onHandOff(op.project, op.branch, pushFailedDraft(branchName || op.branch, op.output)); setOp(null); }}>
            <SquarePen size={13} strokeWidth={2} />Handle in a new session
          </button>
        )}
        <button className={`gp-pb ghost${pushy ? " sq" : ""}`} title="retry" disabled={busy}
          onClick={() => void (op.kind === "fetch" ? fetchNow() : sync(op.kind, op.n))}>
          <RotateCcw size={13} strokeWidth={2} />{!pushy && "Retry"}
        </button>
      </div>
    </div>
  ) : op?.phase === "done" ? (
    <div className="gp-done"><Check size={13} strokeWidth={2.4} /><span>{op.text}</span></div>
  ) : op?.phase === "busy" && op.kind !== "fetch" ? (
    <button className="gp-pb busy" disabled>
      <LoaderCircle size={14} strokeWidth={2.2} />
      {op.kind === "publish" ? "Publishing…" : `${op.kind === "pull" ? "Pulling" : "Pushing"} ${plural(op.n, "commit")}…`}
    </button>
  ) : s.kind === "diverged" ? (
    <>
      <div className="gp-ronote">A push would be refused and a pull can't fast-forward. A new session can merge{" "}
        <code>{s.upstream}</code> in and push; you send its first message.</div>
      {onHandOff && project && (
        <button className="gp-pb tint" title="Open a session on this branch with the merge as an unsent draft"
          onClick={() => onHandOff(project, branch, divergedDraft(branchName, s.upstream, s.ahead, s.behind))}>
          <SquarePen size={13} strokeWidth={2} />Handle in a new session
        </button>
      )}
    </>
  ) : action ? (
    <button className="gp-pb" disabled={busy} onClick={() => void sync(action.kind, action.n)}
      title={action.kind === "publish" ? `publish ${branchName} to origin and track it`
        : action.kind === "pull" ? `fast-forward ${plural(action.n, "commit")} from ${s.kind === "behind" ? s.upstream : ""}`
        : `push ${plural(action.n, "commit")} to ${s.kind === "ahead" ? s.upstream : ""}`}>
      {action.kind === "publish" ? <CloudUpload size={14} strokeWidth={2.2} /> : action.kind === "pull"
        ? <ArrowDown size={14} strokeWidth={2.2} /> : <ArrowUp size={14} strokeWidth={2.2} />}
      {action.kind === "publish" ? "Publish branch" : `${action.kind === "pull" ? "Pull" : "Push"} ${plural(action.n, "commit")}`}
    </button>
  ) : null;

  const row = (f: GitFile, sec: boolean) => {
    // The letter for the half the row is in — a file staged as added and then
    // edited is A above and M below, and saying "M" in both would be a lie
    // about what's about to be committed. Untracked reads U, as git's own
    // short status does not, but every other tool does.
    const st = (sec ? f.x : f.y) || f.status;
    const cut = f.path.lastIndexOf("/");
    const name = cut < 0 ? f.path : f.path.slice(cut + 1);
    const open = (changed: boolean) => onOpenFile(f.path, changed);
    return (
      <div key={`${sec ? "s" : "u"}:${f.path}`} className="trow gp-row" role="button" tabIndex={0} title={f.path}
        onClick={() => open(true)}
        onKeyDown={(e) => { if (e.key === "Enter") open(true); }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();   // the dashboard's own right-click menu listens on window
          setCtx({ x: e.clientX, y: e.clientY, path: f.path, staged: sec });
        }}>
        <FileIcon name={name} size={14} />
        <span className="gp-name">{name}</span>
        {/* rtl keeps the nearest folder visible when the path is cut */}
        <span className="gp-dir" dir="rtl">{cut < 0 ? "" : f.path.slice(0, cut)}</span>
        <span className="gp-fig"><i>+{f.add}</i><i>−{f.del}</i></span>
        <span className="gp-racts">
          <button className="gp-ib" title="open changes" onClick={(e) => { e.stopPropagation(); open(true); }}><FileDiff size={12} /></button>
          <button className="gp-ib" title={sec ? "unstage" : "stage"} disabled={busy}
            onClick={(e) => { e.stopPropagation(); void gitOp(sec ? "unstage" : "stage", [f.path]); }}>
            {sec ? <Minus size={12} /> : <Plus size={12} />}
          </button>
          {!sec && (
            <button className="gp-ib" title="discard changes" disabled={busy}
              onClick={(e) => { e.stopPropagation(); discard(f.path, st === "?"); }}><RotateCcw size={12} /></button>
          )}
        </span>
        <span className="gp-st" style={{ color: ST_COLOR(st) }}>{st === "?" ? "U" : st}</span>
      </div>
    );
  };

  const group = (title: string, list: GitFile[], sec: boolean) => (
    <div className="gp-group">
      {title}<em>{list.length}</em>
      <button className="gp-ib" disabled={busy} title={sec ? "unstage all" : "stage all"}
        onClick={() => void gitOp(sec ? "unstage" : "stage", list.map((f) => f.path))}>
        {sec ? <Minus size={12} /> : <Plus size={12} />}
      </button>
    </div>
  );

  const bothOpen = !chClosed && !grClosed;

  return (
    <div className="panel gp" style={{ border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", background: "color-mix(in srgb, var(--panel) 86%, transparent)", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div className="gp-head">
        <span className="gp-title">GIT</span>
        {branchName && (
          <span ref={brRef} className="gp-branch" title={branchName}><i>⎇</i><Roll slot="branch" v={branchName} /></span>
        )}
        <button className={`gp-ib${fetching ? " spin" : ""}`} disabled={busy}
          title={s.kind === "none" ? "refresh" : "fetch from origin, then re-read"} onClick={() => void fetchNow()}>
          <RefreshCw size={13} />
        </button>
      </div>
      <div style={{ height: 1, background: "linear-gradient(90deg,var(--acc),transparent)", flex: "none" }} />

      {project && (
        <div ref={rdRef} className="gp-rdw">
          {(!ready || s.kind !== "none") && (
            <div className="gp-rd">
              <div className="gp-ro">
                {cell("push", <ArrowUp size={15} strokeWidth={2.2} />, toPush, s.kind === "publish" ? "to publish" : "to push", warn || (action && action.kind !== "pull" ? "on" : ""))}
                {cell("pull", <ArrowDown size={15} strokeWidth={2.2} />, toPull, "to pull", warn || (action?.kind === "pull" ? "on" : ""))}
                {cell("changed", <CircleDot size={14} strokeWidth={2.2} />, changed.size, "changed", "dirty")}
                {op?.phase === "busy" && op.kind !== "fetch" && <div className="gp-robar"><i /></div>}
              </div>
              <div className={`gp-rosub${fetching ? "" : s.kind === "synced" ? " ok" : warn ? " warn" : ""}`}>{sub}</div>
              {act && <div className="gp-act">{act}</div>}
            </div>
          )}
        </div>
      )}

      {/* Both open: CHANGES takes its content up to half the panel, GRAPH the
          rest. One closed: the other takes everything, and a closed GRAPH's
          head sits at the foot, the way VS Code's panes stack. */}
      <div ref={chRef} className="gp-fold" style={{ flex: chClosed ? "none" : grClosed ? "1 1 0" : "0 1 auto", maxHeight: bothOpen ? "52%" : undefined }}>
        <div className="gp-fh" role="button" aria-expanded={!chClosed} onClick={() => setChClosed((v) => !v)}>
          {chClosed ? <ChevronRight size={12} strokeWidth={2} /> : <ChevronDown size={12} strokeWidth={2} />}
          <b>Changes</b>
          {changed.size > 0 && <em>{changed.size}</em>}
          <span className="gp-acts" onClick={(e) => e.stopPropagation()}>
            {unstaged.length > 0 && (
              <button className="gp-ib" disabled={busy} title="stage all"
                onClick={() => void gitOp("stage", unstaged.map((f) => f.path))}><Plus size={13} /></button>
            )}
            {changed.size > 0 && (
              <button className="gp-ib" title="more"
                onClick={(e) => setCtx({ x: e.clientX, y: e.clientY, path: "", staged: false })}><Ellipsis size={13} /></button>
            )}
          </span>
        </div>
        {!chClosed && (
          <div className="mscroll gp-body">
            {project && (
              <div className="cbox gp-cbox">
                <textarea value={msg} onChange={(e) => setMsg(e.target.value)} rows={2}
                  placeholder={`Message (${MOD}↵ to commit on ${branchName || "this branch"})`}
                  title={`${MOD}Enter to commit`}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && msg.trim() && changed.size && !busy) { e.preventDefault(); void commit(); }
                  }} />
                <div className="gp-cbtns">
                  {ai.commitmsg && (
                    <button className="gp-btn caps" disabled={gen || busy || !changed.size} title="write the message from the diff"
                      onClick={() => void generate()}>{gen ? "Writing…" : "✧ Generate"}</button>
                  )}
                  {/* The label is the promise: with an index, COMMIT takes only
                      what's in it (bridge/git.py commit()), so saying "ALL"
                      would be wrong the moment you stage one file. */}
                  <button className="gp-btn pri caps" disabled={noCommit} title={`${MOD}Enter`} onClick={() => void commit()}>
                    {!ready ? "▸ Commit" : staged.length ? `▸ Commit staged (${staged.length})` : `▸ Commit all (${changed.size})`}
                  </button>
                </div>
              </div>
            )}
            {note && (
              <div className="gp-note" onClick={() => setNote("")} title="dismiss">{note}</div>
            )}
            {!project ? <div className="gp-empty">No session selected.</div>
              : !ready ? (skel ? (
                <div className="swapin" style={{ padding: "4px 12px" }} aria-label="Reading the working tree" aria-busy>
                  {[62, 78, 51, 70, 44].map((w, i) => (
                    <Skeleton key={i} className="h-[13px] rounded-none"
                      style={{ width: `${w}%`, marginBottom: 5, background: "color-mix(in srgb, var(--acc) 13%, transparent)" }} />
                  ))}
                </div>
              ) : null)
              : !git.is_repo ? <div className="gp-empty swapin">Not a git repository.</div>
              : !changed.size ? <div className="gp-empty swapin">Working tree clean.</div>
              : (
                <div className="swapin">
                  {/* Groups only once the index holds something; otherwise the
                      rows sit flat and the fold's count is the group. */}
                  {staged.length > 0 && group("STAGED", staged, true)}
                  {staged.map((f) => row(f, true))}
                  {staged.length > 0 && unstaged.length > 0 && group("UNSTAGED", unstaged, false)}
                  {unstaged.map((f) => row(f, false))}
                </div>
              )}
          </div>
        )}
      </div>

      <div className="gp-fold" style={{ flex: grClosed ? "none" : "1 1 0" }}>
        <div className="gp-fh" role="button" aria-expanded={!grClosed} onClick={() => setGrClosed((v) => !v)}>
          {grClosed ? <ChevronRight size={12} strokeWidth={2} /> : <ChevronDown size={12} strokeWidth={2} />}
          <b>Graph</b>
          <span className="gp-acts" onClick={(e) => e.stopPropagation()}>
            <button className="gp-filter" title={branchOnly ? "showing this branch — click for every branch" : "showing every branch — click for this branch only"}
              onClick={() => setBranchOnly((v) => !v)}>
              <span>{branchOnly ? branchName || "this branch" : "all branches"}</span><ChevronDown size={10} strokeWidth={2} />
            </button>
          </span>
        </div>
        {!grClosed && (
          <div className="mscroll gp-body">
            {project ? (
              <CommitGraph project={project} branch={branchOnly ? branchName || undefined : undefined}
                upstream={git?.upstream} ahead={ahead} behind={behind} nonce={nonce} />
            ) : <div className="gp-empty">No session selected.</div>}
          </div>
        )}
      </div>

      {ctx && (
        <ContextMenu ctx={{ x: ctx.x, y: ctx.y, type: ctx.path ? "file" : "folder", id: ctx.path, label: ctx.path || "all changes" }}
          items={ctxItems(ctx)} onClose={() => setCtx(null)} />
      )}
    </div>
  );
}
