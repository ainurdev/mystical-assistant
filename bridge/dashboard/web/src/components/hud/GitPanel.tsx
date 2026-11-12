import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronDown, ChevronRight, Cloud, Ellipsis, ExternalLink, FileDiff, GitMerge,
  GitPullRequest, Laptop, LoaderCircle, Minus, Plus, RefreshCw, RotateCcw, Send, SquarePen, TriangleAlert, Undo2, X,
} from "lucide-react";
import { api, type CompareFile, type GitFile, type GitLedger, type GitStatus, type LedgerCommit, type PrStatus } from "../../api";
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
import { TaskLine } from "./TaskChip";
import { TabKick } from "./TabKick";
import { commentsMessage, failureMessage, stateLine } from "../../lib/prchip";
import { diffColor } from "../../lib/resultfields";

/* GIT — the right rail's one git tab, and the dashboard's only git status: a
   kicker (branch, how fresh, ⟳ fetch), then the LEDGER (/design-first
   git-reimagine, 2026-11-11): one line read downward. Your uncommitted edits
   with the commit box; the commits only on this machine (hollow dots: what a
   push sends); a marker where origin is; the commits origin has that the base
   lacks, with the pull request; a marker for the base (a menu: the branch this
   one is compared with, BRANCHES' Target). Where the markers sit is the status,
   and each button sits on the stretch it moves. Commit and Push stay two
   presses (the user's pick). A commit opens in place to its files; the newest
   unpushed one can be undone. The graph (CommitGraph) waits behind its link.
   The working tree comes from App's per-worktree status poll (sessionGit), so
   the rail badge and the list read the same answer; an op here bumps that poll
   (onGitChanged) instead of running a second one. The commit box lives outside
   this component (lib/commitdraft.ts): the rail rebuilds the panel on every
   tab/session switch, and a GENERATE in flight outlives that. Styles under
   GIT LEDGER in index.css.
   NEXT STEP (/design-first git-better, 2026-11-12): the stretch you're on opens
   as a glowing card holding the one filled button (Commit, Push, Open PR, or
   the PR's failure); the other stretches fold their commits to one line with
   quiet links. A bar under the kicker counts the steps left to the base, and
   the commit message is drafted up front from the diff. */

interface Props {
  project: string | null;
  branch?: string;
  // App's status poll for this worktree; null until its first answer.
  git: GitStatus | null;
  // App's auto-fetch of this tree (lib/gitsync needsFetch): busy while it runs,
  // and git's words from a failed one until a fetch after `at` lands.
  autoFetch?: { at: number; busy: boolean; error?: string } | null;
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
  // To this session's chat: the task line's "link one".
  onSend?: (text: string) => void;
}

type OpKind = "push" | "publish" | "pull" | "fetch" | "merge";
// The hero's sync op, in flight or just over: done shows a few seconds,
// failed stays with git's own words until dismissed or retried. `push`: a
// failed merge was Merge & push, which its hand-off draft keeps.
type Op = { kind: OpKind; n: number; phase: "busy" }
  | { kind: OpKind; n: number; phase: "done"; text: string }
  | { kind: OpKind; n: number; phase: "failed"; output: string; project: string; branch?: string; push?: boolean };
const FAILED: Record<OpKind, string> = { push: "Push refused", publish: "Publish refused", pull: "Pull failed", fetch: "Fetch failed", merge: "Merge failed" };

const ST_COLOR = (s: string) => (s === "A" || s === "?" ? "var(--ok)" : s === "D" ? "var(--err)" : "var(--warn)");
const ROWS = 6;      // a stretch's commits before "Show all"
const IN_ROWS = 3;   // origin's incoming stays short: the buttons are the point
// What each tree's line last read, so a switch back draws at once and re-reads in place.
const LEDGERS = new Map<string, GitLedger>();
const PRS = new Map<string, PrStatus>();
const byPath = (a: GitFile, b: GitFile) => a.path.localeCompare(b.path);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const MOD = /Mac|iP/.test(navigator.platform) ? "⌘" : "Ctrl+";
// The file set each tree's message was last drafted for, and the draft itself,
// so a rebuild doesn't draft again and the box can say a draft is untouched.
const DRAFTED = new Map<string, string>();
const AUTO = new Map<string, string>();

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

