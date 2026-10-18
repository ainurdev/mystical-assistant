import {
  Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore,
  type CSSProperties, type ReactNode,
} from "react";
import {
  Activity, AudioLines, Bell, Bookmark, Boxes, Cable, CircleCheck, 
  FolderTree, Gauge, GitBranch, 
  Globe,
  Handshake, KeyRound, ListMusic, ListTree, LoaderCircle, Lock,
  Monitor, Moon, Network, Palette, Play, Plug,
  Power, ScanLine, ScrollText, Search, Server, 
  SlidersHorizontal, Sparkles, SquareTerminal, TriangleAlert, Type,
  Upload, Waypoints, type LucideIcon,
  ChevronDown, ChevronRight, FileArchive, HardDriveDownload, HardDriveUpload, 
  ListChecks, Package, PackageOpen, Truck, AppWindow, AppWindowMac, Pin,
} from "lucide-react";
import { CHAT_BGS, type ChatBg } from "../../lib/toolwidget";
import { toolAccent } from "../../lib/tools";

import { ago, hhmm, projectName, useClock12, windowLabels } from "../../lib/surfaces";
import { SkillsFold } from "./SkillsFold";
import { DeviceRunsPanel } from "./DeviceRunsPanel";
import { ProfilePick, ProjectsSettings, type ProjectsSettingsProps } from "./ProjectsSettings";
import {
  api,
  type AccountInfo,
  type AiFeature,
  type EnvSetting,
  type Integration,
  type AcpAccount,
  type AcpAgentsInfo,
  type AcpPreset,
  type McpInfo,
  type NoticePrefs,
  type NoticePrefsPatch,
  type RivendellInstance,
  type RivendellInput,
  type RivendellStatus,
  type StartupState,
  type TrackerConnection,
  type UpdateInfo,
  type VideoTools,
  MOVE_EVENT,
  type MoveFile,
  type MoveItem,
  type MoveJob,
  type MovePlan,
  type MoveRead,
  type MoveSection,
  type MoveSectionKey,
} from "../../api";
import { fmtBytes, fmtDur, nextAction, nextLabel } from "./MoveDock";
import {
  canInstall as canInstallNow, install, isInstalled, subscribe,
} from "../../lib/installprompt";
import {
  autoBaseFont,
  BASE_FONTS,
  colourings,
  FAMILIES,
  family,
  FONTS,
  HEADER_STYLES,
  type HeaderStyle,
  fontStack,
  isLight,
  themeDef,
  themeHasCrt,
  twin,
  type Family,
  type HudSettings,
  type ThemeKey,
} from "../../lib/theme";
import { describe, importLegacy, type Profile, type ProfilesInfo, type ProfileWrite } from "../../lib/profiles";
import { AGENT_DEFAULT, agentLabel, optionRows, setAgentLabels } from "../../lib/agents";
import { notify } from "./Notifications";
import { NYAN_MODES, nyanLabel, nyanThumb, type NyanSound } from "../../lib/nyan";
import { setAiFeatures, useAiFeatures } from "../../lib/ai";
import { setIntegrations, useIntegrations } from "../../lib/integrations";
import { askConfirm } from "../ui/Ask";
import { TONES, chime, pushSupported, requestPush, type ToneKey } from "../../lib/push";
import { isNativeApp, isWinApp, macRebuild, macSet, useMacSettings, type MacSwitch } from "../../lib/mac";
import { EFFORTS, PERMS, PONYTAILS } from "../Composer";
import { latestPerFamily } from "../../models";
import { UpdateButton } from "./UpdateButton";
import { restartBridge } from "../../lib/restart";
import { takeSettingsFocus } from "../../lib/opensettings";
import { testText } from "../../lib/rivendelltasks";
import { PromptBubble } from "../PromptBubble";
import { FinalResult } from "../RunStream";

export interface SettingsModalProps {
  host: string;
  port: string;
  /** Which tab to land on, when the opener asked for one by name (a dead-login
   *  badge sends you to ACCOUNTS). Read once: the modal mounts per open. */
  startTab?: Tab;
  settings: HudSettings;
  onTheme: (t: ThemeKey) => void;
  onToggle: (key: "scanlines" | "sweep" | "glow") => void;
  onPatch: (patch: Partial<HudSettings>) => void;
  models: { id: string; label: string }[];
  onFeed: (texts: string[], project?: string, fresh?: boolean) => void; // a failed self-update hands git's error to Claude
  onClose: () => void;
  // A profile can carry the open session's tool switches, so the panel reads them.
  sessionTools: string[];
  // The bridge's profiles (null until loaded; unavailable = a bridge older than
  // them), reloaded through onProfilesChanged after every edit here.
  profiles: ProfilesInfo | null;
  profilesAvailable: boolean;
  profilesError: string | null; // why the last load failed (not a 404)
  onProfilesChanged: () => void;
  // A login was added, removed, signed back in or switched on or off. A new
  // login comes with its own profile (bridge profiles.add_default), so the
  // composer reloads both its profiles and its meters rather than waiting a minute.
  onAccountsChanged: () => void;
  onOpenInspector: () => void;
  projects: ProjectsSettingsProps;
  /** The open session's project — what the SKILLS fold installs to. */
  project: string | null;
}

// ---- CATEGORIES -------------------------------------------------------------
// A category is "what were you trying to change", not "which file holds it".
// The first four are taste — how the HUD looks, what plays while it works, how
// it behaves, what surrounds it. NOTIFICATIONS is when it interrupts you. The
// last four are what a run, an account and the bridge do.
//
// NOTIFICATIONS used to be a block inside SYSTEM, between the HTTP inspector
// and the updater, which is where you look for it only if you already know it
// is there; likewise the prompt-box and transcript switches sat under SESSION
// among the model/mode/effort knobs they have nothing to do with.

export type Tab = "appearance" | "transcript" | "notifications"
  | "aimgmt"
  | "integrations" | "system" | "move"
  | "mac";

/** The four tabs AI MANAGEMENT replaced, and the fold each lands on. A caller
 *  that still names one (a bookmark, an older bridge's bot button) opens the
 *  page on that fold rather than on nothing. PLUGINS became INTEGRATIONS:
 *  openSettings("plugins", id) still opens the Rivendell card on that instance. */
const LEGACY_TAB: Record<string, string> = { projects: "PROJECTS", session: "PROFILES", accounts: "ACCOUNTS", mcp: "MCP SERVERS", ai: "MODEL-SPENDING EXTRAS" };
export function normalizeTab(t: string | undefined): { tab: Tab | undefined; sec: string | null } {
  if (t === "plugins") return { tab: "integrations", sec: "RIVENDELL" };
  if (t && t in LEGACY_TAB) return { tab: "aimgmt", sec: LEGACY_TAB[t] };
  return { tab: t as Tab | undefined, sec: null };
}

// The rail carries the same three-way split the comment above describes, but
// as two headings rather than ten peers: what the HUD is like, and what the
// work does. Ten flat rows made you read the whole list to find one setting.
//
// Hints are one line each, always — the four that used to wrap ("what plays
// while working", "extras that spend model calls") gave every other row a
// different height, and a rail whose rows are all different heights reads as
// ten unrelated things rather than two groups of five.
//
// `about` is the page's own first line: what the category is FOR, in a
// sentence. The rail's hint names what's inside; nothing said why you'd open
// it, so every page began on its first block and left you to work that out.
const TABS: { key: Tab; label: string; hint: string; about: string; icon: LucideIcon; group: string }[] = [
  { key: "appearance", label: "APPEARANCE", hint: "theme · header · type", icon: Palette, group: "THE HUD",
    about: "How the dashboard looks: its theme and colour, the header over the transcript, its typeface and size." },
  { key: "transcript", label: "TRANSCRIPT", hint: "how a session draws", icon: ScrollText, group: "THE HUD",
    about: "How a session reads: the chat layout, the composer's send key, the ground every turn is drawn on, whether results start open, and what shows while it works." },
  { key: "notifications", label: "NOTIFY", hint: "events · quiet · sound", icon: Bell, group: "THE HUD",
    about: "What interrupts you, and how: for each kind of news — a session, a Rivendell job, a PR — a pop-up, a sound, a Telegram message, or only the bell." },
  // Only inside the native app — Mystical.app or Mystical.exe (RAIL and the
  // search both skip it elsewhere): the switches that are the app's, not the
  // page's (lib/mac). One tab, named for the shell it's in.
  { key: "mac", label: isWinApp() ? "WINDOWS APP" : "MAC APP", hint: isWinApp() ? "window · tray · hotkey" : "window · dock · panel",
    icon: isWinApp() ? AppWindow : AppWindowMac, group: "THE HUD",
    about: isWinApp()
      ? "What only the Windows app can do: the window's title, the floating WAITING ON YOU panel, the Win+Ctrl+A summon, and rebuilding the app after an update."
      : "What only the Mac app can do: the window's title, the Dock icon, the floating WAITING ON YOU panel, and rebuilding the app after an update." },
  // First under THE WORK: who runs a session and where. One page, five folds —
  // it was five tabs (PROJECTS, SESSION, MCP, ACCOUNTS, AI) that each held a
  // piece of the same question, and the sidebar's SKILLS panel besides.
  { key: "aimgmt", label: "AI MANAGEMENT", hint: "accounts · skills · mcp · profile · projects", icon: KeyRound, group: "THE WORK",
    about: "Who runs your sessions and with what: the logins and the profiles bound to them, the skills, extras and MCP servers they can reach, the default profile, and which one each project starts with." },
  { key: "integrations", label: "INTEGRATIONS", hint: "installed · available", icon: Waypoints, group: "THE WORK",
    about: "Other systems the bridge does work for. Each one ships with Mystical but stays silent until you install it: no tab, no card, no rows, no worker." },
  { key: "system", label: "SYSTEM", hint: "bridge · updates", icon: Server, group: "THE WORK",
    about: "The bridge itself: its address, starting at login, the API inspector, updates, and every setting it reads from its environment." },
  { key: "move", label: "MOVE", hint: "export · import", icon: Truck, group: "THE WORK",
    about: "Carry this bridge to another machine. EXPORT packs your repos' unpushed work, MCP servers, plugins, Claude Code settings and chat history into one file; IMPORT replays a file from another machine here." },
];
const RAIL = TABS.filter((t) => t.key !== "mac" || isNativeApp());

// ---- SEARCH -----------------------------------------------------------------
// Ten categories deep, "where do I turn X off" is a hunt through all ten. One
// entry per Section, carrying the names of the rows inside it as `terms`: you
// search for the setting and land on the block that holds it. The forty-odd
// environment settings under SYSTEM are deliberately absent — they come from
// the bridge, so search fetches that registry the first time you type and folds
// it in row by row, which also means nobody has to keep a copy of them here.
const INDEX: { tab: Tab; sec: string; terms: string }[] = [
  { tab: "appearance", sec: "THEME", terms: "colour color palette scheme aurora claude flint phosphor dark light day bright" },
  { tab: "appearance", sec: "HEADER", terms: "header island frost veil tuck glass readouts" },
  { tab: "appearance", sec: "CRT EFFECTS", terms: "scanlines scan sweep text glow bloom raster" },
  { tab: "appearance", sec: "TYPE", terms: "font typeface monospace family text size zoom bigger smaller scale px auto base preview" },
  { tab: "transcript", sec: "WHILE IT WORKS", terms: "working indicator equalizer spinner status line bars nyan cat" },
  { tab: "transcript", sec: "LAYOUT", terms: "layout compact default chat bubbles right side header pill composer model popover effort slider permissions prompt box tabs console classic" },
  { tab: "transcript", sec: "COMPOSER", terms: "send key enter ctrl+enter cmd newline shift submit message keyboard shortcut" },
  { tab: "transcript", sec: "RESULTS", terms: "auto-open results bash output edit diffs collapse steps fold" },
  { tab: "transcript", sec: "THE GROUND", terms: "background pattern texture ground graph grid dots matrix ruled lines tooth grain noise paper lamp light haze wash mat wallpaper chat background" },
  { tab: "notifications", sec: "WHAT INTERRUPTS YOU", terms: "events pop up toast banner sound tone telegram away rivendell pr finished failed question approval" },
  { tab: "notifications", sec: "QUIET HOURS", terms: "quiet hours night do not disturb dnd mute schedule" },
  { tab: "notifications", sec: "THIS BROWSER", terms: "os notifications browser push permission alert sound volume chime mute" },
  { tab: "mac", sec: "WINDOW", terms: "mac app windows app title bar session name dock icon keep cmd-tab space tray hotkey summon shortcut win ctrl a" },
  { tab: "mac", sec: "PANEL", terms: "floating panel waiting on you always on top every space window" },
  { tab: "mac", sec: "APP", terms: "rebuild version screen capture recording permission mystical.exe mystical.app" },
  { tab: "aimgmt", sec: "PROFILES", terms: "model mode effort ponytail permission plan bypass opus sonnet run defaults default profile preset saved knobs tools agent account login bind" },
  { tab: "aimgmt", sec: "MODEL-SPENDING EXTRAS", terms: "ai features extras titles guard next-up scout summaries lessons dreaming cost tokens spending" },
  { tab: "aimgmt", sec: "MCP SERVERS", terms: "mcp server tool connect authenticate auth oauth token expired reconnect logout remove playwright github notion figma" },
  { tab: "aimgmt", sec: "ADD A SERVER", terms: "mcp add new server url command stdio http sse scope install connector" },
  { tab: "aimgmt", sec: "ACCOUNTS", terms: "policy wait switch fallback reset quota account add sign in oauth profile login agent acp codex opencode gemini api key install test other agent" },
  { tab: "integrations", sec: "RIVENDELL", terms: "rivendell plugin pr review implement ai instance production local staging websocket agent token api url workdir model timeout video ffmpeg whisper" },
  { tab: "integrations", sec: "ADD AN INSTANCE", terms: "rivendell add new instance connection production local staging api url token" },
  { tab: "integrations", sec: "TRACKERS", terms: "teamwork jira tracker tasks link token connection digest" },
  { tab: "integrations", sec: "CLAUDE DESIGN", terms: "claude design system link pull sync skill tokens components" },
  { tab: "integrations", sec: "AVAILABLE", terms: "install integration plugin add rivendell teamwork jira claude design" },
  { tab: "system", sec: "BRIDGE", terms: "host port address" },
  { tab: "system", sec: "STARTUP", terms: "install app pwa start at login autostart window systemd" },
  { tab: "aimgmt", sec: "SKILLS", terms: "skills skill catalog install plugin marketplace SKILL.md system project" },
  { tab: "aimgmt", sec: "PROJECTS", terms: "manage projects hide remove import repository repo detach sidebar name rename label default profile" },
  { tab: "system", sec: "HTTP INSPECTOR", terms: "api traffic proxy request sse token" },
  { tab: "system", sec: "PLATFORM", terms: "update version git rebuild restart" },
  { tab: "move", sec: "WHAT GOES", terms: "move export import migrate new machine laptop transfer backup restore tar file" },
];

type Hit = { tab: Tab; sec: string; row?: string; hint?: string };

/** AI TUNING rows by the switch they tune: with it off they're noise, so the
 *  panel and the search both drop them.
 *  ponytail: matched on the env name's prefix, so a knob named any other way
 *  stays visible; give envsettings a `feature` field if one ever is. */
const TUNES: Record<string, string> = { RELEVANCE_: "relevance", NEXTUP_: "nextup" };
const tunesOff = (key: string, ai: Record<string, boolean>) =>
  Object.entries(TUNES).some(([pre, f]) => key.startsWith(pre) && !ai[f]);

function search(q: string, env: EnvSetting[], hidden: Set<string>): Hit[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const label = (t: Tab) => TABS.find((x) => x.key === t)!.label;
  const all: (Hit & { hay: string })[] = [
    ...INDEX.filter((e) => !hidden.has(e.sec) && (e.tab !== "mac" || isNativeApp())).map((e) => ({
      tab: e.tab, sec: e.sec, hay: `${label(e.tab)} ${e.sec} ${e.terms}`.toLowerCase(),
    })),
    ...env.map((s) => ({
      tab: "system" as Tab, sec: s.group, row: s.label, hint: s.hint,
      hay: `system ${s.group} ${s.label} ${s.key} ${s.hint}`.toLowerCase(),
    })),
  ];
  return all.filter((e) => words.every((w) => e.hay.includes(w))).slice(0, 40);
}

const CRT_TOGGLES: { key: "scanlines" | "sweep" | "glow"; label: string; desc: string }[] = [
  { key: "scanlines", label: "SCANLINES", desc: "horizontal CRT raster lines" },
  { key: "sweep", label: "SCAN SWEEP", desc: "roaming refresh glow band" },
  { key: "glow", label: "TEXT GLOW", desc: "phosphor bloom on headings" },
];

/** Every family draws this dialog as an app's settings page (index.css, THE
 *  FAMILIES · SETTINGS): sentence-case labels, a toggle for a switch, one theme
 *  grid behind a Dark/Light switch. AURORA sets the same words in its tracked
 *  capitals, from CSS. */
const ACRONYMS = new Set(["AI", "MCP", "CRT", "HUD", "CLI", "API", "URL", "TG", "SSH", "PR", "ID", "UI", "OS",
  "GPU", "CPU", "RAM", "JSON", "ENV", "IDE", "MA", "VS", "FM", "PWA", "SOS", "ESC", "TTS", "STT", "LLM", "GH"]);
/** "THEME · DARK" → "Theme · dark"; acronyms stay capitals. */
function sentence(s: string): string {
  const w = s.toLowerCase().replace(/[a-z]+/g, (m) => (ACRONYMS.has(m.toUpperCase()) ? m.toUpperCase() : m));
  return w.charAt(0).toUpperCase() + w.slice(1);
}
/** A label in the dialog's voice. */
export function useVoice(): (s: ReactNode) => ReactNode {
  return (s) => (typeof s === "string" ? sentence(s) : s);
}

const field = {
  background: "var(--panel3)",
  border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)",
  outline: "none",
  color: "var(--txb)",
  fontFamily: "inherit",
  fontSize: "var(--t10)",
  letterSpacing: 1,
  padding: "6px 8px",
};

const ROW: CSSProperties = { display: "flex", alignItems: "center", gap: 10, marginTop: 11 };
// Several controls abreast, wrapping onto a second line when the panel narrows.
const LINE: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 12, marginTop: 11 };
const CAPTION: CSSProperties = { fontSize: "var(--t95)", letterSpacing: 1, color: "var(--txd)", flex: "none", width: 62 };
const RULE = "1px solid color-mix(in srgb, var(--acc) 10%, transparent)";
// A card is a raised surface, not just an outline — --panel over the modal's
// own --panel2 is what separates "a block of settings" from "the panel".
export const CARD: CSSProperties = {
  border: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)",
  background: "color-mix(in srgb, var(--panel) 55%, transparent)",
  padding: "14px 16px",
};
const KV: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between" };
// A setting's name at --txm, the lines that explain it at --txd. The explaining
// used to sit at --txl — under 2.5:1 on the dark grounds — so the ⓘ you opened
// in order to read something handed you text you could barely read.
const KEY_TX: CSSProperties = { fontSize: "var(--t10)", letterSpacing: 1, color: "var(--txm)" };
const NOTE: CSSProperties = { fontSize: "var(--t95)", color: "var(--txd)", marginTop: 11, lineHeight: 1.7 };
// What an ⓘ unfolds. Ruled off on the left so it reads as an aside about the
// row above it, not as another line of the panel.
const ASIDE: CSSProperties = {
  fontSize: "var(--t95)", color: "var(--txd)", lineHeight: 1.75, marginTop: 9,
  borderLeft: "1px solid color-mix(in srgb, var(--acc) 32%, transparent)", paddingLeft: 10,
};

/** ⓘ — unfolds the long-form "why" behind a setting. The disc is 15px; the
 *  .infodot class in index.css is what makes it a thumb-sized target. */
function InfoDot({ on, about, onClick }: { on: boolean; about?: string; onClick: () => void }) {
  return (
    <button
      className="infodot"
      onClick={onClick}
      aria-expanded={on}
      aria-label={about ? `about ${about}` : "what this does"}
      style={{
        appearance: "none", cursor: "pointer", flex: "none", padding: 0,
        width: 15, height: 15, lineHeight: "13px", borderRadius: "50%",
        border: `1px solid color-mix(in srgb, var(--acc) ${on ? 65 : 28}%, transparent)`,
        background: on ? "color-mix(in srgb, var(--acc) 18%, transparent)" : "transparent",
        color: on ? "var(--txb)" : "var(--txl)",
        fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t8)",
      }}
    >
      i
    </button>
  );
}

// One icon per block, looked up by title rather than passed at each call site:
// the groups under SYSTEM and the tools under CONFIG are named by the bridge,
// so they get theirs from the same table instead of a second mechanism.
const SEC_ICONS: Record<string, LucideIcon> = {
  "WHILE IT WORKS": AudioLines,
  "CRT EFFECTS": ScanLine,
  TYPE: Type,
  "WORKING INDICATOR": AudioLines,
  RESULTS: ListTree,
  "WHAT INTERRUPTS YOU": Bell,
  "QUIET HOURS": Moon,
  "THIS BROWSER": Monitor,
  "PER EVENT": ListMusic,
  "RUN DEFAULTS": SlidersHorizontal,
  PROFILES: Bookmark,
  "MODEL-SPENDING EXTRAS": Sparkles,
  "CLAUDE CODE": SquareTerminal,
  OPENCODE: Boxes,
  "MCP SERVERS": Plug,
  "ADD A SERVER": Server,
  "ON USAGE LIMIT": Gauge,
  "CLAUDE LOGINS": KeyRound,
  AGENTS: Handshake,
  BRIDGE: Network,
  STARTUP: Power,
  "HTTP INSPECTOR": Activity,
  PLATFORM: GitBranch,
  // …and the environment registry's own groups, which arrive from the bridge.
  ACCESS: Lock,
  PROJECTS: FolderTree,
  RUNS: Play,
  SERVERS: Server,
  TUNNEL: Cable,
  UPLOADS: Upload,
  "AI TUNING": Sparkles,
  "DEV SERVER": SquareTerminal,
  BROWSER: Globe,
};

// …and one visible line per block saying what it is FOR, looked up the same way
// for the same reason. The long "why" stays behind the ⓘ; this is the line that
// tells you, before you read any of that, whether you're in the right place.
const SEC_DESC: Record<string, string> = {
  "WHILE IT WORKS": "What the transcript shows while a session is working.",
  HEADER: "How the session header sits over the transcript.",
  "CRT EFFECTS": "The tube laid over the screen: raster lines, a roaming glow, bloom on headings.",
  TYPE: "The typeface the HUD is set in, and the base size every other size scales from.",
  "THE GROUND": "The texture the transcript sits on.",
  RESULTS: "Whether command output and diffs start open or folded.",
  "WORKING INDICATOR": "The tab you pick is the one the dashboard shows while it works.",
  "WHAT INTERRUPTS YOU": "Everything lands in the bell. These choose what interrupts you, per kind of news. Kept on the bridge, so Telegram follows them too.",
  "QUIET HOURS": "A window when nothing pops up, sounds or reaches Telegram.",
  "THIS BROWSER": "This browser's own switches: the system banner permission, sounds, and how loud.",
  "PER EVENT": "A different sound for each kind of news: a tone, a voice line from a pack, or nothing.",
  "RUN DEFAULTS": "What each new run starts with. The composer's dropdowns are these same settings.",
  PROFILES: "Who runs a session, and with what — bound to it on every surface.",
  "MODEL-SPENDING EXTRAS": "Features that call a model on their own. Each shows what one use costs.",
  "CLAUDE CODE": "Claude Code's global instructions and settings, read by every run.",
  OPENCODE: "opencode's global instructions and config.",
  "MCP SERVERS": "Servers a session can call tools from: their health, their login, removing them.",
  "ADD A SERVER": "Connect a new server by URL, or by the command that starts it.",
  "INBOUND HOOKS": "Your hook URLs. Anything POSTed to one is pushed to Telegram.",
  "ADD A HOOK": "Make a new URL for one sender, like GitHub, Sentry or a CI job.",
  "RECENT EVENTS": "What your hooks received lately, newest first.",
  "ON USAGE LIMIT": "What a chat does when its login runs out: ask you, fall back on its own, or wait.",
  "CLAUDE LOGINS": "The Claude accounts runs can use, and how much of each is left.",
  AGENTS: "Other coding agents a profile can run a session on, and the accounts they use.",
  BRIDGE: "The address this dashboard is talking to.",
  STARTUP: "Install the dashboard as its own app, and start it when you log in.",
  "HTTP INSPECTOR": "Watch every API request a run makes, live.",
  PLATFORM: "The bridge's version, and updating it in place.",
  // …and the environment registry's groups, as they arrive from the bridge.
  ACCESS: "Who may drive this bridge: the bot token, allowed chats, the dashboard's gate.",
  PROJECTS: "Where the project browser starts, and the project a new chat opens in.",
  RUNS: "How runs are launched and watched: timeouts, auto-resume, modes, flags.",
  SERVERS: "The local servers the bridge runs, and their ports.",
  TUNNEL: "The Cloudflare tunnel that gives the Mini App its public URL.",
  UPLOADS: "Limits on attachments, and how long they're kept.",
  "AI TUNING": "Models and limits for the new-session guard and the next-up scout.",
  "DEV SERVER": "Defaults for /server: its start command, port and tunnel client.",
  BROWSER: "The browser the AI drives when it tests: hidden or visible, which binary, whose profile.",
};

/** A titled block. The explanation that used to stand under every block as a
 *  paragraph folds behind the ⓘ beside the title instead — nine tabs of prose
 *  at rest is what made these panels read as a wall of text.
 *
 *  The icon is what you actually navigate by once a tab is longer than a
 *  screen: SYSTEM is twelve of these blocks, and twelve identical dim rules
 *  give the eye nothing to count off against while scrolling. */
