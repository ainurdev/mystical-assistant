import {
  Fragment, useCallback, useEffect, useRef, useState, useSyncExternalStore,
  type CSSProperties, type ReactNode,
} from "react";
import {
  Activity, AudioLines, Bell, Bookmark, Boxes, Cable, CircleCheck, CloudSun,
  Ellipsis, FileCog, FolderTree, Gauge, GitBranch, GitCommitVertical, GraduationCap,
  Handshake, Hourglass, KeyRound, ListMusic, ListTodo, ListTree, LoaderCircle, Lock,
  MessageCircleQuestion, Monitor, MonitorPlay, Moon, Network, Palette, PenLine, Play, Plug,
  Power, Radio, ScanLine, Scissors, ScrollText, Search, Server, Shapes,
  ShieldQuestion, SlidersHorizontal, Sparkles, SquareTerminal, Sun, Tag, TriangleAlert, Type,
  Upload, Volume2, Waypoints, X, type LucideIcon,
} from "lucide-react";
import { TOOL_STYLES, type ToolStyle, type ToolWidgetSpec } from "../../lib/toolwidget";
import { ToolWidget } from "../ResultWidgets";
import { toolAccent } from "../../lib/tools";

import { ago } from "../../lib/surfaces";
import {
  api,
  type AccountInfo,
  type AgentConfigTool,
  type AiFeature,
  type EnvSetting,
  type FreeAgentInfo,
  type HooksInfo,
  type FreeAgents,
  type McpInfo,
  type StartupState,
  type TagCount,
  type UpdateInfo,
  type Weather,
} from "../../api";
import {
  canInstall as canInstallNow, install, isInstalled, subscribe,
} from "../../lib/installprompt";
import {
  autoBaseFont,
  AURORA_KEYS,
  BASE_FONTS,
  CLAUDE_KEYS,
  FONTS,
  fontStack,
  isLight,
  THEME_DEFS,
  themeCompensator,
  themeDef,
  themeHasCrt,
  themeUnfilter,
  type HudSettings,
  type Indicator,
  type ThemeKey,
} from "../../lib/theme";
import { describe, loadProfiles, saveProfiles, type Profile } from "../../lib/profiles";
import { NYAN_MODES, nyanThumb, type NyanSound } from "../../lib/nyan";
import { VOICES, VOICE_GROUPS } from "../../lib/piano";
import { SONGS, TILE_SPEEDS, type TileSpeed } from "../../lib/songs";
import { RADIO_STATIONS } from "../../lib/ambient";
import { setAiFeatures, useAiFeatures } from "../../lib/ai";
import { TONES, chime, pushSupported, requestPush, type ToneKey } from "../../lib/push";
import {
  loadPackSounds,
  loadPacks,
  OFF,
  packChoice,
  playSound,
  PUSH_EVENT_KEYS,
  PUSH_EVENTS,
  soundsFor,
  type Pack,
  type PackSound,
  type PushEvent,
  type SoundChoice,
} from "../../lib/sounds";
import { EFFORTS, PERMS, PONYTAILS } from "../Composer";
import { latestPerFamily } from "../../models";
import { UpdateButton } from "./UpdateButton";
import { restartBridge } from "../../lib/restart";

export interface SettingsModalProps {
  host: string;
  port: string;
  settings: HudSettings;
  onTheme: (t: ThemeKey) => void;
  onToggle: (key: "scanlines" | "sweep" | "glow") => void;
  onPatch: (patch: Partial<HudSettings>) => void;
  models: { id: string; label: string }[];
  // Who runs the turn. A profile already saves it and every run already sends
  // it, so leaving it out of RUN DEFAULTS made it a knob you could only reach
  // from the composer — and could restore from a profile without ever seeing.
  agents: { id: string; label: string }[];
  weather: Weather;
  onSetCity: (city: string) => Promise<string | null>;
  onSetUnit: (unit: string) => Promise<string | null>;
  station: number;
  onStation: (i: number) => void;
  onFeed: (texts: string[]) => void; // a failed self-update hands git's error to Claude
  onReplayBoot: () => void;
  onClose: () => void;
  // Profiles snapshot the run knobs *and* the open session's tool switches, so
  // the panel needs to read the latter and write it back.
  sessionTools: string[];
  onSessionTools: (rules: string[]) => void;
  onOpenInspector: () => void;
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

type Tab = "appearance" | "transcript" | "indicator" | "ambient" | "notifications"
  | "session" | "tags" | "ai" | "agentconfig" | "mcp" | "hooks" | "accounts" | "system";

// The rail carries the same three-way split the comment above describes, but
// as two headings rather than ten peers: what the HUD is like, and what the
// work does. Ten flat rows made you read the whole list to find one setting.
//
// Hints are one line each, always — the four that used to wrap ("what plays
// while working", "extras that spend model calls") gave every other row a
// different height, and a rail whose rows are all different heights reads as
// ten unrelated things rather than two groups of five.
const TABS: { key: Tab; label: string; hint: string; icon: LucideIcon; group: string }[] = [
  { key: "appearance", label: "APPEARANCE", hint: "theme · type · CRT", icon: Palette, group: "THE HUD" },
  { key: "transcript", label: "TRANSCRIPT", hint: "how a session draws", icon: ScrollText, group: "THE HUD" },
  { key: "indicator", label: "INDICATOR", hint: "while it works", icon: AudioLines, group: "THE HUD" },
  { key: "ambient", label: "AMBIENT", hint: "weather · Claude·FM", icon: CloudSun, group: "THE HUD" },
  { key: "notifications", label: "NOTIFY", hint: "desktop · sound", icon: Bell, group: "THE HUD" },
  { key: "session", label: "SESSION", hint: "model · mode · effort", icon: SlidersHorizontal, group: "THE WORK" },
  { key: "tags", label: "TAGS", hint: "topics across sessions", icon: Tag, group: "THE WORK" },
  { key: "ai", label: "AI", hint: "spends model calls", icon: Sparkles, group: "THE WORK" },
  { key: "agentconfig", label: "CONFIG", hint: "each AI's own files", icon: FileCog, group: "THE WORK" },
  { key: "mcp", label: "MCP", hint: "servers · auth", icon: Plug, group: "THE WORK" },
  { key: "hooks", label: "HOOKS", hint: "inbound events", icon: Radio, group: "THE WORK" },
  { key: "accounts", label: "ACCOUNTS", hint: "logins · fallback", icon: KeyRound, group: "THE WORK" },
  { key: "system", label: "SYSTEM", hint: "bridge · updates", icon: Server, group: "THE WORK" },
];

// ---- SEARCH -----------------------------------------------------------------
// Ten categories deep, "where do I turn X off" is a hunt through all ten. One
// entry per Section, carrying the names of the rows inside it as `terms`: you
// search for the setting and land on the block that holds it. The forty-odd
// environment settings under SYSTEM are deliberately absent — they come from
// the bridge, so search fetches that registry the first time you type and folds
// it in row by row, which also means nobody has to keep a copy of them here.
const INDEX: { tab: Tab; sec: string; terms: string }[] = [
  { tab: "appearance", sec: "THEME · DARK", terms: "colour color palette scheme aurora phosphor" },
  { tab: "appearance", sec: "THEME · LIGHT", terms: "colour color palette scheme day bright" },
  { tab: "appearance", sec: "CRT EFFECTS", terms: "scanlines scan sweep text glow bloom raster" },
  { tab: "appearance", sec: "TYPE", terms: "font typeface monospace family text size zoom bigger smaller scale px auto base" },
  { tab: "appearance", sec: "BOOT SEQUENCE", terms: "intro splash replay animation" },
  { tab: "indicator", sec: "WORKING INDICATOR", terms: "equalizer spinner nyan cat piano keyboard tiles song voice samples synth" },
  { tab: "transcript", sec: "OUTPUT STYLE", terms: "auto-open results bash output edit diffs tool widget output style control plate stamp wire signal log ledger press halo instrument terminal note plain sources screens preview" },
  { tab: "ambient", sec: "WEATHER · header clock", terms: "city unit celsius fahrenheit temperature clock" },
  { tab: "ambient", sec: "CLAUDE·FM", terms: "radio station music volume ambient" },
  { tab: "notifications", sec: "DESKTOP", terms: "os notifications browser push permission alert" },
  { tab: "notifications", sec: "SOUND", terms: "tone chime volume packs peonping mute" },
  { tab: "notifications", sec: "PER EVENT", terms: "sound per event pack finished needs you error" },
  { tab: "session", sec: "RUN DEFAULTS", terms: "model agent mode effort ponytail permission plan bypass opus sonnet" },
  { tab: "session", sec: "PROFILES", terms: "preset saved knobs tools restore" },
  { tab: "tags", sec: "TAGS", terms: "topics rename merge chart sessions" },
  { tab: "ai", sec: "MODEL-SPENDING EXTRAS", terms: "features titles guard next-up scout summaries cost tokens" },
  { tab: "agentconfig", sec: "CLAUDE CODE", terms: "claude.md memory global instructions settings.json permissions hooks env user config" },
  { tab: "agentconfig", sec: "OPENCODE", terms: "agents.md opencode.json provider free agent config" },
  { tab: "mcp", sec: "MCP SERVERS", terms: "mcp server tool connect authenticate auth oauth token expired reconnect logout remove playwright github notion figma" },
  { tab: "mcp", sec: "ADD A SERVER", terms: "mcp add new server url command stdio http sse scope install connector" },
  { tab: "hooks", sec: "INBOUND HOOKS", terms: "webhook hook inbound event github sentry ci deploy trigger notify token revoke url" },
  { tab: "hooks", sec: "ADD A HOOK", terms: "webhook hook new mint token secret signature source github sentry ci generic" },
  { tab: "hooks", sec: "RECENT EVENTS", terms: "webhook feed received events history inbound log" },
  { tab: "accounts", sec: "ON USAGE LIMIT", terms: "policy wait switch fallback reset quota" },
  { tab: "accounts", sec: "CLAUDE LOGINS", terms: "account add sign in oauth profile" },
  { tab: "accounts", sec: "FREE AGENTS", terms: "api key gemini openai provider fallback handover" },
  { tab: "system", sec: "BRIDGE", terms: "host port address" },
  { tab: "system", sec: "STARTUP", terms: "install app pwa start at login autostart window systemd" },
  { tab: "system", sec: "HTTP INSPECTOR", terms: "api traffic proxy request sse token" },
  { tab: "system", sec: "PLATFORM", terms: "update version git rebuild restart" },
];

type Hit = { tab: Tab; sec: string; row?: string; hint?: string };

function search(q: string, env: EnvSetting[], hidden: Set<string>): Hit[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const label = (t: Tab) => TABS.find((x) => x.key === t)!.label;
  const all: (Hit & { hay: string })[] = [
    ...INDEX.filter((e) => !hidden.has(e.sec)).map((e) => ({
      tab: e.tab, sec: e.sec, hay: `${label(e.tab)} ${e.sec} ${e.terms}`.toLowerCase(),
    })),
    ...env.map((s) => ({
      tab: "system" as Tab, sec: s.group, row: s.label, hint: s.hint,
      hay: `system ${s.group} ${s.label} ${s.key} ${s.hint}`.toLowerCase(),
    })),
  ];
  return all.filter((e) => words.every((w) => e.hay.includes(w))).slice(0, 40);
}

// ---- WORKING INDICATOR ------------------------------------------------------
// Four forms share one tabbed panel so the modal stays one screen: the stock
// equalizer, a nyan.cat ride, a playable piano, and piano tiles. Picking a tab
// IS picking the form — `settings.indicator` is the tab state.

// `help` is the long "how to play it" — folded behind the ⓘ beside the blurb,
// since it's a paragraph you read once and then never again.
const INDICATOR_TABS: { key: Indicator; label: string; blurb: string; help?: ReactNode }[] = [
  { key: "bar", label: "EQUALIZER", blurb: "the stock braille spinner, phrase ticker and level bars" },
  { key: "nyan", label: "NYAN CAT", blurb: "a nyan.cat ride — 36 cats, their trails, their music" },
  {
    key: "piano",
    label: "PIANO",
    blurb: "two octaves to play with mouse or keyboard while you wait",
    help: (
      <>
        Click the board to arm the computer keys — unfocused, they stay yours for typing.
        <br />
        <span style={{ color: "var(--txd)" }}>SAMPLES</span> are real recordings, one MP3 per note,
        fetched on first use (~600&nbsp;KB a voice, then browser-cached); the synth covers until they
        land. <span style={{ color: "var(--txd)" }}>SYNTH</span> voices are generated locally and
        need no network.
        <br />
        <span style={{ fontFamily: "'JetBrains Mono',monospace", color: "var(--txd)" }}>
          Z S X D C V G B H N J M
        </span>{" "}
        plays C3–B3 ·{" "}
        <span style={{ fontFamily: "'JetBrains Mono',monospace", color: "var(--txd)" }}>
          Q 2 W 3 E R 5 T 6 Y 7 U I
        </span>{" "}
        plays C4–C5.
      </>
    ),
  },
  {
    key: "tiles",
    label: "TILES",
    blurb: "piano tiles — clear each falling note on the key that plays it",
    help: (
      <>
        Notes fall down the lane of the key that plays them — hit that key as the tile lands. Mouse
        or computer keys, same as the piano, and it uses the VOICE picked on the PIANO tab.
        <br />
        Every melody is public domain; a modern chart hit&apos;s tune is a copyrighted composition,
        so the directory sticks to the canon. Add your own in{" "}
        <span style={{ fontFamily: "'JetBrains Mono',monospace", color: "var(--txd)" }}>
          src/lib/songs.ts
        </span>
        .
      </>
    ),
  },
];

// 0 = AUTO (viewport-derived); the rest are the base the type scale hangs off.
const BASE_FONT_OPTS = BASE_FONTS.map((n) => ({
  label: n === 0 ? "AUTO" : `${n}PX`,
  value: String(n),
}));

const TONE_OPTS = (Object.keys(TONES) as ToneKey[]).map((k) => ({ label: TONES[k].label, value: k }));

const CRT_TOGGLES: { key: "scanlines" | "sweep" | "glow"; label: string; desc: string }[] = [
  { key: "scanlines", label: "SCANLINES", desc: "horizontal CRT raster lines" },
  { key: "sweep", label: "SCAN SWEEP", desc: "roaming refresh glow band" },
  { key: "glow", label: "TEXT GLOW", desc: "phosphor bloom on headings" },
];

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
const CARD: CSSProperties = {
  border: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)",
  background: "color-mix(in srgb, var(--panel) 55%, transparent)",
  padding: "12px 13px",
};
const KV: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between" };
const KEY_TX: CSSProperties = { fontSize: "var(--t10)", letterSpacing: 1, color: "var(--txd)" };
const NOTE: CSSProperties = { fontSize: "var(--t95)", color: "var(--txl)", marginTop: 11, lineHeight: 1.7 };
// What an ⓘ unfolds. Ruled off on the left so it reads as an aside about the
// row above it, not as another line of the panel.
const ASIDE: CSSProperties = {
  fontSize: "var(--t95)", color: "var(--txl)", lineHeight: 1.75, marginTop: 9,
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
  "THEME · DARK": Moon,
  "THEME · LIGHT": Sun,
  "CRT EFFECTS": ScanLine,
  TYPE: Type,
  "BOOT SEQUENCE": MonitorPlay,
  "WORKING INDICATOR": AudioLines,
  "OUTPUT STYLE": ScrollText,
  RESULTS: ListTree,
  "WEATHER · header clock": CloudSun,
  "CLAUDE·FM": Radio,
  DESKTOP: Monitor,
  SOUND: Volume2,
  "PER EVENT": ListMusic,
  "RUN DEFAULTS": SlidersHorizontal,
  PROFILES: Bookmark,
  TAGS: Tag,
  "MODEL-SPENDING EXTRAS": Sparkles,
  "CLAUDE CODE": SquareTerminal,
  OPENCODE: Boxes,
  "MCP SERVERS": Plug,
  "ADD A SERVER": Server,
  "ON USAGE LIMIT": Gauge,
  "CLAUDE LOGINS": KeyRound,
  "FREE AGENTS": Handshake,
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
};