export function GitPanel({ project, branch, git, autoFetch, onGitChanged, onOpenFile, onReveal, onHandOff, onSend }: Props) {
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
  const [grOpen, setGrOpen] = useStickyFlag("git-graph-open");   // off by default: the tracker's list is the short answer
  const [branchOnly, setBranchOnly] = useStickyFlag("git-graph-branch-only");
  const [nonce, setNonce] = useState(0);   // the graph re-reads on ⟳
  const ready = git !== null;
  // A clean `git status` answers fast; useLoadingPhase keeps the placeholder
  // from strobing on and off inside one frame budget.
  const skel = useLoadingPhase(!ready);
  const branchName = git?.branch || branch || "";
  const ahead = git?.ahead ?? 0;
  const behind = git?.behind ?? 0;
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
  const up = s.kind === "diverged" ? s.ahead : s.kind === "ahead" || s.kind === "publish" ? s.n : 0;
  const down = s.kind === "diverged" ? s.behind : s.kind === "behind" ? s.n : 0;
  // The line under the working tree, re-read when the counts or a sync op move.
  const tkey = `${project}|${branch || ""}`;
  const [led, setLed] = useState<GitLedger | null>(() => LEDGERS.get(tkey) ?? null);
  useEffect(() => {
    if (!project || !git?.is_repo) return;
    let live = true;
    void api.gitLedger(project, branch || undefined).then((r) => { if (live && r.local) { LEDGERS.set(tkey, r); setLed(r); } }).catch(() => undefined);
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tkey, git?.is_repo, up, down, git?.upstream, nonce]);
  // The branch's pull request (the chat header's chip reads the same cached answer).
  const [pr, setPr] = useState<PrStatus | null>(() => PRS.get(tkey) ?? null);
  useEffect(() => {
    if (!project || !branchName || !git?.upstream) return;
    let live = true;
    const read = () => void api.prStatus(project, branchName).then((r) => { if (live) { PRS.set(tkey, r); setPr(r); } }).catch(() => undefined);
    read();
    const t = setInterval(() => { if (document.visibilityState === "visible") read(); }, 60_000);
    return () => { live = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tkey, branchName, git?.upstream, nonce]);
  // One commit opened in place: its files, and one file's diff under it.
  const [openSha, setOpenSha] = useState("");
  const [shown, setShown] = useState<{ files: CompareFile[]; add: number; del: number } | null>(null);
  const [fdiff, setFdiff] = useState<{ name: string; text: string | null } | null>(null);
  function openCommit(sha: string) {
    setFdiff(null); setShown(null);
    if (openSha === sha || !project) { setOpenSha(""); return; }
    setOpenSha(sha);
    void api.gitShow(project, sha).then((r) => setShown({ files: r.files ?? [], add: r.add ?? 0, del: r.del ?? 0 })).catch(() => setShown({ files: [], add: 0, del: 0 }));
  }
  function openCommitFile(sha: string, name: string) {
    if (fdiff?.name === name || !project) { setFdiff(null); return; }
    setFdiff({ name, text: null });
    void api.gitShow(project, sha, name).then((r) => setFdiff({ name, text: r.diff ?? "" })).catch(() => setFdiff({ name, text: "" }));
  }
  const [allOf, setAllOf] = useState<Record<string, boolean>>({});   // a stretch showing every commit
  const [baseAt, setBaseAt] = useState<{ x: number; y: number } | null>(null);
  const [prForm, setPrForm] = useState<{ title: string; body: string } | null>(null);
  // COMING IN (origin's commits) and, diverged, the merge's dry run. The last
  // answer stays up while the next loads, so the rows don't blink; its verdict
  // only counts for the heads it was asked about (`key`).
  type Incoming = { commits: { sha: string; subject: string; ts: number }[]; clash: string[] | null; key: string };
  const [incoming, setIncoming] = useState<Incoming | null>(null);
  const ikey = `${project}|${branch}|${up}|${down}|${git?.upstream}`;
  useEffect(() => {
    if (!project || !down) { setIncoming(null); return; }
    let live = true;
    void api.gitIncoming(project, branch || undefined).then((r) => { if (live) setIncoming({ ...r, key: ikey }); })
      .catch(() => { if (live) setIncoming({ commits: [], clash: null, key: ikey }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ikey, nonce]);
  // A merge that clashed when it ran (no dry run on this git): its files, until the heads move.
  const [clashSeen, setClashSeen] = useState<{ files: string[]; key: string } | null>(null);
  const [clashAll, setClashAll] = useState(false);
  const clashFiles = clashSeen?.key === ikey ? clashSeen.files : incoming?.key === ikey ? incoming.clash : undefined;
  useEffect(() => {
    if (op?.phase !== "done") return;
    const t = setTimeout(() => setOp(null), 4000);
    return () => clearTimeout(t);
  }, [op]);

  // The hero's one move: PUSH, PUBLISH (push() adds -u) or PULL (ff-only).
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
      // A refused push is most often origin moving on: fetch, so the hero offers the merge.
      if (!r.ok && kind !== "pull") await api.gitFetch(project, branch || undefined).catch(() => undefined);
    } catch (e) { setOp({ kind, n, phase: "failed", output: (e as Error).message, project, branch }); }
    finally { setBusy(false); onGitChanged(); setNonce((x) => x + 1); }
  }

  // Merge / Merge & push on a diverged branch, here: a merge commit, never a
  // rebase. A clash changes nothing: its files come back and the two buttons
  // turn into session hand-offs. Pushing happens only for Merge & push.
  async function merge(andPush: boolean) {
    if (!project || s.kind !== "diverged") return;
    const { upstream, ahead, behind } = s;
    let kind: OpKind = "merge";
    setBusy(true);
    setOp({ kind, n: behind, phase: "busy" });
    try {
      const r = await api.gitMergeUpstream(project, branch || undefined);
      if (r.clash?.length) { setClashSeen({ files: r.clash, key: ikey }); setOp(null); return; }
      if (!r.ok) { setOp({ kind, n: behind, phase: "failed", output: r.output || "Merge failed.", project, branch, push: andPush }); return; }
      const merged = `Merged ${plural(behind, "commit")} from ${upstream}`;
      if (!andPush) { setOp({ kind, n: behind, phase: "done", text: merged }); return; }
      kind = "push";
      setOp({ kind, n: ahead + 1, phase: "busy" });
      const p = await api.gitPush(project, branch || undefined);
      setOp(p.ok ? { kind, n: ahead + 1, phase: "done", text: `${merged} and pushed ${plural(ahead + 1, "commit")}` }
        : { kind, n: ahead + 1, phase: "failed", output: p.output || "Push refused.", project, branch });
      if (!p.ok) await api.gitFetch(project, branch || undefined).catch(() => undefined);
    } catch (e) { setOp({ kind, n: kind === "push" ? ahead + 1 : behind, phase: "failed", output: (e as Error).message, project, branch, push: andPush }); }
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
  async function generate(auto = false) {
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
    if (auto) { if (message) AUTO.set(key, message); return; }   // a draft nobody asked for stays quiet
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
      : `Discard your changes to ${path}? This can't be undone.`, { ok: untracked ? "Delete" : "Discard", danger: true })
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
          onClick: () => void askConfirm(`Delete ${t.path} from disk?`, { ok: "Delete", danger: true })
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
        onClick: () => void askConfirm(`Discard every unstaged change in this working tree (${plural(unstaged.length, "file")})? This can't be undone.`, { ok: "Discard all", danger: true })
          .then((yes) => { if (yes) void gitOp("discard", unstaged.map((f) => f.path)); }),
      });
    return items;
  }

  const noCommit = busy || !msg.trim() || !changed.size;
  // Draft the message up front: once per set of changes, after they sit still
  // a few seconds, and only into an empty box (a cleared draft stays cleared).
  const sig = files.map((f) => `${f.path}:${f.add}:${f.del}`).join("|");
  useEffect(() => {
    if (!ai.commitmsg || !sig || gen || msg.trim() || DRAFTED.get(key) === sig) return;
    const t = setTimeout(() => { DRAFTED.set(key, sig); void generate(true); }, 4000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, ai.commitmsg, gen, msg, key]);

  /* The hero's inputs: how fresh the status is (`when`), and the moves this
     state allows. Diverged, a pull can't fast-forward: Merge / Merge & push
     run here, or go to a session when the dry run says they'd clash. */
  const fetching = (op?.kind === "fetch" && op.phase === "busy") || !!autoFetch?.busy;
  const t = git?.fetched_at ? ago(git.fetched_at) : "";
  const when = !t ? "" : t === "now" ? "checked just now" : `checked ${t} ago`;
  // An auto-fetch failure no fetch has retired since: one quiet line, not the
  // alert box, which stays for a fetch you asked for.
  const autoErr = !fetching && op?.phase !== "failed" && autoFetch?.error
    && !(git?.fetched_at && git.fetched_at >= autoFetch.at) ? autoFetch.error : "";
  // Never fetched, or the last auto-fetch failed: no "up to date" claim stands.
  const unchecked = !!git?.upstream && (git.fetched_at === null || !!autoErr);
  const msgRef = useRef<HTMLTextAreaElement>(null);
  // A clash never starts here: a new session merges, and its draft says whether to push.
  function mergeAct(andPush: boolean) {
    if (s.kind !== "diverged") return;
    if (clashFiles?.length) {
      if (onHandOff && project) onHandOff(project, branch, divergedDraft(branchName, s.upstream, s.ahead, s.behind,
        { push: andPush, clash: clashFiles, dirty: changed.size }));
    } else void merge(andPush);
  }
  // Update: the base merged in here. A clash changes nothing and goes to a session, unsent.
  async function updateBase() {
    if (!project || !led?.base) return;
    setBusy(true);
    try {
      const r = await api.gitUpdateBase(project, led.base, branch || undefined);
      if (r.clash?.length && onHandOff) {
        onHandOff(project, branch, `Merge \`${led.ref}\` into \`${branchName}\` (a merge commit, never a rebase) and resolve the conflicts. A dry run says these files clash:\n${r.clash.map((f) => `- ${f}`).join("\n")}\nThen stop: don't push.`);
        setNote(`Merging ${led.base} would clash in ${plural(r.clash.length, "file")}, so nothing changed. The merge is an unsent draft in a new session.`);
      } else setNote(r.ok ? `Merged ${led.base} into ${branchName}.` : r.output || "Update failed.");
    } catch (e) { setNote((e as Error).message); }
    finally { setBusy(false); onGitChanged(); setNonce((x) => x + 1); }
  }
  function undoCommit(c: LedgerCommit) {
    void askConfirm(`Undo "${c.subject}"? The commit goes away and its changes stay, staged.`, { ok: "Undo commit" }).then(async (yes) => {
      if (!yes || !project) return;
      setBusy(true);
      try {
        const r = await api.gitUndoCommit(project, branch || undefined);
        setNote(r.ok ? "" : r.output || "Couldn't undo the commit.");
        if (r.ok) setOpenSha("");
      } catch (e) { setNote((e as Error).message); }
      finally { setBusy(false); onGitChanged(); setNonce((x) => x + 1); }
    });
  }
  async function setBase(target: string | null) {
    if (!project || !branchName) return;
    try { await api.setBranchTarget(project, branchName, target); } catch (e) { setNote((e as Error).message); }
    setNonce((x) => x + 1);
  }
  async function openPr() {
    if (!project || !led?.base || !prForm?.title.trim()) return;
    setBusy(true);
    try {
      const r = await api.createPr(project, branchName, led.base, prForm.title.trim(), prForm.body);
      setNote(r.ok ? `Opened pull request${r.number ? ` #${r.number}` : ""}.` : r.output || "Couldn't open the pull request.");
      if (r.ok) setPrForm(null);
    } catch (e) { setNote((e as Error).message); }
    finally { setBusy(false); setNonce((x) => x + 1); }
  }
  // The kicker's short form of how fresh this is (the full words are in the title).
  const right = fetching ? "checking…" : autoErr ? "offline" : unchecked ? "not checked" : !t ? "" : t === "now" ? "just now" : `${t} ago`;
  // Only a running push or pull locks the hero: Commit just opens the message box, and an auto-fetch is no reason to wait.
  const syncing = op?.phase === "busy" && op.kind !== "fetch";
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
        {/* Nothing changed, so the hero's buttons are the retry; this hands the merge on. */}
        {op.kind === "merge" && onHandOff && s.kind === "diverged" && (
          <button className="gp-pb tint" title="Handle it in a new session on this branch, with the merge as an unsent draft"
            onClick={() => { onHandOff(op.project, op.branch, divergedDraft(branchName, s.upstream, s.ahead, s.behind, { push: !!op.push, dirty: changed.size })); setOp(null); }}>
            <SquarePen size={13} strokeWidth={2} />Handle in a new session
          </button>
        )}
        {op.kind !== "merge" && (
          <button className={`gp-pb ghost${pushy ? " sq" : ""}`} title="retry" disabled={busy}
            onClick={() => void (op.kind === "fetch" ? fetchNow() : op.kind !== "merge" && sync(op.kind, op.n))}>
            <RotateCcw size={13} strokeWidth={2} />{!pushy && "Retry"}
          </button>
        )}
      </div>
    </div>
  ) : op?.phase === "done" ? (
    <div className="gp-done"><Check size={13} strokeWidth={2.4} /><span>{op.text}</span></div>
  ) : op?.phase === "busy" && op.kind !== "fetch" ? (
    <button className="gp-pb busy" disabled>
      <LoaderCircle size={14} strokeWidth={2.2} />
      {op.kind === "publish" ? "Publishing…" : `${op.kind === "pull" ? "Pulling" : op.kind === "merge" ? "Merging" : "Pushing"} ${plural(op.n, "commit")}…`}
    </button>
  ) : s.kind === "diverged" && clashFiles?.length ? (
    <div className="gp-clash">
      <div className="gp-clash-h"><TriangleAlert size={12} strokeWidth={2.2} /><span>Would clash</span><em>{plural(clashFiles.length, "file")}</em></div>
      <div className="gp-clash-rows">
        {(clashAll ? clashFiles : clashFiles.slice(0, 3)).map((f) => {
          const cut = f.lastIndexOf("/");
          return (
            <div key={f} className="trow gp-row" role="button" tabIndex={0} title={f}
              onClick={() => onOpenFile(f, false)} onKeyDown={(e) => { if (e.key === "Enter") onOpenFile(f, false); }}>
              <FileIcon name={f} size={14} />
              <span className="gp-name">{cut < 0 ? f : f.slice(cut + 1)}</span>
              <span className="gp-dir" dir="rtl">{cut < 0 ? "" : f.slice(0, cut)}</span>
              <span className="gp-st">!</span>
            </div>
          );
        })}
      </div>
      {clashFiles.length > 3 && !clashAll && <button className="gp-clash-more" onClick={() => setClashAll(true)}>+{clashFiles.length - 3} more</button>}
      <div className="gp-clash-note">Nothing on disk changed. Each merge button opens a <b>new session</b> with the merge as an unsent draft; only <b>Merge &amp; push</b>'s draft ends in a push.</div>
    </div>
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

  const dirty = changed.size;
  const local = led?.local ?? [];
  const localN = up || local.length;
  const prInfo = pr?.pr?.state === "OPEN" ? pr.pr : null;
  const cap = (n: number) => (n > 99 ? "99+" : n);
  // The merge's dry run, said before a press (diverged only).
  const clashN = clashFiles?.length ?? 0;
  const chk = s.kind !== "diverged" ? null
    : clashFiles === undefined ? { tone: "", text: "Testing the merge…" }
    : clashFiles === null ? { tone: "", text: "Couldn't test the merge first; a clash would be undone" }
    : clashN ? { tone: "warn", text: `${plural(clashN, "file")} clash with origin's ${down}` }
    : { tone: "ok", text: dirty ? `Merges cleanly; your ${dirty === 1 ? "edit stays" : `${dirty} edits stay`} put` : "Merges cleanly, nothing clashes" };
  const originSays = s.kind === "local" ? "no remote" : s.kind === "publish" ? "not on origin yet" : s.kind === "detached" ? "detached" : "on origin";
  // The step you're on: its stretch is the card with the one filled button.
  const failing = !!prInfo && (prInfo.failed > 0 || (!!prInfo.review && !!onSend));
  const step = dirty ? "commit" : down ? "sync" : up ? "push"
    : led?.base && led.shipped_n > 0 && !prInfo ? "pr" : failing ? "fix" : null;
  // The bar's three legs to the base: done, the one you're on, or still ahead.
  const legs = !led?.base ? [] : [
    dirty ? "n" : "d",
    up || down ? (step === "push" || step === "sync" ? "n" : "") : "d",
    !led.shipped_n && !localN && !dirty ? "d" : failing ? "w" : step === "pr" || prInfo ? "n" : "",
  ];
  const left = legs.filter((l) => l !== "d").length;
  const [unfold, setUnfold] = useState<Record<string, boolean>>({});
  const flip = (name: string) => setUnfold((u) => ({ ...u, [name]: !u[name] }));
  const showLink = (name: string) => <button type="button" className="gl-b q dim" onClick={() => flip(name)}>{unfold[name] ? "Hide" : "Show"}</button>;
  // A folded stretch's header unfolds it; clicks on its own buttons stay theirs.
  const foldHead = (name: string, folded: boolean) => !folded ? {} : {
    className: "gl-h fold", title: unfold[name] ? "Hide these commits" : "Show these commits",
    onClick: (e: React.MouseEvent) => { if (!(e.target as HTMLElement).closest("button")) flip(name); },
  };
  const card = (on: boolean, label: string, body: ReactNode, amb = false) => on
    ? <div className={`gl-nx${amb ? " amb" : ""}`}><div className="gl-nx-l">Next · {label}</div>{body}</div> : body;
  const crow = (c: LedgerCommit, tone: "out" | "on", undo: boolean) => (
    <Fragment key={c.sha}>
      <button type="button" className={`gl-c ${tone}`} aria-expanded={openSha === c.sha} title={c.subject} onClick={() => openCommit(c.sha)}>
        <span>{c.subject}</span><em>{ago(c.ts)}</em>
      </button>
      {openSha === c.sha && (
        <div className="gl-open">
          <div className="gl-meta">{c.sha}{shown ? ` · ${plural(shown.files.length, "file")} · +${shown.add} −${shown.del}` : " · reading…"}</div>
          {shown?.files.map((f) => {
            const cut = f.name.lastIndexOf("/");
            return (
              <Fragment key={f.name}>
                <div className="trow gp-row" role="button" tabIndex={0} title={f.name} aria-expanded={fdiff?.name === f.name}
                  onClick={() => openCommitFile(c.sha, f.name)} onKeyDown={(e) => { if (e.key === "Enter") openCommitFile(c.sha, f.name); }}>
                  <FileIcon name={f.name} size={14} />
                  <span className="gp-name">{cut < 0 ? f.name : f.name.slice(cut + 1)}</span>
                  <span className="gp-dir" dir="rtl">{cut < 0 ? "" : f.name.slice(0, cut)}</span>
                  <span className="gp-fig"><i>+{f.add}</i><i>−{f.del}</i></span>
                  <span className="gp-st" style={{ color: ST_COLOR(f.mark) }}>{f.mark}</span>
                </div>
                {fdiff?.name === f.name && (
                  <pre className="gg-diff">{fdiff.text === null ? "reading…" : fdiff.text.split("\n").map((l, i) => <div key={i} style={{ color: diffColor(l) }}>{l || " "}</div>)}</pre>
                )}
              </Fragment>
            );
          })}
          {undo && (
            <div className="gl-acts">
              <button type="button" className="gl-b ghost err" disabled={busy} title="Take this commit back; its changes stay, staged"
                onClick={() => undoCommit(c)}><Undo2 size={12} strokeWidth={2.2} />Undo commit</button>
            </div>
          )}
        </div>
      )}
    </Fragment>
  );
  const stretch = (name: string, list: LedgerCommit[], total: number, tone: "out" | "on") => (<>
    {(allOf[name] ? list : list.slice(0, ROWS)).map((c, i) => crow(c, tone, tone === "out" && i === 0 && !down))}
    {!allOf[name] && list.length > ROWS && <button type="button" className={`gl-c more ${tone}`} onClick={() => setAllOf((a) => ({ ...a, [name]: true }))}><span>Show all {Math.min(total, list.length)}</span></button>}
    {(allOf[name] || list.length <= ROWS) && total > list.length && <button type="button" className={`gl-c more ${tone}`} onClick={() => setGrOpen(true)}><span>+{total - list.length} more in the graph</span></button>}
  </>);

  return (
    <div className="panel gp" style={{ border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", background: "color-mix(in srgb, var(--panel) 86%, transparent)", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <TabKick name="GIT"
        chip={branchName && (
          <span ref={brRef} className="gp-branch" title={branchName}><i>⎇</i><Roll slot="branch" v={branchName} /></span>
        )}
        tools={<>
          {ready && right && <span className="gt-when" title={when || undefined}>{right}</span>}
          <button className={`gp-ib${fetching ? " spin" : ""}`} disabled={busy || fetching}
            title={s.kind === "none" ? "refresh" : "fetch from origin, then re-read"} onClick={() => void fetchNow()}>
            <RefreshCw size={13} />
          </button>
        </>} />

      <div className="mscroll gl">
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
          : (<>
            <div className="gp-rd">
              {autoErr && <div className="gp-roerr" title={autoErr}>{when || "never checked"} · {autoErr.split("\n")[0]}</div>}
              <TaskLine project={project} branch={branchName} onSend={onSend} />
              {act && <div className="gp-act">{act}</div>}
            </div>
            {legs.length > 0 && (
              <div className="gl-legs" title="Commit, push, pull request">
                <b>{left ? `${plural(left, "step")} to ${led!.base}` : `All in ${led!.base}`}</b>
                {legs.map((l, i) => <i key={i} className={l} />)}
              </div>
            )}
            <div className={`gl-line${dirty || localN ? "" : " calm"}`}>
              {/* your edits, and the box that commits them */}
              <section className="gl-s">
                <i className={`gl-n${dirty ? " me" : " done"}`}>{dirty ? <Laptop size={10} strokeWidth={2.4} /> : <Check size={10} strokeWidth={2.8} />}</i>
                {card(dirty > 0, "commit", <>
                <div className="gl-h">
                  <b className={dirty ? "" : "calm"}>{dirty ? `${plural(dirty, "file")} changed` : "Nothing to commit"}</b>
                  {dirty > 0 && (
                    <span className="gl-r">
                      <span className="gt-fig"><i>+{files.reduce((n, f) => n + f.add, 0)}</i><i>−{files.reduce((n, f) => n + f.del, 0)}</i></span>
                      {unstaged.length > 0 && <button className="gp-ib" disabled={busy} title="stage all" onClick={() => void gitOp("stage", unstaged.map((f) => f.path))}><Plus size={13} /></button>}
                      <button className="gp-ib" title="more" onClick={(e) => setCtx({ x: e.clientX, y: e.clientY, path: "", staged: false })}><Ellipsis size={13} /></button>
                    </span>
                  )}
                </div>
                {dirty > 0 && (<>
                  {/* Groups only once the index holds something; otherwise the rows sit flat. */}
                  {staged.length > 0 && group("STAGED", staged, true)}
                  {staged.map((f) => row(f, true))}
                  {staged.length > 0 && unstaged.length > 0 && group("UNSTAGED", unstaged, false)}
                  {unstaged.map((f) => row(f, false))}
                  <div className="cbox gp-cbox">
                    <textarea ref={msgRef} value={msg} onChange={(e) => setMsg(e.target.value)} rows={2}
                      placeholder={`Message (${MOD}↵ to commit on ${branchName || "this branch"})`}
                      title={`${MOD}Enter to commit`}
                      onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && msg.trim() && changed.size && !busy) { e.preventDefault(); void commit(); }
                      }} />
                    {!!msg && AUTO.get(key) === msg && <div className="gl-drafted">✧ Drafted from the diff<em>edit it · {MOD}↵</em></div>}
                    <div className="gp-cbtns">
                      {ai.commitmsg && (
                        <button className="gp-btn caps" disabled={gen || busy || !changed.size} title="write the message from the diff"
                          onClick={() => void generate()}>{gen ? "Writing…" : "✧ Write it"}</button>
                      )}
                      {/* The label is the promise: with an index, COMMIT takes only
                          what's in it (bridge/git.py commit()), so saying "ALL"
                          would be wrong the moment you stage one file. */}
                      <button className="gp-btn pri caps" disabled={noCommit} title={`${MOD}Enter`} onClick={() => void commit()}>
                        {staged.length ? `✓ Commit staged (${staged.length})` : `✓ Commit ${plural(changed.size, "file")}`}
                      </button>
                    </div>
                  </div>
                </>)}
                </>)}
                {note && <div className="gp-note" onClick={() => setNote("")} title="dismiss">{note}</div>}
              </section>

              {/* the commits a push sends: hollow, as the graph draws them */}
              {localN > 0 && (
                <section className="gl-s">
                  <i className="gl-n out"><ArrowUp size={10} strokeWidth={2.6} /></i>
                  {card(step === "push", s.kind === "publish" ? "publish" : "push", <>
                  <div className="gl-h" {...foldHead("local", step !== "push" && !down)}>
                    <b>Ready to push</b><span>{plural(localN, "commit")}</span>
                    {up > 0 && !down && (
                      <span className="gl-r">
                        <button type="button" className={`gl-b ${step === "push" ? "pri" : "q"}`} disabled={busy || syncing}
                          onClick={() => void sync(s.kind === "publish" ? "publish" : "push", up)}>
                          <ArrowUp size={12} strokeWidth={2.6} />{s.kind === "publish" ? "Publish" : "Push"} {cap(up)}
                        </button>
                      </span>
                    )}
                  </div>
                  {(step === "push" || down > 0 || unfold.local) && stretch("local", local, localN, "out")}
                  </>)}
                </section>
              )}
              {!localN && !down && !!git.upstream && (
                <section className="gl-s"><i className="gl-n done"><Check size={10} strokeWidth={2.8} /></i><div className="gl-h"><b className="calm">All pushed</b></div></section>
              )}

              {/* what origin has that this branch doesn't: amber, it came from elsewhere */}
              {down > 0 && (
                <section className="gl-s">
                  <i className="gl-n in"><ArrowDown size={10} strokeWidth={2.6} /></i>
                  {card(true, s.kind === "diverged" ? "merge" : "pull", <>
                  <div className="gl-h">
                    <b>On origin, not here</b><span>{plural(down, "commit")}</span>
                    {s.kind === "behind" && (
                      <span className="gl-r">
                        <button type="button" className="gl-b warn" disabled={busy || syncing} onClick={() => void sync("pull", down)}>
                          <ArrowDown size={12} strokeWidth={2.6} />Pull {cap(down)}
                        </button>
                      </span>
                    )}
                  </div>
                  {incoming?.commits.slice(0, IN_ROWS).map((c) => (
                    <div key={c.sha} className="gl-c in" title={c.subject}><span>{c.subject}</span><em>{ago(c.ts)}</em></div>
                  ))}
                  {down > IN_ROWS && <button type="button" className="gl-c more in" onClick={() => setGrOpen(true)}><span>+{down - IN_ROWS} more in the graph</span></button>}
                  {s.kind === "diverged" && (<>
                    <div className="gl-acts">
                      <button type="button" className="gl-b warn" disabled={busy || syncing} onClick={() => mergeAct(false)}
                        title={clashN ? "Opens a new session with the merge as an unsent draft; it stops before pushing" : `Merge ${s.upstream}'s ${down} into this branch here. Pushing stays a separate step.`}>
                        {clashN ? <SquarePen size={12} strokeWidth={2.2} /> : <GitMerge size={12} strokeWidth={2.4} />}Merge {cap(down)}
                      </button>
                      <button type="button" className="gl-b soft" disabled={busy || syncing} onClick={() => mergeAct(true)}
                        title={clashN ? "Opens a new session with the merge as an unsent draft; it pushes at the end" : `Merge ${s.upstream}'s ${down} in, then push to origin`}>
                        {clashN ? <SquarePen size={12} strokeWidth={2.2} /> : <ArrowUpDown size={12} strokeWidth={2.4} />}Merge &amp; push
                      </button>
                    </div>
                    {chk && <div className={`gl-chk ${chk.tone}`}>{chk.tone === "ok" ? <Check size={12} strokeWidth={2.4} /> : <TriangleAlert size={12} strokeWidth={2.2} />}<span title={chk.text}>{chk.text}</span></div>}
                  </>)}
                  </>, true)}
                </section>
              )}

              <div className="gl-mk"><span className="gl-tag"><Cloud size={12} strokeWidth={2} />{originSays}</span>{when && <em>{unchecked ? "not checked" : when}</em>}</div>

              {/* on origin, but the base hasn't got it: the pull request's stretch */}
              {!!led?.base && (led.shipped_n > 0 || prInfo) && (
                <section className="gl-s">
                  <div className="gl-h" {...foldHead("shipped", step !== "pr" && !prInfo && !prForm && led.shipped_n > 0)}>
                    <b>Waiting for {led.base}</b>{led.shipped_n > 0 && <span>{led.shipped_n}</span>}
                    {led.shipped_n > 0 && (step !== "pr" || (!prInfo && !prForm)) && (
                      <span className="gl-r">
                        {step !== "pr" && (prInfo || prForm) && showLink("shipped")}
                        {!prInfo && !prForm && (
                        <button type="button" className={`gl-b ${step === "pr" ? "pri" : "q"}`} disabled={busy}
                          title={up ? "Opens a pull request for what origin has; push first to include the rest" : `Open a pull request into ${led.base}`}
                          onClick={() => setPrForm({ title: led.shipped.length === 1 ? led.shipped[0].subject : branchName.replace(/^[a-z]+\//, "").replace(/[-_]/g, " "),
                            body: [...led.shipped].reverse().map((c) => `- ${c.subject}`).join("\n") })}>
                          <GitPullRequest size={12} strokeWidth={2.2} />Open PR
                        </button>
                        )}
                      </span>
                    )}
                  </div>
                  {(step === "pr" || unfold.shipped) && stretch("shipped", led.shipped, led.shipped_n, "on")}
                  {prForm && (
                    <div className="gl-pr gl-form">
                      <input value={prForm.title} placeholder="Title" aria-label="Pull request title" onChange={(e) => setPrForm({ ...prForm, title: e.target.value })} />
                      <textarea value={prForm.body} rows={4} placeholder="What changed" aria-label="Pull request description" onChange={(e) => setPrForm({ ...prForm, body: e.target.value })} />
                      <div className="gl-acts">
                        <button type="button" className="gl-b pri" disabled={busy || !prForm.title.trim()} onClick={() => void openPr()}><GitPullRequest size={12} strokeWidth={2.2} />Open PR into {led.base}</button>
                        <button type="button" className="gl-b ghost" onClick={() => setPrForm(null)}>Cancel</button>
                      </div>
                    </div>
                  )}
                  {prInfo && card(step === "fix", prInfo.failed ? "fix a check" : "answer the review", (
                    <div className={step === "fix" ? "gl-pr in" : "gl-pr"}>
                      <div className="gl-pr-t" title={prInfo.title}>#{prInfo.number} · {prInfo.title}</div>
                      <div className="gl-pr-s">into {prInfo.base} · {stateLine(prInfo)}</div>
                      {[...prInfo.checks].sort((a, b) => Number(b.state === "fail") - Number(a.state === "fail")).slice(0, 6).map((c) => (
                        <div key={c.name + c.workflow} className={`gl-ck ${c.state}`} title={c.workflow}>
                          <i>{c.state === "pass" ? <Check size={9} strokeWidth={3.2} /> : c.state === "fail" ? <X size={9} strokeWidth={3.2} /> : null}</i>
                          <span>{c.name}</span><em>{c.state === "pass" ? "passed" : c.state === "fail" ? "failed" : "running"}</em>
                        </div>
                      ))}
                      <div className="gl-acts">
                        {prInfo.failed > 0 && onSend && (
                          <button type="button" className={`gl-b ${step === "fix" ? "ask" : "warn"} grow`} onClick={() => onSend(failureMessage(prInfo))}><Send size={12} strokeWidth={2} />Send failure to chat</button>
                        )}
                        {!prInfo.failed && prInfo.review && onSend && (
                          <button type="button" className={`gl-b ${step === "fix" ? "ask" : "warn"} grow`} onClick={() => onSend(commentsMessage(prInfo))}><Send size={12} strokeWidth={2} />Send comments to chat</button>
                        )}
                        <a className="gl-b ghost" href={prInfo.url} target="_blank" rel="noreferrer"><ExternalLink size={12} strokeWidth={2} />GitHub</a>
                      </div>
                    </div>
                  ), true)}
                </section>
              )}

              {/* the base: a menu, and whether it moved since */}
              {!!led?.base && (
                <div className="gl-mk">
                  <button type="button" className="gl-tag base" title="The branch this one is compared with. Click to change."
                    onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setBaseAt({ x: r.left, y: r.bottom + 4 }); }}>
                    <GitMerge size={12} strokeWidth={2} />{led.base}<ChevronDown size={10} strokeWidth={2.6} />
                  </button>
                  <em>{led.behind ? `moved ${led.behind}` : led.ahead ? "up to date" : "has all of this"}</em>
                  {led.behind > 0 && <button type="button" className="gl-lnk" disabled={busy} title={`Merge ${led.ref} into ${branchName} (a merge commit, never a rebase)`} onClick={() => void updateBase()}>Update</button>}
                </div>
              )}

              <section className="gl-s gl-foot">
                <button type="button" className="gl-c more dim" aria-expanded={grOpen} onClick={() => setGrOpen((v) => !v)}>
                  <span>Older history · Graph</span>{grOpen ? <ChevronDown size={11} strokeWidth={2.4} /> : <ChevronRight size={11} strokeWidth={2.4} />}
                </button>
              </section>
            </div>
            {grOpen && (
              <div className="gl-graph">
                <div className="gp-fh">
                  <b>Graph</b>
                  <span className="gp-acts">
                    <button className="gp-filter" title={branchOnly ? "showing this branch — click for every branch" : "showing every branch — click for this branch only"}
                      onClick={() => setBranchOnly((v) => !v)}>
                      <span>{branchOnly ? branchName || "this branch" : "all branches"}</span><ChevronDown size={10} strokeWidth={2} />
                    </button>
                  </span>
                </div>
                <CommitGraph project={project} branch={branchOnly ? branchName || undefined : undefined}
                  upstream={git?.upstream} ahead={ahead} behind={behind} nonce={nonce} />
              </div>
            )}
          </>)}
      </div>

      {ctx && (
        <ContextMenu ctx={{ x: ctx.x, y: ctx.y, type: ctx.path ? "file" : "folder", id: ctx.path, label: ctx.path || "all changes" }}
          items={ctxItems(ctx)} onClose={() => setCtx(null)} />
      )}
      {baseAt && led && (
        <ContextMenu ctx={{ x: baseAt.x, y: baseAt.y, type: "base", id: "base", label: `compare ${branchName} with` }}
          items={[
            ...led.branches.slice(0, 14).map((b): CtxItem => ({ icon: b === led.base ? "✓" : "⎇", label: b, onClick: () => void setBase(b) })),
            { divider: true },
            { icon: "↺", label: "Back to the project's default", onClick: () => void setBase(null) },
          ]} onClose={() => setBaseAt(null)} />
      )}
    </div>
  );
}