export function Section({ title, icon, desc, info, top, children }: {
  title: ReactNode;
  icon?: LucideIcon;
  desc?: ReactNode;   // defaults to SEC_DESC by title
  info?: ReactNode;
  top?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const voice = useVoice();
  const Icon = icon ?? (typeof title === "string" ? SEC_ICONS[title] : undefined);
  const sub = desc ?? (typeof title === "string" ? SEC_DESC[title] : undefined);
  return (
    <div className="set-sec" data-sec={typeof title === "string" ? title : undefined} style={{ marginTop: top ? 34 : 0 }}>
      <div className="set-sechead" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {Icon && (
            <Icon size={13} strokeWidth={1.7} aria-hidden
              style={{ flex: "none", color: "var(--acc)", opacity: .8 }} />
          )}
          <span className="set-sectitle" style={{ fontSize: "var(--t95)", letterSpacing: 1.5, color: "var(--txd)", flex: "none" }}>
            {voice(title)}
          </span>
          {info && <InfoDot on={open} about={typeof title === "string" ? title : undefined} onClick={() => setOpen(!open)} />}
          <span className="set-secrule" style={{ flex: 1, height: 1, background: "color-mix(in srgb, var(--acc) 12%, transparent)" }} />
        </div>
        {/* Indented past the icon to the title, so it reads as the title's own
            caption rather than as the first line of the card below. */}
        {sub && (
          <div className="set-secdesc" style={{ fontSize: "var(--t95)", color: "var(--txd)", lineHeight: 1.6, marginTop: 6, paddingLeft: Icon ? 21 : 0 }}>
            {sub}
          </div>
        )}
        {info && open && <div style={{ ...ASIDE, marginTop: 10 }}>{info}</div>}
      </div>
      {children}
    </div>
  );
}

/** One setting inside a card: its name, its control on the right, a one-line
 *  `desc` if the name isn't self-evident, and everything longer behind the ⓘ.
 *  Rows are ruled apart rather than spaced apart, so a card of five settings
 *  stays one object. */
export function Row({ label, desc, info, first, children }: {
  label: ReactNode;
  desc?: ReactNode;
  info?: ReactNode;
  first?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const voice = useVoice();
  return (
    <div
      className="set-row"
      data-row={typeof label === "string" ? label : undefined}
      style={{ marginTop: first ? 0 : 13, paddingTop: first ? 0 : 13, borderTop: first ? undefined : RULE }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="set-key" style={KEY_TX}>{voice(label)}</span>
        {info && <InfoDot on={open} about={typeof label === "string" ? label : undefined} onClick={() => setOpen(!open)} />}
        <span style={{ flex: 1, minWidth: 8 }} />
        {children}
      </div>
      {desc && <div className="set-desc" style={{ fontSize: "var(--t95)", color: "var(--txd)", marginTop: 5, lineHeight: 1.6 }}>{desc}</div>}
      {info && open && <div style={ASIDE}>{info}</div>}
    </div>
  );
}

/** The top of every category page: its name, and in one sentence what it is
 *  for. The rail already said the first; nothing said the second. */
function PageHead({ tab }: { tab: (typeof TABS)[number] }) {
  const voice = useVoice();
  return (
    <div className="set-head" style={{ marginBottom: 30 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <tab.icon size={17} strokeWidth={1.6} aria-hidden style={{ flex: "none", color: "var(--acc)" }} />
        <h2 className="glow" style={{ margin: 0, fontSize: "var(--t15)", fontWeight: 400, letterSpacing: 2, color: "var(--txb)" }}>
          {voice(tab.label)}
        </h2>
      </div>
      <p style={{ margin: "9px 0 0", maxWidth: 600, fontSize: "var(--t10)", lineHeight: 1.7, color: "var(--txm)" }}>
        {tab.about}
      </p>
      {/* The panel's drawline: teal under the title, gone by the far edge. */}
      <div className="set-drawline" style={{
        height: 1, marginTop: 16,
        background: "linear-gradient(90deg, color-mix(in srgb, var(--acc) 45%, transparent), color-mix(in srgb, var(--acc) 8%, transparent) 60%, transparent)",
      }} />
    </div>
  );
}

/** Nothing to show yet, or nothing to show at all. A bare sentence in the top
 *  corner of a 700px-tall empty pane reads as a rendering failure; centred
 *  under its own icon it reads as the state it is. */
function Placeholder({ icon: Icon, spin, children }: {
  icon: LucideIcon;
  spin?: boolean;
  children: ReactNode;
}) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      gap: 12, padding: "72px 20px", textAlign: "center",
    }}>
      <Icon size={26} strokeWidth={1.3} aria-hidden
        style={{
          color: "var(--acc)", opacity: .4,
          animation: spin ? "introspin 1.4s linear infinite" : undefined,
        }} />
      <div style={{ fontSize: "var(--t10)", color: "var(--txl)", lineHeight: 1.75, maxWidth: 360 }}>
        {children}
      </div>
    </div>
  );
}

/** On/off, the way an app's settings page says it: a toggle (each family
 *  draws its own — index.css, THE FAMILIES · SETTINGS). */
export function Switch({ on, onClick, label }: { on: boolean; onClick: () => void; label?: string }) {
  return <button className="set-toggle" role="switch" aria-checked={on} aria-label={label} data-on={on || undefined} onClick={onClick}><i /></button>;
}

function Volume({ value, disabled, onChange }: { value: number; disabled?: boolean; onChange: (v: number) => void }) {
  return (
    <>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        title={`Volume ${Math.round(value * 100)}%`}
        style={{ width: 96, flex: "none", accentColor: "var(--acc)" }}
      />
      <span style={{ fontSize: "var(--t95)", color: "var(--txl)", flex: "none", width: 30, textAlign: "right", fontFamily: "'JetBrains Mono',monospace" }}>
        {Math.round(value * 100)}%
      </span>
    </>
  );
}

/** Segmented picker — one button per option, active one filled. A grid, not a
 *  wrapping flex row: flex stretches whatever lands on the last line, so ten
 *  fonts read as six even cells and then four oversized ones. Every cell is the
 *  same width here, however the list divides. */
function Segmented<T extends string>({
  options,
  value,
  onPick,
  size = "var(--t10)",
}: {
  options: { label: string; value: T }[];
  value: T;
  onPick: (v: T) => void;
  size?: string;
}) {
  const [hover, setHover] = useState<T | null>(null);
  return (
    <div className="set-seg" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(72px,1fr))", gap: 2, border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)" }}>
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            data-on={active || undefined}
            onClick={() => onPick(o.value)}
            onMouseEnter={() => setHover(o.value)}
            onMouseLeave={() => setHover(null)}
            style={{
              appearance: "none",
              cursor: "pointer",
              border: 0,
              background: active ? "var(--acc)"
                : hover === o.value ? "color-mix(in srgb, var(--acc) 12%, transparent)"
                : "transparent",
              color: active ? "var(--acc-on)" : "var(--txd)",
              fontFamily: "inherit",
              fontSize: size,
              letterSpacing: 1,
              padding: "6px 4px",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** A labelled control that shares its line with the others beside it — the
 *  caption sits above so the cells stay narrow, and they wrap when the panel
 *  can't hold them all. */
function Cell({ label, grow = "1 1 148px", children }: { label: string; grow?: string; children: ReactNode }) {
  return (
    <div style={{ flex: grow, minWidth: 0 }}>
      <div style={{ ...CAPTION, width: "auto", marginBottom: 5 }}>{label}</div>
      {children}
    </div>
  );
}

/** A labelled <select> cell over one of the composer's option lists. */
function PickCell({
  label,
  value,
  options,
  onPick,
  disabled,
  title,
}: {
  label: string;
  value: string;
  options: { id: string; label: string }[];
  onPick: (v: string) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <Cell label={label}>
      <select value={value} onChange={(e) => onPick(e.target.value)} disabled={disabled} title={title}
        style={{ ...field, width: "100%", opacity: disabled ? 0.6 : 1 }}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </Cell>
  );
}

const FAMILY_NAME: Record<Family, string> = { aurora: "Aurora", claude: "Claude", flint: "Flint", pebble: "Pebble" };
const FAMILY_TAG: Record<Family, string> = { aurora: "the CRT", claude: "the app itself", flint: "the editor", pebble: "the river stone" };
// What the Theme typeface is in each family: the face its palette brought.
const FAMILY_FACE: Record<Family, string> = { aurora: "Share Tech", claude: "System", flint: "Geist", pebble: "Nunito" };

/** A colouring's swatch, filled with what it paints: you, then what waits on
 *  you. A FLINT swatch keeps its ground between the two, because FLINT is
 *  mostly ground and the ground is what parts NOCTURNE from VIOLET; SUNSET's
 *  you is its gradient, KILN's corners are bars. */
function swatchFill(k: ThemeKey): string {
  const p = themeDef(k).pal;
  if (family(k) === "flint") {
    const [a, b] = k.startsWith("flint-kiln") ? [22, 78] : [40, 80];
    const you = p.acc2 ? `${p.acc}, ${p.acc2} ${a}%` : `${p.acc} 0 ${a}%`;
    return `linear-gradient(135deg, ${you}, ${p.panel} ${a}% ${b}%, ${p.ask} ${b}%)`;
  }
  return `linear-gradient(135deg, ${p.acc} 0 58%, ${p.ask} 58%)`;
}

/** The theme picker: one card per family, each previewing the UI in its own
 *  skin (data-pv), with its colourings on the chosen ground as swatches. A
 *  family's card wears your colouring if it is yours, or that colouring's twin
 *  on the other ground, so Ember on dark is one click from Ember on light.
 *  AURORA has no light ground — a tube has no daylight — so on Light its card
 *  stays, greyed, to say so. */
function ThemeGrid({ light, settings, onTheme }: {
  light: boolean;
  settings: HudSettings;
  onTheme: (t: ThemeKey) => void;
}) {
  const cur = settings.theme;
  return (
    <div className="ftgrid">
      {FAMILIES.map((fam) => {
        const keys = colourings(fam, light);
        const shown = keys.length ? keys : colourings(fam, !light);
        const mine = family(cur) === fam;
        const live = mine && shown.includes(cur) ? cur
          : mine && twin(cur) && shown.includes(twin(cur)!) ? twin(cur)!
          : shown[0];
        const on = mine && keys.includes(cur);
        const d = themeDef(live);
        const colour = d.name.replace(/^(AURORA|CLAUDE|FLINT|PEBBLE)\s*/, "");
        const vars = {
          "--a": d.pal.acc, "--k": d.pal.ask, "--g": d.pal.canvas, "--g2": d.pal.panel,
          "--g3": `color-mix(in oklab, ${d.pal.txg} 45%, ${d.pal.panel})`,
        } as CSSProperties;
        return (
          <div key={fam} className="ftcard" data-pv={fam} data-on={on || undefined} data-off={!keys.length || undefined}
            style={vars} onClick={keys.length ? () => onTheme(live) : undefined}>
            <div className="ftprev">
              <div className="sb"><i /><i /><i /><i /></div>
              <div className="ch"><div className="p" /><i /><i /><div className="bx"><u /></div></div>
            </div>
            <div className="ftmeta">
              <span className="d" />
              <div style={{ minWidth: 0 }}>
                <b>{FAMILY_NAME[fam]}</b>
                <span>{keys.length ? [colour && sentence(colour), FAMILY_TAG[fam]].filter(Boolean).join(" · ") : "a tube has no daylight."}</span>
              </div>
              {on && <em>Active</em>}
            </div>
            <div className="ftsq">
              {shown.map((k) => (
                <button key={k} title={sentence(themeDef(k).name)} data-on={cur === k || undefined} disabled={!keys.length}
                  style={{ background: swatchFill(k) }}
                  onClick={(e) => { e.stopPropagation(); onTheme(k); }} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The header styles, each a tiny header showing the time the way it would. */
function HeaderStyles({ settings, onHeader }: { settings: HudSettings; onHeader: (h: HeaderStyle) => void }) {
  const h12 = useClock12();
  const now = hhmm(Date.now() / 1000, h12);
  return (
    <div className="fthdr">
      {HEADER_STYLES.map((h) => (
        <label key={h} data-h={h} data-on={settings.headerStyle === h || undefined}>
          <button title={`header: ${h}`} onClick={() => onHeader(h)}><span>{now}</span></button>
          <small>{sentence(h)}</small>
        </label>
      ))}
    </div>
  );
}

/** THE GROUND. A swatch of each texture on the transcript's own canvas, with
 *  nothing on it. The tile used to carry a short turn so a ground would be
 *  judged with words over it — but the theme families draw DOSSIER with no turn
 *  card (index.css, "no turn card"), so the turn covered most of the tile and
 *  the texture it was there to show peeked out of the gaps. */
function ChatBgPicker({
  value,
  onPick,
}: {
  value: ChatBg;
  onPick: (b: ChatBg) => void;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 10 }}>
      {CHAT_BGS.map((o) => (
        <PickTile key={o.key} label={o.label} hint={o.hint} on={value === o.key} onPick={() => onPick(o.key)}>
          <div
            data-bg={o.key}
            style={{
              borderTop: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)",
              // The transcript's own ground, not a panel's: a preview of a texture on
              // the wrong surface is a preview of a different texture. backgroundColor
              // and not the `background` shorthand — the shorthand resets
              // background-image, which is the entire pattern.
              backgroundColor: "var(--canvas)",
              height: 96,
              width: "100%",
            }}
          />
        </PickTile>
      ))}
    </div>
  );
}

/** The chrome a tile wears: a name, a live badge, the one-line hint, and
 *  the well underneath. */
function PickTile({ label, hint, on, onPick, children }: {
  label: string;
  hint: string;
  on: boolean;
  onPick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onPick}
      aria-pressed={on}
      style={{
        appearance: "none",
        cursor: "pointer",
        textAlign: "left",
        fontFamily: "inherit",
        padding: 0,
        overflow: "hidden",
        // A button centres its content in whatever height the grid row
        // gives it; these have to start at the top or the tiles read as
        // several different layouts.
        display: "flex",
        flexDirection: "column",
        border: `1px solid ${on ? "var(--acc)" : "color-mix(in srgb, var(--acc) 14%, transparent)"}`,
        background: on ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "var(--panel3)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "8px 11px 7px" }}>
        <span style={{ flex: "none", fontSize: "var(--t10)", letterSpacing: 1.6, color: on ? "var(--txb)" : "var(--txh)" }}>
          {label}
        </span>
        {on && (
          <span style={{ flex: "none", fontSize: "var(--t7)", letterSpacing: 1, color: "var(--acc-on)", background: "var(--acc)", padding: "1px 5px" }}>
            ON
          </span>
        )}
        {/* The hint wraps rather than truncating: these are the sentence that
            tells the two quiet languages apart, and an ellipsis ate it. */}
        <span style={{ flex: 1, minWidth: 0, textAlign: "right", fontSize: "var(--t9)", color: "var(--txl)", lineHeight: 1.35 }}>
          {hint}
        </span>
      </div>
      {children}
    </button>
  );
}

function CrtToggles({
  settings,
  onToggle,
}: {
  settings: HudSettings;
  onToggle: (key: "scanlines" | "sweep" | "glow") => void;
}) {
  return (
    <div style={CARD}>
      {CRT_TOGGLES.map((g, i) => (
        <Row key={g.key} first={!i} label={g.label} desc={g.desc}>
          <Switch on={settings[g.key]} onClick={() => onToggle(g.key)} />
        </Row>
      ))}
    </div>
  );
}

/** A face's stack. Theme's is the family's own --ui-font, read off the root:
 *  the HUD container under it carries the picked face instead, and AURORA's
 *  theme face lives only in CSS (lib/theme FAMILY font ""). */
function faceStack(key: string, theme: ThemeKey): string {
  return fontStack(key, theme) || getComputedStyle(document.documentElement).getPropertyValue("--ui-font");
}

// Every stack in FONTS ends on its generic family, so that names the kind.
const faceKind = (stack: string) => (stack.endsWith("monospace") ? "Mono" : stack.endsWith("sans-serif") ? "Sans" : "Serif");

const SAMPLE_ASK = "why does the lightbox open on the wrong picture?";
const SAMPLE_ANSWER = "The strip counted pictures per turn, not per WORK zone, so the third zone opened on picture 0. "
  + "Fixed in `ImageLightbox.tsx:88`; reload to see it.\n\n"
  + "- **Cause:** the index restarted in every zone.\n- **Checked:** a 16-picture turn, in Chrome and in WebKit.";

/** A slice of your chat at a face and base size of its own, drawn by the
 *  transcript's own components inside DOSSIER's markup, so every family, your
 *  layout and your ground draw it the way they draw the chat. `.typepv`
 *  re-declares the type scale (index.css), so its --fs reaches every --t*
 *  inside; --ui-font is the face DOSSIER's prose reads (--d-face). Inert: a
 *  picture, not a turn. */
function TypePreview({ stack, size, settings }: { stack: string; size: number; settings: HudSettings }) {
  const now = Math.floor(Date.now() / 1000);
  return (
    <div className="typepv" inert data-bg={settings.chatBg} data-layout={settings.layout}
      style={{ "--fs": `${size}px`, "--ui-font": stack } as CSSProperties}>
      <div data-style="dossier" style={{ fontFamily: "var(--mono)", fontSize: "var(--t13)", lineHeight: 1.6 }}>
        <div className="dturn flex flex-col gap-2" data-last>
          <div className="dprompt"><PromptBubble text={SAMPLE_ASK} at={now - 126} n={1} /></div>
          <div className="dreply relative space-y-1.5">
            <div className="rstream space-y-2">
              <FinalResult result={SAMPLE_ANSWER} at={now} elapsed={126} tokens={41000} animate={false} idKey="typepv" dossier />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The typeface menu: every face set in itself, grouped by kind in two
 *  columns. A face under the pointer or the keyboard goes to onHover (the
 *  preview shows it); a click picks it. */
function FaceMenu({ value, theme, onPick, onHover }: {
  value: string;
  theme: ThemeKey;
  onPick: (key: string) => void;
  onHover: (key: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const shut = (refocus?: boolean) => {
    setOpen(false);
    onHover(null);
    if (refocus) box.current?.querySelector<HTMLElement>(".tp-pick")?.focus();
  };
  useEffect(() => {
    if (!open) return;
    // Start on the picked face, and bring the list into the pane: TYPE is the
    // page's last section, so the menu opens below the fold.
    const menu = box.current?.querySelector(".tp-menu");
    menu?.querySelector<HTMLElement>("[aria-selected=true]")?.focus({ preventScroll: true });
    menu?.scrollIntoView({ block: "nearest" });
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) shut(); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const own = FAMILY_FACE[family(theme)];
  const row = (f: (typeof FONTS)[number]) => (
    <button key={f.key} type="button" role="option" aria-selected={f.key === value} className="tp-row"
      style={{ fontFamily: faceStack(f.key, theme) }}
      onMouseEnter={() => onHover(f.key)} onFocus={() => onHover(f.key)}
      onClick={() => { onPick(f.key); shut(true); }}>
      <span className="tp-name">{f.label}</span>
      {!f.key && <small>{own}</small>}
      <span className="tp-ck">{f.key === value ? "✓" : ""}</span>
    </button>
  );
  const kind = (k: string) => FONTS.filter((f) => f.key && faceKind(f.stack) === k).map(row);
  const cur = FONTS.find((f) => f.key === value) ?? FONTS[0];
  return (
    <div ref={box} style={{ position: "relative" }}
      onKeyDown={(e) => {
        if (!open) return;
        if (e.key === "Escape") { e.stopPropagation(); shut(true); }   // the menu, not the dialog
        else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=option]")];
          const i = rows.indexOf(document.activeElement as HTMLElement) + (e.key === "ArrowDown" ? 1 : -1);
          rows[Math.max(0, Math.min(rows.length - 1, i))]?.focus();
        }
      }}
      // Tabbing out shuts it; a click elsewhere is the pointerdown above.
      onBlur={(e) => { if (open && e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) shut(); }}>
      <button type="button" className="tp-pick" aria-haspopup="listbox" aria-expanded={open} data-open={open || undefined}
        onClick={() => (open ? shut() : setOpen(true))}>
        <span className="tp-aa" style={{ fontFamily: faceStack(value, theme) }}>Aa</span>
        <span className="tp-name" style={{ fontFamily: faceStack(value, theme) }}>{cur.label}</span>
        {!value && <small>{own}</small>}
        <span className="tp-car">▾</span>
      </button>
      {open && (
        <div className="tp-menu" role="listbox" aria-label="Typeface" onMouseLeave={() => onHover(null)}>
          <div><div className="tp-gh">Follow the theme</div>{row(FONTS[0])}<div className="tp-gh">Sans</div>{kind("Sans")}</div>
          <div><div className="tp-gh">Serif</div>{kind("Serif")}<div className="tp-gh">Mono</div>{kind("Mono")}</div>
        </div>
      )}
    </div>
  );
}

/** THE TYPE section (drafts/type-settings, C · TWO MENUS): a strip of your
 *  chat at actual size over the typeface menu and a size stepper. The dialog
 *  never shows a size itself (it is fixed-size in every family), so the strip
 *  is where a size is judged; a face can be judged there before it is picked. */
function TypePicker({ settings, autoBase, onPatch }: {
  settings: HudSettings;
  autoBase: number;
  onPatch: (patch: Partial<HudSettings>) => void;
}) {
  const voice = useVoice();
  const [hover, setHover] = useState<string | null>(null);
  const face = hover ?? settings.font;
  const trying = hover !== null && hover !== settings.font;
  const size = settings.baseFont || autoBase;
  const steps = BASE_FONTS.filter((n) => n > 0);
  const up = steps.find((n) => n > size) ?? size;
  const down = [...steps].reverse().find((n) => n < size) ?? size;
  const name = face ? FONTS.find((f) => f.key === face)?.label : `Theme · ${FAMILY_FACE[family(settings.theme)]}`;
  return (
    <div style={CARD}>
      <div className="tp-bar">
        <span className="set-key" style={KEY_TX}>{voice("PREVIEW")}</span>
        <span className="set-desc" style={{ color: "var(--txd)" }}>{trying ? "previewing · click to use" : "actual size"}</span>
        <span className="tp-tag" data-trying={trying || undefined}>{name} · {settings.baseFont ? "" : "Auto "}{size}px</span>
      </div>
      <TypePreview stack={faceStack(face, settings.theme)} size={size} settings={settings} />
      <div style={LINE}>
        <Cell label="TYPEFACE" grow="2 1 240px">
          <FaceMenu value={settings.font} theme={settings.theme} onPick={(font) => onPatch({ font })} onHover={setHover} />
        </Cell>
        <Cell label="SIZE" grow="1 1 200px">
          <div className="tp-step" role="group" aria-label="Size">
            <button type="button" className="tp-auto" aria-pressed={!settings.baseFont}
              title={`follows the window — ${autoBase}px on this one`} onClick={() => onPatch({ baseFont: 0 })}>Auto</button>
            <button type="button" aria-label="Smaller" disabled={down === size} onClick={() => onPatch({ baseFont: down })}>−</button>
            <span className="tp-val">{size}<small>px</small></span>
            <button type="button" aria-label="Bigger" disabled={up === size} onClick={() => onPatch({ baseFont: up })}>+</button>
          </div>
        </Cell>
      </div>
    </div>
  );
}

/** What the bridge's own checkout is running, and the pull-and-restart button. */
function UpdatePanel({ onFeed }: { onFeed: (texts: string[], project?: string, fresh?: boolean) => void }) {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  useEffect(() => {
    let live = true;
    void api.update().then((u) => { if (live) setInfo(u); }).catch(() => { /* ignore */ });
    return () => { live = false; };
  }, []);

  return (
    <div style={CARD}>
      <Row first label="BRANCH">
        <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t11)", color: "var(--tx)" }}>
          {info ? `⎇ ${info.branch || "—"}` : "…"}
        </span>
      </Row>
      <Row label="UPSTREAM">
        <span style={{ fontSize: "var(--t105)", color: info && info.behind > 0 ? "var(--warn)" : "var(--ok)" }}>
          {!info ? "…" : info.behind > 0 ? `${info.behind} COMMIT${info.behind === 1 ? "" : "S"} BEHIND` : "UP TO DATE"}
        </span>
      </Row>
      {info && info.dirty > 0 && (
        <Row label="WORKING TREE">
          <span style={{ fontSize: "var(--t105)", color: "var(--warn)" }}>{info.dirty} UNCOMMITTED</span>
        </Row>
      )}
      <Row
        label="RESTART"
        info="The bridge runs the code it launched with. Anything already on disk — an edit, a setting that says it waits for a restart — takes effect on the next boot, and this is that boot without pulling anything."
      >
        <button onClick={() => void restartBridge()}
          style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--warn) 35%, transparent)", background: "transparent", color: "var(--warn)", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1.5, padding: "6px 12px", flex: "none" }}>
          RESTART BRIDGE
        </button>
      </Row>
      {info && info.behind > 0 && (
        <div style={{ marginTop: 12, display: "flex" }}>
          <UpdateButton onFeed={onFeed} />
        </div>
      )}
    </div>
  );
}

// ---- ACCOUNTS ---------------------------------------------------------------
// Multiple Claude logins + what happens when one hits its usage limit. Each
// account is a CLAUDE_CONFIG_DIR profile, so adding one means logging in with
// `claude /login` in a terminal first — we only snapshot what's on disk.

const POLICY_OPTS: { label: string; value: string }[] = [
  { label: "ASK", value: "ask" },
  { label: "AUTO", value: "auto" },
  { label: "WAIT", value: "wait" },
];

const POLICY_BLURB: Record<string, string> = {
  ask: "Offer the choices (other account · wait) and stay parked until you pick.",
  auto: "Take the best fallback immediately and report which one it landed on.",
  wait: "Only wait for the window to reset — the behaviour before the ladder existed.",
};

/** One setting's control, picked by its type. Text fields commit on blur or
 *  Enter rather than per keystroke, so a half-typed port never reaches the
 *  bridge. A secret shows its mask as the placeholder and only submits what you
 *  actually type — clearing it is what RESET is for. */
function EnvField({ s, busy, onSave }: {
  s: EnvSetting;
  busy: boolean;
  onSave: (v: string | number | boolean) => void;
}) {
  const secret = s.type === "secret";
  const [draft, setDraft] = useState(secret ? "" : String(s.value ?? ""));
  // The server answers with the whole list after every save, so a row can change
  // under a field that isn't being edited — follow it.
  useEffect(() => setDraft(secret ? "" : String(s.value ?? "")), [s.value, secret]);

  if (s.type === "bool")
    return <Switch on={!!s.value} onClick={() => (busy ? null : onSave(!s.value))} />;

  if (s.type === "enum")
    return (
      <select
        value={String(s.value ?? "")}
        disabled={busy}
        onChange={(e) => onSave(e.target.value)}
        style={{ ...field, maxWidth: 190 }}
      >
        {(s.choices ?? []).map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
    );

  const commit = () => {
    if (secret ? !draft : draft === String(s.value ?? "")) return;
    onSave(draft);
  };
  return (
    <input
      value={draft}
      disabled={busy}
      spellCheck={false}
      inputMode={s.type === "int" ? "numeric" : undefined}
      placeholder={secret ? String(s.value || "not set") : s.placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setDraft(secret ? "" : String(s.value ?? ""));
      }}
      style={{
        ...field,
        width: s.type === "int" ? 96 : 210,
        fontFamily: "'JetBrains Mono',monospace",
        textAlign: s.type === "int" ? "right" : "left",
      }}
    />
  );
}

/** Installing the dashboard as an app, and having it there when you log in.
 *
 *  Three switches for three different machines' worth of state, which is why they
 *  live together: the browser owns the install, systemd owns whether the bridge
 *  starts itself, and a launcher — a .cmd in the Windows Startup folder under WSL,
 *  a ~/.config/autostart entry otherwise — owns whether the window comes up with it. Turning login OFF never stops the running bridge — you are
 *  almost certainly talking to it. */
// ---- MAC APP / WINDOWS APP ---------------------------------------------------
// The switches the native app owns (macos/ MacPrefs.swift, windows/ Prefs.cs),
// read and written over its message handler (lib/mac) so the app has them before
// any page has loaded. One panel; the rows that are one platform's hide on the other.
const MAC_BTN: CSSProperties = {
  appearance: "none", cursor: "pointer",
  border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)",
  background: "transparent", color: "var(--acc)",
  fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1.5, padding: "6px 12px", flex: "none",
};

/** NOTIFY: what interrupts you, per kind of news, kept on the bridge
 *  (bridge/notices.py) because Telegram obeys the same choices; quiet hours;
 *  and this browser's own banner permission, sounds and volume. Everything
 *  lands in the bell whatever is picked here. */
const NOTIFY_ROWS: { head: string; ask?: boolean; rows: [string, string, string?][] }[] = [
  { head: "NEEDS YOU · always in the bell, pinned", ask: true, rows: [
    ["ask", "Approval or question", "a session's card, or a Rivendell run that paused for you"],
    ["asked", "Turn ended on a question"],
    ["rv_offer", "Rivendell offer", "a teammate's job that would run on your accounts"],
    ["account", "Login expired · limit choice"]] },
  { head: "SESSIONS", rows: [
    ["done", "Finished"],
    ["failed", "Failed", "with the reason: context full, API error, killed…"],
    ["parked", "Paused by the usage limit", "it resumes on its own at the reset"],
    ["resumed", "Resumed or retrying on its own", "after a restart, a limit reset, an API error or a sign-in; a Rivendell link back"],
    ["started", "Started elsewhere", "Telegram, Rivendell, a goal's next turn"]] },
  { head: "RIVENDELL", rows: [
    ["rv_held", "Job held behind running work", "it starts by itself; RUN IT TOO starts it now"],
    ["rv_done", "Job done", "PR review, implementation, todolist, changelog…"],
    ["rv_failed", "Job failed or refused"],
    ["rv_link", "Link broken · token refused"]] },
  { head: "PRs", rows: [["pr", "Checks failing · changes requested"]] },
  { head: "THE BRIDGE", rows: [["bridge", "MOVE finished"], ["weekly", "Weekly report"]] },
];
const SOUND_OPTS = ["none", ...Object.keys(TONES)] as ("none" | ToneKey)[];
const ROUTE_OPTS = ["off", "away", "always"] as const;

function NotifyPanel({ settings, onPatch }: { settings: HudSettings; onPatch: (p: Partial<HudSettings>) => void }) {
  const plugins = useIntegrations();   // Rivendell's rows only while it's installed
  const [prefs, setPrefs] = useState<NoticePrefs | null>(null);
  const [tg, setTg] = useState(true);
  const [old, setOld] = useState(false);   // a bridge started before the feed: the route 404s
  useEffect(() => {
    api.notices().then((r) => { setPrefs(r.prefs); setTg(r.telegram); }, () => setOld(true));
  }, []);
  const save = (p: NoticePrefsPatch) =>
    void api.noticePrefs(p).then((r) => setPrefs(r.prefs), (e: Error) => notify("error", e.message));
  const q = prefs?.quiet;
  return (
    <>
      <Section title="WHAT INTERRUPTS YOU">
        {old || !prefs ? (
          <div style={{ ...CARD, fontSize: "var(--t10)", color: "var(--txd)", lineHeight: 1.6 }}>
            {old ? "This bridge started before per-event notifications. Restart it to choose them here." : "Reading…"}
          </div>
        ) : (
          <div className="ntf-mxwrap">
            <table className="ntf-mx">
              <thead><tr><th>EVENT</th><th>POP UP</th><th>SOUND</th><th>TELEGRAM</th></tr></thead>
              <tbody>
                {NOTIFY_ROWS.filter((g) => g.head !== "RIVENDELL" || plugins.rivendell).map((g) => (
                  <Fragment key={g.head}>
                    <tr className="grp"><td colSpan={4} className={g.ask ? "ask" : undefined}>{g.head}</td></tr>
                    {g.rows.map(([key, label, desc]) => {
                      const r = prefs.events[key];
                      if (!r || (key === "rv_offer" && !plugins.rivendell)) return null;
                      return (
                        <tr key={key}>
                          <td><span className="ev">{label}{desc && <small>{desc}</small>}</span></td>
                          <td><button className={`ntf-ck${r.pop ? " on" : ""}`} role="checkbox" aria-checked={r.pop} aria-label={`${label}: pop up`}
                            onClick={() => save({ events: { [key]: { pop: !r.pop } } })}>{r.pop ? "✓" : ""}</button></td>
                          <td><select value={r.sound} aria-label={`${label}: sound`} style={{ ...field, padding: "3px 6px", letterSpacing: 0 }}
                            onChange={(e) => {
                              const sound = e.target.value as (typeof SOUND_OPTS)[number];
                              if (sound !== "none") chime(sound, settings.pushVolume);
                              save({ events: { [key]: { sound } } });
                            }}>
                            {SOUND_OPTS.map((t) => <option key={t} value={t}>{t === "none" ? "none" : TONES[t].label.toLowerCase()}</option>)}
                          </select></td>
                          <td><span className={`ntf-tg${tg ? "" : " off"}`}>
                            {ROUTE_OPTS.map((o) => (
                              <button key={o} className={r.tg === o ? `on${o === "always" ? " al" : ""}` : undefined} disabled={!tg}
                                onClick={() => save({ events: { [key]: { tg: o } } })}>{o}</button>
                            ))}
                          </span></td>
                        </tr>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
            <div className="ntf-mxnote">
              <b>Pop up</b> means a toast while a dashboard window has focus, and the system banner when none does — never both.{" "}
              <b>Away</b> means no click or keypress in any dashboard window for{" "}
              <select value={prefs.away_min} aria-label="away after" style={{ ...field, padding: "2px 4px", letterSpacing: 0 }}
                onChange={(e) => save({ away_min: Number(e.target.value) })}>
                {[2, 5, 10, 15, 30].map((m) => <option key={m} value={m}>{m} min</option>)}
              </select>.
              {!tg && <> Telegram pings are off in System ▸ Telegram, so that column waits.</>}
            </div>
          </div>
        )}
      </Section>

      {q && (
        <Section title="QUIET HOURS" top>
          <div style={CARD}>
            <Row first label="QUIET HOURS" desc={q.on ? `Nothing pops up, sounds or reaches Telegram from ${q.from} to ${q.to}.` : undefined}>
              <Switch on={q.on} onClick={() => save({ quiet: { on: !q.on } })} />
            </Row>
            {q.on && (
              <>
                <Row label="FROM · TO">
                  <input type="time" value={q.from} aria-label="quiet from" style={{ ...field, letterSpacing: 0 }}
                    onChange={(e) => e.target.value && save({ quiet: { from: e.target.value } })} />
                  <input type="time" value={q.to} aria-label="quiet to" style={{ ...field, letterSpacing: 0 }}
                    onChange={(e) => e.target.value && save({ quiet: { to: e.target.value } })} />
                </Row>
                <Row label="LET NEEDS YOU THROUGH" desc="An approval at 23:00 still reaches you.">
                  <Switch on={q.needs} onClick={() => save({ quiet: { needs: !q.needs } })} />
                </Row>
              </>
            )}
          </div>
        </Section>
      )}

      <Section title="THIS BROWSER" top>
        <div style={CARD}>
          <Row
            first
            label="OS NOTIFICATIONS"
            info={pushSupported()
              ? "The system banner for news that pops up while no dashboard window has focus. Telegram is set per event above."
              : "This browser has no Notification API — pop-ups stay inside the dashboard."}
          >
            <Switch
              on={settings.push}
              onClick={() => {
                if (settings.push) { onPatch({ push: false }); return; }
                // Ask only on switch-on; a denial can't be re-asked, so the
                // switch goes back off rather than sitting on and silent.
                void requestPush().then((ok) => onPatch({ push: ok }));
              }}
            />
          </Row>
          <Row label="SOUNDS" desc="Each event plays the tone picked above; off mutes them all here.">
            <Switch
              on={settings.pushSound}
              onClick={() => {
                // Switching it on plays one — otherwise you find out how loud it
                // is at the wrong moment.
                if (!settings.pushSound) chime(settings.pushTone, settings.pushVolume);
                onPatch({ pushSound: !settings.pushSound });
              }}
            />
          </Row>
          {settings.pushSound && (
            <Row label="VOLUME">
              {/* Preview when the drag ends, not on every step. */}
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}
                onPointerUp={() => chime(settings.pushTone, settings.pushVolume)}
                onKeyUp={() => chime(settings.pushTone, settings.pushVolume)}>
                <Volume value={settings.pushVolume} onChange={(pushVolume) => onPatch({ pushVolume })} />
              </div>
            </Row>
          )}
        </div>
      </Section>
    </>
  );
}

function MacPanel() {
  const mac = useMacSettings();
  const [busy, setBusy] = useState(false);
  const win = isWinApp();
  const appName = win ? "Mystical.exe" : "Mystical.app";
  const flip = (k: MacSwitch) => {
    if (!mac || busy) return;
    setBusy(true);
    void macSet(k, !mac[k]).finally(() => setBusy(false));
  };
  if (!mac) {
    return (
      <Section title={win ? "WINDOWS APP" : "MAC APP"} icon={win ? AppWindow : AppWindowMac} desc={`No answer from ${appName}.`}>
        <div style={{ ...CARD, color: "var(--txl)", fontSize: "var(--t11)", lineHeight: 1.5 }}>
          The app running this window predates these settings. Rebuild it from the{" "}
          {win ? "tray" : "menu bar"} (Rebuild App) or with <code>mystical app</code>, then reopen.
        </div>
      </Section>
    );
  }
  return (
    <>
      <Section title="WINDOW" icon={win ? AppWindow : AppWindowMac} desc="The one window, and what it says about itself.">
        <div style={CARD}>
          <Row
            first
            label="SESSION IN THE TITLE"
            desc={win
              ? "The taskbar and Alt-Tab name the open session instead of the app."
              : "Mission Control and the Window menu name the open session instead of the app."}
          >
            <Switch on={mac.titleFollowsSession} onClick={() => flip("titleFollowsSession")} />
          </Row>
          {mac.keepInDock !== undefined && (
            <Row
              label="KEEP IN DOCK"
              desc="The Dock icon stays while the window is closed, so ⌘-Tab and the Dock's Assign To Space keep working. Off: menu bar only, until you open it again."
            >
              <Switch on={mac.keepInDock} onClick={() => flip("keepInDock")} />
            </Row>
          )}
          {mac.hotkey !== undefined && (
            <Row
              label="SUMMON WITH WIN+CTRL+A"
              desc="A system-wide shortcut raises the dashboard from any app, and hides it again when it's already in front."
            >
              <Switch on={mac.hotkey} onClick={() => flip("hotkey")} />
            </Row>
          )}
        </div>
      </Section>
      <Section title="PANEL" icon={Pin} desc="Who is waiting, readable from any app." top>
        <div style={CARD}>
          <Row
            first
            label="WAITING ON YOU PANEL"
            desc={`A small always-on-top list of the sessions waiting on you, ${win ? "over every window" : "on every Space"}, while the dashboard isn't in front. Click a row to open that session.`}
          >
            <Switch on={mac.floating} onClick={() => flip("floating")} />
          </Row>
        </div>
      </Section>
      <Section title="APP" icon={Package} desc="The native shell itself." top>
        <div style={CARD}>
          <Row
            first
            label="VERSION"
            desc={`${appName} ${mac.version}. A bridge update doesn't rebuild the app — REBUILD does, from the checkout, and reopens it.`}
          >
            <button onClick={macRebuild} style={MAC_BTN}>REBUILD</button>
          </Row>
          <Row
            label="SCREEN CAPTURE"
            desc={win
              ? "A session can capture your screen, or one window, through the app (windows/capture.sh). Nothing to allow — Windows needs no permission for it."
              : "A session can capture your screen, or one window, through the app (macos/capture.sh). macOS asks for Screen Recording the first time: allow Mystical in System Settings, then quit and reopen the app."}
          />
        </div>
      </Section>
    </>
  );
}

function StartupSection() {
  const [st, setSt] = useState<StartupState | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const canInstall = useSyncExternalStore(subscribe, canInstallNow, () => false);
  const [installed, setInstalled] = useState(isInstalled);

  useEffect(() => {
    void api.startup().then(setSt).catch(() => setSt(null));
  }, []);

  // The toggles pass no profile and keep the current pin; the selector passes
  // its pick (null = back to the auto-guess).
  async function save(login: boolean, win: boolean, profile?: string | null) {
    setBusy(true);
    setErr(null);
    try {
      const pin = profile === undefined ? (st?.profile ?? null) : profile;
      setSt((await api.setStartup(login, win, pin)).startup);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="STARTUP"
      top
      info="Two separate things. Installing puts the dashboard in your Start Menu as its own window, with no tab strip or address bar — that is the browser's doing and it never leaves this machine. Starting at login is the bridge's: a systemd user unit brings it up (a launchd agent on a Mac, where OPEN THE WINDOW TOO opens Mystical.app — build it with `mystical app`; on Windows and Linux it also starts a tray icon with what's waiting on you), and under WSL — where nothing runs until Windows touches the distro — a small script in the Startup folder is what wakes it. Switching login off leaves the bridge you are using alone; it only stops the next boot from starting one."
    >
      <div style={CARD}>
        <Row
          first
          label="INSTALL AS APP"
          desc={
            installed
              ? "Installed — you are running it as an app."
              : canInstall
                ? "Opens your browser's install dialog."
                : "Your browser handles this from the address bar (Chromium browsers only)."
          }
        >
          <button
            disabled={installed || !canInstall}
            onClick={() => {
              void install().then((ok) => ok && setInstalled(true));
            }}
            style={{
              appearance: "none",
              cursor: installed || !canInstall ? "default" : "pointer",
              border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)",
              background: "transparent",
              color: installed || !canInstall ? "var(--txl)" : "var(--acc)",
              fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1.5,
              padding: "6px 12px", flex: "none",
            }}
          >
            {installed ? "INSTALLED" : "INSTALL"}
          </button>
        </Row>

        {st && !st.supported ? (
          <Row label="START AT LOGIN" desc={st.reason ?? "Not available on this machine."} />
        ) : (
          <>
            <Row
              label="START AT LOGIN"
              desc="Brings the bridge up on its own when you sign in."
            >
              <Switch
                on={!!st?.login}
                onClick={() => !busy && st && void save(!st.login, st.window)}
              />
            </Row>
            <Row
              label="OPEN THE WINDOW TOO"
              desc={
                st?.browser
                  ? `Opens the dashboard in ${st.browser} once the bridge answers.`
                  : "Opens the dashboard once the bridge answers."
              }
            >
              <Switch
                on={!!st?.window && !!st?.login}
                onClick={() => !busy && st?.login && void save(true, !st.window)}
              />
            </Row>
            {/* Absent `profiles` = a bridge older than the selector; hide the row. */}
            {!!st?.window && !!st?.login && !!st.profiles?.length && (
              <Row
                label="AS PROFILE"
                desc="Which browser profile the window opens in. AUTO guesses the one that visits the dashboard."
              >
                <select
                  value={st.profile ?? ""}
                  disabled={busy}
                  onChange={(e) => void save(true, true, e.target.value || null)}
                  style={{ ...field, flex: "none", maxWidth: 220 }}
                >
                  <option value="">AUTO</option>
                  {st.profiles.map((p) => (
                    <option key={p.dir} value={p.dir}>
                      {p.name === p.dir ? p.dir : `${p.name} — ${p.dir}`}
                    </option>
                  ))}
                </select>
              </Row>
            )}
          </>
        )}
      </div>

      {/* A bridge that escaped its unit looks perfectly healthy — it just has
          nothing watching it any more, so it is worth saying out loud. */}
      {st?.login && !st.supervised && (
        <div style={NOTE}>
          This bridge was started by hand, so nothing restarts it if it dies. The unit takes
          over at the next boot, or now with{" "}
          <code>systemctl --user restart mystical-assistant</code>, which ends the sessions
          running here.
        </div>
      )}
      {err && <div style={{ ...NOTE, color: "var(--bad, #ff6b6b)" }}>{err}</div>}
    </Section>
  );
}

/** The rest of bridge/config.py, which until now needed a text editor and a
 *  restart to reach. Same precedence as the AI tab: what you set here beats
 *  .env, and RESET puts a row back to whatever .env said rather than to a
 *  hardcoded default — so the file stays the floor under all of this. */
function EnvPanel() {
  const [rows, setRows] = useState<EnvSetting[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Which row was refused, and why. A rejection belongs beside the field that
  // caused it — at the foot of eight scrolling blocks nobody sees it.
  const [err, setErr] = useState<{ key: string; message: string } | null>(null);
  const ai = useAiFeatures();   // AI TUNING rows go with the switch they tune

  useEffect(() => {
    void api.envSettings().then((r) => setRows(r.settings)).catch(() => setRows([]));
  }, []);

  async function save(key: string, value: string | number | boolean | null) {
    setBusy(key);
    setErr(null);
    try {
      setRows((await api.setEnvSetting(key, value)).settings);
    } catch (e) {
      setErr({ key, message: e instanceof Error ? e.message : "could not save" });
    } finally {
      setBusy(null);
    }
  }

  if (rows === null) return <Placeholder icon={LoaderCircle} spin>Reading the environment registry…</Placeholder>;
  if (!rows.length)
    return <Placeholder icon={TriangleAlert}>This bridge is running a build without the settings registry. Restart it.</Placeholder>;

  const shown = rows.filter((r) => !tunesOff(r.key, ai));
  const groups = [...new Set(shown.map((r) => r.group))];
  const pending = rows.some((r) => r.source === "saved" && !r.live);

  return (
    <>
      {groups.map((g, gi) => (
        <Section
          key={g}
          title={g}
          top
          info={
            gi === 0
              ? "Everything here used to live only in .env, where only whoever deployed this bridge could reach it. A value set here is written beside the session store and layered over that file — it never rewrites it — so RESET always has somewhere to fall back to. Most apply to the next turn; the ones that bind a port, open the database or authenticate the bot say so and wait for a restart."
              : undefined
          }
        >
          <div style={CARD}>
            {shown.filter((r) => r.group === g).map((s, i) => {
              const desc = (
                <>
                  {s.hint}
                  {s.unit && <span style={{ color: "var(--txd)" }}> · {s.unit}</span>}
                  {!s.live && <span style={{ color: "var(--txd)" }}> · next start</span>}
                  {s.source === "saved" && (
                    <>
                      {" · "}
                      <button
                        onClick={() => void (busy ? null : save(s.key, null))}
                        style={{
                          appearance: "none", cursor: "pointer", border: 0, background: "transparent",
                          color: "var(--acc)", font: "inherit", fontSize: "var(--t95)", padding: 0,
                        }}
                      >
                        RESET TO .ENV
                      </button>
                    </>
                  )}
                  {err?.key === s.key && (
                    <div style={{ color: "var(--err)", marginTop: 4 }}>{err.message}</div>
                  )}
                </>
              );
              // A long prompt needs the width of the card, so it drops under its
              // own label instead of sharing the line.
              if (s.type === "text")
                return (
                  <div
                    key={s.key}
                    style={{ marginTop: i ? 11 : 0, paddingTop: i ? 11 : 0, borderTop: i ? RULE : undefined }}
                  >
                    <Row first label={s.label} desc={desc} info={s.about} />
                    <textarea
                      defaultValue={String(s.value ?? "")}
                      key={String(s.value ?? "")}
                      disabled={busy === s.key}
                      spellCheck={false}
                      rows={5}
                      onBlur={(e) => e.target.value !== String(s.value ?? "") && void save(s.key, e.target.value)}
                      style={{ ...field, width: "100%", marginTop: 8, resize: "vertical", lineHeight: 1.6, letterSpacing: 0 }}
                    />
                  </div>
                );
              return (
                <Row key={s.key} first={!i} label={s.label} desc={desc} info={s.about}>
                  <EnvField s={s} busy={busy === s.key} onSave={(v) => void save(s.key, v)} />
                </Row>
              );
            })}
          </div>
        </Section>
      ))}
      {pending && (
        <div style={NOTE}>
          Something saved here binds a port, opens the database or authenticates the bot — it is
          stored, and the next start picks it up. PLATFORM below restarts the bridge.
        </div>
      )}
    </>
  );
}

/* TRACKERS — the Teamwork / Jira connections (bridge/trackers.py). What exists
   on the machine; which repo uses which lives in ANALYZE, beside the repo. */
const KIND_LABEL = { teamwork: "TEAMWORK", jira: "JIRA" } as const;

function TrackersPanel({ onChange }: { onChange?: () => void }) {   // onChange: a connection was added or removed
  const [rows, setRows] = useState<TrackerConnection[] | null>(null);
  const [gone, setGone] = useState(false);     // an old bridge: the route 404s
  const [kind, setKind] = useState<"teamwork" | "jira">("teamwork");
  const [name, setName] = useState("");
  const [site, setSite] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [hov, setHov] = useState("");
  const hp = (k: string) => ({ onMouseEnter: () => setHov(k), onMouseLeave: () => setHov("") });

  useEffect(() => {
    void api.trackers().then((r) => setRows(r.connections)).catch(() => { setRows([]); setGone(true); });
  }, []);

  async function add() {
    setBusy(true);
    setErr("");
    try {
      const r = await api.addTracker({ kind, name, site, email: kind === "jira" ? email : undefined, token });
      setRows((p) => [...(p ?? []), r.connection].sort((a, b) => a.name.localeCompare(b.name)));
      setName(""); setSite(""); setEmail(""); setToken("");
      onChange?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not connect");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try {
      await api.removeTracker(id);
      setRows((p) => (p ?? []).filter((c) => c.id !== id));
      onChange?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not remove");
    }
  }

  if (rows === null) return <Placeholder icon={LoaderCircle} spin>Reading the tracker connections…</Placeholder>;
  if (gone) return <Placeholder icon={TriangleAlert}>This bridge is running a build without trackers. Restart it.</Placeholder>;

  const btn = (k: string, on: boolean): CSSProperties => ({
    appearance: "none", cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1.5,
    padding: "6px 12px", flex: "none",
    border: `1px solid ${on ? "var(--acc)" : "color-mix(in srgb, var(--acc) 25%, transparent)"}`,
    background: on ? "color-mix(in srgb, var(--acc) 14%, transparent)" : hov === k ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent",
    color: on ? "var(--txb)" : "var(--txm)",
  });

  return (
    <>
      {rows.length > 0 && (
        <div style={CARD}>
          {rows.map((c, i) => (
            <Row key={c.id} first={!i}
              label={<span>{c.name} <span style={{ color: "var(--txd)", letterSpacing: 1 }}>· {KIND_LABEL[c.kind]}</span></span>}
              desc={
                <>
                  <span style={{ fontFamily: "'JetBrains Mono',monospace" }}>{c.site}</span>
                  {c.me && <> · as {c.me}</>}
                  {" · token "}<span style={{ fontFamily: "'JetBrains Mono',monospace" }}>{c.token}</span>
                  <div style={{ marginTop: 4, color: c.mcp ? "var(--txd)" : "var(--warn)" }}>
                    {c.mcp
                      ? <>MCP entry <span style={{ fontFamily: "'JetBrains Mono',monospace" }}>{c.mcp_server}</span> ready — updates can post</>
                      : <>MCP entry <span style={{ fontFamily: "'JetBrains Mono',monospace" }}>{c.mcp_server}</span> missing — updates cannot post until you run{" "}
                          <code style={{ fontFamily: "'JetBrains Mono',monospace", userSelect: "all" }}>{c.mcp_cmd}</code>
                          {" "}and sign in once{c.kind === "jira" ? " (a private window for a different Atlassian account)" : ""}.</>}
                  </div>
                </>
              }
            >
              <button onClick={() => void remove(c.id)} {...hp(`rm:${c.id}`)}
                style={{ appearance: "none", cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1.5, padding: "6px 12px", flex: "none", border: "1px solid color-mix(in srgb, var(--err) 30%, transparent)", background: hov === `rm:${c.id}` ? "color-mix(in srgb, var(--err) 10%, transparent)" : "transparent", color: "var(--err)" }}>
                REMOVE
              </button>
            </Row>
          ))}
        </div>
      )}
      <div style={{ ...CARD, marginTop: rows.length ? 11 : 0 }}>
        <Row first label="ADD A CONNECTION"
          desc={kind === "teamwork"
            ? "Your API key: Teamwork ▸ profile ▸ Edit My Details ▸ API & Mobile. Site is your Teamwork address."
            : "An Atlassian API token (id.atlassian.com ▸ Security ▸ API tokens) with the account email it belongs to. Site is the atlassian.net address; a scoped token works too."}>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => setKind("teamwork")} {...hp("k:tw")} style={btn("k:tw", kind === "teamwork")}>TEAMWORK</button>
            <button onClick={() => setKind("jira")} {...hp("k:jira")} style={btn("k:jira", kind === "jira")}>JIRA</button>
          </div>
        </Row>
        <div style={LINE}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name (e.g. ACME)" spellCheck={false}
            style={{ ...field, flex: "1 1 140px" }} />
          <input value={site} onChange={(e) => setSite(e.target.value)} spellCheck={false}
            placeholder={kind === "teamwork" ? "acme.teamwork.com" : "acme.atlassian.net"}
            style={{ ...field, flex: "2 1 200px", fontFamily: "'JetBrains Mono',monospace", letterSpacing: 0 }} />
        </div>
        <div style={LINE}>
          {kind === "jira" && (
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="account email" spellCheck={false}
              style={{ ...field, flex: "1 1 180px", letterSpacing: 0 }} />
          )}
          <input value={token} onChange={(e) => setToken(e.target.value)} type="password" placeholder={kind === "teamwork" ? "API key" : "API token"}
            style={{ ...field, flex: "2 1 200px", fontFamily: "'JetBrains Mono',monospace", letterSpacing: 0 }} />
          <button onClick={() => void add()} disabled={busy || !site.trim() || !token.trim() || (kind === "jira" && !email.trim())}
            {...hp("add")}
            style={{ ...btn("add", false), border: "1px solid var(--acc)", color: "var(--txb)", opacity: busy ? 0.6 : 1 }}>
            {busy ? "TESTING…" : "TEST & ADD"}
          </button>
        </div>
        {err && <div style={{ fontSize: "var(--t95)", color: "var(--err)", marginTop: 8 }}>{err}</div>}
      </div>
    </>
  );
}

/* INTEGRATIONS ▸ RIVENDELL — the rivendell-api connections the PR-review plugin runs
   (bridge/rivendell_instances.py). One bridge, several Rivendells: a production
   dashboard, a local one, staging later. Each is an independent websocket
   worker with its own URL, token, model and workdir; a run it makes is tagged
   with which one it came from (origin "rivendell:<name>"). What existed as one
   flat RIVENDELL_* block under SYSTEM until this became a keyed collection. */

function riToInput(c: RivendellInstance): RivendellInput {
  return {
    name: c.name, enable: c.enable, api_url: c.api_url, token: "",
    ws_url: c.ws_url, model: c.model, workdir: c.workdir,
    review_timeout: c.review_timeout, impl_timeout: c.impl_timeout,
    share_device: c.share_device, device_token: "",
  };
}

/** The colour + label the status pip shows for one instance's live socket. */
export function riStatusView(s?: RivendellStatus) {
  switch (s?.state) {
    case "connected": return { color: "var(--ok)", label: "CONNECTED", glow: true };
    case "connecting": return { color: "var(--warn)", label: "CONNECTING…", glow: false };
    case "error": return { color: "var(--err)", label: "DISCONNECTED", glow: false };
    case "auth_error": return { color: "var(--err)", label: "TOKEN REJECTED", glow: false };
    default: return { color: "var(--txd)", label: "OFF", glow: false };
  }
}

function InstanceForm({ initial, busy, err, onSubmit, onCancel }: {
  initial?: RivendellInstance;   // present when editing; absent for a new one
  busy: boolean;
  err: string;
  onSubmit: (v: RivendellInput) => void;
  onCancel?: () => void;
}) {
  const editing = !!initial;
  const [name, setName] = useState(initial?.name ?? "");
  const [apiUrl, setApiUrl] = useState(initial?.api_url ?? "");
  const [token, setToken] = useState("");     // blank when editing = keep stored
  const [model, setModel] = useState(initial?.model ?? "opus");
  const [workdir, setWorkdir] = useState(initial?.workdir ?? "");
  const [review, setReview] = useState(String(initial?.review_timeout ?? 3600));
  const [impl, setImpl] = useState(String(initial?.impl_timeout ?? 10800));
  const [enable, setEnable] = useState(initial?.enable ?? true);
  const [hov, setHov] = useState("");
  const hp = (k: string) => ({ onMouseEnter: () => setHov(k), onMouseLeave: () => setHov("") });

  const canSave = !!name.trim() && !!apiUrl.trim() && (editing || !!token.trim());
  const submit = () => onSubmit({
    name: name.trim(), enable, api_url: apiUrl.trim(), token: token.trim(),
    model: model.trim() || "opus", workdir: workdir.trim(),
    review_timeout: Number(review) || 3600, impl_timeout: Number(impl) || 10800,
  });
  const mono = { ...field, fontFamily: "'JetBrains Mono',monospace", letterSpacing: 0 } as CSSProperties;
  const btn = (k: string, primary: boolean): CSSProperties => ({
    appearance: "none", cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1.5,
    padding: "6px 12px", flex: "none",
    border: `1px solid ${primary ? "var(--acc)" : "color-mix(in srgb, var(--acc) 25%, transparent)"}`,
    background: hov === k ? "color-mix(in srgb, var(--acc) 10%, transparent)" : "transparent",
    color: primary ? "var(--txb)" : "var(--txm)", opacity: busy ? 0.6 : 1,
  });

  return (
    <div style={{ ...CARD, marginTop: 11 }}>
      <Row first label={editing ? `EDIT · ${initial!.name}` : "ADD AN INSTANCE"}
        desc={editing
          ? "A blank token keeps the one stored. Saving reconnects this instance with the new settings."
          : "Point it at a rivendell-api base URL with a token minted there (Profile ▸ Tokens, LLM capability). It runs reviews autonomously, so only add an API you own."}>
        <Switch on={enable} onClick={() => setEnable(!enable)} />
      </Row>
      <div style={LINE}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name (e.g. production)" spellCheck={false}
          style={{ ...field, flex: "1 1 140px" }} />
        <input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="http://localhost:3001" spellCheck={false}
          style={{ ...mono, flex: "2 1 220px" }} />
      </div>
      <div style={LINE}>
        <input value={token} onChange={(e) => setToken(e.target.value)} type="password"
          placeholder={editing ? `token ${initial!.token || "set"} — blank keeps it` : "rvd_… bearer token"}
          style={{ ...mono, flex: "2 1 220px" }} />
      </div>
      <div style={LINE}>
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="model (opus)" spellCheck={false}
          style={{ ...field, flex: "1 1 120px" }} />
        <input value={workdir} onChange={(e) => setWorkdir(e.target.value)} placeholder="workdir (optional; falls back to BASE_PATH)" spellCheck={false}
          style={{ ...mono, flex: "2 1 220px" }} />
      </div>
      <div style={LINE}>
        <input value={review} onChange={(e) => setReview(e.target.value)} inputMode="numeric" placeholder="review timeout (s)"
          style={{ ...field, flex: "1 1 120px", textAlign: "right" }} />
        <input value={impl} onChange={(e) => setImpl(e.target.value)} inputMode="numeric" placeholder="impl timeout (s)"
          style={{ ...field, flex: "1 1 120px", textAlign: "right" }} />
        <span style={{ flex: 1 }} />
        {onCancel && <button onClick={onCancel} {...hp("cancel")} style={btn("cancel", false)}>CANCEL</button>}
        <button onClick={submit} disabled={busy || !canSave} {...hp("save")} style={btn("save", true)}>
          {busy ? "SAVING…" : editing ? "SAVE" : "ADD"}
        </button>
      </div>
      {err && <div style={{ fontSize: "var(--t95)", color: "var(--err)", marginTop: 8 }}>{err}</div>}
    </div>
  );
}

function RivendellPanel({ onChange }: { onChange?: () => void }) {   // onChange: an instance was saved, switched or removed
  const [rows, setRows] = useState<RivendellInstance[] | null>(null);
  const [video, setVideo] = useState<VideoTools>();   // absent on a bridge older than the VIDEO JOBS row
  const [gone, setGone] = useState(false);     // an old bridge: the route 404s
  const [editing, setEditing] = useState<string | null>(() => takeSettingsFocus());   // instance id, "new", or null
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [hov, setHov] = useState("");
  const hp = (k: string) => ({ onMouseEnter: () => setHov(k), onMouseLeave: () => setHov("") });
  // TEST LINK: a ping/pong round trip on the live socket, or a re-dial of a
  // parked token (bridge/rivendell.py Worker.test_link). The row keeps the last.
  const [testing, setTesting] = useState("");
  async function test(id: string, job: boolean) {
    setTesting(id); setErr("");
    try {
      const r = await api.rivendellTest(id, job);
      setRows((p) => (p ?? []).map((x) => (x.id === id ? { ...x, status: { ...x.status, last_test: r } } : x)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not test");
    } finally {
      setTesting("");
    }
  }

  useEffect(() => {
    void api.rivendell().then((r) => { setRows(r.instances); setVideo(r.video); }).catch(() => { setRows([]); setGone(true); });
  }, []);

  // The socket goes up and down on its own (reconnect-forever with backoff), so
  // poll for the live status while the panel is open. A save/remove is skipped
  // (busy) so the poll can't clobber its optimistic result mid-flight.
  useEffect(() => {
    const t = setInterval(() => {
      if (busy) return;
      void api.rivendell().then((r) => { setRows(r.instances); setVideo(r.video); }).catch(() => {});
    }, 4000);
    return () => clearInterval(t);
  }, [busy]);

  const byName = (a: RivendellInstance, b: RivendellInstance) => a.name.localeCompare(b.name);
  const upsert = (inst: RivendellInstance) =>
    setRows((p) => {
      const rest = (p ?? []).filter((x) => x.id !== inst.id);
      return [...rest, inst].sort(byName);
    });

  async function save(input: RivendellInput, id: string | null) {
    setBusy(true); setErr("");
    try {
      const r = id && id !== "new"
        ? await api.updateRivendell(id, input)
        : await api.addRivendell(input);
      upsert(r.instance);
      setEditing(null);
      onChange?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not save");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(inst: RivendellInstance) {
    setErr("");
    try {
      const r = await api.updateRivendell(inst.id, { ...riToInput(inst), enable: !inst.enable });
      upsert(r.instance);
      onChange?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not save");
    }
  }

  async function remove(id: string) {
    try {
      await api.removeRivendell(id);
      setRows((p) => (p ?? []).filter((c) => c.id !== id));
      if (editing === id) setEditing(null);
      onChange?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not remove");
    }
  }

  if (rows === null) return <Placeholder icon={LoaderCircle} spin>Reading the rivendell instances…</Placeholder>;
  if (gone) return <Placeholder icon={TriangleAlert}>This bridge is running a build without the rivendell plugin. Restart it.</Placeholder>;

  const dim = { color: "var(--txd)" };
  const mono = { fontFamily: "'JetBrains Mono',monospace" };
  const missing = video ? [!video.ffmpeg && "ffmpeg", !video.whisper && "whisper-cli", !video.model && "model file"].filter(Boolean) : [];

  // Its heading — title, blurb, ⓘ — is the Rivendell card's on the INTEGRATIONS page.
  return (
    <>
      {(rows.length > 0 || video) && (
        <div style={CARD}>
          {rows.map((c, i) => {
            const sv = riStatusView(c.status);
            const st = c.status?.state ?? "off";
            const jobs = !!c.status?.features?.includes("ping");
            return (
            <Fragment key={c.id}>
              <Row first={!i}
                label={<span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span>{c.name}</span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
                    title={c.status?.detail || sv.label}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: sv.color, flex: "none",
                      boxShadow: sv.glow ? `0 0 6px ${sv.color}` : undefined }} />
                    <span style={{ fontSize: "var(--t85)", letterSpacing: 1, color: sv.color }}>{sv.label}</span>
                  </span>
                  <span style={{ ...dim, ...mono, letterSpacing: 0 }}>· {c.origin}</span>
                </span>}
                desc={
                  <>
                    <span style={mono}>{c.api_url}</span>
                    {" · "}model <span style={mono}>{c.model}</span>
                    {" · token "}<span style={mono}>{c.token || "not set"}</span>
                    {st === "connected" && c.status?.last_event_at
                      ? <> · last request {ago(c.status.last_event_at)} ago</>
                      : null}
                    {st === "error" && c.status?.detail
                      ? <div style={{ marginTop: 4, color: "var(--err)" }}>reconnecting — {c.status.detail}</div>
                      : null}
                    {st === "auth_error"
                      ? <div style={{ marginTop: 4, color: "var(--err)" }}>
                          token rejected — not reconnecting until you change it{c.status?.detail ? <> · {c.status.detail}</> : null}
                        </div>
                      : null}
                    <div style={{ marginTop: 4, ...dim }}>
                      workdir <span style={mono}>{c.workdir || "BASE_PATH"}</span>
                      {" · review "}{c.review_timeout}s · impl {c.impl_timeout}s
                    </div>
                    <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ ...dim, letterSpacing: 1.5 }}>TEST</span>
                      <span style={{ color: c.status?.last_test?.ok ? "var(--ok)" : c.status?.last_test?.ok === false ? "var(--err)" : "var(--txl)" }}>
                        {testText(c.status?.last_test)}
                        {c.status?.last_test
                          ? <span style={dim}> · {new Date(c.status.last_test.at * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                          : null}
                      </span>
                      <button disabled={st === "off" || testing === c.id} onClick={() => void test(c.id, jobs)} {...hp(`ts:${c.id}`)}
                        style={{ appearance: "none", cursor: st === "off" ? "default" : "pointer", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1.5, padding: "4px 10px", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: hov === `ts:${c.id}` ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent", color: "var(--txm)", opacity: st === "off" ? 0.4 : 1 }}>
                        {testing === c.id ? "TESTING…" : jobs ? "SEND TEST JOB" : "TEST LINK"}
                      </button>
                    </div>
                  </>
                }
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "none" }}>
                  <Switch on={c.enable} onClick={() => void toggle(c)} />
                  <button onClick={() => setEditing(editing === c.id ? null : c.id)} {...hp(`ed:${c.id}`)}
                    style={{ appearance: "none", cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1.5, padding: "6px 12px", flex: "none", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: hov === `ed:${c.id}` ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent", color: "var(--txm)" }}>
                    {editing === c.id ? "CLOSE" : "EDIT"}
                  </button>
                  <button onClick={() => void remove(c.id)} {...hp(`rm:${c.id}`)}
                    style={{ appearance: "none", cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1.5, padding: "6px 12px", flex: "none", border: "1px solid color-mix(in srgb, var(--err) 30%, transparent)", background: hov === `rm:${c.id}` ? "color-mix(in srgb, var(--err) 10%, transparent)" : "transparent", color: "var(--err)" }}>
                    REMOVE
                  </button>
                </div>
              </Row>
              {editing === c.id && (
                <InstanceForm initial={c} busy={busy} err={err}
                  onSubmit={(v) => void save(v, c.id)} onCancel={() => setEditing(null)} />
              )}
            </Fragment>
            );
          })}
          {video && (
            <Row first={!rows.length} label="VIDEO JOBS"
              desc="A client's recording, transcribed and framed on this machine: ffmpeg · whisper-cli · the model file">
              <MoveChip c={missing.length ? [`MISSING: ${missing.join(" · ")}`, "var(--err)"] : ["FOUND", "var(--ok)"]} />
            </Row>
          )}
        </div>
      )}
      {editing === "new" ? (
        <InstanceForm busy={busy} err={err}
          onSubmit={(v) => void save(v, null)} onCancel={() => setEditing(null)} />
      ) : (
        <button onClick={() => { setErr(""); setEditing("new"); }}
          {...hp("add")}
          style={{ appearance: "none", cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1.5, padding: "8px 14px", marginTop: 11, border: "1px solid var(--acc)", background: hov === "add" ? "color-mix(in srgb, var(--acc) 10%, transparent)" : "transparent", color: "var(--txb)" }}>
          + ADD AN INSTANCE
        </button>
      )}
      {err && editing === null && <div style={{ fontSize: "var(--t95)", color: "var(--err)", marginTop: 8 }}>{err}</div>}
    </>
  );
}

/* INTEGRATIONS — the bundled plugins (bridge/integrations.py). One that isn't
   installed has no tab, card, row or worker anywhere else, so this page is the
   one place it shows: a card per installed plugin with its settings inside and
   REMOVE at its head, then the rest, each with INSTALL. Titled by search's
   INDEX names, so a hit lands on the card. */
const PLUGIN_SEC: Record<string, string> = { rivendell: "RIVENDELL", trackers: "TRACKERS", design: "CLAUDE DESIGN" };
const PLUGIN_INFO: Record<string, string> = {
  rivendell: "Each instance holds a websocket open to a rivendell-api /agent endpoint and runs every request it sends with full autonomy (bypassPermissions) in its own workdir, so only connect an API you own. The token is minted in that Rivendell (Profile ▸ Tokens, LLM capability), kept beside the session store (mode 0600) and never shown again in full; revoke it there if it leaks. Runs appear in the session list tagged with the instance name. The first instance is seeded from your .env RIVENDELL_* values; edit or add more here — a save reconnects without a restart.",
  trackers: "The token is kept beside the session store (mode 0600), sent only to the tracker's own API, and never shown again in full. Reading — the TASKS tab, the first-turn digest, NEXT UP — is the bridge's own HTTP and spends no model call. Writing goes through the session: its claude turn gets the tracker's MCP server for that turn only, in manual mode, with an ask rule on the whole server, so every comment and status change shows an Allow card with the full text before it posts. Teamwork's MCP entry is shared; each Jira site needs its own (Atlassian's login is per site) — the row says how to add it.",
};
// AVAILABLE's cards. Trackers is two, Teamwork and Jira, both installing it;
// the other two say what the registry says.
const OFFERS: { id: string; chip: string; color: string; name?: string; hint?: string; needs?: string }[] = [
  { id: "rivendell", chip: "RV", color: "var(--ok)" },
  { id: "trackers", chip: "TW", color: "var(--purple)", name: "Teamwork", needs: "API key",
    hint: "A repo linked to a Teamwork project opens every session with what is open and overdue; TASKS tab, LINK TASKS, updates posted through the run." },
  { id: "trackers", chip: "JR", color: "var(--info)", name: "Jira", needs: "API token",
    hint: "The same, against an Atlassian site: one connection per site, an API token and the account it belongs to." },
  { id: "design", chip: "CD", color: "var(--warn)" },
];

function IntegrationsPanel() {
  const [list, setList] = useState<Integration[] | null>(null);
  const [down, setDown] = useState("");   // why the list can't be read; "not found" is a bridge from before integrations
  const [busy, setBusy] = useState("");   // the plugin being installed or removed
  const [err, setErr] = useState<{ id: string; msg: string } | null>(null);   // shown on the card it belongs to
  const [digest, setDigest] = useState<AiFeature>();   // TASK DIGEST: the aifeatures switch `tasks`

  // Every answer also goes to the shared store, so the tabs and buttons a
  // plugin brings appear or leave in the same frame.
  const take = (plugins: Integration[]) => { setList(plugins); setIntegrations(plugins); };
  // A card's panel changed what its summary counts (instances, connections).
  const recount = () => void api.integrations().then((r) => take(r.plugins)).catch(() => {});

  useEffect(() => {
    void api.integrations().then((r) => take(r.plugins))
      .catch((e) => setDown(e instanceof Error ? e.message : "could not read the integrations"));
    void api.aiFeatures().then((r) => { setDigest(r.features.find((f) => f.key === "tasks")); setAiFeatures(r.features); })
      .catch(() => {});
  }, []);

  async function set(id: string, action: "install" | "remove") {
    setBusy(id); setErr(null);
    try {
      take((await api.setIntegration(id, action)).plugins);
    } catch (e) {
      // A refused REMOVE (a Rivendell run in flight) is a 409 that says why.
      setErr({ id, msg: e instanceof Error ? e.message : `could not ${action}` });
    } finally {
      setBusy("");
    }
  }

  async function remove(p: Integration) {
    if (await askConfirm(`Remove ${p.label}? Its tabs, buttons and worker go; its connections stay on disk, so installing it again restores them.`))
      await set(p.id, "remove");
  }

  async function toggleDigest(f: AiFeature) {
    setErr(null);
    try {
      const fresh = (await api.setAiFeature("tasks", !f.enabled)).features;
      setDigest(fresh.find((x) => x.key === "tasks"));
      setAiFeatures(fresh);
    } catch (e) {
      setErr({ id: "tasks", msg: e instanceof Error ? e.message : "could not save" });
    }
  }

  if (down === "not found")
    return <Placeholder icon={TriangleAlert}>This bridge is running code from before integrations. Restart it to install or remove one.</Placeholder>;
  if (down) return <Placeholder icon={TriangleAlert}>{down}</Placeholder>;
  if (!list) return <Placeholder icon={LoaderCircle} spin>Reading the integrations…</Placeholder>;

  const installed = list.filter((p) => p.installed);
  const offers = OFFERS.filter((o) => list.some((p) => p.id === o.id && !p.installed));
  const errLine = (id: string) => (err?.id === id ? <div style={{ color: "var(--err)", marginTop: 4 }}>{err.msg}</div> : undefined);

  return (
    <>
      {installed.map((p, i) => (
        <Section key={p.id} title={PLUGIN_SEC[p.id] ?? p.label} desc={p.blurb} info={PLUGIN_INFO[p.id]} top={i > 0}>
          <div style={CARD}>
            <Row first label={p.summary}
              desc={p.id === "design"
                ? <>Adds ANALYZE ▸ DESIGN (link · pull · sync), the composer's DESIGN button and the project menu's Design system. A repo is linked from ANALYZE ▸ DESIGN.{errLine(p.id)}</>
                : errLine(p.id)}>
              <MiniBtn danger disabled={!!busy} onClick={() => void remove(p)} title={`Remove ${p.label}`}>REMOVE</MiniBtn>
            </Row>
            {p.id === "trackers" && digest && (
              <Row label="TASK DIGEST" desc={<>{digest.hint}{errLine("tasks")}</>} info={digest.about}>
                <Switch on={digest.enabled} onClick={() => void toggleDigest(digest)} label="Task digest" />
              </Row>
            )}
          </div>
          {p.id === "rivendell" && <div style={{ marginTop: 11 }}><RivendellPanel onChange={recount} /><DeviceRunsPanel /></div>}
          {p.id === "trackers" && <div style={{ marginTop: 11 }}><TrackersPanel onChange={recount} /></div>}
        </Section>
      ))}
      <Section title="AVAILABLE" top={installed.length > 0}
        desc={offers.length ? "Install one to connect it. Nothing is downloaded; the code is already here, switched off." : "Everything that ships with Mystical is installed."}>
        {offers.length > 0 && (
          // .aim scopes the card tokens (--l, --l2, --f) the aim-* classes read.
          <div className="aim aim-xgrid">
            {offers.map((o) => {
              const p = list.find((x) => x.id === o.id)!;
              const name = o.name ?? p.label;
              return (
                <div key={o.chip} className="aim-x" data-busy={busy === o.id || undefined}
                  style={{ border: "1px dashed var(--line2)", background: "transparent" }}>
                  <div className="aim-xhd">
                    <span className="aim-xic" aria-hidden
                      style={{ color: o.color, background: `color-mix(in oklab, ${o.color} 16%, var(--panel))`, fontSize: 10, fontWeight: 600 }}>
                      {o.chip}
                    </span>
                    <b>{name}</b>
                  </div>
                  <div className="aim-xhint">{o.hint ?? p.blurb}</div>
                  {err?.id === o.id && <div className="aim-xerr">{err.msg}</div>}
                  <div className="aim-xfoot">
                    <span>{o.needs ?? p.needs}</span>
                    <span style={{ flex: 1 }} />
                    <button type="button" className="aim-xbtn" disabled={!!busy} aria-label={`Install ${name}`}
                      onClick={() => void set(o.id, "install")} style={{ border: "1px solid var(--acc)", color: "var(--txb)" }}>
                      Install
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </>
  );
}

/* MCP — every server this machine can reach, and the four things you actually
   do to one: add it, drop it, sign in again when its token expires, or forget
   the token entirely. `claude mcp` runs all of it, so what shows here is what a
   terminal shows, and an add from this panel is byte-identical to one typed.

   Which servers a *session* switches on is a different question, and stays in
   the TOOLS modal beside the built-in tools it belongs with. This tab is about
   what exists on the machine at all. */
const REMOTE = /\((HTTP|SSE)\)\s*$/i;   // a stdio server has no OAuth to renew

function McpPanel() {
  const [info, setInfo] = useState<McpInfo | null>(null);
  // The client can be newer than the bridge: a dashboard built from this commit
  // against a process that started before it gets a 404 here, not a panel.
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState("");            // the row mid-action, if any
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Authorization in flight: the CLI is parked on its "paste the redirect URL"
  // prompt under a pty, waiting for what the browser hands back.
  const [login, setLogin] = useState<{ name: string; url: string } | null>(null);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [transport, setTransport] = useState("http");
  const [scope, setScope] = useState("user");

  const load = (refresh = false) => {
    if (refresh) setChecking(true);
    return api
      .mcp(refresh)
      .then((r) => {
        setInfo(r);
        setLogin(r.pending?.url ? { name: r.pending.name, url: r.pending.url } : null);
      })
      .catch((e) => setStale(e instanceof Error && e.message.includes("404")))
      .finally(() => setChecking(false));
  };

  useEffect(() => {
    void load();
  }, []);

  // The CLI runs its own localhost callback listener, so a browser on this
  // machine usually finishes the flow with nothing pasted back. Poll for that,
  // or the panel keeps asking for a code that already arrived.
  useEffect(() => {
    if (!login) return;
    const t = setInterval(() => {
      void api
        .mcp()
        .then((r) => {
          if (!r.pending) {
            setLogin(null);
            setInfo(r);
          }
        })
        .catch(() => {});
    }, 2500);
    return () => clearInterval(t);
  }, [login]);

  async function act(action: string, server: string, extra?: Record<string, unknown>) {
    setBusy(server);
    setErr(null);
    try {
      const r = await api.mcpAction(action, server, extra);
      if (r.servers) setInfo((i) => (i ? { ...i, servers: r.servers! } : i));
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
      return false;
    } finally {
      setBusy("");
    }
  }

  async function startLogin(server: string) {
    setBusy(server);
    setErr(null);
    try {
      const r = await api.mcpAction("login_begin", server);
      if (r.url) {
        setLogin({ name: server, url: r.url });
        window.open(r.url, "_blank", "noopener");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not start authorization");
    } finally {
      setBusy("");
    }
  }

  async function addServer() {
    if (!name.trim() || !target.trim()) return;
    setBusy("+");
    setErr(null);
    try {
      const r = await api.mcpAction("add", name.trim(), { target: target.trim(), transport, scope });
      if (r.servers) setInfo((i) => (i ? { ...i, servers: r.servers! } : i));
      setName("");
      setTarget("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not add it");
    } finally {
      setBusy("");
    }
  }

  const servers = info?.servers ?? [];
  const live = servers.filter((s) => s.ok).length;

  return (
    <>
      <Section
        title="MCP SERVERS"
        info={
          <>
            The servers <span style={{ color: "var(--txd)" }}>claude mcp list</span> knows about,
            health-checked. NEEDS AUTH means the server is configured but its token expired or was
            never granted — AUTH opens its authorization page, and the sign-in usually completes
            the moment the browser lands back on this machine. A plugin&apos;s servers arrive with
            the plugin, so they&apos;re removed under SKILLS above, not here. Every server on costs
            context in each session that has it switched on; that switch lives in TOOLS.
          </>
        }
      >
        <div style={CARD}>
          <div style={{ ...KV, marginBottom: servers.length ? 12 : 0 }}>
            <span style={KEY_TX}>
              {stale ? "NEEDS A RESTART" : info === null ? "READING…" : `${live}/${servers.length} CONNECTED`}
            </span>
            <MiniBtn disabled={checking || stale} onClick={() => void load(true)}>
              {checking ? "CHECKING…" : "REFRESH"}
            </MiniBtn>
          </div>

          {stale && (
            <div style={{ fontSize: "var(--t105)", color: "var(--txl)" }}>
              the bridge needs a restart before it can answer this
            </div>
          )}
          {!stale && info !== null && servers.length === 0 && (
            <div style={{ fontSize: "var(--t105)", color: "var(--txl)" }}>
              No MCP servers configured. Add one below.
            </div>
          )}

          {servers.map((s, i) => {
            const remote = !s.target || REMOTE.test(s.target);
            const plugin = s.name.startsWith("plugin:");
            const working = busy === s.name;
            return (
              <div
                key={s.name}
                style={{ ...ROW, marginTop: i ? 9 : 0, opacity: working ? 0.5 : 1 }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    flex: "none",
                    background: s.ok ? "var(--ok)" : s.status.startsWith("!") ? "var(--warn)" : "var(--err)",
                  }}
                />
                <span
                  style={{
                    fontSize: "var(--t11)",
                    color: s.ok ? "var(--tx)" : "var(--txb)",
                    flex: "none",
                    maxWidth: "42%",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={s.name}
                >
                  {plugin ? s.name.slice("plugin:".length) : s.name}
                </span>
                {/* Healthy: what it connects to, which is what identifies it.
                    Unhealthy: why — calendly's registration error is the whole
                    reason you opened this tab. */}
                <span
                  style={{
                    fontSize: "var(--t95)",
                    color: s.ok ? "var(--txd)" : s.status.startsWith("!") ? "var(--warn)" : "var(--err)",
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={s.ok ? s.target : s.status}
                >
                  {s.ok ? s.target : s.status}
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 8, flex: "none" }}>
                  {/* Says why there is no REMOVE here: the plugin owns it. */}
                  {plugin && <span style={{ ...CAPTION, width: "auto" }}>PLUGIN</span>}
                  {remote && (
                    <MiniBtn disabled={!!busy || !!login} onClick={() => void startLogin(s.name)}>
                      {s.ok ? "RE-AUTH" : "AUTH"}
                    </MiniBtn>
                  )}
                  {remote && s.ok && (
                    <MiniBtn
                      disabled={!!busy}
                      title="forget this machine's stored credentials for the server"
                      onClick={() => void act("logout", s.name)}
                    >
                      LOGOUT
                    </MiniBtn>
                  )}
                  {!plugin && (
                    <MiniBtn disabled={!!busy} danger onClick={() => void act("remove", s.name)}>
                      REMOVE
                    </MiniBtn>
                  )}
                </span>
              </div>
            );
          })}

          {login && (
            <LoginFlow
              url={login.url}
              placeholder="paste the redirect URL here"
              steps={
                <>
                  Authorizing <span style={{ color: "var(--tx)" }}>{login.name}</span> — the page
                  should already be open.{" "}
                  <a href={login.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--acc)" }}>
                    open it again
                  </a>
                  <br />
                  It usually finishes on its own. If the browser can&apos;t reach this machine, copy
                  the URL it lands on and paste it here:
                </>
              }
              onSubmit={(url) => api.mcpAction("login_submit", login.name, { url })}
              onDone={() => {
                setLogin(null);
                void load();
              }}
              onCancel={() => {
                void api.mcpAction("login_cancel").catch(() => {});
                setLogin(null);
                void load();
              }}
            />
          )}
          {err && <div style={{ fontSize: "var(--t10)", color: "var(--warn)", marginTop: 10 }}>{err}</div>}
        </div>
      </Section>

      <Section
        title="ADD A SERVER"
        top
        info={
          <>
            HTTP and SSE take a URL and authorize in the browser; STDIO takes a command line the
            bridge runs locally. USER scope makes it available in every project on this machine,
            PROJECT writes it to the project&apos;s{" "}
            <span style={{ color: "var(--txd)" }}>.mcp.json</span>, LOCAL keeps it to you here. A
            server that needs API keys or auth headers has to be added with{" "}
            <span style={{ color: "var(--txd)" }}>claude mcp add-json</span> in a terminal.
          </>
        }
      >
        <div style={CARD}>
          <div style={{ ...LINE, marginTop: 0 }}>
            <Cell label="KIND" grow="1 1 200px">
              <Segmented
                options={(info?.transports ?? ["http", "sse", "stdio"]).map((t) => ({
                  label: t.toUpperCase(),
                  value: t,
                }))}
                value={transport}
                onPick={setTransport}
              />
            </Cell>
            <Cell label="SCOPE" grow="1 1 200px">
              <Segmented
                options={(info?.scopes ?? ["user", "local", "project"]).map((sc) => ({
                  label: sc.toUpperCase(),
                  value: sc,
                }))}
                value={scope}
                onPick={setScope}
              />
            </Cell>
          </div>
          <div style={{ ...ROW, gap: 8 }}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="name"
              style={{ ...FIELD, flex: "none", width: 130 }}
            />
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void addServer()}
              placeholder={transport === "stdio" ? "npx -y some-mcp-server" : "https://mcp.example.com/mcp"}
              style={FIELD}
            />
            <MiniBtn disabled={!!busy || stale} onClick={() => void addServer()}>
              {busy === "+" ? "…" : "ADD"}
            </MiniBtn>
          </div>
        </div>
      </Section>
    </>
  );
}

const CODE: CSSProperties = {
  fontFamily: "'JetBrains Mono',monospace",
  fontSize: "var(--t95)",
  color: "var(--tx)",
  background: "var(--panel3)",
  padding: "1px 5px",
};

const FIELD: CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: "var(--panel3)",
  border: "1px solid color-mix(in srgb, var(--acc) 22%, transparent)",
  outline: "none",
  color: "var(--txb)",
  fontFamily: "inherit",
  fontSize: "var(--t11)",
  padding: "6px 8px",
};

/** The paste-the-code half of a sign-in: the link is already open in a tab. */
function LoginFlow({
  url,
  onSubmit,
  onDone,
  onCancel,
  steps,
  placeholder = "paste the code here",
}: {
  url: string;
  onSubmit: (code: string) => Promise<unknown>;
  onDone: () => void;
  onCancel: () => void;
  /** What the user has to do, in their words — an account sign-in and an MCP
   *  authorization differ only in this and the placeholder. */
  steps?: ReactNode;
  placeholder?: string;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!code.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(code.trim());
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "sign-in failed");
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 13, borderTop: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", paddingTop: 12 }}>
      <div style={{ fontSize: "var(--t105)", color: "var(--txl)", lineHeight: 1.7 }}>
        {steps ?? (
          <>
            1 · Sign in as the account you want to add —{" "}
            <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--acc)" }}>
              open the sign-in page
            </a>
            <br />2 · Paste the code it gives you back:
          </>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <input
          value={code}
          autoFocus
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          placeholder={placeholder}
          style={err ? { ...FIELD, border: "1px solid var(--err)" } : FIELD}
        />
        <MiniBtn disabled={busy} onClick={() => void submit()}>
          {busy ? "…" : "CONNECT"}
        </MiniBtn>
        <MiniBtn disabled={busy} danger onClick={onCancel}>
          CANCEL
        </MiniBtn>
      </div>
      {err && <div style={{ fontSize: "var(--t10)", color: "var(--warn)", marginTop: 8 }}>{err}</div>}
    </div>
  );
}

type TestState = { busy: true } | { ok: true; n: number } | { ok: false; error: string };

function copyText(text: string) {
  void navigator.clipboard?.writeText(text)
    .then(() => notify("info", "Copied."), () => notify("error", "Clipboard refused the copy."));
}

/** The vetted non-Claude agents (bridge/acp_agents.py PRESETS): installed or
 *  not, the accounts each runs under, and a TEST per account. A pasted key goes
 *  to the bridge in a POST body and is dropped here once saved: the list only
 *  ever holds the masked form the bridge sends back. */
function AgentsSection({ profileRows }: { profileRows?: (agentId: string) => ReactNode }) {
  const [info, setInfo] = useState<AcpAgentsInfo | null>(null);
  const [gone, setGone] = useState(false); // a bridge older than agents (404)
  const [err, setErr] = useState<string | null>(null);
  const load = () => api.acpAgents()
    .then((r) => { setInfo(r); setGone(false); setErr(null); setAgentLabels(r.presets); })
    .catch((e) => { if ((e as Error).message === "not found") setGone(true); else setErr((e as Error).message); });
  useEffect(() => { void load(); }, []);

  const note = (
    <div style={NOTE}>
      Only vetted agents are offered. Logins happen in each CLI&apos;s own sign-in; the bridge stores only API keys you paste here.
    </div>
  );
  if (gone) return <div style={CARD}><div style={KEY_TX}>Restart the bridge to use other agents.</div></div>;
  if (!info) {
    return (
      <div style={CARD}>
        {err ? <div style={{ fontSize: "var(--t10)", color: "var(--warn)" }}>Couldn&apos;t load agents — {err}</div>
          : <div style={KEY_TX}>LOADING…</div>}
      </div>
    );
  }
  return (
    <>
      {info.presets.map((p) => (
        <div key={p.id} className="aim-card">
          <div className="aim-agent">
            <AgentRow p={p} first accounts={info.accounts.filter((a) => a.agent === p.id)} onChanged={() => void load()} />
          </div>
          {profileRows?.(p.id)}
        </div>
      ))}
      {note}
    </>
  );
}

/** One preset: install state, its accounts with TEST and ✕, and the forms that
 *  add a key or a separate login. */
function AgentRow({ p, first, accounts, onChanged }: {
  p: AcpPreset;
  first: boolean;
  accounts: AcpAccount[];
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState<"" | "key" | "home">("");
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});

  function open(kind: "" | "key" | "home") {
    setAdding(kind);
    setLabel("");
    setKey("");
    setErr(null);
  }
  async function create() {
    if (busy || !label.trim() || (adding === "key" && !key.trim())) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.acpAccount({
        action: "create", agent: p.id, label: label.trim(), kind: adding as "key" | "home",
        ...(adding === "key" ? { key: key.trim() } : {}),
      });
      setHint(r.login_hint ?? null);
      open("");          // drops the pasted key: from here on only its masked form exists
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    setBusy(true);
    setErr(null);
    try {
      await api.acpAccount({ action: "delete", id });
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function test(acct: string) {
    setTests((t) => ({ ...t, [acct]: { busy: true } }));
    let r: TestState;
    try {
      const res = await api.acpTest(p.id, acct);
      r = res.ok ? { ok: true, n: res.options?.model.length ?? 0 } : { ok: false, error: res.error ?? "failed" };
      if (res.ok) onChanged();   // its options are cached now: the pickers can list them
    } catch (e) {
      r = { ok: false, error: (e as Error).message };
    }
    setTests((t) => ({ ...t, [acct]: r }));
  }

  const result = (acct: string) => {
    const t = tests[acct];
    if (!t || "busy" in t) return null;
    return t.ok
      ? <span style={{ fontSize: "var(--t10)", color: "var(--ok)" }}>✓ {t.n} MODEL{t.n === 1 ? "" : "S"}</span>
      : <span style={{ fontSize: "var(--t10)", color: "var(--warn)" }}>✕</span>;
  };
  const why = (acct: string) => {
    const t = tests[acct];
    return t && "ok" in t && !t.ok
      ? <div style={{ fontSize: "var(--t10)", color: "var(--warn)", marginTop: 4, lineHeight: 1.6, overflowWrap: "anywhere" }}>{t.error}</div>
      : null;
  };
  const testBtn = (acct: string) => {
    const t = tests[acct];
    return (
      <MiniBtn disabled={!p.installed || (!!t && "busy" in t)} onClick={() => void test(acct)}
        title={p.installed ? "Start it once and list what it offers (up to two minutes)" : "Install it first"}>
        {t && "busy" in t ? <><LoaderCircle size={11} aria-hidden style={{ animation: "introspin 1.4s linear infinite" }} /> TESTING…</> : "TEST"}
      </MiniBtn>
    );
  };
  const line = (acct: string, name: ReactNode, extra?: ReactNode) => (
    <div key={acct || "machine"} style={{ padding: "7px 0 0 12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span style={{ fontSize: "var(--t10)", color: "var(--tx)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
        <span style={{ flex: 1 }} />
        {result(acct)}
        {testBtn(acct)}
        {extra}
      </div>
      {why(acct)}
    </div>
  );
  const input = (v: string, set: (v: string) => void, placeholder: string, secret = false) => (
    <input value={v} onChange={(e) => set(e.target.value)} placeholder={placeholder}
      type={secret ? "password" : "text"} autoComplete={secret ? "new-password" : "off"} spellCheck={false}
      onKeyDown={(e) => e.key === "Enter" && void create()} style={FIELD} />
  );

  return (
    <div style={{ marginTop: first ? 0 : 14, paddingTop: first ? 0 : 12, borderTop: first ? undefined : RULE }}>
      <div style={KV}>
        <span style={{ fontSize: "var(--t11)", color: p.installed ? "var(--txb)" : "var(--txl)" }}>{p.label.toUpperCase()}</span>
        <span style={{ fontSize: "var(--t10)", letterSpacing: 1, color: p.installed ? "var(--ok)" : "var(--txd)" }}>
          {p.installed ? "INSTALLED" : "NOT INSTALLED"}
        </span>
      </div>
      {!p.installed && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 7 }}>
          <code style={{ ...CODE, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.install}</code>
          <MiniBtn onClick={() => copyText(p.install)} title="Copy the install command">COPY</MiniBtn>
        </div>
      )}
      {!p.key_required && line("", <>MACHINE LOGIN{p.login && <span style={{ color: "var(--txd)" }}> · {p.login}</span>}</>)}
      {accounts.map((a) => line(a.id,
        <>{a.label} <span style={{ color: "var(--txd)" }}>· {a.kind === "key" ? `API KEY ${a.key ?? ""}` : "SEPARATE LOGIN"}</span></>,
        <MiniBtn danger disabled={busy} onClick={() => void remove(a.id)} title={`Remove ${a.label}`}>✕</MiniBtn>))}
      {hint && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 9 }}>
          <code style={{ ...CODE, minWidth: 0, overflowWrap: "anywhere" }}>{hint}</code>
          <MiniBtn onClick={() => copyText(hint.replace(/^Run once in a terminal: /, ""))} title="Copy the sign-in command">COPY</MiniBtn>
          <MiniBtn onClick={() => setHint(null)} title="Dismiss">✕</MiniBtn>
        </div>
      )}
      {adding ? (
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          {input(label, setLabel, "label, e.g. work")}
          {adding === "key" && input(key, setKey, `${p.key_env} — paste the API key`, true)}
          <MiniBtn disabled={busy || !label.trim() || (adding === "key" && !key.trim())} onClick={() => void create()}>
            {busy ? "…" : "SAVE"}
          </MiniBtn>
          <MiniBtn disabled={busy} onClick={() => open("")}>CANCEL</MiniBtn>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          {p.key_env && <MiniBtn disabled={busy} onClick={() => open("key")}>+ API KEY</MiniBtn>}
          {p.home_env && !p.key_required && <MiniBtn disabled={busy} onClick={() => open("home")}>+ SEPARATE LOGIN</MiniBtn>}
        </div>
      )}
      {err && <div style={{ fontSize: "var(--t10)", color: "var(--warn)", marginTop: 8 }}>{err}</div>}
    </div>
  );
}

function MiniBtn({
  children,
  onClick,
  disabled,
  danger,
  hot,
  title,
  primary,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** The one action the row is for — filled in the accent. */
  primary?: boolean;
  /** The one button the panel was opened for: lit, and it flashes on arrival. */
  hot?: boolean;
  /** An icon-only button has to say what it is somewhere. */
  title?: string;
}) {
  const [hov, setHov] = useState(false);
  const voice = useVoice();
  return (
    <button
      className="set-mini"
      data-danger={danger || undefined}
      data-primary={primary || undefined}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        appearance: "none",
        cursor: disabled ? "default" : "pointer",
        border: `1px solid color-mix(in srgb, ${danger ? "var(--warn)" : "var(--acc)"} ${hot || primary ? 100 : 24}%, transparent)`,
        background: primary && !disabled ? "var(--acc)" : (hov || hot) && !disabled ? `color-mix(in srgb, ${danger ? "var(--warn)" : "var(--acc)"} ${hot ? 16 : 10}%, transparent)` : "transparent",
        color: disabled ? "var(--txd)" : primary ? "var(--acc-on)" : danger ? "var(--warn)" : hot ? "var(--acc)" : "var(--tx)",
        animation: hot ? "resultflash 1.2s ease 3" : undefined,
        fontFamily: "inherit",
        fontSize: "var(--t95)",
        letterSpacing: 1,
        padding: "4px 9px",
        opacity: disabled ? 0.5 : 1,
        // Icon children would otherwise sit on the text baseline and ride high.
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5,
      }}
    >
      {typeof children === "string" ? voice(children) : children}
    </button>
  );
}


// ---- AI MANAGEMENT ----------------------------------------------------------
// One page for who runs a session and where: ACCOUNTS (the logins, each with
// the profiles bound to it, and the other agents), SKILLS (with the extras
// that spend model calls), MCP, DEFAULT PROFILE (and what a session gets
// without one) and PROJECTS — five folds, all shut until you open one, each
// remembered per browser. It replaced five tabs that each held a piece of the
// same question, and the sidebar's SKILLS panel.

/** The login list and its actions, shared by the ACCOUNTS fold and the
 *  profile editor's LOGIN picker. */
function useAccounts(onChanged: () => void) {
  const [rows, setRows] = useState<AccountInfo[] | null>(null);
  const [policy, setPolicy] = useState("ask");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A sign-in in flight: the CLI is parked on its "paste the code" prompt in a
  // fresh profile, waiting for what the browser hands back.
  const [login, setLogin] = useState<{ slot: number; url: string } | null>(null);
  const load = () => api.accounts()
    .then((r) => {
      setRows(r.accounts);
      setPolicy(r.default_policy);
      if (r.pending_login?.url) setLogin({ slot: r.pending_login.slot, url: r.pending_login.url });
    })
    .catch(() => setRows([]));
  useEffect(() => { void load(); }, []);
  async function act(action: "add" | "remove" | "disable" | "enable", slot?: number) {
    setBusy(true); setErr(null);
    try { await api.accountAction(action, slot); onChanged(); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : "failed"); }
    finally { setBusy(false); }
  }
  // No slot adds an account; a slot signs that one back in where it lives —
  // what an expired OAuth session needs, and what the bot's dead-login button does.
  async function startLogin(slot?: number) {
    setBusy(true); setErr(null);
    try {
      const r = await api.loginBegin(slot);
      setLogin({ slot: r.slot, url: r.url });
      window.open(r.url, "_blank", "noopener");
    } catch (e) { setErr(e instanceof Error ? e.message : "could not start the sign-in"); }
    finally { setBusy(false); }
  }
  return { rows, setRows, policy, setPolicy, busy, err, setErr, login, setLogin, load, act, startLogin };
}

/** A login's tile: its slot on a hue of its own. The six hues are the theme's
 *  named roles, so a login reads the same in its card, in a profile row and in
 *  a project's picker. */
const SLOT_HUES = ["var(--acc)", "var(--ask, var(--purple))", "var(--info)", "var(--ok)", "var(--warn)", "var(--purple)"];
function LoginTile({ slot, size = 34 }: { slot: number | string; size?: number }) {
  const n = Number(slot) || 1;
  return (
    <span className="aim-av" style={{ width: size, height: size, borderRadius: Math.round(size * .27), fontSize: Math.round(size * .36), background: SLOT_HUES[(n - 1) % SLOT_HUES.length] }}>
      A{n}
    </span>
  );
}

/** The 5h / wk fuel gauges of a login, from its usage windows. */
function LoginMeters({ a }: { a: AccountInfo }) {
  const tone = a.left === null ? "var(--txd)" : a.left <= 1 ? "var(--warn)" : "var(--ok)";
  const labels = windowLabels(a);
  if (!labels.length) {
    return (
      <span className="aim-usage" style={{ color: a.logged_in === false ? "var(--err)" : "var(--txd)" }}>
        {a.logged_in === false ? "Login expired" : "Usage unknown"}
      </span>
    );
  }
  return (
    <span className="aim-meters">
      {labels.map((w) => {
        // "5H 95% 0H31M" → tag, percent left, time to reset
        const m = /^(\S+)\s+(\d+)%\s*(.*)$/.exec(w);
        if (!m) return <span key={w} className="aim-usage" style={{ color: tone }}>{w}</span>;
        return (
          <span key={w} className="aim-meter" title={w}>
            <em>{m[1].toLowerCase()}</em>
            <i style={{ ["--v" as string]: `${m[2]}%`, ["--c" as string]: tone }} />
            <b style={{ color: tone }}>{m[2]}%</b>
          </span>
        );
      })}
    </span>
  );
}

/** What a profile sets, as pills: model · mode · effort · tools off. */
function ProfilePills({ p }: { p: Profile }) {
  const bits = [p.agent !== "claude" ? `◇ ${agentLabel(p.agent)}` : null, p.model.replace(/^claude-/, ""),
    p.mode.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase(), p.effort, p.tools && `${p.tools.length} off`].filter(Boolean) as string[];
  return <span className="aim-pills">{bits.length ? bits.map((b) => <em key={b}>{b}</em>) : <em>defaults</em>}</span>;
}

/** The profile form — a new one or the one being edited — inline under its
 *  row. Writes go through `write` (POST /local/profiles). */
function ProfileEditor({ form, setForm, models, settings, sessionTools, logins, loginsErr, acp, loadAcp, busy, err, onSave, onCancel }: {
  form: Profile;
  setForm: (patch: Partial<Profile>) => void;
  models: { id: string; label: string }[];
  settings: HudSettings;
  sessionTools: string[];
  logins: AccountInfo[];
  loginsErr: string | null;
  acp: AcpAgentsInfo | null;
  loadAcp: () => Promise<void>;
  busy: boolean;
  err: string | null;
  onSave: () => void;
  onCancel: () => void;
}) {
  const [testing, setTesting] = useState(false);
  const [testErr, setTestErr] = useState<string | null>(null);
  const set = setForm;
  // A value the lists no longer offer (a login since removed, a model gone
  // from the Models API) stays shown as itself, not as another row.
  const keep = (opts: { id: string; label: string }[], v: string, label = v.toUpperCase()) =>
    opts.some((o) => o.id === v) ? opts : [...opts, { id: v, label }];
  const NOT_SET = { id: "", label: "NOT SET" };
  const isAgent = form.agent !== "claude";
  // An agent's pickers: what it advertised for this account (a TEST or a turn
  // cached it), AGENT DEFAULT first. Nothing cached yet → a TEST right here.
  const cached = isAgent ? acp?.options[`${form.agent}|${form.account}`] : undefined;
  const agentRows = (list: { value: string; name: string }[] | undefined, v: string) =>
    keep(optionRows(list) ?? [AGENT_DEFAULT], v);
  async function testHere() {
    setTesting(true); setTestErr(null);
    try {
      const r = await api.acpTest(form.agent, form.account);
      if (r.ok) await loadAcp(); else setTestErr(r.error ?? "the agent didn't start");
    } catch (e) { setTestErr((e as Error).message); }
    finally { setTesting(false); }
  }
  const warn = (text: string) => <div style={{ fontSize: "var(--t10)", color: "var(--warn)" }}>{text}</div>;
  return (
    <div className="aim-editor">
      <div className="aim-f">
        <label>Name</label>
        <input value={form.name} maxLength={32} autoFocus placeholder="name this profile"
          onChange={(e) => set({ name: e.target.value })} />
      </div>
      {/* A profile keeps its agent (the bridge refuses a change): an agent
          can't read another's history, and sessions are bound to it. */}
      <div className="aim-f">
        <label>Agent</label>
        <select value={form.agent} disabled={!!form.id} title={form.id ? "A profile keeps its agent — make a new profile for another" : undefined}
          onChange={(e) => { const agent = e.target.value; set(agent === "claude"
            ? { agent, account: "", model: settings.model, mode: settings.perm, effort: settings.effort }
            : { agent, account: "", model: "", mode: "", effort: "" }); }}>
          {keep([{ id: "claude", label: "Claude" },
            ...(acp?.presets ?? []).filter((p) => p.installed).map((p) => ({ id: p.id, label: p.label }))], form.agent, agentLabel(form.agent))
            .map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </div>
      <div className="aim-f">
        <label>{isAgent ? "Account" : "Login"}</label>
        {isAgent ? (
          <select value={form.account} onChange={(e) => set({ account: e.target.value, model: "", mode: "", effort: "" })}>
            {keep([{ id: "", label: "Machine login" },
              ...(acp?.accounts ?? []).filter((a) => a.agent === form.agent)
                .map((a) => ({ id: a.id, label: `${a.label} · ${a.kind === "key" ? "API key" : "own login"}` }))], form.account)
              .map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        ) : (
          <select value={form.account} onChange={(e) => set({ account: e.target.value })}>
            {keep([{ id: "", label: "Default login" },
              ...logins.map((a) => ({ id: String(a.slot), label: `A${a.slot} · ${a.email ?? "unknown"}` }))], form.account, `A${form.account}`)
              .map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        )}
      </div>
      {loginsErr && !isAgent && <div className="aim-f wide">{warn(`Couldn't list the Claude logins — ${loginsErr}`)}</div>}
      {isAgent ? (
        <>
          <div className="aim-f"><label>Model</label>
            <select value={form.model} onChange={(e) => set({ model: e.target.value })}>{agentRows(cached?.model, form.model).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></div>
          <div className="aim-f"><label>Mode</label>
            <select value={form.mode} onChange={(e) => set({ mode: e.target.value })}>{agentRows(cached?.mode, form.mode).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></div>
          <div className="aim-f"><label>Effort</label>
            <select value={form.effort} onChange={(e) => set({ effort: e.target.value })}>{agentRows(cached?.effort, form.effort).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></div>
          {!cached?.model.length && !cached?.mode.length && !cached?.effort.length && (
            <div className="aim-f wide">
              <MiniBtn disabled={testing} onClick={() => void testHere()} title="Start the agent once and list its models and modes (up to two minutes)">
                {testing ? "TESTING…" : "TEST"}
              </MiniBtn>
              {testErr && warn(testErr)}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="aim-f"><label>Model</label>
            <select value={form.model} onChange={(e) => set({ model: e.target.value })}>
              {keep([NOT_SET, ...models.map((m) => ({ id: m.id, label: m.label }))], form.model).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select></div>
          <div className="aim-f"><label>Permission mode</label>
            <select value={form.mode} onChange={(e) => set({ mode: e.target.value })}>
              {[NOT_SET, ...PERMS].map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select></div>
          <div className="aim-f"><label>Effort</label>
            <select value={form.effort} onChange={(e) => set({ effort: e.target.value })}>
              {[NOT_SET, ...EFFORTS.filter((e) => e.id)].map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select></div>
        </>
      )}
      <div className="aim-f wide aim-foot">
        {/* Tool switches are Claude's --disallowedTools; another agent asks its own way.
            ON = the profile carries tool switches: its own while you edit it, the
            open session's once switched on here. OFF = null, the bridge's defaults. */}
        {!isAgent && (
          <>
            <Switch on={form.tools !== null} onClick={() => set({ tools: form.tools ? null : sessionTools })} />
            <span>Use this session's tool switches{form.tools && <em> · {form.tools.length} off</em>}</span>
          </>
        )}
        <span style={{ flex: 1 }} />
        {err && <span style={{ fontSize: "var(--t10)", color: "var(--warn)" }}>{err}</span>}
        <MiniBtn disabled={busy} onClick={onCancel}>CANCEL</MiniBtn>
        <MiniBtn disabled={busy || !form.name.trim()} onClick={onSave} primary>SAVE PROFILE</MiniBtn>
      </div>
    </div>
  );
}

/** One fold of the page: a header that opens and closes it (a rotating
 *  chevron, the count, and whatever the fold puts at its right edge), kept per
 *  fold in this browser. `secs` are the search index titles that live inside,
 *  so a hit opens the fold it scrolls to. */
const FOLDS_KEY = "hud-aim-folds";
function readFolds(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(FOLDS_KEY) || "{}") as Record<string, boolean>; } catch { return {}; }
}
function AimFold({ id, title, hint, count, right, secs, defaultOpen = false, openSec, children }: {
  id: string;
  title: string;
  hint?: ReactNode;
  count?: ReactNode;
  right?: ReactNode;
  secs: string[];
  defaultOpen?: boolean;
  openSec: string | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState<boolean>(() => readFolds()[id] ?? defaultOpen);
  // Opened from outside — a search hit, or a caller that named one of the
  // tabs this page replaced — the fold opens and stays open.
  useEffect(() => { if (openSec && secs.includes(openSec)) setOpen(true); }, [openSec]);
  const toggle = () => {
    setOpen((o) => { const n = !o; try { localStorage.setItem(FOLDS_KEY, JSON.stringify({ ...readFolds(), [id]: n })); } catch { /* ignore */ } return n; });
  };
  return (
    <section className="aim-fold" data-open={open || undefined} data-sec={secs[0]}>
      <div className="aim-foldhead">
        <button type="button" className="aim-foldbtn" onClick={toggle} aria-expanded={open}>
          <ChevronRight size={14} aria-hidden className="aim-chev" />
          <b>{title}</b>
          {count != null && <span className="aim-count">{count}</span>}
          {hint && <span className="aim-hint">{hint}</span>}
        </button>
        {right && <div className="aim-foldright">{right}</div>}
      </div>
      {open && <div className="aim-foldbody">{children}</div>}
    </section>
  );
}

function AiManagementPanel({ settings, onPatch, models, sessionTools, profiles, profilesAvailable, profilesError,
  onProfilesChanged, onAccountsChanged, projects, project, openSec }: {
  settings: HudSettings;
  onPatch: (patch: Partial<HudSettings>) => void;
  models: { id: string; label: string }[];
  sessionTools: string[];
  profiles: ProfilesInfo | null;
  profilesAvailable: boolean;
  profilesError: string | null;
  onProfilesChanged: () => void;
  onAccountsChanged: () => void;
  projects: ProjectsSettingsProps;
  project: string | null;
  openSec: string | null;
}) {
  const aiFeatures = useAiFeatures();
  const acc = useAccounts(onAccountsChanged);
  // Opened on one login (the composer's PROFILE menu, on a profile whose login
  // has expired) or on a blank profile (its + NEW PROFILE): read once.
  const [focus] = useState(() => takeSettingsFocus());
  const focusSlot = Number(focus) || null;
  const focusRow = useRef<HTMLDivElement>(null);
  useEffect(() => { focusRow.current?.scrollIntoView({ block: "center" }); }, [acc.rows === null]);

  // ---- profiles: the editor's environment and its writes
  const blank = (account = ""): Profile => ({ id: "", name: "", agent: "claude", account, model: settings.model,
                                               mode: settings.perm, effort: settings.effort, tools: null });
  // The profile in the form: id "" = a new one, `under` = which login's list
  // it sits beneath ("" = the general one at the foot). null = no form open.
  const [form, setForm] = useState<{ p: Profile; under: string } | null>(() => focus === "new" ? { p: blank(), under: "" } : null);
  const [pBusy, setPBusy] = useState(false);
  const [pErr, setPErr] = useState<string | null>(null);
  const [loginsErr, setLoginsErr] = useState<string | null>(null);
  const [acp, setAcp] = useState<AcpAgentsInfo | null>(null);
  const loadAcp = () => api.acpAgents().then(setAcp).catch(() => {});
  useEffect(() => {
    void loadAcp();
    // Opening the page re-reads the list: a failed load, or a bridge that has
    // been restarted since it 404'd, gets another go without a page reload.
    onProfilesChanged();
  }, []);
  useEffect(() => { if (acc.rows === null) return; setLoginsErr(null); }, [acc.rows]);
  // The browser-only profiles this replaced move onto the bridge once, after
  // the list is in (a clash with one already there gets " (old)").
  useEffect(() => {
    if (!profiles) return;
    void importLegacy(profiles.profiles, api.profileWrite).then((r) => {
      if (!r) return;
      if (r.landed) onProfilesChanged();
      if (r.picked) notify("info", `Your AGENT pick is now profile '${r.picked}' — pick it in PROFILE`);
    });
  }, [profiles]);
  async function write(body: ProfileWrite, done?: () => void) {
    setPBusy(true); setPErr(null);
    try { await api.profileWrite(body); done?.(); onProfilesChanged(); }
    catch (e) { setPErr((e as Error).message); }
    finally { setPBusy(false); }
  }
  const saveForm = () => {
    if (!form) return;
    const { id, ...fields } = { ...form.p, tools: form.p.agent !== "claude" ? null : form.p.tools };
    void write(id ? { action: "update", id, ...fields } : { action: "create", ...fields }, () => setForm(null));
  };
  const editor = form && (
    <ProfileEditor form={form.p} setForm={(patch) => setForm((f) => f && { ...f, p: { ...f.p, ...patch } })}
      models={models} settings={settings} sessionTools={sessionTools}
      logins={(acc.rows ?? []).filter((a) => !a.disabled)} loginsErr={loginsErr} acp={acp} loadAcp={loadAcp}
      busy={pBusy} err={pErr} onSave={saveForm} onCancel={() => { setForm(null); setPErr(null); }} />
  );
  const list = profiles?.profiles ?? [];
  const defaultId = profiles?.default;
  const defaultName = list.find((p) => p.id === defaultId)?.name;
  /** The rows of one owner — a Claude login (its slot) or another agent (its id). */
  const profileRows = (owner: { agent: string; account?: string }, under: string, newLabel: string) => {
    const mine = list.filter((p) => owner.agent === "claude"
      ? p.agent === "claude" && (p.account === owner.account || (owner.account === "" && p.account === ""))
      : p.agent === owner.agent);
    return (
      <div className="aim-profs">
        {mine.map((p, i) => (
          <Fragment key={p.id}>
            <div className="aim-prof" data-editing={form?.p.id === p.id || undefined}>
              <span className="aim-tree">{i === mine.length - 1 ? "└" : "├"}</span>
              <span className="aim-profname">
                <b>{p.name}</b>
                {defaultId !== undefined && p.id === defaultId && <span className="aim-chip ok" title="new sessions get this profile unless their project names another">Default profile</span>}
              </span>
              <ProfilePills p={p} />
              <span className="aim-acts">
                {defaultId !== undefined && p.id !== defaultId && (
                  <MiniBtn disabled={pBusy} onClick={() => void write({ action: "default", id: p.id })} title="new sessions get this profile unless their project names another">MAKE DEFAULT</MiniBtn>
                )}
                <MiniBtn disabled={pBusy} onClick={() => { setPErr(null); setForm({ p, under }); }} title="Edit">✎</MiniBtn>
                <MiniBtn disabled={pBusy} danger onClick={() => void write({ action: "delete", id: p.id }, () => form?.p.id === p.id && setForm(null))}
                  title="delete profile — its sessions keep what it gave them">✕</MiniBtn>
              </span>
            </div>
            {form?.p.id === p.id && editor}
          </Fragment>
        ))}
        {form && !form.p.id && form.under === under ? editor : (
          <button type="button" className="aim-addrow" disabled={pBusy || !profilesAvailable}
            onClick={() => { setPErr(null); setForm({ p: { ...blank(owner.account ?? ""), agent: owner.agent }, under }); }}>
            <span className="aim-tree">+</span><u>New profile</u> {newLabel}
          </button>
        )}
      </div>
    );
  };

  // ---- the folds
  const policyPick = (
    <div className="aim-segwrap" title={POLICY_BLURB[acc.policy]}>
      <span className="aim-hint">when a login runs out</span>
      <Segmented options={POLICY_OPTS} value={acc.policy}
        onPick={(v) => { acc.setPolicy(v); void api.setDefaultPolicy(v).catch(() => void acc.load()); }} />
    </div>
  );
  const accountsBody = (
    <>
      <div className="aim-toolbar">
        <span className="aim-lead">The Claude logins runs can use, and the profiles bound to each. A new login comes with a profile of its own.</span>
        <span style={{ flex: 1 }} />
        <MiniBtn disabled={acc.busy || !!acc.login} onClick={() => void acc.startLogin()} primary>+ ADD ACCOUNT</MiniBtn>
      </div>
      {acc.rows === null && <div className="aim-card"><div className="aim-login"><span className="aim-hint">Loading…</span></div></div>}
      {acc.rows?.length === 0 && (
        <div className="aim-card"><div className="aim-login"><span className="aim-hint">No login found. Run <code>claude /login</code> in a terminal.</span></div></div>
      )}
      {acc.rows?.map((a) => (
        <div key={a.slot} className="aim-card" data-disabled={a.disabled || undefined} ref={a.slot === focusSlot ? focusRow : undefined}>
          <div className="aim-login">
            <LoginTile slot={a.slot} />
            <span className="aim-who">
              <b>{a.email ?? "unknown"}</b>
              <span>{[a.plan, a.default ? "default login" : null, a.disabled ? "disabled" : null].filter(Boolean).join(" · ") || "Claude login"}</span>
            </span>
            {a.default && <span className="aim-chip">Default</span>}
            <LoginMeters a={a} />
            <span className="aim-acts">
              <MiniBtn disabled={acc.busy || !!acc.login} hot={a.slot === focusSlot} onClick={() => void acc.startLogin(a.slot)}>RE-LOGIN</MiniBtn>
              {!a.default && (
                <>
                  <MiniBtn disabled={acc.busy} onClick={() => void acc.act(a.disabled ? "enable" : "disable", a.slot)} title={a.disabled ? "Enable" : "Disable"}>
                    {a.disabled ? "ENABLE" : "DISABLE"}
                  </MiniBtn>
                  <MiniBtn disabled={acc.busy} danger onClick={() => void acc.act("remove", a.slot)} title="Remove this login">✕</MiniBtn>
                </>
              )}
            </span>
          </div>
          {profilesAvailable && profileRows({ agent: "claude", account: String(a.slot) }, String(a.slot), "on this login")}
        </div>
      ))}
      {acc.login ? (
        <div className="aim-card"><div style={{ padding: "0 14px 12px" }}>
          <LoginFlow url={acc.login.url}
            onDone={async () => { acc.setLogin(null); onAccountsChanged(); await acc.load(); }}
            onSubmit={async (code) => {
              try { await api.loginSubmit(acc.login!.slot, code); }
              catch (e) {
                // The bridge keeps a sign-in going only through a paste worth
                // retrying (half a code). Any other failure ended it, and this
                // box could only fail again: back to the buttons, with the reason.
                const r = await api.accounts().catch(() => null);
                if (r && !r.pending_login) { acc.setLogin(null); acc.setRows(r.accounts); acc.setErr(e instanceof Error ? e.message : "sign-in failed"); }
                throw e;
              }
            }}
            onCancel={async () => { await api.loginCancel(acc.login!.slot).catch(() => {}); acc.setLogin(null); await acc.load(); }} />
        </div></div>
      ) : null}
      {acc.err && <div style={{ fontSize: "var(--t10)", color: "var(--warn)", marginTop: 8 }}>{acc.err}</div>}
      {/* Profiles on the default login (account ""), and a blank form from the
          composer's + NEW PROFILE, sit after the logins: they belong to
          whichever login is default rather than to a slot. */}
      {profilesAvailable && (list.some((p) => p.agent === "claude" && p.account === "") || (form && !form.p.id && form.under === "")) && (
        <div className="aim-card">
          <div className="aim-login"><span className="aim-av" style={{ background: "var(--panel3)", color: "var(--txm)", boxShadow: "inset 0 0 0 1px var(--line, var(--border))" }}>A</span>
            <span className="aim-who"><b>Default login</b><span>profiles that follow whichever login is default</span></span></div>
          {profileRows({ agent: "claude", account: "" }, "", "on the default login")}
        </div>
      )}
      {!profilesAvailable && <div className="aim-hint" style={{ marginTop: 8 }}>Restart the bridge to use profiles.</div>}
      {profilesError && <div style={{ fontSize: "var(--t10)", color: "var(--warn)", marginTop: 8 }}>Couldn't reload profiles, so this list may be stale — {profilesError}</div>}
      <div className="aim-sub">
        <b>Other agents</b>
        <span className="aim-hint">Codex, OpenCode — over the Agent Client Protocol — and the profiles that run on them. TEST starts one once and remembers the models and modes it offers.</span>
      </div>
      <AgentsSection profileRows={profilesAvailable ? (id) => profileRows({ agent: id }, id, `on ${agentLabel(id)}`) : undefined} />
    </>
  );

  const profilesBody = (
    <>
      <div className="aim-hero">
        <div>
          <div className="aim-hero-l">Default profile</div>
          <span className="aim-hint">What a new session gets unless its project names another. The profiles themselves live under each login in ACCOUNTS.</span>
        </div>
        {profiles ? (
          <ProfilePick lg value={defaultId ?? ""} emptyLabel="The first login's" profiles={profiles} logins={acc.rows ?? []}
            disabled={!profilesAvailable || pBusy} onPick={(id) => void write({ action: "default", id })} />
        ) : <span className="aim-hint">{profilesError ?? "—"}</span>}
      </div>
      <div className="aim-glabel" data-sec="RUN DEFAULTS">When no profile applies — this browser's run defaults</div>
      <div className="aim-vfields">
        <div className="aim-vfield">
          <b>Model</b>
          <select className="aim-sel" value={settings.model} onChange={(e) => onPatch({ model: e.target.value })}>
            {(settings.allModels ? models : latestPerFamily(models, settings.model)).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <span>the composer's default, for a session with no profile</span>
        </div>
        <div className="aim-vfield">
          <b>Permission mode</b>
          <select className="aim-sel" value={settings.perm} onChange={(e) => onPatch({ perm: e.target.value })}>
            {PERMS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
          <span>what it may do unasked</span>
        </div>
        <div className="aim-vfield">
          <b>Effort</b>
          <select className="aim-sel" value={settings.effort} onChange={(e) => onPatch({ effort: e.target.value })}>
            {EFFORTS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
          <span>how hard it thinks</span>
        </div>
      </div>
      <div className="aim-vfields two">
        {aiFeatures.ponytail && (
          <div className="aim-vfield row">
            <div><b>Ponytail</b><span>how much it trims — this browser's</span></div>
            <select className="aim-sel" value={settings.ponytail} onChange={(e) => onPatch({ ponytail: e.target.value })}>
              {PONYTAILS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </div>
        )}
        <div className="aim-vfield row">
          <div><b>All models</b><span>list every model, not just the latest of each family</span></div>
          <Switch on={settings.allModels} onClick={() => onPatch({ allModels: !settings.allModels })} />
        </div>
      </div>
      <div className="aim-hint" style={{ marginTop: 12 }}>
        Model, mode and effort belong to the open session — a pick is saved to it and follows it to every surface.
      </div>
    </>
  );

  return (
    <div className="aim">
      <AimFold id="accounts" title="Accounts" secs={["ACCOUNTS", "ON USAGE LIMIT", "CLAUDE LOGINS", "AGENTS"]} openSec={openSec}
        count={acc.rows ? `${acc.rows.length} login${acc.rows.length === 1 ? "" : "s"} · ${list.length} profile${list.length === 1 ? "" : "s"}` : null}
        right={policyPick}>
        {accountsBody}
      </AimFold>
      <AimFold id="skills" title="Skills" secs={["SKILLS", "MODEL-SPENDING EXTRAS"]} openSec={openSec}
        hint="installed here and on this machine, the catalog, and the extras that spend model calls">
        <SkillsFold project={project} />
      </AimFold>
      <AimFold id="mcp" title="MCP" secs={["MCP SERVERS", "ADD A SERVER", "MCP"]} openSec={openSec} hint="servers and their logins">
        <McpPanel />
      </AimFold>
      <AimFold id="defprofile" title="Default profile" secs={["PROFILES", "RUN DEFAULTS"]} openSec={openSec}
        count={defaultName ?? (profilesAvailable ? "the first login's" : null)} hint="what a session gets unless its project names one">
        {profilesBody}
      </AimFold>
      <AimFold id="projects" title="Projects" secs={["PROJECTS"]} openSec={openSec}
        count={`${projects.groups.length} repo${projects.groups.length === 1 ? "" : "s"}`} hint="which profile each starts with · rename, hide, import">
        <ProjectsSettings {...projects} logins={acc.rows ?? []} />
      </AimFold>
    </div>
  );
}

// ---- MOVE -------------------------------------------------------------------
// Export this bridge to one file, or import a file from another machine. The
// bridge runs both (bridge/movejob.py); the dock (MoveDock.tsx) draws their
// progress. Three pages under one strip, like INDICATOR's picker: what goes,
// what comes in, and how the bar looks.

type MoveSub = "export" | "import";
const MOVE_SUBS: { key: MoveSub; label: string; icon: LucideIcon }[] = [
  { key: "export", label: "EXPORT", icon: HardDriveUpload },
  { key: "import", label: "IMPORT", icon: HardDriveDownload },
];
const MOVE_GROUP: Record<MoveSectionKey, string> = {
  repos: "REPOS", mcp: "MCP SERVERS", plugins: "PLUGINS", claude: "CLAUDE CODE", history: "HISTORY", bridge: "BRIDGE",
};
const TN = {
  warn: "var(--warn)", mid: "var(--txm)", vio: "var(--purple)", acc: "var(--acc)", dim: "var(--txl)", err: "var(--err)",
};
type ChipSpec = [string, string];
// What an item would do here, as the IMPORT list says it.
const DO_CHIP: Record<string, ChipSpec> = {
  clone: ["CLONE", TN.acc], add: ["ADD", TN.acc], merge: ["MERGE", TN.mid], present: ["ALREADY HERE", TN.dim],
  skip: ["SOMETHING ELSE IS THERE", TN.warn], keep: ["THIS MACHINE'S STAYS", TN.mid],
  behind: ["LEFT BEHIND", TN.warn], park: ["PARKED", TN.dim], fail: ["FAILS", TN.err],
};
// Items an import can't do anything with: no box to tick.
const MOVE_NA = new Set(["present", "skip", "behind"]);
const plural = (n: number, one: string, many = one + (one === one.toUpperCase() ? "S" : "s")) => `${n} ${n === 1 ? one : many}`;

function MoveChip({ c }: { c: ChipSpec }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", fontSize: "var(--t8)", letterSpacing: 1, padding: "1px 6px",
      border: `1px solid color-mix(in srgb, ${c[1]} 35%, transparent)`, color: c[1], whiteSpace: "nowrap", lineHeight: 1.6,
    }}>
      {c[0]}
    </span>
  );
}

function itemChips(sec: MoveSectionKey, it: MoveItem, mode: "export" | "import"): ChipSpec[] {
  const c: ChipSpec[] = [];
  if (mode === "import" && it.do && DO_CHIP[it.do]) c.push(DO_CHIP[it.do]);
  if (sec === "repos") {
    if (it.unpushed) c.push([mode === "import" ? `+${plural(it.unpushed, "COMMIT")}` : `${it.unpushed} UNPUSHED`, TN.warn]);
    if (it.uncommitted) c.push(["UNCOMMITTED", TN.warn]);
    if (it.worktrees) c.push([plural(it.worktrees, "WORKTREE"), TN.mid]);
    if (it.stashes) c.push([plural(it.stashes, "STASH", "STASHES"), TN.mid]);
    if (it.config) c.push([it.config === 1 ? ".ENV" : `${it.config} .ENV`, TN.vio]);
    if (mode === "import" && it.files) c.push([plural(it.files, "FILE"), TN.mid]);
    if (mode === "export" && it.untracked) c.push([`${it.untracked} UNTRACKED`, TN.mid]);
    if (mode === "export" && (it.mystical ?? 0) >= 1024) c.push([`.MYSTICAL ${fmtBytes(it.mystical).toUpperCase()}`, TN.mid]);
    if (mode === "export" && it.remote === false) c.push(["NO REMOTE", TN.warn]);
    if (mode === "export" && !c.length) c.push(["CLONE ONLY", TN.dim]);
  }
  if (sec === "mcp" && it.oauth) c.push([mode === "import" ? "LOGIN AFTER" : "OAUTH", TN.warn]);
  if (sec === "plugins" && it.marketplace) c.push(["MARKETPLACE", TN.dim]);
  if (sec === "claude" && it.hook) c.push(["HOOK SCRIPT", TN.dim]);
  if (sec === "history" && it.transcripts) c.push([plural(it.transcripts, "TRANSCRIPT"), TN.mid]);
  if ((sec === "history" || sec === "bridge") && it.bytes) c.push([fmtBytes(it.bytes).toUpperCase(), TN.dim]);
  if (sec === "bridge") {
    if (it.keys) c.push([plural(it.keys, "KEY"), TN.mid]);
    if (it.add) c.push([`+${plural(it.add, "KEY")}`, TN.acc]);
    if (it.local || it.behind) c.push([`${it.local || it.behind} STAY`, TN.dim]);
    if (it.off?.length) c.push(["ARRIVES OFF", TN.warn]);
  }
  return c;
}

/** What a group's row says under its name. */
function groupSummary(sec: MoveSection, mode: "export" | "import", ctx: { loose?: string[]; from?: string; here?: string }): string {
  const it = sec.items;
  const sum = (f: (x: MoveItem) => number) => it.reduce((a, x) => a + f(x), 0);
  if (!it.length) return "Nothing here.";
  if (mode === "import") {
    if (sec.key === "repos") {
      const n = (d: string) => it.filter((x) => x.do === d).length;
      return [n("clone") && `${n("clone")} to clone`, n("present") && `${n("present")} already here`,
        n("skip") && `${n("skip")} where something else is`].filter(Boolean).join(" · ");
    }
    if (sec.key === "claude") return "Skills, agents and a CLAUDE.md that already exist here stay as they are.";
    if (sec.key === "history" && ctx.from && ctx.here) return `Paths rewritten from ${ctx.from} to ${ctx.here}, so History lists them and they resume.`;
    return "";
  }
  if (sec.key === "repos") {
    const bits = [sum((x) => x.unpushed ?? 0) && `${sum((x) => x.unpushed ?? 0)} commits no remote has`,
      sum((x) => x.stashes ?? 0) && plural(sum((x) => x.stashes ?? 0), "stash", "stashes"),
      sum((x) => (x.uncommitted ? 1 : 0)) && `uncommitted work in ${sum((x) => (x.uncommitted ? 1 : 0))}`,
      sum((x) => x.worktrees ?? 0) && plural(sum((x) => x.worktrees ?? 0), "worktree")].filter(Boolean);
    return `${bits.length ? `${bits.join(" · ")}. ` : ""}Each repo is cloned again from its remote there; the file carries only what the remote lacks.` +
      (ctx.loose?.length ? ` Not git, so left behind: ${ctx.loose.slice(0, 6).join(", ")}${ctx.loose.length > 6 ? " …" : ""}.` : "");
  }
  if (sec.key === "mcp") {
    const o = it.filter((x) => x.oauth).length;
    return `${it.slice(0, 5).map((x) => x.ref).join(", ")}${it.length > 5 ? ` +${it.length - 5}` : ""}.` +
      (o ? ` The ${o} that sign in with OAuth arrive logged out.` : "");
  }
  if (sec.key === "plugins") {
    const p = it.filter((x) => !x.marketplace), mk = it.length - p.length;
    return `${p.slice(0, 4).map((x) => x.ref.split("@")[0]).join(", ")}${p.length > 4 ? ` +${p.length - 4}` : ""}${mk ? `, from ${plural(mk, "marketplace", "marketplaces").toLowerCase()}` : ""}.`;
  }
  if (sec.key === "claude") {
    const dirs = new Map<string, number>();
    for (const x of it) if (x.dir) dirs.set(x.dir, (dirs.get(x.dir) ?? 0) + 1);
    return [...it.filter((x) => !x.dir && !x.hook).map((x) => x.ref),
      ...[...dirs].map(([d, n]) => `${n} ${n === 1 ? d.replace(/s$/, "") : d}`),
      it.some((x) => x.hook) && "the scripts your hooks run"].filter(Boolean).join(" · ") + ".";
  }
  if (sec.key === "history") {
    const proj = it.filter((x) => x.ref !== "prompts");
    return `${sum((x) => x.transcripts ?? 0)} transcripts in ${proj.length} projects, ${fmtBytes(sum((x) => x.bytes ?? 0))}.`;
  }
  const env = it.find((x) => x.ref === ".env"), db = it.find((x) => x.ref === "bridge.db");
  const state = it.filter((x) => x !== env && x !== db).length;
  return [env && `.env without its ${env.local ?? 0} per-machine keys`, state && plural(state, "settings file"),
    db && `a bridge.db snapshot (${fmtBytes(db.bytes)}), parked on arrival, not merged`].filter(Boolean).join(" · ") + ".";
}

function MoveCheck({ state, onClick, label }: { state: "on" | "off" | "part" | "na"; onClick?: () => void; label: string }) {
  return (
    <button
      role="checkbox"
      aria-checked={state === "on" ? true : state === "part" ? "mixed" : false}
      aria-label={label}
      disabled={state === "na"}
      onClick={onClick}
      style={{
        appearance: "none", width: 12, height: 12, padding: 0, flex: "none", position: "relative", background: "transparent",
        cursor: state === "na" ? "default" : "pointer",
        border: `1px ${state === "na" ? "dashed" : "solid"} color-mix(in srgb, var(--acc) ${state === "na" ? 22 : 50}%, transparent)`,
      }}
    >
      {state === "on" && <i style={{ position: "absolute", inset: 2, background: "var(--acc)" }} />}
      {state === "part" && <i style={{ position: "absolute", left: 2, right: 2, top: 4, height: 2, background: "var(--acc)" }} />}
    </button>
  );
}

const SHOW_ITEMS = 10;   // a group's items shown before "+N MORE"

/** One group of the EXPORT or IMPORT list: a tri-state box for the whole
 *  section, its summary, and the items under it when opened. */
function MoveGroup({ sec, mode, skip, setSkip, open, onOpen, first, ctx }: {
  sec: MoveSection; mode: "export" | "import"; skip: Set<string>; setSkip: (f: (s: Set<string>) => Set<string>) => void;
  open: boolean; onOpen: () => void; first: boolean; ctx: { loose?: string[]; from?: string; here?: string };
}) {
  const [all, setAll] = useState(false);
  const na = (x: MoveItem) => mode === "import" && MOVE_NA.has(x.do ?? "");
  const live = sec.items.filter((x) => !na(x));
  const off = live.filter((x) => skip.has(`${sec.key}:${x.ref}`)).length;
  const state = !live.length ? "na" : off === 0 ? "on" : off === live.length ? "off" : "part";
  const flip = () => setSkip((s) => {
    const n = new Set(s);
    for (const x of live) { const k = `${sec.key}:${x.ref}`; if (state === "off") n.delete(k); else n.add(k); }
    return n;
  });
  // Work no remote has first: unpushed commits, then uncommitted changes, then
  // stashes and worktrees, then loose files. Ten rows in, a clean repo can wait.
  const weight = (x: MoveItem) => (x.unpushed ? 8 : 0) + (x.uncommitted ? 4 : 0) +
    (x.stashes || x.worktrees ? 2 : 0) + (x.config || x.untracked ? 1 : 0);
  const items = sec.key === "repos" ? [...sec.items].sort((a, b) => weight(b) - weight(a)) : sec.items;
  const shown = all ? items : items.slice(0, SHOW_ITEMS);
  const groupChips: ChipSpec[] = [];
  if (mode === "import" && sec.key !== "repos") {
    const n = new Map<string, number>();
    for (const x of sec.items) if (x.do && DO_CHIP[x.do]) n.set(x.do, (n.get(x.do) ?? 0) + 1);
    for (const [d, k] of n) groupChips.push([`${k} ${DO_CHIP[d][0]}`, DO_CHIP[d][1]]);
    const o = sec.items.filter((x) => x.oauth).length;
    if (sec.key === "mcp" && o) groupChips.push([`${o} NEED A LOGIN AFTER`, TN.warn]);
    if (sec.key === "bridge" && sec.items.some((x) => x.off?.length)) groupChips.push(["RIVENDELL ARRIVES OFF", TN.warn]);
  }
  const summary = groupSummary(sec, mode, ctx) + (mode === "export" && off && state === "part" ? ` ${off} unticked.` : "");
  return (
    <div data-row={MOVE_GROUP[sec.key]} style={{ marginTop: first ? 0 : 13, paddingTop: first ? 0 : 13, borderTop: first ? undefined : RULE }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 11 }}>
        <span style={{ marginTop: 2 }}><MoveCheck state={state} onClick={flip} label={MOVE_GROUP[sec.key]} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <button onClick={onOpen} aria-expanded={open} disabled={!sec.items.length}
            style={{ appearance: "none", border: 0, background: "none", padding: 0, width: "100%", cursor: sec.items.length ? "pointer" : "default", display: "flex", alignItems: "center", gap: 8, fontFamily: "inherit", textAlign: "left" }}>
            <span style={{ fontSize: "var(--t10)", letterSpacing: 1.5, color: state === "off" ? "var(--txl)" : "var(--txb)" }}>{MOVE_GROUP[sec.key]}</span>
            {sec.items.length > 0 && <span style={{ fontFamily: "var(--mono)", fontSize: "var(--t10)", color: state === "off" ? "var(--txl)" : "var(--txm)" }}>{sec.items.length}</span>}
            <span style={{ flex: 1 }} />
            {sec.items.length > 0 && (open ? <ChevronDown size={13} color="var(--txd)" /> : <ChevronRight size={13} color="var(--txd)" />)}
          </button>
          {summary && <div style={{ fontSize: "var(--t95)", color: "var(--txd)", marginTop: 4, lineHeight: 1.6 }}>{summary}</div>}
          {groupChips.length > 0 && <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 6 }}>{groupChips.map((c) => <MoveChip key={c[0]} c={c} />)}</div>}
          {open && (
            <div style={{ margin: "11px 0 2px", borderLeft: "1px dashed color-mix(in srgb, var(--acc) 16%, transparent)", paddingLeft: 12 }}>
              {shown.map((x) => {
                const k = `${sec.key}:${x.ref}`;
                const s = na(x) ? "na" : skip.has(k) ? "off" : "on";
                return (
                  <div key={x.ref} style={{ display: "flex", alignItems: "center", gap: 9, padding: "4px 0", minHeight: 24 }}>
                    <MoveCheck state={s} label={x.ref}
                      onClick={() => setSkip((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; })} />
                    <span title={x.ref} style={{ fontFamily: "var(--mono)", fontSize: "var(--t105)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, color: s === "off" ? "var(--txl)" : s === "na" ? "var(--txf)" : "var(--tx)" }}>
                      {x.label ?? x.ref}
                    </span>
                    <span style={{ display: "flex", gap: 4, flex: "none", marginLeft: "auto" }}>
                      {itemChips(sec.key, x, mode).map((c) => <MoveChip key={c[0]} c={c} />)}
                    </span>
                  </div>
                );
              })}
              {items.length > SHOW_ITEMS && (
                <button onClick={() => setAll(!all)} style={{ appearance: "none", border: 0, background: "none", cursor: "pointer", padding: "6px 0 2px", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1, color: "var(--txd)" }}>
                  {all ? "− FEWER" : `+ ${items.length - SHOW_ITEMS} MORE`}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The skip list the bridge takes: a whole section when none of it is ticked. */
function toSkip(sections: MoveSection[], skip: Set<string>, mode: "export" | "import"): string[] {
  const out: string[] = [];
  for (const s of sections) {
    const live = s.items.filter((x) => !(mode === "import" && MOVE_NA.has(x.do ?? "")));
    const off = live.filter((x) => skip.has(`${s.key}:${x.ref}`));
    if (live.length && off.length === live.length) out.push(s.key);
    else out.push(...off.map((x) => `${s.key}:${x.ref}`));
  }
  return out;
}

function MoveList({ sections, mode, skip, setSkip, ctx, stays }: {
  sections: MoveSection[]; mode: "export" | "import"; skip: Set<string>;
  setSkip: (f: (s: Set<string>) => Set<string>) => void; ctx: { loose?: string[]; from?: string; here?: string }; stays: string;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(["repos"]));
  return (
    <div style={CARD}>
      {sections.map((s, i) => (
        <MoveGroup key={s.key} sec={s} mode={mode} skip={skip} setSkip={setSkip} first={i === 0} ctx={ctx}
          open={open.has(s.key)} onOpen={() => setOpen((o) => { const n = new Set(o); if (n.has(s.key)) n.delete(s.key); else n.add(s.key); return n; })} />
      ))}
      <div style={{ marginTop: 13, paddingTop: 13, borderTop: RULE, display: "flex", gap: 11, alignItems: "flex-start" }}>
        <Lock size={12} strokeWidth={1.7} aria-hidden style={{ color: "var(--txf)", marginTop: 1, flex: "none" }} />
        <div>
          <div style={{ fontSize: "var(--t10)", letterSpacing: 1.5, color: "var(--txf)" }}>STAYS ON EACH MACHINE</div>
          <div style={{ fontSize: "var(--t95)", color: "var(--txf)", marginTop: 4, lineHeight: 1.6 }}>{stays}</div>
        </div>
      </div>
    </div>
  );
}

function BigBtn({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      appearance: "none", cursor: disabled ? "default" : "pointer", border: "1px solid var(--acc)", background: "var(--acc)",
      color: "var(--acc-on)", fontFamily: "inherit", fontSize: "var(--t11)", letterSpacing: 2, padding: "9px 20px",
      opacity: disabled ? 0.4 : 1, flex: "none",
    }}>
      {children}
    </button>
  );
}

const moved = () => window.dispatchEvent(new Event(MOVE_EVENT));
const isStale = (e: Error) => e.message === "not found";
const STALE_MSG = "The bridge is running older code than this dashboard, so it has no MOVE yet. Restart it (SYSTEM ▸ PLATFORM) and this page fills in.";

function MoveExport({ busy }: { busy: boolean }) {
  const [plan, setPlan] = useState<MovePlan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [skip, setSkip] = useState<Set<string>>(() => new Set());
  const [out, setOut] = useState("");
  const [startErr, setStartErr] = useState("");
  useEffect(() => {
    api.movePlan().then((p) => { setPlan(p); setOut(p.out); }, (e: Error) => setErr(isStale(e) ? STALE_MSG : `Couldn't look at this machine: ${e.message}`));
  }, []);
  if (err) return <Placeholder icon={TriangleAlert}>{err}</Placeholder>;
  if (!plan) return <Placeholder icon={LoaderCircle} spin>looking at this machine: its repos, MCP servers, history…</Placeholder>;
  const sk = toSkip(plan.sections, skip, "export");
  const count = (k: MoveSectionKey) => {
    const s = plan.sections.find((x) => x.key === k);
    return s && !sk.includes(k) ? s.items.filter((x) => !skip.has(`${k}:${x.ref}`)).length : 0;
  };
  const start = () => {
    setStartErr("");
    api.moveExport(out, sk).then(moved, (e: Error) => setStartErr(e.message));
  };
  return (
    <>
      <Section title="WHAT GOES" icon={Package}
        desc="Everything here that no remote keeps. Untick what the next machine shouldn't get."
        info="Repos are cloned again from their remotes on the next machine; the file carries only what no remote has: commits on no remote, stashes, the uncommitted diff, untracked files and git-ignored config such as .env. MCP servers and plugins go back through the claude CLI, and history is rewritten to the new home and BASE_PATH so it lists and resumes.">
        <MoveList sections={plan.sections} mode="export" skip={skip} setSkip={setSkip} ctx={{ loose: plan.loose }}
          stays="Logins (Claude, gh, MCP sign-ins), the Telegram bot token and chat list, BASE_PATH and the tunnel. Rivendell links arrive switched OFF." />
      </Section>
      <Section title="THE FILE" icon={FileArchive} top
        desc="Where the export is written. It holds secrets: move it straight to the next machine, import it, then delete it.">
        <div style={CARD}>
          <div style={{ ...CAPTION, width: "auto", marginBottom: 6 }}>SAVE AS</div>
          <input value={out} onChange={(e) => setOut(e.target.value)} spellCheck={false} aria-label="save as"
            style={{ ...field, width: "100%", fontFamily: "var(--mono)", letterSpacing: 0, fontSize: "var(--t105)" }} />
          <div style={{ ...NOTE, marginTop: 6 }}>Written so only you can read it (0600).</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 18 }}>
          <span style={{ fontSize: "var(--t95)", color: "var(--txd)", lineHeight: 1.6 }}>
            {busy ? "A move is running; follow it in the dock."
              : `${count("repos")} repos · ${count("mcp")} MCP · ${count("plugins")} plugins · ${count("claude") ? "Claude Code" : "no Claude Code"} · ${count("history")} history projects · ${count("bridge") ? "bridge" : "no bridge"}`}
          </span>
          <span style={{ flex: 1 }} />
          <BigBtn disabled={busy || !out.trim()} onClick={start}>▸ EXPORT</BigBtn>
        </div>
        {startErr && <div style={{ ...NOTE, color: "var(--err)", textAlign: "right" }}>{startErr}</div>}
      </Section>
    </>
  );
}

const dateOf = (t?: number) => (t ? new Date(t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

function MoveImported({ job }: { job: MoveJob }) {
  const [full, setFull] = useState(false);
  const rep = (job.result?.report ?? {}) as Record<string, Record<string, unknown[]>>;
  const list = (s: string, k: string) => rep[s]?.[k] ?? [];
  const nums = (s: string, k: string, re: RegExp) => list(s, k).reduce<number>((a, x) =>
    a + (typeof x === "number" ? x : Number(String(x).match(re)?.[1] ?? 0)), 0);
  const failed = Object.values(rep).reduce((a, sec) => a + (sec.failed?.length ?? 0), 0);
  const stats: [number, string, string?][] = [
    [list("repos", "cloned").length, "REPOS CLONED"], [list("repos", "worktrees").length, "WORKTREES"],
    [nums("repos", "unpushed", /: (\d+) commit/), "COMMITS RESTORED"], [nums("repos", "stashes", /: (\d+)$/), "STASHES"],
    [list("mcp", "added").length, "MCP SERVERS"], [list("plugins", "added").length, "PLUGINS"],
    [nums("history", "transcripts", /(\d+)/), "TRANSCRIPTS"],
    failed ? [failed, "FAILED", "var(--err)"] : [list("repos", "parked").length + list("bridge", "parked").length, "PARKED", "var(--txm)"],
  ];
  const next = job.next ?? [];
  return (
    <>
      <Section title="IMPORTED" icon={CircleCheck}
        desc={<>From {job.title}{job.ended ? ` on ${dateOf(job.ended)}` : ""}, in {fmtDur(job.elapsed)}. The full report is kept in <span style={{ fontFamily: "var(--mono)" }}>{job.result?.park}</span>.</>}>
        <div style={{ ...CARD, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "14px 18px" }}>
          {stats.map(([v, l, tone]) => (
            <div key={l} style={{ padding: "4px 0" }}>
              <div className="glow" style={{ fontSize: "var(--t22)", color: tone ?? "var(--txb)", lineHeight: 1.1 }}>{v}</div>
              <div style={{ fontSize: "var(--t8)", letterSpacing: 1.5, color: "var(--txd)", marginTop: 5 }}>{l}</div>
            </div>
          ))}
        </div>
      </Section>
      <Section title="WHAT'S LEFT" icon={ListChecks} top
        desc="Things only you can do. They stay on the dock card too, until you dismiss it.">
        {next.length === 0 ? (
          <Placeholder icon={CircleCheck}>Nothing left: it's all in.</Placeholder>
        ) : (
          <div style={CARD}>
            {next.map((n, i) => {
              const [label, act, danger] = nextAction(n);
              return (
                <Row key={n.key} first={i === 0}
                  label={<><span style={{ fontFamily: "var(--mono)", color: "var(--purple)", marginRight: 10 }}>{i + 1}</span><span style={{ color: "var(--txb)" }}>{nextLabel(n).toUpperCase()}</span></>}
                  desc={<>{n.text}{n.items?.length ? <> <span style={{ color: "var(--txm)" }}>{n.items.join(" · ")}</span></> : null}</>}>
                  <MiniBtn danger={danger} onClick={act}>{label}</MiniBtn>
                </Row>
              );
            })}
          </div>
        )}
      </Section>
      <Section title="FULL REPORT" icon={ScrollText} top>
        <div style={CARD}>
          <button onClick={() => setFull(!full)} aria-expanded={full} style={{ appearance: "none", border: 0, background: "none", padding: 0, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, width: "100%", fontFamily: "inherit" }}>
            {full ? <ChevronDown size={13} color="var(--txd)" /> : <ChevronRight size={13} color="var(--txd)" />}
            <span style={KEY_TX}>{full ? "HIDE" : "SHOW EVERY LINE"}</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: "var(--t95)", color: "var(--txd)" }}>
              {Object.entries(rep).map(([s, keys]) => `${s} ${Object.keys(keys).length}`).join(" · ")}
            </span>
          </button>
          {full && (
            <pre style={{ margin: "12px 0 0", fontFamily: "var(--mono)", fontSize: "var(--t95)", color: "var(--txm)", lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {Object.entries(rep).map(([s, keys]) => `${s}\n${Object.entries(keys).map(([k, items]) =>
                `  ${k}: ${items.every((x) => typeof x === "number") ? items.reduce<number>((a, x) => a + (x as number), 0) : items.join(", ")}`).join("\n")}`).join("\n")}
            </pre>
          )}
        </div>
      </Section>
      <div style={{ display: "flex", marginTop: 18 }}>
        <span style={{ flex: 1 }} />
        <MiniBtn onClick={() => void api.moveDismiss(job.id).then(moved)}>IMPORT ANOTHER FILE</MiniBtn>
      </div>
    </>
  );
}

function MoveImport({ jobs, busy }: { jobs: MoveJob[]; busy: boolean }) {
  const [files, setFiles] = useState<MoveFile[] | null>(null);
  const [read, setRead] = useState<MoveRead | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [startErr, setStartErr] = useState("");
  const [skip, setSkip] = useState<Set<string>>(() => new Set());
  const ended = jobs.filter((j) => j.status !== "running").map((j) => j.id).join();
  useEffect(() => {
    api.moveFiles().then((r) => setFiles(r.files), (e: Error) => setErr(isStale(e) ? STALE_MSG : e.message));
    api.moveRead().then((r) => setRead(r.read), () => setRead(null));
  }, [ended]);
  const running = jobs.find((j) => j.status === "running");
  const last = [...jobs].reverse().find((j) => j.kind === "import");
  const go = (p: Promise<unknown>) => { setStartErr(""); p.then(moved, (e: Error) => setStartErr(e.message)); };

  if (err) return <Placeholder icon={TriangleAlert}>{err}</Placeholder>;
  if (running && running.kind !== "export")
    return <Placeholder icon={LoaderCircle} spin>{running.kind === "read" ? `reading ${running.title}` : `importing from ${running.title}`}… follow it in the dock.</Placeholder>;
  if (last?.status === "done") return <MoveImported job={last} />;
  if (read === undefined || files === null) return <Placeholder icon={LoaderCircle} spin>looking for move files…</Placeholder>;

  if (read) {
    const sk = toSkip(read.sections, skip, "import");
    const count = (k: MoveSectionKey) => {
      const s = read.sections.find((x) => x.key === k);
      return s && !sk.includes(k) ? s.items.filter((x) => !MOVE_NA.has(x.do ?? "") && !skip.has(`${k}:${x.ref}`)).length : 0;
    };
    const f = read.from;
    return (
      <>
        <Section title="THE FILE" icon={FileArchive} desc="Read: unpacked and dry-run. Nothing here has changed yet.">
          <div style={CARD}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <FileArchive size={14} strokeWidth={1.7} color="var(--purple)" style={{ flex: "none" }} />
              <span style={{ fontFamily: "var(--mono)", fontSize: "var(--t105)", color: "var(--txb)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{read.file.split("/").pop()}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontFamily: "var(--mono)", fontSize: "var(--t95)", color: "var(--txd)" }}>{fmtBytes(read.bytes)}</span>
            </div>
            <div style={{ fontSize: "var(--t95)", color: "var(--txd)", marginTop: 5, paddingLeft: 22, fontFamily: "var(--mono)" }}>{read.file}</div>
            <div style={{ ...ASIDE, margin: "10px 0 0 22px", display: "grid", gridTemplateColumns: "44px 1fr", rowGap: 3 }}>
              <span style={{ letterSpacing: 1.5, color: "var(--txl)" }}>FROM</span>
              <span style={{ color: "var(--txm)" }}>{[f.host, f.platform, f.base].filter(Boolean).join(" · ")}</span>
              <span style={{ letterSpacing: 1.5, color: "var(--txl)" }}>MADE</span>
              <span style={{ color: "var(--txm)" }}>{[dateOf(f.at), f.mystical && `mystical ${f.mystical}`, f.claude].filter(Boolean).join(" · ")}</span>
              {read.only?.length ? <><span style={{ letterSpacing: 1.5, color: "var(--txl)" }}>ONLY</span><span style={{ color: "var(--txm)" }}>{read.only.join(", ")} (a top-up)</span></> : null}
            </div>
          </div>
        </Section>
        <Section title="WHAT COMES IN" icon={PackageOpen} top
          desc="What the file holds and what each part does here. This machine wins every conflict; whatever can't apply is parked, never dropped.">
          <MoveList sections={read.sections} mode="import" skip={skip} setSkip={setSkip}
            ctx={{ from: f.base, here: (read as MoveRead & { here?: string }).here }}
            stays="Your logins, bot token, BASE_PATH, DASH_TOKEN and tunnel. The per-machine .env keys in the file are skipped." />
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 18 }}>
            <span style={{ fontSize: "var(--t95)", color: "var(--txd)" }}>
              {busy ? "A move is running; follow it in the dock."
                : `${count("repos")} repos · ${count("plugins")} plugins · ${count("claude")} Claude files · ${count("mcp")} MCP · ${count("history")} history · ${count("bridge") ? "bridge" : "no bridge"}`}
            </span>
            <span style={{ flex: 1 }} />
            <MiniBtn disabled={busy} onClick={() => void api.moveForget().then(() => setRead(null))}>FORGET FILE</MiniBtn>
            <BigBtn disabled={busy} onClick={() => go(api.moveImport(sk))}>{last ? "▸ IMPORT AGAIN" : "▸ IMPORT"}</BigBtn>
          </div>
          {startErr && <div style={{ ...NOTE, color: "var(--err)", textAlign: "right" }}>{startErr}</div>}
        </Section>
      </>
    );
  }

  return (
    <Section title="THE FILE" icon={FileArchive}
      desc="Move files in your home, Downloads, Desktop and the bridge's incoming folder. READ unpacks one and works out what it would do; nothing changes until IMPORT.">
      <div style={CARD}>
        {files.length === 0 && (
          <div style={{ ...NOTE, marginTop: 0 }}>No mystical-move-*.tar.gz in those folders. Give its path below.</div>
        )}
        {files.map((x, i) => (
          <Row key={x.path} first={i === 0}
            label={<span style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--mono)", letterSpacing: 0, color: "var(--tx)" }}><FileArchive size={14} strokeWidth={1.7} color="var(--txd)" />{x.name}</span>}
            desc={<span style={{ paddingLeft: 22 }}>{x.dir} · {dateOf(x.mtime)} · {fmtBytes(x.bytes)}</span>}>
            <MiniBtn disabled={busy} onClick={() => go(api.moveStartRead(x.path))}>READ</MiniBtn>
          </Row>
        ))}
        <Row first={files.length === 0} label="OR A PATH">
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/path/to/mystical-move-….tar.gz" spellCheck={false}
            onKeyDown={(e) => { if (e.key === "Enter" && path.trim()) go(api.moveStartRead(path.trim())); }}
            style={{ ...field, width: 380, fontFamily: "var(--mono)", letterSpacing: 0 }} />
          <MiniBtn disabled={busy || !path.trim()} onClick={() => go(api.moveStartRead(path.trim()))}>READ</MiniBtn>
        </Row>
      </div>
      {startErr && <div style={{ ...NOTE, color: "var(--err)" }}>{startErr}</div>}
      {busy && <div style={NOTE}>A move is running; follow it in the dock.</div>}
    </Section>
  );
}

function MovePanel() {
  // The dock's SETTINGS ▸ and REVIEW ▸ name the page to land on.
  const [sub, setSub] = useState<MoveSub>(() => {
    const f = takeSettingsFocus();
    return f === "import" ? "import" : "export";
  });
  const [jobs, setJobs] = useState<MoveJob[]>([]);
  useEffect(() => {
    let t = 0;
    let live = true;
    const tick = () => {
      window.clearTimeout(t);
      api.moveJobs().then((r) => {
        if (!live) return;
        setJobs(r.jobs);
        t = window.setTimeout(tick, r.jobs.some((j) => j.status === "running") ? 1000 : 5000);
      }, () => { if (live) t = window.setTimeout(tick, 10000); });
    };
    tick();
    window.addEventListener(MOVE_EVENT, tick);
    return () => { live = false; window.clearTimeout(t); window.removeEventListener(MOVE_EVENT, tick); };
  }, []);
  const running = jobs.find((j) => j.status === "running");
  return (
    <>
      <div style={{ display: "flex", gap: 2, border: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)", background: "color-mix(in srgb, var(--panel) 92%, transparent)", marginBottom: 26 }}>
        {MOVE_SUBS.map((t) => {
          const on = sub === t.key;
          const dot = running && (t.key === "export" ? running.kind === "export" : t.key === "import" && running.kind !== "export");
          return (
            <button key={t.key} onClick={() => setSub(t.key)} aria-pressed={on}
              style={{ flex: 1, appearance: "none", cursor: "pointer", border: 0, borderBottom: `2px solid ${on ? "var(--acc)" : "transparent"}`, background: on ? "color-mix(in srgb, var(--acc) 14%, transparent)" : "transparent", color: on ? "var(--txb)" : "var(--txd)", fontFamily: "inherit", fontSize: "var(--t95)", letterSpacing: 1.5, padding: "9px 4px", display: "flex", alignItems: "center", justifyContent: "center", gap: 7 }}>
              <t.icon size={12} strokeWidth={1.7} aria-hidden />
              {t.label}
              {dot && <i style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--purple)", boxShadow: "0 0 6px var(--purple)" }} />}
            </button>
          );
        })}
      </div>
      {sub === "export" && <MoveExport busy={!!running} />}
      {sub === "import" && <MoveImport jobs={jobs} busy={!!running} />}
    </>
  );
}

export function SettingsModal(props: SettingsModalProps) {
  const {
    host,
    port,
    settings,
    onTheme,
    onToggle,
    onPatch,
    models,
    onFeed,
    onClose,
    sessionTools,
    profiles,
    profilesAvailable,
    profilesError,
    onProfilesChanged,
    onAccountsChanged,
    onOpenInspector,
    projects,
    project,
    startTab,
  } = props;

  // A caller may still name one of the tabs AI MANAGEMENT replaced; it lands
  // on that page, on the fold the tab became.
  const [start] = useState(() => normalizeTab(startTab));
  const startSec = start.sec;
  const [tab, setTab] = useState<Tab>(start.tab ?? "appearance");
  const aiFeatures = useAiFeatures();   // the PONYTAIL level hides with its switch
  // Search. A query replaces the panel with its results; picking one puts the
  // tab back and scrolls to the setting, so `q` is also "which view is this".
  const [q, setQ] = useState("");
  const [jump, setJump] = useState<Hit | null>(null);
  const [env, setEnv] = useState<EnvSetting[]>([]);
  const asked = useRef(false);
  const pane = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!q.trim() || asked.current) return;
    asked.current = true;   // one attempt: a failed fetch must not retry per keystroke
    void api.envSettings().then((r) => setEnv(r.settings)).catch(() => {});
  }, [q]);
  // Sections that exist only while their plugin is installed; AVAILABLE answers
  // for one that isn't, so a search never offers a card the page doesn't draw.
  const plugins = useIntegrations();
  const hidden = new Set(Object.entries(PLUGIN_SEC).filter(([id]) => !plugins[id]).map(([, sec]) => sec));
  if (!plugins.rivendell) hidden.add("ADD AN INSTANCE");
  const hits = search(q, env.filter((s) => !tunesOff(s.key, aiFeatures)), hidden);
  const shown: Tab | "search" = q.trim() ? "search" : tab;
  function go(h: Hit) {
    setTab(h.tab);
    setQ("");
    setJump(h);
  }
  // The panel a hit lives in may still be fetching (the environment registry,
  // the accounts list), so keep looking for a moment before giving up.
  useEffect(() => {
    if (!jump) return;
    let timer = 0;
    let tries = 0;
    const find = () => {
      const el = (jump.row && pane.current?.querySelector(`[data-row="${jump.row}"]`))
        || pane.current?.querySelector(`[data-sec="${jump.sec}"]`);
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        (el as HTMLElement).style.animation = "resultflash 1.2s ease both";
        setJump(null);
      } else if (++tries < 10) {
        timer = window.setTimeout(find, 150);
      }
    };
    find();
    return () => clearTimeout(timer);
  }, [jump]);
  // As a top strip the rail scrolls, and the browser's own scroll-on-click only
  // brings the tab just inside the edge — enough to leave the category you are
  // reading half off-screen. Centre it instead.
  const rail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    rail.current?.querySelector(".on")?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [tab]);
  // A category opens at its top. The pane is one scroller shared by every page,
  // so without this you landed wherever the last page left it — halfway down a
  // short page, or past its end. A layout effect so the old offset never paints;
  // a search hit still lands on its setting, because the jump effect above is a
  // plain effect and runs after this one.
  useLayoutEffect(() => { pane.current?.scrollTo(0, 0); }, [shown]);
  const autoBase = autoBaseFont(window.innerWidth, window.innerHeight);
  const [escHover, setEscHover] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [ground, setGround] = useState<"dark" | "light">(isLight(settings.theme) ? "light" : "dark");
  const crumbTab = TABS.find((t) => t.key === shown);

  return (
    <div
      className="setscrim"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "color-mix(in srgb, var(--panel3) 72%, transparent)",
        zIndex: 93,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "7vh",
        animation: "backdropIn .22s ease both",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="panel setdlg"
        style={{
          // Content is capped at 760px by .mcol; the family layer's rail is 236
          // and the pane pads 32 a side — so 1062 IS the content's width. Wider
          // is empty gutter (the shared --modal-w, 75vw, spent ~130px a side on
          // it); 976, sized for the old 180 rail, squeezed the rows to 674.
          width: "min(1062px, 94vw)",
          // One height for every category, not one per: sizing to the tab meant
          // the panel jumped ~200px between INTERFACE (one switch) and
          // APPEARANCE, and a dialog that resizes under the pointer costs more
          // than the void it saves. 86vh rather than the old 76vh — the tabs
          // that overflow are the ones you spend time in.
          height: "86vh",
          display: "flex",
          flexDirection: "column",
          border: "1px solid color-mix(in srgb, var(--acc) 40%, transparent)",
          background: "color-mix(in srgb, var(--panel2) 98%, transparent)",
          boxShadow: "0 0 70px var(--shadow-modal),0 0 30px color-mix(in srgb, var(--acc) 8%, transparent)",
          animation: "modalIn .46s cubic-bezier(.16,.84,.3,1) both",
        }}
      >
        {/* Header. The storage note used to stand in a footer bar under every
            tab — a permanent caption for a fact you need once. It folds behind
            the ⓘ here instead, the same way every long explanation in this
            modal already does. */}
        <div style={{ flex: "none", position: "relative" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 11,
            padding: "14px 18px",
          }}
        >
          <svg
            viewBox="0 0 24 24"
            width="17"
            height="17"
            fill="none"
            stroke="var(--acc)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flex: "none" }}
          >
            <circle cx="12" cy="12" r="3.2" />
            <path d="M12 3.3v2.4M12 18.3v2.4M20.7 12h-2.4M5.7 12H3.3M18.16 5.84l-1.7 1.7M7.54 16.46l-1.7 1.7M18.16 18.16l-1.7-1.7M7.54 7.54l-1.7-1.7" />
          </svg>
          <span className="set-crumb">Settings{crumbTab && <i><u>/</u> {sentence(crumbTab.label)}</i>}</span>
          <InfoDot on={scopeOpen} about="where these are stored" onClick={() => setScopeOpen(!scopeOpen)} />
          <span style={{ flex: 1 }}></span>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && hits.length) go(hits[0]);
              // Otherwise Escape would close the whole modal from inside the box.
              if (e.key === "Escape" && q) { e.stopPropagation(); setQ(""); }
            }}
            placeholder="Search settings"
            className="set-search"
            style={{ ...field, flex: "0 1 220px", minWidth: 140 }}
          />
          <button
            className="set-close"
            title="close (Esc)"
            onClick={onClose}
            onMouseEnter={() => setEscHover(true)}
            onMouseLeave={() => setEscHover(false)}
            style={{
              appearance: "none",
              cursor: "pointer",
              border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)",
              background: escHover ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent",
              color: "var(--txm)",
              fontFamily: "inherit",
              fontSize: "var(--t95)",
              letterSpacing: 1.5,
              padding: "4px 10px",
            }}
          >
            ✕
          </button>
        </div>
        {scopeOpen && (
          <div style={{ ...ASIDE, margin: "0 18px 12px" }}>
            Stored in this browser — except weather and the prompt check, which the bridge keeps
            for every client.
          </div>
        )}
        {/* The panel's drawline, not a flat rule: teal at the title, gone by the
            far edge, wiped in on open. */}
        <div className="set-drawline" style={{
          height: 1,
          background: "linear-gradient(90deg, color-mix(in srgb, var(--acc) 55%, transparent), color-mix(in srgb, var(--acc) 10%, transparent) 62%, transparent)",
          transformOrigin: "left",
          animation: "drawline .55s cubic-bezier(.2,.8,.2,1) .12s both",
        }} />
        </div>

        {/* Category rail + the active category's panel. Both the rail's own
            layout and its selected-tab marker live in index.css, which is what
            lets it turn from a side rail into a top strip on a phone. */}
        <div className="setbody">
          <div className="setrail" ref={rail}>
            {RAIL.map((t, i) => (
              <Fragment key={t.key}>
                {t.group !== RAIL[i - 1]?.group && <div className="setgroup">{sentence(t.group)}</div>}
                <button
                  className={tab === t.key ? "on" : undefined}
                  aria-current={tab === t.key ? "page" : undefined}
                  onClick={() => setTab(t.key)}
                  style={{ display: "flex", alignItems: "center", gap: 8 }}
                >
                  <t.icon size={14} strokeWidth={1.7} aria-hidden style={{ flex: "none" }} />
                  <div style={{ minWidth: 0 }}>
                    <div className="set-raillbl" style={{ fontSize: "var(--t10)", letterSpacing: 1.5 }}>{sentence(t.label)}</div>
                    <div className="hint"
                      style={{ fontSize: "var(--t85)", letterSpacing: 0.3, color: "var(--txl)", marginTop: 2 }}>
                      {t.hint}
                    </div>
                  </div>
                </button>
              </Fragment>
            ))}
          </div>

          <div ref={pane} className="mscroll mcol setpane" style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
            {/* Keyed on the page, so a new category remounts and its entrance
                runs again (.setpage in index.css). Search is a page too. */}
            <div key={shown} className="setpage">
            {shown !== "search" && <PageHead tab={TABS.find((t) => t.key === shown)!} />}
            {shown === "search" && (
              <Section icon={Search} title={`SEARCH · ${hits.length} MATCH${hits.length === 1 ? "" : "ES"}`}>
                {hits.length === 0 ? (
                  <Placeholder icon={Search}>Nothing here matches that.</Placeholder>
                ) : (
                  <div style={CARD}>
                    {hits.map((h, i) => (
                      <Row
                        key={`${h.tab}${h.sec}${h.row ?? ""}`}
                        first={!i}
                        label={h.row ?? h.sec}
                        desc={
                          <>
                            <span style={{ color: "var(--txd)" }}>
                              {TABS.find((t) => t.key === h.tab)!.label}
                              {h.row ? ` · ${h.sec}` : ""}
                            </span>
                            {h.hint ? ` — ${h.hint}` : ""}
                          </>
                        }
                      >
                        <MiniBtn onClick={() => go(h)}>GO</MiniBtn>
                      </Row>
                    ))}
                  </div>
                )}
              </Section>
            )}

            {shown === "appearance" && (
              <>
                {/* One theme grid behind a Dark/Light switch; the switch shows each
                    family's colourings on that ground, it does not change theme. */}
                <div className="set-sec" data-sec="THEME">
                  <div className="set-themehead">
                    <b>Theme</b>
                    <div className="set-seg2">
                      {(["dark", "light"] as const).map((g) => (
                        <button key={g} data-on={ground === g || undefined} onClick={() => setGround(g)}>{g === "dark" ? "Dark" : "Light"}</button>
                      ))}
                    </div>
                  </div>
                  <ThemeGrid light={ground === "light"} settings={settings} onTheme={onTheme} />
                </div>

                {themeHasCrt(settings.theme) && (
                  <Section
                    title="CRT EFFECTS"
                    top
                    info="Kept when you change phosphor; reset when you switch family. Claude and Flint have no CRT layer at all."
                  >
                    <CrtToggles settings={settings} onToggle={onToggle} />
                  </Section>
                )}

                <Section title="HEADER" top>
                  <HeaderStyles settings={settings} onHeader={(headerStyle) => onPatch({ headerStyle })} />
                </Section>

                {/* One block, not two: a section heading and a fold-out
                    paragraph each, for one control each, spent more of the tab
                    on the frame than on the two controls it framed. */}
                <Section
                  title="TYPE"
                  top
                  info={
                    <>
                      A theme is a palette; the type voice is yours.{" "}
                      <span style={{ color: "var(--txd)" }}>Theme</span> follows whichever one the
                      palette brought — anything else stays put when you switch palettes. Code and
                      logs keep their monospace either way. Every size in the HUD derives from the
                      base: captions, body and headings move together, spacing stays put, and{" "}
                      <span style={{ color: "var(--txd)" }}>Auto</span> tracks the window ({autoBase}px
                      on this one). Point at a face in the menu to see it in the preview first.
                    </>
                  }
                >
                  <TypePicker settings={settings} autoBase={autoBase} onPatch={onPatch} />
                </Section>

              </>
            )}

            {shown === "transcript" && (
              <>
                {/* Its own tab, again. It was folded into APPEARANCE when it
                    held one switch and a dropdown and left 700px of void; the
                    dropdown is now five previews, which is the page that void
                    was waiting for. Still a reading preference, so it stays
                    under THE HUD rather than with the run knobs. */}
                <Section
                  title="LAYOUT"
                  info="DEFAULT is the nameplate header over a row of run dropdowns. COMPACT reads as a chat: your prompt on the right and replies on the left, neither wider than 80%; the header shrinks to a pill of readouts on the right; the session's title, project and branch move down beside the context meter; and model, permission mode and effort fold into one popover above SEND."
                >
                  <div style={CARD}>
                    <Row first label="CHAT LAYOUT" desc="how the chat column is arranged">
                      <div style={{ width: 220 }}>
                        <Segmented
                          options={[{ label: "DEFAULT", value: "default" }, { label: "COMPACT", value: "compact" }]}
                          value={settings.layout}
                          onPick={(layout) => onPatch({ layout })}
                        />
                      </div>
                    </Row>
                    {/* COMPACT's composer (lib/theme COMPOSER_STYLES): the session as tabs on
                        the box, as status lines under a bare
                        command line, or the CLASSIC one row. DEFAULT never reads it. */}
                    <Row label="PROMPT BOX" desc="how the COMPACT layout's prompt box carries the session"
                      info="TABS (the default): the title, branch, PR, running app and context meter as folder tabs on the box's top edge, the tools in the box's footer. CONSOLE: no box; a command line with an accent bar, then a place line and a quiet settings line. CLASSIC: the prompt box as it was, the session's nameplate sharing one row with the tools above the box. The DEFAULT layout keeps its own row whichever you pick.">
                      <div style={{ width: 280 }}>
                        <Segmented
                          options={[{ label: "TABS", value: "tabs" }, { label: "CONSOLE", value: "console" }, { label: "CLASSIC", value: "classic" }]}
                          value={settings.composer}
                          onPick={(composer) => onPatch({ composer })}
                        />
                      </div>
                    </Row>
                  </div>
                </Section>

                <Section
                  title="COMPOSER"
                  top
                  info="ENTER sends on Enter, and Shift+Enter starts a new line. CTRL+ENTER swaps them: Enter starts a new line and Ctrl+Enter (Cmd+Enter on a Mac) sends — for prompts you write across several lines."
                >
                  <div style={CARD}>
                    <Row first label="SEND KEY" desc="which key sends the message">
                      <div style={{ width: 220 }}>
                        <Segmented
                          options={[{ label: "ENTER", value: "enter" }, { label: "CTRL+ENTER", value: "ctrl-enter" }]}
                          value={settings.sendKey}
                          onPick={(sendKey) => onPatch({ sendKey })}
                        />
                      </div>
                    </Row>
                  </div>
                </Section>


                <Section
                  title="THE GROUND"
                  top
                  info="The texture the transcript is read on. Four hairline patterns drawn at the ghost ink tier, three tones — grain, a lamp, a haze — with no edge to cross a word, and none. All are pinned to the column so they don't slide under the words. Under a hairline pattern the answer sits on a mat the colour of the column, so the pattern lives in the margins and the gaps between turns."
                >
                  <ChatBgPicker
                    value={settings.chatBg}
                    onPick={(chatBg) => onPatch({ chatBg })}
                  />
                </Section>

                <Section title="RESULTS" top>
                  <div style={CARD}>
                    <Row
                      first
                      label="AUTO-OPEN RESULTS"
                      info="Bash output and edit diffs draw themselves open. Off, a turn reads as the list of commands and files it touched — click one to see its result."
                    >
                      <Switch
                        on={settings.openResults}
                        onClick={() => onPatch({ openResults: !settings.openResults })}
                      />
                    </Row>
                    <Row
                      label="COLLAPSE STEPS"
                      info="Between two things the agent says or thinks, everything it ran, edited or read sits under one STEPS row — the row names the count. On, it mounts shut and the words are what you see; off, it mounts open and the transcript reads as the full ledger. A click on any one row moves only that row. Thoughts are never folded."
                    >
                      <Switch
                        on={!settings.foldsOpen}
                        onClick={() => onPatch({ foldsOpen: !settings.foldsOpen })}
                      />
                    </Row>
                  </div>
                </Section>
                <Section title="WHILE IT WORKS" top>
                  <div style={CARD}>
                    <Row first label="WORKING INDICATOR" desc="STATUS is one quiet line: what is running right now, and for how long. EQUALIZER is the braille spinner with level bars. NYAN CAT is a nyan.cat ride — 36 cats, their trails, their music. ORBIT is the WORK card itself: a comet on its node while a tool runs, a ripple while the model thinks. Every form lives in the WORK card while a turn runs.">
                      <div style={{ width: 360 }}>
                        <Segmented
                          options={[{ label: "EQUALIZER", value: "bar" }, { label: "STATUS", value: "status" }, { label: "NYAN CAT", value: "nyan" }, { label: "ORBIT", value: "orbit" }]}
                          value={settings.indicator}
                          onPick={(indicator) => onPatch({ indicator })}
                        />
                      </div>
                    </Row>
                    {settings.indicator === "nyan" && (
                      <>
                        <Row label="CAT">
                          <span style={{ fontSize: "var(--t11)", color: "var(--tx)" }}>{nyanLabel(settings.nyan)}</span>
                        </Row>
                        <div
                          className="mscroll"
                          style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(52px,1fr))", gap: 5, maxHeight: 172, overflowY: "auto", marginTop: 11 }}
                        >
                          {NYAN_MODES.map((m) => {
                            const on = settings.nyan === m.key;
                            return (
                              <button
                                key={m.key}
                                onClick={() => onPatch({ nyan: m.key })}
                                title={m.label}
                                aria-pressed={on}
                                style={{
                                  appearance: "none",
                                  cursor: "pointer",
                                  padding: 3,
                                  lineHeight: 0,
                                  background: on ? "color-mix(in srgb, var(--acc) 20%, transparent)" : "var(--panel3)",
                                  border: `1px solid ${on ? "var(--acc)" : "color-mix(in srgb, var(--acc) 14%, transparent)"}`,
                                }}
                              >
                                <img src={nyanThumb(m.thumb)} alt={m.label} loading="lazy" style={{ width: "100%", display: "block" }} />
                              </button>
                            );
                          })}
                        </div>
                        <Row label="SOUND" desc="MATCH THE CAT plays the picked cat's own track; MUTE plays none.">
                          <select
                            value={settings.nyanSound}
                            onChange={(e) => onPatch({ nyanSound: e.target.value as NyanSound })}
                            style={{ ...field, flex: "0 1 200px", minWidth: 0 }}
                          >
                            <option value="match">MATCH THE CAT</option>
                            <option value="off">MUTE</option>
                            {NYAN_MODES.map((m) => (
                              <option key={m.key} value={m.key}>
                                {m.label}
                              </option>
                            ))}
                          </select>
                          <Volume
                            value={settings.nyanVolume}
                            disabled={settings.nyanSound === "off"}
                            onChange={(nyanVolume) => onPatch({ nyanVolume })}
                          />
                        </Row>
                        <Row label="EXTRA ANIMATIONS" desc="fly the cat, draw nyan.cat's rainbow trail + pixel stars">
                          <Switch on={settings.nyanExtra} onClick={() => onPatch({ nyanExtra: !settings.nyanExtra })} />
                        </Row>
                      </>
                    )}
                  </div>
                </Section>
              </>
            )}



            {shown === "notifications" && <NotifyPanel settings={settings} onPatch={onPatch} />}

            {shown === "aimgmt" && (
              <AiManagementPanel settings={settings} onPatch={onPatch} models={models} sessionTools={sessionTools}
                profiles={profiles} profilesAvailable={profilesAvailable} profilesError={profilesError}
                onProfilesChanged={onProfilesChanged} onAccountsChanged={onAccountsChanged}
                projects={projects} project={project} openSec={jump?.sec ?? startSec} />
            )}
            {shown === "integrations" && <IntegrationsPanel />}
            {shown === "move" && <MovePanel />}
            {shown === "mac" && <MacPanel />}

            {shown === "system" && (
              <>
                <Section title="BRIDGE">
                  <div style={CARD}>
                    <Row first label="HOST">
                      <span style={{ fontSize: "var(--t11)", color: "var(--tx)" }}>{host}</span>
                    </Row>
                    <Row label="PORT">
                      <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t11)", color: "var(--tx)" }}>
                        {port}
                      </span>
                    </Row>
                  </div>
                </Section>

                <StartupSection />

                <Section title="HTTP INSPECTOR" top>
                  <div style={CARD}>
                    <Row
                      first
                      label="API TRAFFIC"
                      info="Every request a run makes to the Anthropic API — its token accounting, its SSE frames, its timings — through a local pass-through proxy. Off by default: it sits on the critical path of the turns it watches."
                    >
                      <button onClick={onOpenInspector}
                        style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)", background: "transparent", color: "var(--acc)", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1.5, padding: "6px 12px", flex: "none" }}>
                        OPEN
                      </button>
                    </Row>
                  </div>
                </Section>

                <Section
                  title="PLATFORM"
                  top
                  info="Updating pulls the bridge's own checkout, rebuilds this dashboard and restarts the bridge; running turns resume on their own."
                >
                  <UpdatePanel onFeed={onFeed} />
                </Section>

                {/* Everything config.py reads from the environment, which until
                    now meant a text editor and a restart to change. */}
                <EnvPanel />
              </>
            )}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