/** A titled block. The explanation that used to stand under every block as a
 *  paragraph folds behind the ⓘ beside the title instead — nine tabs of prose
 *  at rest is what made these panels read as a wall of text.
 *
 *  The icon is what you actually navigate by once a tab is longer than a
 *  screen: SYSTEM is twelve of these blocks, and twelve identical dim rules
 *  give the eye nothing to count off against while scrolling. */
function Section({ title, icon, info, top, children }: {
  title: ReactNode;
  icon?: LucideIcon;
  info?: ReactNode;
  top?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const Icon = icon ?? (typeof title === "string" ? SEC_ICONS[title] : undefined);
  return (
    <div data-sec={typeof title === "string" ? title : undefined} style={{ marginTop: top ? 22 : 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 11 }}>
        {Icon && (
          <Icon size={13} strokeWidth={1.7} aria-hidden
            style={{ flex: "none", color: "var(--acc)", opacity: .75 }} />
        )}
        <span style={{ fontSize: "var(--t95)", letterSpacing: 1.5, color: "var(--txl)", flex: "none" }}>
          {title}
        </span>
        {info && <InfoDot on={open} about={typeof title === "string" ? title : undefined} onClick={() => setOpen(!open)} />}
        <span style={{ flex: 1, height: 1, background: "color-mix(in srgb, var(--acc) 12%, transparent)" }} />
      </div>
      {info && open && <div style={{ ...ASIDE, marginTop: 0, marginBottom: 12 }}>{info}</div>}
      {children}
    </div>
  );
}

/** One setting inside a card: its name, its control on the right, a one-line
 *  `desc` if the name isn't self-evident, and everything longer behind the ⓘ.
 *  Rows are ruled apart rather than spaced apart, so a card of five settings
 *  stays one object. */
function Row({ label, desc, info, first, children }: {
  label: ReactNode;
  desc?: ReactNode;
  info?: ReactNode;
  first?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      data-row={typeof label === "string" ? label : undefined}
      style={{ marginTop: first ? 0 : 11, paddingTop: first ? 0 : 11, borderTop: first ? undefined : RULE }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={KEY_TX}>{label}</span>
        {info && <InfoDot on={open} about={typeof label === "string" ? label : undefined} onClick={() => setOpen(!open)} />}
        <span style={{ flex: 1, minWidth: 8 }} />
        {children}
      </div>
      {desc && <div style={{ fontSize: "var(--t95)", color: "var(--txl)", marginTop: 4 }}>{desc}</div>}
      {info && open && <div style={ASIDE}>{info}</div>}
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

/** An ON/OFF pill, matching the CRT rows. */
function Switch({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        appearance: "none",
        cursor: "pointer",
        border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)",
        background: "var(--panel3)",
        padding: 2,
        display: "flex",
        gap: 2,
        flex: "none",
        fontFamily: "inherit",
      }}
    >
      <span style={{ fontSize: "var(--t9)", letterSpacing: 1, padding: "3px 10px", background: on ? "var(--acc)" : "transparent", color: on ? "var(--acc-on)" : "var(--txl)" }}>
        ON
      </span>
      <span style={{ fontSize: "var(--t9)", letterSpacing: 1, padding: "3px 10px", background: on ? "transparent" : "color-mix(in srgb, var(--acc) 18%, transparent)", color: on ? "var(--txl)" : "var(--txb)" }}>
        OFF
      </span>
    </button>
  );
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
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(72px,1fr))", gap: 2, border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)" }}>
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
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
}: {
  label: string;
  value: string;
  options: { id: string; label: string }[];
  onPick: (v: string) => void;
}) {
  return (
    <Cell label={label}>
      <select value={value} onChange={(e) => onPick(e.target.value)} style={{ ...field, width: "100%" }}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </Cell>
  );
}

// ---- NOTIFICATION SOUNDS ----------------------------------------------------

/** One scrolling list, used for both halves of the browser. */
const LIST: CSSProperties = {
  maxHeight: 168, overflowY: "auto", marginTop: 6,
  border: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)",
};

function ListRow({ on, children, onClick }: { on?: boolean; children: ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "block", width: "100%", textAlign: "left", appearance: "none", cursor: "pointer",
        border: 0, borderBottom: "1px solid color-mix(in srgb, var(--acc) 8%, transparent)",
        background: on ? "color-mix(in srgb, var(--acc) 16%, transparent)" : "transparent",
        color: on ? "var(--txb)" : "var(--tx)", fontFamily: "inherit", fontSize: "var(--t10)",
        letterSpacing: .5, padding: "7px 9px", lineHeight: 1.4,
      }}
    >
      {children}
    </button>
  );
}

/** Browse peonping.com: search the catalog, open a pack, click a sound to hear
 *  it and assign it. Every sound in the pack is offered, not just the ones
 *  written for this event — a victory line on FAILURE is a valid taste. */
