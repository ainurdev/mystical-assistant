import { useEffect, useRef, useState, type DragEvent } from "react";
import { ArrowUp, BrushCleaning, Check, ChevronDown, Cloud, Ellipsis, ExternalLink, GitBranch, GitMerge, GripVertical,
  MessageSquare, Plus, RefreshCw, Sparkle } from "lucide-react";
import { api, type SessionBrief } from "../../api";
import { facts, landList, landPrompt, mergePrompt, nextStep, type Node as TreeNode, type ShownRow, type Step } from "../../lib/branchrows";
import { conflictsMessage } from "../../lib/prchip";
import { askConfirm } from "../ui/Ask";
import type { CtxItem } from "./ContextMenu";
import { notify } from "./Notifications";
import { TabKick } from "./TabKick";

/* BRANCHES — the right rail's view of the open session's repo as a TREE
   (.mystical/design-drafts/branches-reimagine, A): each branch hangs under the
   branch it goes into (lib/branchrows), and the parent says that target once
   and offers Land N for its idle children. A row is two even lines: the name
   with its one next step and ⋯, then who is working on it, else where it stands.
   Land = one fresh session merges it into its target, runs the checks, then
   removes the worktree and branch (landPrompt). Drag a row onto another to
   merge it there; it asks first. ⋯ and right-click open the app's context menu
   with the rest: Land, Merge only, Merge into ▸, Target ▸, git and copy.
   A click opens the branch's live session, else its newest; a branch with no
   session opens the menu. Hover a row for + Session.
   Landed children fold into one line; with the broom on (App's useAutoClean)
   the ones nothing holds go by themselves. App owns the data (useBranches). */

/** App's context menu asks here for a row's items: data-ctx-type="branch", data-ctx-id its key. */
export const branchMenu: { items: ((id: string) => CtxItem[]) | null } = { items: null };

export interface BranchView {
  base: string;
  rows: ShownRow[];
  tree: TreeNode[];
  picks: Record<string, string>;
  live: Map<string, SessionBrief>;
  byBranch: Map<string, SessionBrief[]>;
}

