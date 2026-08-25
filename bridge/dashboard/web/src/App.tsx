import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  FileDiff, FolderGit2, FolderTree, GitBranch, GraduationCap, ListTodo, Sparkles,
} from "lucide-react";
import {
  api,
  AUTH_REQUIRED,
  TOKEN,
  type AnswerSelection,
  type DashState,
  type EffortLevel,
  type EnrichedSession,
  type GitBadge,
  type GitStatus,
  type Lifecycle,
  type ModelId,
  type SessionBrief,
  type SessionStatus,
  type UsageInfo,
  type AccountInfo,
  type FreeAgentInfo,
} from "./api";
import { modelOptions, latestPerFamily, type AgentOption } from "./models";
import { activeOf, estimateContextTokens, mergeDelta, type Turn } from "./chat";
import { ckId, type Mark } from "./lib/checkpoints";
import type { TranscriptNav } from "./components/Transcript";
import { useTelemetry } from "./lib/telemetry";
import { ago, useProjectTints } from "./lib/surfaces";
import {
  autoBaseFont,
  fontStack,
  isLight,
  loadSettings,
  sameFamily,
  saveSettings,
  themeCanvas,
  themeDef,
  themeFilter,
  themeVars,
  THEME_TOKEN_KEYS,
  type HudSettings,
  type RightTab,
  type ThemeKey,
} from "./lib/theme";
import { useHostVitals, useRadio, useWeather } from "./lib/ambient";
import { nativeCtxItems } from "./lib/nativeCtx";
import { useAiFeatures } from "./lib/ai";
import { useSessionPins, useStickySet } from "./lib/prefs";
import { nearBottom, stickOnResize, stickToBottom } from "./lib/stick";
import { recall, remember, type Anchor } from "./lib/scrollmem";
import { lastOpen, rememberOpen } from "./lib/lastopen";
import { branchForSession } from "./lib/issuebranch";
import { push, shouldPush } from "./lib/push";
import { playSound, preloadSound, type PushEvent } from "./lib/sounds";
import { chatToMarkdown } from "./lib/chatmd";
import { distinctDirs, fileRefCandidates, resolveFileRef } from "./lib/filepath";
import { Composer } from "./components/Composer";
import { SuggestNewSessionCard } from "./components/SuggestNewSessionCard";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { Strip } from "./components/hud/Strip";
import { StatusBar } from "./components/hud/StatusBar";
import { TaskQueuePanel } from "./components/hud/TaskQueuePanel";
import { ProjectsPanel, type ProjectGroup } from "./components/hud/ProjectsPanel";
import { FilesPanel } from "./components/hud/FilesPanel";
import { SkillsPanel } from "./components/hud/SkillsTab";
import { LearnPanel, READ_KEY } from "./components/hud/LearnTab";
import { RightPanel, type PanelTab } from "./components/RightPanel";
import { GitTab } from "./components/GitTab";
import { SessionsPanel, type PromptFlag } from "./components/hud/SessionsPanel";
import { Terminal } from "./components/hud/Terminal";
import type { View } from "./components/hud/ViewTabs";
import { notify, setNoticeSound } from "./components/hud/Notifications";
import { BootIntro } from "./components/hud/BootIntro";
import { count as bootCount, initialBootSteps, markStep, type BootKey } from "./lib/bootsteps";
import { SettingsModal } from "./components/hud/SettingsModal";
import { AskDialog, askPrompt } from "./components/ui/Ask";
import { confirmLeave, leavePending, leavingOnPurpose, setLeavePending } from "./lib/leaveGuard";
import { RestartIntro, restartBridge } from "./lib/restart";
import { NativeTips } from "./components/ui/Tip";
import { ContextMenu, type CtxItem, type CtxState } from "./components/hud/ContextMenu";
import { AnalyzeModal, type Tab as AnalyzeTab } from "./components/hud/AnalyzeModal";
import { ManageProjectsModal } from "./components/hud/ManageProjectsModal";
import { ToolsModal } from "./components/hud/ToolsModal";
import { InspectorModal } from "./components/hud/InspectorModal";
import { AgentsPill } from "./components/AgentsPill";
import { GoalPill } from "./components/GoalPill";
import { useSessionQueue } from "./components/design/useSessionQueue";
import { Spinner } from "./components/ui";