function PackBrowser({ cat, volume, onPick }: {
  cat: string;
  volume: number;
  onPick: (c: SoundChoice) => void;
}) {
  const [packs, setPacks] = useState<Pack[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [pack, setPack] = useState<Pack | null>(null);
  const [byCat, setByCat] = useState<Record<string, PackSound[]> | null>(null);

  useEffect(() => {
    let live = true;
    loadPacks().then((p) => { if (live) setPacks(p); },
      (e: Error) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, []);

  // Re-fetching a manifest is free (module-cached), so this just re-renders.
  useEffect(() => {
    if (!pack) { setByCat(null); return; }
    let live = true;
    setByCat(null);
    loadPackSounds(pack).then((m) => { if (live) setByCat(m); },
      (e: Error) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [pack]);

  if (err) return <div style={{ ...NOTE, color: "var(--err)" }}>peonping.com unreachable — {err}</div>;
  if (!packs) return <div style={NOTE}>Loading the pack catalog…</div>;

  if (pack) {
    const groups = byCat ? soundsFor(byCat, cat) : [];
    return (
      <>
        <ListRow onClick={() => setPack(null)}>← {packs.length} packs</ListRow>
        <div style={{ ...NOTE, marginTop: 6 }}>{pack.display_name}</div>
        {!byCat ? <div style={NOTE}>Loading sounds…</div> : (
          <div style={LIST}>
            {groups.map((g) => (
              <div key={g.cat}>
                <div style={{ fontSize: "var(--t85)", letterSpacing: 1.5, color: "var(--txl)", padding: "6px 9px 3px" }}>
                  {g.cat === cat ? `${g.cat} — written for this` : g.cat}
                </div>
                {g.sounds.map((s) => {
                  const choice = packChoice(pack, s);
                  return (
                    <ListRow key={choice.src} onClick={() => { playSound(choice, volume, "blip"); onPick(choice); }}>
                      ♪ {choice.label.split(" · ").slice(1).join(" · ")}
                    </ListRow>
                  );
                })}
              </div>
            ))}
            {!groups.length && <div style={{ ...NOTE, padding: "0 9px 8px" }}>This pack ships no sounds.</div>}
          </div>
        )}
      </>
    );
  }

  const needle = q.trim().toLowerCase();
  const hits = packs
    // A pack without this event's category still has sounds you can assign, so
    // it stays in the list — it just sorts below the ones written for it.
    .filter((p) => !needle || `${p.display_name} ${p.name} ${(p.tags ?? []).join(" ")}`.toLowerCase().includes(needle))
    .sort((a, b) => Number(b.categories.includes(cat)) - Number(a.categories.includes(cat)))
    .slice(0, 120);
  return (
    <>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={`search ${packs.length} packs — glados, peon, rick…`}
        style={{ ...field, width: "100%", boxSizing: "border-box" }}
      />
      <div style={LIST}>
        {hits.map((p) => (
          <ListRow key={p.name} onClick={() => setPack(p)}>
            {p.display_name}
            <span style={{ color: "var(--txl)", fontSize: "var(--t9)" }}>
              {"  "}· {p.sound_count ?? "?"} sounds{p.categories.includes(cat) ? "" : " · no clip for this event"}
            </span>
          </ListRow>
        ))}
        {!hits.length && <div style={{ ...NOTE, padding: "8px 9px" }}>No pack matches “{q}”.</div>}
      </div>
    </>
  );
}

/** The per-event table: one assignable sound per thing the dashboard notifies
 *  about. An unassigned event falls back to the single TONE below, which is
 *  what every install sounded like before this panel existed. */
// Six rows that differ only in wording otherwise — the icon is what makes
// "the one that fires when something breaks" findable without reading all six.
const EVENT_ICONS: Record<PushEvent, LucideIcon> = {
  done: CircleCheck,
  question: MessageCircleQuestion,
  permission: ShieldQuestion,
  failure: TriangleAlert,
  start: Play,
  limit: Hourglass,
};

function SoundBoard({ settings, onPatch }: {
  settings: HudSettings;
  onPatch: (patch: Partial<HudSettings>) => void;
}) {
  const [open, setOpen] = useState<PushEvent | null>(null);
  // The browser is a tall thing that unfolds under whichever row you tapped, so
  // opening one on LIMIT — the last row — otherwise puts the search box and the
  // whole pack list below the fold, with no hint that anything happened.
  const picker = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) picker.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [open]);
  const set = (ev: PushEvent, c: SoundChoice | undefined) => {
    const next = { ...settings.pushSounds };
    if (c) next[ev] = c; else delete next[ev];
    onPatch({ pushSounds: next });
  };
  return (
    <div>
      {PUSH_EVENT_KEYS.map((ev, i) => {
        const meta = PUSH_EVENTS[ev];
        const cur = settings.pushSounds[ev];
        const on = open === ev;
        const Icon = EVENT_ICONS[ev];
        return (
          <div key={ev} style={{
            // A rule between rows, not above the first one — the card already
            // draws that edge.
            borderTop: i ? "1px solid color-mix(in srgb, var(--acc) 10%, transparent)" : 0,
            padding: i ? "9px 0" : "0 0 9px",
          }}>
            {/* Wraps rather than crushes: on a phone panel the assigned sound
                drops onto its own line under the event name instead of
                squeezing the name down to two characters. */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <Icon size={14} strokeWidth={1.6} aria-hidden
                style={{ flex: "none", color: "var(--acc)", opacity: cur?.src === "off" ? .3 : .75 }} />
              <div style={{ flex: "1 1 150px", minWidth: 0 }}>
                <div style={KEY_TX}>{meta.label}</div>
                <div style={{ fontSize: "var(--t95)", color: "var(--txl)", marginTop: 3 }}>{meta.hint}</div>
              </div>
              <div style={{ flex: "0 1 auto", display: "flex", alignItems: "center", gap: 6, minWidth: 0, marginLeft: "auto" }}>
                <span style={{
                  fontSize: "var(--t9)", letterSpacing: .5, minWidth: 0, overflow: "hidden",
                  textOverflow: "ellipsis", whiteSpace: "nowrap",
                  color: cur ? "var(--acc)" : "var(--txl)",
                }}>
                  {cur ? cur.label : `${TONES[settings.pushTone].label} (default)`}
                </span>
                <MiniBtn title="play it" onClick={() => playSound(cur, settings.pushVolume, settings.pushTone)}>
                  <Play size={11} strokeWidth={2} aria-hidden />
                </MiniBtn>
                <MiniBtn title={on ? "close" : "pick a sound"} onClick={() => setOpen(on ? null : ev)}>
                  {on ? <X size={11} strokeWidth={2} aria-hidden /> : <Ellipsis size={11} strokeWidth={2} aria-hidden />}
                </MiniBtn>
              </div>
            </div>
            {on && (
              <div ref={picker} style={{ marginTop: 9 }}>
                <Segmented
                  size="var(--t9)"
                  options={[
                    { label: "DEFAULT", value: "" },
                    { label: "OFF", value: "off" },
                    ...TONE_OPTS.map((t) => ({ label: t.label, value: `tone:${t.value}` })),
                  ]}
                  value={cur?.src ?? ""}
                  onPick={(v) => {
                    if (!v) { set(ev, undefined); playSound(undefined, settings.pushVolume, settings.pushTone); return; }
                    const c = v === "off" ? OFF
                      : { src: v, label: TONES[v.slice(5) as ToneKey].label };
                    set(ev, c);
                    playSound(c, settings.pushVolume, settings.pushTone);
                  }}
                />
                <div style={{ marginTop: 9 }}>
                  <PackBrowser cat={meta.cat} volume={settings.pushVolume} onPick={(c) => set(ev, c)} />
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// The "DISPLAY PROFILE" grid. Because the whole app is run through the active
// theme's CSS filter, every swatch/preview colour is pre-corrected by the
// INVERSE of that filter's color matrix so the cards render TRUE colours.
// AURORA's four hues and CLAUDE's four accents each collapse into one card with
// a variant row; every other theme is its own card. The cards split by ground —
// six dark cards, six light — and each set gets its own labelled row.
type ThemeCard = { key: ThemeKey; variants?: ThemeKey[] };

const CARDS: ThemeCard[] = [
  { key: "aqua", variants: AURORA_KEYS },
  { key: "claude", variants: CLAUDE_KEYS },
  ...THEME_DEFS
    .filter((t) => !AURORA_KEYS.includes(t.key) && !CLAUDE_KEYS.includes(t.key))
    .map((t) => ({ key: t.key })),
];

const DARK_CARDS = CARDS.filter((c) => !isLight(c.key));
const LIGHT_CARDS = CARDS.filter((c) => isLight(c.key));

function ThemeCardGrid({
  cards,
  settings,
  onTheme,
}: { cards: ThemeCard[]; settings: HudSettings; onTheme: (t: ThemeKey) => void }) {
  const [hover, setHover] = useState<ThemeKey | null>(null);
  const comp = themeCompensator(settings.theme);
  // A family card wears whichever of its variants is live (the first otherwise).
  const liveOf = (variants: ThemeKey[]): ThemeKey =>
    variants.includes(settings.theme) ? settings.theme : variants[0];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 9 }}>
      {cards.map((card) => {
        const t = themeDef(card.variants ? liveOf(card.variants) : card.key);
        const on = card.variants ? card.variants.includes(settings.theme) : settings.theme === card.key;
        const name = card.variants ? themeDef(card.variants[0]).name : t.name;
        const sw = comp(t.sw);
        const cardBd = on ? comp(t.sw) : comp("#26413d");
        const cardBg = on ? comp("#132824") : comp("#0d1517");
        const dim = comp("#20332f");
        const pbg = comp(t.pbg);
        // The card ground is a hardcoded dark, so the name is a fixed light —
        // following the live theme's --txb turned it invisible in light themes.
        const nameC = comp("#e6f2ee");
        const descC = comp("#8fa8a2");
        const chipC = comp("var(--acc-on)");
        const pfont = t.font || "inherit";
        const prad = t.prad || "0";
        return (
          <div
            key={card.key}
            onClick={() => onTheme(t.key)}
            onMouseEnter={() => setHover(card.key)}
            onMouseLeave={() => setHover(null)}
            style={{
              textAlign: "left",
              cursor: "pointer",
              fontFamily: "inherit",
              border: `1px solid ${hover === card.key ? "color-mix(in srgb, var(--acc) 45%, transparent)" : cardBd}`,
              background: cardBg,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                position: "relative",
                height: 38,
                background: pbg,
                borderBottom: `1px solid ${dim}`,
                overflow: "hidden",
                padding: "7px 9px",
              }}
            >
              <div style={{ display: "flex", gap: 3, alignItems: "flex-end", height: "100%" }}>
                <span style={{ flex: 1, height: "55%", background: sw, opacity: 0.8 }}></span>
                <span style={{ flex: 1, height: "100%", background: sw }}></span>
                <span style={{ flex: 1, height: "45%", background: sw, opacity: 0.5 }}></span>
                <span style={{ flex: 1, height: "80%", background: sw, opacity: 0.8 }}></span>
                <span style={{ flex: 1, height: "30%", background: sw, opacity: 0.35 }}></span>
                <span style={{ flex: 1, height: "65%", background: sw, opacity: 0.8 }}></span>
              </div>
              {t.crt && (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    pointerEvents: "none",
                    background:
                      "repeating-linear-gradient(0deg,rgba(0,0,0,0) 0,rgba(0,0,0,0) 2px,rgba(0,0,0,.28) 3px,rgba(0,0,0,0) 4px)",
                    opacity: 0.55,
                  }}
                ></div>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 9px" }}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  background: sw,
                  border: "1px solid rgba(0,0,0,.45)",
                  flex: "none",
                  borderRadius: prad,
                }}
              ></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: "var(--t105)",
                    letterSpacing: 1,
                    color: nameC,
                    fontFamily: pfont,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {name}
                </div>
                <div
                  style={{
                    fontSize: "var(--t8)",
                    letterSpacing: 0.4,
                    color: descC,
                    marginTop: 1,
                    fontFamily: pfont,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {t.feel}
                </div>
              </div>
              {on && (
                <span
                  style={{
                    fontSize: "var(--t7)",
                    letterSpacing: 1,
                    color: chipC,
                    background: sw,
                    padding: "1px 5px",
                    flex: "none",
                  }}
                >
                  ON
                </span>
              )}
            </div>

            {card.variants && (
              <div style={{ display: "flex", gap: 5, padding: "0 9px 8px" }}>
                {card.variants.map((k) => {
                  const c = themeDef(k);
                  const live = settings.theme === k;
                  return (
                    <button
                      key={k}
                      title={c.name}
                      onClick={(e) => { e.stopPropagation(); onTheme(k); }}
                      style={{
                        appearance: "none",
                        cursor: "pointer",
                        flex: 1,
                        height: 12,
                        padding: 0,
                        background: comp(c.sw),
                        border: `1px solid ${live ? comp("#f2fbf9") : "rgba(0,0,0,.45)"}`,
                        borderRadius: t.prad || "0",
                      }}
                    />
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** OUTPUT STYLE, drawn as itself. A dropdown listing CONTROL PLATE · WIRE ·
 *  SIGNAL LOG asks you to picture five things you have never seen, and an
 *  earlier cut of these styles was a few borders apart, so nobody could. Each
 *  tile renders the REAL ToolWidget under the real CSS — a tile cannot drift
 *  from the transcript the way a mockup would.
 *
 *  The wells are `inert`: a preview is a picture, so its links neither take a
 *  click nor a tab stop away from the tile that owns them. */
/* Two payloads, not one: SOURCES draws in the zero-chrome STRIP idiom, which
   is the idiom a material has no frame to show itself in. A tile that showed
   only that would preview the language's typography and none of its chrome. */
const STYLE_PREVIEW_PLATE: ToolWidgetSpec = {
  label: "OUTPUT",
  type: "output",
  meta: "2 lines",
  value: { cmd: "tsc -p tsconfig.app.json", ok: false, text: "lib/toolwidget.ts:41:12\nerror TS2322: not assignable to 'Idiom'" },
};

const STYLE_PREVIEW: ToolWidgetSpec = {
  label: "SOURCES",
  type: "sources",
  meta: "3",
  value: [
    { url: "https://docs.claude.com/en/docs/claude-code", title: "Claude Code — overview", code: 200 },
    { url: "https://github.com/anthropics/claude-code", title: "anthropics/claude-code", code: 200 },
    { url: "https://developer.mozilla.org/en-US/docs/Web/CSS", title: "CSS reference — MDN", code: 200 },
  ],
};

function OutputStylePicker({
  value,
  onPick,
}: {
  value: ToolStyle;
  onPick: (s: ToolStyle) => void;
}) {
  const hue = toolAccent("WebSearch");
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 10 }}>
      {TOOL_STYLES.map((o) => {
        const on = value === o.key;
        return (
          <button
            key={o.key}
            onClick={() => onPick(o.key)}
            aria-pressed={on}
            style={{
              appearance: "none",
              cursor: "pointer",
              textAlign: "left",
              fontFamily: "inherit",
              padding: 0,
              overflow: "hidden",
              // A button centres its content in whatever height the grid row
              // gives it; these have to start at the top or the four tiles read
              // as four different layouts.
              display: "flex",
              flexDirection: "column",
              border: `1px solid ${on ? "var(--acc)" : "color-mix(in srgb, var(--acc) 14%, transparent)"}`,
              background: on ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "var(--panel3)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "8px 11px 7px" }}>
              <span style={{ flex: "none", fontSize: "var(--t10)", letterSpacing: 1.6, color: on ? "var(--txb)" : "var(--txh)" }}>
                {o.label}
              </span>
              {on && (
                <span style={{ flex: "none", fontSize: "var(--t7)", letterSpacing: 1, color: "var(--acc-on)", background: "var(--acc)", padding: "1px 5px" }}>
                  ON
                </span>
              )}
              <span
                style={{
                  flex: 1, minWidth: 0, textAlign: "right", fontSize: "var(--t9)",
                  color: "var(--txl)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                }}
              >
                {o.hint}
              </span>
            </div>
            {/* data-style, not just data-tw: the style governs the whole
                stream now, so the well has to be a slice of one — a result and
                a piece of a reply — or the tile would preview a quarter of what
                the pick actually does. */}
            <div
              inert
              data-style={o.key}
              style={{
                borderTop: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)",
                background: "var(--panel)",
                padding: "11px 13px",
                minHeight: 124,
                flex: 1,
                width: "100%",
              }}
            >
              <ToolWidget spec={STYLE_PREVIEW_PLATE} accent={hue} style={o.key} />
              <ToolWidget spec={STYLE_PREVIEW} accent={hue} style={o.key} />
              <div className="md" style={{ marginTop: 9, fontSize: "var(--t11)" }}>
                <div className="md-tablewrap">
                  <table>
                    <thead><tr><th>Tool</th><th>Share</th></tr></thead>
                    <tbody>
                      <tr><td>Bash</td><td>70%</td></tr>
                      <tr><td>Read</td><td>10%</td></tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
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

function IndicatorPicker({
  settings,
  onPatch,
}: {
  settings: HudSettings;
  onPatch: (patch: Partial<HudSettings>) => void;
}) {
  const unfilter = themeUnfilter(settings.theme);
  const active = INDICATOR_TABS.find((t) => t.key === settings.indicator) ?? INDICATOR_TABS[0];
  const [help, setHelp] = useState(false);

  return (
    <div style={{ border: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)", background: "color-mix(in srgb, var(--panel) 92%, transparent)" }}>
      <div style={{ display: "flex", gap: 2, borderBottom: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)" }}>
        {INDICATOR_TABS.map((t) => {
          const on = settings.indicator === t.key;
          return (
            <button
              key={t.key}
              onClick={() => onPatch({ indicator: t.key })}
              style={{
                flex: 1,
                appearance: "none",
                cursor: "pointer",
                border: 0,
                borderBottom: `2px solid ${on ? "var(--acc)" : "transparent"}`,
                background: on ? "color-mix(in srgb, var(--acc) 14%, transparent)" : "transparent",
                color: on ? "var(--txb)" : "var(--txd)",
                fontFamily: "inherit",
                fontSize: "var(--t95)",
                letterSpacing: 1.5,
                padding: "8px 4px",
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div style={{ padding: "12px 13px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ fontSize: "var(--t95)", color: "var(--txl)" }}>{active.blurb}</div>
          {active.help && <InfoDot on={help} about={active.label} onClick={() => setHelp(!help)} />}
        </div>
        {active.help && help && <div style={ASIDE}>{active.help}</div>}

        {settings.indicator === "nyan" && (
          <>
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
                    style={{
                      appearance: "none",
                      cursor: "pointer",
                      padding: 3,
                      lineHeight: 0,
                      background: on ? "color-mix(in srgb, var(--acc) 20%, transparent)" : "var(--panel3)",
                      border: `1px solid ${on ? "var(--acc)" : "color-mix(in srgb, var(--acc) 14%, transparent)"}`,
                    }}
                  >
                    <img src={nyanThumb(m.thumb)} alt={m.label} loading="lazy" style={{ width: "100%", display: "block", filter: unfilter }} />
                  </button>
                );
              })}
            </div>

            <div style={ROW}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: "var(--t11)", color: "var(--txh)", letterSpacing: 0.5 }}>EXTRA ANIMATIONS</div>
                <div style={{ fontSize: "var(--t95)", color: "var(--txl)", marginTop: 2 }}>
                  fly the cat, draw nyan.cat's rainbow trail + pixel stars
                </div>
              </div>
              <Switch on={settings.nyanExtra} onClick={() => onPatch({ nyanExtra: !settings.nyanExtra })} />
            </div>

            <div style={ROW}>
              <span style={CAPTION}>SOUND</span>
              <select
                value={settings.nyanSound}
                onChange={(e) => onPatch({ nyanSound: e.target.value as NyanSound })}
                style={{ ...field, flex: 1, minWidth: 0 }}
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
            </div>
          </>
        )}

        {settings.indicator === "tiles" && (
          <>
            <div style={ROW}>
              <span style={CAPTION}>SONG</span>
              <select
                value={settings.tilesSong}
                onChange={(e) => onPatch({ tilesSong: e.target.value })}
                style={{ ...field, flex: 1, minWidth: 0 }}
              >
                {SONGS.map((song) => (
                  <option key={song.key} value={song.key}>
                    {song.title} — {song.composer}
                  </option>
                ))}
              </select>
              <select
                value={settings.tilesSpeed}
                onChange={(e) => onPatch({ tilesSpeed: e.target.value as TileSpeed })}
                style={{ ...field, flex: "none" }}
              >
                {TILE_SPEEDS.map((sp) => (
                  <option key={sp} value={sp}>
                    {sp.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        {settings.indicator === "piano" && (
          <>
            <div style={ROW}>
              <span style={CAPTION}>VOICE</span>
              <select
                value={settings.pianoVoice}
                onChange={(e) => onPatch({ pianoVoice: e.target.value })}
                style={{ ...field, flex: 1, minWidth: 0 }}
              >
                {VOICE_GROUPS.map((g) => (
                  <optgroup key={g} label={g}>
                    {VOICES.filter((v) => v.group === g).map((v) => (
                      <option key={v.key} value={v.key}>
                        {v.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <Volume value={settings.pianoVolume} onChange={(pianoVolume) => onPatch({ pianoVolume })} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** City + unit for the header clock's weather — the same bridge-side setting the
 *  clock popover writes. */
function WeatherCard({
  weather,
  onSetCity,
  onSetUnit,
}: {
  weather: Weather;
  onSetCity: (city: string) => Promise<string | null>;
  onSetUnit: (unit: string) => Promise<string | null>;
}) {
  const [city, setCity] = useState(weather.loc);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!city.trim() || saving) return;
    setSaving(true);
    setErr(null);
    const e = await onSetCity(city.trim());
    setSaving(false);
    setErr(e);
  }

  return (
    <div style={CARD}>
      <div style={{ ...LINE, marginTop: 0 }}>
        <Cell label="CITY" grow="1 1 200px">
          <div style={{ display: "flex", gap: 9 }}>
            <input
              value={city}
              onChange={(e) => setCity(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void save()}
              placeholder="city — e.g. Tehran"
              style={{
                flex: 1,
                minWidth: 0,
                background: "var(--panel3)",
                border: `1px solid ${err ? "var(--err)" : "color-mix(in srgb, var(--acc) 22%, transparent)"}`,
                outline: "none",
                color: "var(--txb)",
                fontFamily: "inherit",
                fontSize: "var(--t115)",
                padding: "7px 9px",
              }}
            />
            <button
              onClick={() => void save()}
              disabled={saving}
              style={{
                appearance: "none",
                cursor: saving ? "wait" : "pointer",
                border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)",
                background: "color-mix(in srgb, var(--acc) 8%, transparent)",
                color: "var(--tx)",
                fontFamily: "inherit",
                fontSize: "var(--t10)",
                letterSpacing: 1.5,
                padding: "7px 13px",
                flex: "none",
              }}
            >
              {saving ? "…" : "SAVE"}
            </button>
          </div>
        </Cell>
        <Cell label="UNIT" grow="none">
          <Segmented
            options={[
              { label: "°C", value: "celsius" },
              { label: "°F", value: "fahrenheit" },
            ]}
            value={weather.unit === "F" ? "fahrenheit" : "celsius"}
            onPick={(u) => void onSetUnit(u)}
          />
        </Cell>
      </div>
      {err && <div style={{ fontSize: "var(--t9)", color: "var(--err)", marginTop: 5 }}>{err}</div>}
    </div>
  );
}

/** What the bridge's own checkout is running, and the pull-and-restart button. */
function UpdatePanel({ onFeed }: { onFeed: (texts: string[]) => void }) {
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
  ask: "Offer the choices (other account · free agent · wait) and stay parked until you pick.",
  auto: "Take the best fallback immediately and report which one it landed on.",
  wait: "Only wait for the window to reset — the behaviour before the ladder existed.",
};

/** Every model call the bridge makes on top of your own turns, and its switch.
 *  Anything that runs on its own ships off: an install should cost exactly the
 *  turns you typed until you decide otherwise. The ones that only fire on a
 *  press ship on, and are listed so the spend is still visible and stoppable.
 *  Takes effect on the next turn — no restart. */
/** Every tag in play, with the two operations that actually come up: fix a name,
 *  or get rid of one. Merging isn't a separate button — renaming a tag to one
 *  that already exists is a merge, which is both true of the storage and one
 *  fewer thing to explain. */
function TagsPanel() {
  const [tags, setTags] = useState<TagCount[]>([]);
  const [manage, setManage] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void api.tags().then((r) => { if (live) setTags(r.tags); }).catch(() => {});
    return () => { live = false; };
  }, []);

  async function commit(tag: string, next?: string) {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.retag(tag, next);
      setTags(r.tags);
    } catch { /* the list just doesn't change */ }
    setBusy(false);
    setEditing(null);
  }

  if (!tags.length)
    return <div style={CARD}><span style={{ fontSize: "var(--t105)", color: "var(--txl)" }}>No tags yet — they arrive with the first named session.</span></div>;

  // The bar IS the chart: each tag against the most-used one. A count alone
  // doesn't say whether 12 is a lot here; beside the longest bar it does. Only
  // the head is worth drawing — the tail is a hundred one-session tags, which
  // is a wall of stubs, so the full set lives in the list below instead.
  const top = tags.slice(0, 12);
  const peak = tags[0].count;

  const nameStyle: CSSProperties = { fontSize: "var(--t11)", color: "var(--purple-d)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
  const editStyle: CSSProperties = { flex: 1, minWidth: 0, background: "transparent", border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)", color: "var(--txb)", fontFamily: "inherit", fontSize: "var(--t11)", padding: "3px 7px", outline: "none" };

  const rename = (t: TagCount) => (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") void commit(t.tag, value.trim() || undefined);
        if (e.key === "Escape") setEditing(null);
      }}
      onBlur={() => setEditing(null)}
      style={editStyle}
    />
  );

  return (
    <div style={CARD}>
      {top.map((t) => (
        <div key={t.tag} style={{ marginTop: 9 }} title={`${t.count} session${t.count === 1 ? "" : "s"}`}>
          <div style={{ ...KV, gap: 10 }}>
            <span style={nameStyle}>{t.tag}</span>
            <span style={{ fontSize: "var(--t95)", color: "var(--txl)", flex: "none" }}>{t.count}</span>
          </div>
          <div style={{ height: 3, marginTop: 3, background: "color-mix(in srgb, var(--acc) 8%, transparent)" }}>
            <div style={{ height: "100%", width: `${(t.count / peak) * 100}%`, background: "var(--purple-d)" }} />
          </div>
        </div>
      ))}

      <div style={{ ...ROW, marginTop: 16, paddingTop: 12, borderTop: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)" }}>
        <span style={KEY_TX}>MANAGE ALL {tags.length}</span>
        <span style={{ flex: 1 }} />
        <Switch on={manage} onClick={() => { setManage(!manage); setEditing(null); }} />
      </div>

      {manage && (
        <div style={{ maxHeight: 280, overflowY: "auto", marginTop: 2 }}>
          {tags.map((t) => (
            <div key={t.tag} style={{ ...KV, marginTop: 8, gap: 10 }}>
              {editing === t.tag ? rename(t) : (
                <>
                  <span style={nameStyle}>{t.tag}</span>
                  <span style={{ fontSize: "var(--t95)", color: "var(--txl)", flex: "none" }}>
                    {t.count} session{t.count === 1 ? "" : "s"}
                  </span>
                  <button
                    onClick={() => { setEditing(t.tag); setValue(t.tag); }}
                    title="rename — an existing name merges the two"
                    style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: "transparent", color: "var(--txd)", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1, padding: "3px 8px", flex: "none" }}
                  >RENAME</button>
                  <button
                    onClick={() => void commit(t.tag)}
                    title={`remove "${t.tag}" from all ${t.count} session${t.count === 1 ? "" : "s"}`}
                    style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--err) 30%, transparent)", background: "transparent", color: "var(--err)", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1, padding: "3px 8px", flex: "none" }}
                  >✕</button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// One icon per extra: a grid of ten cards is scanned by shape long before it is
// read, and these are otherwise ten identical rectangles.
const AI_ICONS: Record<string, LucideIcon> = {
  title: PenLine,
  relevance: ShieldQuestion,
  nextup: ListTodo,
  preview: Play,
  learn: GraduationCap,
  tailstate: MessageCircleQuestion,
  ponytail: Scissors,
  graph: Waypoints,
  commitmsg: GitCommitVertical,
  design: Shapes,
};

/** One extra as its own card: icon, name, what it does, what it costs, its
 *  switch. As ruled rows in a single card these read as a list you go down
 *  line by line; as cards, which ones are spending is visible from across the
 *  grid — the question this tab exists to answer. The cost line sits on the
 *  card's floor (marginTop:auto) so it lines up across a row whatever the
 *  hints do. */
function AiCard({ f, busy, err, onToggle }: {
  f: AiFeature; busy: boolean; err?: string; onToggle: () => void;
}) {
  const [open, setOpen] = useState(false);
  const Icon = AI_ICONS[f.key] ?? Sparkles;
  return (
    <div style={{
      ...CARD,
      display: "flex",
      flexDirection: "column",
      gap: 7,
      border: `1px solid color-mix(in srgb, var(--acc) ${f.enabled ? 34 : 12}%, transparent)`,
      background: f.enabled ? "color-mix(in srgb, var(--acc) 7%, var(--panel))" : CARD.background,
      opacity: busy ? 0.55 : 1,
      transition: "border-color .15s, background .15s, opacity .15s",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Icon size={13} strokeWidth={1.7} aria-hidden
          style={{ flex: "none", color: f.enabled ? "var(--acc)" : "var(--txd)" }} />
        <span style={{ ...KEY_TX, color: f.enabled ? "var(--txb)" : "var(--txd)" }}>{f.label}</span>
        {f.about && <InfoDot on={open} about={f.label} onClick={() => setOpen(!open)} />}
        <span style={{ flex: 1, minWidth: 8 }} />
        <Switch on={f.enabled} onClick={() => (busy ? null : onToggle())} />
      </div>
      <div style={{ fontSize: "var(--t95)", color: "var(--txl)", lineHeight: 1.6 }}>{f.hint}</div>
      {open && f.about && <div style={{ ...ASIDE, marginTop: 0 }}>{f.about}</div>}
      {err && <div style={{ fontSize: "var(--t95)", color: "var(--err)" }}>{err}</div>}
      <div style={{
        display: "flex", alignItems: "center", gap: 6, marginTop: "auto", paddingTop: 8,
        borderTop: RULE, fontSize: "var(--t9)", letterSpacing: 1, color: "var(--txd)",
      }}>
        <span>{f.cost}</span>
        {f.tokens && <>
          <span style={{ opacity: 0.5 }}>·</span>
          <span style={{ fontFamily: "'JetBrains Mono',monospace", color: "var(--txm)" }}>{f.tokens}</span>
        </>}
      </div>
    </div>
  );
}

function AiPanel() {
  const [rows, setRows] = useState<AiFeature[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Keyed by feature: a failure belongs on the card whose switch just refused
  // to move, not in a line under ten of them.
  const [err, setErr] = useState<{ key: string; msg: string } | null>(null);

  useEffect(() => {
    void api
      .aiFeatures()
      .then((r) => {
        setRows(r.features);
        setAiFeatures(r.features);
      })
      .catch(() => setRows([]));
  }, []);

  async function toggle(f: AiFeature) {
    setBusy(f.key);
    setErr(null);
    try {
      const fresh = (await api.setAiFeature(f.key, !f.enabled)).features;
      setRows(fresh);
      // The switch owns visible UI elsewhere (tabs, boards, cards) — hand the
      // fresh answer to the shared store so it appears/disappears right now.
      setAiFeatures(fresh);
    } catch (e) {
      setErr({ key: f.key, msg: e instanceof Error ? e.message : "could not save" });
    } finally {
      setBusy(null);
    }
  }

  if (rows === null) return <Placeholder icon={LoaderCircle} spin>Reading the feature switches…</Placeholder>;
  if (!rows.length)
    return <Placeholder icon={TriangleAlert}>This bridge is running a build without the AI tab. Restart it.</Placeholder>;

  const on = rows.filter((f) => f.enabled).length;
  return (
    <Section
      title="MODEL-SPENDING EXTRAS"
      info="Anything that runs without you pressing something is off by default. A switch here beats the matching environment setting and applies to the next turn — nothing to restart. Everything a feature adds to the dashboard is hidden again the moment you switch it off. The next-up board also prefers a free provider (ACCOUNTS tab) over spending Claude quota. The token figure is what one unit burns, in and out together, as a median of real runs. Even the smallest one-shot costs tens of thousands: every headless run carries the CLI's own system prompt and tool schemas before it reads a word of yours. Most of that is read from cache, so it is cheaper than the number looks — but it is not free, and the ones that fire on their own are the ones that add up."
    >
      <div style={{ fontSize: "var(--t95)", letterSpacing: 1, color: "var(--txd)", marginBottom: 11 }}>
        {on} OF {rows.length} SPENDING
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(258px,1fr))", gap: 9 }}>
        {rows.map((f) => (
          <AiCard
            key={f.key}
            f={f}
            busy={busy === f.key}
            err={err?.key === f.key ? err.msg : undefined}
            onToggle={() => void toggle(f)}
          />
        ))}
      </div>
    </Section>
  );
}

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
      info="Two separate things. Installing puts the dashboard in your Start Menu as its own window, with no tab strip or address bar — that is the browser's doing and it never leaves this machine. Starting at login is the bridge's: a systemd user unit brings it up, and under WSL — where nothing runs until Windows touches the distro — a small script in the Startup folder is what wakes it. Switching login off leaves the bridge you are using alone; it only stops the next boot from starting one."
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
/** The global config files each AI tool reads for itself — ~/.claude/CLAUDE.md
 *  and settings.json, opencode's pair when it is installed. Unlike EnvPanel
 *  below, nothing here is layered over anything: the file on disk IS the state,
 *  so a save is a write and there is no RESET to fall back to. Hence an
 *  explicit SAVE rather than EnvPanel's save-on-blur — and a refused write
 *  (invalid JSON) needs somewhere to say so. */
function AgentConfigPanel() {
  const [tools, setTools] = useState<AgentConfigTool[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<{ id: string; message: string } | null>(null);

  useEffect(() => {
    void api.agentConfig().then((r) => setTools(r.tools)).catch(() => setTools([]));
  }, []);

  async function save(id: string, content: string) {
    setBusy(id);
    setErr(null);
    try {
      setTools((await api.setAgentConfig(id, content)).tools);
      setDrafts((d) => { const next = { ...d }; delete next[id]; return next; });
    } catch (e) {
      setErr({ id, message: e instanceof Error ? e.message : "could not save" });
    } finally {
      setBusy(null);
    }
  }

  if (tools === null) return <Placeholder icon={LoaderCircle} spin>Reading each tool’s config files…</Placeholder>;
  if (!tools.length)
    return <Placeholder icon={TriangleAlert}>This bridge is running a build without the agent-config route. Restart it.</Placeholder>;

  return (
    <>
      {tools.map((t, ti) => (
        <Section
          key={t.id}
          title={t.label}
          top={ti > 0}
          info={
            ti === 0
              ? "These are the tools' own files, not bridge settings: written verbatim to the paths each tool reads for itself, and just as editable from a terminal or from Claude Code's own /config. A save lands immediately and the next turn picks it up — nothing restarts. A .json file is parsed before it is written, so a typo comes back as an error instead of quietly voiding every setting in it."
              : undefined
          }
        >
          <div style={CARD}>
            {!t.installed ? (
              <Row first label="NOT INSTALLED" desc={`${t.hint} — nothing to configure until it is`} />
            ) : t.files.map((f, i) => {
              const text = drafts[f.id] ?? f.content;
              const dirty = text !== f.content;
              return (
                <div
                  key={f.id}
                  style={{ marginTop: i ? 11 : 0, paddingTop: i ? 11 : 0, borderTop: i ? RULE : undefined }}
                >
                  <Row
                    first
                    label={f.name}
                    desc={
                      <>
                        {f.hint}
                        <span style={{ color: "var(--txd)" }}> · {f.path}</span>
                        {!f.exists && <span style={{ color: "var(--txd)" }}> · not created yet</span>}
                      </>
                    }
                  >
                    <button
                      onClick={() => void (busy || !dirty ? null : save(f.id, text))}
                      disabled={!!busy || !dirty || !!f.error}
                      style={{
                        appearance: "none", cursor: dirty && !busy ? "pointer" : "default",
                        border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)",
                        background: "transparent", color: dirty ? "var(--acc)" : "var(--txd)",
                        fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1.5,
                        padding: "6px 12px", flex: "none",
                      }}
                    >
                      {busy === f.id ? "SAVING…" : dirty ? "SAVE" : "SAVED"}
                    </button>
                  </Row>
                  {f.error ? (
                    <div style={{ ...NOTE, color: "var(--err)" }}>{f.error}</div>
                  ) : (
                    <textarea
                      value={text}
                      disabled={busy === f.id}
                      spellCheck={false}
                      rows={14}
                      onChange={(e) => {
                        const v = e.target.value;
                        setDrafts((d) => ({ ...d, [f.id]: v }));
                      }}
                      style={{
                        ...field, width: "100%", marginTop: 8, resize: "vertical",
                        lineHeight: 1.6, letterSpacing: 0,
                        fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t95)",
                      }}
                    />
                  )}
                  {err?.id === f.id && (
                    <div style={{ ...NOTE, color: "var(--err)", marginTop: 6 }}>{err.message}</div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      ))}
    </>
  );
}

function EnvPanel() {
  const [rows, setRows] = useState<EnvSetting[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Which row was refused, and why. A rejection belongs beside the field that
  // caused it — at the foot of eight scrolling blocks nobody sees it.
  const [err, setErr] = useState<{ key: string; message: string } | null>(null);

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

  const groups = [...new Set(rows.map((r) => r.group))];
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
            {rows.filter((r) => r.group === g).map((s, i) => {
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
            the plugin, so they&apos;re removed in the SKILLS tab, not here. Every server on costs
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

/* HOOKS — the one door into this machine that isn't a person typing. Each row is
   a URL you paste into GitHub, a CI job, an error monitor or your own script;
   anything that POSTs to it lands in Telegram and in the feed below.

   Every hook here only notifies. Nothing on this panel can make an inbound POST
   start a run, because a POST that spawns Claude on this machine is remote code
   execution and the default has to be the harmless one. See bridge/hooks.py. */
function HooksPanel() {
  const [info, setInfo] = useState<HooksInfo | null>(null);
  // Same client-newer-than-bridge case McpPanel handles: a dashboard built from
  // this commit against a process that started before it gets a 404, not a panel.
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState("");
  const [label, setLabel] = useState("");
  const [source, setSource] = useState("github");
  const [secret, setSecret] = useState("");

  const load = () =>
    api
      .hooks()
      .then((r) => {
        setInfo(r);
        setStale(false);
      })
      .catch((e) => setStale(e instanceof Error && e.message.includes("404")));

  useEffect(() => {
    void load();
  }, []);

  async function add() {
    if (busy) return;
    setBusy("+");
    setErr(null);
    try {
      const r = await api.hookAction("create", {
        label: label.trim() || source,
        source,
        secret: secret.trim(),
      });
      if (r.error) setErr(r.error);
      else {
        setLabel("");
        setSecret("");
        await load();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  async function drop(token: string) {
    setBusy(token);
    setErr(null);
    try {
      await api.hookAction("delete", { token });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  function copy(h: { token: string; url: string }) {
    void navigator.clipboard.writeText(h.url).then(() => {
      setCopied(h.token);
      setTimeout(() => setCopied(""), 1500);
    });
  }

  const rows = info?.hooks ?? [];
  const events = info?.events ?? [];

  return (
    <>
      <Section
        title="INBOUND HOOKS"
        info={
          <>
            A URL that anything on the internet can POST to, which pushes what it receives to
            Telegram. Paste one into a GitHub repo&apos;s webhook settings, a CI job&apos;s
            notification step, or your own script. The token in the URL is the whole credential, so
            treat it like a password and REVOKE any you have pasted somewhere you regret. Setting a
            secret when you mint one adds a signature check on top — GitHub and Sentry both sign,
            and a hook with a secret refuses anything unsigned.
          </>
        }
      >
        <div style={CARD}>
          <div style={{ ...KV, marginBottom: rows.length ? 12 : 0 }}>
            <span style={KEY_TX}>
              {stale ? "NEEDS A RESTART" : info === null ? "READING…" : `${rows.length} HOOK${rows.length === 1 ? "" : "S"}`}
            </span>
          </div>

          {stale && (
            <div style={{ fontSize: "var(--t105)", color: "var(--txl)" }}>
              the bridge needs a restart before it can answer this
            </div>
          )}
          {!stale && info !== null && rows.length === 0 && (
            <div style={{ fontSize: "var(--t105)", color: "var(--txl)" }}>
              Nothing can reach this machine yet. Mint one below.
            </div>
          )}
          {!stale && info !== null && !info.public && rows.length > 0 && (
            <div style={{ fontSize: "var(--t105)", color: "var(--txl)", marginBottom: 10 }}>
              No tunnel configured (PREVIEW_HOSTNAME), so these are paths, not addresses — nothing
              outside can reach them until the Mini App has a public host.
            </div>
          )}

          {rows.map((h) => (
            <div
              key={h.token}
              style={{
                display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
                padding: "8px 0", borderTop: "1px solid var(--line)",
              }}
            >
              <span style={{ fontWeight: 600 }}>{h.label}</span>
              <span style={{ color: "var(--txd)", fontSize: "var(--t95)" }}>{h.source}</span>
              {h.signed && (
                <span style={{ color: "var(--txd)", fontSize: "var(--t95)" }}>· signed</span>
              )}
              <span style={{ color: "var(--txl)", fontSize: "var(--t95)" }}>
                · {h.hits} hit{h.hits === 1 ? "" : "s"}
                {!h.last_seen ? " · never fired" : ago(h.last_seen) === "now" ? " · just now" : ` · ${ago(h.last_seen)} ago`}
              </span>
              <span style={{ flex: 1 }} />
              <MiniBtn onClick={() => copy(h)}>{copied === h.token ? "COPIED" : "COPY URL"}</MiniBtn>
              <MiniBtn disabled={busy === h.token} onClick={() => void drop(h.token)}>
                {busy === h.token ? "…" : "REVOKE"}
              </MiniBtn>
            </div>
          ))}
          {err && (
            <div style={{ marginTop: 10, fontSize: "var(--t105)", color: "var(--bad)" }}>{err}</div>
          )}
        </div>
      </Section>

      <Section
        title="ADD A HOOK"
        top
        info={
          <>
            SOURCE only labels the row and picks which signature header is checked; any sender can
            post to any hook. Leave SECRET empty and the token alone authorises the caller — fine
            for a script you control, worth filling in for anything public. GitHub calls it the
            webhook secret, Sentry calls it the client secret.
          </>
        }
      >
        <div style={CARD}>
          <div style={{ ...LINE, marginTop: 0 }}>
            <Cell label="SOURCE" grow="1 1 260px">
              <Segmented
                options={(info?.sources ?? ["github", "sentry", "ci", "generic"]).map((sc) => ({
                  label: sc.toUpperCase(),
                  value: sc,
                }))}
                value={source}
                onPick={setSource}
              />
            </Cell>
          </div>
          <div style={{ ...ROW, gap: 8 }}>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="label"
              style={{ ...FIELD, flex: "none", width: 130 }}
            />
            <input
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void add()}
              placeholder="signing secret (optional)"
              style={FIELD}
            />
            <MiniBtn disabled={!!busy || stale} onClick={() => void add()}>
              {busy === "+" ? "…" : "MINT"}
            </MiniBtn>
          </div>
        </div>
      </Section>

      <Section
        title="RECENT EVENTS"
        top
        info={
          <>
            The last few hundred events any hook received, newest first. The line is a best-effort
            summary — the bridge stores the whole payload but does not try to understand each
            sender&apos;s shape, so a source it cannot read still shows up, just without a title.
          </>
        }
      >
        <div style={CARD}>
          {events.length === 0 ? (
            <div style={{ fontSize: "var(--t105)", color: "var(--txl)" }}>
              Nothing received yet.
            </div>
          ) : (
            events.map((e, i) => (
              <div
                key={e.id}
                style={{
                  display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap",
                  padding: "6px 0",
                  borderTop: i ? "1px solid var(--line)" : "none",
                }}
              >
                <span style={{ color: "var(--txd)", fontSize: "var(--t95)", minWidth: 34 }}>
                  {ago(e.received)}
                </span>
                <span style={{ fontWeight: 600 }}>{e.label ?? e.source}</span>
                <span style={{ color: "var(--txl)" }}>{e.title ?? "(no summary)"}</span>
                {e.url && (
                  <a
                    href={e.url}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: "var(--txd)", fontSize: "var(--t95)" }}
                  >
                    open
                  </a>
                )}
              </div>
            ))
          )}
        </div>
      </Section>
    </>
  );
}

function AccountsPanel() {
  const [rows, setRows] = useState<AccountInfo[] | null>(null);
  const [policy, setPolicy] = useState("ask");
  const [free, setFree] = useState<FreeAgents>({ installed: false, providers: [] });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A sign-in in flight: the CLI is parked on its "paste the code" prompt in a
  // fresh profile, waiting for what the browser hands back.
  const [login, setLogin] = useState<{ slot: number; url: string } | null>(null);

  const load = () =>
    api
      .accounts()
      .then((r) => {
        setRows(r.accounts);
        setPolicy(r.default_policy);
        // A bridge still running the pre-setup build answers with a bare list of
        // labels; show no rungs rather than throwing until it restarts.
        setFree(
          Array.isArray(r.free_agents?.providers) ? r.free_agents : { installed: false, providers: [] },
        );
        if (r.pending_login?.url)
          setLogin({ slot: r.pending_login.slot, url: r.pending_login.url });
      })
      .catch(() => setRows([]));

  useEffect(() => {
    void load();
  }, []);

  async function act(action: "add" | "remove" | "disable" | "enable", slot?: number) {
    setBusy(true);
    setErr(null);
    try {
      await api.accountAction(action, slot);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  // No slot adds an account; a slot signs that one back in where it lives —
  // what an expired OAuth session needs, and what the bot's dead-login button does.
  async function startLogin(slot?: number) {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.loginBegin(slot);
      setLogin({ slot: r.slot, url: r.url });
      window.open(r.url, "_blank", "noopener");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not start the sign-in");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Section
        title="ON USAGE LIMIT"
        info="The default for new chats. Any one chat can override it — right-click it in the sessions list."
      >
        <div style={CARD}>
          <Segmented
            options={POLICY_OPTS}
            value={policy}
            onPick={(v) => {
              setPolicy(v);
              void api.setDefaultPolicy(v).catch(() => void load());
            }}
          />
          {/* Stays visible: it changes with the choice, so it's feedback on what
              you just picked rather than prose about the panel. */}
          <div style={{ ...NOTE, marginTop: 9 }}>{POLICY_BLURB[policy]}</div>
        </div>
      </Section>

      <Section
        title="CLAUDE LOGINS"
        top
        info={
          <>
            ADD ANOTHER ACCOUNT signs in right here: a link opens, you log in as the other account,
            and you paste the code back. Your current login is never touched — the new one gets its
            own profile. COPY CURRENT LOGIN is the old way in: it snapshots whoever is logged in at{" "}
            <span style={{ color: "var(--txd)" }}>~/.claude</span> right now, which only helps if you
            already switched accounts in a terminal. RE-LOGIN signs an account that is already here
            back in — the fix when a turn dies on{" "}
            <span style={{ color: "var(--txd)" }}>OAuth session expired</span>, where adding a new
            account would just be the same login again. Accounts share transcripts and skills; only
            the credentials differ.
          </>
        }
      >
      <div style={CARD}>
        {rows === null && <div style={{ ...KEY_TX }}>LOADING…</div>}
        {rows?.length === 0 && (
          <div style={{ fontSize: "var(--t105)", color: "var(--txl)" }}>
            No login found. Run <span style={{ color: "var(--tx)" }}>claude /login</span> in a
            terminal.
          </div>
        )}
        {rows?.map((a) => (
          <div key={a.slot} style={{ ...KV, marginTop: a.slot === rows[0].slot ? 0 : 10 }}>
            <span style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ ...KEY_TX, color: "var(--acc)", flex: "none" }}>A{a.slot}</span>
              <span
                style={{
                  fontSize: "var(--t11)",
                  color: a.disabled ? "var(--txd)" : "var(--tx)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {a.email ?? "unknown"}
              </span>
              {a.default && <span style={{ ...CAPTION, width: "auto" }}>DEFAULT</span>}
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 10, flex: "none" }}>
              <span
                style={{
                  fontSize: "var(--t105)",
                  color: a.left === null ? "var(--txd)" : a.left <= 1 ? "var(--warn)" : "var(--ok)",
                }}
              >
                {a.left === null ? "—" : `${a.left}% LEFT`}
              </span>
              <MiniBtn disabled={busy || !!login} onClick={() => void startLogin(a.slot)}>
                RE-LOGIN
              </MiniBtn>
              {!a.default && (
                <>
                  <MiniBtn disabled={busy} onClick={() => void act(a.disabled ? "enable" : "disable", a.slot)}>
                    {a.disabled ? "ENABLE" : "DISABLE"}
                  </MiniBtn>
                  <MiniBtn disabled={busy} danger onClick={() => void act("remove", a.slot)}>
                    REMOVE
                  </MiniBtn>
                </>
              )}
            </span>
          </div>
        ))}
        {login ? (
          <LoginFlow
            url={login.url}
            onDone={async () => {
              setLogin(null);
              await load();
            }}
            onSubmit={(code) => api.loginSubmit(login.slot, code)}
            onCancel={async () => {
              await api.loginCancel(login.slot).catch(() => {});
              setLogin(null);
              await load();
            }}
          />
        ) : (
          <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <MiniBtn disabled={busy} onClick={() => void startLogin()}>
              + ADD ANOTHER ACCOUNT
            </MiniBtn>
            <MiniBtn disabled={busy} onClick={() => void act("add")}>
              COPY CURRENT LOGIN
            </MiniBtn>
            {err && <span style={{ fontSize: "var(--t10)", color: "var(--warn)" }}>{err}</span>}
          </div>
        )}
      </div>
      </Section>

      <Section
        title="FREE AGENTS"
        top
        info={
          <>
            A free agent takes the turn when every Claude account is spent — a different provider on
            a fresh session, briefed with the task so far. Keys are saved to{" "}
            <span style={{ color: "var(--txd)" }}>~/.mystical/freeagents.json</span> and take effect
            on the next handover; no restart. A key already in the bridge&apos;s environment wins and
            shows as FROM ENV.
          </>
        }
      >
        <div style={CARD}>
          {!free.installed && (
            <div style={{ fontSize: "var(--t105)", color: "var(--txl)", marginBottom: 13 }}>
              <span style={{ color: "var(--warn)" }}>opencode is not installed</span> — the rungs
              below stay unusable until it is. Install it with{" "}
              <code style={CODE}>curl -fsSL https://opencode.ai/install | bash</code>
            </div>
          )}
          {free.providers.map((p, i) => (
            <FreeAgentRow
              key={p.provider}
              p={p}
              first={i === 0}
              installed={free.installed}
              onSave={(v) => api.setFreeAgent(p.env, v).then((r) => setFree(r.free_agents))}
            />
          ))}
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

/** One free-agent rung with the box that configures it. */
function FreeAgentRow({
  p,
  first,
  installed,
  onSave,
}: {
  p: FreeAgentInfo;
  first: boolean;
  installed: boolean;
  onSave: (value: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(p.needs === "model" ? p.model : "");
  const [busy, setBusy] = useState(false);

  async function save(v: string) {
    setBusy(true);
    await onSave(v).catch(() => {});
    setBusy(false);
    setOpen(false);
    setValue("");
  }

  const state = p.ready ? "READY" : p.configured ? "NEEDS OPENCODE" : "NOT SET";
  return (
    <div style={{ marginTop: first ? 0 : 13 }}>
      <div style={KV}>
        <span style={{ fontSize: "var(--t11)", color: p.ready ? "var(--tx)" : "var(--txl)" }}>{p.label}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 9, flex: "none" }}>
          <span style={{ fontSize: "var(--t10)", color: p.ready ? "var(--ok)" : "var(--txd)" }}>
            {p.source === "env" ? "FROM ENV" : state}
          </span>
          {p.source !== "env" && (
            <MiniBtn disabled={busy} onClick={() => setOpen(!open)}>
              {p.configured ? "CHANGE" : "SET UP"}
            </MiniBtn>
          )}
          {p.source === "saved" && (
            <MiniBtn disabled={busy} danger onClick={() => void save("")}>
              CLEAR
            </MiniBtn>
          )}
        </span>
      </div>
      {open && (
        <div style={{ display: "flex", gap: 8, marginTop: 9 }}>
          <input
            value={value}
            autoFocus
            type={p.needs === "key" ? "password" : "text"}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && value.trim() && void save(value.trim())}
            placeholder={p.needs === "key" ? `${p.env} — paste the API key` : "model name, e.g. qwen2.5-coder"}
            style={FIELD}
          />
          <MiniBtn disabled={busy || !value.trim()} onClick={() => void save(value.trim())}>
            {busy ? "…" : "SAVE"}
          </MiniBtn>
        </div>
      )}
      {!open && p.ready && (
        <div style={{ fontSize: "var(--t95)", color: "var(--txd)", marginTop: 4 }}>{p.model}</div>
      )}
    </div>
  );
}

function MiniBtn({
  children,
  onClick,
  disabled,
  danger,
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** An icon-only button has to say what it is somewhere. */
  title?: string;
}) {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        appearance: "none",
        cursor: disabled ? "default" : "pointer",
        border: `1px solid color-mix(in srgb, ${danger ? "var(--warn)" : "var(--acc)"} 24%, transparent)`,
        background: hov && !disabled ? `color-mix(in srgb, ${danger ? "var(--warn)" : "var(--acc)"} 10%, transparent)` : "transparent",
        color: disabled ? "var(--txd)" : danger ? "var(--warn)" : "var(--tx)",
        fontFamily: "inherit",
        fontSize: "var(--t95)",
        letterSpacing: 1,
        padding: "4px 9px",
        opacity: disabled ? 0.5 : 1,
        // Icon children would otherwise sit on the text baseline and ride high.
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5,
      }}
    >
      {children}
    </button>
  );
}

/** Named snapshots of the run knobs plus the open session's tool switches.
 *  SAVE captures whatever is set right now; APPLY writes it all back. */
function ProfilesPanel({
  settings,
  sessionTools,
  onPatch,
  onSessionTools,
}: {
  settings: HudSettings;
  sessionTools: string[];
  onPatch: (patch: Partial<HudSettings>) => void;
  onSessionTools: (rules: string[]) => void;
}) {
  const [profiles, setProfiles] = useState<Profile[]>(loadProfiles);
  const [name, setName] = useState("");

  const write = (next: Profile[]) => {
    setProfiles(next);
    saveProfiles(next);
  };

  const save = () => {
    const n = name.trim().slice(0, 32);
    if (!n) return;
    const p: Profile = {
      id: `${Date.now().toString(36)}`,
      name: n,
      model: settings.model,
      effort: settings.effort,
      perm: settings.perm,
      ponytail: settings.ponytail,
      agent: settings.agent,
      disabledTools: sessionTools,
    };
    // Same name = replace, so re-saving after a tweak doesn't grow a pile of
    // near-identical profiles.
    write([...profiles.filter((x) => x.name !== n), p]);
    setName("");
  };

  const apply = (p: Profile) => {
    onPatch({ model: p.model, effort: p.effort, perm: p.perm,
              ponytail: p.ponytail, agent: p.agent });
    onSessionTools(p.disabledTools);
  };

  const btn = (accent: string): CSSProperties => ({
    appearance: "none", cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t85)",
    letterSpacing: 1, padding: "5px 10px", flex: "none",
    border: `1px solid color-mix(in srgb, ${accent} 30%, transparent)`,
    background: "transparent", color: accent,
  });

  return (
    <div style={CARD}>
      {profiles.length === 0 && (
        <div style={{ fontSize: "var(--t10)", color: "var(--txd)" }}>
          No profiles yet — set the knobs above and this session&apos;s tools, then save them under a name.
        </div>
      )}
      {profiles.map((p, i) => (
        <div key={p.id}
          style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderTop: i ? RULE : undefined }}>
          <span style={{ fontSize: "var(--t12)", color: "var(--txb)", flex: "none" }}>{p.name}</span>
          <span style={{ fontSize: "var(--t85)", letterSpacing: 1, color: "var(--txd)", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {describe(p)}
          </span>
          <span style={{ flex: 1 }} />
          <button onClick={() => apply(p)} style={btn("var(--ok)")}>APPLY</button>
          <button onClick={() => write(profiles.filter((x) => x.id !== p.id))}
            style={btn("var(--err)")} title="delete profile">✕</button>
        </div>
      ))}
      <div style={{ ...ROW, marginTop: profiles.length ? 12 : 11 }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") save(); }}
          placeholder="name this setup"
          style={{ flex: "1 1 auto", minWidth: 0, maxWidth: 340, background: "color-mix(in srgb, var(--panel2) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--acc) 22%, transparent)", outline: "none", color: "var(--txb)", fontFamily: "inherit", fontSize: "var(--t11)", padding: "6px 9px" }}
        />
        <button onClick={save} style={btn("var(--acc)")}>SAVE CURRENT</button>
      </div>
    </div>
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
    agents,
    weather,
    onSetCity,
    onSetUnit,
    station,
    onStation,
    onFeed,
    onReplayBoot,
    onClose,
    sessionTools,
    onSessionTools,
    onOpenInspector,
  } = props;

  const [tab, setTab] = useState<Tab>("appearance");
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
  // Two sections only exist while their own switch is on, and a hit that
  // scrolls to nothing is worse than no hit.
  const hidden = new Set([
    ...(settings.pushSound ? [] : ["PER EVENT"]),
  ]);
  const hits = search(q, env, hidden);
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
  const autoBase = autoBaseFont(window.innerWidth, window.innerHeight);
  const [escHover, setEscHover] = useState(false);
  const [replayHover, setReplayHover] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);

  return (
    <div
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
        className="panel"
        style={{
          // Content is capped at 760px by .mcol and the rail is 180 — a modal at
          // the shared --modal-w (75vw) therefore spent ~130px a side on empty
          // gutter. This width IS the content's width.
          width: "min(976px, 94vw)",
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
          <span style={{ fontSize: "var(--t95)", letterSpacing: 2.5, color: "var(--txl)" }}>
            CONFIGURE
          </span>
          <span
            style={{ fontSize: "var(--t15)", color: "var(--txb)", letterSpacing: ".5px", whiteSpace: "nowrap" }}
            className="glow"
          >
            DASHBOARD SETTINGS
          </span>
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
            placeholder="search settings…"
            style={{ ...field, flex: "0 1 220px", minWidth: 140 }}
          />
          <button
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
            ESC ✕
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
        <div style={{
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
            {TABS.map((t, i) => (
              <Fragment key={t.key}>
                {t.group !== TABS[i - 1]?.group && <div className="setgroup">{t.group}</div>}
                <button
                  className={tab === t.key ? "on" : undefined}
                  aria-current={tab === t.key ? "page" : undefined}
                  onClick={() => setTab(t.key)}
                  style={{ display: "flex", alignItems: "center", gap: 8 }}
                >
                  <t.icon size={14} strokeWidth={1.7} aria-hidden style={{ flex: "none" }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: "var(--t10)", letterSpacing: 1.5 }}>{t.label}</div>
                    <div className="hint"
                      style={{ fontSize: "var(--t85)", letterSpacing: 0.3, color: "var(--txl)", marginTop: 2 }}>
                      {t.hint}
                    </div>
                  </div>
                </button>
              </Fragment>
            ))}
          </div>

          <div ref={pane} className="mscroll mcol" style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: 18 }}>
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
                <Section title="THEME · DARK">
                  <ThemeCardGrid cards={DARK_CARDS} settings={settings} onTheme={onTheme} />
                </Section>
                <Section title="THEME · LIGHT" top>
                  <ThemeCardGrid cards={LIGHT_CARDS} settings={settings} onTheme={onTheme} />
                </Section>

                {themeHasCrt(settings.theme) && (
                  <Section
                    title="CRT EFFECTS"
                    top
                    info="Kept when you recolour AURORA; reset when you switch profile. The paper and daylight themes have no CRT layer at all."
                  >
                    <CrtToggles settings={settings} onToggle={onToggle} />
                  </Section>
                )}

                {/* One block, not two: a section heading and a fold-out
                    paragraph each, for one <select> each, spent more of the tab
                    on the frame than on the two controls it framed. */}
                <Section
                  title="TYPE"
                  top
                  info={
                    <>
                      A theme is a palette; the type voice is yours.{" "}
                      <span style={{ color: "var(--txd)" }}>THEME</span> follows whichever one the
                      palette brought — anything else stays put when you switch palettes. Code and
                      logs keep their monospace either way. Every size in the HUD derives from the
                      base: captions, body and headings move together, spacing stays put, and{" "}
                      <span style={{ color: "var(--txd)" }}>AUTO</span> tracks the window ({autoBase}px
                      on this one).
                    </>
                  }
                >
                  <div style={CARD}>
                    <div style={{ ...LINE, marginTop: 0 }}>
                      <Cell label="TYPEFACE" grow="2 1 240px">
                        {/* Each name is set in the face it names — THEME included,
                            which is how you see what the palette brought without
                            applying it. */}
                        <select
                          value={settings.font}
                          onChange={(e) => onPatch({ font: e.target.value })}
                          style={{ ...field, width: "100%", fontFamily: fontStack(settings.font, settings.theme) || "inherit" }}
                        >
                          {FONTS.map((f) => (
                            <option
                              key={f.key}
                              value={f.key}
                              style={{ fontFamily: fontStack(f.key, settings.theme) || "inherit" }}
                            >
                              {f.label}
                            </option>
                          ))}
                        </select>
                      </Cell>
                      <Cell label="BASE SIZE" grow="1 1 130px">
                        <select
                          value={String(settings.baseFont)}
                          onChange={(e) => onPatch({ baseFont: Number(e.target.value) })}
                          style={{ ...field, width: "100%" }}
                        >
                          {BASE_FONT_OPTS.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      </Cell>
                    </div>
                  </div>
                </Section>

                <Section title="BOOT SEQUENCE" top>
                  <div style={CARD}>
                    <Row first label="INTRO" desc="Replay the intro this dashboard boots with.">
                      <button
                        onClick={onReplayBoot}
                        onMouseEnter={() => setReplayHover(true)}
                        onMouseLeave={() => setReplayHover(false)}
                        style={{
                          appearance: "none",
                          cursor: "pointer",
                          border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)",
                          background: replayHover ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent",
                          color: "var(--tx)",
                          fontFamily: "inherit",
                          fontSize: "var(--t10)",
                          letterSpacing: 1.5,
                          padding: "6px 12px",
                          flex: "none",
                        }}
                      >
                        ▸ REPLAY
                      </button>
                    </Row>
                  </div>
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
                  title="OUTPUT STYLE"
                  info="How the whole session draws — your prompt, the ledger of what it did, a delegated run, and the reply itself with its tables and its code. Five languages, one per column of the Chat Elements sheet: each is a whole grammar rather than a border swap. Each tile is the real thing under the real stylesheet, so what you see is what the transcript does."
                >
                  <OutputStylePicker
                    value={settings.toolStyle}
                    onPick={(toolStyle) => onPatch({ toolStyle })}
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
                  </div>
                </Section>
              </>
            )}

            {shown === "indicator" && (
              <Section title="WORKING INDICATOR">
                <IndicatorPicker settings={settings} onPatch={onPatch} />
              </Section>
            )}

            {shown === "ambient" && (
              <>
                <Section title="WEATHER · header clock">
                  <WeatherCard weather={weather} onSetCity={onSetCity} onSetUnit={onSetUnit} />
                </Section>

                <Section
                  title="CLAUDE·FM"
                  top
                  info="Play/pause and skip live on the header pill. Station resets to the first one on reload; volume is remembered."
                >
                  <div style={CARD}>
                    <div style={{ ...LINE, marginTop: 0 }}>
                      <Cell label="STATION" grow="1 1 220px">
                        <select
                          value={station}
                          onChange={(e) => onStation(Number(e.target.value))}
                          style={{ ...field, width: "100%" }}
                        >
                          {RADIO_STATIONS.map((s, i) => (
                            <option key={s.title} value={i}>
                              {s.title} — {s.artist}
                            </option>
                          ))}
                        </select>
                      </Cell>
                      <Cell label="VOLUME" grow="none">
                        <div style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 26 }}>
                          <Volume value={settings.radioVolume} onChange={(radioVolume) => onPatch({ radioVolume })} />
                        </div>
                      </Cell>
                    </div>
                  </div>
                </Section>
              </>
            )}

            {shown === "session" && (
              <>
                <Section
                  title="RUN DEFAULTS"
                  info={
                    <>
                      The composer&apos;s dropdowns are these same knobs — set them here and they
                      stick across reloads. MODE ·{" "}
                      <span style={{ color: "var(--txd)" }}>Session</span> keeps whatever mode the
                      session was started with. AGENT ·{" "}
                      <span style={{ color: "var(--txd)" }}>Default login</span> is whichever account
                      the ACCOUNTS tab marks default.
                    </>
                  }
                >
                  <div style={CARD}>
                    <div style={{ ...ROW, marginTop: 0, marginBottom: 6 }}>
                      <span style={KEY_TX}>MODEL</span>
                      <span style={{ flex: 1 }} />
                      <span style={{ ...CAPTION, flex: "none" }}>SHOW ALL</span>
                      <Switch on={settings.allModels} onClick={() => onPatch({ allModels: !settings.allModels })} />
                    </div>
                    <Segmented
                      options={(settings.allModels ? models : latestPerFamily(models, settings.model))
                        .map((m) => ({ label: m.label.toUpperCase(), value: m.id }))}
                      value={settings.model}
                      onPick={(model) => onPatch({ model })}
                    />
                    <div style={LINE}>
                      <PickCell
                        label="AGENT"
                        value={settings.agent}
                        options={[{ id: "", label: "DEFAULT LOGIN" }, ...agents]}
                        onPick={(agent) => onPatch({ agent })}
                      />
                      <PickCell label="MODE" value={settings.perm} options={PERMS} onPick={(perm) => onPatch({ perm })} />
                      <PickCell label="EFFORT" value={settings.effort} options={EFFORTS} onPick={(effort) => onPatch({ effort })} />
                      {aiFeatures.ponytail && (
                        <PickCell label="PONYTAIL" value={settings.ponytail} options={PONYTAILS} onPick={(ponytail) => onPatch({ ponytail })} />
                      )}
                    </div>
                  </div>
                </Section>

                <Section
                  title="PROFILES"
                  top
                  info="A profile carries the four knobs above, the runtime, and the tools this session has switched off. APPLY writes all of them — the knobs globally, the tools onto the open session."
                >
                  <ProfilesPanel
                    settings={settings}
                    sessionTools={sessionTools}
                    onPatch={onPatch}
                    onSessionTools={onSessionTools}
                  />
                </Section>
              </>
            )}

            {shown === "notifications" && (
              <>
                <Section title="DESKTOP">
                  <div style={CARD}>
                    <Row
                      first
                      label="OS NOTIFICATIONS"
                      info={pushSupported()
                        ? "A banner when a session finishes or needs an answer — only for the ones you're not watching. Telegram still covers you when no dashboard is open."
                        : "This browser has no Notification API — Telegram remains the only push path."}
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
                  </div>
                </Section>

                {/* Sound is its own switch, not a rider on DESKTOP: the failure
                    sound belongs to an in-app toast, which fires whether or not
                    the OS is showing banners. */}
                <Section title="SOUND" top>
                  <div style={CARD}>
                    <Row
                      first
                      label="PLAY A SOUND"
                      info="For when the news lands on a screen you aren't looking at. One per event per batch, not per session."
                    >
                      <Switch
                        on={settings.pushSound}
                        onClick={() => {
                          // Switching it on plays it once — otherwise you find out how
                          // loud it is at the wrong moment.
                          if (!settings.pushSound) chime(settings.pushTone, settings.pushVolume);
                          onPatch({ pushSound: !settings.pushSound });
                        }}
                      />
                    </Row>
                    {settings.pushSound && (
                      // Every change plays itself: picking a notification sound you
                      // can't hear until the next notification is guesswork.
                      <div style={{ ...ROW, marginTop: 12, paddingTop: 12, borderTop: RULE, alignItems: "flex-end", flexWrap: "wrap" }}>
                        <Cell label="DEFAULT TONE" grow="3 1 260px">
                          <Segmented
                            options={TONE_OPTS}
                            value={settings.pushTone}
                            onPick={(pushTone) => { onPatch({ pushTone }); chime(pushTone, settings.pushVolume); }}
                          />
                        </Cell>
                        <Cell label="VOLUME" grow="1 1 150px">
                          {/* Preview when the drag ends, not on every step — a chime
                              per pixel of travel is a swarm, not a sample. */}
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}
                            onPointerUp={() => chime(settings.pushTone, settings.pushVolume)}
                            onKeyUp={() => chime(settings.pushTone, settings.pushVolume)}>
                            <Volume
                              value={settings.pushVolume}
                              onChange={(pushVolume) => onPatch({ pushVolume })}
                            />
                          </div>
                        </Cell>
                      </div>
                    )}
                  </div>
                </Section>

                {settings.pushSound && (
                  <Section
                    title="PER EVENT"
                    top
                    info={
                      <>
                        Pack sounds come from{" "}
                        <a href="https://www.peonping.com/" target="_blank" rel="noreferrer"
                          style={{ color: "var(--acc)" }}>peonping.com</a>
                        {" "}and stream from the pack&apos;s own repo — nothing is installed here.
                        An event left on DEFAULT rings the tone above.
                      </>
                    }
                  >
                    <div style={CARD}>
                      <SoundBoard settings={settings} onPatch={onPatch} />
                    </div>
                  </Section>
                )}
              </>
            )}

            {shown === "tags" && (
              <Section
                title="TAGS"
                info="Tags come from the model when it names a session. The chart is the twelve most-worn, each against the most-used one; MANAGE opens the full set, where renaming a tag onto an existing one merges them and every session wearing the old name follows."
              >
                <TagsPanel />
              </Section>
            )}

            {shown === "ai" && <AiPanel />}

            {shown === "agentconfig" && <AgentConfigPanel />}

            {shown === "mcp" && <McpPanel />}
            {shown === "hooks" && <HooksPanel />}
            {shown === "accounts" && <AccountsPanel />}

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
  );
}
