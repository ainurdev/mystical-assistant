import { useEffect, useRef, useState } from "react";
import {
  api,
  type CompareInfo,
  type GitStatus,
  type SessionBrief,
  type Worktree,
} from "../../api";

/* WORKTREES tab of the Analyze modal — a compact one-line row per branch that
   expands (accordion, one at a time) into its actions: checkout, open worktree,
   attach session, merge, delete. Rows are grouped (live worktrees first, plain
   branches folded behind a count) and filterable, so a repo with 50 branches
   stays a list instead of 50 stacked cards. Plus the new-worktree creator, PR
   creation, and the delete confirm dialog. */

interface Props {
  project: string;
  sessions: SessionBrief[];
  worktrees: Worktree[];
  branches: string[];
  defaultBranch: string;
  git: GitStatus | null;
  onSelectSession: (s: SessionBrief) => void;
  onWorktreeSession: (rel: string, branch: string, create: boolean, parent?: string) => void;
  onRefresh: () => void;
}

interface ConfirmState {
  branch: string;
  path: string;
  sessCount: number;
  hasWorktree: boolean;
}

const MARK_COLOR = (s: string) => (s === "A" ? "var(--ok)" : s === "D" ? "var(--err)" : "var(--warn)");
const SECTION: React.CSSProperties = { fontSize: "var(--t8)", letterSpacing: 1.5, color: "var(--txl)", margin: "12px 0 5px" };
const BTN: React.CSSProperties = { appearance: "none", cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1, padding: "5px 10px", lineHeight: 1.4, flex: "none" };