const MONO = "'JetBrains Mono',monospace";
const TONE = { warn: "var(--warn)", err: "var(--err)", merged: "var(--purple-h)", ok: "var(--ok)" };
const keyOf = (r: ShownRow) => r.name || `@${r.worktree}`;
const plural = (n: number, w: string, ws = `${w}s`) => `${n} ${n === 1 ? w : ws}`;
const short = (t: string) => t.replace(/^origin\//, "");
type Ask = "commit" | "update" | "openpr" | "resolve" | "fix";

/** A step's pill. Sparkle (✦) marks one a Claude session does; Land is one too, with its own mark. */
function stepLook(s: Step, r: ShownRow): { t: string; c?: string; ai?: boolean; Icon: typeof Plus } {
  switch (s) {
    case "answer": return { t: "Answer", c: "var(--ask, var(--warn))", Icon: MessageSquare };
    case "cleanup": return { t: "Clean up", c: "var(--purple-h)", Icon: BrushCleaning };
    case "push": return { t: `Push ${r.unpushed}`, Icon: ArrowUp };
    case "pr": return { t: `PR #${r.pr?.number}`, Icon: ExternalLink };
    case "resolve": return { t: "Resolve", c: "var(--warn)", ai: true, Icon: Sparkle };
    case "fix": return { t: "Fix checks", c: "var(--err)", ai: true, Icon: Sparkle };
    case "commit": return { t: "Commit", ai: true, Icon: Sparkle };
    case "land": return { t: "Land", c: "var(--acc)", Icon: GitMerge };
  }
}

export function BranchesPanel({ project, view, err, onReload, autoClean, onAutoClean, onOpen, onNew, onNewBranch, onAsk }: {
  project: string | null;
  view: BranchView | null;                // App's: rows, tree and who's on each (useBranches)
  err: string;
  onReload: () => void;
  autoClean: boolean;                     // the broom: landed branches go by themselves
  onAutoClean: (on: boolean) => void;
  onOpen: (s: SessionBrief) => void;
  onNew: (r: ShownRow) => void;           // + Session on a row
  onNewBranch: (name: string, from: string) => void;
  onAsk: (prompt: string, cwd?: string) => void;   // a fresh session there (the repo folder without a cwd), the prompt first
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [from, setFrom] = useState("");
  const [busy, setBusy] = useState("");   // the row whose git step is running
  const [folds, setFolds] = useState<Set<string>>(new Set());   // parents whose landed line is open
  const [pop, setPop] = useState<{ into: string; take: ShownRow[]; held: { row: ShownRow; why: string }[]; y: number } | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<ShownRow | null>(null);
  const [over, setOver] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { setPop(null); setFolds(new Set()); }, [project]);

  const base = view?.base ?? "";
  const rows = view?.rows ?? [];
  const byName = (n: string) => rows.find((x) => x.name === short(n));
  // A merge runs where its target is checked out: a worktree's own folder, else the repo folder.
  const cwdFor = (into: string) => { const t = byName(into); return t?.worktree && !t.main ? t.worktree : undefined; };

  // A git step: say how it went, then read the branches again.
  async function run(r: ShownRow, p: Promise<{ ok: boolean; output: string }>, done: string, what: string) {
    setBusy(keyOf(r));
    const res = await p.catch((e: Error) => ({ ok: false, output: e.message }));
    setBusy("");
    notify(res.ok ? "info" : "error", res.ok ? done : `${what} failed: ${res.output}`);
    onReload();
  }
  const push = (r: ShownRow) => run(r, api.gitPush(project!, r.name), `Pushed ${r.name}.`, "Push");
  // a worktree's scratch (.mystical, .superpowers) is archived before it goes (bridge git.archive_scratch)
  const drop = (r: ShownRow, force: boolean) => r.worktree ? api.worktreeRemove(project!, r.worktree, r.name, true, true)
    : api.deleteBranch(project!, r.name, force);
  async function cleanup(r: ShownRow) {
    const dirty = r.dirty ? ` Its ${plural(r.dirty, "uncommitted file")} go too.` : "";
    if (!(await askConfirm(`${r.worktree ? `Remove the ${r.label} worktree and delete` : "Delete"} ${r.name}? Its work is in ${short(r.into)}.${dirty}`,
      { ok: "Clean up", danger: !!r.dirty }))) return;
    // A squash merge leaves commits git can't find in the target, so -d would refuse: its PR merged at the tip says it's done.
    await run(r, drop(r, !r.merged), `Cleaned up ${r.name}.`, "Clean up");
  }
  async function cleanAll(gone: ShownRow[], into: string) {
    const dirty = gone.reduce((n, r) => n + (r.dirty ?? 0), 0);
    if (!(await askConfirm(`Clean up ${plural(gone.length, "landed branch", "landed branches")}? Their work is in ${short(into)}.`
      + (dirty ? ` ${plural(dirty, "uncommitted file")} go too.` : ""), { ok: "Clean up", danger: !!dirty }))) return;
    let bad = 0;
    for (const r of gone) if (!(await drop(r, !r.merged).catch(() => ({ ok: false }))).ok) bad++;
    notify(bad ? "error" : "info", bad ? `${bad} of ${gone.length} landed branches wouldn't go.` : `Cleaned up ${plural(gone.length, "landed branch", "landed branches")}.`);
    onReload();
  }
  async function removeTree(r: ShownRow) {
    if (!(await askConfirm(`Remove the worktree at ${r.worktree}?${r.dirty ? ` Its ${plural(r.dirty, "uncommitted file")} are deleted.` : ""} The branch stays.`,
      { ok: "Remove", danger: true }))) return;
    await run(r, api.worktreeRemove(project!, r.worktree!, r.name || undefined, false, true), `Removed the ${r.label} worktree.`, "Remove");
  }
  async function del(r: ShownRow) {
    const lost = r.ahead ? ` Its ${plural(r.ahead, "commit")} not in ${short(r.into) || base} go${r.upstream ? " here; origin keeps what was pushed" : " for good"}.` : "";
    const tree = r.worktree ? ` Its worktree goes too${r.dirty ? `, with ${plural(r.dirty, "uncommitted file")}` : ""}.` : "";
    if (!(await askConfirm(`Delete ${r.name}?${lost}${tree}`, { ok: "Delete", danger: true }))) return;
    await run(r, drop(r, true), `Deleted ${r.name}.`, "Delete");
  }
  async function setTarget(r: ShownRow, target: string | null) {
    const res = await api.setBranchTarget(project!, r.name, target).catch((e: Error) => ({ error: e.message }));
    if ("error" in res) notify("error", `Couldn't change the target: ${res.error}`);
    else notify("info", target === null ? `${r.name} goes where it was made again.` : target ? `${r.name} now goes into ${target}.` : `${r.name} goes nowhere now.`);
    onReload();
  }
  async function mergeInto(r: ShownRow, into: ShownRow) {
    const landing = short(r.into) === into.name;
    if (!(await askConfirm(landing ? `Land ${r.name} in ${into.name}? A session merges it, runs the checks, then cleans it up.`
      : `Merge ${r.name} into ${into.name}, then clean up ${r.name}? A session does it and runs the checks.`, { ok: landing ? "Land" : "Merge" }))) return;
    onAsk(landing ? landPrompt([r], into.name) : mergePrompt(r, into.name), cwdFor(into.name));
  }
  // ✦: a fresh session does it in the branch's checkout. Open PR goes from the repo folder when there's none.
  function ask(s: Ask, r: ShownRow) {
    const n = r.name, pr = r.pr, into = short(r.into) || base;
    const text: Record<Ask, string> = {
      commit: `Commit the uncommitted changes on ${n}: look at what changed, then commit with a short message. Don't push.`,
      update: `Bring ${n} up to date with ${into}: merge ${into} in, resolve any conflicts, make sure the build and tests pass, then commit. Don't push.`,
      openpr: `Open a pull request for ${n} into ${into}: push it, then write the title and description from its commits.`,
      resolve: pr ? conflictsMessage({ number: pr.number, head: n, base: pr.base || into, url: pr.url ?? "" }) : "",
      fix: pr ? `Checks failed on PR #${pr.number} · ⎇ ${n}: ${pr.url ?? ""}\nRead the failing checks with gh, fix the cause, make sure the build and tests pass, then commit and push.` : "",
    };
    if (text[s]) onAsk(text[s], r.worktree ?? undefined);
  }
  function onStep(r: ShownRow, s: Step) {
    if (s === "answer") { const l = view?.live.get(r.name); if (l) onOpen(l); }
    else if (s === "pr") { if (r.pr?.url) window.open(r.pr.url, "_blank", "noopener"); }
    else if (s === "push") void push(r);
    else if (s === "cleanup") void cleanup(r);
    else if (s === "land") onAsk(landPrompt([r], r.into), cwdFor(r.into));
    else ask(s, r);
  }
  function openLand(n: TreeNode, el: HTMLElement) {
    const { take, held } = landList(n);
    const box = panel.current?.getBoundingClientRect(), b = el.getBoundingClientRect();
    setTicked(new Set(take.map((r) => r.name)));
    setPop({ into: n.row.name, take, held, y: b.bottom - (box?.top ?? 0) + 6 });
  }

  // ⋯ and right-click: everything that applies, sessions first, then landing and git, then copy and the destructive ones.
  function menuFor(r: ShownRow): CtxItem[] {
    const l = r.name ? view?.live.get(r.name) : undefined;
    const go = l ?? ((r.name && view?.byBranch.get(r.name)?.[0]) || undefined);
    const into = short(r.into);
    const items: CtxItem[] = [];
    if (go) items.push({ icon: "▸", label: l ? "Open its session" : "Open newest session", hint: l ? (r.activity === "asking" ? "WAITS" : "LIVE") : undefined, onClick: () => onOpen(go) });
    if (!r.remote) items.push({ icon: "+", label: "New session", hint: r.worktree ? undefined : "NEW WORKTREE", onClick: () => onNew(r) });
    const others = rows.filter((o) => o.name && o.name !== r.name);
    const git: CtxItem[] = [];
    if (nextStep(r) === "land") git.push({ icon: "⤵", label: `Land in ${into}`, hint: r.clash?.length ? `${r.clash.length} CLASH` : r.clash ? "CLEAN" : undefined,
      onClick: () => onAsk(landPrompt([r], r.into), cwdFor(r.into)) });
    if (r.name && into && r.ahead && !r.landed && !r.activity)
      git.push({ icon: "⤵", label: "Merge only, keep it", onClick: () => onAsk(mergePrompt(r, into, true), cwdFor(into)) });
    if (r.name && !r.base && !r.main && !r.remote && !r.activity && others.length)
      git.push({ icon: "⤵", label: "Merge into", hint: "▸", children: others.map((o) => ({ icon: "⎇", label: o.name,
        hint: o.activity === "asking" ? "WAITS" : o.activity ? "WORKING" : o.base ? "BASE" : undefined, onClick: () => void mergeInto(r, o) })) });
    if (r.name && !r.base && !r.remote) git.push({ icon: "◎", label: `Target: ${into || "none"}`, hint: "▸", children: [
      ...others.filter((o) => !o.remote).map((o) => ({ icon: "⎇", label: o.name, hint: o.name === into ? "NOW" : undefined, onClick: () => void setTarget(r, o.name) })),
      { divider: true }, { icon: "∅", label: "None, it stays", hint: !into ? "NOW" : undefined, onClick: () => void setTarget(r, "") },
      ...(view?.picks && r.name in view.picks ? [{ icon: "↺", label: "Back to where it was made", onClick: () => void setTarget(r, null) }] : []),
    ] });
    if (r.worktree && r.name && (r.upstream ? !!r.unpushed : !r.base))
      git.push({ icon: "↑", label: r.upstream ? "Push" : "Publish", hint: r.upstream ? `↑${r.unpushed}` : "ORIGIN", onClick: () => void push(r) });
    if (r.worktree && r.dirty) git.push({ icon: "✦", label: "Commit changes", hint: `${r.dirty} FILES`, onClick: () => ask("commit", r) });
    if (r.worktree && r.name && r.behind && into && !r.landed) git.push({ icon: "✦", label: `Update from ${into}`, hint: `↓${r.behind}`, onClick: () => ask("update", r) });
    const url = r.pr?.state === "OPEN" ? r.pr.url : undefined;
    if (url) git.push({ icon: "↗", label: `PR #${r.pr!.number} on GitHub`, onClick: () => window.open(url, "_blank", "noopener") });
    else if (r.name && r.ahead && into && !r.landed && !r.pr) git.push({ icon: "✦", label: "Open a PR", onClick: () => ask("openpr", r) });
    if (r.worktree && r.pr?.status === "conflicts") git.push({ icon: "✦", label: "Resolve conflicts", onClick: () => ask("resolve", r) });
    if (r.worktree && r.pr?.status === "failing") git.push({ icon: "✦", label: "Fix failing checks", hint: `${r.pr.failed}`, onClick: () => ask("fix", r) });
    if (r.landed && !r.main) git.push({ icon: "⌫", label: "Clean up", hint: "LANDED", onClick: () => void cleanup(r) });
    if (git.length) items.push({ divider: true }, ...git);
    const tail: CtxItem[] = [];
    if (r.name) tail.push({ icon: "⧉", label: "Copy name", onClick: () => void navigator.clipboard.writeText(r.name).then(() => notify("info", `Copied ${r.name}.`), () => notify("error", "Couldn't copy.")) });
    // nothing destructive while a session works or waits there, and never the repo folder itself
    if (!r.activity && !r.main && !r.landed && !r.remote) {
      if (r.worktree) tail.push({ icon: "⊘", label: "Remove worktree", hint: r.dirty ? `${r.dirty} DIRTY` : undefined, danger: true, onClick: () => void removeTree(r) });
      if (r.name && !r.base) tail.push({ icon: "✕", label: "Delete branch…", hint: r.merged ? undefined : "UNMERGED", danger: true, onClick: () => void del(r) });
    }
    if (tail.length) items.push({ divider: true }, ...tail);
    return items;
  }
  useEffect(() => {
    branchMenu.items = (id) => { const r = rows.find((x) => keyOf(x) === id); return r ? menuFor(r) : []; };
    return () => { branchMenu.items = null; };
  });

  // Drag a branch onto another: the row under it says what letting go does.
  const canDrag = (r: ShownRow) => !!r.name && !r.base && !r.main && !r.parent && !r.remote && !r.activity;
  const dnd = (r: ShownRow) => ({
    draggable: canDrag(r) || undefined,
    onDragStart: (e: DragEvent) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", r.name); setDrag(r); },
    onDragEnd: () => { setDrag(null); setOver(""); },
    onDragOver: (e: DragEvent) => { if (drag && r.name && r.name !== drag.name) { e.preventDefault(); if (over !== r.name) setOver(r.name); } },
    onDragLeave: (e: DragEvent) => { if (over === r.name && !e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) setOver(""); },
    onDrop: (e: DragEvent) => { e.preventDefault(); const src = drag; setDrag(null); setOver(""); if (src && r.name !== src.name) void mergeInto(src, r); },
  });

  // One row: the name with its step and ⋯, then the live session or the facts; `kids` gives it Land N.
  // Plain render functions, not components: a component made in here would remount every row on each
  // render, and a drag dies when its row leaves the page.
  function row(r: ShownRow, kids?: TreeNode, root?: boolean) {
    const live = r.name ? view?.live.get(r.name) : undefined;
    const go = live ?? (r.name ? view?.byBranch.get(r.name)?.[0] : undefined);
    const take = kids ? landList(kids).take.length : 0;
    const step = take ? null : nextStep(r);
    const look = step && stepLook(step, r);
    const tone = r.activity === "asking" ? "var(--ask, var(--warn))" : "var(--ok)";
    const menu = (el: HTMLElement, x: number, y: number) => el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: x, clientY: y }));
    const k = r.activity === "asking" ? "ask" : r.activity ? "live" : r.parent || r.remote ? "parent" : "idle";
    const dropping = over === r.name && drag;
    return (
      <div key={keyOf(r)} className={root ? "brow bt-root" : "brow bt-node"} data-k={k} data-here={r.here || undefined} data-drop={dropping ? true : undefined}
        data-drag={drag?.name === r.name || undefined} data-ctx-type={r.remote ? undefined : "branch"} data-ctx-id={keyOf(r)} data-ctx-label={r.name || r.label}
        {...dnd(r)}
        onClick={(e) => { if (go) onOpen(go); else if (!r.remote) menu(e.currentTarget, e.clientX, e.clientY); }}
        title={[r.name || `detached at ${r.head}`, r.worktree, r.into ? `goes into ${short(r.into)}` : "", go ? `click: ${live ? "its session" : "its newest session"}` : "click: its actions"].filter(Boolean).join("\n")}>
        {!root && <span className="bt-mk" aria-hidden>{k === "parent" ? <GitBranch size={10} strokeWidth={2.4} /> : null}</span>}
        <div className="brow-l1">
          {root && (r.remote ? <Cloud size={14} strokeWidth={2} aria-hidden className="bt-ricon" /> : <GitBranch size={14} strokeWidth={2} aria-hidden className="bt-ricon" />)}
          <span className="bt-name" style={{ fontFamily: MONO }}>{root ? r.name : r.label}</span>
          {r.title && <span className="bt-title">{r.title}</span>}
          <span className="brow-acts">
            {!r.remote && (
              <button className="rowact brow-plus" onClick={(e) => { e.stopPropagation(); onNew(r); }} aria-label="New session"
                title={r.worktree ? `New session in ${r.worktree}` : `Check ${r.name} out into a new worktree and start a session there`}>
                <Plus size={11} strokeWidth={2.6} aria-hidden />
              </button>
            )}
            {take > 0 && (
              <button className="brow-step" data-tone style={{ ["--c" as string]: "var(--acc)" }}
                onClick={(e) => { e.stopPropagation(); openLand(kids!, e.currentTarget); }} title={`Land the ${plural(take, "idle branch", "idle branches")} that go into ${r.name}`}>
                <GitMerge size={10} strokeWidth={2.2} aria-hidden />Land {take}
              </button>
            )}
            {look && (
              <button className="brow-step" data-ai={look.ai || undefined} data-tone={look.c ? true : undefined} disabled={busy === keyOf(r)}
                onClick={(e) => { e.stopPropagation(); onStep(r, step!); }} style={look.c ? { ["--c" as string]: look.c } : undefined}
                title={step === "land" ? `Merge into ${short(r.into)}, run the checks, then remove the worktree and branch` : undefined}>
                <look.Icon size={10} strokeWidth={2.2} aria-hidden />{look.t}
              </button>
            )}
            {!r.remote && (
              <button className="brow-more" aria-label="Actions" title="Every action for this branch"
                onClick={(e) => { e.stopPropagation(); const b = e.currentTarget.getBoundingClientRect(); menu(e.currentTarget, b.right - 216, b.bottom + 4); }}>
                <Ellipsis size={13} strokeWidth={2.2} aria-hidden />
              </button>
            )}
          </span>
        </div>
        <div className="brow-l2">
          {dropping ? (
            <span className="t bt-droptxt">⤵ {short(drag!.into) === r.name ? `Land ${drag!.label} here` : `Merge ${drag!.label} into ${r.label}`}</span>
          ) : live ? (
            <>
              {root && <span className="bt-livedot" style={{ background: tone }} />}
              <span className="t" style={{ color: tone }}>{live.title || "fresh session"}</span>
              {/* the status never truncates: only the title gives way */}
              <span style={{ flex: "none", color: tone }}>{r.activity === "asking" ? "waits on you" : "working"}</span>
            </>
          ) : r.remote ? (
            <span className="t">on origin only{take ? ` · ${plural(take, "branch", "branches")} to land` : ""}</span>
          ) : (
            <span className="t">
              {facts(r, kids ? kids.kids.length + kids.landed.length : 0).map((f, i) => (
                <span key={i}>{i > 0 && <i>·</i>}<span style={f.tone ? { color: TONE[f.tone] } : undefined}>{f.t}</span></span>
              ))}
            </span>
          )}
        </div>
      </div>
    );
  }

  // A node's children, each with its own guide; the landed ones fold into one last line.
  function kidsOf(n: TreeNode) {
    if (!n.kids.length && !n.landed.length) return null;
    const open = folds.has(n.row.name);
    const flip = () => setFolds((s) => { const t = new Set(s); if (t.has(n.row.name)) t.delete(n.row.name); else t.add(n.row.name); return t; });
    return (
      <div className="bt-kids">
        {n.kids.map((k, i) => (
          <div key={keyOf(k.row)} className="bt-item" data-k={k.row.activity === "asking" ? "ask" : k.row.activity ? "live" : undefined}
            data-last={(i === n.kids.length - 1 && !n.landed.length) || undefined}>
            {row(k.row, k)}
            {kidsOf(k)}
          </div>
        ))}
        {n.landed.length > 0 && (
          <div className="bt-item" data-last>
            <div className="brow bt-node bt-fold" data-k="landed" onClick={flip} aria-expanded={open}
              title={open ? "Fold them back" : "Show each one"}>
              <span className="bt-mk" aria-hidden><Check size={9} strokeWidth={3.2} /></span>
              <div className="brow-l1">
                <span className="bt-name">{n.landed.length} landed in {n.row.label}</span>
                <span className="brow-acts">
                  <button className="brow-step" data-tone style={{ ["--c" as string]: "var(--purple-h)" }}
                    onClick={(e) => { e.stopPropagation(); void cleanAll(n.landed, n.row.name); }}>
                    <BrushCleaning size={10} strokeWidth={2.2} aria-hidden />Clean up{n.landed.length > 1 ? ` ${n.landed.length}` : ""}
                  </button>
                  <ChevronDown size={12} strokeWidth={2.4} aria-hidden className="bt-chev" />
                </span>
              </div>
              <div className="brow-l2"><span className="t">{n.landed.map((r) => r.label).join(" · ")}</span></div>
            </div>
            {open && (
              <div className="bt-kids">
                {n.landed.map((r, i) => (
                  <div key={keyOf(r)} className="bt-item" data-last={i === n.landed.length - 1 || undefined}>{row(r)}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  const make = () => {
    const n = name.trim();
    if (!n) return;
    onNewBranch(n, from || base);
    setNaming(false); setName("");
  };
  const land = () => {
    if (!pop) return;
    const go = pop.take.filter((r) => ticked.has(r.name));
    if (go.length) onAsk(landPrompt(go, pop.into), cwdFor(pop.into));
    setPop(null);
  };

  return (
    <div ref={panel} className="panel" style={{ position: "relative", border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", background: "color-mix(in srgb, var(--panel) 86%, transparent)", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <TabKick name="BRANCHES" tools={<>
        <button className="gp-ib bt-auto" data-on={autoClean || undefined} aria-pressed={autoClean} onClick={() => onAutoClean(!autoClean)}
          title={autoClean ? "Landed branches clean up by themselves: on (nothing in use, nothing uncommitted). Click to turn off."
            : "Landed branches wait for Clean up. Click to let them clean up by themselves."}>
          <BrushCleaning size={13} aria-hidden />
        </button>
        {project && view && view.rows.length > 0 && (
          <button className="br-add" onClick={() => setNaming((v) => !v)} aria-expanded={naming} title="A new branch in its own worktree, and a session there">
            <Plus size={12} strokeWidth={2.4} aria-hidden />Branch
          </button>
        )}
        <button className="gp-ib" onClick={onReload} title="refresh" aria-label="Refresh"><RefreshCw size={13} aria-hidden /></button>
      </>} />
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
                {rows.filter((b) => b.name && !b.remote).map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
              </select>
            </label>
            <button type="submit" className="bnew-kbd" aria-label="Create the branch and start a session" disabled={!name.trim()}>↵</button>
          </form>
          <div style={{ margin: "5px 14px 0 21px", fontSize: "var(--t9)", color: "var(--txd)" }}>makes the worktree, opens a session there · esc closes</div>
        </>
      )}
      <div className="mscroll" style={{ padding: "4px 0 14px", flex: 1, minHeight: 0, overflowY: "auto" }}>
        {!project && <div className="bt-say">No session selected.</div>}
        {project && err && <div className="bt-say" style={{ color: "var(--err)" }}>Couldn't read the branches: {err}</div>}
        {project && !err && !view && <div className="bt-say">Reading branches…</div>}
        {project && view && !view.rows.length && <div className="bt-say">No branches: not a git repo?</div>}
        <div className="swapin">
          {view?.tree.map((n) => (
            <div key={keyOf(n.row)} className="bt-tree">
              {row(n.row, n, true)}
              {kidsOf(n)}
            </div>
          ))}
          {view && view.rows.length > 1 && (
            <div className="bt-hint"><GripVertical size={12} strokeWidth={2} aria-hidden />Drag a branch onto another to merge it there</div>
          )}
        </div>
      </div>
      {pop && (
        <>
          <div className="bt-veil" onClick={() => setPop(null)} />
          <div className="bt-pop" style={{ top: pop.y, boxShadow: "0 14px 40px var(--shadow-pop)" }} role="dialog" aria-label={`Land in ${pop.into}`}
            onKeyDown={(e) => { if (e.key === "Escape") setPop(null); }}>
            <div className="bt-ph">LAND IN <b>{short(pop.into)}</b></div>
            {pop.take.map((r) => {
              const on = ticked.has(r.name);
              return (
                <label key={r.name} className="bt-pr">
                  <input type="checkbox" checked={on} autoFocus={r === pop.take[0]}
                    onChange={() => setTicked((s) => { const t = new Set(s); if (on) t.delete(r.name); else t.add(r.name); return t; })} />
                  <span className="w"><span className="n">{r.name}</span>
                    <small>{facts(r).filter((f) => f.tone !== "merged").map((f) => f.t).join(" · ")}</small></span>
                </label>
              );
            })}
            {pop.held.length > 0 && (
              <div className="bt-out">Left out: {pop.held.map((h, i) => <span key={h.row.name}>{i > 0 && " · "}<b>{h.row.label}</b> {h.why}</span>)}</div>
            )}
            <div className="bt-sayp">One session merges them the way this repo does it, runs the checks, then removes their worktrees and branches. Nothing is pushed.</div>
            <div className="bt-bt">
              <button className="act-pri" disabled={!ticked.size} onClick={land}><GitMerge size={12} strokeWidth={2.3} aria-hidden />Land {ticked.size}</button>
              <button className="act-alt neutral" onClick={() => setPop(null)}>Cancel</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
