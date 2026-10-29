import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowUp, BrushCleaning, ChevronDown, Ellipsis, ExternalLink, GitBranch, MessageSquare, Plus, Sparkle } from "lucide-react";
import { api, type SessionBrief, type SessionStatus } from "../../api";
import { branchGroups, facts, nextStep, type Activity, type BranchPr, type BranchStatus, type ShownRow, type Step } from "../../lib/branchrows";
import { conflictsMessage } from "../../lib/prchip";
import { askConfirm } from "../ui/Ask";
import type { CtxItem } from "./ContextMenu";
import { notify } from "./Notifications";

/* BRANCHES — the right rail's view of the open session's repo, for working on
   every branch from one place (.mystical/design-drafts/branches-actions, A).
   A row is two even lines: the name with its one next step (lib/branchrows
   nextStep) and ⋯; then who is working on it, else where it stands in a few
   words (facts). ⋯ and right-click open the app's context menu with the rest.
   ✦ steps start a fresh Claude session with a prompt, in the branch's
   worktree (merge and Open PR use the repo folder when it has none); push
   and clean up are git, behind a confirm when they delete anything.
   A click opens the branch's live session, else its newest; a branch with no
   session opens the menu. Hover a row for + Session.
   Rows and groups: lib/branchrows. Two bridge calls: git.branch_status, then
   the PRs (prstatus.branch_prs) for a repo with anything pushed. */

/** App's context menu asks here for a row's items: data-ctx-type="branch", data-ctx-id its key. */
export const branchMenu: { items: ((id: string) => CtxItem[]) | null } = { items: null };

const FOLD = 8;
const SEC: React.CSSProperties = { display: "flex", alignItems: "center", gap: 7, padding: "12px 14px 5px", fontSize: "var(--t9)", letterSpacing: 1.4, color: "var(--txl)" };
const MONO = "'JetBrains Mono',monospace";
const TONE = { warn: "var(--warn)", err: "var(--err)", merged: "var(--purple-h)" };
const keyOf = (r: ShownRow) => r.name || `@${r.worktree}`;
const plural = (n: number, w: string, ws = `${w}s`) => `${n} ${n === 1 ? w : ws}`;
type Ask = "commit" | "update" | "merge" | "openpr" | "resolve" | "fix";

/** A step's pill. Sparkle (✦) marks one a Claude session does. */
function stepLook(s: Step, r: ShownRow): { t: string; c?: string; ai?: boolean; Icon: typeof Plus } {
  switch (s) {
    case "answer": return { t: "Answer", c: "var(--ask, var(--warn))", Icon: MessageSquare };
    case "cleanup": return { t: "Clean up", c: "var(--purple-h)", Icon: BrushCleaning };
    case "push": return { t: `Push ${r.unpushed}`, Icon: ArrowUp };
    case "pr": return { t: `PR #${r.pr?.number}`, Icon: ExternalLink };
    case "resolve": return { t: "Resolve", c: "var(--warn)", ai: true, Icon: Sparkle };
    case "fix": return { t: "Fix checks", c: "var(--err)", ai: true, Icon: Sparkle };
    case "openpr": return { t: "Open PR", ai: true, Icon: Sparkle };
    case "commit": return { t: "Commit", ai: true, Icon: Sparkle };
    case "merge": return { t: "Merge", ai: true, Icon: Sparkle };
  }
}

