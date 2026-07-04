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

const MARK_COLOR = (s: string) => (s === "A" ? "var(--ok)" : s === "D" ? "var(--err)" : "var(--warn)");

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
          <span style={{ fontSize: 9.5, letterSpacing: 1.5, color: "var(--txl)" }}>WORKTREES</span>
          <span style={{ fontSize: 8.5, letterSpacing: ".5px", color: "var(--purple-g)" }}>{wtOpenCount} OPEN</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 9, letterSpacing: ".5px", color: "var(--txd)", fontFamily: "'JetBrains Mono',monospace" }}>●{git?.dirty ?? 0} ↑{git?.ahead ?? 0} ↓{git?.behind ?? 0}</span>
        </div>

        {banner && (
          <div style={{ border: "1px solid color-mix(in srgb, var(--acc) 35%, transparent)", background: "color-mix(in srgb, var(--acc) 6%, transparent)", color: "var(--tx)", fontSize: 10, letterSpacing: ".2px", padding: "8px 11px", marginBottom: 9, display: "flex", alignItems: "center", gap: 8, animation: "mslide .25s ease both", fontFamily: "'JetBrains Mono',monospace" }}>
            <span style={{ color: "var(--acc)", flex: "none" }}>▸</span>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{banner}</span>
          </div>
        )}

        {/* base branch row */}
        <div style={{ display: "flex", alignItems: "center", gap: 9, border: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", padding: "8px 11px", marginBottom: 8, background: "color-mix(in srgb, var(--panel2) 30%, transparent)" }}>
          <span style={{ fontSize: 12, color: "var(--acc)", flex: "none" }}>⎇</span>
          <button onClick={() => void checkout(base)} title={`checkout ${base}`} {...hp("base")}
            style={{ flex: 1, minWidth: 0, appearance: "none", border: 0, background: "transparent", cursor: "pointer", textAlign: "left", fontFamily: "'JetBrains Mono',monospace", fontSize: 11.5, color: hov === "base" ? "var(--txb)" : "var(--txh)" }}>{base}</button>
          <span style={{ fontSize: 8, letterSpacing: 1, color: "#456b65", flex: "none" }}>BASE</span>
          {cur === base && <span style={{ fontSize: 8, letterSpacing: 1, color: "var(--acc-on)", background: "var(--acc)", padding: "2px 6px", flex: "none" }}>HEAD</span>}
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
          const accent = current ? "var(--acc)" : isMerged ? "color-mix(in srgb, var(--ok) 45%, transparent)" : open ? "color-mix(in srgb, var(--acc) 32%, transparent)" : "color-mix(in srgb, var(--acc) 10%, transparent)";
          const cardBg = current ? "color-mix(in srgb, var(--acc) 5%, transparent)" : isMerged ? "color-mix(in srgb, var(--ok) 4%, transparent)" : "transparent";
          const nameColor = current ? "var(--txb)" : open ? "var(--txh)" : "var(--txm)";
          const statusColor = isMerged ? "var(--ok)" : open ? "var(--acc)" : "var(--txf)";
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
                  style={{ flex: 1, minWidth: 0, appearance: "none", border: 0, background: "transparent", cursor: "pointer", textAlign: "left", fontFamily: "'JetBrains Mono',monospace", fontSize: 11.5, color: hov === `co:${name}` ? "var(--txb)" : nameColor, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</button>
                {current && <span style={{ fontSize: 8, letterSpacing: 1, color: "var(--acc-on)", background: "var(--acc)", padding: "2px 6px", flex: "none" }}>HEAD</span>}
                <span style={{ display: "flex", alignItems: "center", gap: 5, flex: "none" }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: statusColor }} />
                  <span style={{ fontSize: 8, letterSpacing: 1, color: statusColor }}>{statusLabel}</span>
                </span>
              </div>
              {open && (
                <>
                  <div style={{ marginTop: 7, fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: "var(--txf)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={wt.path}>{wt.path}</div>
                  <div style={{ marginTop: 5, display: "flex", alignItems: "center", gap: 10, fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: "var(--txd)" }}>
                    <span style={{ color: "var(--ok)" }}>↑{ahead}</span>
                    <span style={{ color: "var(--info)" }}>↓{behind}</span>
                    {dirty > 0 && <span style={{ color: "var(--warn)" }}>●{dirty} dirty</span>}
                    <span style={{ flex: 1 }} />
                    <span style={{ color: "var(--purple-d)" }}>{sess.length} session{sess.length === 1 ? "" : "s"}</span>
                  </div>
                </>
              )}
              <div style={{ marginTop: 10 }}>
                {showOpen && (
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <button onClick={() => onWorktreeSession(project, name, false)} title="create a worktree and start a session" {...hp(`open:${name}`)}
                      style={{ flex: 1, appearance: "none", cursor: "pointer", border: "1px solid var(--acc)", background: hov === `open:${name}` ? "color-mix(in srgb, var(--acc) 22%, transparent)" : "color-mix(in srgb, var(--acc) 12%, transparent)", color: "var(--txb)", fontFamily: "inherit", fontSize: 9.5, letterSpacing: 1, padding: 8, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                      <span style={{ color: "var(--acc)" }}>▸</span>OPEN WORKTREE</button>
                    <button onClick={() => setConfirmDel({ branch: name, path: "", sessCount: sess.length, hasWorktree: open })} title="delete branch" {...hp(`del:${name}`)}
                      style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--err) 28%, transparent)", background: hov === `del:${name}` ? "color-mix(in srgb, var(--err) 10%, transparent)" : "transparent", color: hov === `del:${name}` ? "var(--err)" : "var(--err-g)", fontFamily: "inherit", fontSize: 12, padding: "7px 10px", flex: "none", lineHeight: 1 }}>✕</button>
                  </div>
                )}
                {showMerge && (
                  <>
                    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <button onClick={() => { const s = sess[0]; if (s) onSelectSession(s); else onWorktreeSession(project, name, false); }} title="attach a session on this worktree" {...hp(`att:${name}`)}
                        style={{ appearance: "none", cursor: "pointer", border: "1px solid var(--acc)", background: hov === `att:${name}` ? "color-mix(in srgb, var(--acc) 22%, transparent)" : "color-mix(in srgb, var(--acc) 12%, transparent)", color: "var(--txb)", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "7px 12px", flex: "none", display: "flex", alignItems: "center", gap: 5 }}>
                        <span style={{ color: "var(--acc)" }}>▸</span>ATTACH SESSION</button>
                      <button onClick={() => onWorktreeSession(project, name, false)} title="start another session on this worktree" {...hp(`plus:${name}`)}
                        style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 22%, transparent)", background: hov === `plus:${name}` ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "transparent", color: "var(--txm)", fontFamily: "inherit", fontSize: 12, padding: "6px 10px", flex: "none", lineHeight: 1 }}>+</button>
                      <span style={{ flex: 1 }} />
                      <button onClick={() => setConfirmDel({ branch: name, path: wt?.path ?? "", sessCount: sess.length, hasWorktree: open })} title="delete branch + worktree" {...hp(`del:${name}`)}
                        style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--err) 28%, transparent)", background: hov === `del:${name}` ? "color-mix(in srgb, var(--err) 10%, transparent)" : "transparent", color: hov === `del:${name}` ? "var(--err)" : "var(--err-g)", fontFamily: "inherit", fontSize: 12, padding: "6px 10px", flex: "none", lineHeight: 1 }}>✕</button>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, paddingTop: 9, borderTop: "1px dashed color-mix(in srgb, var(--acc) 12%, transparent)" }}>
                      <span style={{ fontSize: 8, letterSpacing: 1.5, color: "var(--txd)", flex: "none" }}>MERGE INTO</span>
                      <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
                        <button onClick={() => setMergeMenu((m) => (m === name ? "" : name))} title="choose destination branch" {...hp(`mt:${name}`)}
                          style={{ width: "100%", boxSizing: "border-box", appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 5, border: `1px solid ${hov === `mt:${name}` ? "var(--ok)" : "color-mix(in srgb, var(--ok) 35%, transparent)"}`, background: "color-mix(in srgb, var(--ok) 5%, transparent)", color: "var(--txh)", fontFamily: "'JetBrains Mono',monospace", fontSize: 9.5, padding: "6px 9px" }}>
                          <span style={{ color: "var(--ok)", flex: "none" }}>⎇</span>
                          <span style={{ flex: 1, minWidth: 0, textAlign: "left", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{mtSel}</span>
                          <span style={{ color: "var(--txd)", flex: "none" }}>▾</span>
                        </button>
                        {mergeMenu === name && (
                          <div style={{ position: "absolute", bottom: "calc(100% + 6px)", left: 0, right: 0, zIndex: 30, border: "1px solid color-mix(in srgb, var(--ok) 40%, transparent)", background: "color-mix(in srgb, var(--panel2) 98%, transparent)", boxShadow: "0 12px 34px rgba(0,0,0,.6)", padding: 5, animation: "mslide .16s ease both" }}>
                            <div style={{ fontSize: 8, letterSpacing: 1.5, color: "var(--txl)", padding: "5px 8px 7px" }}>MERGE {name} INTO</div>
                            {targets.map((m) => {
                              const on = m === mtSel;
                              return (
                                <button key={m} onClick={() => { setMergeTarget((t) => ({ ...t, [name]: m })); setMergeMenu(""); }} {...hp(`mti:${name}:${m}`)}
                                  style={{ width: "100%", appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 7, border: 0, borderLeft: `2px solid ${on ? "var(--ok)" : "transparent"}`, background: hov === `mti:${name}:${m}` ? "color-mix(in srgb, var(--ok) 10%, transparent)" : on ? "color-mix(in srgb, var(--ok) 8%, transparent)" : "transparent", color: on ? "var(--txb)" : "var(--txm)", fontFamily: "'JetBrains Mono',monospace", fontSize: 10, padding: "7px 9px", textAlign: "left" }}>
                                  <span style={{ color: "var(--ok)", flex: "none" }}>⎇</span>
                                  <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m}</span>
                                  {on && <span style={{ color: "var(--ok)", flex: "none" }}>✓</span>}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                      <button onClick={() => void doMerge(name, mtSel)} title="merge into the selected branch" {...hp(`mg:${name}`)}
                        style={{ appearance: "none", cursor: "pointer", border: "1px solid var(--ok)", background: hov === `mg:${name}` ? "color-mix(in srgb, var(--ok) 24%, transparent)" : "color-mix(in srgb, var(--ok) 14%, transparent)", color: "var(--txb)", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "6px 14px", flex: "none", display: "flex", alignItems: "center", gap: 5 }}>
                        <span style={{ color: "var(--ok)" }}>▸</span>MERGE</button>
                    </div>
                  </>
                )}
                {isMerged && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 9.5, letterSpacing: ".5px", color: "var(--ok)", display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ flex: "none" }}>✓</span>merged into {mtSel}</span>
                    <button onClick={() => setConfirmDel({ branch: name, path: wt?.path ?? "", sessCount: sess.length, hasWorktree: open })} title="delete merged branch + worktree" {...hp(`delm:${name}`)}
                      style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--err) 40%, transparent)", background: hov === `delm:${name}` ? "color-mix(in srgb, var(--err) 18%, transparent)" : "color-mix(in srgb, var(--err) 8%, transparent)", color: "var(--err)", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "6px 11px", flex: "none", display: "flex", alignItems: "center", gap: 5 }}>
                      <span>✕</span>DELETE BRANCH</button>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {/* new worktree */}
        <div style={{ border: "1px solid color-mix(in srgb, var(--purple) 25%, transparent)", background: "color-mix(in srgb, var(--purple) 4%, transparent)", padding: "8px 9px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 7 }}>
            <span style={{ fontSize: 8, letterSpacing: 1, color: "var(--purple-g)", flex: "none" }}>NEW WORKTREE FROM</span>
            <button onClick={cycleParent} title="change parent branch — click to cycle" {...hp("cycle")}
              style={{ appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 5, border: `1px solid ${hov === "cycle" ? "var(--purple)" : "color-mix(in srgb, var(--purple) 35%, transparent)"}`, background: hov === "cycle" ? "color-mix(in srgb, var(--purple) 18%, transparent)" : "color-mix(in srgb, var(--purple) 8%, transparent)", color: "var(--purple-h)", fontFamily: "'JetBrains Mono',monospace", fontSize: 9, padding: "3px 8px", minWidth: 0 }}>
              <span style={{ color: "var(--purple)", flex: "none" }}>⎇</span>
              <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 140 }}>{parentName}</span>
              <span style={{ color: "var(--purple-g)", fontSize: 10, flex: "none" }}>⟳</span>
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ fontSize: 13, color: "var(--purple)", flex: "none" }}>⎇</span>
            <input value={branchInput} onChange={(e) => setBranchInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") createAndOpen(); }}
              placeholder="new branch name…"
              style={{ flex: 1, minWidth: 0, background: "color-mix(in srgb, var(--panel2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--acc) 18%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, padding: "5px 8px" }} />
            <button onClick={createAndOpen} title="create branch + worktree + session" {...hp("wtopen")}
              style={{ appearance: "none", cursor: "pointer", border: "1px solid var(--purple)", background: hov === "wtopen" ? "color-mix(in srgb, var(--purple) 24%, transparent)" : "color-mix(in srgb, var(--purple) 14%, transparent)", color: "var(--purple-b)", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "6px 10px", flex: "none", display: "flex", alignItems: "center", gap: 5 }}>
              <span>▸</span>OPEN</button>
          </div>
        </div>

        {/* PR: created card / form / button */}
        {prCreated && (
          <div title={prCreated.url} style={{ marginTop: 11, border: "1px solid color-mix(in srgb, var(--ok) 35%, transparent)", background: "color-mix(in srgb, var(--ok) 6%, transparent)", padding: "10px 12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, color: "var(--ok)" }}>⇡ PR {prCreated.num != null ? `#${prCreated.num}` : ""}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 9, letterSpacing: 1, color: "var(--ok)", border: "1px solid color-mix(in srgb, var(--ok) 40%, transparent)", padding: "1px 6px" }}>OPEN</span>
            </div>
            <div style={{ fontSize: 11, color: "var(--txh)", marginTop: 6 }}>{prCreated.title}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 4, fontSize: 9.5, color: "var(--txd)", fontFamily: "'JetBrains Mono',monospace" }}>
              <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{prCreated.branch} → {prCreated.base}</span>
              <span style={{ flex: 1 }} />
              <span style={{ color: "var(--ok)" }}>+{prCreated.add}</span>
              <span style={{ color: "var(--err)" }}>−{prCreated.del}</span>
            </div>
          </div>
        )}
        {prOpen && (
          <div style={{ marginTop: 11, border: "1px solid color-mix(in srgb, var(--purple) 32%, transparent)", background: "color-mix(in srgb, var(--purple) 5%, transparent)", padding: "11px 12px" }}>
            <div style={{ fontSize: 9, letterSpacing: 1.5, color: "var(--txl)", marginBottom: 8 }}>NEW PULL REQUEST</div>
            <input value={prTitle} onChange={(e) => setPrTitle(e.target.value)} placeholder="pull request title…"
              style={{ width: "100%", boxSizing: "border-box", background: "color-mix(in srgb, var(--panel2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--acc) 18%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "inherit", fontSize: 11.5, padding: "7px 9px" }} />
            <div style={{ fontSize: 8.5, letterSpacing: 1.5, color: "var(--txl)", margin: "10px 0 6px" }}>MERGE INTO · DESTINATION</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {prDests.map((d) => {
                const on = d === prBaseSel;
                return (
                  <button key={d} onClick={() => setPrBase(d)} {...hp(`prb:${d}`)}
                    style={{ appearance: "none", cursor: "pointer", border: `1px solid ${on || hov === `prb:${d}` ? "var(--purple)" : "color-mix(in srgb, var(--acc) 18%, transparent)"}`, background: on ? "color-mix(in srgb, var(--purple) 18%, transparent)" : "transparent", color: on ? "var(--purple-b)" : "var(--txm)", fontFamily: "'JetBrains Mono',monospace", fontSize: 10, padding: "5px 8px", display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ color: "var(--purple)" }}>⎇</span>{d}</button>
                );
              })}
            </div>
            <div style={{ marginTop: 9, border: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", background: "color-mix(in srgb, var(--panel2) 50%, transparent)", padding: "8px 10px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "'JetBrains Mono',monospace", fontSize: 10 }}>
                <span style={{ color: "var(--purple-h)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{cur} → {prBaseSel}</span>
                <span style={{ flex: 1 }} />
                <span style={{ color: "var(--ok)" }}>+{prCmp?.add ?? 0}</span>
                <span style={{ color: "var(--err)" }}>−{prCmp?.del ?? 0}</span>
              </div>
              <div style={{ display: "flex", gap: 12, marginTop: 5, fontSize: 9, letterSpacing: ".5px", color: "var(--txd)" }}>
                <span>{prCmp?.commits ?? 0} commits</span>
                <span>{prCmp?.files.length ?? 0} files changed</span>
              </div>
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 3 }}>
                {(prCmp?.files ?? []).map((f) => (
                  <div key={f.name} style={{ display: "flex", alignItems: "center", gap: 7, fontFamily: "'JetBrains Mono',monospace", fontSize: 10 }}>
                    <span style={{ color: MARK_COLOR(f.mark), width: 9, flex: "none", fontWeight: 700 }}>{f.mark}</span>
                    <span style={{ color: "var(--txm)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", direction: "rtl", textAlign: "left" }}>{f.name}</span>
                    <span style={{ color: "var(--ok)", fontSize: 9, flex: "none" }}>+{f.add}</span>
                    <span style={{ color: "var(--err)", fontSize: 9, flex: "none" }}>−{f.del}</span>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", gap: 7, marginTop: 9 }}>
              <button onClick={() => void createPr()} {...hp("propen")}
                style={{ flex: 1, appearance: "none", cursor: "pointer", border: "1px solid var(--purple)", background: hov === "propen" ? "color-mix(in srgb, var(--purple) 24%, transparent)" : "color-mix(in srgb, var(--purple) 14%, transparent)", color: "var(--purple-b)", fontFamily: "inherit", fontSize: 10, letterSpacing: 1.5, padding: 7 }}>OPEN PR</button>
              <button onClick={() => setPrOpen(false)} {...hp("prcancel")}
                style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)", background: hov === "prcancel" ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "transparent", color: "var(--txd)", fontFamily: "inherit", fontSize: 10, letterSpacing: 1.5, padding: "7px 12px" }}>CANCEL</button>
            </div>
          </div>
        )}
        {!prOpen && (
          <button onClick={() => { if (!prDisabled) { setPrOpen(true); setPrTitle(`Merge ${cur} into ${prBaseSel}`); } }}
            title={prDisabled ? "check out a feature branch to open a PR" : "open a pull request"} {...hp("prbtn")}
            style={{ width: "100%", marginTop: 11, appearance: "none", cursor: prDisabled ? "not-allowed" : "pointer", border: `1px solid ${prDisabled ? "color-mix(in srgb, var(--acc) 12%, transparent)" : "color-mix(in srgb, var(--acc) 30%, transparent)"}`, background: !prDisabled && hov === "prbtn" ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "transparent", color: prDisabled ? "var(--txl)" : "var(--tx)", fontFamily: "inherit", fontSize: 10, letterSpacing: 1.5, padding: 9 }}>⇡ CREATE PULL REQUEST</button>
        )}
      </div>

      {/* DELETE WORKTREE CONFIRM */}
      {confirmDel && (
        <div onClick={() => setConfirmDel(null)}
          style={{ position: "fixed", inset: 0, background: "color-mix(in srgb, var(--panel3) 78%, transparent)", zIndex: 96, display: "flex", alignItems: "center", justifyContent: "center", animation: "backdropIn .2s ease both" }}>
          <div onClick={(e) => e.stopPropagation()} className="panel"
            style={{ width: 450, maxWidth: "92vw", border: "1px solid color-mix(in srgb, var(--err) 50%, transparent)", background: "rgba(9,13,13,.99)", boxShadow: "0 0 60px rgba(0,0,0,.8),0 0 26px color-mix(in srgb, var(--err) 12%, transparent)", animation: "mslide .2s ease both" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "15px 18px", borderBottom: "1px solid color-mix(in srgb, var(--err) 20%, transparent)" }}>
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="var(--err)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" /></svg>
              <span style={{ fontSize: 14, color: "var(--err-hi)", letterSpacing: ".5px" }}>Delete worktree</span>
            </div>
            <div style={{ padding: "16px 18px" }}>
              <div style={{ fontSize: 12.5, color: "var(--txh)", lineHeight: 1.6 }}>
                Removes the worktree checkout and deletes branch <span style={{ fontFamily: "'JetBrains Mono',monospace", color: "#e7b0a6" }}>⎇ {confirmDel.branch}</span>. This can’t be undone.
              </div>
              <div style={{ marginTop: 11, fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: "var(--txf)", borderLeft: "2px solid color-mix(in srgb, var(--err) 30%, transparent)", padding: "3px 0 3px 10px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {confirmDel.hasWorktree ? confirmDel.path : "no worktree checkout — deletes the branch ref only"}
              </div>
              {confirmDel.sessCount > 0 && (
                <div style={{ marginTop: 12, border: "1px solid color-mix(in srgb, var(--warn) 35%, transparent)", background: "color-mix(in srgb, var(--warn) 6%, transparent)", color: "var(--warn)", fontSize: 10.5, letterSpacing: ".3px", padding: "8px 11px", display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ flex: "none" }}>⚠</span>
                  <span>{confirmDel.sessCount} session{confirmDel.sessCount === 1 ? "" : "s"} running here will be ended.</span>
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 9, padding: "0 18px 16px" }}>
              <button onClick={() => setConfirmDel(null)} {...hp("dcancel")}
                style={{ flex: 1, appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: hov === "dcancel" ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "transparent", color: "var(--tx)", fontFamily: "inherit", fontSize: 10.5, letterSpacing: 1.5, padding: 10 }}>CANCEL</button>
              <button onClick={() => void doDelete()} disabled={busy} {...hp("dgo")}
                style={{ flex: 1, appearance: "none", cursor: "pointer", border: "1px solid var(--err)", background: hov === "dgo" ? "color-mix(in srgb, var(--err) 28%, transparent)" : "color-mix(in srgb, var(--err) 16%, transparent)", color: "var(--err-b)", fontFamily: "inherit", fontSize: 10.5, letterSpacing: 1.5, padding: 10, display: "flex", alignItems: "center", justifyContent: "center", gap: 7, opacity: busy ? 0.6 : 1 }}>
                <span>✕</span>DELETE BRANCH</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
