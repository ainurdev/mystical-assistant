import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, GitBranch, Search, SquareTerminal } from "lucide-react";
import { api, type GitBadge, type GitStatus, type SessionBrief, type SessionStatus, type Worktree } from "../../api";
import { useAiFeatures } from "../../lib/ai";
import { isMacApp } from "../../lib/mac";
import { projectName } from "../../lib/surfaces";
import { ProjectTile } from "../ui/ProjectTile";
import { EditorTab, type BranchOpt } from "./EditorTab";
import { MapTab } from "./MapTab";
import { Lights } from "./Strip";
import { TermDrawer } from "./TermDrawer";
import MarkEditor from "./MarkEditor";

/* The FILE WINDOW (AnalyzeModal by name) — full-bleed since
   .mystical/design-drafts/editor-window: the window is the screen, with no
   backdrop, no rounded corners and nothing of the dashboard at its edges. One
   title bar: the project's mark (its tile opens MarkEditor), the branch it
   shows, ↑↓, LIVE, a ⌘P box for the editor's palette, the terminal's toggle,
   close. The EDITOR (EditorTab) fills the rest — explorer · search · outline ·
   changes · map down its activity bar, the terminal a drawer under the code.

   Nothing opens it on purpose: a file does (FILES, a file link in chat); a
   changed file opens it on CHANGES with its diff inline (the GIT tab that showed
   diffs here went — commits are the rail's GIT tab); RUN and a transcript
   re-run open the terminal drawer; the MAP chip opens the map. */

export type Tab = "changes" | "editor" | "terminal" | "map";

interface Props {
  project: string;
  badge?: GitBadge;
  sessions: SessionBrief[];
  status: Map<string, SessionStatus>;
  // Deep-link from the sidebar FILES explorer: open straight into the editor
  // on this file, in the branch's worktree the explorer was listing.
  initialFile?: string;
  initialBranch?: string;
  /** Line named by a chat file reference (`RunStream.tsx:190`) — the editor
      opens scrolled to it. */
  initialLine?: number;
  /** How it opens: on CHANGES (a changed file), the terminal, the map — else the editor. */
  initialTab?: Tab;
  /** Re-run from a transcript terminal block: typed into the drawer's PTY. */
  initialCommand?: string;
  /** What this session wrote — ✦ in CHANGES. */
  edited?: Set<string>;
  onClose: () => void;
  /** ✦ Ask Claude / REVIEW: text for the prompt; `close` when no unsaved edits hold the window. */
  onAsk?: (text: string, close: boolean) => void;
  /** COMMIT IN GIT ›: close, and show the rail's GIT tab. */
  onOpenGit?: () => void;
}