function Row({ r, base, sess, live, busy, onOpen, onNew, onStep }: {
  r: ShownRow; base: string; sess: SessionBrief[]; live: SessionBrief | undefined; busy: boolean;
  onOpen: (s: SessionBrief) => void; onNew: (r: ShownRow) => void; onStep: (s: Step) => void;
}) {
  const dot = r.activity === "asking" ? "var(--ask, var(--warn))" : r.activity === "working" ? "var(--ok)" : null;
  const tone = r.activity === "asking" ? "var(--ask, var(--warn))" : "var(--ok)";
  const step = nextStep(r);
  const look = step && stepLook(step, r);
  const go = live ?? sess[0];
  // The menu is the app's right-click menu, opened where asked: the window listener reads data-ctx-* off the row.
  const menu = (el: HTMLElement, x: number, y: number) => el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: x, clientY: y }));
  return (
    <div className="brow" data-here={r.here || undefined} data-ctx-type="branch" data-ctx-id={keyOf(r)} data-ctx-label={r.name || r.label}
      onClick={(e) => { if (go) onOpen(go); else menu(e.currentTarget, e.clientX, e.clientY); }}
      title={[r.name || `detached at ${r.head}`, r.worktree, go ? `click: ${live ? "its session" : "its newest session"}` : "click: its actions"].filter(Boolean).join("\n")}>
      <div className="brow-l1">
        {dot ? (
          <span className={r.activity === "working" ? "sessdot" : undefined} data-work={r.activity === "working" || undefined}
            style={{ flex: "none", width: 7, height: 7, borderRadius: "50%", background: dot, boxShadow: `0 0 6px color-mix(in srgb, ${dot} 50%, transparent)` }} />
        ) : (
          <span style={{ flex: "none", width: 7, height: 7, boxSizing: "border-box", borderRadius: "50%", border: "1.5px solid color-mix(in srgb, var(--txd) 80%, transparent)" }} />
        )}
        <span style={{ fontFamily: MONO, fontSize: "var(--t105)", color: "var(--txb)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.label}</span>
        <span className="brow-acts">
          {/* + Session sits over the name's tail while you hover, so nothing moves */}
          <button className="rowact brow-plus" onClick={(e) => { e.stopPropagation(); onNew(r); }} aria-label="New session"
            title={r.worktree ? `New session in ${r.worktree}` : `Check ${r.name} out into a new worktree and start a session there`}>
            <Plus size={11} strokeWidth={2.6} aria-hidden />
          </button>
          {look && (
            <button className="brow-step" data-ai={look.ai || undefined} data-tone={look.c ? true : undefined} disabled={busy} onClick={(e) => { e.stopPropagation(); onStep(step!); }}
              style={look.c ? { ["--c" as string]: look.c } : undefined}>
              <look.Icon size={10} strokeWidth={2.2} aria-hidden />{look.t}
            </button>
          )}
          <button className="brow-more" aria-label="Actions" title="Every action for this branch"
            onClick={(e) => { e.stopPropagation(); const b = e.currentTarget.getBoundingClientRect(); menu(e.currentTarget, b.right - 216, b.bottom + 4); }}>
            <Ellipsis size={13} strokeWidth={2.2} aria-hidden />
          </button>
        </span>
      </div>
      <div className="brow-l2">
        {live ? (
          <>
            <MessageSquare size={12} strokeWidth={2} aria-hidden style={{ flex: "none", color: tone }} />
            <span className="t" style={{ color: tone }}>{live.title || "fresh session"}</span>
            <span style={{ flex: "none", color: tone }}>{r.activity === "asking" ? "waits on you" : "working"}</span>
          </>
        ) : (
          <span className="t">
            {facts(r, base).map((f, i) => (
              <span key={i}>{i > 0 && <i>·</i>}<span style={f.tone ? { color: TONE[f.tone] } : undefined}>{f.t}</span></span>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

function Group({ title, rows, fold, bulk, render }: { title: string; rows: ShownRow[]; fold?: boolean; bulk?: ReactNode; render: (r: ShownRow) => ReactNode }) {
  const [all, setAll] = useState(false);
  if (!rows.length) return null;
  const shown = fold && !all ? rows.slice(0, FOLD) : rows;
  return (
    <>
      <div style={SEC}>{title}<span style={{ color: "var(--txd)" }}>{rows.length}</span>{bulk}</div>
      {shown.map(render)}
      {shown.length < rows.length && (
        <button onClick={() => setAll(true)}
          style={{ appearance: "none", border: 0, background: "transparent", cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t95)", color: "var(--txd)", padding: "6px 16px" }}>
          {rows.length - shown.length} more ↓
        </button>
      )}
    </>
  );
}

export function BranchesPanel({ project, branch, sessions, status, nonce, onOpen, onNew, onNewBranch, onAsk }: {
  project: string | null;
  branch?: string;                        // the open session's: HERE
  sessions: SessionBrief[];
  status: Map<string, SessionStatus>;
  nonce: number;                          // App's gitNonce: a commit, a push, a checkout
  onOpen: (s: SessionBrief) => void;
  onNew: (r: ShownRow) => void;           // + Session on a row
  onNewBranch: (name: string, from: string) => void;
  onAsk: (prompt: string, cwd?: string) => void;   // ✦: a fresh session there (the repo folder without a cwd), the prompt first
}) {
  const [data, setData] = useState<BranchStatus | null>(null);
  const [prs, setPrs] = useState<Record<string, BranchPr>>({});
  const [err, setErr] = useState("");
  const [hov, setHov] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [from, setFrom] = useState("");
  const [busy, setBusy] = useState("");   // the row whose git step is running

  const load = useCallback(async () => {
    if (!project) return;
    try {
      const d = await api.branchStatus(project);
      setData(d); setErr("");
      // gh only for a repo with something pushed: a local-only one has no PRs to find
      if (!d.branches.some((b) => b.upstream && b.name !== d.base)) setPrs({});
      else void api.branchPrs(project).then((r) => setPrs(r.prs ?? {}), () => setPrs({}));
    } catch (e) { setErr((e as Error).message); }
  }, [project]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 30000);
    return () => clearInterval(id);
  }, [load, nonce]);

  // Each branch's sessions, newest first, and the one busy there: waiting on you outranks working.
  const { activity, byBranch, live } = useMemo(() => {
    const activity = new Map<string, Activity>(), byBranch = new Map<string, SessionBrief[]>(), live = new Map<string, SessionBrief>();
    for (const s of sessions) {
      if (s.project !== project || !s.branch || s.archived) continue;
      (byBranch.get(s.branch) ?? byBranch.set(s.branch, []).get(s.branch)!).push(s);
      const st = status.get(s.id)?.state;
      if (st === "awaiting" || st === "asking") { activity.set(s.branch, "asking"); live.set(s.branch, s); }
      else if ((st === "working" || st === "checking") && activity.get(s.branch) !== "asking") { activity.set(s.branch, "working"); live.set(s.branch, s); }
    }
    for (const l of byBranch.values()) l.sort((a, b) => b.updated - a.updated);
    return { activity, byBranch, live };
  }, [sessions, status, project]);

  const base = data?.base ?? "";
  const g = useMemo(() => branchGroups(data?.branches ?? [], base, branch ?? null, activity, prs), [data, base, branch, activity, prs]);

  // A git step: say how it went, then read the branches again.
  async function run(r: ShownRow, p: Promise<{ ok: boolean; output: string }>, done: string, what: string) {
    setBusy(keyOf(r));
    const res = await p.catch((e: Error) => ({ ok: false, output: e.message }));
    setBusy("");
    notify(res.ok ? "info" : "error", res.ok ? done : `${what} failed: ${res.output}`);
    void load();
  }
  const push = (r: ShownRow) => run(r, api.gitPush(project!, r.name), `Pushed ${r.name}.`, "Push");
  async function cleanup(r: ShownRow) {
    const dirty = r.dirty ? ` Its ${plural(r.dirty, "uncommitted file")} go too.` : "";
    if (!(await askConfirm(`${r.worktree ? `Remove the ${r.label} worktree and delete` : "Delete"} ${r.name}? Its work is in ${base}.${dirty}`,
      { ok: "Clean up", danger: !!r.dirty }))) return;
    // A squash merge leaves commits git can't find in the base, so -d would refuse: its PR merged at the tip says it's done.
    await run(r, r.worktree ? api.worktreeRemove(project!, r.worktree, r.name, true) : api.deleteBranch(project!, r.name, !r.merged),
      `Cleaned up ${r.name}.`, "Clean up");
  }
  async function removeTree(r: ShownRow) {
    if (!(await askConfirm(`Remove the worktree at ${r.worktree}?${r.dirty ? ` Its ${plural(r.dirty, "uncommitted file")} are deleted.` : ""} The branch stays.`,
      { ok: "Remove", danger: true }))) return;
    await run(r, api.worktreeRemove(project!, r.worktree!, r.name || undefined, false), `Removed the ${r.label} worktree.`, "Remove");
  }
  async function del(r: ShownRow) {
    const lost = r.ahead ? ` Its ${plural(r.ahead, "commit")} not in ${base} go${r.upstream ? " here; origin keeps what was pushed" : " for good"}.` : "";
    const tree = r.worktree ? ` Its worktree goes too${r.dirty ? `, with ${plural(r.dirty, "uncommitted file")}` : ""}.` : "";
    if (!(await askConfirm(`Delete ${r.name}?${lost}${tree}`, { ok: "Delete", danger: true }))) return;
    await run(r, r.worktree ? api.worktreeRemove(project!, r.worktree, r.name, true) : api.deleteBranch(project!, r.name, true),
      `Deleted ${r.name}.`, "Delete");
  }
  async function cleanAll(rows: ShownRow[]) {
    if (!(await askConfirm(`Delete ${plural(rows.length, "merged branch", "merged branches")}? Their work is in ${base}.`, { ok: "Clean up" }))) return;
    let bad = 0;
    for (const r of rows) if (!(await api.deleteBranch(project!, r.name, !r.merged).catch(() => ({ ok: false }))).ok) bad++;
    notify(bad ? "error" : "info", bad ? `${bad} of ${rows.length} merged branches wouldn't delete.` : `Deleted ${plural(rows.length, "merged branch", "merged branches")}.`);
    void load();
  }
  // ✦: a fresh session does it in the branch's checkout. Merge and Open PR go from the repo folder when there's none.
  function ask(s: Ask, r: ShownRow) {
    const n = r.name, pr = r.pr;
    const text: Record<Ask, string> = {
      commit: `Commit the uncommitted changes on ${n}: look at what changed, then commit with a short message. Don't push.`,
      update: `Bring ${n} up to date with ${base}: merge ${base} in, resolve any conflicts, make sure the build and tests pass, then commit. Don't push.`,
      merge: `Merge ${n} into ${base} the way this repo does it, resolve any conflicts, and make sure the build and tests pass. Don't push.`,
      openpr: `Open a pull request for ${n} into ${base}: push it, then write the title and description from its commits.`,
      resolve: pr ? conflictsMessage({ number: pr.number, head: n, base, url: pr.url ?? "" }) : "",
      fix: pr ? `Checks failed on PR #${pr.number} · ⎇ ${n}: ${pr.url ?? ""}\nRead the failing checks with gh, fix the cause, make sure the build and tests pass, then commit and push.` : "",
    };
    if (text[s]) onAsk(text[s], s === "merge" ? undefined : r.worktree ?? undefined);
  }
  function onStep(r: ShownRow, s: Step) {
    if (s === "answer") { const l = live.get(r.name); if (l) onOpen(l); }
    else if (s === "pr") { if (r.pr?.url) window.open(r.pr.url, "_blank", "noopener"); }
    else if (s === "push") void push(r);
    else if (s === "cleanup") void cleanup(r);
    else ask(s, r);
  }

  // ⋯ and right-click: everything that applies, sessions first, then git, then copy and the destructive ones.
  function menuFor(r: ShownRow): CtxItem[] {
    const l = r.name ? live.get(r.name) : undefined;
    const go = l ?? ((r.name && byBranch.get(r.name)?.[0]) || undefined);
    const items: CtxItem[] = [];
    if (go) items.push({ icon: "▸", label: l ? "Open its session" : "Open newest session", hint: l ? (r.activity === "asking" ? "WAITS" : "LIVE") : undefined, onClick: () => onOpen(go) });
    items.push({ icon: "+", label: "New session", hint: r.worktree ? undefined : "NEW WORKTREE", onClick: () => onNew(r) });
    const git: CtxItem[] = [];
    if (r.worktree && r.name && (r.upstream ? !!r.unpushed : !r.base))
      git.push({ icon: "↑", label: r.upstream ? "Push" : "Publish", hint: r.upstream ? `↑${r.unpushed}` : "ORIGIN", onClick: () => void push(r) });
    if (r.worktree && r.dirty) git.push({ icon: "✦", label: "Commit changes", hint: `${r.dirty} FILES`, onClick: () => ask("commit", r) });
    if (r.worktree && r.name && r.behind && !r.base) git.push({ icon: "✦", label: `Update from ${base}`, hint: `↓${r.behind}`, onClick: () => ask("update", r) });
    if (r.name && r.ahead && !r.base && !r.landed) git.push({ icon: "✦", label: `Merge into ${base}`, hint: `↑${r.ahead}`, onClick: () => ask("merge", r) });
    const url = r.pr?.state === "OPEN" ? r.pr.url : undefined;
    if (url) git.push({ icon: "↗", label: `PR #${r.pr!.number} on GitHub`, onClick: () => window.open(url, "_blank", "noopener") });
    else if (r.name && r.ahead && !r.base && !r.landed && !r.pr) git.push({ icon: "✦", label: "Open a PR", onClick: () => ask("openpr", r) });
    if (r.worktree && r.pr?.status === "conflicts") git.push({ icon: "✦", label: "Resolve conflicts", onClick: () => ask("resolve", r) });
    if (r.worktree && r.pr?.status === "failing") git.push({ icon: "✦", label: "Fix failing checks", hint: `${r.pr.failed}`, onClick: () => ask("fix", r) });
    if (r.landed && !r.main) git.push({ icon: "⌫", label: "Clean up", hint: "MERGED", onClick: () => void cleanup(r) });
    if (git.length) items.push({ divider: true }, ...git);
    const tail: CtxItem[] = [];
    if (r.name) tail.push({ icon: "⧉", label: "Copy name", onClick: () => void navigator.clipboard.writeText(r.name).then(() => notify("info", `Copied ${r.name}.`), () => notify("error", "Couldn't copy.")) });
    // nothing destructive while a session works or waits there, and never the repo folder itself
    if (!r.activity && !r.main && !r.landed) {
      if (r.worktree) tail.push({ icon: "⊘", label: "Remove worktree", hint: r.dirty ? `${r.dirty} DIRTY` : undefined, danger: true, onClick: () => void removeTree(r) });
      if (r.name && !r.base) tail.push({ icon: "✕", label: "Delete branch…", hint: r.merged ? undefined : "UNMERGED", danger: true, onClick: () => void del(r) });
    }
    if (tail.length) items.push({ divider: true }, ...tail);
    return items;
  }
  useEffect(() => {
    branchMenu.items = (id) => { const r = g.all.find((x) => keyOf(x) === id); return r ? menuFor(r) : []; };
    return () => { branchMenu.items = null; };
  });

  const row = (r: ShownRow) => (
    <Row key={keyOf(r)} r={r} base={base} sess={(r.name && byBranch.get(r.name)) || []} live={r.name ? live.get(r.name) : undefined}
      busy={busy === keyOf(r)} onOpen={onOpen} onNew={onNew} onStep={(s) => onStep(r, s)} />
  );
  const make = () => {
    const n = name.trim();
    if (!n) return;
    onNewBranch(n, from || base);
    setNaming(false); setName("");
  };
  const btn: React.CSSProperties = { appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)", background: "transparent", color: "var(--txm)", fontFamily: "inherit", fontSize: "var(--t95)", lineHeight: 1.3, padding: "2px 6px" };

  return (
    <div className="panel" style={{ border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", background: "color-mix(in srgb, var(--panel) 86%, transparent)", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px" }}>
        <span style={{ fontSize: "var(--t105)", letterSpacing: 2.5, color: "var(--txl)" }}>BRANCHES</span>
        {base && <span className="bhead-base swapin"><GitBranch size={10} strokeWidth={2.2} aria-hidden />{base}</span>}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: "auto" }}>
          {project && data && data.branches.length > 0 && (
            <button onClick={() => setNaming((v) => !v)} aria-expanded={naming} title="A new branch in its own worktree, and a session there"
              style={{ ...btn, display: "inline-flex", alignItems: "center", gap: 5, fontSize: "var(--t9)",
                       ...(naming ? { color: "var(--acc)", background: "color-mix(in srgb, var(--acc) 12%, transparent)" } : {}) }}>
              <Plus size={10} strokeWidth={2.6} aria-hidden />Branch
            </button>
          )}
          <button onClick={() => void load()} title="refresh" onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
            style={{ ...btn, background: hov ? "color-mix(in srgb, var(--acc) 10%, transparent)" : "transparent" }}>⟳</button>
        </span>
      </div>
      <div style={{ height: 1, background: "linear-gradient(90deg,var(--acc),transparent)" }} />
      {naming && (
        <>
          <form className="bnew" onSubmit={(e) => { e.preventDefault(); make(); }}>
            <GitBranch size={11} strokeWidth={2.2} aria-hidden style={{ flex: "none", color: "var(--txl)" }} />
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="new branch name…" aria-label="New branch name"
              onKeyDown={(e) => { if (e.key === "Escape") { setNaming(false); setName(""); } }} />
            {/* the chip shows the pick; the native select, invisible on top, does the picking */}
            <label className="bnew-from" title="The branch it starts from">from
              <span className="bnew-base"><GitBranch size={10} strokeWidth={2.2} aria-hidden style={{ flex: "none", color: "var(--purple)" }} />
                <span className="v">{from || base}</span><ChevronDown size={10} strokeWidth={2.4} aria-hidden style={{ flex: "none" }} /></span>
              <select value={from || base} onChange={(e) => setFrom(e.target.value)} aria-label="Start from">
                {(data?.branches ?? []).filter((b) => b.name).map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
              </select>
            </label>
            <button type="submit" className="bnew-kbd" aria-label="Create the branch and start a session" disabled={!name.trim()}>↵</button>
          </form>
          <div style={{ margin: "5px 14px 0 21px", fontSize: "var(--t9)", color: "var(--txd)" }}>makes the worktree, opens a session there · esc closes</div>
        </>
      )}
      <div className="mscroll" style={{ padding: "4px 0 14px", flex: 1, minHeight: 0, overflowY: "auto" }}>
        {!project && <div style={{ fontSize: "var(--t105)", color: "var(--txl)", padding: "8px 14px" }}>No session selected.</div>}
        {project && err && <div style={{ fontSize: "var(--t105)", color: "var(--err)", padding: "8px 14px" }}>Couldn't read the branches: {err}</div>}
        {project && !err && !data && <div style={{ fontSize: "var(--t105)", color: "var(--txl)", padding: "8px 14px" }}>Reading branches…</div>}
        {project && data && !data.branches.length && (
          <div style={{ fontSize: "var(--t105)", color: "var(--txl)", padding: "8px 14px" }}>No branches: not a git repo?</div>
        )}
        <div className="swapin">
          <Group title="WORKTREES" rows={g.worktrees} render={row} />
          <Group title="BRANCHES" rows={g.branches} render={row} fold />
          <Group title="MERGED" rows={g.merged} render={row} fold
            bulk={g.merged.length > 1 && (
              <button className="brow-step bsec-bulk" data-tone style={{ ["--c" as string]: "var(--purple-h)" }} onClick={() => void cleanAll(g.merged)}>
                <BrushCleaning size={10} strokeWidth={2.2} aria-hidden />Clean up all
              </button>
            )} />
        </div>
      </div>
    </div>
  );
}
