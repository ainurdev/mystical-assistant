import { useEffect, useRef, useState } from "react";
import {
  api,
  type CompareInfo,
  type GitStatus,
  type SessionBrief,
  type Worktree,
} from "../../api";

/* WORKTREES tab of the Analyze modal — one card per branch (base checkout row +
   a card for every other branch), with open/merge/merged action states, a
   new-worktree creator, PR creation, and the delete-worktree confirm dialog.
   Matches the HUD design mock (hud.dc.html lines 729–875 + 1236–1258). */

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

const MARK_COLOR = (s: string) => (s === "A" ? "#8fd9a8" : s === "D" ? "#e0897a" : "#e3c279");

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

  function cycleParent() {
    if (!branches.length) return;
    const i = Math.max(0, branches.indexOf(parentName));
    setParent(branches[(i + 1) % branches.length]);
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

  return (
    <div style={{ animation: "mslide .3s ease both" }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 9.5, letterSpacing: 1.5, color: "#3c544f" }}>WORKTREES</span>
          <span style={{ fontSize: 8.5, letterSpacing: ".5px", color: "#6f6088" }}>{wtOpenCount} OPEN</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 9, letterSpacing: ".5px", color: "#6f938d", fontFamily: "'JetBrains Mono',monospace" }}>●{git?.dirty ?? 0} ↑{git?.ahead ?? 0} ↓{git?.behind ?? 0}</span>
        </div>

        {banner && (
          <div style={{ border: "1px solid rgba(127,233,216,.35)", background: "rgba(127,233,216,.06)", color: "#bfe6de", fontSize: 10, letterSpacing: ".2px", padding: "8px 11px", marginBottom: 9, display: "flex", alignItems: "center", gap: 8, animation: "mslide .25s ease both", fontFamily: "'JetBrains Mono',monospace" }}>
            <span style={{ color: "#7fe9d8", flex: "none" }}>▸</span>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{banner}</span>
          </div>
        )}

        {/* base branch row */}
        <div style={{ display: "flex", alignItems: "center", gap: 9, border: "1px solid rgba(127,233,216,.12)", padding: "8px 11px", marginBottom: 8, background: "rgba(7,13,13,.3)" }}>
          <span style={{ fontSize: 12, color: "#7fe9d8", flex: "none" }}>⎇</span>
          <button onClick={() => void checkout(base)} title={`checkout ${base}`} {...hp("base")}
            style={{ flex: 1, minWidth: 0, appearance: "none", border: 0, background: "transparent", cursor: "pointer", textAlign: "left", fontFamily: "'JetBrains Mono',monospace", fontSize: 11.5, color: hov === "base" ? "#dff8f2" : "#cfe9e3" }}>{base}</button>
          <span style={{ fontSize: 8, letterSpacing: 1, color: "#456b65", flex: "none" }}>BASE</span>
          {cur === base && <span style={{ fontSize: 8, letterSpacing: 1, color: "#06100e", background: "#7fe9d8", padding: "2px 6px", flex: "none" }}>HEAD</span>}
        </div>

        {/* one card per non-base branch */}
        {list.map((name) => {
          const wt = wtByBranch.get(name);
          const open = !!wt;
          const isMerged = merged.has(name);
          const sess = sessions.filter((s) => (s.branch || base) === name);
          const st = stats[name];
          const ahead = st?.ahead ?? 0;
          const behind = st?.behind ?? 0;
          const dirty = st?.dirty ?? 0;
          const current = name === cur;
          const accent = current ? "#7fe9d8" : isMerged ? "rgba(143,217,168,.45)" : open ? "rgba(127,233,216,.32)" : "rgba(127,233,216,.1)";
          const cardBg = current ? "rgba(127,233,216,.05)" : isMerged ? "rgba(143,217,168,.04)" : "transparent";
          const nameColor = current ? "#dff8f2" : open ? "#cfe9e3" : "#9fc7c0";
          const statusColor = isMerged ? "#8fd9a8" : open ? "#7fe9d8" : "#5a6f6a";
          const statusLabel = isMerged ? "MERGED" : open ? "WORKTREE LIVE" : "NOT OPENED";
          const targets = branches.filter((b) => b !== name);
          const mtSel = targets.includes(mergeTarget[name] || "") ? mergeTarget[name] : (targets.includes(base) ? base : (targets[0] || base));
          const showOpen = !open && !isMerged;
          const showMerge = open && !isMerged;

          return (
            <div key={name} data-ctx-type="branch" data-ctx-id={name} data-ctx-label={name}
              style={{ border: `1px solid ${accent}`, borderLeft: `2px solid ${accent}`, background: cardBg, padding: "9px 11px", marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12, color: accent, flex: "none" }}>⎇</span>
                <button onClick={() => void checkout(name)} title="checkout" {...hp(`co:${name}`)}
                  style={{ flex: 1, minWidth: 0, appearance: "none", border: 0, background: "transparent", cursor: "pointer", textAlign: "left", fontFamily: "'JetBrains Mono',monospace", fontSize: 11.5, color: hov === `co:${name}` ? "#dff8f2" : nameColor, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</button>
                {current && <span style={{ fontSize: 8, letterSpacing: 1, color: "#06100e", background: "#7fe9d8", padding: "2px 6px", flex: "none" }}>HEAD</span>}
                <span style={{ display: "flex", alignItems: "center", gap: 5, flex: "none" }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: statusColor }} />
                  <span style={{ fontSize: 8, letterSpacing: 1, color: statusColor }}>{statusLabel}</span>
                </span>
              </div>
              {open && (
                <>
                  <div style={{ marginTop: 7, fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: "#5a6f6a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={wt.path}>{wt.path}</div>
                  <div style={{ marginTop: 5, display: "flex", alignItems: "center", gap: 10, fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: "#6f938d" }}>
                    <span style={{ color: "#8fd9a8" }}>↑{ahead}</span>
                    <span style={{ color: "#6fb5ff" }}>↓{behind}</span>
                    {dirty > 0 && <span style={{ color: "#e3c279" }}>●{dirty} dirty</span>}
                    <span style={{ flex: 1 }} />
                    <span style={{ color: "#a78bf0" }}>{sess.length} session{sess.length === 1 ? "" : "s"}</span>
                  </div>
                </>
              )}
              <div style={{ marginTop: 10 }}>
                {showOpen && (
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <button onClick={() => onWorktreeSession(project, name, false)} title="create a worktree and start a session" {...hp(`open:${name}`)}
                      style={{ flex: 1, appearance: "none", cursor: "pointer", border: "1px solid #7fe9d8", background: hov === `open:${name}` ? "rgba(127,233,216,.22)" : "rgba(127,233,216,.12)", color: "#dff8f2", fontFamily: "inherit", fontSize: 9.5, letterSpacing: 1, padding: 8, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                      <span style={{ color: "#7fe9d8" }}>▸</span>OPEN WORKTREE</button>
                    <button onClick={() => setConfirmDel({ branch: name, path: "", sessCount: sess.length, hasWorktree: open })} title="delete branch" {...hp(`del:${name}`)}
                      style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(224,137,122,.28)", background: hov === `del:${name}` ? "rgba(224,137,122,.1)" : "transparent", color: hov === `del:${name}` ? "#e0897a" : "#9a6f68", fontFamily: "inherit", fontSize: 12, padding: "7px 10px", flex: "none", lineHeight: 1 }}>✕</button>
                  </div>
                )}
                {showMerge && (
                  <>
                    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <button onClick={() => { const s = sess[0]; if (s) onSelectSession(s); else onWorktreeSession(project, name, false); }} title="attach a session on this worktree" {...hp(`att:${name}`)}
                        style={{ appearance: "none", cursor: "pointer", border: "1px solid #7fe9d8", background: hov === `att:${name}` ? "rgba(127,233,216,.22)" : "rgba(127,233,216,.12)", color: "#dff8f2", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "7px 12px", flex: "none", display: "flex", alignItems: "center", gap: 5 }}>
                        <span style={{ color: "#7fe9d8" }}>▸</span>ATTACH SESSION</button>
                      <button onClick={() => onWorktreeSession(project, name, false)} title="start another session on this worktree" {...hp(`plus:${name}`)}
                        style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(127,233,216,.22)", background: hov === `plus:${name}` ? "rgba(127,233,216,.06)" : "transparent", color: "#9fc7c0", fontFamily: "inherit", fontSize: 12, padding: "6px 10px", flex: "none", lineHeight: 1 }}>+</button>
                      <span style={{ flex: 1 }} />
                      <button onClick={() => setConfirmDel({ branch: name, path: wt?.path ?? "", sessCount: sess.length, hasWorktree: open })} title="delete branch + worktree" {...hp(`del:${name}`)}
                        style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(224,137,122,.28)", background: hov === `del:${name}` ? "rgba(224,137,122,.1)" : "transparent", color: hov === `del:${name}` ? "#e0897a" : "#9a6f68", fontFamily: "inherit", fontSize: 12, padding: "6px 10px", flex: "none", lineHeight: 1 }}>✕</button>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, paddingTop: 9, borderTop: "1px dashed rgba(127,233,216,.12)" }}>
                      <span style={{ fontSize: 8, letterSpacing: 1.5, color: "#6f938d", flex: "none" }}>MERGE INTO</span>
                      <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
                        <button onClick={() => setMergeMenu((m) => (m === name ? "" : name))} title="choose destination branch" {...hp(`mt:${name}`)}
                          style={{ width: "100%", boxSizing: "border-box", appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 5, border: `1px solid ${hov === `mt:${name}` ? "#8fd9a8" : "rgba(143,217,168,.35)"}`, background: "rgba(143,217,168,.05)", color: "#cfe9e3", fontFamily: "'JetBrains Mono',monospace", fontSize: 9.5, padding: "6px 9px" }}>
                          <span style={{ color: "#8fd9a8", flex: "none" }}>⎇</span>
                          <span style={{ flex: 1, minWidth: 0, textAlign: "left", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{mtSel}</span>
                          <span style={{ color: "#6f938d", flex: "none" }}>▾</span>
                        </button>
                        {mergeMenu === name && (
                          <div style={{ position: "absolute", bottom: "calc(100% + 6px)", left: 0, right: 0, zIndex: 30, border: "1px solid rgba(143,217,168,.4)", background: "rgba(7,13,13,.98)", boxShadow: "0 12px 34px rgba(0,0,0,.6)", padding: 5, animation: "mslide .16s ease both" }}>
                            <div style={{ fontSize: 8, letterSpacing: 1.5, color: "#3c544f", padding: "5px 8px 7px" }}>MERGE {name} INTO</div>
                            {targets.map((m) => {
                              const on = m === mtSel;
                              return (
                                <button key={m} onClick={() => { setMergeTarget((t) => ({ ...t, [name]: m })); setMergeMenu(""); }} {...hp(`mti:${name}:${m}`)}
                                  style={{ width: "100%", appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 7, border: 0, borderLeft: `2px solid ${on ? "#8fd9a8" : "transparent"}`, background: hov === `mti:${name}:${m}` ? "rgba(143,217,168,.1)" : on ? "rgba(143,217,168,.08)" : "transparent", color: on ? "#dff8f2" : "#9fc7c0", fontFamily: "'JetBrains Mono',monospace", fontSize: 10, padding: "7px 9px", textAlign: "left" }}>
                                  <span style={{ color: "#8fd9a8", flex: "none" }}>⎇</span>
                                  <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m}</span>
                                  {on && <span style={{ color: "#8fd9a8", flex: "none" }}>✓</span>}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                      <button onClick={() => void doMerge(name, mtSel)} title="merge into the selected branch" {...hp(`mg:${name}`)}
                        style={{ appearance: "none", cursor: "pointer", border: "1px solid #8fd9a8", background: hov === `mg:${name}` ? "rgba(143,217,168,.24)" : "rgba(143,217,168,.14)", color: "#dff8f2", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "6px 14px", flex: "none", display: "flex", alignItems: "center", gap: 5 }}>
                        <span style={{ color: "#8fd9a8" }}>▸</span>MERGE</button>
                    </div>
                  </>
                )}
                {isMerged && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 9.5, letterSpacing: ".5px", color: "#8fd9a8", display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ flex: "none" }}>✓</span>merged into {mtSel}</span>
                    <button onClick={() => setConfirmDel({ branch: name, path: wt?.path ?? "", sessCount: sess.length, hasWorktree: open })} title="delete merged branch + worktree" {...hp(`delm:${name}`)}
                      style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(224,137,122,.4)", background: hov === `delm:${name}` ? "rgba(224,137,122,.18)" : "rgba(224,137,122,.08)", color: "#e0897a", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "6px 11px", flex: "none", display: "flex", alignItems: "center", gap: 5 }}>
                      <span>✕</span>DELETE BRANCH</button>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {/* new worktree */}
        <div style={{ border: "1px solid rgba(185,166,255,.25)", background: "rgba(185,166,255,.04)", padding: "8px 9px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 7 }}>
            <span style={{ fontSize: 8, letterSpacing: 1, color: "#6f6088", flex: "none" }}>NEW WORKTREE FROM</span>
            <button onClick={cycleParent} title="change parent branch — click to cycle" {...hp("cycle")}
              style={{ appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 5, border: `1px solid ${hov === "cycle" ? "#b9a6ff" : "rgba(185,166,255,.35)"}`, background: hov === "cycle" ? "rgba(185,166,255,.18)" : "rgba(185,166,255,.08)", color: "#cbb8ff", fontFamily: "'JetBrains Mono',monospace", fontSize: 9, padding: "3px 8px", minWidth: 0 }}>
              <span style={{ color: "#b9a6ff", flex: "none" }}>⎇</span>
              <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 140 }}>{parentName}</span>
              <span style={{ color: "#6f6088", fontSize: 10, flex: "none" }}>⟳</span>
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ fontSize: 13, color: "#b9a6ff", flex: "none" }}>⎇</span>
            <input value={branchInput} onChange={(e) => setBranchInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") createAndOpen(); }}
              placeholder="new branch name…"
              style={{ flex: 1, minWidth: 0, background: "rgba(7,13,13,.6)", border: "1px solid rgba(127,233,216,.18)", outline: "none", color: "#dff8f2", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, padding: "5px 8px" }} />
            <button onClick={createAndOpen} title="create branch + worktree + session" {...hp("wtopen")}
              style={{ appearance: "none", cursor: "pointer", border: "1px solid #b9a6ff", background: hov === "wtopen" ? "rgba(185,166,255,.24)" : "rgba(185,166,255,.14)", color: "#e7deff", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "6px 10px", flex: "none", display: "flex", alignItems: "center", gap: 5 }}>
              <span>▸</span>OPEN</button>
          </div>
        </div>

        {/* PR: created card / form / button */}
        {prCreated && (
          <div title={prCreated.url} style={{ marginTop: 11, border: "1px solid rgba(143,217,168,.35)", background: "rgba(143,217,168,.06)", padding: "10px 12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, color: "#8fd9a8" }}>⇡ PR {prCreated.num != null ? `#${prCreated.num}` : ""}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 9, letterSpacing: 1, color: "#8fd9a8", border: "1px solid rgba(143,217,168,.4)", padding: "1px 6px" }}>OPEN</span>
            </div>
            <div style={{ fontSize: 11, color: "#cfe9e3", marginTop: 6 }}>{prCreated.title}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 4, fontSize: 9.5, color: "#6f938d", fontFamily: "'JetBrains Mono',monospace" }}>
              <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{prCreated.branch} → {prCreated.base}</span>
              <span style={{ flex: 1 }} />
              <span style={{ color: "#8fd9a8" }}>+{prCreated.add}</span>
              <span style={{ color: "#e0897a" }}>−{prCreated.del}</span>
            </div>
          </div>
        )}
        {prOpen && (
          <div style={{ marginTop: 11, border: "1px solid rgba(185,166,255,.32)", background: "rgba(185,166,255,.05)", padding: "11px 12px" }}>
            <div style={{ fontSize: 9, letterSpacing: 1.5, color: "#3c544f", marginBottom: 8 }}>NEW PULL REQUEST</div>
            <input value={prTitle} onChange={(e) => setPrTitle(e.target.value)} placeholder="pull request title…"
              style={{ width: "100%", boxSizing: "border-box", background: "rgba(7,13,13,.6)", border: "1px solid rgba(127,233,216,.18)", outline: "none", color: "#dff8f2", fontFamily: "inherit", fontSize: 11.5, padding: "7px 9px" }} />
            <div style={{ fontSize: 8.5, letterSpacing: 1.5, color: "#3c544f", margin: "10px 0 6px" }}>MERGE INTO · DESTINATION</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {prDests.map((d) => {
                const on = d === prBaseSel;
                return (
                  <button key={d} onClick={() => setPrBase(d)} {...hp(`prb:${d}`)}
                    style={{ appearance: "none", cursor: "pointer", border: `1px solid ${on || hov === `prb:${d}` ? "#b9a6ff" : "rgba(127,233,216,.18)"}`, background: on ? "rgba(185,166,255,.18)" : "transparent", color: on ? "#e7deff" : "#9fc7c0", fontFamily: "'JetBrains Mono',monospace", fontSize: 10, padding: "5px 8px", display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ color: "#b9a6ff" }}>⎇</span>{d}</button>
                );
              })}
            </div>
            <div style={{ marginTop: 9, border: "1px solid rgba(127,233,216,.12)", background: "rgba(7,13,13,.5)", padding: "8px 10px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "'JetBrains Mono',monospace", fontSize: 10 }}>
                <span style={{ color: "#cbb8ff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{cur} → {prBaseSel}</span>
                <span style={{ flex: 1 }} />
                <span style={{ color: "#8fd9a8" }}>+{prCmp?.add ?? 0}</span>
                <span style={{ color: "#e0897a" }}>−{prCmp?.del ?? 0}</span>
              </div>
              <div style={{ display: "flex", gap: 12, marginTop: 5, fontSize: 9, letterSpacing: ".5px", color: "#6f938d" }}>
                <span>{prCmp?.commits ?? 0} commits</span>
                <span>{prCmp?.files.length ?? 0} files changed</span>
              </div>
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 3 }}>
                {(prCmp?.files ?? []).map((f) => (
                  <div key={f.name} style={{ display: "flex", alignItems: "center", gap: 7, fontFamily: "'JetBrains Mono',monospace", fontSize: 10 }}>
                    <span style={{ color: MARK_COLOR(f.mark), width: 9, flex: "none", fontWeight: 700 }}>{f.mark}</span>
                    <span style={{ color: "#9fc7c0", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", direction: "rtl", textAlign: "left" }}>{f.name}</span>
                    <span style={{ color: "#8fd9a8", fontSize: 9, flex: "none" }}>+{f.add}</span>
                    <span style={{ color: "#e0897a", fontSize: 9, flex: "none" }}>−{f.del}</span>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", gap: 7, marginTop: 9 }}>
              <button onClick={() => void createPr()} {...hp("propen")}
                style={{ flex: 1, appearance: "none", cursor: "pointer", border: "1px solid #b9a6ff", background: hov === "propen" ? "rgba(185,166,255,.24)" : "rgba(185,166,255,.14)", color: "#e7deff", fontFamily: "inherit", fontSize: 10, letterSpacing: 1.5, padding: 7 }}>OPEN PR</button>
              <button onClick={() => setPrOpen(false)} {...hp("prcancel")}
                style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(127,233,216,.2)", background: hov === "prcancel" ? "rgba(127,233,216,.06)" : "transparent", color: "#6f938d", fontFamily: "inherit", fontSize: 10, letterSpacing: 1.5, padding: "7px 12px" }}>CANCEL</button>
            </div>
          </div>
        )}
        {!prOpen && (
          <button onClick={() => { if (!prDisabled) { setPrOpen(true); setPrTitle(`Merge ${cur} into ${prBaseSel}`); } }}
            title={prDisabled ? "check out a feature branch to open a PR" : "open a pull request"} {...hp("prbtn")}
            style={{ width: "100%", marginTop: 11, appearance: "none", cursor: prDisabled ? "not-allowed" : "pointer", border: `1px solid ${prDisabled ? "rgba(127,233,216,.12)" : "rgba(127,233,216,.3)"}`, background: !prDisabled && hov === "prbtn" ? "rgba(127,233,216,.06)" : "transparent", color: prDisabled ? "#3c544f" : "#bfe6de", fontFamily: "inherit", fontSize: 10, letterSpacing: 1.5, padding: 9 }}>⇡ CREATE PULL REQUEST</button>
        )}
      </div>

      {/* DELETE WORKTREE CONFIRM */}
      {confirmDel && (
        <div onClick={() => setConfirmDel(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(4,7,7,.78)", zIndex: 96, display: "flex", alignItems: "center", justifyContent: "center", animation: "backdropIn .2s ease both" }}>
          <div onClick={(e) => e.stopPropagation()} className="panel"
            style={{ width: 450, maxWidth: "92vw", border: "1px solid rgba(224,137,122,.5)", background: "rgba(9,13,13,.99)", boxShadow: "0 0 60px rgba(0,0,0,.8),0 0 26px rgba(224,137,122,.12)", animation: "mslide .2s ease both" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "15px 18px", borderBottom: "1px solid rgba(224,137,122,.2)" }}>
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#e0897a" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" /></svg>
              <span style={{ fontSize: 14, color: "#f0d0c8", letterSpacing: ".5px" }}>Delete worktree</span>
            </div>
            <div style={{ padding: "16px 18px" }}>
              <div style={{ fontSize: 12.5, color: "#cfe9e3", lineHeight: 1.6 }}>
                Removes the worktree checkout and deletes branch <span style={{ fontFamily: "'JetBrains Mono',monospace", color: "#e7b0a6" }}>⎇ {confirmDel.branch}</span>. This can’t be undone.
              </div>
              <div style={{ marginTop: 11, fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: "#5a6f6a", borderLeft: "2px solid rgba(224,137,122,.3)", padding: "3px 0 3px 10px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {confirmDel.hasWorktree ? confirmDel.path : "no worktree checkout — deletes the branch ref only"}
              </div>
              {confirmDel.sessCount > 0 && (
                <div style={{ marginTop: 12, border: "1px solid rgba(227,194,121,.35)", background: "rgba(227,194,121,.06)", color: "#e3c279", fontSize: 10.5, letterSpacing: ".3px", padding: "8px 11px", display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ flex: "none" }}>⚠</span>
                  <span>{confirmDel.sessCount} session{confirmDel.sessCount === 1 ? "" : "s"} running here will be ended.</span>
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 9, padding: "0 18px 16px" }}>
              <button onClick={() => setConfirmDel(null)} {...hp("dcancel")}
                style={{ flex: 1, appearance: "none", cursor: "pointer", border: "1px solid rgba(127,233,216,.25)", background: hov === "dcancel" ? "rgba(127,233,216,.06)" : "transparent", color: "#bfe6de", fontFamily: "inherit", fontSize: 10.5, letterSpacing: 1.5, padding: 10 }}>CANCEL</button>
              <button onClick={() => void doDelete()} disabled={busy} {...hp("dgo")}
                style={{ flex: 1, appearance: "none", cursor: "pointer", border: "1px solid #e0897a", background: hov === "dgo" ? "rgba(224,137,122,.28)" : "rgba(224,137,122,.16)", color: "#f4d5cd", fontFamily: "inherit", fontSize: 10.5, letterSpacing: 1.5, padding: 10, display: "flex", alignItems: "center", justifyContent: "center", gap: 7, opacity: busy ? 0.6 : 1 }}>
                <span>✕</span>DELETE BRANCH</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