export function AnalyzeModal(props: Props) {
  const { project, badge } = props;
  const [hov, setHov] = useState("");
  const hp = (k: string) => ({ onMouseEnter: () => setHov(k), onMouseLeave: () => setHov("") });

  const aiFeatures = useAiFeatures();   // MAP hides with its switch, and with the repo's own
  const [mapOn, setMapOn] = useState(false);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [termCount, setTermCount] = useState(0);
  // The drawer mounts on its first show and only hides after: its PTYs and
  // their scrollback keep running underneath.
  const [term, setTerm] = useState<"none" | "open" | "hidden">(props.initialTab === "terminal" ? "open" : "none");
  const [closing, setClosing] = useState(false);
  // window-wide branch focus (which worktree the editor shows)
  const [selectedBranch, setSelectedBranch] = useState(props.initialBranch ?? "");
  const [menuOpen, setMenuOpen] = useState(false);
  const [markOpen, setMarkOpen] = useState(false);   // the tile's mark editor
  const markTile = useRef<HTMLButtonElement>(null);
  const bus = useRef<{ palette?: () => void }>({});
  const mac = isMacApp();

  const refreshWt = () => {
    void api.worktrees(project)
      .then((w) => setWorktrees(w.worktrees))
      .catch(() => {});
  };

  useEffect(() => {
    setSelectedBranch(props.initialBranch ?? "");
    setMarkOpen(false);
    void api.git(project).then(setGit).catch(() => {});
    void api.branches(project).then((b) => { setBranches(b.branches); if (b.default) setDefaultBranch(b.default); }).catch(() => {});
    refreshWt();
    void api.terminals(project).then((d) => setTermCount(d.terminals.length)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  useEffect(() => {
    if (!aiFeatures.graph) { setMapOn(false); return; }
    void api.graphState(project).then((g) => setMapOn(g.repo_on !== false)).catch(() => setMapOn(false));
  }, [project, aiFeatures.graph]);

  // default viewed branch → the checked-out branch
  useEffect(() => { const c = git?.branch || badge?.branch; if (c) setSelectedBranch((p) => p || c); }, [git, badge]);

  function close() {
    setClosing(true);
    setTimeout(props.onClose, 200);
  }

  const cur = git?.branch || badge?.branch || "";
  const live = props.sessions.some((s) => {
    const st = props.status.get(s.id)?.state;
    return st === "working" || st === "live";
  });

  const branchOpts: BranchOpt[] = useMemo(() => {
    const list = branches.length ? branches : (cur ? [cur] : []);
    return list.map((b) => ({ name: b, on: b === (selectedBranch || cur), hasWorktree: worktrees.some((w) => w.branch === b) }));
  }, [branches, cur, selectedBranch, worktrees]);
  const toggleTerm = () => setTerm((t) => (t === "open" ? "hidden" : "open"));
  const line = (a: number, c = "acc") => `1px solid color-mix(in srgb, var(--${c}) ${a}%, transparent)`;
  const mono = "'JetBrains Mono',monospace";

  return (
    <div className="fwin"
      style={{ position: "fixed", inset: 0, zIndex: 92, display: "flex", flexDirection: "column", background: "var(--panel2)", color: "var(--tx)", animation: closing ? "backdropOut .2s ease forwards" : "backdropIn .2s ease both" }}>
      {/* title bar — in Mystical.app its bare surface drags the window (App's
          --mac-titlebar listener), and the page's traffic lights sit at its left */}
      <div style={{ position: "relative", height: 40, flex: "none", display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center", gap: 12, padding: `0 10px 0 ${mac ? 82 : 12}px`, borderBottom: line(14), background: "color-mix(in srgb, var(--panel3) 70%, transparent)" }}>
        {mac && <Lights show />}
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          {/* The project's tile is its mark editor: a logo, an icon or its initials, and its colour. */}
          <span className="mkwrap an-mark">
            <button ref={markTile} type="button" className="mktile" data-on={markOpen || undefined} onClick={() => setMarkOpen((o) => !o)}
              title="this project's mark: a logo, an icon or its initials">
              <ProjectTile project={project} />
            </button>
            {markOpen && (
              <MarkEditor project={project} name={projectName(project)} anchor={markTile.current} onClose={() => setMarkOpen(false)} />
            )}
          </span>
          <span style={{ fontSize: "var(--t13)", color: "var(--txb)", letterSpacing: ".3px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{projectName(project)}</span>
          {/* the branch the window shows — worktrees marked */}
          <div style={{ position: "relative", flex: "none" }}>
            <button onClick={() => setMenuOpen((o) => !o)} title="switch branch — worktrees marked" {...hp("br")}
              style={{ appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 5, border: `1px solid ${hov === "br" ? "var(--purple)" : "color-mix(in srgb, var(--purple) 30%, transparent)"}`, background: "color-mix(in srgb, var(--purple) 6%, transparent)", color: "var(--purple-h)", fontFamily: mono, fontSize: "var(--t95)", padding: "3px 8px", maxWidth: 200 }}>
              <GitBranch size={12} strokeWidth={1.8} style={{ color: "var(--purple)", flex: "none" }} />
              <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{selectedBranch || cur || "—"}</span>
              <ChevronDown size={11} strokeWidth={1.8} style={{ color: "var(--purple-g)", flex: "none" }} />
            </button>
            {menuOpen && (
              <div style={{ position: "absolute", top: "calc(100% + 5px)", left: 0, zIndex: 30, minWidth: 214, border: "1px solid color-mix(in srgb, var(--purple) 40%, transparent)", background: "color-mix(in srgb, var(--panel2) 99%, transparent)", boxShadow: "0 12px 32px var(--shadow-pop)", padding: 5, animation: "mslide .16s ease both" }}>
                <div style={{ fontSize: "var(--t8)", letterSpacing: 1.5, color: "var(--txl)", padding: "5px 8px 7px" }}>SWITCH BRANCH</div>
                {branchOpts.map((b) => (
                  <button key={b.name} onClick={() => { setSelectedBranch(b.name); setMenuOpen(false); }} {...hp(`bi:${b.name}`)}
                    style={{ width: "100%", appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 7, border: 0, background: hov === `bi:${b.name}` ? "color-mix(in srgb, var(--purple) 10%, transparent)" : "transparent", color: "var(--purple-h)", fontFamily: mono, fontSize: "var(--t10)", padding: "7px 9px", textAlign: "left" }}>
                    <span style={{ color: "var(--purple)", flex: "none" }}>⎇</span>
                    <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{b.name}</span>
                    {b.hasWorktree && <span style={{ fontSize: "var(--t75)", letterSpacing: 1, color: "var(--ok)", border: "1px solid color-mix(in srgb, var(--ok) 35%, transparent)", padding: "1px 4px", flex: "none" }}>WORKTREE</span>}
                    {b.on && <span style={{ color: "var(--acc)", flex: "none" }}>✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <span style={{ fontSize: "var(--t10)", color: "var(--txd)", display: "flex", gap: 8, fontFamily: mono, flex: "none" }}>
            <span style={{ color: "var(--ok)" }}>↑{git?.ahead ?? badge?.ahead ?? 0}</span>
            <span>↓{git?.behind ?? badge?.behind ?? 0}</span>
          </span>
          {live && <span style={{ fontSize: "var(--t8)", letterSpacing: 1, color: "var(--ok)", border: line(30, "ok"), padding: "1px 6px", flex: "none" }}>LIVE</span>}
        </div>
        {/* the editor's palette, where it can be seen: files · @symbols · >commands */}
        <button onClick={() => bus.current.palette?.()} title="go to a file, a @symbol in this file or a >command · Ctrl-P" {...hp("pal")}
          style={{ appearance: "none", cursor: "pointer", width: "min(440px, 34vw)", height: 27, display: "flex", alignItems: "center", gap: 8, padding: "0 6px 0 10px", border: line(hov === "pal" ? 38 : 20), background: "color-mix(in srgb, var(--panel2) 80%, transparent)", color: "var(--txl)", fontFamily: mono, fontSize: "var(--t105)" }}>
          <Search size={13} strokeWidth={1.8} style={{ flex: "none" }} />
          <span style={{ flex: 1, textAlign: "left", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>Go to file · <span style={{ color: "var(--txd)" }}>@</span>symbol · <span style={{ color: "var(--txd)" }}>&gt;</span>command</span>
          <span style={{ fontSize: "var(--t85)", color: "var(--txl)", border: line(22), padding: "0 5px", lineHeight: "16px", flex: "none" }}>{mac ? "⌘P" : "Ctrl P"}</span>
        </button>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={toggleTerm} title={term === "open" ? "hide the terminal · Ctrl-`" : "terminal · Ctrl-`"} {...hp("term")}
            style={{ appearance: "none", cursor: "pointer", height: 27, display: "flex", alignItems: "center", gap: 6, padding: "0 9px", border: line(term === "open" ? 40 : 22), background: term === "open" ? "color-mix(in srgb, var(--acc) 12%, transparent)" : hov === "term" ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent", color: term === "open" ? "var(--txb)" : "var(--txm)", fontFamily: mono, fontSize: "var(--t95)" }}>
            <SquareTerminal size={15} strokeWidth={1.6} />{termCount > 0 && <span>{termCount}</span>}
          </button>
          <button onClick={close} {...hp("x")}
            style={{ appearance: "none", cursor: "pointer", height: 27, border: line(25), background: hov === "x" ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent", color: "var(--txm)", fontFamily: "inherit", fontSize: "var(--t95)", letterSpacing: 1.5, padding: "0 10px" }}>ESC ✕</button>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <EditorTab project={project} branch={selectedBranch || cur}
          initialFile={props.initialFile} initialLine={props.initialLine} initialMode={props.initialTab}
          bus={bus} edited={props.edited} onAsk={props.onAsk} onOpenGit={props.onOpenGit}
          mapView={mapOn ? <MapTab project={project} /> : undefined}
          drawer={term === "none" ? undefined : (
            <TermDrawer project={project} worktrees={worktrees} branch={cur || defaultBranch} onCount={setTermCount}
              initialCommand={props.initialCommand} open={term === "open"} onHide={() => setTerm("hidden")} />
          )}
          onToggleTerm={toggleTerm} />
      </div>
    </div>
  );
}