function fmtReset(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (!isFinite(ms) || ms <= 0) return "now";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}H${String(m).padStart(2, "0")}M`;
}

// One size for every right-rail icon — the rail's buttons are 30px.
const RAIL = { size: 15, strokeWidth: 1.6 } as const;

// Manage-projects choices survive a reload / bridge restart. HIDE is owned by
// the bridge (project_config.json, GET/POST /local/project*), so it syncs across
// browsers; the localStorage copy is only a cache for the pre-first-poll paint.
// ponytail: remove/import stay per-browser — no bridge endpoint for them yet.
const MANAGE_KEY = "hud-project-manage";
type ManagePrefs = { hidden: Record<string, boolean>; removed: Record<string, boolean>; imported: string[] };

function loadManage(): ManagePrefs {
  try {
    const r = JSON.parse(localStorage.getItem(MANAGE_KEY) || "{}") as Partial<ManagePrefs>;
    return { hidden: r.hidden ?? {}, removed: r.removed ?? {}, imported: r.imported ?? [] };
  } catch { return { hidden: {}, removed: {}, imported: [] }; }
}

// Sessions that finished a turn while you were looking elsewhere — flagged DONE
// in the session list until you open them. Persisted so a reload doesn't lose
// "you haven't seen this yet".
const DONE_KEY = "hud-sessions-done";

function loadDone(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(DONE_KEY) || "[]") as string[]); }
  catch { return new Set(); }
}

// Composer text you typed but never sent, per session. Persisted so a reload
// doesn't silently drop it — the DRAFT flags in the session list promise it's
// still there. Image attachments stay in the composer and aren't part of this.
const DRAFTS_KEY = "hud-session-drafts";

function loadDrafts(): Record<string, string> {
  try {
    const r = JSON.parse(localStorage.getItem(DRAFTS_KEY) || "{}") as unknown;
    if (!r || typeof r !== "object") return {};
    return Object.fromEntries(
      Object.entries(r as Record<string, unknown>)
        .filter(([, v]) => typeof v === "string" && v.trim()),
    ) as Record<string, string>;
  } catch { return {}; }
}

/** The relevance check holds the run for ~10s before anything starts. Loud on
 *  purpose: the quiet one-liner this replaced read as the UI being stuck, and
 *  the prompt line shows exactly what's waiting (and in which session). */
function CheckingBanner({ prompt }: { prompt: string }) {
  return (
    <div
      style={{
        position: "relative", overflow: "hidden", margin: "0 16px 9px", padding: "10px 12px",
        border: "1px solid var(--purple)", background: "color-mix(in srgb, var(--purple) 13%, transparent)",
        boxShadow: "0 0 18px color-mix(in srgb, var(--purple) 22%, transparent)",
        animation: "mpop .18s ease both",
      }}
    >
      <span style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: "linear-gradient(90deg,transparent,var(--purple),transparent)", backgroundSize: "200% 100%", animation: "awaitsweep 1.4s linear infinite" }} />
      <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
        <span style={{ color: "var(--purple-b)", display: "flex", flex: "none" }}>
          <Spinner className="h-[11px] w-[11px] border" />
        </span>
        <span style={{ fontSize: "var(--t12)", letterSpacing: 2, fontWeight: 600, color: "var(--purple-b)", flex: "none", animation: "twinkle 1.2s ease-in-out infinite" }}>
          CHECKING CONTEXT…
        </span>
        <span style={{ fontSize: "var(--t10)", letterSpacing: 0.5, color: "var(--txd)" }}>
          deciding if this belongs in this session — nothing has run yet
        </span>
      </div>
      <div style={{ marginTop: 7, fontSize: "var(--t11)", color: "var(--txm)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        <span style={{ color: "var(--purple)" }}>❯ </span>{prompt}
      </div>
    </div>
  );
}

/** Drop one session's entry from a per-session map (same object if absent). */
function omit<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

// A prompt the relevance guardrail parked, with everything needed to route it
// later — the session and project it was written in, not whichever is open when
// the user finally answers the card.
interface HeldPrompt {
  sid: string;
  project?: string;
  cwd?: string | null;   // the run dir (worktree) it was held in, not just the repo
  text: string;
  images: string[];
  reason: string;
  title: string | null;
}

export function App() {
  useProjectTints(); // re-render on saved project tag/colour edits
  const [state, setState] = useState<DashState | null>(null);
  const [sessions, setSessions] = useState<SessionBrief[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loadingSession, setLoadingSession] = useState(false); // true from select until its transcript first resolves
  // Latest transcript fetcher, so answering a permission/question can pull the
  // resolved card in immediately instead of waiting for the next poll tick.
  const refetchTurns = useRef<() => Promise<void>>(async () => {});
  // First list + first state have landed. Until then an empty sessions panel is
  // "still loading", not "you have no projects".
  const [booted, setBooted] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  // What the live turn is waiting on before its first token — a status the poll
  // carries, not a recorded event, so it clears itself when the child speaks.
  const [boot, setBoot] = useState<string | null>(null);
  const [view, setView] = useState<View>("chat");
  // Which model-spending extras are on: each one owns a tab and a palette entry
  // that don't exist while it's off.
  const ai = useAiFeatures();
  const [statusMap, setStatusMap] = useState<Map<string, SessionStatus>>(new Map());
  const [doneIds, setDoneIds] = useState<Set<string>>(loadDone);
  const [pins, togglePin] = useSessionPins();
  // Owned here because the LEARN tab's badge counts what the LEARN panel marks —
  // two copies of the read set would drift apart (same reason as pins).
  const [lessonsRead, setLessonsRead] = useStickySet(READ_KEY);
  const [lessonKeys, setLessonKeys] = useState<string[]>([]);
  const [gitBadges, setGitBadges] = useState<Map<string, GitBadge>>(new Map());
  // The open session's own working tree (its worktree when it has one), which
  // gitBadges can't answer — those are keyed by project, one badge per repo.
  const [sessionGit, setSessionGit] = useState<GitStatus | null>(null);
  // Bumped by the footer's PUBLISH — a 10s poll is too slow to watch a chip you
  // just acted on, so the push re-runs the fetch below instead of waiting.
  const [gitNonce, setGitNonce] = useState(0);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  // Free-agent rungs that are ready to run right now (configured + opencode
  // installed) — the non-Claude half of the AGENT picker.
  const [freeAgents, setFreeAgents] = useState<FreeAgentInfo[]>([]);
  const [inject, setInject] = useState<{ text: string; nonce: number }>({ text: "", nonce: 0 });
  // Prompts the relevance guardrail held back — still client-side, nothing ran.
  // Keyed by the session each one was written in: the check takes ~10s, and a
  // card about session A must not appear (or start work) in session B.
  const [heldMap, setHeldMap] = useState<Record<string, HeldPrompt>>({});
  const [heldBusy, setHeldBusy] = useState(false);
  // /local/run is in flight, per session. Normally ~instant, but a relevance
  // check makes it block for ~10s — without this the composer looks dead.
  const [checkingMap, setCheckingMap] = useState<Record<string, string>>({});
  // Typed but not sent, per session. Lives here (not in the composer) so it
  // survives a session switch and the session list can flag it as a DRAFT.
  const [drafts, setDrafts] = useState<Record<string, string>>(loadDrafts);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // ?skipboot bypasses the intro (handy on revisits + for screenshots).
  const skipBoot = new URLSearchParams(location.search).has("skipboot");
  const [booting, setBooting] = useState(!skipBoot);
  const [showDashboard, setShowDashboard] = useState(skipBoot);
  // The intro's boot log. Each of the five startup fetches below reports into
  // it as it lands, so the lines and the bar are the real load, not a timer.
  const [bootSteps, setBootSteps] = useState(initialBootSteps);
  const markBoot = useCallback((key: BootKey, phase: "ok" | "fail", detail: string) => {
    setBootSteps((prev) => markStep(prev, key, phase, detail));
  }, []);
  const [manageOpen, setManageOpen] = useState(false);
  const [toolsFor, setToolsFor] = useState<string | null>(null); // session id
  const [inspectorOpen, setInspectorOpen] = useState(false);
  // Manage-projects bookkeeping. TODO(phase2-data): the bridge has no
  // remove/import endpoints, so those two persist client-side.
  const [hiddenProjects, setHiddenProjects] = useState<Record<string, boolean>>(() => loadManage().hidden);
  const [removedProjects, setRemovedProjects] = useState<Record<string, boolean>>(() => loadManage().removed);
  const [importedProjects, setImportedProjects] = useState<string[]>(() => loadManage().imported);
  // Git repos discovered on disk (org-folder nesting included) — so sessionless
  // projects still show up in the PROJECTS panel.
  const [discovered, setDiscovered] = useState<string[]>([]);

  // HUD chrome state.
  const [settings, setSettings] = useState<HudSettings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The composer's four run knobs live in settings so they survive a reload —
  // the SESSION tab and the composer's dropdowns write the same state.
  const model = settings.model as ModelId;
  const effort = settings.effort as EffortLevel | "";
  const permMode = settings.perm;
  const ponytail = settings.ponytail;
  const setModel = (m: ModelId) => patchSettings({ model: m });
  const setEffort = (e: EffortLevel | "") => patchSettings({ effort: e });
  const setPermMode = (m: string) => patchSettings({ perm: m });
  const setPonytail = (p: string) => patchSettings({ ponytail: p });
  const [analyzeProject, setAnalyzeProject] = useState<string | null>(null);
  // Set only when the modal is opened as a deep-link on a file (sidebar FILES).
  const [analyzeFile, setAnalyzeFile] = useState<{ path: string; branch?: string; line?: number } | null>(null);
  // Same-named files the click could have meant, waiting to be picked between.
  const [filePick, setFilePick] = useState<{ x: number; y: number; name: string; line?: number; paths: string[] } | null>(null);
  // Set only when something opens the modal straight onto a tab (composer MAP).
  const [analyzeTab, setAnalyzeTab] = useState<AnalyzeTab | undefined>(undefined);
  // Set only by re-run on a transcript terminal block — typed into the PTY.
  const [analyzeCommand, setAnalyzeCommand] = useState<string | undefined>(undefined);
  const [ctxMenu, setCtxMenu] = useState<CtxState | null>(null);
  // The browser items we took away by preventDefault()-ing, rebuilt per open.
  const [nativeCtx, setNativeCtx] = useState<{ top: CtxItem[]; page: CtxItem[] }>({ top: [], page: [] });
  const [ctxClosing, setCtxClosing] = useState(false);
  const ctxTimer = useRef<number | null>(null);

  const seqRef = useRef(0);
  // First load asks for the last N event-bearing turns only; the rest stays
  // server-side behind a "load older" control. 3 keeps the worst measured
  // session's first payload at ~53KB gzipped (10 still shipped 81% of it —
  // megaturns cluster at the end).
  const TAIL_TURNS = 3;
  // Older turns exist beyond what's loaded. `from` = first loaded turn (the
  // render cut), `seq` = oldest loaded event seq (the next page's `before` key).
  // A server without tail support never sends the fields, so this stays inert.
  const [older, setOlder] = useState<{ has: boolean; seq: number | null; from: string | null; loading: boolean }>(
    { has: false, seq: null, from: null, loading: false });
  const olderRef = useRef(older);
  olderRef.current = older;
  // The turns on screen belong to the session we just left — held there so a
  // switch doesn't blank the chat. Whatever writes the new session's first
  // turns drops them.
  const staleTurns = useRef(false);
  // The open session, readable from async work that outlives a session switch:
  // a send() awaiting its relevance check must know whether you're still here.
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const liveTurns = useRef<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  // Where the session we're opening was left, held until its turns are on
  // screen — there's nothing to scroll to before then. It stays armed while the
  // transcript settles: rows measure and images load for a beat after the turns
  // land, so the pixel the anchor points at keeps moving.
  const restoreTo = useRef<Anchor | null>(null);
  const restoreT = useRef(0);
  // Older pages walked back looking for the remembered turn. Bounded: a restore
  // that never converges would leave keepPlace disarmed for the tab's life.
  const restorePages = useRef(0);
  // The walk advances one page per effect pass, and the effect only re-runs when
  // turns change — so a page that fails to load stalls it with the restore still
  // armed, and nothing would be saved again until a reload. This ends it.
  const pageT = useRef(0);
  // A smooth scroll of ours is in flight — the scroll listener must not read its
  // downward travel as a gesture (mid-glide we're still far from the bottom,
  // which would drop stick and flash the jump button).
  const glideRef = useRef(false);
  // Mirror of stickRef for rendering — the ref drives the auto-scroll (no
  // re-render), the state drives the "jump to latest" button.
  const [atBottom, setAtBottom] = useState(true);
  const jumpToBottom = useCallback(() => {
    stickRef.current = true;
    setAtBottom(true);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  // Glide to the bottom instead of snapping — used when you send a prompt from
  // near the end, so the new prompt slides into view. The ResizeObserver keeps
  // retargeting the animation as the turn renders.
  // ponytail: 700ms is an assumed animation ceiling; swap for `scrollend` if it
  // ever ends late (a stuck flag would freeze stick until the next scroll).
  const glideToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    glideRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    window.setTimeout(() => { glideRef.current = false; }, 700);
  }, []);

  // AUTO base font size follows the window; a fixed baseFont ignores this.
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const baseFont = settings.baseFont || autoBaseFont(vp.w, vp.h);
  // One knob for the whole type scale: index.css derives every --tNN from --fs.
  useEffect(() => {
    document.documentElement.style.setProperty("--fs", `${baseFont}px`);
  }, [baseFont]);

  // Ambient widgets.
  const host = useHostVitals();
  const { weather, setCity, setUnit } = useWeather();
  const [wxSettings, setWxSettings] = useState(0); // nonce — opens the weather settings editor from the context menu
  const radio = useRadio(settings.radioVolume);
  // Server-side per-session prompt queue: lets a new prompt be queued while a
  // turn is in flight (runs after it) instead of forcing a STOP first.
  const queue = useSessionQueue(sessionId);

  const active = activeOf(turns);
  const running = active !== null;
  const pendingCount = active?.pending.length ?? 0;
  const selected = sessions.find((s) => s.id === sessionId) ?? null;
  const activeProject = state?.project?.rel ?? null;
  // Everything the composer shows is scoped to the open session — a check or a
  // held card belonging to another one stays with that one.
  const checking = sessionId ? checkingMap[sessionId] : undefined;
  const held = sessionId ? heldMap[sessionId] : undefined;
  const draft = (sessionId ? drafts[sessionId] : "") ?? "";
  const openWorking =
    (sessionId ? statusMap.get(sessionId)?.state : undefined) === "working";

  const contextTokens = estimateContextTokens(turns);
  const toolCount = turns.reduce(
    (n, t) => n + t.events.filter((e) => e.type === "tool").length, 0);
  const eventCount = turns.reduce((n, t) => n + t.events.length, 0);
  const tele = useTelemetry({ running, toolCount, eventCount });

  // Apply theme: hue-rotate filter on the dashboard, glow var, ambient bg.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--glow", settings.glow ? "8px" : "0px");
    // The UA chrome we don't paint — <select> option popups, native scrollbars,
    // autofill — follows color-scheme, so a light theme has to say so or those
    // render light-text-on-dark inside an otherwise white dashboard.
    root.style.colorScheme = isLight(settings.theme) ? "light" : "dark";
    // `data-light` drives the light-ground token overrides in index.css — the
    // alpha washes and borders authored for a dark ground are invisible on paper.
    if (isLight(settings.theme)) root.dataset.light = "";
    else delete root.dataset.light;
    // Palette themes override the design tokens on :root (not just the themed
    // wrapper) so the DERIVED tokens (--primary/--card/--border/--ac-*, defined
    // via var() in :root) re-resolve to the palette too. Filter themes clear
    // these and recolour via the container `filter` instead.
    const vars = themeVars(settings.theme);
    for (const k of THEME_TOKEN_KEYS) {
      const v = vars[k];
      if (v != null) root.style.setProperty(k, v);
      else root.style.removeProperty(k);
    }
    saveSettings(settings);
  }, [settings]);

  // Picking a theme also applies its default CRT toggles (design onPick) —
  // except within a family (AURORA's colours, CLAUDE's accents), which is one
  // profile, so your toggles survive the switch.
  function setTheme(t: ThemeKey) {
    const d = themeDef(t);
    setSettings((s) =>
      sameFamily(s.theme, t)
        ? { ...s, theme: t }
        : { ...s, theme: t, scanlines: d.crt, sweep: d.swp, glow: d.glw });
  }
  function toggleCrt(key: "scanlines" | "sweep" | "glow") {
    setSettings((s) => ({ ...s, [key]: !s[key] }));
  }
  function patchSettings(patch: Partial<HudSettings>) {
    setSettings((s) => ({ ...s, ...patch }));
  }
  function toggleRight() {
    setSettings((s) => ({ ...s, rightOpen: !s.rightOpen }));
  }
  // Tab click: the active tab collapses the sidebar, any other opens on it.
  function pickRightTab(id: string) {
    setSettings((s) => ({ ...s, rightTab: id as RightTab, rightOpen: !(s.rightOpen && s.rightTab === id) }));
  }

  // Every AnalyzeModal open goes through here so a stale file deep-link can't
  // survive into the next (plain) open.
  function openAnalyze(rel: string, file?: { path: string; branch?: string; line?: number }, tab?: AnalyzeTab,
                       command?: string) {
    setAnalyzeFile(file ?? null);
    setAnalyzeTab(tab);
    setAnalyzeCommand(command);
    setAnalyzeProject(rel);
  }

  // Re-run a command from a transcript terminal block: the project's TERMINAL
  // tab, on a live PTY, with the command already typed in.
  function runCommand(command: string) {
    const rel = selected?.project ?? activeProject;
    if (rel) openAnalyze(rel, undefined, "terminal", command);
  }

  // A changed file opens on the GIT tab (diff view) — an editor buffer hides
  // which lines actually changed. Clean files still open in the editor.
  function openFileFromPanel(path: string, changed: boolean) {
    if (sessionProject) openAnalyze(sessionProject, { path, branch: sessionBranch }, changed ? "changes" : undefined);
  }

  function openSession(id: string) {
    // Already the open one: re-opening would re-fetch and re-animate the chat
    // to land on what's already on screen.
    if (id === sessionIdRef.current) return;
    seqRef.current = 0;
    // `older` is NOT reset here: the outgoing session's turns stay on screen
    // (dimmed) until the new transcript lands, and zeroing `from` now would
    // lift their render cut — every pre-tail prompt mounts above the viewport
    // and the held frame visibly jumps. The landing fetch resets it.
    // Back to where you were reading this session, if we know — otherwise the
    // bottom, which is where a session you've never opened starts.
    const was = recall(id);
    restoreTo.current = was && was !== "bottom" ? was : null;
    window.clearTimeout(restoreT.current);
    restoreT.current = 0;
    restorePages.current = 0;
    stickRef.current = !restoreTo.current;
    setAtBottom(stickRef.current);
    staleTurns.current = true;
    setLoadingSession(true);
    setSessionId(id);
    setDoneIds((d) => { if (!d.has(id)) return d; const n = new Set(d); n.delete(id); return n; });
  }

  // Point the bridge's active project (the selection Telegram shares) at `rel`
  // without making the UI wait for the round-trip: patch local state now, then
  // let the real response (and the 3s state poll) reconcile.
  function selectProjectBg(rel: string) {
    setState((st) => st ? { ...st, project: { rel, name: rel.split("/").pop() || rel } } : st);
    void api.select(rel).then(() => api.state()).then(setState).catch(() => { /* ignore */ });
  }

  function selectSession(s: SessionBrief) {
    openSession(s.id);  // instant — the transcript keys off the id, not the active project
    if (s.project !== activeProject) selectProjectBg(s.project);
  }

  // --- polls (unchanged data flow) ---
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const s = await api.state();
        if (live) setState(s);
        markBoot("bridge", "ok", "LINKED");
      } catch { markBoot("bridge", "fail", "OFFLINE"); }
    };
    void tick();
    const id = setInterval(tick, 3000);
    return () => { live = false; clearInterval(id); };
  }, [markBoot]);

  useEffect(() => {
    try { localStorage.setItem(MANAGE_KEY, JSON.stringify({ hidden: hiddenProjects, removed: removedProjects, imported: importedProjects })); }
    catch { /* ignore */ }
  }, [hiddenProjects, removedProjects, importedProjects]);

  // Disk discovery polls like the session list, so a repo cloned or created
  // after load appears on its own — no rescan button, no reload.
  const refreshProjects = useCallback(async () => {
    try {
      const p = await api.projects();
      setDiscovered(p.projects ?? []);
      // The bridge is the source of truth for HIDE; an older backend omits the
      // field, in which case the cached localStorage set stands.
      if (p.hidden) setHiddenProjects(Object.fromEntries(p.hidden.map((rel) => [rel, true])));
      markBoot("projects", "ok", bootCount((p.projects ?? []).length, "REPO"));
    } catch { markBoot("projects", "fail", "NO SCAN"); /* old backend without discovery — panel stays session-derived */ }
  }, [markBoot]);
  useEffect(() => {
    void refreshProjects();
    const id = setInterval(refreshProjects, 10000);
    return () => clearInterval(id);
  }, [refreshProjects]);

  const loadSessions = useCallback(async () => {
    try {
      const { sessions: list } = await api.sessions();
      // A poll already in flight when a session is created comes back without
      // it and would drop the chat you just opened (startIn/newSession add it
      // optimistically) out of the lists — keep the open one until a poll
      // carries it.
      setSessions((prev) => {
        const sid = sessionIdRef.current;
        const open = sid && !list.some((s) => s.id === sid)
          ? prev.find((s) => s.id === sid) : undefined;
        return open ? [open, ...list] : list;
      });
      markBoot("sessions", "ok", bootCount(list.length, "CHAT"));
      return list;
    } catch { markBoot("sessions", "fail", "UNREADABLE"); return [] as SessionBrief[]; }
    finally { setBooted(true); }
  }, [markBoot]);

  const projectRel = state?.project?.rel ?? null;
  useEffect(() => {
    let live = true;
    void loadSessions().then((ss) => {
      if (!live) return;
      if (!sessionId) {
        // Back to the chat you had open, wherever it lives; one that's gone
        // falls through to the newest here, as before. Opening it is all this
        // takes — every panel reads the *session's* repo, and a run carries it
        // in the request — so a page load leaves the bridge's own selection
        // (which Telegram shares) alone.
        const was = ss.find((s) => s.id === lastOpen())
          ?? ss.find((s) => s.project === projectRel) ?? ss[0];
        if (was) openSession(was.id);
        // Nothing to reopen (or the list never landed) — say so, or the intro
        // would wait on a transcript fetch that is never going to happen.
        else markBoot("chat", "ok", "NONE");
      }
    });
    const id = setInterval(loadSessions, 5000);
    return () => { live = false; clearInterval(id); };
  }, [loadSessions, projectRel, sessionId, markBoot]);

  // The other half: the chat on screen is the one to come back to next time.
  useEffect(() => {
    if (sessionId) rememberOpen(sessionId);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    const fetchOnce = async () => {
      try {
        const first = seqRef.current === 0;
        const t = await api.transcript(sessionId, seqRef.current, first ? { tail: TAIL_TURNS } : undefined);
        if (!live) return;
        const held = staleTurns.current;
        staleTurns.current = false;
        setTurns((prev) => mergeDelta(held ? [] : prev, t));
        setBoot(t.boot ?? null);
        seqRef.current = t.next_cursor;
        // Every first fetch resets `older` — including to the zero state when
        // the server doesn't speak tail — because openSession left the previous
        // session's values in place to keep the held frame's cut stable.
        if (first)
          setOlder(t.has_older !== undefined
            ? { has: !!t.has_older, seq: t.oldest_seq ?? null, from: t.tail_from ?? null, loading: false }
            : { has: false, seq: null, from: null, loading: false });
        markBoot("chat", "ok", bootCount(t.turns.length, "TURN"));
      } catch {
        // Never landed: drop the previous session's turns rather than pass them
        // off as this one's.
        if (live && staleTurns.current) {
          staleTurns.current = false;
          setTurns([]);
          setOlder({ has: false, seq: null, from: null, loading: false });
        }
        markBoot("chat", "fail", "NO TRANSCRIPT");
      }
      finally { if (live) setLoadingSession(false); }
    };
    refetchTurns.current = fetchOnce;
    void fetchOnce();                                   // always load once on open
    // Then poll only while the session is actually producing output; an idle
    // session doesn't change, so re-effect on the running/working transitions
    // (this also captures the final delta the moment a turn completes).
    const id = setInterval(() => {
      if (running || openWorking) void fetchOnce();
    }, 1500);
    return () => { live = false; clearInterval(id); };
  }, [sessionId, running, openWorking, markBoot]);

  // Fetch the page of turns before the oldest loaded one and prepend it.
  // mergeDelta does the prepending for free: older turns already exist in the
  // full turns list (empty), their events just fill in, and turn order comes
  // from store seq. seqRef is untouched on purpose — this response's
  // next_cursor is the live head, not a forward delta marker.
  const loadOlder = useCallback(async () => {
    const o = olderRef.current;
    // staleTurns: mid-swap `older` still describes the session being left —
    // paging with its seq against the new session id would merge nonsense.
    if (!sessionId || staleTurns.current || !o.has || o.loading || o.seq == null) return;
    setOlder({ ...o, loading: true });
    try {
      const t = await api.transcript(sessionId, 0, { tail: TAIL_TURNS, before: o.seq });
      if (sessionIdRef.current !== sessionId) return;   // switched away mid-flight
      setTurns((prev) => mergeDelta(prev, t));
      setOlder({ has: !!t.has_older, seq: t.oldest_seq ?? o.seq,
                 from: t.tail_from ?? null, loading: false });
    } catch { setOlder({ ...olderRef.current, loading: false }); }
  }, [sessionId]);

  // Checkpoint navigation into the virtualized transcript. A jump to a turn
  // hidden behind the tail cut loads older pages until its row exists, then
  // scrolls to it — so the checkpoint list keeps covering the whole session
  // even though only its tail is loaded.
  const transcriptNav = useRef<TranscriptNav | null>(null);
  const jumpToMark = useCallback(async (m: Mark) => {
    const sub = m.subKey ? ckId(m.turnId, m.subKey) : undefined;
    for (let i = 0; i < 200; i++) {              // pages ≫ max observed 34 turns
      if (transcriptNav.current?.jumpToTurn(m.turnId, sub)) return;
      if (!olderRef.current.has || olderRef.current.loading) return;
      await loadOlder();
      // A prepend re-renders the transcript; give the nav a frame to rebuild.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
  }, [loadOlder]);

  // Remember the place in the open session on every scroll, so leaving it keeps
  // it. Parked at the bottom is a place too — it's what brings you back to the
  // latest instead of to wherever you last read. Mid-restore the scrolling is
  // ours, not yours, so it isn't recorded.
  const keepPlace = useCallback((stick: boolean) => {
    const sid = sessionIdRef.current;
    if (!sid || restoreTo.current) return;
    const a = stick ? "bottom" : transcriptNav.current?.anchor();
    if (a) remember(sid, a);
  }, []);

  // Aim at the remembered turn. Called again on every content resize until we
  // actually land on it: a freshly opened transcript is mostly estimated, so the
  // first attempt scrolls past the end and clamps — and a clamp to the bottom is
  // exactly what re-arms follow and drags you back down.
  const applyRestore = useCallback(() => {
    const a = restoreTo.current;
    const el = scrollRef.current;
    if (!a || a === "bottom" || !el) return;
    const top = transcriptNav.current?.turnTop(a.turn);
    if (top != null) el.scrollTop = top + a.off;
  }, []);

  const endRestore = useCallback(() => {
    restoreTo.current = null;
    window.clearTimeout(restoreT.current);
    restoreT.current = 0;
    window.clearTimeout(pageT.current);
    pageT.current = 0;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    let prev = el.scrollTop;
    // Anchoring against content shifting above the viewport now lives in the
    // transcript virtualizer (shouldAdjustScrollPositionOnItemSizeChange in
    // Transcript.tsx) — a row above you re-measuring adjusts scroll there.
    // What remains here is the follow policy: when to stick to the bottom.
    const sync = () => {
      // Keep `prev` fresh through a glide or a restore, or the first flick up
      // afterwards still reads as "scrolled down" against a stale mark.
      // staleTurns: what's on screen belongs to the session being left — a
      // move there must not flip stick or be remembered under the new id.
      if (glideRef.current || restoreTo.current || staleTurns.current) { prev = el.scrollTop; return; }
      const stick = stickToBottom(el, prev, stickRef.current);
      prev = el.scrollTop;
      stickRef.current = stick;
      setAtBottom(stick);           // no-op re-render-wise unless it flipped
      keepPlace(stick);
    };
    el.addEventListener("scroll", sync, { passive: true });
    // Content grew/shrank: pull to the bottom if we were parked there, otherwise
    // re-check (a shrink can land us back at the bottom on its own).
    const ro = new ResizeObserver(() => {
      // The held frame during a session swap is not ours to move — no follow,
      // no restore-aiming against rows that belong to the session being left.
      // The landing commit repositions (stick or restore) once the new turns
      // are what's on screen.
      if (staleTurns.current) { prev = el.scrollTop; return; }
      // Still on our way back to where you were reading: re-aim, and let none of
      // the follow policy below see the half-settled positions on the way.
      if (restoreTo.current) { applyRestore(); prev = el.scrollTop; return; }
      if (!stickRef.current) {
        // Content moved, not you — so this can only re-arm follow by landing
        // exactly on the end (see stickOnResize). Running the gesture test here
        // let a nudge up inside the 80px band re-stick, and the next streamed
        // chunk yanked the view back to the bottom.
        const stick = stickOnResize(el, stickRef.current);
        prev = el.scrollTop;
        stickRef.current = stick;
        setAtBottom(stick);
        keepPlace(stick);
      }
      else if (glideRef.current) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      else el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    // Touch the scroller mid-restore and it's yours again — 2s of re-aiming
    // would otherwise fight you.
    const giveUp = () => endRestore();
    el.addEventListener("wheel", giveUp, { passive: true });
    el.addEventListener("touchstart", giveUp, { passive: true });
    if (stickRef.current) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    return () => {
      el.removeEventListener("scroll", sync);
      el.removeEventListener("wheel", giveUp);
      el.removeEventListener("touchstart", giveUp);
      ro.disconnect();
    };
  }, [view, showDashboard, keepPlace, applyRestore, endRestore]);

  // The other half of keepPlace: once the opened session's turns are on screen,
  // put you back where you left it — paging older turns back in if the place you
  // left is behind the tail cut, and only falling back to the bottom once there
  // is nothing left to load.
  useEffect(() => {
    const a = restoreTo.current;
    if (!a || a === "bottom" || loadingSession || !turns.length) return;
    if (transcriptNav.current?.turnTop(a.turn) == null) {
      // Not in the tail: you'd paged older turns in before leaving. Page them
      // back — a prepend re-runs this effect, so this walks back one page per
      // pass until the row exists. Only with nothing left to load is the bottom
      // the honest answer to "that place is gone".
      if (olderRef.current.has && !olderRef.current.loading
          && restorePages.current < 200) {   // pages ≫ max observed 34 turns
        restorePages.current++;
        if (!pageT.current) pageT.current = window.setTimeout(endRestore, 10000);
        void loadOlder();
        return;
      }
      endRestore();
      jumpToBottom();
      return;
    }
    window.clearTimeout(pageT.current);      // found it — the walk is over
    pageT.current = 0;
    // Pinned for a beat, not aimed once: the turns keep measuring after they
    // land, and every measurement moves the pixel the anchor points at.
    if (!restoreT.current) restoreT.current = window.setTimeout(endRestore, 2000);
    applyRestore();
  }, [turns, loadingSession, jumpToBottom, applyRestore, endRestore, loadOlder]);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const r = await api.running();
        if (!live) return;
        setStatusMap(new Map(Object.entries(r.status ?? {})));
      } catch { /* ignore */ }
    };
    void tick();
    const id = setInterval(tick, 4000);
    return () => { live = false; clearInterval(id); };
  }, []);

  // working → not-working (and not awaiting, which the list already flags) on a
  // session you don't have open = it finished without you = DONE.
  // ponytail: only transitions this tab actually polls get flagged — a session
  // that finishes while the dashboard is closed won't. Needs a bridge-side
  // finished_at/seen_at pair to cover that.
  // States that mean a turn is already under way — see SessionState in api.ts.
  const IN_FLIGHT = ["working", "awaiting", "checking", "parked"];
  const prevStatus = useRef(statusMap);
  // The first poll lands against an empty map, so every session already running
  // would read as one that just started (and every open question as one just
  // asked). Nothing that predates the tab counts as news.
  const statusSeen = useRef(false);
  useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = statusMap;
    const first = !statusSeen.current;
    statusSeen.current = true;
    const finished = [...prev]
      .filter(([id, st]) => st.state === "working" && id !== sessionId
        && !["working", "awaiting", "parked"].includes(statusMap.get(id)?.state ?? ""))
      .map(([id]) => id);
    if (finished.length) setDoneIds((d) => new Set([...d, ...finished]));
    // Same transitions, sent to the OS. Finished is computed above against the
    // session you have open; awaiting is not, because a question in the session
    // you're looking at but a window you've left is still news.
    if (first) return;
    const brief = (id: string) => sessions.find((s) => s.id === id);
    const name = (id: string) => brief(id)?.title || "session";
    // Clicking the notification opens the session it's about, switching project
    // if that session lives in another one.
    const reveal = (id: string) => () => {
      const s = brief(id);
      if (s) void selectSession(s); else openSession(id);
    };
    // One sound per event per batch, not per session: five sessions finishing
    // together is one piece of news, and five overlapping samples is an alarm.
    // Different events still each get their voice — that's the whole point of
    // assigning them separately.
    const rang = new Set<PushEvent>();
    const ping = (ev: PushEvent, title: string, body: string, id: string) => {
      if (settings.push) push(title, body, id, reveal(id));
      if (settings.pushSound && !rang.has(ev)) {
        rang.add(ev);
        playSound(settings.pushSounds[ev], settings.pushVolume, settings.pushTone);
      }
    };
    for (const id of finished)
      if (shouldPush(id, sessionId)) ping("done", `✓ ${name(id)}`, "finished", id);
    for (const [id, st] of statusMap) {
      const was = prev.get(id)?.state;
      if (st.state === "awaiting" && was !== "awaiting" && shouldPush(id, sessionId))
        ping(st.kind === "permission" ? "permission" : "question", `⏸ ${name(id)}`,
          st.label || "waiting on you", id);
      // Parked is the bridge saying "this died but I'll bring it back" — worth
      // hearing wherever you are, including in the session you're looking at.
      else if (st.state === "parked" && was !== "parked")
        ping("limit", `⏳ ${name(id)}`, st.label || "parked", id);
      // A turn beginning on a session you didn't start yourself (Telegram, a
      // scheduled run) is the one start worth announcing. Coming back from
      // awaiting/checking/parked is the same turn resuming, not a new one —
      // announcing those means a sound every time you answer a question.
      else if (st.state === "working" && !IN_FLIGHT.includes(was ?? "")
          && shouldPush(id, sessionId))
        ping("start", `▸ ${name(id)}`, st.label || "working…", id);
    }
  }, [statusMap, sessionId, sessions, settings.push, settings.pushSound,
      settings.pushTone, settings.pushVolume, settings.pushSounds]);

  // The error toast is the dashboard's own failure channel — a request that
  // came back 500, a worktree that wouldn't create. It never had a sound.
  useEffect(() => {
    setNoticeSound((kind) => {
      if (kind !== "error" || !settings.pushSound) return;
      playSound(settings.pushSounds.failure, settings.pushVolume, settings.pushTone);
    });
  }, [settings.pushSound, settings.pushSounds, settings.pushVolume, settings.pushTone]);

  // Fetch each assigned pack sound once, up front — the first notification
  // shouldn't be the one that waits on GitHub.
  useEffect(() => {
    for (const c of Object.values(settings.pushSounds)) preloadSound(c?.src);
  }, [settings.pushSounds]);

  // Closing the tab costs the server nothing — runs are local processes, not
  // browser ones, and a working session keeps working. Only a live card is
  // worth stopping for: it takes away the only place it can be answered. Ask
  // for any session on the machine, not just the open one. `kind` separates a
  // live card from a turn that merely ended on a question — only the first is
  // answerable here. The prompt itself lives in lib/leaveGuard.
  const pendingAsk = [...statusMap.values()].some((st) => st.state === "awaiting" && st.kind);
  useEffect(() => {
    setLeavePending(pendingAsk);
    if (!pendingAsk) return;
    const guard = (e: BeforeUnloadEvent) => {
      if (leavingOnPurpose()) return; // already asked, in our own dialog
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [pendingAsk]);

  useEffect(() => {
    try { localStorage.setItem(DONE_KEY, JSON.stringify([...doneIds])); } catch { /* ignore */ }
  }, [doneIds]);

  useEffect(() => {
    try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts)); } catch { /* ignore */ }
  }, [drafts]);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const { repos } = await api.gitAll();
        if (live) setGitBadges(new Map(Object.entries(repos)));
        const dirty = Object.values(repos).filter((r) => r.dirty > 0).length;
        markBoot("git", "ok", dirty ? `${bootCount(Object.keys(repos).length, "REPO")} · ${dirty} DIRTY`
          : bootCount(Object.keys(repos).length, "REPO"));
      } catch { markBoot("git", "fail", "NO STATUS"); }
    };
    void tick();
    const id = setInterval(tick, 10000);
    return () => { live = false; clearInterval(id); };
  }, [markBoot]);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try { const u = await api.usage(); if (live) setUsage(u); } catch { /* ignore */ }
      // Same 60s tick: the per-account meters + which agents you can pick from.
      try {
        const a = await api.accounts();
        if (!live) return;
        setAccounts(a.accounts);
        setFreeAgents((a.free_agents?.providers ?? []).filter((p) => p.ready));
        markBoot("auth", "ok", bootCount(a.accounts.length, "ACCOUNT"));
      } catch { markBoot("auth", "fail", "NO LOGIN"); }
    };
    void tick();
    const id = setInterval(tick, 60000);
    return () => { live = false; clearInterval(id); };
  }, [markBoot]);

  // ⌘K palette + Escape closes the topmost overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "r") || e.key === "F5") {
        // Worth stealing the browser's reload only when there's something to
        // lose — then it's our dialog asking, in the theme, instead of Chrome's.
        if (!leavePending()) return;
        e.preventDefault();
        void confirmLeave().then((ok) => ok && location.reload());
      } else if (e.key === "Escape") {
        if (ctxMenu) closeCtx();
        else if (inspectorOpen) setInspectorOpen(false);
        else if (toolsFor) setToolsFor(null);
        else if (manageOpen) setManageOpen(false);
        else if (paletteOpen) setPaletteOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
        else if (analyzeProject) setAnalyzeProject(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxMenu, toolsFor, inspectorOpen, manageOpen, paletteOpen, settingsOpen, analyzeProject]);

  // Right-click context menu — reads data-ctx-* off the target chain.
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest?.("[data-ctxmenu]")) { e.preventDefault(); return; }
      // Text fields keep the real browser menu (spellcheck, undo, paste), and
      // shift+right-click is the usual escape hatch to it everywhere else.
      if (el.closest?.("input, textarea") || e.shiftKey) return;
      e.preventDefault();
      const node = el.closest?.("[data-ctx-type]") as HTMLElement | null;
      if (ctxTimer.current) window.clearTimeout(ctxTimer.current);
      setCtxClosing(false);
      setNativeCtx(nativeCtxItems(e));
      setCtxMenu({
        x: e.clientX, y: e.clientY,
        type: node?.getAttribute("data-ctx-type") || "surface",
        id: node?.getAttribute("data-ctx-id") || "",
        label: node?.getAttribute("data-ctx-label") || "",
      });
    };
    window.addEventListener("contextmenu", onCtx);
    return () => window.removeEventListener("contextmenu", onCtx);
  }, []);

  // Sends are bound to the session the prompt was written in. The relevance
  // check blocks for ~10s, and you're free to open another session meanwhile —
  // so `sid` (not the open session) decides where the run, the queue fallback,
  // the held card and the optimistic turn all land.
  async function send(
    text: string, images: string[],
    opts?: { force?: boolean; sessionId?: string; project?: string },
  ) {
    const sid = opts?.sessionId ?? sessionId;
    if (!sid) return;
    // `/goal <objective>` sets the session's objective instead of prompting; a
    // bare `/goal` clears it. The loop itself is the bridge's (bridge/goals.py) —
    // this only records what the session is for.
    const goalCmd = /^\/goal\b\s*([\s\S]*)$/.exec(text.trim());
    if (goalCmd) {
      try {
        const { goal } = await api.setGoal(sid, goalCmd[1].trim());
        setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, goal } : s)));
        notify("info", goal ? `Goal set — ${goal.objective}` : "Goal cleared.");
      } catch (e) {
        notify("error", (e as Error).message);
      }
      return;
    }
    // The prompt's own session decides the project too — `opts.project` covers a
    // session just created, which this render's `sessions` doesn't know about.
    const project = opts?.project
      ?? sessions.find((s) => s.id === sid)?.project
      ?? state?.project?.rel ?? undefined;
    const sessionName = () =>
      sessions.find((s) => s.id === sid)?.title || "another session";
    const enqueue = () => queue.enqueue({
      text, prompt: text, images, project,
      model, effort: effort || undefined, permission_mode: permMode || undefined,
      agent: settings.agent || undefined,
    }, sid);
    // Sending by hand is the un-pause: otherwise the prompt joins a held queue and
    // sits there looking sent.
    queue.resumeIfPaused();
    // A turn is already in flight for this session — queue the prompt to run
    // after it (and any earlier queued prompts) instead of blocking on STOP.
    if (running && !opts?.sessionId) { enqueue(); return; }
    setCheckingFor(sid, text);
    try {
      const res = await api.run({
        prompt: text, images, project,
        session_id: sid, model, effort: effort || undefined,
        permission_mode: permMode || undefined, ponytail: ponytail || undefined,
        agent: settings.agent || undefined,
        force: opts?.force || undefined,
      });
      // Held: this looks like different work from the session it would resume.
      // Nothing ran — park the prompt on the card and let the user route it.
      if ("suggest_new" in res) {
        setHeldMap((m) => ({
          ...m,
          [sid]: { sid, project, cwd: sessions.find((s) => s.id === sid)?.cwd,
                   text, images, reason: res.reason, title: res.suggested_title },
        }));
        if (sessionIdRef.current !== sid)
          notify("info", `Held a prompt in “${sessionName()}” — it may be different work.`);
        return;
      }
      setHeldMap((m) => omit(m, sid));
      liveTurns.current.add(res.job_id);
      // Only paint the turn if that session is still the one on screen; if you
      // moved on it belongs to the session you left, and its transcript poll
      // picks it up when you go back.
      if (sessionIdRef.current !== sid) {
        notify("info", `Started in “${sessionName()}” — the session you sent it from.`);
        return;
      }
      // Your own prompt pulls you down to it — but only from nearby. More than a
      // screen up the transcript you're reading something; a jump to the bottom
      // would throw that place away, so stay put and let the prompt land unseen.
      const sc = scrollRef.current;
      if (sc && nearBottom(sc)) {
        stickRef.current = true;
        setAtBottom(true);
        glideToBottom();
      }
      const held = staleTurns.current;
      staleTurns.current = false;
      setTurns((prev) => [
        ...(held ? [] : prev),
        { id: res.job_id, prompt: text, events: [], status: "running", pending: [], attachments: images },
      ]);
    } catch (e) {
      // Lost the race: the run slot filled between our check and the request.
      // Queue it rather than surfacing a "busy" error.
      if ((e as Error).message === "busy") enqueue();
      else notify("error", (e as Error).message);
    } finally {
      setCheckingFor(sid, null);
    }
  }

  function setCheckingFor(sid: string, prompt: string | null) {
    setCheckingMap((m) => (prompt === null ? omit(m, sid) : { ...m, [sid]: prompt }));
  }

  // "Start new session" on the held-prompt card: route it to a fresh session
  // pre-named with the suggested title, forced so the check isn't paid twice.
  async function heldStartNew(h: HeldPrompt) {
    const project = h.project ?? state?.project?.rel;
    if (!project) return;
    setHeldMap((m) => omit(m, h.sid));
    setHeldBusy(true);
    try {
      await startIn(project, h.text,
                    { images: h.images, title: h.title ?? undefined, force: true,
                      cwd: h.cwd ?? undefined });
    } finally {
      setHeldBusy(false);
    }
  }

  // Composer text, stored against the session it's being written for (via the
  // ref, so it lands on the session on screen right now and not on a stale one).
  function setDraft(text: string) {
    const sid = sessionIdRef.current;
    if (!sid) return;
    setDrafts((d) => (text ? { ...d, [sid]: text } : omit(d, sid)));
  }

  /** A path the model mentioned, opened in the editor — at the line it named,
   *  if it named one. Routed through the same call the file browser uses, so it
   *  lands on the session's own branch. */
  async function openFileRef(path: string, line?: number, at?: { x: number; y: number }) {
    if (!sessionProject) { notify("info", "No project open for this session."); return; }
    // The path came out of prose, so check it against the tree we're about to
    // open it in — a file the model invented, or named from another directory,
    // would otherwise open an empty editor.
    let target = path;
    try {
      const { files } = await api.filesTree(sessionProject, sessionBranch);
      // A bare `App.tsx` matches one per package, so break the tie with what
      // this session has already said and done: tool summaries (a Bash command
      // with the path inside it) and the model's own prose, which names files in
      // full far more often than it abbreviates them.
      // ponytail: a Bash summary is the command's first 120 chars (runner.py),
      // so a path buried deeper in a heredoc is invisible here — the picker below
      // catches those. Raising that cap means widening the bot's status line too.
      const touched = turns.flatMap((t) => t.events.flatMap((e) =>
        e.type === "tool" ? [e.summary] : e.type === "text" ? [e.text] : [])).reverse();
      const hit = resolveFileRef(files, path, touched);
      if (!hit) {
        const many = fileRefCandidates(files, path);
        // Undecidable is a question, not an error: the candidates open as a menu
        // under the link. A toast listing them would name the right file and
        // still leave you to go find it in the tree yourself.
        if (many.length > 1 && at) { setFilePick({ ...at, name: path, line, paths: many }); return; }
        notify("info", many.length > 1
          ? `Several files named ${path} — ${many.join("  ·  ")}`
          : `No such file in this branch — ${path}`);
        return;
      }
      target = hit;
    } catch { /* tree unreachable: open anyway, the editor reports its own error */ }
    openAnalyze(sessionProject, { path: target, branch: sessionBranch, line });
  }

  /** A line of the model's prose → a markdown blockquote in the prompt box, the
   *  way you'd quote a mail. Appended, not substituted: you quote a sentence
   *  because you're already halfway through writing about it. */
  function quote(text: string) {
    const q = text.trim().split("\n").map((l) => `> ${l}`).join("\n");
    setDraft(draft.trim() ? `${draft.replace(/\s+$/, "")}\n\n${q}\n\n` : `${q}\n\n`);
    setView("chat");
  }

  async function respond(requestId: string, opts: { behavior?: "allow" | "deny"; answers?: AnswerSelection[] }) {
    if (!active) return false;
    try { await api.respond(active.id, { request_id: requestId, ...opts }); } catch { return false; }
    // Don't wait out the 1.5s poll to retire the card — the bridge has already
    // written the resolved event by the time the POST returns.
    void refetchTurns.current();
    return true;
  }
  async function stop() {
    if (!active) return;
    try { await api.interrupt(active.id); } catch { /* poll reconciles */ }
  }

  // A queued task or a GitHub issue carries the project it belongs to. Feeding it
  // into whatever session happens to be open would run it against the wrong repo,
  // so a project that isn't the open session's gets a session of its own and the
  // prompt starts there. No project (self-update errors, suggestions) = inject
  // into the current composer, as before.
  function feed(texts: string[], project?: string) {
    const text = texts.join("\n");
    if (project && project !== sessionProject) {
      void startIn(project, text);
      return;
    }
    setInject((p) => ({ text, nonce: p.nonce + 1 }));
    setView("chat");
  }

  // New session in `project`, then run `prompt` in it. The explicit sessionId is
  // what makes send() reusable here: it otherwise reads sessionId from state,
  // which React has not updated yet for the session we just created.
  // Opening a new session means a round trip (a POST, and for a worktree a git
  // add that takes seconds) — spent staring at the session you just left. So the
  // chat opens on nothing first and the transcript's own loading state carries
  // the wait; the real session drops in behind it.
  function openBlank() {
    setSessionId(null);
    setTurns([]);
    setLoadingSession(true);
    setView("chat");
  }

  async function startIn(
    project: string, prompt: string,
    opts?: { images?: string[]; title?: string; force?: boolean; cwd?: string },
  ) {
    openBlank();
    try {
      const { session } = await api.createSession(project, opts?.cwd, opts?.title);
      setSessions((prev) => [session, ...prev]);
      openSession(session.id);
      setView("chat");
      await send(prompt, opts?.images ?? [],
                 { sessionId: session.id, project, force: opts?.force });
    } catch (e) {
      setLoadingSession(false);
      notify("error", (e as Error).message);
    }
  }

  // Pull a queued prompt out of a busy session into a fresh one, where it starts
  // immediately instead of waiting behind the current turn. Same project and
  // worktree; the view stays put and the new session shows up in the list.
  async function ejectQueued(itemId: string) {
    if (!sessionProject) return;
    try {
      const { session } = await api.createSession(sessionProject, selected?.cwd ?? undefined);
      setSessions((prev) => [session, ...prev]);
      await queue.move(itemId, session.id);
    } catch (e) {
      notify("error", (e as Error).message);
    }
  }

  async function selectProject(rel: string) {
    selectProjectBg(rel);
    // The list on screen almost always has this project's sessions already; hit
    // the network only when it doesn't (a session created since the last poll).
    const cur = sessions.find((s) => s.project === rel)
      ?? (await loadSessions()).find((s) => s.project === rel);
    if (cur) openSession(cur.id);
  }

  async function newSession(project: string) {
    openBlank();
    try {
      const { session } = await api.createSession(project);
      setSessions((prev) => [session, ...prev]);
      openSession(session.id);
    } catch { setLoadingSession(false); }
  }

  /** Start a session that knows what it is for: the type picks the flow, the
   *  form's fields are its first prompt. */
  async function typedSession(project: string, stype: string, prompt: string) {
    openBlank();
    try {
      const { session } = await api.createSession(project, undefined, undefined, stype);
      setSessions((prev) => [session, ...prev]);
      openSession(session.id);
      setView("chat");
      await send(prompt, [], { sessionId: session.id, project, force: true });
    } catch (e) {
      setLoadingSession(false);
      notify("error", (e as Error).message);
    }
  }

  /** Approve a gated stage, or move by hand from the rail. The server owns the
   *  move; this asks for it and takes the answer it gives back. */
  async function setStage(action: "advance" | "back" | "set", stage?: string) {
    if (!sessionId) return;
    try {
      const r = await api.setStage(sessionId, action, stage);
      setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, stage: r.stage } : s)));
    } catch (e) {
      notify("error", (e as Error).message);
    }
  }

  /** The way out of a wrong AUTO TYPE verdict: re-type the session, or clear
   *  it back to a plain chat. The new flow restarts at its first stage. */
  async function retypeSession(stype: string | null) {
    if (!sessionId) return;
    try {
      const r = await api.retypeSession(sessionId, stype);
      setSessions((prev) => prev.map((s) =>
        (s.id === sessionId ? { ...s, stype: r.stype, stage: r.stage } : s)));
    } catch (e) {
      notify("error", (e as Error).message);
    }
  }

  async function worktreeSession(rel: string, branch: string, create: boolean, parent?: string,
                                 firstPrompt?: string) {
    openBlank();
    // `git worktree add` checks out the whole tree — seconds on a big repo, spent
    // on a blank chat that says nothing about what it's waiting for. Same boot
    // line a starting child gets; the transcript's first poll clears it.
    setBoot(create ? `cutting worktree ${branch}` : `checking out ${branch}`);
    try {
      const wt = await api.worktreeAdd(rel, branch, parent, create);
      if (!wt.ok) { setBoot(null); setLoadingSession(false); notify("error", wt.output || "worktree failed"); return; }
      setBoot(`moving into ${wt.rel}`);
      // With a prompt this is startIn's job — it already opens a session in a
      // given cwd and addresses the run to it by id.
      if (firstPrompt) { await startIn(rel, firstPrompt, { cwd: wt.path }); return; }
      const { session } = await api.createSession(rel, wt.path);
      await loadSessions();
      openSession(session.id);
    } catch (e) { setBoot(null); setLoadingSession(false); notify("error", (e as Error).message); }
  }

  async function createProject(name: string, prompt: string) {
    try {
      const r = await api.createProject(name, prompt);
      await selectProject(r.project.rel);
      await loadSessions();
      if (r.session) openSession(r.session.id);
      setView("chat");
    } catch (e) { notify("error", (e as Error).message); }
  }

  function openFromHistory(s: EnrichedSession) {
    // Seed the list so the header/composer know this session before a poll
    // does; loadSessions keeps the open one even when the backend list omits it.
    setSessions((prev) => prev.some((x) => x.id === s.id) ? prev : [s, ...prev]);
    openSession(s.id);
    setView("chat");
    if (s.project !== activeProject) selectProjectBg(s.project);
  }

  function replayBoot() {
    setSettingsOpen(false);
    setShowDashboard(false); setBooting(true);
  }

  // Animated context-menu close (design closeCtxAnim — ctxOut plays, then unmount).
  function closeCtx() {
    if (ctxTimer.current) window.clearTimeout(ctxTimer.current);
    setCtxClosing(true);
    ctxTimer.current = window.setTimeout(() => { setCtxMenu(null); setCtxClosing(false); }, 165);
  }

  // Optimistic locally, then persisted through the bridge (project_config.json)
  // so the choice outlives this browser — the poll would undo a local-only flip.
  function setHidden(rels: string[], hide: boolean) {
    setHiddenProjects((p) => {
      const next = { ...p };
      for (const rel of rels) next[rel] = hide;
      return next;
    });
    void Promise.all(rels.map((rel) =>
      api.setProjectSettings({ project: rel }, { hidden: hide }).catch(() => null),
    )).then(() => refreshProjects());
  }

  // TODO(phase2-data): local-only import — no bridge endpoint to attach a repo yet.
  function importProject(path: string) {
    const rel = path.trim().replace(/\/+$/, "");
    if (!rel) return;
    setImportedProjects((prev) => (prev.includes(rel) ? prev : [...prev, rel]));
    setRemovedProjects((p) => ({ ...p, [rel]: false }));
    setHidden([rel], false);
  }

  // --- derived ---
  const projectGroups = useMemo<ProjectGroup[]>(() => {
    const byProj = new Map<string, SessionBrief[]>();
    for (const s of sessions) {
      const arr = byProj.get(s.project) ?? [];
      arr.push(s);
      byProj.set(s.project, arr);
    }
    if (activeProject && !byProj.has(activeProject)) byProj.set(activeProject, []);
    for (const rel of discovered) if (!byProj.has(rel)) byProj.set(rel, []);
    const groups: ProjectGroup[] = [];
    for (const [rel, ss] of byProj) {
      ss.sort((a, b) => b.updated - a.updated);
      const running = ss.some((s) => {
        const st = statusMap.get(s.id)?.state;
        return st === "working" || st === "awaiting" || st === "live";
      });
      groups.push({
        // Basename only — the PROJECTS panel groups rows under a parent-path
        // header, so the org context lives on the group, not the row.
        rel, name: rel.replace(/\/+$/, "").split("/").pop() || rel,
        badge: gitBadges.get(rel), sessions: ss.slice(0, 3), sessionCount: ss.length, running,
      });
    }
    // Alphabetical by path — a fixed order. Activity sorting reshuffled rows
    // on every session update, and zero-session ties followed Map insertion
    // order, so selecting a project moved it (and others) under the cursor.
    groups.sort((a, b) => a.rel.localeCompare(b.rel));
    return groups;
  }, [sessions, gitBadges, statusMap, activeProject, discovered]);

  // HIDE keeps a project out of the sidebar; REMOVE detaches it (design manage modal).
  const visibleGroups = projectGroups.filter((g) => !hiddenProjects[g.rel] && !removedProjects[g.rel]);
  // …and out of the left session list, whose RECENT tab reads the flat list.
  const visibleSessions = sessions.filter(
    (s) => !hiddenProjects[s.project] && !removedProjects[s.project]);

  // Prompt state the session list flags, so work you left mid-flight is visible
  // from anywhere: a check still running, a card waiting on you, unsent text.
  const promptFlags = useMemo(() => {
    const m = new Map<string, PromptFlag>();
    for (const sid of Object.keys(drafts)) if (drafts[sid].trim()) m.set(sid, "draft");
    for (const sid of Object.keys(heldMap)) m.set(sid, "held");
    for (const sid of Object.keys(checkingMap)) m.set(sid, "checking");
    return m;
  }, [drafts, heldMap, checkingMap]);

  // The open session's working tree — its worktree branch when it has one.
  const sessionProject = selected?.project ?? activeProject;
  const sessionBranch = selected?.branch;

  // Footer git state for that tree. Same 10s cadence as the project badges;
  // clears on switch so the footer never shows the last session's branch.
  // Clearing is its own effect: a push bumps gitNonce to re-read now, and that
  // must not blank the chain back to its loading stand-ins on the way.
  useEffect(() => { setSessionGit(null); }, [sessionProject, sessionBranch]);
  useEffect(() => {
    if (!sessionProject) return;
    let live = true;
    const tick = async () => {
      try {
        const g = await api.git(sessionProject, sessionBranch || undefined);
        if (live) setSessionGit(g);
      } catch {
        // Not a repo / fetch failed — resolve to "no git" so the footer's
        // loading stand-ins clear instead of holding their slots forever.
        if (live) setSessionGit((prev) => prev ?? { is_repo: false, branch: "", ahead: 0, behind: 0, dirty: 0, files: [] });
      }
    };
    void tick();
    const id = setInterval(tick, 10000);
    return () => { live = false; clearInterval(id); };
  }, [sessionProject, sessionBranch, gitNonce]);

  // Unread lessons, for the LEARN tab's badge — the whole reason to open a tab
  // you are not already looking at. Every repo's, because the panel reads that
  // way too. One listdir per repo, so a slow tick is plenty.
  useEffect(() => {
    if (!ai.learn) return;
    let live = true;
    const tick = () => api.lessons("*")
      .then((r) => { if (live) setLessonKeys(r.lessons.map((l) => `${l.project ?? ""}::${l.file}`)); })
      .catch(() => { /* ignore */ });
    void tick();
    const id = setInterval(tick, 60000);
    return () => { live = false; clearInterval(id); };
  }, [ai.learn]);
  const unreadLessons = lessonKeys.filter((k) => !lessonsRead.has(k)).length;
  // Uncommitted files in the session's repo — the CHANGES tab badges the count.
  const dirtyFiles = gitBadges.get(sessionProject ?? "")?.dirty ?? 0;

  const rightTabs: PanelTab[] = [
    {
      id: "projects", label: "Projects", icon: <FolderGit2 {...RAIL} />,
      render: () => (
        <ProjectsPanel
          groups={visibleGroups} activeProject={activeProject} booting={!booted}
          onSelectProject={(rel) => void selectProject(rel)}
          onAnalyze={(rel) => openAnalyze(rel)}
          onManage={() => setManageOpen(true)}
          onCreateProject={(name, prompt) => void createProject(name, prompt)}
        />
      ),
    },
    {
      id: "files", label: "Files", icon: <FolderTree {...RAIL} />, ownScroll: true, scope: "worktree",
      render: () => (
        <FilesPanel
          project={sessionProject} branch={sessionBranch}
          onOpenFile={openFileFromPanel}
        />
      ),
    },
    {
      id: "changes", label: dirtyFiles ? `Changed files (${dirtyFiles})` : "Changed files", icon: <FileDiff {...RAIL} />, ownScroll: true, scope: "worktree",
      badge: dirtyFiles ? String(dirtyFiles) : null,
      render: () => (
        <FilesPanel
          project={sessionProject} branch={sessionBranch} changedOnly
          onOpenFile={openFileFromPanel}
        />
      ),
    },
    {
      id: "git", label: "Source Control", icon: <GitBranch {...RAIL} />, scope: "project",
      badge: dirtyFiles ? "●" : null,
      render: () => <GitTab project={sessionProject} />,
    },
    {
      id: "skills", label: "Skills", icon: <Sparkles {...RAIL} />,
      render: () => <SkillsPanel project={sessionProject} />,
    },
    {
      id: "learn", label: "Learn", icon: <GraduationCap {...RAIL} />, ownScroll: true,
      badge: unreadLessons ? String(unreadLessons) : null,
      render: () => (
        <LearnPanel project={sessionProject} read={lessonsRead}
          onRead={(k) => setLessonsRead((r) => new Set(r).add(k))} />
      ),
    },
    { id: "queue", label: "Queue", icon: <ListTodo {...RAIL} />, render: () => <TaskQueuePanel projects={projectNames} onFeed={feed} /> },
  ];

  const activeBadge = activeProject ? gitBadges.get(activeProject) : undefined;
  // No usage payload (no token / upstream down long enough that the bridge's
  // last-good copy went stale) reads as unknown — not as a real 0%.
  const fiveHour = usage?.available ? usage.five_hour : null;
  const usedPct = fiveHour ? Math.round(fiveHour.percent) : null;
  const resetLabel = fiveHour ? fmtReset(fiveHour.resets_at) : null;
  const projectNames = useMemo(() => projectGroups.map((g) => g.rel), [projectGroups]);
  // Model picker options — the live list served from /local/state (Models API).
  const modelOpts = useMemo(() => modelOptions(state?.models), [state?.models]);
  // The composer lists one model per family unless settings says otherwise;
  // SettingsModal keeps the full list so it can offer the SHOW ALL switch.
  const composerModels = useMemo(
    () => (settings.allModels ? modelOpts : latestPerFamily(modelOpts, model)),
    [modelOpts, settings.allModels, model],
  );
  // Once the live list loads, snap the selection to an available model (prefer
  // Opus) if the current one isn't offered — the old default was a fixed alias.
  useEffect(() => {
    if (!modelOpts.length || modelOpts.some((m) => m.id === model)) return;
    setModel((modelOpts.find((m) => m.id.includes("opus")) ?? modelOpts[0]).id);
  }, [modelOpts, model]);

  // AGENT picker — which platform runs the turn. Claude logins first (the
  // ambient one leads), then every ready free-agent rung. Option ids are the
  // strings the bridge stores as a turn's runtime, so the picker, the status
  // bar and the transcript badge all name the same thing.
  const agentOpts = useMemo<AgentOption[]>(() => [
    ...accounts.filter((a) => !a.disabled).map((a) => ({
      id: `claude:${a.slot}`,
      short: `A${a.slot} ${(a.email ?? "?").split("@")[0]}`,
      label: `A${a.slot} · ${a.email ?? "unknown"}${a.left === null ? "" : ` · ${a.left}% LEFT`}`,
      free: false, def: a.default, left: a.left,
    })),
    ...freeAgents.map((p) => ({
      id: `opencode:${p.provider}`,
      short: `⚡ ${p.provider.toUpperCase()}`,
      label: `⚡ ${p.provider.toUpperCase()} · ${p.model}`,
      free: true, def: false, left: null,
    })),
  ], [accounts, freeAgents]);
  // "" is the ambient login — resolve it to that account's own id so the picker
  // and the status bar always name someone.
  const agentId = settings.agent || agentOpts.find((o) => o.def)?.id || agentOpts[0]?.id || "";
  const activeAgent = agentOpts.find((o) => o.id === agentId) ?? null;
  const setAgent = (id: string) => patchSettings({ agent: id });
  // A pick that went away (account removed, key cleared) falls back to the
  // default login instead of 400ing on the next send.
  useEffect(() => {
    if (!agentOpts.length || agentOpts.some((o) => o.id === agentId)) return;
    setAgent("");
  }, [agentOpts, agentId]);

  // Switched an extra off while looking at the view it owns: the tab is gone, so
  // sitting there would strand you on a screen with no way back to it. (The MEM
  // and TEACH panel tabs need no guard — RightPanel falls back to its first tab.)
  useEffect(() => {
    if (view === "next" && !ai.nextup) setView("chat");
  }, [view, ai]);

  const commands: Command[] = [
    { id: "new-chat", label: "New chat", group: "Session", icon: "+", run: () => activeProject && void newSession(activeProject) },
    { id: "compact", label: "Compact context (/compact)", group: "Session", icon: "▢", run: () => void send("/compact", []) },
    { id: "copy-chat", label: "Copy chat as markdown", group: "Session", icon: "⧉", run: () => {
      const md = chatToMarkdown(turns, sessions.find((s) => s.id === sessionId)?.title ?? undefined);
      if (!md.trim()) { notify("info", "Nothing to copy yet."); return; }
      try { void navigator.clipboard?.writeText(md); notify("info", "Chat copied as markdown."); }
      catch { notify("error", "Clipboard refused the copy."); }
    } },
    { id: "view-chat", label: "Go to Chat", group: "View", icon: "▣", run: () => setView("chat") },
    { id: "view-history", label: "Go to History", group: "View", icon: "◷", run: () => setView("history") },
    // Gated exactly like the tabs: an extra that's off has no way in at all.
    ...(ai.nextup
      ? [{ id: "view-next", label: "Go to Next up", group: "View", icon: "◈", run: () => setView("next") }]
      : []),
    { id: "analyze", label: "Analyze active project", group: "Project", icon: "⊞", run: () => activeProject && openAnalyze(activeProject) },
    { id: "right-panel", label: settings.rightOpen ? "Collapse right panel" : "Expand right panel", group: "View", icon: "▥", run: toggleRight },
    { id: "settings", label: "Dashboard settings…", group: "Display", icon: "⚙", run: () => setSettingsOpen(true) },
    { id: "inspector", label: "HTTP inspector…", group: "Session", icon: "◫", run: () => setInspectorOpen(true) },
    { id: "radio", label: radio.radio.playing ? "Pause Claude·FM" : "Play Claude·FM", group: "Audio", icon: "♪", run: () => radio.toggle() },
    ...modelOpts.map((m) => ({
      id: `model-${m.id}`, label: `Use ${m.label}`, group: "Model",
      icon: "⌥", run: () => setModel(m.id),
    })),
  ];

  // Context-menu items per target type.
  // Worktrees of the session the context menu is open on — the relocate targets.
  // Must be declared above ctxItems: that useMemo's callback runs during this
  // render pass and reads relocTargets, so a later `const` would be in its TDZ.
  const [relocTargets, setRelocTargets] = useState<{ branch: string }[]>([]);
  useEffect(() => {
    const proj = ctxMenu?.type === "session"
      ? sessions.find((s) => s.id === ctxMenu.id)?.project : null;
    if (!proj) { setRelocTargets([]); return; }
    let live = true;
    void api.worktrees(proj)
      .then((r) => { if (live) setRelocTargets(r.worktrees.map((w) => ({ branch: w.branch }))); })
      .catch(() => { if (live) setRelocTargets([]); });
    return () => { live = false; };
  }, [ctxMenu, sessions]);

  const ctxItems: CtxItem[] = useMemo(() => {
    if (!ctxMenu) return [];
    const cproj = analyzeProject || activeProject || "";
    // Copy / open link / image act on what was under the cursor, so they lead.
    const items: CtxItem[] = nativeCtx.top.length ? [...nativeCtx.top, { divider: true }] : [];
    const copy = (t: string) => { try { void navigator.clipboard?.writeText(t); } catch { /* ignore */ } };
    if (ctxMenu.type === "session") {
      const s = sessions.find((x) => x.id === ctxMenu.id);
      const pinned = pins.has(ctxMenu.id);
      // One exit, not a taxonomy — done/backlog sounded useful and weren't, so
      // a single Abandon replaces the lifecycle submenu. Its flip side shows
      // only for a hidden row (seeded back into `sessions` by openFromHistory).
      const lc = s?.lifecycle ?? null;
      items.push({ icon: "▸", label: "Attach & resume", onClick: () => s && openSession(s.id) });
      items.push(lc === null
        ? { icon: "⊘", label: "Abandon session", danger: true,
            hint: "gave up — hides it, HISTORY tags it abandoned",
            onClick: () => void setLifecycle(ctxMenu.id, "abandoned") }
        : { icon: "↺", label: "Reopen session",
            hint: "unhide — back in the sidebar, untagged",
            onClick: () => void setLifecycle(ctxMenu.id, null) });
      items.push({ icon: pinned ? "★" : "☆", label: pinned ? "Unpin session" : "Pin session",
        hint: "TOP", onClick: () => togglePin(ctxMenu.id) });
      items.push({ icon: "✎", label: "Rename session…",
        hint: "your own name for it",
        onClick: () => void renameSession(ctxMenu.id, s?.title ?? "") });
      items.push({ divider: true });
      const nOff = s?.disabled_tools?.length ?? 0;
      items.push({ icon: "⚒", label: "Tools & MCP…",
        hint: nOff ? `${nOff} switched off` : "all on",
        onClick: () => setToolsFor(ctxMenu.id) });
      // Usage-limit fallback policy for this session; the 5s session poll picks
      // up the new value, so the ● marker is fresh next open.
      const pol = s?.fallback_policy ?? "ask";
      const setPol = (v: string) => { void api.setPolicy(ctxMenu.id, v).then(() => void loadSessions()); };
      items.push({ icon: "◈", label: `On limit: ${pol === "auto" ? "auto-switch" : pol}`, children: [
        { icon: pol === "ask" ? "●" : "○", label: "Ask",
          hint: "offer account/free-agent choices", onClick: () => setPol("ask") },
        { icon: pol === "auto" ? "●" : "○", label: "Auto-switch",
          hint: "take the best fallback silently", onClick: () => setPol("auto") },
        { icon: pol === "wait" ? "●" : "○", label: "Wait",
          hint: "only wait for the reset", onClick: () => setPol("wait") },
      ] });
      // How full this session's window is, and when claude compacts it. The
      // reading is written at the end of each turn, so it's the fill the next
      // turn resumes into.
      const ctxPct = s?.ctx_tokens && s?.ctx_window
        ? Math.round((s.ctx_tokens / s.ctx_window) * 100) : null;
      const at = s?.autocompact ?? "auto";
      const setAt = (v: string) => {
        void api.setAutocompact(ctxMenu.id, v).then(() => void loadSessions());
      };
      items.push({ icon: "◫", label: `Context: ${ctxPct === null ? "not measured yet" : `${ctxPct}% full`}`, children: [
        { icon: "◫", label: s?.ctx_tokens ? `${s.ctx_tokens.toLocaleString()} tokens` : "no reading yet",
          hint: s?.ctx_tokens ? "on the last request" : "runs a turn to measure",
          onClick: () => { /* a reading, not an action */ } },
        { divider: true },
        { icon: at === "auto" ? "●" : "○", label: "Compact: auto",
          hint: "claude decides when", onClick: () => setAt("auto") },
        { icon: at === "100000" ? "●" : "○", label: "Compact at 100k",
          hint: "earlier, shorter context", onClick: () => setAt("100000") },
        { icon: at === "150000" ? "●" : "○", label: "Compact at 150k",
          hint: "later, more room before it summarises", onClick: () => setAt("150000") },
      ] });
      items.push({ divider: true });
      // The once-a-month rows. Flat inside one section — a submenu can't open
      // its own submenu, so share and relocate live here as plain rows.
      items.push({ icon: "⋯", label: "More", children: [
        { icon: "⧉", label: "Copy session name", onClick: () => s && copy(s.title || "session") },
        { icon: "↻", label: "Regenerate title",
          hint: "let the model name it from the whole session",
          onClick: () => void regenerateTitle(ctxMenu.id) },
        { icon: "⧉", label: "Duplicate session",
          hint: "copy the transcript into a new one",
          onClick: () => void duplicateSession(ctxMenu.id) },
        { divider: true },
        { icon: "⇗", label: "Share read-only link", hint: "expires in 7 days",
          onClick: () => void shareSession(ctxMenu.id) },
        { icon: "⊘", label: "Revoke share links",
          hint: "every link to this session stops working",
          onClick: () => void revokeShares(ctxMenu.id) },
        { divider: true },
        { icon: "⑂", label: "Move to a new worktree",
          hint: "branch named after the session; uncommitted work stays behind",
          onClick: () => void moveToNewWorktree(ctxMenu.id) },
        ...relocTargets.map((wt) => ({
          icon: "⇉", label: `Relocate to ${wt.branch}`,
          hint: "rewrites paths so the model never sees the move",
          onClick: () => void relocateSession(ctxMenu.id, s?.project ?? "", wt.branch),
        })),
      ] });
      items.push({ divider: true });
    } else if (ctxMenu.type === "project") {
      items.push({ icon: "⊞", label: "Analyze project", onClick: () => openAnalyze(ctxMenu.id) });
      items.push({ icon: "◉", label: "Select as active", onClick: () => void selectProject(ctxMenu.id) });
      items.push({ icon: "+", label: "New session here", onClick: () => void newSession(ctxMenu.id) });
      items.push({ icon: "◎", label: "Open issues", onClick: () => openAnalyze(ctxMenu.id) });
      items.push({ divider: true });
    } else if (ctxMenu.type === "issue") {
      items.push({ icon: "▸", label: "Feed to Claude", onClick: () => feed([`Address issue #${ctxMenu.id} in ${cproj}`], cproj) });
      items.push({ icon: "⧉", label: "Copy issue ref", onClick: () => copy(`${cproj}#${ctxMenu.id}`) });
      items.push({ divider: true });
    } else if (ctxMenu.type === "turn") {
      // The turn the cursor was inside — its prompt, and whatever the agent
      // said back. Tool calls and thinking are left out of "reply": what you
      // want on the clipboard is the answer, not the working.
      const t = turns.find((x) => x.id === ctxMenu.id);
      const reply = (t?.events ?? [])
        .map((e) => (e.type === "text" ? e.text : ""))
        .filter(Boolean).join("\n\n").trim();
      if (t?.prompt)
        items.push({ icon: "⧉", label: "Copy prompt", onClick: () => copy(t.prompt) });
      if (reply)
        items.push({ icon: "⧉", label: "Copy reply", onClick: () => copy(reply) });
      if (t?.prompt || reply)
        items.push({ icon: "⧉", label: "Copy turn as Markdown",
          onClick: () => copy(`**${t?.prompt || "(no prompt)"}**\n\n${reply || "_(no reply)_"}`) });
      if (reply)
        items.push({ icon: "❞", label: "Quote reply in composer",
          hint: "drops it into the prompt box", onClick: () => quote(reply) });
      if (t?.prompt)
        items.push({ icon: "↻", label: "Send this prompt again",
          hint: "runs it as a new turn in this session",
          onClick: () => void send(t.prompt, []) });
      items.push({ divider: true });
    } else if (ctxMenu.type === "terminal") {
      items.push({ icon: "⊙", label: "Copy session title", onClick: () => copy(selected?.title || "session") });
      items.push({ icon: "↥", label: "Scroll to top", onClick: () => { if (scrollRef.current) scrollRef.current.scrollTop = 0; } });
      items.push({ divider: true });
    } else if (ctxMenu.type === "weather") {
      const other = weather.unit === "F" ? "C" : "F";
      items.push({ icon: "✎", label: "Set city…", onClick: () => setWxSettings((n) => n + 1) });
      items.push({ icon: "°", label: `Use °${other} (${other === "F" ? "Fahrenheit" : "Celsius"})`, onClick: () => void setUnit(other === "F" ? "fahrenheit" : "celsius") });
      items.push({ divider: true });
    }
    // Dashboard-wide rows. When you right-clicked *something* — a card, a turn,
    // a file — these five are never the reason, so they collapse to one row and
    // stop pushing that thing's own options off the bottom. On bare surface,
    // where there is nothing else, they are the menu.
    const globals: CtxItem[] = [
      { icon: "⊕", label: "Command palette", hint: "⌘K", onClick: () => setPaletteOpen(true) },
      { icon: "♪", label: "Toggle Claude·FM", onClick: () => radio.toggle() },
      { icon: "⚙", label: "Dashboard settings", onClick: () => setSettingsOpen(true) },
      { icon: "↻", label: "Replay boot", onClick: () => replayBoot() },
      { icon: "⏻", label: "Restart bridge",
        hint: "picks up code on disk; running turns resume",
        onClick: () => void restartBridge() },
    ];
    if (ctxMenu.type === "surface") items.push(...globals);
    else items.push({ icon: "⌗", label: "Dashboard", children: globals });
    // The browser-level block (back/reload/print) is never the reason you opened
    // the menu — it goes behind one row.
    if (nativeCtx.page.length)
      items.push({ divider: true }, { icon: "⌾", label: "Browser", children: nativeCtx.page });
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxMenu, nativeCtx, sessions, turns, pins, analyzeProject, activeProject, selected, radio, weather, setUnit, relocTargets]);

  /** Your own name for a session. */
  async function renameSession(id: string, current: string) {
    const next = (await askPrompt("Name this session", current))?.trim();
    if (!next || next === current) return;
    try {
      await api.retitle(id, next);
      await loadSessions();
    } catch (e) {
      notify("error", (e as Error).message);
    }
  }

  /** Hand the name back to the model, which reads the whole session this time
   *  rather than just the first turn. Lands on the next poll. */
  async function regenerateTitle(id: string) {
    try {
      await api.retitle(id);
      notify("info", "Renaming — the new title lands in a moment.");
      setTimeout(() => void loadSessions(), 4000);
    } catch (e) {
      notify("error", (e as Error).message);
    }
  }

  /** A read-only link to this session, on the clipboard. The bridge binds
   *  loopback, so the link opens on this machine — reaching it from a phone
   *  means putting the port behind the tunnel yourself, deliberately. */
  async function shareSession(id: string) {
    try {
      const r = await api.share(id, { days: 7 });
      const url = `${location.origin}${r.url}`;
      try { void navigator.clipboard?.writeText(url); } catch { /* shown below anyway */ }
      notify("info", `Link copied — read-only, expires in 7 days. ${url}`);
    } catch (e) {
      notify("error", (e as Error).message);
    }
  }

  async function revokeShares(id: string) {
    try {
      const r = await api.share(id, { revoke: true });
      notify("info", r.revoked ? `Revoked ${r.revoked} link${r.revoked === 1 ? "" : "s"}.`
                               : "No live links to revoke.");
    } catch (e) {
      notify("error", (e as Error).message);
    }
  }

  async function duplicateSession(id: string) {
    try {
      const { session } = await api.duplicateSession(id);
      await loadSessions();
      setSessionId(session.id);          // land in the copy, not the original
      notify("info", `Duplicated — “${session.title ?? "session"}”`);
    } catch (e) {
      notify("error", (e as Error).message);
    }
  }

  // "This is bigger than I thought." Cut a worktree for the session you are in and
  // keep going in it, instead of abandoning the chat and starting a new one next
  // door. The branch is the session's own title — nothing to type on a phone — and
  // the branch list decides the suffix so a second press can't fail on the name.
  async function moveToNewWorktree(id: string) {
    const s = sessions.find((x) => x.id === id);
    if (!s) return;
    try {
      const { branches } = await api.branches(s.project);
      const branch = branchForSession(s.title || "", branches);
      // Cut from the session's own branch, not the main checkout's HEAD: a session
      // already in a worktree is asking to branch from where it is standing.
      const wt = await api.worktreeAdd(s.project, branch, s.branch || undefined, true);
      if (!wt.ok) { notify("error", wt.output || "worktree failed"); return; }
      await api.relocateSession(id, s.project, branch);
      await loadSessions();
      notify("info", `Now in ${branch}`);
    } catch (e) {
      notify("error", (e as Error).message);
    }
  }

  async function relocateSession(id: string, project: string, branch: string) {
    try {
      const r = await api.relocateSession(id, project, branch);
      await loadSessions();
      notify("info", `Moved to ${branch} — ${r.rewritten} rows rewritten.`);
    } catch (e) {
      notify("error", (e as Error).message);
    }
  }

  /** Tools/MCP servers this session may not touch. Optimistic — the switch flips
   *  now and the 5s session poll confirms. Takes effect on the next turn. */
  function setSessionToolsFor(id: string, rules: string[]) {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, disabled_tools: rules } : s)));
    void api.setSessionTools(id, rules).then(() => void loadSessions()).catch(() => void loadSessions());
  }
  const setSessionTools = (rules: string[]) => {
    if (sessionId) setSessionToolsFor(sessionId, rules);
  };

  async function setLifecycle(id: string, state: Lifecycle | null) {
    try {
      await api.setLifecycle(id, state);
      // Only let go of the session if it just left the active list.
      if (state !== null && sessionId === id) setSessionId(null);
      await loadSessions();
    } catch { /* ignore */ }
  }

  if (AUTH_REQUIRED && !TOKEN) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        Missing token. Open the dashboard via the URL the bridge printed (it includes
        <span className="font-mono"> ?token=…</span>).
      </div>
    );
  }

  const td = themeDef(settings.theme);
  const wsRoot = (activeProject || "/").replace(/\/[^/]*$/, "") || "/";

  return (
    <div className="flex h-full flex-col" style={{ background: "var(--panel3)", position: "relative" }}>
      {settings.scanlines && <div className="crt" />}
      {settings.sweep && <div className="sweep" />}
      <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: -1, background: td.bg, transition: "background .5s ease" }} />

      {showDashboard && (
        // ONE themed container: colour comes from the CSS filter, shape from
        // data-theme, ground/voice from canvas/font. Every surface — panels
        // and all modals below — inherits all three.
        <div
          data-theme={settings.theme}
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            filter: themeFilter(settings.theme),
            background: themeCanvas(settings.theme),
            fontFamily: fontStack(settings.font, settings.theme) || undefined,
            ...themeVars(settings.theme),
          } as CSSProperties}
        >
            <Strip
              radio={radio.radio}
              onToggleRadio={radio.toggle}
              onNextRadio={radio.next}
              onOpenSettings={() => setSettingsOpen(true)}
              clock={tele.clock}
              weather={weather}
              onSetCity={setCity}
              onSetUnit={setUnit}
              openSettings={wxSettings}
              onFeed={feed}
            />

            <div
              className="hudgrid grid min-h-0 flex-1 gap-[13px] p-[13px]"
              style={{ gridTemplateColumns: `360px minmax(0,1fr) ${settings.rightOpen ? "372px" : "30px"}`, minWidth: 0 }}
            >
              {/* LEFT — no scroller here: SessionsPanel owns the only scroll. */}
              <div className="flex min-h-0 min-w-0 flex-col gap-[13px] pr-0.5">
                <SessionsPanel
                  sessions={visibleSessions} groups={visibleGroups} status={statusMap} done={doneIds}
                  flags={promptFlags} pins={pins}
                  selectedSessionId={sessionId} booting={!booted}
                  activeProject={activeProject}
                  onTogglePin={togglePin}
                  onSelectSession={(s) => void selectSession(s)}
                  onAnalyze={(rel) => openAnalyze(rel)}
                  onNewSession={(rel) => void newSession(rel)}
                  onWorktreeSession={(rel, branch, create, parent) => void worktreeSession(rel, branch, create, parent)}
                  onTypedSession={(rel, stype, prompt) => void typedSession(rel, stype, prompt)}
                />
              </div>

              {/* CENTER */}
              <Terminal
                view={view} onView={setView} selected={selected} sessionId={sessionId} activeProject={activeProject}
                branch={selected?.branch} model={model} turnCount={turns.length} turns={turns}
                activeId={active?.id ?? null} onRespond={respond}
                scrollRef={scrollRef} contentRef={contentRef}
                atBottom={atBottom} onJumpBottom={jumpToBottom}
                onOpenFromHistory={(s) => void openFromHistory(s)}
                onStartNext={(it) => void startIn(it.project, it.prompt,
                  { title: it.title, cwd: it.cwd, force: true })}
                liveTurns={liveTurns.current}
                trailingWorking={openWorking && !running} loading={loadingSession || !booted} hud={settings}
                boot={boot}
                hasOlder={older.has} olderLoading={older.loading} onLoadOlder={() => void loadOlder()}
                renderFrom={older.from}
                navRef={transcriptNav} restoringRef={restoreTo} onJumpMark={(m) => void jumpToMark(m)}
                onRunCommand={runCommand}
                onQuote={quote}
                // Tapping a suggested reply to a question the model asked in prose
                // sends it as the next prompt — same path as typing it yourself.
                // Except "No": there's nothing to do, so it just drops the ASK
                // state instead of paying for a turn that answers nobody.
                onAnswer={(text) => {
                  if (text === "No" && sessionId) {
                    setStatusMap((m) => { const n = new Map(m); n.delete(sessionId); return n; });
                    void api.dismissAsk(sessionId);
                  } else void send(text, []);
                }}
                onStage={(action, stage) => void setStage(action, stage)}
                onRetype={(stype) => void retypeSession(stype)}
                onOpenFile={openFileRef}
                onOpenDesign={ai.design && sessionProject ? () => openAnalyze(sessionProject, undefined, "design") : undefined}
                composer={
                  <>
                    {checking !== undefined && <CheckingBanner prompt={checking} />}
                    {held && (
                      <SuggestNewSessionCard
                        currentTitle={selected?.title ?? ""}
                        reason={held.reason}
                        suggestedTitle={held.title}
                        busy={heldBusy}
                        onStartNew={() => void heldStartNew(held)}
                        onContinue={() => {
                          setHeldMap((m) => omit(m, held.sid));
                          void send(held.text, held.images, { force: true, sessionId: held.sid });
                        }}
                        onDismiss={() => { feed([held.text]); setHeldMap((m) => omit(m, held.sid)); }}
                      />
                    )}
                    <Composer
                      pills={
                        // Inside the composer's box, not on the bare panel above
                        // it: a lone pill on its own strip read as a layout slip.
                        <div className="pillstrip">
                          <AgentsPill sessionId={sessionId} running={running} />
                          <GoalPill
                            goal={sessions.find((s) => s.id === sessionId)?.goal}
                            onClear={() => void send("/goal", [])}
                          />
                        </div>
                      }
                      disabled={!sessionId || pendingCount > 0} running={running} model={model} models={composerModels} usage={usage} effort={effort}
                      agent={agentId} agents={agentOpts} onAgent={setAgent}
                      injectedText={inject.text} injectNonce={inject.nonce} sessionId={sessionId}
                      draft={draft} onDraft={setDraft}
                      contextTokens={contextTokens} onModel={setModel} onEffort={setEffort}
                      perm={permMode} onPerm={setPermMode} ponytail={ponytail} onPonytail={setPonytail}
                      showPonytail={ai.ponytail}
                      onSend={(t, i) => void send(t, i)} onStop={() => void stop()}
                      onSteer={(t, i) => void queue.steer(t, i).then((ok) => { if (!ok) void send(t, i); })}
                      onCompact={(instr) => void send(instr ? `/compact ${instr}` : "/compact", [])}
                      queued={queue.queued.map((q) => ({ id: q.id, text: q.text }))}
                      paused={queue.paused} onTogglePause={queue.togglePause}
                      onCancelQueued={(id) => queue.remove(id)}
                      onEjectQueued={(id) => void ejectQueued(id)}
                      project={sessionProject}
                      onOpenMap={ai.graph && sessionProject ? () => openAnalyze(sessionProject, undefined, "map") : undefined}
                    />
                  </>
                }
              />

              {/* RIGHT — activity bar of icons; clicking the active one collapses
                  the body and unmounts the panel (which stops its polling). */}
              <RightPanel
                tabs={rightTabs} activeId={settings.rightTab}
                open={settings.rightOpen} onTab={pickRightTab}
                project={sessionProject} branch={sessionBranch}
              />
            </div>

            <StatusBar
              mount={wsRoot} usedPct={usedPct} resetLabel={resetLabel} accounts={accounts}
              agent={activeAgent}
              // The footer reports the session you have open, not the bridge's
              // active project — those differ while you read another session.
              repo={sessionProject ?? "—"} git={sessionGit}
              changes={sessionGit?.dirty ?? activeBadge?.dirty ?? 0}
              ctxTokens={selected?.ctx_tokens ?? null}
              ctxWindow={selected?.ctx_window ?? null}
              sessionId={sessionId}
              branch={sessionBranch}
              onSynced={() => setGitNonce((n) => n + 1)}
              onPalette={() => setPaletteOpen(true)}
              agents={agentOpts} onPickAgent={setAgent}
            />

            {analyzeProject && (
              <AnalyzeModal
                // The file is part of the key so a second deep-link (same
                // project, different file) remounts on that file.
                key={`${analyzeProject}:${analyzeFile?.path ?? ""}:${analyzeFile?.line ?? ""}:${analyzeTab ?? ""}:${analyzeCommand ?? ""}`}
                project={analyzeProject} badge={gitBadges.get(analyzeProject)}
                initialFile={analyzeFile?.path} initialBranch={analyzeFile?.branch}
                initialLine={analyzeFile?.line}
                initialTab={analyzeTab} initialCommand={analyzeCommand}
                sessions={sessions.filter((s) => s.project === analyzeProject)} status={statusMap}
                onClose={() => setAnalyzeProject(null)} onFeed={feed}
                onSelectSession={(s) => { void selectSession(s); setAnalyzeProject(null); setView("chat"); }}
                onWorktreeSession={(rel, branch, create, parent, firstPrompt) => { void worktreeSession(rel, branch, create, parent, firstPrompt); setAnalyzeProject(null); }}
              />
            )}
            <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
            {manageOpen && (
              <ManageProjectsModal
                groups={projectGroups.filter((g) => !removedProjects[g.rel])}
                imported={importedProjects.filter((rel) => !removedProjects[rel])}
                hidden={hiddenProjects}
                onSetHidden={setHidden}
                onRemove={(rel) => {
                  setRemovedProjects((p) => ({ ...p, [rel]: true }));
                }}
                onImport={importProject}
                onClose={() => setManageOpen(false)}
              />
            )}
            {toolsFor && (
              <ToolsModal
                title={sessions.find((s) => s.id === toolsFor)?.title || "session"}
                disabled={sessions.find((s) => s.id === toolsFor)?.disabled_tools ?? []}
                onChange={(rules) => setSessionToolsFor(toolsFor, rules)}
                onClose={() => setToolsFor(null)}
              />
            )}
            {inspectorOpen && <InspectorModal onClose={() => setInspectorOpen(false)} />}
            {settingsOpen && (
              <SettingsModal host={host.host} port={location.port || "8790"}
                settings={settings} onTheme={setTheme} onToggle={toggleCrt} onPatch={patchSettings}
                models={modelOpts} agents={agentOpts} weather={weather} onSetCity={setCity} onSetUnit={setUnit}
                station={radio.station} onStation={radio.setStation} onFeed={feed}
                sessionTools={selected?.disabled_tools ?? []}
                onSessionTools={setSessionTools}
                onOpenInspector={() => { setSettingsOpen(false); setInspectorOpen(true); }}
                onReplayBoot={replayBoot} onClose={() => setSettingsOpen(false)} />
            )}
            {ctxMenu && <ContextMenu ctx={ctxMenu} items={ctxItems} closing={ctxClosing} onClose={closeCtx} />}
            {filePick && (
              <ContextMenu
                ctx={{ x: filePick.x, y: filePick.y, type: "file", id: "", label: filePick.name }}
                items={distinctDirs(filePick.paths).map((dir, i) => ({
                  icon: "▤", label: dir,
                  onClick: () => {
                    if (sessionProject)
                      openAnalyze(sessionProject, { path: filePick.paths[i], branch: sessionBranch, line: filePick.line });
                  },
                }))}
                onClose={() => setFilePick(null)}
              />
            )}
            {/* every plain title="" in here, drawn in the HUD's own type */}
            <NativeTips />
            <AskDialog />
            <RestartIntro theme={settings.theme} scanlines={settings.scanlines} />
        </div>
      )}

      {booting && (
        <BootIntro theme={settings.theme} scanlines={settings.scanlines} steps={bootSteps} onReveal={() => setShowDashboard(true)} onDone={() => { setShowDashboard(true); setBooting(false); }} />
      )}
    </div>
  );
}