export function WorktreesTab({
  project, sessions, worktrees, branches, defaultBranch, git,
  onSelectSession, onWorktreeSession, onRefresh,
}: Props) {
  const base = defaultBranch || "main";
  const cur = git?.branch || base;
  const [hov, setHov] = useState("");
  const hp = (k: string) => ({ onMouseEnter: () => setHov(k), onMouseLeave: () => setHov("") });

  const [banner, setBanner] = useState("");
  const bannerT = useRef<ReturnType<typeof setTimeout> | null>(null);
  function showBanner(msg: string) {
    setBanner(msg);
    if (bannerT.current) clearTimeout(bannerT.current);
    bannerT.current = setTimeout(() => setBanner(""), 4500);
  }
  useEffect(() => () => { if (bannerT.current) clearTimeout(bannerT.current); }, []);

  const [busy, setBusy] = useState(false);
  // merged-this-session branches (backend has no merged-branch detection yet).
  // TODO(phase2-data): detect already-merged branches via compare on load.
  const [merged, setMerged] = useState<Set<string>>(new Set());
  const [mergeTarget, setMergeTarget] = useState<Record<string, string>>({});
  const [mergeMenu, setMergeMenu] = useState("");
  const [stats, setStats] = useState<Record<string, GitStatus>>({});
  const [parent, setParent] = useState("");
  const [branchInput, setBranchInput] = useState("");
  const [confirmDel, setConfirmDel] = useState<ConfirmState | null>(null);
  const [expanded, setExpanded] = useState("");
  const [q, setQ] = useState("");
  const [showAll, setShowAll] = useState(false);

  // PR creation (head = the checked-out branch).
  const [prOpen, setPrOpen] = useState(false);
  const [prTitle, setPrTitle] = useState("");
  const [prBase, setPrBase] = useState("");
  const [prCmp, setPrCmp] = useState<CompareInfo | null>(null);
  const [prCreated, setPrCreated] = useState<{ num: number | null; title: string; branch: string; base: string; add: number; del: number; url: string } | null>(null);

  const linked = worktrees.filter((w) => !w.is_main);
  const wtByBranch = new Map(linked.map((w) => [w.branch, w]));
  const list = branches.filter((b) => b !== base);
  const wtOpenCount = linked.length;
  const parentName = parent && branches.includes(parent) ? parent : cur;

  const needle = q.trim().toLowerCase();
  const hits = list.filter((b) => !needle || b.toLowerCase().includes(needle));
  const liveRows = hits.filter((b) => wtByBranch.has(b));
  const plainRows = hits.filter((b) => !wtByBranch.has(b));
  // fold the long tail of worktree-less branches unless asked for / filtering
  const folded = !showAll && !needle && plainRows.length > 8;

  // ahead/behind/dirty for each open worktree branch (real per-worktree git status)
  useEffect(() => {
    let live = true;
    for (const w of linked) {
      void api.git(project, w.branch)
        .then((g) => { if (live) setStats((s) => ({ ...s, [w.branch]: g })); })
        .catch(() => {});
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, worktrees]);

  const prDests = branches.filter((b) => b !== cur);
  const prBaseSel = prDests.includes(prBase) ? prBase : (prDests.includes(base) ? base : (prDests[0] || ""));
  const prDisabled = !cur || cur === base || prDests.length === 0;

  useEffect(() => {
    if (!prOpen || !prBaseSel || !cur) { setPrCmp(null); return; }
    let live = true;
    void api.compare(project, prBaseSel, cur, 2).then((c) => { if (live) setPrCmp(c); }).catch(() => { if (live) setPrCmp(null); });
    return () => { live = false; };
  }, [prOpen, prBaseSel, cur, project]);

  async function checkout(ref: string) {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.checkout(project, ref);
      if (r.ok) { showBanner(`Checked out ${ref}`); onRefresh(); }
      else showBanner(`Checkout failed: ${r.output}`);
    } finally { setBusy(false); }
  }

  async function doMerge(name: string, target: string) {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.merge(project, name, target);
      if (r.ok) {
        setMerged((m) => new Set(m).add(name));
        showBanner(`Merged ${name} → ${target} · ${r.output.split("\n")[0] || "done"}`);
        onRefresh();
      } else showBanner(`Merge failed: ${r.output}`);
    } finally { setBusy(false); }
  }

  async function doDelete() {
    if (!confirmDel || busy) return;
    setBusy(true);
    try {
      const r = confirmDel.hasWorktree
        ? await api.worktreeRemove(project, confirmDel.path, confirmDel.branch, true)
        : await api.deleteBranch(project, confirmDel.branch, true);
      showBanner(r.ok
        ? `Removed ${confirmDel.hasWorktree ? "worktree + " : ""}branch ${confirmDel.branch}`
        : `Delete failed: ${r.output}`);
      if (r.ok) {
        setMerged((m) => { const n = new Set(m); n.delete(confirmDel.branch); return n; });
        onRefresh();
      }
    } finally { setBusy(false); setConfirmDel(null); }
  }

  function createAndOpen() {
    const v = branchInput.trim().replace(/\s+/g, "-");
    if (!v) return;
    onWorktreeSession(project, v, true, parentName || undefined);
    setBranchInput("");
  }

  async function createPr() {
    if (busy) return;
    setBusy(true);
    try {
      const title = prTitle.trim() || `Merge ${cur} into ${prBaseSel}`;
      const r = await api.createPr(project, cur, prBaseSel, title);
      if (r.ok) {
        setPrCreated({ num: r.number, title, branch: cur, base: prBaseSel, add: prCmp?.add ?? 0, del: prCmp?.del ?? 0, url: r.url });
        setPrOpen(false);
      } else showBanner(`PR failed: ${r.output}`);
    } finally { setBusy(false); }
  }

  /* one collapsed line per branch; the expanded one shows its actions */
  function branchRow(name: string) {
    const wt = wtByBranch.get(name);
    const open = !!wt;
    const isMerged = merged.has(name);
    const sess = sessions.filter((s) => (s.branch || base) === name);
    const st = stats[name];
    const current = name === cur;
    const on = expanded === name;
    const dot = isMerged ? "var(--ok)" : open ? "var(--acc)" : "var(--txf)";
    const edge = current ? "var(--acc)" : isMerged ? "color-mix(in srgb, var(--ok) 45%, transparent)" : open ? "color-mix(in srgb, var(--acc) 32%, transparent)" : "transparent";
    const targets = branches.filter((b) => b !== name);
    const mtSel = targets.includes(mergeTarget[name] || "") ? mergeTarget[name] : (targets.includes(base) ? base : (targets[0] || base));

    return (
      <div key={name} data-ctx-type="branch" data-ctx-id={name} data-ctx-label={name}
        style={{ borderLeft: `2px solid ${edge}`, borderBottom: "1px solid color-mix(in srgb, var(--acc) 8%, transparent)", background: on ? "color-mix(in srgb, var(--acc) 6%, transparent)" : current ? "color-mix(in srgb, var(--acc) 3%, transparent)" : "transparent" }}>
        <div onClick={() => setExpanded((v) => (v === name ? "" : name))} {...hp(`row:${name}`)}
          style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 9px", cursor: "pointer", background: hov === `row:${name}` && !on ? "color-mix(in srgb, var(--acc) 4%, transparent)" : "transparent" }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: dot, flex: "none" }} />
          <span style={{ flex: 1, minWidth: 0, fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t11)", color: current ? "var(--txb)" : open ? "var(--txh)" : "var(--txm)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
          {current && <span style={{ fontSize: "var(--t75)", letterSpacing: 1, color: "var(--acc-on)", background: "var(--acc)", padding: "1px 5px", flex: "none" }}>HEAD</span>}
          {isMerged && <span style={{ fontSize: "var(--t75)", letterSpacing: 1, color: "var(--ok)", flex: "none" }}>MERGED</span>}
          {open && (
            <span style={{ display: "flex", gap: 6, flex: "none", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t9)", color: "var(--txd)" }}>
              <span style={{ color: "var(--ok)" }}>↑{st?.ahead ?? 0}</span>
              <span style={{ color: "var(--info)" }}>↓{st?.behind ?? 0}</span>
              {(st?.dirty ?? 0) > 0 && <span style={{ color: "var(--warn)" }}>●{st?.dirty}</span>}
            </span>
          )}
          {sess.length > 0 && <span style={{ fontSize: "var(--t9)", color: "var(--purple-d)", flex: "none", fontFamily: "'JetBrains Mono',monospace" }}>{sess.length}⧉</span>}
          <span style={{ fontSize: "var(--t8)", color: "var(--txd)", flex: "none", width: 8, textAlign: "center" }}>{on ? "▾" : "▸"}</span>
        </div>

        {on && (
          <div style={{ padding: "2px 9px 9px", animation: "mslide .16s ease both" }}>
            {open && <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t9)", color: "var(--txf)", marginBottom: 7, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={wt.path}>{wt.path}</div>}
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
              {!current && (
                <button onClick={() => void checkout(name)} title="checkout this branch here" {...hp(`co:${name}`)}
                  style={{ ...BTN, border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)", background: hov === `co:${name}` ? "color-mix(in srgb, var(--acc) 10%, transparent)" : "transparent", color: "var(--tx)" }}>⎇ CHECKOUT</button>
              )}
              {!open && !isMerged && (
                <button onClick={() => onWorktreeSession(project, name, false)} title="create a worktree and start a session" {...hp(`open:${name}`)}
                  style={{ ...BTN, border: "1px solid var(--acc)", background: hov === `open:${name}` ? "color-mix(in srgb, var(--acc) 22%, transparent)" : "color-mix(in srgb, var(--acc) 12%, transparent)", color: "var(--txb)" }}>▸ OPEN WORKTREE</button>
              )}
              {open && (
                <>
                  <button onClick={() => { const s = sess[0]; if (s) onSelectSession(s); else onWorktreeSession(project, name, false); }} title="attach a session on this worktree" {...hp(`att:${name}`)}
                    style={{ ...BTN, border: "1px solid var(--acc)", background: hov === `att:${name}` ? "color-mix(in srgb, var(--acc) 22%, transparent)" : "color-mix(in srgb, var(--acc) 12%, transparent)", color: "var(--txb)" }}>▸ ATTACH SESSION</button>
                  <button onClick={() => onWorktreeSession(project, name, false)} title="start another session on this worktree" {...hp(`plus:${name}`)}
                    style={{ ...BTN, border: "1px solid color-mix(in srgb, var(--acc) 22%, transparent)", background: hov === `plus:${name}` ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "transparent", color: "var(--txm)", fontSize: "var(--t11)", padding: "4px 9px" }}>+</button>
                </>
              )}
              <span style={{ flex: 1 }} />
              <button onClick={() => setConfirmDel({ branch: name, path: wt?.path ?? "", sessCount: sess.length, hasWorktree: open })} title={open ? "delete branch + worktree" : "delete branch"} {...hp(`del:${name}`)}
                style={{ ...BTN, border: "1px solid color-mix(in srgb, var(--err) 28%, transparent)", background: hov === `del:${name}` ? "color-mix(in srgb, var(--err) 10%, transparent)" : "transparent", color: hov === `del:${name}` ? "var(--err)" : "var(--err-g)", fontSize: "var(--t11)", padding: "4px 9px" }}>✕</button>
            </div>

            {open && !isMerged && (
              <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 8, paddingTop: 8, borderTop: "1px dashed color-mix(in srgb, var(--acc) 12%, transparent)" }}>
                <span style={{ fontSize: "var(--t8)", letterSpacing: 1.5, color: "var(--txd)", flex: "none" }}>MERGE INTO</span>
                <div style={{ position: "relative", flex: 1, minWidth: 0, maxWidth: 280 }}>
                  <button onClick={() => setMergeMenu((m) => (m === name ? "" : name))} title="choose destination branch" {...hp(`mt:${name}`)}
                    style={{ width: "100%", boxSizing: "border-box", appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 5, border: `1px solid ${hov === `mt:${name}` ? "var(--ok)" : "color-mix(in srgb, var(--ok) 35%, transparent)"}`, background: "color-mix(in srgb, var(--ok) 5%, transparent)", color: "var(--txh)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t95)", padding: "5px 8px" }}>
                    <span style={{ color: "var(--ok)", flex: "none" }}>⎇</span>
                    <span style={{ flex: 1, minWidth: 0, textAlign: "left", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{mtSel}</span>
                    <span style={{ color: "var(--txd)", flex: "none" }}>▾</span>
                  </button>
                  {mergeMenu === name && (
                    <div className="mscroll" style={{ position: "absolute", bottom: "calc(100% + 6px)", left: 0, right: 0, zIndex: 30, maxHeight: 210, overflowY: "auto", border: "1px solid color-mix(in srgb, var(--ok) 40%, transparent)", background: "color-mix(in srgb, var(--panel2) 98%, transparent)", boxShadow: "0 12px 34px var(--shadow-pop)", padding: 5, animation: "mslide .16s ease both" }}>
                      <div style={{ fontSize: "var(--t8)", letterSpacing: 1.5, color: "var(--txl)", padding: "5px 8px 7px" }}>MERGE {name} INTO</div>
                      {targets.map((m) => {
                        const sel = m === mtSel;
                        return (
                          <button key={m} onClick={() => { setMergeTarget((t) => ({ ...t, [name]: m })); setMergeMenu(""); }} {...hp(`mti:${name}:${m}`)}
                            style={{ width: "100%", appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 7, border: 0, borderLeft: `2px solid ${sel ? "var(--ok)" : "transparent"}`, background: hov === `mti:${name}:${m}` ? "color-mix(in srgb, var(--ok) 10%, transparent)" : sel ? "color-mix(in srgb, var(--ok) 8%, transparent)" : "transparent", color: sel ? "var(--txb)" : "var(--txm)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t10)", padding: "6px 9px", textAlign: "left" }}>
                            <span style={{ color: "var(--ok)", flex: "none" }}>⎇</span>
                            <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m}</span>
                            {sel && <span style={{ color: "var(--ok)", flex: "none" }}>✓</span>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
                <button onClick={() => void doMerge(name, mtSel)} title="merge into the selected branch" {...hp(`mg:${name}`)}
                  style={{ ...BTN, border: "1px solid var(--ok)", background: hov === `mg:${name}` ? "color-mix(in srgb, var(--ok) 24%, transparent)" : "color-mix(in srgb, var(--ok) 14%, transparent)", color: "var(--txb)", padding: "5px 12px" }}>▸ MERGE</button>
              </div>
            )}
            {isMerged && (
              <div style={{ marginTop: 7, fontSize: "var(--t95)", letterSpacing: ".5px", color: "var(--ok)" }}>✓ merged into {mtSel}</div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ animation: "mslide .3s ease both" }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: "var(--t95)", letterSpacing: 1.5, color: "var(--txl)" }}>WORKTREES</span>
          <span style={{ fontSize: "var(--t85)", letterSpacing: ".5px", color: "var(--purple-g)" }}>{wtOpenCount} OPEN</span>
          <span style={{ fontSize: "var(--t85)", letterSpacing: ".5px", color: "var(--txd)" }}>{branches.length} BRANCHES</span>
          <span style={{ flex: 1 }} />
          {list.length > 8 && (
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter…"
              style={{ width: 130, background: "color-mix(in srgb, var(--panel2) 60%, transparent)", border: `1px solid ${q ? "var(--acc)" : "color-mix(in srgb, var(--acc) 18%, transparent)"}`, outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t10)", padding: "3px 7px" }} />
          )}
          <span style={{ fontSize: "var(--t9)", letterSpacing: ".5px", color: "var(--txd)", fontFamily: "'JetBrains Mono',monospace" }}>●{git?.dirty ?? 0} ↑{git?.ahead ?? 0} ↓{git?.behind ?? 0}</span>
        </div>

        {banner && (
          <div style={{ border: "1px solid color-mix(in srgb, var(--acc) 35%, transparent)", background: "color-mix(in srgb, var(--acc) 6%, transparent)", color: "var(--tx)", fontSize: "var(--t10)", letterSpacing: ".2px", padding: "8px 11px", marginBottom: 9, display: "flex", alignItems: "center", gap: 8, animation: "mslide .25s ease both", fontFamily: "'JetBrains Mono',monospace" }}>
            <span style={{ color: "var(--acc)", flex: "none" }}>▸</span>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{banner}</span>
          </div>
        )}

        {/* base branch row */}
        <div style={{ display: "flex", alignItems: "center", gap: 9, border: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", padding: "8px 11px", marginBottom: 8, background: "color-mix(in srgb, var(--panel2) 30%, transparent)" }}>
          <span style={{ fontSize: "var(--t12)", color: "var(--acc)", flex: "none" }}>⎇</span>
          <button onClick={() => void checkout(base)} title={`checkout ${base}`} {...hp("base")}
            style={{ flex: 1, minWidth: 0, appearance: "none", border: 0, background: "transparent", cursor: "pointer", textAlign: "left", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t115)", color: hov === "base" ? "var(--txb)" : "var(--txh)" }}>{base}</button>
          <span style={{ fontSize: "var(--t8)", letterSpacing: 1, color: "var(--txf)", flex: "none" }}>BASE</span>
          {cur === base && <span style={{ fontSize: "var(--t8)", letterSpacing: 1, color: "var(--acc-on)", background: "var(--acc)", padding: "2px 6px", flex: "none" }}>HEAD</span>}
        </div>

        {/* live worktrees, then the worktree-less tail */}
        {liveRows.length > 0 && (
          <>
            <div style={SECTION}>LIVE WORKTREES · {liveRows.length}</div>
            {liveRows.map(branchRow)}
          </>
        )}
        {plainRows.length > 0 && (
          <>
            <div onClick={() => folded && setShowAll(true)} style={{ ...SECTION, cursor: folded ? "pointer" : "default", display: "flex", alignItems: "center", gap: 7 }}>
              <span>BRANCHES · {plainRows.length}</span>
              {folded && <span style={{ color: "var(--acc)" }}>▾ SHOW ALL</span>}
            </div>
            {(folded ? plainRows.slice(0, 8) : plainRows).map(branchRow)}
          </>
        )}
        {hits.length === 0 && (
          <div style={{ fontSize: "var(--t105)", color: "var(--txl)", padding: "10px 2px" }}>No branch matches “{q}”.</div>
        )}

        {/* new worktree */}
        <div style={{ border: "1px solid color-mix(in srgb, var(--purple) 25%, transparent)", background: "color-mix(in srgb, var(--purple) 4%, transparent)", padding: "8px 9px", marginTop: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 7 }}>
            <span style={{ fontSize: "var(--t8)", letterSpacing: 1, color: "var(--purple-g)", flex: "none" }}>NEW WORKTREE FROM</span>
            <select value={parentName} onChange={(e) => setParent(e.target.value)} title="parent branch"
              style={{ appearance: "none", cursor: "pointer", maxWidth: 200, border: "1px solid color-mix(in srgb, var(--purple) 35%, transparent)", background: "color-mix(in srgb, var(--purple) 8%, transparent)", color: "var(--purple-h)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t9)", padding: "3px 8px", outline: "none" }}>
              {branches.map((b) => <option key={b} value={b} style={{ background: "var(--panel2)" }}>⎇ {b}</option>)}
            </select>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ fontSize: "var(--t13)", color: "var(--purple)", flex: "none" }}>⎇</span>
            <input value={branchInput} onChange={(e) => setBranchInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") createAndOpen(); }}
              placeholder="new branch name…"
              style={{ flex: 1, minWidth: 0, background: "color-mix(in srgb, var(--panel2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--acc) 18%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t11)", padding: "5px 8px" }} />
            <button onClick={createAndOpen} title="create branch + worktree + session" {...hp("wtopen")}
              style={{ appearance: "none", cursor: "pointer", border: "1px solid var(--purple)", background: hov === "wtopen" ? "color-mix(in srgb, var(--purple) 24%, transparent)" : "color-mix(in srgb, var(--purple) 14%, transparent)", color: "var(--purple-b)", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1, padding: "6px 10px", flex: "none", display: "flex", alignItems: "center", gap: 5 }}>
              <span>▸</span>OPEN</button>
          </div>
        </div>

        {/* PR: created card / form / button */}
        {prCreated && (
          <div title={prCreated.url} style={{ marginTop: 11, border: "1px solid color-mix(in srgb, var(--ok) 35%, transparent)", background: "color-mix(in srgb, var(--ok) 6%, transparent)", padding: "10px 12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: "var(--t11)", color: "var(--ok)" }}>⇡ PR {prCreated.num != null ? `#${prCreated.num}` : ""}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: "var(--t9)", letterSpacing: 1, color: "var(--ok)", border: "1px solid color-mix(in srgb, var(--ok) 40%, transparent)", padding: "1px 6px" }}>OPEN</span>
            </div>
            <div style={{ fontSize: "var(--t11)", color: "var(--txh)", marginTop: 6 }}>{prCreated.title}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 4, fontSize: "var(--t95)", color: "var(--txd)", fontFamily: "'JetBrains Mono',monospace" }}>
              <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{prCreated.branch} → {prCreated.base}</span>
              <span style={{ flex: 1 }} />
              <span style={{ color: "var(--ok)" }}>+{prCreated.add}</span>
              <span style={{ color: "var(--err)" }}>−{prCreated.del}</span>
            </div>
          </div>
        )}
        {prOpen && (
          <div style={{ marginTop: 11, border: "1px solid color-mix(in srgb, var(--purple) 32%, transparent)", background: "color-mix(in srgb, var(--purple) 5%, transparent)", padding: "11px 12px" }}>
            <div style={{ fontSize: "var(--t9)", letterSpacing: 1.5, color: "var(--txl)", marginBottom: 8 }}>NEW PULL REQUEST</div>
            <input value={prTitle} onChange={(e) => setPrTitle(e.target.value)} placeholder="pull request title…"
              style={{ width: "100%", boxSizing: "border-box", background: "color-mix(in srgb, var(--panel2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--acc) 18%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "inherit", fontSize: "var(--t115)", padding: "7px 9px" }} />
            <div style={{ fontSize: "var(--t85)", letterSpacing: 1.5, color: "var(--txl)", margin: "10px 0 6px" }}>MERGE INTO · DESTINATION</div>
            <select value={prBaseSel} onChange={(e) => setPrBase(e.target.value)}
              style={{ width: "100%", boxSizing: "border-box", appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--purple) 35%, transparent)", background: "color-mix(in srgb, var(--purple) 8%, transparent)", color: "var(--purple-b)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t10)", padding: "6px 9px", outline: "none" }}>
              {prDests.map((d) => <option key={d} value={d} style={{ background: "var(--panel2)" }}>⎇ {d}</option>)}
            </select>
            <div style={{ marginTop: 9, border: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", background: "color-mix(in srgb, var(--panel2) 50%, transparent)", padding: "8px 10px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t10)" }}>
                <span style={{ color: "var(--purple-h)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{cur} → {prBaseSel}</span>
                <span style={{ flex: 1 }} />
                <span style={{ color: "var(--ok)" }}>+{prCmp?.add ?? 0}</span>
                <span style={{ color: "var(--err)" }}>−{prCmp?.del ?? 0}</span>
              </div>
              <div style={{ display: "flex", gap: 12, marginTop: 5, fontSize: "var(--t9)", letterSpacing: ".5px", color: "var(--txd)" }}>
                <span>{prCmp?.commits ?? 0} commits</span>
                <span>{prCmp?.files.length ?? 0} files changed</span>
              </div>
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 3 }}>
                {(prCmp?.files ?? []).map((f) => (
                  <div key={f.name} style={{ display: "flex", alignItems: "center", gap: 7, fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t10)" }}>
                    <span style={{ color: MARK_COLOR(f.mark), width: 9, flex: "none", fontWeight: 700 }}>{f.mark}</span>
                    <span style={{ color: "var(--txm)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", direction: "rtl", textAlign: "left" }}>{f.name}</span>
                    <span style={{ color: "var(--ok)", fontSize: "var(--t9)", flex: "none" }}>+{f.add}</span>
                    <span style={{ color: "var(--err)", fontSize: "var(--t9)", flex: "none" }}>−{f.del}</span>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", gap: 7, marginTop: 9 }}>
              <button onClick={() => void createPr()} {...hp("propen")}
                style={{ flex: 1, appearance: "none", cursor: "pointer", border: "1px solid var(--purple)", background: hov === "propen" ? "color-mix(in srgb, var(--purple) 24%, transparent)" : "color-mix(in srgb, var(--purple) 14%, transparent)", color: "var(--purple-b)", fontFamily: "inherit", fontSize: "var(--t10)", letterSpacing: 1.5, padding: 7 }}>OPEN PR</button>
              <button onClick={() => setPrOpen(false)} {...hp("prcancel")}
                style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)", background: hov === "prcancel" ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "transparent", color: "var(--txd)", fontFamily: "inherit", fontSize: "var(--t10)", letterSpacing: 1.5, padding: "7px 12px" }}>CANCEL</button>
            </div>
          </div>
        )}
        {!prOpen && (
          <button onClick={() => { if (!prDisabled) { setPrOpen(true); setPrTitle(`Merge ${cur} into ${prBaseSel}`); } }}
            title={prDisabled ? "check out a feature branch to open a PR" : "open a pull request"} {...hp("prbtn")}
            style={{ width: "100%", marginTop: 11, appearance: "none", cursor: prDisabled ? "not-allowed" : "pointer", border: `1px solid ${prDisabled ? "color-mix(in srgb, var(--acc) 12%, transparent)" : "color-mix(in srgb, var(--acc) 30%, transparent)"}`, background: !prDisabled && hov === "prbtn" ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "transparent", color: prDisabled ? "var(--txl)" : "var(--tx)", fontFamily: "inherit", fontSize: "var(--t10)", letterSpacing: 1.5, padding: 9 }}>⇡ CREATE PULL REQUEST</button>
        )}
      </div>

      {/* DELETE WORKTREE CONFIRM */}
      {confirmDel && (
        <div onClick={() => setConfirmDel(null)}
          style={{ position: "fixed", inset: 0, background: "color-mix(in srgb, var(--panel3) 78%, transparent)", zIndex: 96, display: "flex", alignItems: "center", justifyContent: "center", animation: "backdropIn .2s ease both" }}>
          <div onClick={(e) => e.stopPropagation()} className="panel"
            style={{ width: 450, maxWidth: "92vw", border: "1px solid color-mix(in srgb, var(--err) 50%, transparent)", background: "color-mix(in srgb, var(--panel2) 99%, transparent)", boxShadow: "0 0 60px var(--shadow-modal),0 0 26px color-mix(in srgb, var(--err) 12%, transparent)", animation: "mslide .2s ease both" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "15px 18px", borderBottom: "1px solid color-mix(in srgb, var(--err) 20%, transparent)" }}>
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="var(--err)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" /></svg>
              <span style={{ fontSize: "var(--t14)", color: "var(--err-hi)", letterSpacing: ".5px" }}>Delete worktree</span>
            </div>
            <div style={{ padding: "16px 18px" }}>
              <div style={{ fontSize: "var(--t125)", color: "var(--txh)", lineHeight: 1.6 }}>
                Removes the worktree checkout and deletes branch <span style={{ fontFamily: "'JetBrains Mono',monospace", color: "var(--err)" }}>⎇ {confirmDel.branch}</span>. This can’t be undone.
              </div>
              <div style={{ marginTop: 11, fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t10)", color: "var(--txf)", borderLeft: "2px solid color-mix(in srgb, var(--err) 30%, transparent)", padding: "3px 0 3px 10px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {confirmDel.hasWorktree ? confirmDel.path : "no worktree checkout — deletes the branch ref only"}
              </div>
              {confirmDel.sessCount > 0 && (
                <div style={{ marginTop: 12, border: "1px solid color-mix(in srgb, var(--warn) 35%, transparent)", background: "color-mix(in srgb, var(--warn) 6%, transparent)", color: "var(--warn)", fontSize: "var(--t105)", letterSpacing: ".3px", padding: "8px 11px", display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ flex: "none" }}>⚠</span>
                  <span>{confirmDel.sessCount} session{confirmDel.sessCount === 1 ? "" : "s"} running here will be ended.</span>
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 9, padding: "0 18px 16px" }}>
              <button onClick={() => setConfirmDel(null)} {...hp("dcancel")}
                style={{ flex: 1, appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: hov === "dcancel" ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "transparent", color: "var(--tx)", fontFamily: "inherit", fontSize: "var(--t105)", letterSpacing: 1.5, padding: 10 }}>CANCEL</button>
              <button onClick={() => void doDelete()} disabled={busy} {...hp("dgo")}
                style={{ flex: 1, appearance: "none", cursor: "pointer", border: "1px solid var(--err)", background: hov === "dgo" ? "color-mix(in srgb, var(--err) 28%, transparent)" : "color-mix(in srgb, var(--err) 16%, transparent)", color: "var(--err-b)", fontFamily: "inherit", fontSize: "var(--t105)", letterSpacing: 1.5, padding: 10, display: "flex", alignItems: "center", justifyContent: "center", gap: 7, opacity: busy ? 0.6 : 1 }}>
                <span>✕</span>DELETE BRANCH</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
