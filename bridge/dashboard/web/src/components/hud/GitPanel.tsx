import { useMemo, useState } from "react";
import {
  ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Ellipsis, FileDiff, Minus, Plus, RefreshCw, RotateCcw,
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

/* GIT — the right rail's one git tab: a repo header (branch, how far ahead or
   behind the upstream, push/pull, refresh) over two folds in VS Code's Source
   Control shape. CHANGES is the working tree with the commit box; GRAPH is
   the commit graph (CommitGraph). Each fold remembers whether it is open.
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
  // A push git refused goes to a new session on the tree that was pushing,
  // git's message as its unsent draft (App's pushFailedSession). Named here,
  // not read at click time: this panel outlives a switch to another session.
  onPushFailed?: (project: string, branch: string | null | undefined, output: string) => void;
}

const ST_COLOR = (s: string) => (s === "A" || s === "?" ? "var(--ok)" : s === "D" ? "var(--err)" : "var(--warn)");
const byPath = (a: GitFile, b: GitFile) => a.path.localeCompare(b.path);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const MOD = /Mac|iP/.test(navigator.platform) ? "⌘" : "Ctrl+";

export function GitPanel({ project, branch, git, onGitChanged, onOpenFile, onReveal, onPushFailed }: Props) {
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
  // the note, while it is git refusing a push, with the tree that was pushing
  const [pushErr, setPushErr] = useState<{ project: string; branch?: string; output: string } | null>(null);
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

  // Push and pull report under the commit box, so the fold opens to show it.
  async function push() {
    if (!project) return;
    setBusy(true);
    try {
      const r = await api.gitPush(project, branch || undefined);
      setNote(r.ok ? "Pushed." : r.output || "Push failed.");
      setPushErr(r.ok ? null : { project, branch, output: r.output || "Push failed." });
    } catch (e) { setNote((e as Error).message); }
    finally { setBusy(false); setChClosed(false); onGitChanged(); setNonce((n) => n + 1); }
  }

  async function pull() {
    if (!project) return;
    setBusy(true);
    try {
      const r = await api.gitPull(project, branch || undefined);
      setNote(r.ok ? r.output || "Pulled." : r.output || "Pull failed.");
    } catch (e) { setNote((e as Error).message); }
    finally { setBusy(false); setChClosed(false); onGitChanged(); setNonce((n) => n + 1); }
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

  /* The header's sync chip reads the status: ↑n pushes, ↓n pulls, both when
     diverged, a quiet ✓ when in step, and a bare PUSH for a branch the remote
     has never seen (bridge/git.py publishes it with -u). */
  const sync = !git || !git.is_repo ? null
    : !git.upstream ? (
      <button className="gp-sync" disabled={busy} title="publish this branch to origin" onClick={() => void push()}>
        <ArrowUp size={11} strokeWidth={2} />PUSH
      </button>
    ) : ahead === 0 && behind === 0 ? (
      <span className="gp-sync quiet" title={`in step with ${git.upstream}`}><Check size={11} strokeWidth={2} />synced</span>
    ) : (
      <>
        {ahead > 0 && (
          <button className="gp-sync" disabled={busy} title={`push ${plural(ahead, "commit")} to ${git.upstream}`} onClick={() => void push()}>
            <ArrowUp size={11} strokeWidth={2} />{ahead}
          </button>
        )}
        {behind > 0 && (
          <button className="gp-sync" disabled={busy} title={`pull ${plural(behind, "commit")} from ${git.upstream} (fast-forward only)`} onClick={() => void pull()}>
            <ArrowDown size={11} strokeWidth={2} />{behind}
          </button>
        )}
      </>
    );

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
          <span className="gp-branch" title={branchName}><i>⎇</i><span>{branchName}</span></span>
        )}
        {sync}
        <button className="gp-ib" title="refresh" onClick={() => { onGitChanged(); setNonce((n) => n + 1); }}>
          <RefreshCw size={13} />
        </button>
      </div>
      <div style={{ height: 1, background: "linear-gradient(90deg,var(--acc),transparent)", flex: "none" }} />

      {/* Both open: CHANGES takes its content up to half the panel, GRAPH the
          rest. One closed: the other takes everything, and a closed GRAPH's
          head sits at the foot, the way VS Code's panes stack. */}
      <div className="gp-fold" style={{ flex: chClosed ? "none" : grClosed ? "1 1 0" : "0 1 auto", maxHeight: bothOpen ? "52%" : undefined }}>
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
                    <button className="gp-btn" disabled={gen || busy || !changed.size} title="write the message from the diff"
                      onClick={() => void generate()}>{gen ? "WRITING…" : "✧ GENERATE"}</button>
                  )}
                  {/* The label is the promise: with an index, COMMIT takes only
                      what's in it (bridge/git.py commit()), so saying "ALL"
                      would be wrong the moment you stage one file. */}
                  <button className="gp-btn pri" disabled={noCommit} title={`${MOD}Enter`} onClick={() => void commit()}>
                    {!ready ? "▸ COMMIT" : staged.length ? `▸ COMMIT STAGED (${staged.length})` : `▸ COMMIT ALL (${changed.size})`}
                  </button>
                </div>
              </div>
            )}
            {note && (
              <div className="gp-note" onClick={() => setNote("")} title="dismiss">{note}</div>
            )}
            {/* Not a retry: the push goes to a new session on the branch, which
                you send yourself (runner._PUSH_NOTE tells agents the same). */}
            {pushErr && note === pushErr.output && onPushFailed && (
              <button className="gp-btn wide"
                title="Handle it in a new session on this branch, with git's message as an unsent draft"
                onClick={() => { onPushFailed(pushErr.project, pushErr.branch, pushErr.output); setNote(""); setPushErr(null); }}>
                ▸ HANDLE IN A NEW SESSION
              </button>
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
