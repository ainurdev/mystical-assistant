import { Fragment, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Blocks, Brain, Bug, ChevronRight, ChevronsRight, DraftingCompass, Gauge, GitMerge, Hammer, Hand, Merge, MessageCircleQuestionMark, Paperclip, Pause, Pin, Play, Route as RouteIcon, Scissors, Settings, ShieldHalf, SkipForward, SlidersHorizontal, Square, TriangleAlert, UserRound, Users, Zap, type LucideIcon } from "lucide-react";
import { api, type AccountInfo, type FlowChange, type FlowSetting, type EffortLevel, type GitStatus, type GraphState, type ModelId, type Route, type SlashCommand, type UsageInfo } from "../api";
import { KINDS, KIND_ORDER, kindFacts, nextKind, presetFor, sendPlan, shownKind, type Fact, type KindId, type KindPick, type KindRun, type LastCheck } from "../lib/kinds";
import { chipWindow, deadLogin, loginSlot, loginWindows, modelName, modelRows, type Window } from "../models";
import { describe, slotHue, type Profile } from "../lib/profiles";
import type { AgentPickers } from "../lib/agents";
import { ago, fmtReset, hhmm } from "../lib/surfaces";
import { loginName, otherLogin } from "../lib/limit";
import { freshness, lowWindow, meterTone, readAgo, windowWord } from "../lib/clisignals";
import { Spinner } from "./ui";
import { openSettings } from "../lib/opensettings";
import { useIntegrations } from "../lib/integrations";
import { ImageLightbox, MediaThumb, ZoomButton, isFileUrl, withName } from "./ImageLightbox";
import { FileIcon } from "../lib/fileicon";
import type { AskMode } from "./AskDock";
import { ICON_BODY } from "../lib/fileicons.gen";
import { applyMention, mentionAt, rankPaths, type Mention } from "../lib/mention";
import { isExact, rankCommands, slashAt } from "../lib/slash";
import { SMART_ZONE, caption, ghostFor, isDropped, isStale, shouldAutoApply, swapLead } from "../lib/route";
import type { FlowChip, FlowOption } from "../lib/flowview";
import type { FlowAct } from "../lib/useFlow";
import { Tip } from "./ui/Tip";
import { Switch } from "./hud/SettingsModal";
import { changeFlows, refreshFlowSettings, useFlowSettings } from "../lib/flowsettings";
import { useAiFeatures } from "../lib/ai";
import { promptSteps, runs } from "../lib/flowsteps";
import { flowRuns, saveRun } from "../lib/flowruns";
import { askConfirm } from "./ui/Ask";
import { useChatChrome } from "../lib/chatchrome";
import { MarkdownInput, type MarkdownInputHandle } from "./MarkdownInput";
import { HelpersRow } from "./HelpersRow";
import { rankProfiles, skillQuery, STEER_SOFT_WORDS, type Caps, type HelperConfig } from "../lib/multi";
import { multi as multiApi } from "../lib/multistore";
import { chatImagesInline, uploadChatImage, useChatImages } from "../lib/chatimages";
import { isInlineImage } from "../lib/embeds";
import { keyAttrs, SHORTCUTS } from "../lib/shortcuts";

const STILL_SAVING = "An image is still saving. Send again in a moment.";

export const EFFORTS: { id: EffortLevel | ""; label: string }[] = [
  { id: "", label: "Auto" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "XHigh" },
  { id: "max", label: "Max" },
];
// The session's operating mode. These are Claude Code's own permission modes —
// the ids and titles the CLI itself uses, in its own least-authority-first
// order — so the picker can't offer a posture `claude --permission-mode` would
// reject, or name one something Claude doesn't. The CLI also takes "manual", but
// that is just its alias for "default". Each row's tooltip is Claude's own
// one-line description of the mode; the row itself prints a shorter reading
// of it, so the six names explain themselves without a hover.
export const PERMS: { id: string; label: string; title?: string; hint?: string }[] = [
  { id: "plan", label: "Plan", hint: "plans only; runs no tools", title: "Planning mode, no actual tool execution." },
  { id: "default", label: "Manual", hint: "asks before anything dangerous", title: "Standard behavior, prompts for dangerous operations." },
  { id: "dontAsk", label: "Don't Ask", hint: "never asks; denies what isn't pre-approved", title: "Don't prompt for permissions, deny if not pre-approved." },
  { id: "acceptEdits", label: "Accept Edits", hint: "file edits go through unasked", title: "Auto-accept file edit operations." },
  { id: "auto", label: "Auto", hint: "a classifier approves or denies each prompt", title: "Use a model classifier to approve/deny permission prompts." },
  { id: "bypassPermissions", label: "Bypass", hint: "no checks at all — full autonomy", title: "Bypass all permission checks — full autonomy." },
];
// Per-run code-minimalism intensity, threaded to the runner's env (Task 4/8).
export const PONYTAILS: { id: string; label: string }[] = [
  { id: "", label: "Default" },
  { id: "off", label: "Off" },
  { id: "lite", label: "Lite" },
  { id: "full", label: "Full" },
  { id: "ultra", label: "Ultra" },
];

// Past this share of the window, COMPACT lights up. A fraction, not a token
// count: the ceiling moves with the model and with a session's own compact-at.
const COMPACT_SUGGEST = 0.75;
// The context readout is a segmented instrument, not a track: eight lamps read
// as fast as a bar at a tenth of the width, and the width is the point — the
// old full-bleed bar spent a whole row of the composer to render "1%".
const CTX_SEGMENTS = 8;
// The prompt box's kinds of work (lib/kinds), each with its glyph on the rail.
const KIND_ICON: Record<KindId, LucideIcon> = { design: DraftingCompass, build: Hammer, refactor: Blocks, fix: Bug, ship: GitMerge, ask: MessageCircleQuestionMark };
// The FLOW chip's and the FLOWS sheet's glyph per flow id (lib/flowview flowOf), looked up by plain string.
const FLOW_ICON: Record<string, LucideIcon> = KIND_ICON;
// The FLOWS sheet's line under a flow's name, and a one-step flow's row (a2-open).
const FLOW_ABOUT: Record<string, string> = {
  design: "grill, then draw it, then build", build: "grill, then build: here, or as tickets",
  refactor: "improve, then build as tickets", fix: "find the cause, fix it, then review",
  ship: "merge, check, clean up", ask: "an answer, nothing changed",
};
const ONE_STEP: Record<string, string> = { ship: "ship: merge, check, clean up" };
// PRESET names a run's fields as the box does; the bridge's flow settings as they do (lib/flowruns).
const RUN_KEY: Record<keyof KindRun, string> = { model: "model", perm: "mode", effort: "effort", ponytail: "trim" };
const PONYTAIL_TIP = "PONYTAIL — code-minimalism for this session's runs.\n\nClaude answers as a lazy senior dev: reuse what's already in the repo, stdlib or native platform before a new dependency, shortest diff that works, no speculative abstractions.\n\nOff = normal. Lite → Full → Ultra = increasing pressure to write less code. Default keeps whatever the bridge is configured with.";

// hint → a quieter second line under the label (what a mode does); tag → a
// small pill after it (PRESET's PROFILE, on the row the profile sets)
type DropOption<T extends string> = { id: T; label: string; short?: string; group?: string; tail?: ReactNode; title?: string; tone?: string; hint?: string; tag?: string };

/** The rows of a picker menu: every chip dropdown's (Drop), PRESET's model
 *  and mode selects among them, with the same usage meters on the models. */
function MenuRows<T extends string>({ options, value, onPick }: {
  options: DropOption<T>[];
  value: T;
  onPick: (id: T) => void;
}) {
  return (
    <>
      {options.map((o, i) => {
        const on = o.id === value;
        const heading = o.group && o.group !== options[i - 1]?.group ? o.group : null;
        return (
          <Fragment key={o.id}>
            {heading && (
              <div style={{
                fontSize: "var(--t8)", letterSpacing: 1, color: "var(--txd)", whiteSpace: "nowrap",
                padding: i ? "10px 11px 4px" : "8px 11px 4px",
                borderBottom: "1px solid color-mix(in srgb, var(--acc) 8%, transparent)",
              }}>
                {heading}
              </div>
            )}
            <button
              onClick={() => onPick(o.id)}
              title={o.title}
              style={{
                width: "100%", appearance: "none", cursor: "pointer", border: 0,
                borderBottom: "1px solid color-mix(in srgb, var(--acc) 8%, transparent)",
                background: on ? "color-mix(in srgb, var(--acc) 10%, transparent)" : "transparent",
                color: on ? "var(--txb)" : "var(--txm)", fontFamily: "inherit", fontSize: "var(--t105)",
                letterSpacing: ".3px", textAlign: "left", padding: "8px 11px",
                display: "flex", alignItems: o.hint ? "flex-start" : "center", gap: 8, whiteSpace: "nowrap",
              }}
            >
              <span style={{ width: 8, color: "var(--acc)", flex: "none", marginTop: o.hint ? 2 : 0 }}>{on ? "✓" : ""}</span>
              <span style={{ flex: 1, color: o.tone, minWidth: 0 }}>
                {o.label}{o.tag && <span className="mr-tag">{o.tag}</span>}
                {o.hint && <span className="mr-hint">{o.hint}</span>}
              </span>
              {o.tail}
            </button>
          </Fragment>
        );
      })}
    </>
  );
}

/** How a mode reads when the list on show lacks it: its own Claude label, the
 *  raw id if even Claude has none (an agent's own mode ids), and "Session" for no mode at all (the
 *  session's own, before its picks load or on an older bridge). Never another
 *  mode's row: falling back to the list's first read a "default" session as Plan. */
function modeRow(id: string): { id: string; label: string; title?: string } {
  return PERMS.find((o) => o.id === id) ?? { id, label: id || "Session" };
}

// A knob set by hand in a session bound to a profile: its value wins over the
// profile's until you pick the profile's own again (bridge profiles.save_pick).
const OVERRIDE_TIP = "set in this session; pick the profile's value to follow it again";
// The PROFILE menu's last row isn't a profile: it opens SETTINGS ▸ SESSION on a
// blank profile form. Real ids are p_<hex>, so this one never clashes.
const NEW_PROFILE = "+new";
function OverrideDot({ tip = OVERRIDE_TIP }: { tip?: string }) {
  return <span title={tip} style={{ color: "var(--acc)", flex: "none" }}>•</span>;
}
// The FLOW chip's next step, in words (its title).
const MARK_WORDS = { auto: "starts by itself", held: "held: you start it", you: "waits for you" } as const;

function Drop<T extends string>({
  label, code, value, options, fallback, open, onToggle, onPick, minWidth = 78, align = "left", title, dot, tone, meter, menu, className, face,
}: {
  label: string;
  // The chip's whole face, when the field draws its own (the rail's usage ring); the menu is unchanged.
  face?: ReactNode;
  // A class on the chip's wrapper, for a layout that treats this chip apart.
  className?: string;
  // A field glyph printed inside the chip. The identity of the field then
  // travels with the control instead of sitting beside it as a separate span,
  // which is what let the layout ladder shed it exactly when the row got tight
  // enough that you could no longer tell the five dropdowns apart. `label` is
  // in the button title, so the glyph never has to carry the name alone.
  code?: ReactNode;
  value: T;
  // short → what the chip shows; group → a heading printed once above each run
  // of rows sharing it; tail → right-aligned decoration (the usage meters, what
  // a profile sets); tone → the label's colour (a profile whose login expired)
  options: DropOption<T>[];
  // What the chip shows when `value` isn't in `options` (default: the first row).
  fallback?: { id: string; label: string; short?: string };
  open: boolean;
  onToggle: () => void;
  onPick: (id: T) => void;
  minWidth?: number;
  // Which edge the menu hangs from. "right" for a chip at the row's far end,
  // whose menu would otherwise run off the column.
  align?: "left" | "right";
  // The chip's hover box, when the field needs explaining (default: the field
  // and its value). A plain title, so NativeTips draws it: fixed, and nudged in
  // off the window's edge. A <Tip> around the chip was clipped by the column
  // and came up alongside this title's box.
  title?: string;
  // The value is the session's own, over its profile's (OverrideDot).
  dot?: boolean;
  // The chip's text and border colour, when the value is in trouble (a
  // profile whose login has expired).
  tone?: string;
  // A reading printed after the value (PROFILE: what its login has left).
  meter?: ReactNode;
  // The menu's rows when they aren't MenuRows (PROFILE draws two-line rows
  // with a control of their own); `options` still names the chip.
  menu?: ReactNode;
}) {
  const cur = options.find((o) => o.id === value) ?? fallback ?? options[0];
  if (!cur) return null;                 // nothing to pick from yet (still loading)
  // min-width rides a custom property so the tight end of the layout ladder can
  // drop it to 0 (inline styles win over any stylesheet rule otherwise).
  const btn: CSSProperties = {
    appearance: "none", cursor: "pointer", border: `1px solid color-mix(in srgb, ${tone ?? "var(--acc)"} ${tone ? 55 : 25}%, transparent)`,
    background: "color-mix(in srgb, var(--panel2) 60%, transparent)", color: tone ?? "var(--txh)", fontFamily: "inherit",
    fontSize: "var(--t95)", letterSpacing: ".3px", display: "flex",
    alignItems: "center", gap: code ? 7 : 10, justifyContent: code ? "flex-start" : "space-between",
    padding: code ? "4px 8px 4px 5px" : "4px 9px",
    ["--dw" as string]: `${minWidth}px`,
  };
  return (
    <div className={className} style={{ position: "relative", display: "flex", alignItems: "center", gap: 6 }}>
      <button className="drop-btn" onClick={onToggle} title={title ?? `${label} — ${cur.label}`} style={btn}>
        {face ?? <>
          {code && <span className="ctrl-fld">{code}</span>}
          <span className="drop-val" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: code ? 1 : undefined }}>{cur.short ?? cur.label}</span>
          {dot && <OverrideDot />}
          {meter}
          <span style={{ color: code ? "var(--txl)" : "var(--txd)", fontSize: "var(--t8)", flex: "none" }}>▾</span>
        </>}
      </button>
      {open && (
        <div
          style={{
            // max-content: the menu sizes to its longest row instead of wrapping
            // labels inside the chip-wide box that positions it.
            position: "absolute", bottom: "calc(100% + 5px)", ...(align === "right" ? { right: 0 } : { left: 0 }), minWidth: 132, width: "max-content",
            zIndex: 30, border: "1px solid color-mix(in srgb, var(--acc) 35%, transparent)", background: "color-mix(in srgb, var(--panel2) 98%, transparent)",
            boxShadow: "0 -8px 26px var(--shadow-pop)", animation: "mpop .12s ease",
          }}
        >
          {menu ?? <MenuRows options={options} value={value} onPick={onPick} />}
        </div>
      )}
    </div>
  );
}

// What a usage window's severity wears: red once critical or spent, amber
// past normal, else the accent.
function sevColor(severity?: string): string {
  return severity === "critical" || severity === "exceeded" ? "var(--err)"
    : severity && severity !== "normal" ? "var(--warn)" : "var(--acc)";
}

// A fuel gauge in the MODEL menu: how much of a usage window is still unspent
// (fill = left, so a full bar is a full tank). The PROFILE menu draws its own
// (Fuel below), with the refill written in.
function LeftMeter({ left, severity }: { left: number; severity?: string }) {
  const c = sevColor(severity);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, marginLeft: 18, color: c, flex: "none" }}>
      <span style={{ width: 44, height: 3, background: "color-mix(in srgb, var(--acc) 12%, transparent)", position: "relative", overflow: "hidden" }}>
        <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${left}%`, background: c }} />
      </span>
      <span style={{ minWidth: 30, textAlign: "right", fontSize: "var(--t9)", letterSpacing: .5 }}>{left}%</span>
    </span>
  );
}

/** The PROFILE menu (drafts/profile-menu, A · LEDGER): two lines a profile —
 *  its login's tile, its name and what it sets, then what that login has left
 *  in each window with the refill written in, so nothing waits on a hover —
 *  and at the right end the default control: the DEFAULT pill on the profile
 *  new sessions get (the chip SETTINGS ▸ AI & PROFILES wears), a pin on every
 *  other row that makes it the default without binding this session. A row is
 *  a div, not a button, because the pin is a button of its own. */
function ProfileRows({ profiles, accounts, value, defaultId, onPick, onDefault, reading, onCheck }: {
  profiles: Profile[];
  accounts?: AccountInfo[];
  value: string;
  defaultId?: string | null;   // undefined: a bridge too old to say, so no pill and no pin
  onPick: (id: string) => void;
  onDefault?: (id: string) => void;
  /** A read of the meters in flight: the age (s) past which it redoes one; null for none. */
  reading: number | null;
  /** Check now: read every login through Claude Code. */
  onCheck?: () => void;
}) {
  const key = (id: string) => (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(id); }
  };
  const now = Date.now() / 1000;
  return (
    <div role="listbox" aria-label="Profiles">
      {profiles.map((p) => {
        const on = p.id === value;
        const dead = deadLogin(accounts, p.agent, p.account);
        const acct = dead === null ? accounts?.find((a) => a.slot === loginSlot(p.agent, p.account)) : undefined;
        const wins = loginWindows(acct);
        // How fresh its reading is (live, N min ago, checking), where the meter line ends.
        const fresh = acct ? freshness(acct, now, reading) : null;
        return (
          <div key={p.id} className="pm-row" role="option" aria-selected={on} tabIndex={0} data-on={on || undefined} data-dead={dead !== null || undefined}
            title={dead !== null ? `Account ${dead}'s Claude login has expired. Opens SETTINGS ▸ ACCOUNTS to sign it in again.` : undefined}
            onClick={() => onPick(p.id)} onKeyDown={key(p.id)}>
            <span className="pm-chk">{on ? "✓" : ""}</span>
            {p.agent === "claude"
              ? <span className="ps-av" style={{ background: slotHue(p.account), color: p.account ? "var(--acc-on)" : "var(--txm)" }}>{p.account ? `A${p.account}` : "A"}</span>
              : <span className="ps-av ps-av-agent">◇</span>}
            <span className="pm-main">
              <span className="pm-l1"><span className="pm-name">{p.name}</span><span className="pm-knobs">{knobs(p)}</span></span>
              {dead !== null
                ? <span className="pm-exp">LOGIN EXPIRED ▸ pick to sign in again</span>
                : wins.length > 0 ? <span className="pm-fuel">{wins.map((w) => <Fuel key={w.tag} w={w} />)}</span>
                : fresh && <span className="pm-wait">reading through Claude Code…</span>}
            </span>
            {(defaultId !== undefined || fresh) && (
              <span className="pm-tail" data-fresh={fresh ? "" : undefined}>
                {defaultId !== undefined && (p.id === defaultId
                  ? <span className="pm-tag" title="new sessions get this profile unless their project names another">DEFAULT</span>
                  : <button type="button" className="pm-pin" aria-label="Make default"
                      title="Make default · new sessions start on this profile, unless their project names another"
                      onClick={(e) => { e.stopPropagation(); onDefault?.(p.id); }}><Pin size={13} /></button>)}
                {fresh && (
                  <span className="pm-fresh" data-k={fresh.k}
                    title={fresh.k === "live" ? "a turn on this login is running and reporting it"
                      : fresh.k === "checking" ? "reading it through Claude Code" : "its last reading; Check now reads it again"}>
                    {fresh.k === "live" ? <i className="meter-live" aria-hidden />
                      : fresh.k === "checking" ? <Spinner className="h-[9px] w-[9px] border-[1.5px] opacity-100" /> : null}
                    {fresh.text}
                  </span>
                )}
              </span>
            )}
          </div>
        );
      })}
      <div className="pm-foot">
        <button type="button" className="pm-row pm-new caps" onClick={() => onPick(NEW_PROFILE)}>+ New profile</button>
        {onCheck && (
          <span className="pm-check">idle logins are read on open ·{" "}
            <button type="button" disabled={reading === 0} onClick={(e) => { e.stopPropagation(); onCheck(); }}>Check now</button>
          </span>
        )}
      </div>
    </div>
  );
}

/** What a profile sets, without the login its tile already shows: "FABLE-5-1 ·
 *  BYPASS PERMISSIONS · MAX", or DEFAULTS for one that sets nothing. */
function knobs(p: Profile): string {
  return describe(p).replace(/^A\d+( · |$)/, "") || "DEFAULTS";
}

/** One usage window on a PROFILE row: tag, gauge, what's left, when it refills.
 *  A spent window prints its refill bright: when the login works again is the
 *  number that matters. The exact time stays on hover. */
export function Fuel({ w }: { w: Window }) {
  return (
    <span className="pm-w" data-spent={w.left === 0 || undefined} style={{ ["--c" as string]: sevColor(w.severity) }}
      title={`${w.name}: ${w.left}% left${w.resets}`}>
      <span className="pm-wtag">{w.tag}</span><span className="pm-bar"><span style={{ width: `${w.left}%` }} /></span>
      <span className="pm-pct">{w.left}%</span><span className="pm-reset">{fmtReset(w.resets_at)}</span>
    </span>
  );
}

// Claude's logo: simple-icons' Claude mark, already bundled as CLAUDE.md's
// file icon. currentColor, so it takes each theme's accent the way every other
// glyph does. It marks the PROFILE chip: a profile picks who runs the turn.
function ClaudeLogo({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden style={{ flex: "none", color: "var(--acc)" }}
      dangerouslySetInnerHTML={{ __html: ICON_BODY["si:claude"] }} />
  );
}

/** The rail's usage (prompt-kinds R3 · RAIL): a 12px ring of what the login's window has left, its
 *  %, and when it refills. Spent, the whole ring takes the tone (err) and the clock is the refill time.
 *  The track is the theme's neutral --line2, as the mockup's; a theme without one tints it. */
function UsageRing({ left, tone, clock }: { left: number; tone: string; clock: string }) {
  const r = 4.5, c = 2 * Math.PI * r, w = 2.4;
  return (
    <span className="pb-ring">
      <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden>
        <circle cx={6} cy={6} r={r} fill="none" strokeWidth={w} stroke={left > 0 ? `var(--line2, color-mix(in srgb, ${tone} 22%, transparent))` : tone} />
        {/* round caps reach half a stroke past each end, so the dash is a stroke shorter: 92% keeps its gap */}
        {left > 0 && <circle cx={6} cy={6} r={r} fill="none" strokeWidth={w} stroke={tone} strokeLinecap="round"
          strokeDasharray={`${Math.max(0, (c * left) / 100 - w)} ${c}`} transform="rotate(-90 6 6)" />}
      </svg>
      <span className="pb-pc" style={{ color: tone }}>{left}%</span>
      <span className="pb-clock">{clock}</span>
    </span>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return `${n}`;
}

// Shared look for the small action chips (REVIEW / AUDIT / MAP, and COMPACT on the context line).
const chip: CSSProperties = {
  appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)",
  background: "transparent", color: "var(--txd)", fontFamily: "inherit", fontSize: "var(--t9)",
  letterSpacing: 1, padding: "3px 8px",
};

// Steering folds text into the turn already in flight. Merge rotated a quarter
// turn: two strands come in from the left and leave as one, pointing forward.
export function SteerIcon({ size = 13 }: { size?: number }) {
  return <Merge size={size} strokeWidth={1.8} style={{ transform: "rotate(90deg)", flex: "none" }} aria-hidden />;
}

/** What the composer does differently with Settings ▸ Experimental on. null/absent
 *  while it's off: then every check below reads as it always did. */
export interface ComposerMulti {
  /** What the open session's agent can do; it stands in for "is this Claude?". */
  caps?: Caps;
  /** The chat's helper limits, live. Absent where helpers can't run (a job, a share). */
  helpers?: HelperConfig;
  onHelpers?: (patch: Partial<HelperConfig>) => Promise<unknown>;
  /** The profile names `@` offers. */
  profileNames: string[];
  /** The session's folder, for which skills are shared here. */
  cwd?: string | null;
}

/** The effort's row: Claude's ladder, or the agent's own list, an unset one
 *  reading AGENT DEFAULT. */
function effortRow(effort: string, agent?: AgentPickers | null): { id: string; label: string } {
  if (agent) return agent.effort?.find((o) => o.id === effort) ?? { id: effort, label: effort || "AGENT DEFAULT" };
  return EFFORTS.find((e) => e.id === effort) ?? EFFORTS[0];
}

/** The FLOWS sheet, for every session (bridge/flowsettings.py): in the gear's popover, hung from
 *  the card's left edge as PRESET hangs from its segment, and `inline` in SETTINGS ▸ AI MANAGEMENT,
 *  where SKILL PATHS was. Two columns, so picking a flow never changes its height (a2-open).
 *  Tickets 04 to 08 of flow-gear each fill their own section of it. */
type FlowChangeFn = (c: FlowChange) => void;

/** The picked flow's run default for every session: PRESET's Model, Mode, Effort and Trim rows,
 *  drawn the same, with no profile marks (the default is no profile's). */
function FlowRunRows({ f, change, models }: { f: FlowSetting; change: FlowChangeFn; models: DropOption<string>[] }) {
  const [list, setList] = useState<"" | "model" | "perm">("");
  const trim = useAiFeatures().ponytail;
  const val = flowRuns([f])[f.id];
  const edit = (k: keyof KindRun, v: string) => change({ flow: f.id, key: RUN_KEY[k], value: v });
  const sel = (k: "model" | "perm", label: string, opts: DropOption<string>[], shown: string) => (
    <div className="pb-pr"><b>{label}</b>
      <Drop<string> label={label.toUpperCase()} className="pb-sel" value={val[k]} fallback={{ id: val[k], label: shown }} options={opts}
        open={list === k} onToggle={() => setList((l) => (l === k ? "" : k))} onPick={(v) => { edit(k, v); setList(""); }} />
    </div>
  );
  const seg = (k: "effort" | "ponytail", label: string, opts: DropOption<string>[]) => (
    <div className="pb-pr"><b>{label}</b>
      <div className="pb-sg" role="group" aria-label={label}>
        {opts.map((o) => <button key={o.id || "-"} type="button" aria-pressed={o.id === val[k]} onClick={() => edit(k, o.id)}>{o.label}</button>)}
      </div>
    </div>
  );
  const perm = PERMS.find((o) => o.id === val.perm);
  return <>
    {sel("model", "Model", models, modelName(val.model))}
    {sel("perm", "Mode", PERMS, val.perm ? perm?.label ?? modeRow(val.perm).label : "Session")}
    {seg("effort", "Effort", EFFORTS.filter((e) => e.id))}
    {trim && seg("ponytail", "Trim", PONYTAILS)}
  </>;
}
export function FlowsSheet({ initial, inline, models }: { initial?: string | null; inline?: boolean;
  /** The rows of the picked flow's Model select: Claude's, never an agent session's own. */
  models: DropOption<string>[] }) {
  const flowCfg = useFlowSettings();
  const [sheetFlow, setSheetFlow] = useState(initial ?? "build");
  const [flowsErr, setFlowsErr] = useState("");
  useEffect(() => { if (inline) void refreshFlowSettings(); }, [inline]);   // the popover re-reads as the gear opens it
  const sheetPick = flowCfg?.flows.find((f) => f.id === sheetFlow) ?? flowCfg?.flows[0];
  const flowName = (id: string) => KINDS[id as KindId]?.name ?? id.toUpperCase();
  const flowChange: FlowChangeFn = (c) => { setFlowsErr(""); void changeFlows(c).catch((e: Error) => setFlowsErr(e.message)); };
  if (!flowCfg || !sheetPick) return inline ? <div className="aim-hint">Reading the flow settings…</div> : null;
  const SheetGlyph = FLOW_ICON[sheetPick.id] ?? RouteIcon;
  const pickName = flowName(sheetPick.id);
  return (
    <div className="pb-pp fs-sheet" role={inline ? "group" : "dialog"} aria-label="Flows" data-inline={inline ? "" : undefined} style={{ overflow: "visible" }}>
      <h4><Settings size={10} strokeWidth={2.2} aria-hidden />Flows<span>for every session</span></h4>
      <div className="fs-top">
        <div className="pb-pr"><b>Flows</b>
          <div className="pb-sg" role="group" aria-label="Flows">
            {[true, false].map((v) => (
              <button key={String(v)} type="button" aria-pressed={flowCfg.on === v} onClick={() => flowChange({ key: "on", value: v })}>{v ? "ON" : "OFF"}</button>
            ))}
          </div>
        </div>
        <div className="pb-pr"><b>Guess</b>
          <div className="pb-sg" role="group" aria-label="Guess">
            {(["auto", "hand"] as const).map((v) => (
              <button key={v} type="button" aria-pressed={flowCfg.guess === v} onClick={() => flowChange({ key: "guess", value: v })}
                title={v === "auto" ? "The box guesses a flow as you type" : "Only a tap or Tab lights a flow"}>{v === "auto" ? "AUTO" : "BY HAND"}</button>
            ))}
          </div>
        </div>
        <label className="fs-sw"><Switch on={flowCfg.autopick} label="Auto picks" onClick={() => flowChange({ key: "autopick", value: !flowCfg.autopick })} />Auto picks</label>
        <label className="fs-sw"><Switch on={flowCfg.smartzone} label="Smart zone" onClick={() => flowChange({ key: "smartzone", value: !flowCfg.smartzone })} />Smart zone</label>
      </div>
      <div className="fs-body">
        <div className="fs-col" role="listbox" aria-label="Flows">
          {flowCfg.flows.map((f) => {
            const Icon = FLOW_ICON[f.id] ?? RouteIcon;
            return (
              <div key={f.id} className="fs-row" role="option" aria-selected={f.id === sheetPick.id} data-sel={f.id === sheetPick.id ? "" : undefined}
                data-off={f.on ? undefined : ""} tabIndex={0} onClick={() => setSheetFlow(f.id)}
                onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); setSheetFlow(f.id); } }}>
                <span onClick={(e) => e.stopPropagation()}>
                  <Switch on={f.on} label={`${flowName(f.id)} on`} onClick={() => flowChange({ flow: f.id, key: "on", value: !f.on })} />
                </span>
                <Icon size={13} strokeWidth={2} aria-hidden />
                <b>{flowName(f.id)}</b>
                <span>{f.steps.length === 1 ? ONE_STEP[f.id] ?? f.steps[0].step
                  : f.steps.map((st, i) => <Fragment key={st.step}>{i > 0 && " › "}{runs(st) ? st.step : <s>{st.step}</s>}</Fragment>)}</span>
                <em>{[modelName(f.run.model), f.run.effort && effortRow(f.run.effort, null).label].filter(Boolean).join(" · ")}</em>
              </div>
            );
          })}
          <div className="pb-pr fs-nokind"><b>No kind</b>
            <div className="pb-sg" role="group" aria-label="No kind: a prompt sent with no flow lit">
              {(["claude", "typed"] as const).map((v) => (
                <button key={v} type="button" aria-pressed={flowCfg.nokind === v} onClick={() => flowChange({ key: "nokind", value: v })}
                  title={v === "claude" ? "Claude picks one of the flows that are on" : "Claude picks nothing: the prompt goes as typed"}>{v === "claude" ? "CLAUDE PICKS" : "AS TYPED"}</button>
              ))}
            </div>
          </div>
        </div>
        <div className="fs-detail">
          <div className="fs-dh"><SheetGlyph size={13} strokeWidth={2} aria-hidden />{pickName}<span>{FLOW_ABOUT[sheetPick.id]}</span></div>
          <div className="pb-pr"><b>Steps</b>
            {/* A fixed step always runs; the others switch on and off, for every session from its next step. */}
            <div className="fs-chips" role="group" aria-label={`${pickName} steps`}>
              {sheetPick.steps.map((st, i) => (
                <Fragment key={st.step}>{i > 0 && <i aria-hidden>›</i>}
                  <button type="button" className="fs-chip" data-fixed={st.fixed ? "" : undefined} data-on={runs(st) ? "" : undefined}
                    data-pony={st.ponytail_off ? "" : undefined} aria-pressed={st.on} aria-disabled={st.fixed || undefined}
                    aria-label={`${st.step}: ${st.fixed ? "always runs" : st.on ? "on" : "off"}${st.ponytail_off === true ? ", not running while PONYTAIL is off" : st.ponytail_off ? ", not after a here build while PONYTAIL is off" : ""}`}
                    title={st.fixed ? `${pickName} always runs ${st.step.toUpperCase()}`
                      : st.ponytail_off === true ? "PONYTAIL is off: this step doesn't run"
                      : st.ponytail_off ? "PONYTAIL is off: no REVIEW after a here build (the council's after tickets merge still runs)" : undefined}
                    onClick={() => { if (!st.fixed) flowChange({ flow: sheetPick.id, key: "step", step: st.step, value: !st.on }); }}>
                    {st.step.toUpperCase()}</button></Fragment>
              ))}
            </div>
          </div>
          {sheetPick.steps.length > 1 && (
            <div className="pb-pr"><b>Next</b>
              <div className="pb-sg" role="group" aria-label={`${pickName} next`}>
                {[true, false].map((v) => (
                  <button key={String(v)} type="button" aria-pressed={sheetPick.next === v} onClick={() => flowChange({ flow: sheetPick.id, key: "next", value: v })}
                    title={v ? "its steps start by themselves" : "each step waits for you"}>
                    {v ? <><Zap size={10} strokeWidth={2.4} aria-hidden />AUTO</> : "HOLD"}</button>
                ))}
              </div>
            </div>
          )}
          {sheetPick.tickets !== undefined && (
            <div className="fs-tk">
              <label className="fs-sw" title="approved tickets build as sessions, every ready one at once, merged at the end">
                <Switch on={sheetPick.tickets} label={`${pickName} tickets`} onClick={() => flowChange({ flow: sheetPick.id, key: "tickets", value: !sheetPick.tickets })} />Tickets</label>
              <label className="fs-sw" title="the tickets wait for Approve & build before any session starts">
                <Switch on={!!sheetPick.approve} label={`${pickName} approve before build`} onClick={() => flowChange({ flow: sheetPick.id, key: "approve", value: !sheetPick.approve })} />Approve before build</label>
            </div>
          )}
          <FlowRunRows f={sheetPick} change={flowChange} models={models} />
        </div>
      </div>
      <div className="pb-pf">{flowsErr ? <span data-tone="err">{flowsErr}</span>
        : "A change here is for every session. PRESET and the FLOW chip change one session."}
        <button type="button" onClick={() => flowChange({ reset: sheetPick.id })}>Reset {pickName}</button>
      </div>
    </div>
  );
}

export function Composer({
  disabled, running, model, models, usage, accounts, agentPick, profile, profiles, onProfile, defaultProfile, onDefaultProfile, overrides, effort, perm, onPerm, ponytail, onPonytail, showPonytail, injectedText, injectNonce, sessionId,
  draft, onDraft, contextTokens, contextWindow, onModel, onEffort, onSend, onSteer, onStop, onCompact,
  queued, onCancelQueued, onEjectQueued, onSteerQueued, project, onOpenMap, paused, onTogglePause, pills, fileSink, placeholder,
  dock, ask, bg = 0, onAccounts, routing, routeCtx, helper, onRouteFresh, flowQueued, smartZone, flowChip, runningFlow = null, onFlow, multi, git, lastCheck, designLinked,
}: {
  /** Multi-agent chats (ComposerMulti). */
  multi?: ComposerMulti | null;
  disabled: boolean;
  running: boolean;
  // What you've typed, owned by the session it's for — switching sessions swaps
  // the text rather than carrying it into the next one.
  draft: string;
  onDraft: (text: string) => void;
  project?: string | null;
  // Both clusters are switched off from SETTINGS · SESSION: no handler, no GRAPH.
  onOpenMap?: () => void;
  model: ModelId;
  models: { id: ModelId; label: string }[];
  // The usage of the login the session is spending (its turn in flight's, else
  // its next turn's): the MODEL menu shows what each model has left on it.
  usage?: UsageInfo | null;
  // Every login with its meter: the PROFILE menu shows what each profile's has left.
  accounts?: AccountInfo[];
  // The session runs on another agent (lib/agents): its own options replace
  // Claude's lists, a picker it advertised nothing for hides, and a ◇ chip
  // names it beside PROFILE. null/undefined = a Claude session.
  agentPick?: AgentPickers | null;
  // The profile the session is bound to ("" = none). `profiles` undefined:
  // a bridge too old to have them, so there's no picker.
  profile: string;
  profiles?: Profile[];
  onProfile: (id: string) => void;
  // The profile new sessions get (ProfilesInfo.default) and the menu's pin,
  // which moves it. undefined: a bridge too old to say, so no pill and no pin.
  defaultProfile?: string | null;
  onDefaultProfile?: (id: string) => void;
  overrides?: string[]; // knobs set by hand over the profile — each gets an OverrideDot
  effort: EffortLevel | "";
  perm: string;
  onPerm: (p: string) => void;
  ponytail: string;
  onPonytail: (v: string) => void;
  showPonytail: boolean;
  injectedText?: string;
  injectNonce?: number;
  sessionId?: string | null;
  // Measured window fill at the end of the last turn, and what it counts up to
  // (the model's window, or this session's compact-at when it has one). Both
  // come from the session row — the composer no longer guesses from the
  // transcript, which never saw the system prompt, the tools or a file's body.
  contextTokens?: number;
  contextWindow?: number;
  onModel: (m: ModelId) => void;
  onEffort: (e: EffortLevel | "") => void;
  /** run: the kind's preset, sent with this prompt only (COMPACT's kinds, lib/kinds). flow: the
   *  flow the prompt starts and who picked it; the bridge puts its first step in front. */
  onSend: (text: string, images: string[], noPath?: boolean, run?: KindRun | null, typed?: string,
           flow?: { id: KindId; by: "you" | "guess" }) => void;
  onSteer?: (text: string, images: string[]) => void;
  onStop: () => void;
  onCompact?: (instructions?: string) => void;
  queued?: { id: string; text: string }[];
  onCancelQueued?: (id: string) => void;
  onEjectQueued?: (id: string) => void; // pull it out and run it in a fresh session
  onSteerQueued?: (id: string) => void; // fold it into the turn running now (offered only while one is)
  // Paused = the turn in flight finishes, but nothing starts on its own after it:
  // no queued prompt, no goal nudge. Your own SEND still runs (and unpauses).
  paused?: boolean;
  onTogglePause?: () => void;
  // Session readouts (agents, goal) rendered inside the composer's box, so a
  // lone pill never sits on bare panel between transcript and border.
  pills?: ReactNode;
  // Pointed at addFiles, so a file dropped on the fresh session screen lands
  // here the way one dropped on the box does.
  fileSink?: { current: ((files: FileList | File[]) => void) | null };
  /** The box's idle hint, when the session wants its own (a Rivendell job's follow-up). */
  placeholder?: string;
  /** What the session waits on you for (AskDock), hung on the box's top edge in every layout. */
  dock?: ReactNode;
  /** While it waits, the box answers it: its text and its button belong to the ask. */
  ask?: AskMode | null;
  /** Background tasks the answered turn left running (status `background`): a
   *  prompt queues behind them, and STOP ends them. 0 for anything else. */
  bg?: number;
  /** Re-read the logins' meters, any older than `fresh` s (the PROFILE menu). */
  onAccounts?: (fresh: number) => Promise<unknown>;
  /** SKILL ROUTER: what is typed gets the Matt Pocock /command that fits (lib/route). */
  routing?: boolean;
  /** What the router reads besides the text: the session's checkout, its last prompts, how
   *  its last turn ended, whether it has had one. Absent: nothing to route against yet. */
  routeCtx?: { project: string; cwd?: string; prompts: string[]; lastStatus?: string; first: boolean };
  /** Tab on a route that opens in a fresh session (the next free ticket): its draft. */
  onRouteFresh?: (text: string) => void;
  /** A flow step sits in the session's queue: the NEXT STEP ghost stays hidden. */
  flowQueued?: boolean;
  /** Sub-switch: the 150k mark on the CTX meter. */
  smartZone?: boolean;
  /** The session's path, for the FLOW chip beside + (lib/flowview flowChip); null: no chip. */
  flowChip?: FlowChip | null;
  /** The flow the session is on until its last step is done (lib/flowview runningFlow): its glyph's dot. */
  runningFlow?: string | null;
  /** The FLOW chip's switches, Reset and skips (lib/useFlow). */
  onFlow?: (act: FlowAct) => void;
  /** What the kinds' facts read (lib/kinds kindFacts): the session's git status, its newest
   *  check, and whether its project is linked to Claude Design (null: not known yet). */
  git?: GitStatus | null;
  lastCheck?: LastCheck | null;
  designLinked?: boolean | null;
  /** The open session is a helper: its next turn runs on its own picks, so the kinds dim like an agent's. */
  helper?: boolean;
}) {
  const text = draft;
  const setText = onDraft;
  const [images, setImages] = useState<string[]>([]);
  const [zoom, setZoom] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [openDrop, setOpenDrop] = useState<"" | "profile" | "model" | "effort" | "mode" | "pony" | "verbs" | "preset" | "plus" | "queued" | "fits" | "helpers" | "flow" | "flows">("");
  // PRESET's model or mode list, open inside it; and where it hangs: above the card and its tabs, its
  // right edge on the preset segment's (measured as it opens; index.css keeps it inside the card).
  const [ppList, setPpList] = useState<"" | "model" | "mode" | "jump">("");
  const [ppAt, setPpAt] = useState(0);
  useEffect(() => setPpList(""), [openDrop]);
  // PRESET stays open across picks, so it takes a dialog's Esc as well as a
  // click away; the other drops close on their pick.
  useEffect(() => {
    if (openDrop !== "preset" && openDrop !== "flow" && openDrop !== "flows") return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpenDrop(""); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [openDrop]);
  const { compact, lead, sendKey } = useChatChrome();
  const plugins = useIntegrations();   // the DESIGN button exists while Claude Design is installed
  // COMPACT wears the TABS shell; DEFAULT keeps the old markup.
  const shelled = compact;
  // MODEL rows grouped by usage pool, each with what it has left on the login
  // the session is spending, whichever account that is.
  const modelOpts = useMemo(
    () => agentPick ? agentPick.model ?? []
      : modelRows(models, usage).map((r) => ({
        ...r, tail: r.left === undefined ? undefined : <LeftMeter left={r.left} severity={r.severity} />,
      })),
    [models, usage, agentPick],
  );
  const permOpts = agentPick ? agentPick.mode ?? [] : PERMS;
  // The PROFILE chip's rows only name the profiles; the menu itself is
  // ProfileRows (what each sets, its login's fuel, the default control).
  const profileOpts = useMemo(() => (profiles ?? []).map((p) => ({ id: p.id, label: p.name })), [profiles]);
  const bound = profiles?.find((p) => p.id === profile);
  const boundDead = bound ? deadLogin(accounts, bound.agent, bound.account) : null;
  const own = (k: string) => !!overrides?.includes(k);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<MarkdownInputHandle>(null);
  const escRef = useRef(false);   // the last editor key was Esc: the next Tab is the browser's
  // Images on their way into the text (SYSTEM ▸ Send images: In the chat).
  useChatImages();
  const [embedErr, setEmbedErr] = useState<string | null>(null);
  const [uploads, setUploads] = useState(0);
  const uploadsRef = useRef(0);
  const uploadOrder = useRef<Promise<unknown>>(Promise.resolve());
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  useEffect(() => {
    if (injectNonce) {
      setText(injectedText ?? "");
      taRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [injectNonce]);

  useEffect(() => {
    const f = () => taRef.current?.focus();
    window.addEventListener("ask:focus", f);
    return () => window.removeEventListener("ask:focus", f);
  }, []);

  // A letter typed with nothing else to take it (App): it starts your message
  // here. The first composer to answer takes it, so two on screen don't both type.
  useEffect(() => {
    const f = (e: Event) => {
      if (e.defaultPrevented || !taRef.current) return;
      e.preventDefault();
      taRef.current.type((e as CustomEvent<string>).detail);
    };
    window.addEventListener("hud:type", f);
    return () => window.removeEventListener("hud:type", f);
  }, []);

  // Focus the command line whenever a session is opened or switched (and on
  // first mount) so you can start typing immediately without clicking in.
  useEffect(() => {
    taRef.current?.focus();
    setEmbedErr(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Project map freshness for the MAP button. Re-read when the project changes
  // and when a turn ends — that's when the bridge rebuilds the graph — then
  // follow the build so the age lands on the new map, not the one it replaced.
  // Nothing to poll for when the cluster is switched off.
  const [graph, setGraph] = useState<GraphState | null>(null);
  const mapOn = !!onOpenMap;
  useEffect(() => {
    if (!project || !mapOn) { setGraph(null); return; }
    let live = true;
    let t = 0;
    const poll = () => api.graphState(project)
      .then((s) => {
        if (!live) return;
        setGraph(s);
        if (s.building) t = window.setTimeout(poll, 3000);
      })
      .catch(() => { if (live) setGraph(null); });
    void poll();
    return () => { live = false; if (t) window.clearTimeout(t); };
  }, [project, running, mapOn]);

  // --- @-mentions ----------------------------------------------------------
  // The project's file list, fetched once per project and kept for the session.
  // A repo's tree is a few thousand short strings; re-fetching it per keystroke
  // to save that memory would be the expensive choice.
  const [tree, setTree] = useState<string[]>([]);
  useEffect(() => {
    if (!project) { setTree([]); return; }
    let live = true;
    void api.filesTree(project)
      .then((r) => { if (live) setTree(r.files); })
      .catch(() => { if (live) setTree([]); });
    return () => { live = false; };
  }, [project]);

  const [caret, setCaret] = useState(0);
  const [mentionPick, setMentionPick] = useState(0);
  // Escape dismisses the `@` you're on, not mentions in general: the next `@`
  // sits at a different index and opens normally.
  const [dismissed, setDismissed] = useState(-1);
  const profileNames = multi?.profileNames ?? [];
  const mention = tree.length || profileNames.length ? mentionAt(text, caret) : null;
  // `@` names a file, or with multi-agent chats on, a profile to run a helper on.
  const agentHits = mention ? rankProfiles(profileNames, mention.q) : [];
  const fileHits = mention && tree.length ? rankPaths(tree, mention.q) : [];
  const hits = [...agentHits.map((n) => `@${n}`), ...fileHits];
  // A query that matches nothing closes the list rather than showing an empty
  // box — you're writing an email address or a handle, not picking a file.
  const mentionOpen = !!mention && hits.length > 0 && mention.start !== dismissed;
  useEffect(() => { setMentionPick(0); }, [mention?.q, mention?.start]);

  /** Splice `ins` over the word under the caret (an `@query` or a `/command`)
   *  and put the caret after it. */
  function splice(m: Mention, ins: string) {
    const next = applyMention(text, m, caret, ins);
    setText(next.text);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    });
  }
  function takeMention(path: string) {
    if (mention) splice(mention, path);
  }

  /** Arrow/Tab/Enter belong to the mention list while it's open; Escape closes
   *  it without touching the draft. Returns true when the key was consumed. */
  function mentionKey(e: KeyboardEvent): boolean {
    if (!mentionOpen) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setMentionPick((p) => (p + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length);
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      takeMention(hits[mentionPick]);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setDismissed(mention!.start);
      return true;
    }
    return false;
  }

  // --- /commands -----------------------------------------------------------
  // A leading `/` opens the command list, as the CLI's own input does — skills,
  // custom commands, plugins, the CLI's bundled ones. Re-read each time it
  // opens: a local scan of a few dozen files, and a skill installed from the
  // SKILLS tab a moment ago should already be in it.
  const [cmds, setCmds] = useState<SlashCommand[]>([]);
  // A bridge still running pre-restart code has no commands route; with nothing
  // ever loaded the list says so rather than silently never opening.
  const [cmdsStale, setCmdsStale] = useState(false);
  const [slashPick, setSlashPick] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const slash = slashAt(text, caret);
  const slashOn = slash !== null;
  // A box that leads with a /word needs the list too, to draw it as a command
  // (MarkdownInput): a draft can come back with one already in it.
  const leadsSlash = text.trimStart().startsWith("/");
  // The list is Claude's (.claude/skills, commands, plugins, CLI builtins): an
  // agent session's / would run none of them, so it gets no list.
  const onAgent = !!agentPick;
  // ...unless shared skills reach it (Settings ▸ Experimental): then the list is those,
  // each inserted the way that agent spells a skill (caps.skills_prefix), plus /goal
  // where the agent has goals, which the bridge handles before the agent hears it.
  const skillPrefix = onAgent ? multi?.caps?.skills_prefix : undefined;
  const noList = onAgent && !skillPrefix;
  const goals = !!multi?.caps?.goals;
  const cwd = multi?.cwd;
  useEffect(() => {
    if (!slashOn) setSlashDismissed(false);
    if (noList || (!slashOn && !leadsSlash)) return;
    let live = true;
    void (skillPrefix
      ? Promise.all([api.commands(project), multiApi.skillShare(cwd)]).then(([c, s]) => {
          const about = new Map(c.commands.map((x) => [x.name, x.description]));
          const out: SlashCommand[] = s.skills.filter((x) => x.on && !x.conflict).map((x) => ({
            name: x.name, description: about.get(x.name) ?? "", scope: x.scope === "project" ? "project" : "user",
          }));
          return goals ? [...out, { name: "goal", description: "Set what this chat is for; the loop works toward it", scope: "builtin" as const }] : out;
        })
      : api.commands(project).then((r) => r.commands))
      .then((list) => { if (live) { setCmds(list); setCmdsStale(false); } })
      .catch(() => { if (live) setCmdsStale(true); });
    return () => { live = false; };
  }, [slashOn, leadsSlash, project, noList, skillPrefix, goals, cwd]);
  // The router has it read up front, once per project, so a command it puts in front draws as one at once.
  useEffect(() => {
    if ((!routing && !shelled) || onAgent) return;
    let live = true;
    void api.commands(project)
      .then((r) => { if (live) { setCmds(r.commands); setCmdsStale(false); } })
      .catch(() => { if (live) setCmdsStale(true); });
    return () => { live = false; };
  }, [routing, shelled, project, onAgent]);
  const slashQ = slash ? (skillPrefix ? skillQuery(slash.q, skillPrefix) : slash.q) : "";
  const shits = slash && !noList ? rankCommands(cmds, slashQ) : [];
  const slashOpen = !!slash && !noList && !slashDismissed && (shits.length > 0 || cmdsStale);
  /** What picking a command writes: a skill as its agent spells it. */
  const cmdText = (c: SlashCommand) => (skillPrefix && c.scope !== "builtin" ? `${skillPrefix}${c.name}` : `/${c.name}`);
  useEffect(() => { setSlashPick(0); }, [slash?.q]);
  const slashListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    slashListRef.current?.querySelector<HTMLElement>('[data-on="1"]')?.scrollIntoView({ block: "nearest" });
  }, [slashPick, slashOpen]);

  /** Arrow/Tab belong to the command list while it's open. Enter takes the
   *  highlighted command unless it's already what you typed — then it sends,
   *  as `/compact` + Enter should. Escape closes it until the `/` is gone. */
  function slashKey(e: KeyboardEvent): boolean {
    if (!slashOpen) return false;
    if (e.key === "Escape") { e.preventDefault(); setSlashDismissed(true); return true; }
    if (!shits.length) return false;          // only the restart note is showing
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setSlashPick((p) => (p + (e.key === "ArrowDown" ? 1 : shits.length - 1)) % shits.length);
      return true;
    }
    const pick = shits[slashPick] ?? shits[0];
    if (e.key === "Tab" || (e.key === "Enter" && !isExact(pick, slashQ))) {
      e.preventDefault();
      splice(slash!, cmdText(pick));
      return true;
    }
    return false;
  }

  // --- skill router (lib/route, bridge/route.py) ---------------------------
  // 400 ms after the text settles it goes to /local/route, which answers with the one
  // Matt Pocock /command that fits, or none. An auto pick goes in front by itself and
  // draws solid. Any other waits for Tab, drawn where it moves nothing: in an empty box
  // as a ghost on the line the text will start (a next step), and while there is text
  // as a small segment in the caption row under it, so nothing shifts under the caret.
  // Never while a turn runs (steer or queue) or a docked ask takes the text, never over
  // a /command, never for an agent (its / runs none of these), and not at all (no caption
  // row either) while the project's / list has none of Matt's commands to offer.
  // COMPACT has no auto pick and no typed-text suggestion: its kinds take the typed text.
  // The empty box's ghost stays, its caption on the rail.
  const pack = cmds.some((c) => c.name.startsWith("mattpocock-skills:"));
  const routeOn = !!routing && pack && !!routeCtx && !onAgent && !running && !ask?.send;
  // App memoises routeCtx on its turns; the session is in the key because two fresh ones read alike.
  const ctxKey = useMemo(() => (routeOn ? JSON.stringify([sessionId, routeCtx]) : ""), [routeOn, sessionId, routeCtx]);
  const [held, setHeld] = useState<{ r: Route; for: string; ctx: string } | null>(null);   // the last reply, and what it answered
  const [applied, setApplied] = useState<Route | null>(null);   // the auto pick put in front of this draft
  const [dropped, setDropped] = useState(false);                // no auto pick for this draft: one was taken out, or it wasn't typed fresh here
  const [hidden, setHidden] = useState(false);                  // Esc on the route on show, until the box empties or fills
  const [noPath, setNoPath] = useState(false);                 // Esc took an auto pick out of this draft: its send says "no path"
  const [kindPick, setKindPick] = useState<KindPick>(null);     // COMPACT: the kind you tapped or Tabbed to; null = guess it from the text
  // PRESET's edits to a kind's run, per session; they win over the flow's bridge default (lib/kinds presetFor).
  // shortcut: in memory, a reload drops them; persist per session if that's missed
  const [runEdits, setRunEdits] = useState<Record<string, Partial<Record<KindId, Partial<KindRun>>>>>({});
  const [fitPick, setFitPick] = useState(0);
  const fitsId = useId();
  const routeSeq = useRef(0);
  const landed = useRef<string | null>(null);                   // the text as the auto pick left it, until the next edit
  const now = useRef({ text, dropped });
  now.current = { text, dropped };
  const blank = text.trim() === "";
  useEffect(() => {
    const seq = ++routeSeq.current;
    // A held route answered older text: it goes once the box leads with a / or is emptied, until the next reply.
    if (!routeOn || text.startsWith("/")) { setHeld(null); return; }
    if (blank) setHeld((h) => (h && h.for.trim() !== "" ? null : h));
    const c = routeCtx!;
    const stale = () => isStale(text, now.current.text, seq, routeSeq.current);
    const t = window.setTimeout(() => {
      api.route({
        project: c.project, cwd: c.cwd, session: sessionId ?? undefined, text, prompts: c.prompts, last_status: c.lastStatus, first: c.first,
        ctx_tokens: contextTokens === undefined ? undefined : Math.round(contextTokens),
      }).then(({ route }) => {
        if (stale()) return;
        setHeld(route && { r: route, for: text, ctx: ctxKey });
        if (route && !shelled && shouldAutoApply(text, route, now.current.dropped)) {
          taRef.current?.prepend(`/${route.name} `);
          setApplied(route);
          landed.current = `/${route.name} ${text}`;
        }
      }, () => { if (!stale()) setHeld(null); });   // no answer is no route, never the one held for older text
    }, 400);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, ctxKey, contextTokens]);
  useEffect(() => { if (!blank && isDropped(text, applied?.name ?? null)) setDropped(true); }, [text, applied, blank]);
  useEffect(() => { if (text !== landed.current) landed.current = null; }, [text]);
  // Hiding lasts until the box empties or fills; an emptied box is a fresh draft.
  useEffect(() => { setHidden(false); if (blank) { setApplied(null); setDropped(false); setNoPath(false); setKindPick(null); } }, [blank]);
  // Another session's draft, or one restored after a reload, wasn't typed fresh here: it gets no auto pick.
  useEffect(() => {
    setApplied(null); setHidden(false); setNoPath(false); setDropped(text.trim() !== ""); setKindPick(null);
    // PRESET edits made before a session existed (the blank screen) belong to no session: they go.
    setRunEdits((m) => { if (!("" in m)) return m; const next = { ...m }; delete next[""]; return next; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);
  const live = routeOn && held && held.ctx === ctxKey && !hidden && (!blank || held.for.trim() === "") ? held.r : null;
  const auto = !shelled && routeOn && applied && !dropped && !isDropped(text, applied.name) ? applied : null;
  // What you typed, without the auto pick: DESIGN, GRILL and COMPACT put their own command in front.
  const typed = auto ? swapLead(text, auto.name, null) : text;
  // The kind of work on show (COMPACT only; DEFAULT has no rail to show one). An answer to a
  // docked ask, an agent's session and a typed /command go as typed: no kind, the kinds dim.
  // FLOWS (the gear's sheet, bridge-wide): off, the row is FLOWS OFF and prompts go as typed with
  // the session's own picks; a flow switched off leaves the row and Tab's cycle and is never guessed.
  const flowCfg = useFlowSettings();
  const flowsOn = flowCfg ? flowCfg.on : !!routing;
  const flowsOff = useMemo(() => flowCfg?.flows.filter((f) => !f.on).map((f) => f.id) ?? [], [flowCfg]);
  const kindsOn = shelled && flowsOn && !onAgent && !helper && !ask?.send && !leadsSlash;
  const pick = kindPick && kindPick !== "plain" && flowsOff.includes(kindPick) ? null : kindPick;
  const { kind, how: kindHow } = kindsOn ? shownKind(pick, typed, { start: routeCtx?.first === true, design: !!plugins.design, off: flowsOff, hand: flowCfg?.guess === "hand" }) : { kind: null, how: "none" as const };
  const run = kind ? presetFor(kind, flowRuns(flowCfg?.flows), runEdits[sessionId ?? ""]?.[kind]) : null;
  // A kind you picked on an empty box shows its starter there (the placeholder; Tab writes it).
  const starter = kindHow === "picked" && blank && kind ? KINDS[kind].starter : null;
  // ghostFor: never over a /command, nor for an auto pick that isn't in the text.
  // A flow step already queued is the next step: its ghost would offer it twice.
  // A starter on show wins: the kind you picked outranks a suggestion.
  const ghost = live && blank && !starter && !(flowQueued && live.kind === "next") ? ghostFor("", live) : null;
  const rowRoute = !shelled && live && !blank && ghostFor(text, live) ? live : null;
  const shown = auto ?? (ghost ? live : rowRoute);   // what the caption and the list of other fits are about
  const how = auto ? "auto" : ghost ? "inline" : "row";
  // The list of other fits goes with the command it is for (⌫ while it is open), backdrop and all.
  useEffect(() => { if (!shown) setOpenDrop((d) => (d === "fits" ? "" : d)); }, [shown]);
  const fits = shown ? [
    ...shown.alts.map((a) => ({ name: a.name as string | null, label: `/${a.name}`, desc: a.why, title: a.desc })),
    { name: null, label: "Send as typed", desc: "no command", title: undefined },
  ] : [];
  const openFits = () => { setFitPick(0); setOpenDrop((d) => (d === "fits" ? "" : "fits")); };
  // The editor keeps the focus while the list is open, as a combobox's input does: the
  // highlighted row is its active descendant, so a screen reader reads the row ↑/↓ land on.
  useEffect(() => {
    const el = document.querySelector('[data-ctx-type="editor"][data-ctx-id="composer"] .cm-content');
    if (!el) return;
    if (openDrop === "fits") { el.setAttribute("aria-controls", fitsId); el.setAttribute("aria-activedescendant", `${fitsId}-${fitPick}`); }
    else { el.removeAttribute("aria-controls"); el.removeAttribute("aria-activedescendant"); }
  }, [openDrop, fitPick, fitsId]);

  /** Esc or Send as typed: the route on show goes. An auto pick is taken out of the text. An empty
   *  box's ghost hides until the box fills and is let go, so it doesn't show in the row while the
   *  next prompt is typed (which may still get its auto pick); a typed draft's goes for the draft. */
  function dismiss() {
    if (auto) { setText(swapLead(text, auto.name, null)); setDropped(true); return; }
    setHidden(true);
    if (blank) setHeld(null);
    else setDropped(true);
  }

  /** A row of the other fits: its command swaps in for the one on show; Send as typed (null) takes it out. */
  function pickFit(name: string | null) {
    setOpenDrop("");
    if (!name) dismiss();
    else if (auto) setText(swapLead(text, auto.name, name));
    else if (blank) setText(`/${name} `);
    else taRef.current?.prepend(`/${name} `);
  }

  /** While open, the other fits take ↑/↓, Enter or Tab, and Esc, as the / list does; Alt+↓
   *  opens them. Tab takes the route on show; Esc dismisses it. An auto pick goes with Esc too, and with the
   *  first ⌫ while the text is as the pick left it: the caret is at the end then, where ⌫ would
   *  cost a character of yours. A key taken here goes no further: App's own Esc would close a
   *  panel as well. */
  function routeKey(e: KeyboardEvent): boolean {
    const take = () => { e.preventDefault(); e.stopPropagation(); return true; };
    if (openDrop === "fits" && fits.length) {
      if (e.key === "Escape") { setOpenDrop(""); return take(); }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { setFitPick((p) => (p + (e.key === "ArrowDown" ? 1 : fits.length - 1)) % fits.length); return take(); }
      if (e.key === "Enter" || e.key === "Tab") { pickFit(fits[Math.min(fitPick, fits.length - 1)].name); return take(); }
    }
    if (e.altKey && e.key === "ArrowDown" && shown) { openFits(); return take(); }
    if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return false;
    // A selection stays yours to delete: select all + ⌫ still clears the draft.
    const firstBksp = e.key === "Backspace" && text === landed.current && !!window.getSelection()?.isCollapsed;
    // Only Esc on an auto pick says "no path" for the send; Backspace and Send as typed just drop it.
    if (auto && (e.key === "Escape" || firstBksp)) { if (e.key === "Escape") setNoPath(true); dismiss(); return take(); }
    const r = ghost ? live : rowRoute;
    if (!r) return false;
    if (e.key === "Tab") {
      if (r.fresh) onRouteFresh?.(`/${r.name} ${r.arg}`);
      else if (blank) setText(`/${r.name} ${r.arg}`);
      else taRef.current?.prepend(`/${r.name} `);
      return take();
    }
    if (e.key === "Escape") {
      dismiss();
      return take();
    }
    return false;
  }

  /** COMPACT's kinds: Tab and Shift+Tab walk them while the box has text (design … ask, then
   *  plain, then round again), Esc drops the one on show. On an empty box Tab writes a picked
   *  kind's starter, and Esc goes back to guessing. An open list or menu keeps its keys. */
  function kindKey(e: KeyboardEvent): boolean {
    // CodeMirror's convention: after Esc the next Tab leaves the editor; any other key re-arms the cycling.
    if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return false;
    const afterEsc = escRef.current;
    escRef.current = e.key === "Escape";
    if (afterEsc && e.key === "Tab") return false;
    if (!kindsOn || openDrop || e.altKey || e.ctrlKey || e.metaKey) return false;
    if (e.key === "Tab" && starter && !e.shiftKey) setText(starter);
    else if (e.key === "Tab" && !blank) {
      const dir = e.shiftKey ? -1 : 1;
      let n = nextKind(kind, dir, flowsOff);
      if (n === "design" && !plugins.design) n = nextKind(n, dir, flowsOff);   // no Claude Design, no DESIGN kind
      setKindPick(n ?? "plain");
    }
    else if (e.key === "Escape" && kind) setKindPick(blank ? null : "plain");
    else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  // --- Ctrl+R: reverse prompt search ---------------------------------------
  // Shell muscle memory, over every session's prompts rather than this one's:
  // the prompt worth re-running is usually one you wrote somewhere else. Re-read
  // on each open, not once per mount: a few hundred short strings off localhost,
  // and anything else would miss the prompt you sent a minute ago.
  const [rsearch, setRsearch] = useState<string | null>(null);
  const [rpick, setRpick] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const rOpen = rsearch !== null;
  useEffect(() => {
    if (!rOpen) return;
    void api.promptHistory().then((r) => setHistory(r.prompts)).catch(() => { /* keep the last list */ });
  }, [rOpen]);
  const rhits = rsearch === null
    ? []
    : history.filter((p) => p.toLowerCase().includes(rsearch.toLowerCase())).slice(0, 8);
  useEffect(() => { setRpick(0); }, [rsearch]);

  /** Put a past prompt in the box — to edit before sending, as `!!` would. */
  function takeHistory(p: string) {
    setText(p);
    setRsearch(null);
    requestAnimationFrame(() => taRef.current?.focus());
  }

  function rsearchKey(e: React.KeyboardEvent) {
    const step = (d: number) => {
      e.preventDefault();
      setRpick((p) => (rhits.length ? (p + d + rhits.length) % rhits.length : 0));
    };
    if (e.key === "Escape") { e.preventDefault(); setRsearch(null); taRef.current?.focus(); return; }
    if (e.key === "Enter") { e.preventDefault(); if (rhits[rpick]) takeHistory(rhits[rpick]); return; }
    // Ctrl+R again walks the matches, the way holding it in a shell does.
    if (e.key === "ArrowDown" || (e.key === "r" && e.ctrlKey)) return step(1);
    if (e.key === "ArrowUp") return step(-1);
  }

  /** An image going in the text: saved now, its markdown landing where it was pasted.
   *  They upload at once but land in the order they came, whichever answers first. A
   *  failure says why and puts nothing in. */
  function embedFile(f: File) {
    const id = taRef.current?.holdSpot();
    if (id == null) return;
    const session = sessionId;
    const scope = { session, project };
    setEmbedErr(null);
    uploadsRef.current++;
    setUploads(uploadsRef.current);
    const saved = new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => reject(new Error("Couldn't read that image."));
      r.readAsDataURL(f);
    }).then((data) => uploadChatImage(data, scope));
    const before = uploadOrder.current;
    uploadOrder.current = saved.then((r) => ({ md: r.markdown, err: null as string | null }),
      (e: Error) => ({ md: null, err: e.message || "The image didn't save." }))
      .then(async (out) => {
        await before;
        // The box holds another chat's draft now: this one's text isn't there to go into.
        if (sessionRef.current !== session) {
          taRef.current?.dropSpot(id);
          setEmbedErr(out.err ?? "The chat changed before the image went in. It's saved in the project's .mystical/images.");
        } else if (out.md === null) {
          taRef.current?.dropSpot(id);
          setEmbedErr(out.err);
        } else {
          taRef.current?.fillSpot(id, out.md);
        }
        uploadsRef.current--;
        setUploads(uploadsRef.current);
        // Nothing left to wait for, so "send again" no longer applies.
        if (uploadsRef.current === 0) setEmbedErr((m) => (m === STILL_SAVING ? null : m));
      });
  }

  /** Sending now would leave out an image still on its way into the text. */
  function stillSaving() {
    setEmbedErr(uploadsRef.current ? STILL_SAVING : null);
    return uploadsRef.current > 0;
  }

  function addFiles(files: FileList | File[] | null) {
    if (!files) return;
    const inline = chatImagesInline();
    Array.from(files).forEach((f) => {
      if (inline && isInlineImage(f.type)) { embedFile(f); return; }
      const r = new FileReader();
      // The name rides in the data URL, so a .csv reaches the upload dir as a
      // .csv instead of being guessed into a .png the model can't read.
      r.onload = () => setImages((prev) => [...prev, withName(r.result as string, f.name)]);
      r.readAsDataURL(f);
    });
  }
  useEffect(() => {
    if (!fileSink) return;
    fileSink.current = addFiles;
    return () => { fileSink.current = null; };
  });
  // Paste and drop go through here, so this has to accept everything the file
  // picker does — anything, now — otherwise a dragged-in file vanishes with no
  // error, which reads as the app being broken. Pasted text is kind "string",
  // so the kind check is the whole filter.
  function imagesFrom(items: DataTransferItemList | undefined): File[] {
    return Array.from(items ?? [])
      .filter((it) => it.kind === "file")
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null);
  }
  function submit() {
    if (stillSaving()) return;
    const t = text.trim();
    if (ask?.send) {
      // The ask clears the box itself: a stepper hands it the next page's note.
      if (t || (ask.ready && !ask.needsText)) ask.send(t);
      return;
    }
    if (!t || disabled) return;
    // The kind on show sends its preset with the prompt, and the flow when the prompt starts one.
    const plan = sendPlan({ kind, how: kindHow, text: t, running: runningFlow, flows: flowsOn,
                            answering: !!ask?.send, agent: onAgent, run });
    onSend(plan.text, images, noPath || undefined, plan.run, t, plan.flow && plan.by && { id: plan.flow, by: plan.by });
    setText("");
    setImages([]);
  }

  // Land the text — and anything in the attachment tray — in the turn that's
  // already running.
  function steer() {
    if (stillSaving()) return;
    const t = text.trim();
    if (!t || !onSteer) return;
    onSteer(t, images);
    setText("");
    setImages([]);
  }

  // A third destination for whatever is in the box, alongside submit() and
  // steer(): the same text, routed to /design-first instead of straight at the
  // turn. It sits with them rather than in the verb tier because it *is* the
  // send gesture — the verbs are commands that stand on their own.
  function design() {
    if (stillSaving()) return;
    const t = typed.trim();
    if (!t) return;
    onSend(`/design-first ${t}`, images);
    setText("");
    setImages([]);
  }

  const ctx = contextTokens ?? 0;
  const ctxMax = contextWindow || 1_000_000;
  const ctxPct = Math.min(100, Math.round((ctx / ctxMax) * 100));
  const suggest = ctx >= ctxMax * COMPACT_SUGGEST;
  const ctxSegs = Math.min(CTX_SEGMENTS, Math.ceil((ctxPct / 100) * CTX_SEGMENTS));
  // The meter is teal until the window is actually filling. Colour that is
  // always on is colour that says nothing.
  const ctxColor = ctxPct >= 85 ? "var(--err)" : suggest ? "var(--warn)" : "var(--acc)";

  // The verb tier as data, so the row and the ··· overflow it collapses into
  // render the same list from the same handlers.
  const verbs: {
    key: string; label: string; stamp?: string; stampTone?: string; hot?: boolean;
    tip: string; anchor?: "right"; disabled?: boolean; onClick: () => void;
  }[] = [
    // GRILL, REVIEW, AUDIT are Claude skills: an agent session gets MAP only.
    ...(onAgent ? [] : [{
      key: "grill",
      label: "GRILL",
      tip: "GRILL — a relentless interview before any code gets written.\n\nIt asks one question at a time until every open branch of the decision is closed, then you have something worth building from.\n\nType first to grill a specific idea; leave the box empty to grill the conversation so far.\n\nNeeds a grill skill installed — SKILLS ▸ PLUGINS.",
      disabled,
      onClick: () => { const t = typed.trim(); setText(""); onSend(t ? `/grill-me ${t}` : "/grill-me", []); },
    }]),
    ...(showPonytail && !onAgent ? [
      { key: "review", label: "REVIEW", tip: "REVIEW — /ponytail-review over the working tree: what in this diff can be deleted, reused, or replaced by stdlib.", disabled, onClick: () => onSend("/ponytail-review", []) },
      { key: "audit", label: "AUDIT", tip: "AUDIT — /ponytail-audit over the whole repo: a ranked list of what to delete, simplify, or replace with a native equivalent.", disabled, onClick: () => onSend("/ponytail-audit", []) },
    ] : []),
    ...(onOpenMap && graph?.available ? [{
      key: "map",
      label: "MAP",
      stamp: graph.building ? "LEARNING…" : graph.exists ? ago(graph.built_at) : "—",
      stampTone: graph.stale && !graph.building ? "var(--warn)" : undefined,
      hot: graph.building,
      anchor: "right" as const,
      tip: graph.building
        ? "Learning your project for better and faster responses. Opens the MAP tab."
        : graph.exists
        ? `Project map — built ${ago(graph.built_at)} ago${graph.stale ? ", stale" : ""}. Opens the MAP tab.`
        : "No project map yet — it builds itself after the first turn. Opens the MAP tab.",
      onClick: onOpenMap,
    }] : []),
  ];


  // Pieces both layouts place: DEFAULT strings them along one control row;
  // COMPACT ends its rail with the profile chip as a usage ring and folds model /
  // mode / effort / trim into the PRESET popover (presetBtn + presetPop). A profile the
  // list doesn't have (it failed to load) shows as its id, and a session
  // bound to none as NO PROFILE. Re-picking the
  // current one is no change: a bind would also drop the knobs set by hand.
  // One on an expired login opens SETTINGS ▸ ACCOUNTS on that login instead:
  // a session bound to it could only fail.
  // The chip's own reading: what the login this session spends has left in
  // its 5-hour window (the week's, once the week refills first) and when that
  // window refills — the two numbers that decide whether to send now; both
  // windows with exact times on hover, and in the menu's rows. No
  // profile: the default login. An agent profile spends no Claude quota, and a
  // profile the list lacks has no known login, so neither reads. The meter is
  // read through Claude Code (bridge/usage.py), so a login always gets a number:
  // until its first one lands it shows a spinner. A green dot while a running
  // turn reports it; amber at the CLI's warning, red when spent, with the clock
  // it refills at in place of the countdown.
  const chipSlot = agentPick || (profile && !bound) ? null : loginSlot(bound?.agent, bound?.account);
  const chipAcct = chipSlot === null ? undefined : accounts?.find((a) => a.slot === chipSlot);
  const chipWins = loginWindows(chipAcct);
  const chipWin = chipWindow(chipWins);
  const chipTone = chipWin ? meterTone(chipWin.left, chipWin.severity, chipAcct?.status) : "";
  const chipClock = !chipWin ? "" : chipWin.left === 0 && chipWin.resets_at ? hhmm(Date.parse(chipWin.resets_at) / 1000) : fmtReset(chipWin.resets_at);
  const chipMeter = chipWin
    ? <span className="ctrl-meter" style={{ fontSize: "var(--t9)", letterSpacing: .5, flex: "none" }}>
        {chipAcct?.live && <i className="meter-live" aria-hidden />}
        <span style={{ color: chipTone }}>{chipWin.left}%</span>
        <span style={{ color: "var(--txd)" }}>{chipClock}</span>
      </span>
    : chipAcct && chipAcct.left === null && !chipAcct.disabled
      ? <span className="ctrl-meter" style={{ flex: "none", color: "var(--txd)" }}><Spinner className="h-[9px] w-[9px] border-[1.5px] opacity-100" /></span>
      : undefined;
  const chipName = `PROFILE — ${bound?.name ?? (profile || "NO PROFILE")}`;
  const chipRead = chipAcct?.live ? " · live" : chipAcct?.read_at ? ` · read ${readAgo(chipAcct.read_at, Date.now() / 1000)}` : "";
  const chipTitle = chipWins.length
    ? `${chipName} · ${chipWins.map((w) => `${w.name}: ${w.left}% left${w.resets}`).join(" · ")}${chipRead}`
    : chipMeter ? `${chipName} · reading this login's usage through Claude Code…` : undefined;
  // The PROFILE menu reads idle logins as it opens (any reading over a minute
  // old) and every login on Check now; `reading` is that age while the read
  // runs, so the rows it redoes say checking (lib/clisignals freshness).
  const [reading, setReading] = useState<number | null>(null);
  const readMeters = (fresh: number) => {
    if (!onAccounts) return;
    setReading(fresh);
    void onAccounts(fresh).finally(() => setReading((r) => (r === fresh ? null : r)));
  };
  // A row picked in the PROFILE menu: + NEW PROFILE opens a blank form, an
  // expired login its RE-LOGIN, another profile binds; the pin is not a pick.
  const pickProfileRow = (id: string) => {
    const p = profiles?.find((x) => x.id === id);
    const dead = p ? deadLogin(accounts, p.agent, p.account) : null;
    if (id === NEW_PROFILE) openSettings("aimgmt", "new");
    else if (dead !== null) openSettings("aimgmt", String(dead));
    else if (id !== profile) onProfile(id);
    setOpenDrop("");
  };
  // ring: the rail's usage face (UsageRing), while the login has a reading and isn't expired.
  const profileDrop = (right: boolean, ring = false) => profiles && (
    <Drop label="PROFILE" code={agentPick ? <UserRound size={12} /> : <ClaudeLogo />} value={profile} options={profileOpts}
      face={ring && chipWin && boundDead === null ? <UsageRing left={chipWin.left} tone={chipTone} clock={chipClock} /> : undefined}
      fallback={{ id: profile, label: profile || "NO PROFILE" }} minWidth={104} align={right ? "right" : "left"} open={openDrop === "profile"}
      tone={boundDead !== null ? "var(--err)" : undefined} meter={boundDead !== null ? undefined : chipMeter}
      title={boundDead !== null ? `PROFILE — ${bound?.name}: account ${boundDead}'s Claude login has expired; pick it in this menu to sign in again.` : chipTitle}
      onToggle={() => { if (openDrop !== "profile") readMeters(60); setOpenDrop((d) => (d === "profile" ? "" : "profile")); }}
      onPick={pickProfileRow}
      menu={<ProfileRows profiles={profiles} accounts={accounts} value={profile} defaultId={defaultProfile} onPick={pickProfileRow} onDefault={onDefaultProfile}
        reading={reading} onCheck={onAccounts ? () => readMeters(0) : undefined} />} />
  );
  const ponyDrop = (right: boolean) => showPonytail && !onAgent && (
    <Drop label="PONYTAIL" code={<Scissors size={12} />} value={ponytail} options={PONYTAILS} align={right ? "right" : "left"} open={openDrop === "pony"}
      title={PONYTAIL_TIP}
      onToggle={() => setOpenDrop((d) => (d === "pony" ? "" : "pony"))}
      onPick={(id) => { onPonytail(id); setOpenDrop(""); }} />
  );
  // One menu box for the verbs and for +: the same rows, the same look. + is
  // the compact shells' one left-hand control (Claude Code desktop's +): attach
  // first, then the verbs with their names.
  const menuOf = (rows: typeof verbs) => (
    <div style={{
      position: "absolute", bottom: "calc(100% + 6px)", left: 0, minWidth: 158, width: "max-content", zIndex: 30,
      border: "1px solid color-mix(in srgb, var(--acc) 35%, transparent)",
      background: "color-mix(in srgb, var(--panel2) 98%, transparent)",
      boxShadow: "0 -8px 26px var(--shadow-pop)", animation: "mpop .12s ease",
    }}>
      {rows.map((v) => (
        <button key={v.key} onClick={() => { setOpenDrop(""); v.onClick(); }} disabled={v.disabled} title={v.tip}
          style={{
            width: "100%", appearance: "none", cursor: v.disabled ? "not-allowed" : "pointer", border: 0,
            borderBottom: "1px solid color-mix(in srgb, var(--acc) 8%, transparent)",
            background: "transparent", color: "var(--txm)", fontFamily: "inherit", fontSize: "var(--t105)",
            letterSpacing: 1.4, textAlign: "left", padding: "7px 11px", opacity: v.disabled ? 0.4 : 1,
            display: "flex", alignItems: "center", gap: 10, whiteSpace: "nowrap",
          }}>
          <span style={{ flex: 1 }}>{v.label}</span>
          {v.stamp && <span style={{ color: v.stampTone ?? "var(--txl)", letterSpacing: .6 }}>{v.stamp}</span>}
        </button>
      ))}
    </div>
  );
  const verbMenu = openDrop === "verbs" && menuOf(verbs);
  // GRILL stays DEFAULT's: COMPACT's + drops it, the kinds carry the work there (docs/superpowers/specs/prompt-kinds.md).
  const plusVerbs = verbs.filter((v) => v.key !== "grill");
  // Over the open-menu backdrop (z 25), as the rail is, so a second tap toggles directly.
  const plusBtn = (
    <div style={{ position: "relative", flex: "none", zIndex: 26 }}>
      <button className="pb-plus" onClick={() => setOpenDrop((d) => (d === "plus" ? "" : "plus"))}
        title={["Attach a file", ...plusVerbs.map((v) => v.label)].join(" · ")} aria-label="Attach or run a verb">+</button>
      {openDrop === "plus" && menuOf([{ key: "attach", label: "ATTACH A FILE", tip: "Attach a file", onClick: () => fileRef.current?.click() }, ...plusVerbs])}
    </div>
  );
  // FLOW (design-drafts/flow-chip, A · STEP CHIP): the path's next step beside +, ⚡ when it
  // starts by itself, an amber ✋ when it waits on you. Its sheet is PRESET's, hung from the
  // chip: three switches this session may set over SETTINGS (picking SETTINGS' own value
  // follows it again, as PRESET follows a profile), SKIP and JUMP TO, and a Reset.
  const fchip = shelled && flowsOn && !onAgent && onFlow ? flowChip ?? null : null;
  const [flowAt, setFlowAt] = useState(0);
  useEffect(() => { if (!fchip) setOpenDrop((d) => (d === "flow" ? "" : d)); }, [fchip]);
  const FlowGlyph = FLOW_ICON[fchip?.flow ?? ""] ?? RouteIcon;
  const flowBtn = fchip && (
    <div className="pb-flow-w">
      <button type="button" className="pb-flow" data-mark={fchip.mark} aria-haspopup="dialog" aria-expanded={openDrop === "flow"}
        title={`FLOW · ${fchip.label}, step ${fchip.step} of ${fchip.total}. Next: ${fchip.next.label.toUpperCase()}, ${MARK_WORDS[fchip.mark]}.`}
        aria-label={`${fchip.label}, next ${fchip.next.label.toUpperCase()}, ${MARK_WORDS[fchip.mark]}`}
        onClick={(e) => { setFlowAt((e.currentTarget.parentElement as HTMLElement).offsetLeft); setOpenDrop((d) => (d === "flow" ? "" : "flow")); }}>
        <FlowGlyph size={12} strokeWidth={2} aria-hidden />
        {fchip.flow && <span className="pb-flow-n">{fchip.label}</span>}
        <b>{fchip.next.label.toUpperCase()}</b>
        {fchip.mark === "auto" ? <Zap size={11} strokeWidth={2.4} aria-hidden /> : <Hand size={11} strokeWidth={2.2} aria-hidden />}
      </button>
    </div>
  );
  const flowSet = (k: FlowOption, v: boolean) => onFlow?.({ kind: "set", key: k, on: v === fchip?.opts[k].global ? null : v });
  const flowRow = (k: FlowOption, label: string, on: ReactNode, off: string) => {
    const o = fchip!.opts[k];
    return (
      <div className="pb-pr"><b>{label}{o.here && <OverrideDot tip="set in this session; pick SETTINGS' value to follow it again" />}</b>
        <div className="pb-sg" role="group" aria-label={label}>
          {([[true, on], [false, off]] as const).map(([v, face]) => (
            <button key={String(v)} type="button" aria-pressed={o.on === v} onClick={() => flowSet(k, v)}
              data-prof={o.here && o.global === v ? "" : undefined} title={o.global === v ? "SETTINGS' pick" : undefined}>{face}</button>
          ))}
        </div>
      </div>
    );
  };
  const flowSkip = (to: string) => { onFlow?.({ kind: "skip", to }); setOpenDrop(""); };
  const flowPop = fchip && openDrop === "flow" && (
    <div className="pb-pp pb-flow-pp" role="dialog" aria-label="This session's path" style={{ ["--fp-at" as string]: `${flowAt}px`, overflow: "visible" }}>
      <h4><RouteIcon size={10} strokeWidth={2.2} aria-hidden />{fchip.label}<span>step {fchip.step} of {fchip.total}</span></h4>
      {flowRow("nextstep", "Next", <><Zap size={10} strokeWidth={2.4} aria-hidden />AUTO</>, "HOLD")}
      {flowRow("autopick", "Picks", "AUTO", "SUGGEST")}
      {flowRow("smartzone", "Compact", `PAST ${SMART_ZONE / 1000}K`, "NEVER")}
      <div className="pb-pr"><b>Step</b>
        <div className="pb-flow-acts">
          <button type="button" disabled={fchip.skipTo === null} onClick={() => flowSkip(fchip.skipTo!)}
            title={fchip.skipTo === null ? "the tickets are still at work" : `pass over ${fchip.next.label.toUpperCase()}`}>
            <SkipForward size={11} strokeWidth={2.2} aria-hidden />SKIP {fchip.next.label.toUpperCase()}</button>
          <div className="pb-flow-jump">
            <button type="button" disabled={!fchip.jumps.length} aria-haspopup="menu" aria-expanded={ppList === "jump"}
              onClick={() => setPpList((l) => (l === "jump" ? "" : "jump"))}
              title="skip every step before the one you pick">JUMP TO <i aria-hidden>▾</i></button>
            {ppList === "jump" && (
              <div className="pb-flow-list" role="menu">
                {fchip.jumps.map((j) => <button key={j.key} type="button" role="menuitem" onClick={() => flowSkip(j.key)}>{j.label.toUpperCase()}</button>)}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="pb-pf">{fchip.here ? `${fchip.here} set here, for this session only.` : "A change here is for this session only."}
        <button type="button" disabled={!fchip.here} onClick={() => onFlow?.({ kind: "reset" })}>{fchip.here ? "Reset to SETTINGS" : "Reset"}</button>
      </div>
    </div>
  );
  // Claude's window and Claude's /compact: an agent's meter would divide its
  // tokens by the wrong ceiling, and /compact would reach it as plain text.
  // SMART ZONE: the ~150k past which a flow compacts at its next boundary (bridge/route.py),
  // a tick on the meter, and the readout in the warn colour once past it.
  const zone = !!routing && !!smartZone;
  const pastZone = zone && ctx >= SMART_ZONE;
  const ctxBlock = onAgent ? null : (
    <div className="ctrl-ctx" title={`Context — ${ctxPct}% of ${fmtTokens(ctxMax)}${ctx > 0 ? ` (${ctx.toLocaleString()} tokens on the last request)` : ", not measured yet"}${zone ? ` · smart zone ${fmtTokens(SMART_ZONE)}${pastZone ? ", past it" : ""}` : ""}`}>
      <span className="lbl" style={pastZone ? { color: "var(--warn)" } : undefined}>CTX</span>
      <span className="seg">
        {Array.from({ length: CTX_SEGMENTS }, (_, i) => (
          <i key={i} style={i < ctxSegs ? { background: ctxColor } : undefined} />
        ))}
        {zone && SMART_ZONE < ctxMax && <b className="zone" aria-hidden style={{ left: `${(SMART_ZONE / ctxMax) * 100}%` }} />}
      </span>
      <span style={{ color: suggest ? ctxColor : pastZone ? "var(--warn)" : "var(--txd)", fontSize: "var(--t10)", letterSpacing: .5, flex: "none" }}>{ctxPct}%</span>
      {suggest && ctx > 0 && <span style={{ flex: "none" }}>~{fmtTokens(ctx)}</span>}
      {onCompact && (!shelled || suggest) && (
        // Whatever is in the box rides along as compaction instructions ("keep
        // the auth work, drop the log spelunking") — Piebald opens a dialog for
        // this; we already have a text box right there.
        <button onClick={() => { onCompact(typed.trim()); setText(""); }} disabled={disabled || running}
          title={text.trim()
            ? "Compact the context, keeping what you've typed in mind"
            : "Compact context (/compact) — type first to steer what the summary keeps"}
          style={{ ...chip, flex: "none", cursor: disabled || running ? "not-allowed" : "pointer",
                   opacity: disabled || running ? 0.4 : 1,
                   ...(suggest ? { border: `1px solid ${ctxColor}`, color: ctxColor } : null) }}>
          COMPACT
        </button>
      )}
    </div>
  );

  // No accept=: the model reads whatever lands in the upload dir, so a .csv
  // or a PDF is as good an attachment as a screenshot — and a filter that
  // hides them is what made it look image-only.
  const fileInput = (
    <input ref={fileRef} type="file" multiple style={{ display: "none" }}
      onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
  );
  const paperclip = (
    <button onClick={() => fileRef.current?.click()} title="Attach a file"
      style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: "var(--txd)", display: "flex", flex: "none", marginTop: 3 }}>
      <Paperclip size={14} strokeWidth={1.8} aria-hidden /></button>
  );
  const designBtn = plugins.design && !onAgent && (
    <button className="act-alt neutral caps" onClick={design} disabled={disabled || !text.trim()}
      title={"DESIGN — design before code.\n\nSends the box to /design-first: Claude drafts the screens with the design system, screenshots them into the transcript, pushes the draft to the linked Claude Design project, and waits for your approval before implementing.\n\nNeeds text in the box; syncing needs a linked design project (the chat header's project name ▸ ◇ Design system)."}>
      Design <DraftingCompass size={12} strokeWidth={1.8} aria-hidden /></button>
  );
  /* Exactly one primary. STOP and PAUSE are rare and modal and one of
     them is destructive, so they sit as recessive glyphs and only take
     their colour when you reach for them — their labels live in the
     tooltip. STEER is the alternate target for the same text, so it
     stays an outline. QUEUE/SEND is what Enter does, so it is the only
     filled control on the line. */
  const askBtn = ask?.send && (
    <button className="act-pri ask caps" onClick={submit}
      disabled={!(text.trim() || (ask.ready && !ask.needsText))} title="Answer what's docked above (Enter)">
      {ask.label}</button>
  );
  const softSteer = multi?.caps?.steer === "soft";
  const actions = (withDesign: boolean) => askBtn ? (
    <>
      {running && (
        <button className="act-glyph stop" onClick={onStop} aria-label="Stop" title="STOP — interrupt this turn now" {...keyAttrs(SHORTCUTS.stop.keys)}>
          <Square size={11} strokeWidth={0} fill="currentColor" aria-hidden /></button>
      )}
      <span className="act-fence" aria-hidden />
      {askBtn}
    </>
  ) : running ? (
    <>
      {/* After the answer it ends the background tasks, so it says so. */}
      <button className="act-glyph stop" data-wide={bg ? "" : undefined} onClick={onStop} aria-label={bg ? "Stop them" : "Stop"} {...keyAttrs(SHORTCUTS.stop.keys)}
        title={bg ? "STOP — end the background tasks this turn left running; its answer stays" : "STOP — interrupt this turn now"}>
        <Square size={11} strokeWidth={0} fill="currentColor" aria-hidden />{bg ? "Stop them" : null}</button>
      {/* The graceful counterpart to STOP: no interrupt, no half-written
          file — the turn lands, then the loop holds. It keeps its armed
          state here so the banner is confirmation, not the only tell. */}
      {onTogglePause && (
        <button className={`act-glyph hold${paused ? " armed" : ""}`} onClick={onTogglePause}
          aria-label={paused ? "Resume" : "Pause"}
          title={paused
            ? "PAUSED — nothing starts after this turn. Click to resume."
            : "PAUSE — let this turn finish, then hold; no queued prompt or goal nudge starts after it"}>
          <Pause size={11} strokeWidth={0} fill="currentColor" aria-hidden /></button>
      )}
      <span className="act-fence" aria-hidden />
      {withDesign && designBtn}
      {onSteer && (
        <button className="act-alt caps" onClick={steer} disabled={!text.trim()}
          title={softSteer
            ? `STEER — ${agentPick?.label.toLowerCase() ?? "this agent"} takes this ${STEER_SOFT_WORDS}: the running tool finishes, then it reads your message and carries on (falls back to queueing if the run just ended)`
            : "STEER — fold this into the turn that's running now (falls back to queueing if the run just ended)"}>
          Steer <SteerIcon />{softSteer && <span className="ma-soft">{STEER_SOFT_WORDS}</span>}</button>
      )}
      <button className="act-pri queue caps" onClick={submit} disabled={disabled || !text.trim()}
        title="QUEUE — run this prompt after the current turn (Enter)">
        Queue <ChevronsRight size={13} strokeWidth={1.8} aria-hidden /></button>
    </>
  ) : (
    <>
      {withDesign && designBtn}
      {/* COMPACT's key says the kind it sends as; DEFAULT has no kind, so it always reads Send. */}
      <button className="act-pri caps" onClick={submit} disabled={disabled || !text.trim()} title={`${kind ? KINDS[kind].name : "SEND"} (Enter)`}>
        {kind ? KINDS[kind].verb : "Send"} <ChevronRight size={13} strokeWidth={1.8} aria-hidden /></button>
    </>
  );
  const actionCluster = (<>{fileInput}{paperclip}{actions(true)}</>);
  const helpersRow = multi?.helpers && multi.onHelpers
    ? <HelpersRow config={multi.helpers} onChange={multi.onHelpers} /> : null;
  // DEFAULT has no PRESET to hold that row, so it gets a chip of its own.
  const helpersChip = helpersRow && (
    <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
      <button className="drop-btn ma-helpers-chip" aria-expanded={openDrop === "helpers"} title="Helpers and their limits for this chat"
        onClick={() => setOpenDrop((d) => (d === "helpers" ? "" : "helpers"))}>
        <span className="ctrl-fld"><Users size={12} /></span>
        <span className="drop-val">{multi?.helpers?.helpers}</span>
        <span style={{ color: "var(--txl)", fontSize: "var(--t8)", flex: "none" }}>▾</span>
      </button>
      {openDrop === "helpers" && <div className="ma-helpers-pop">{helpersRow}</div>}
    </div>
  );

  // Pieces the compact shells arrange (.mystical/design-drafts/prompt-box):
  // every row the composer can show, as one node each, placed by TABS and
  // CONSOLE below. DEFAULT keeps its own markup further down.
  // The login this chat spends is dry: a send dies in a second, then is handed
  // over or parked (the transcript's limit card). Said here before you send,
  // with the login that has room one tap away (design-drafts/limit-chat, C).
  // Running low (the CLI's warning level) says so early, the same way, while
  // another login has more left (design-drafts/cli-signals, row 2).
  const dry = chipWins.find((w) => w.left === 0);
  const low = dry ? null : lowWindow(chipWins, chipAcct?.status);
  const other = dry || low ? otherLogin(accounts ?? [], chipSlot) : null;
  const room = other && (dry || (other.left !== null && low && other.left > low.left)) ? other : null;
  const roomProfile = room ? profiles?.find((p) => loginSlot(p.agent, p.account) === room.slot) : undefined;
  const dryPill = (dry || low) && (
    <span className="pb-dry" title={dry ? `${dry.name}: used up. A prompt sent now stops at once, then moves to another login or waits for the refill.`
      : `${low!.name}: ${low!.left}% left${low!.resets}. Claude Code warns before the limit; a turn that hits it stops, then moves to another login or waits for the refill.`}>
      <TriangleAlert size={11} strokeWidth={2} aria-hidden />
      {dry ? <span><b>{loginName(chipAcct, chipSlot)}</b> is out{dry.resets_at ? ` until ${hhmm(Date.parse(dry.resets_at) / 1000)}` : ""}</span>
        : <span><b>{loginName(chipAcct, chipSlot)}</b> has <b>{low!.left}%</b> of its {windowWord(low!)} window{low!.resets_at ? ` · refills ${hhmm(Date.parse(low!.resets_at) / 1000)}` : ""}</span>}
      {room && roomProfile && (
        <button type="button" onClick={() => onProfile(roomProfile.id)}>
          Use {loginName(room, room.slot)}{room.left !== null ? ` · ${room.left}%` : ""}
        </button>
      )}
    </span>
  );
  // The turn's own tab, between the lead and CTX (prompt-kinds spec): "working" while a turn
  // runs, "· N queued ▾" while prompts wait, "paused · N held" while paused. No clock: nothing
  // here knows when the turn began. Its list hangs from the tab row's left edge, so it never
  // runs off the column wherever the tab sits.
  const nq = queued?.length ?? 0;
  const workTab = (running || paused || nq > 0) && (
    <div className="pb-work" data-paused={paused ? "" : undefined}
      title={paused ? (running ? "this turn finishes; nothing starts after it" : "nothing starts on its own") : undefined}>
      {/* .pb-ww: the words a narrow box drops (index.css), the glyphs and the count stay */}
      {paused ? <><Pause size={9} strokeWidth={0} fill="currentColor" aria-hidden /><span className="pb-ww">paused</span></>
        : running && <><i aria-hidden /><span className="pb-ww">working</span></>}
      {nq > 0 && (
        <button type="button" aria-expanded={openDrop === "queued"} title={queued!.map((q) => q.text).join("\n")}
          onClick={() => setOpenDrop((d) => (d === "queued" ? "" : "queued"))}>
          {(running || paused) && <span className="pb-ww">· </span>}{nq} {paused ? "held" : "queued"} <i aria-hidden>▾</i>
        </button>
      )}
      {paused && onTogglePause && (
        <button type="button" className="pb-resume" onClick={onTogglePause} aria-label="Resume" title="Let queued prompts and goal nudges run again">
          <Play size={8} strokeWidth={0} fill="currentColor" aria-hidden /><span className="pb-ww">RESUME</span></button>
      )}
    </div>
  );
  const queuedList = openDrop === "queued" && nq > 0 && (
    <div style={{ position: "absolute", bottom: "calc(100% + 6px)", left: 12, zIndex: 30, minWidth: 260, maxWidth: 440, border: "1px solid color-mix(in srgb, var(--purple) 34%, transparent)", background: "color-mix(in srgb, var(--panel2) 98%, transparent)", boxShadow: "0 -8px 26px var(--shadow-pop)", animation: "mpop .12s ease" }}>
      {queued!.map((q) => (
        <div key={q.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderBottom: "1px solid color-mix(in srgb, var(--acc) 8%, transparent)", fontSize: "var(--t105)", color: "var(--txh)" }}>
          <span title={q.text} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.text}</span>
          {running && onSteerQueued && <button onClick={() => onSteerQueued(q.id)} title="Steer — fold this into the turn that's running now" style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: "var(--purple)", lineHeight: 1, padding: 0, flex: "none", display: "flex" }}><SteerIcon size={11} /></button>}
          {onEjectQueued && <button onClick={() => onEjectQueued(q.id)} title="Run in a new session" style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: "var(--purple)", fontSize: "var(--t11)", lineHeight: 1, padding: 0, flex: "none" }}>↗</button>}
          {onCancelQueued && <button onClick={() => onCancelQueued(q.id)} title="Remove from queue" style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: "var(--purple)", fontSize: "var(--t11)", lineHeight: 1, padding: 0, flex: "none" }}>✕</button>}
        </div>
      ))}
    </div>
  );
  // CSS hides an empty ledger and, past one live item, every pill's
  // description (.pill-desc) — busy means terse.
  const ledger = (className: string) => (
    <div className={`pb-ledger ${className}`}>{dryPill}{pills}</div>
  );
  const attachRow = images.length > 0 && (
    <div className="pb-attach" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {images.map((src, i) => (
        <div key={i} style={{ position: "relative", width: 48, height: 48 }}>
          <ZoomButton onOpen={() => { if (!isFileUrl(src)) setZoom(src); }}>
            <MediaThumb src={src} style={{ width: 48, height: 48, border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", objectFit: "cover" }} />
          </ZoomButton>
          <button type="button" onClick={() => setImages((p) => p.filter((_, j) => j !== i))} aria-label="Remove attachment"
            style={{ position: "absolute", right: -6, top: -6, width: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid color-mix(in srgb, var(--acc) 40%, transparent)", background: "var(--panel3)", color: "var(--txd)", fontSize: "var(--t11)", lineHeight: 1, cursor: "pointer" }}>×</button>
        </div>
      ))}
    </div>
  );
  const embedNote = (embedErr || uploads > 0) && (
    embedErr
      ? <div className="ma-set-err" role="alert" style={{ marginTop: 0, marginBottom: 6, display: "flex", gap: 8, alignItems: "baseline" }}>
          <span style={{ flex: 1, minWidth: 0 }}>{embedErr}</span>
          <button type="button" onClick={() => setEmbedErr(null)} aria-label="Dismiss"
            style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: "inherit", padding: 0, fontFamily: "inherit", fontSize: "inherit", lineHeight: 1 }}>×</button>
        </div>
      : <div className="ma-set-note" role="status" style={{ marginTop: 0, marginBottom: 6 }}>saving image…</div>
  );
  const popovers = (
    <>
      {rsearch !== null && (
        <div style={{ position: "absolute", left: 11, right: 11, bottom: "calc(100% + 6px)", zIndex: 31, border: "1px solid color-mix(in srgb, var(--purple) 34%, transparent)", background: "var(--panel3)", boxShadow: "0 -8px 24px rgba(0,0,0,.35)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 10px", borderBottom: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)" }}>
            <span style={{ flex: "none", fontSize: "var(--t9)", letterSpacing: 1, color: "var(--purple)" }}>REVERSE-I-SEARCH</span>
            <input
              autoFocus
              value={rsearch}
              onChange={(e) => setRsearch(e.target.value)}
              onKeyDown={rsearchKey}
              onBlur={() => setRsearch(null)}
              placeholder="a prompt you wrote before…"
              style={{ flex: 1, minWidth: 0, background: "transparent", border: 0, outline: "none", color: "var(--txb)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t12)" }}
            />
            <span style={{ flex: "none", fontSize: "var(--t9)", color: "var(--txd)" }}>
              {rhits.length ? `${rpick + 1}/${rhits.length}` : "no match"}
            </span>
          </div>
          <div style={{ maxHeight: 210, overflowY: "auto" }}>
            {rhits.map((p, i) => (
              <button
                key={p}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); takeHistory(p); }}
                onMouseEnter={() => setRpick(i)}
                title={p}
                style={{ appearance: "none", cursor: "pointer", display: "block", width: "100%", textAlign: "left", border: 0, borderLeft: `2px solid ${i === rpick ? "var(--purple)" : "transparent"}`, background: i === rpick ? "color-mix(in srgb, var(--purple) 10%, transparent)" : "transparent", color: i === rpick ? "var(--txb)" : "var(--txh)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t115)", padding: "5px 10px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {p.replace(/\s+/g, " ")}
              </button>
            ))}
          </div>
        </div>
      )}
      {slashOpen && (
        <div ref={slashListRef} style={{ position: "absolute", left: 11, right: 11, bottom: "calc(100% + 6px)", zIndex: 30, maxHeight: 240, overflowY: "auto", border: "1px solid color-mix(in srgb, var(--acc) 26%, transparent)", background: "var(--panel3)", boxShadow: "0 -8px 24px rgba(0,0,0,.35)" }}>
          {shits.length === 0 ? (
            <div style={{ padding: "6px 10px", fontSize: "var(--t10)", letterSpacing: .5, color: "var(--txd)" }}>
              the bridge needs a restart before it can list commands
            </div>
          ) : shits.map((c, i) => (
            <button
              key={c.name}
              type="button"
              data-on={i === slashPick ? 1 : 0}
              onMouseDown={(e) => { e.preventDefault(); splice(slash!, cmdText(c)); }}
              onMouseEnter={() => setSlashPick(i)}
              title={c.description}
              style={{ appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", border: 0, borderLeft: `2px solid ${i === slashPick ? "var(--acc)" : "transparent"}`, background: i === slashPick ? "color-mix(in srgb, var(--acc) 10%, transparent)" : "transparent", color: i === slashPick ? "var(--txb)" : "var(--txh)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t115)", padding: "5px 10px" }}
            >
              <span style={{ flex: "none", color: "var(--acc)" }}>{cmdText(c)}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--txl)" }}>{c.description}</span>
              <span style={{ flex: "none", fontSize: "var(--t8)", letterSpacing: 1, color: "var(--txd)" }}>{c.scope === "builtin" ? "CLI" : c.scope.toUpperCase()}</span>
            </button>
          ))}
        </div>
      )}
      {openDrop === "fits" && shown && (
        // The other fits for the routed command, drawn as the / list is.
        <div id={fitsId} role="listbox" aria-label="Other fits" style={{ position: "absolute", left: 11, right: 11, bottom: "calc(100% + 6px)", zIndex: 30, maxHeight: 240, overflowY: "auto", border: "1px solid color-mix(in srgb, var(--acc) 26%, transparent)", background: "var(--panel3)", boxShadow: "0 -8px 24px rgba(0,0,0,.35)" }}>
          {fits.map((f, i) => (
            <button
              key={f.label}
              id={`${fitsId}-${i}`}
              type="button"
              role="option"
              aria-selected={i === fitPick}
              data-on={i === fitPick ? 1 : 0}
              onMouseDown={(e) => { e.preventDefault(); pickFit(f.name); }}
              onMouseEnter={() => setFitPick(i)}
              title={f.title}
              style={{ appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", border: 0, borderLeft: `2px solid ${i === fitPick ? "var(--acc)" : "transparent"}`, background: i === fitPick ? "color-mix(in srgb, var(--acc) 10%, transparent)" : "transparent", color: i === fitPick ? "var(--txb)" : "var(--txh)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t115)", padding: "5px 10px" }}
            >
              <span style={{ flex: "none", color: f.name ? "var(--acc)" : "var(--txd)" }}>{f.label}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--txl)" }}>{f.desc}</span>
            </button>
          ))}
        </div>
      )}
      {mentionOpen && (
        <div style={{ position: "absolute", left: 11, right: 11, bottom: "calc(100% + 6px)", zIndex: 30, maxHeight: 210, overflowY: "auto", border: "1px solid color-mix(in srgb, var(--acc) 26%, transparent)", background: "var(--panel3)", boxShadow: "0 -8px 24px rgba(0,0,0,.35)" }}>
          {hits.map((p, i) => (
            <button
              key={p}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); takeMention(p); }}
              onMouseEnter={() => setMentionPick(i)}
              style={{ appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 7, width: "100%", textAlign: "left", border: 0, borderLeft: `2px solid ${i === mentionPick ? "var(--acc)" : "transparent"}`, background: i === mentionPick ? "color-mix(in srgb, var(--acc) 10%, transparent)" : "transparent", color: i === mentionPick ? "var(--txb)" : "var(--txh)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t115)", padding: "5px 10px" }}
            >
              {p.startsWith("@") ? <UserRound size={14} strokeWidth={1.7} aria-hidden style={{ flex: "none", color: "var(--acc)" }} /> : <FileIcon name={p} size={14} />}
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", direction: p.startsWith("@") ? "ltr" : "rtl", textAlign: "left" }}>{p}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
  // Grows with what you type up to min(500px, 50vh), then scrolls — the cap
  // lives in MarkdownInput's theme.
  const editor = (
    <MarkdownInput
      ref={taRef}
      value={text}
      imageSession={sessionId}
      imageProject={project}
      commands={noList ? [] : cmds}
      onChange={(t, c) => { setText(t); setCaret(c); }}
      onCaret={setCaret}
      ghost={ghost}
      onCmdClick={shown ? openFits : undefined}
      onKeyDown={(e) => {
        if (mentionKey(e) || slashKey(e) || routeKey(e) || kindKey(e)) return;
        // Ctrl+R is the browser's reload; in the command line it's the shell's
        // history search, which is what the hands in this box expect.
        if (e.key === "r" && e.ctrlKey) { e.preventDefault(); setRsearch(""); return; }
        // CTRL+ENTER mode leaves a bare Enter to the editor, which makes it
        // the markdown-aware newline Shift+Enter is in the default mode.
        const send = sendKey === "ctrl-enter" ? e.ctrlKey || e.metaKey : !e.shiftKey;
        if (e.key === "Enter" && send) { e.preventDefault(); submit(); }
      }}
      onPaste={(e) => { const imgs = imagesFrom(e.clipboardData?.items); if (imgs.length) { e.preventDefault(); addFiles(imgs); } }}
      onAttach={() => fileRef.current?.click()}
      onClear={() => {
        if (text.includes("\n")) void askConfirm("Clear the draft?", { ok: "Clear", danger: true }).then((yes) => { if (yes) setText(""); });
        else setText("");
      }}
      placeholder={ask?.placeholder ?? (disabled ? "working…" : starter ? `${starter} · Tab writes it` : running
        ? bg ? `queue a prompt — it goes in once the ${bg === 1 ? "background task finishes" : `${bg} background tasks finish`}…`
          : "queue a prompt — runs after the current turn…"
        : placeholder ?? `message ${onAgent ? agentPick!.label.toLowerCase() : "claude"} — describe a change, paste an error…`)}
    />
  );
  const pfx = <span className="pb-pfx" style={{ color: "var(--purple)", fontSize: "var(--t13)", flex: "none", marginTop: 2 }}>~ ❯</span>;
  const boxProps = {
    "data-drag": dragging ? "" : undefined,
    "data-running": running ? "" : undefined,
    style: { position: "relative", display: "flex", alignItems: "flex-start", gap: 11, border: `1px solid ${dragging ? "var(--acc)" : "color-mix(in srgb, var(--acc) 18%, transparent)"}`, background: "color-mix(in srgb, var(--panel2) 70%, transparent)", padding: "10px 13px", fontFamily: "'JetBrains Mono',monospace" } as CSSProperties,
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); if (!dragging) setDragging(true); },
    onDragLeave: () => setDragging(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    },
  };
  // The router's caption, directly under the text: why the routed command is there and what
  // Tab or Esc does with it. It is the ghost's announcement too (the ghost is aria-hidden).
  // While the box has text a suggestion is drawn here, as the segment it would become, not
  // in the text. The line stays while the router is on and Matt's pack is listed, empty or not,
  // so a route coming or going never moves the box, and a live region that is already there is
  // one screen readers speak.
  const capt = shown ? caption(shown, how) : null;
  const seg = shown?.name ?? "";
  const nsAt = seg.lastIndexOf(":");
  const routeLine = routing && pack && !onAgent && (
    <div className="pb-route" role="status">
      {capt && (<>
        <b data-tone={capt.tone}>{capt.tag}</b>
        {how === "row" && (
          // CmdWidget's segment at caption size; a click lists the other fits, the editor keeping the focus.
          <button type="button" className="cmdseg ghost" title={shown?.desc} aria-haspopup="listbox" aria-expanded={openDrop === "fits"}
            onMouseDown={(e) => e.preventDefault()} onClick={() => { openFits(); taRef.current?.focus(); }}>
            <span className="sr-only">/</span>
            {nsAt > 0 && <><span className="sg ns">{seg.slice(0, nsAt)}</span><span className="sr-only">:</span></>}
            <span className="sg">{seg.slice(nsAt + 1)}</span>
          </button>
        )}
        {capt.why && <span className="why">{capt.why}</span>}
        {capt.tail.map(([k, w]) => <Fragment key={w}><i aria-hidden>·</i>{k && <kbd>{k}</kbd>}<span>{w}</span></Fragment>)}
      </>)}
    </div>
  );
  // DEFAULT sets the editor in a row, so the caption hangs under it in a column of its own.
  const editorCol = <div className="pb-ed">{editor}{routeLine}</div>;
  // COMPACT's rail under the text (docs/superpowers/specs/prompt-kinds.md, R3 · RAIL): the kinds,
  // the lit one's live facts, the run preset, the login's usage, on one line where only the facts
  // give way. While the empty box shows the router's next step, its caption takes the facts' place;
  // the segment is a live region, so that caption is still the ghost's announcement.
  const profileChip = profileDrop(true, true);
  // PRESET: the run the next send goes with, which the segment reads and the popover edits. A lit
  // kind's is its preset (lib/kinds presetFor), and a pick here is this session's edit of it. With
  // no kind it is the session's own picks, and a pick sets them.
  const pre = run ?? { model, perm, effort, ponytail };
  const PreGlyph = kind ? KIND_ICON[kind] : SlidersHorizontal;
  const trimOn = showPonytail && !onAgent;
  const optLabel = (opts: DropOption<string>[], id: string) => { const o = opts.find((x) => x.id === id); return o && (o.short ?? o.label); };
  const preModel = optLabel(modelOpts, pre.model) ?? (agentPick && !kind && !pre.model ? agentPick.label : modelName(pre.model));
  const preRest = [
    pre.perm && (optLabel(permOpts, pre.perm) ?? modeRow(pre.perm).label),
    pre.effort && effortRow(pre.effort, kind ? null : agentPick).label,
    trimOn && pre.ponytail && (PONYTAILS.find((p) => p.id === pre.ponytail)?.label ?? pre.ponytail),
  ].filter(Boolean).join(" · ");
  // A kind's preset names its effort; with no kind lit, Auto is a pick again, as in the run sheet.
  const preEffs: DropOption<string>[] = kind ? EFFORTS.filter((e) => e.id) : agentPick ? agentPick.effort ?? [] : EFFORTS;
  // With no kind lit, a knob set here over the bound profile wears the OverrideDot, and the
  // profile's own value a PROFILE mark: picking that follows the profile again (OVERRIDE_TIP).
  const setHere = (k: "model" | "perm" | "effort") => !kind && own(k === "perm" ? "permission_mode" : k);
  const profPick = (k: "model" | "perm" | "effort") => (setHere(k) && bound?.[k === "perm" ? "mode" : k]) || null;
  const preEdit = (k: keyof KindRun, v: string) => {
    const sid = sessionId ?? "";
    if (kind) setRunEdits((m) => ({ ...m, [sid]: { ...m[sid], [kind]: { ...m[sid]?.[kind], [k]: v } } }));
    else if (k === "model") onModel(v);
    else if (k === "perm") onPerm(v);
    else if (k === "effort") onEffort(v as EffortLevel | "");
    else onPonytail(v);
  };
  // A select is the chips' own Drop: its MenuRows list opens over the popover.
  const preSel = (k: "model" | "perm", label: string, opts: DropOption<string>[], shown: string) => {
    const list = k === "model" ? "model" : "mode", prof = profPick(k);
    return (
      <div className="pb-pr"><b>{label}{setHere(k) && <OverrideDot />}</b>
        <Drop<string> label={label.toUpperCase()} className="pb-sel" value={pre[k]} fallback={{ id: pre[k], label: shown }}
          options={prof === null ? opts : opts.map((o) => (o.id === prof ? { ...o, tag: "PROFILE" } : o))}
          open={ppList === list} onToggle={() => setPpList((l) => (l === list ? "" : list))} onPick={(v) => { preEdit(k, v); setPpList(""); }} />
      </div>
    );
  };
  const preSeg = (k: "effort" | "ponytail", label: string, opts: DropOption<string>[]) => {
    const prof = k === "effort" ? profPick(k) : null;
    return (
      <div className="pb-pr"><b>{label}{k === "effort" && setHere(k) && <OverrideDot />}</b>
        <div className="pb-sg" role="group" aria-label={label}>
          {opts.map((o) => (
            <button key={o.id || "-"} type="button" aria-pressed={o.id === pre[k]} onClick={() => preEdit(k, o.id)}
              data-prof={o.id === prof ? "" : undefined} title={o.id === prof ? "your profile's pick" : undefined}>{o.label}</button>
          ))}
        </div>
      </div>
    );
  };
  const presetPop = openDrop === "preset" && (
    // overflow: the select lists hang out of it (FLINT's popover rule would clip them).
    <div className="pb-pp" role="dialog" aria-label={kind ? `${KINDS[kind].verb}'s preset` : "This session's run"}
      style={{ ["--pp-at" as string]: `${ppAt}px`, overflow: "visible" }}>
      <h4><PreGlyph size={10} strokeWidth={2.2} aria-hidden />{kind ? `${KINDS[kind].verb} preset` : "This session"}<span>{kind ? "for this session" : "prompts with no kind"}</span></h4>
      {modelOpts.length > 0 && preSel("model", "Model", modelOpts, preModel)}
      {permOpts.length > 0 && preSel("perm", "Mode", permOpts, pre.perm ? optLabel(permOpts, pre.perm) ?? modeRow(pre.perm).label : "Session")}
      {preEffs.length > 0 && preSeg("effort", "Effort", preEffs)}
      {trimOn && preSeg("ponytail", "Trim", PONYTAILS)}
      {kind && (
        <div className="pb-pf">A change here wins in this session.
          <button type="button" onClick={() => { void saveFlowRun(kind, run!); setOpenDrop(""); }}>Save as {KINDS[kind].verb}'s preset</button>
        </div>
      )}
      {/* The chat's helper limits are the session's, not a kind's: they stay with its own picks. */}
      {!kind && helpersRow}
    </div>
  );
  const presetBtn = (
    <button type="button" className="pb-run" aria-haspopup="dialog" aria-expanded={openDrop === "preset"}
      title={`${kind ? `${KINDS[kind].verb}'s preset` : "This session's picks"}: ${[preModel, preRest].filter(Boolean).join(" · ")}`}
      onClick={(e) => {
        setPpAt(e.currentTarget.closest(".pb-card")!.getBoundingClientRect().right - e.currentTarget.getBoundingClientRect().right);
        setOpenDrop((d) => (d === "preset" ? "" : "preset"));
      }}>
      <PreGlyph size={12} strokeWidth={kind ? 2 : 1.8} aria-hidden />
      <b>{preModel}</b>
      {preRest && <span>· {preRest}</span>}
      <i aria-hidden>▾</i>
    </button>
  );
  // The facts lead with the steps the prompt will follow, then the state facts (a1-rest).
  const steps = promptSteps({ kind, how: kindHow, running: runningFlow, cfg: flowCfg });
  const facts = ghost && capt
    ? <span className="pb-route"><b data-tone={capt.tone}>{capt.tag}</b>{capt.why && <span className="why">{capt.why}</span>}
        {capt.tail.map(([k, w]) => <Fragment key={w}><i aria-hidden>·</i>{k && <kbd>{k}</kbd>}<span>{w}</span></Fragment>)}</span>
    : ask?.send ? <span data-tone="dim">your answer goes to the question above</span>
    : kind && <span>{[...(steps ? [{ text: steps } as Fact] : []), ...kindFacts(kind, { git: git ?? null, lastCheck: lastCheck ?? null,
        designLinked: designLinked ?? null, mapBuiltAt: graph?.exists ? graph.built_at : null, askPerm: run?.perm ?? "" })]
        .map((f, i) => <Fragment key={i}>{i > 0 && " · "}{f.lead}<span data-tone={f.tone}>{f.text}</span></Fragment>)}</span>;
  // PRESET's "Save as <Flow>'s preset": the flow's bridge default, so the sheet shows it at once.
  const saveFlowRun = async (fl: string, r: KindRun) => {
    // shortcut: a failed save only logs (PRESET has closed by then), surface it if saves start failing
    try { for (const c of saveRun(fl, r)) await changeFlows(c); } catch (e) { console.warn("flow preset save failed", e); }
  };
  // The gear: the FLOWS sheet (FlowsSheet below), hung from the card's left edge.
  const gear = (
    <>
      <span className="fs-gsep" aria-hidden />
      <button type="button" className="pb-kg fs-gear" aria-label="Flow settings" aria-haspopup="dialog" aria-expanded={openDrop === "flows"}
        title="FLOWS — settings for every session" onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (openDrop !== "flows") void refreshFlowSettings();
          setOpenDrop((d) => (d === "flows" ? "" : "flows"));
        }}>
        <Settings size={13} strokeWidth={2} aria-hidden />
      </button>
    </>
  );
  const flowsPop = openDrop === "flows" && <FlowsSheet initial={kind} models={agentPick ? modelRows(models, usage) : modelOpts} />;
  const rail = (
    <div className="pb-rail">
      {!flowsOn ? (
        <div className="pb-seg pb-kinds" role="group" aria-label="Kind of work">
          <span className="fs-off">Flows off</span>{gear}
        </div>
      ) :
      <div className="pb-seg pb-kinds" role="group" aria-label="Kind of work" data-dim={kindsOn ? undefined : ""}>
        {KIND_ORDER.filter((id) => !flowsOff.includes(id)).map((id) => {
          const Icon = KIND_ICON[id];
          const lit = id === kind;
          const off = !kindsOn || (id === "design" && !plugins.design);   // no Claude Design, no DESIGN kind
          // The editor keeps the focus (and the caret) through a tap.
          return (
            <button key={id} type="button" className={lit ? "pb-kind" : "pb-kg"} data-how={lit ? kindHow : undefined}
              data-run={id === runningFlow ? "" : undefined}
              disabled={off} aria-pressed={lit && kindHow === "picked"}
              title={lit ? `${KINDS[id].name} — ${blank ? "click to go back to guessing" : "click to send as typed"}` : KINDS[id].name}
              onMouseDown={(e) => e.preventDefault()} onClick={() => setKindPick(lit ? (blank ? null : "plain") : id)}>
              <Icon size={lit ? 11 : 12} strokeWidth={2} aria-hidden />
              {lit && <><span>{KINDS[id].verb}</span>{kindHow === "auto" && <i>auto</i>}</>}
            </button>
          );
        })}
        {gear}
      </div>}
      <div className="pb-seg pb-facts" role="status">{facts}</div>
      <div className="pb-seg pb-preset" data-open={openDrop === "preset" ? "" : undefined}>{presetBtn}</div>
      {profileChip && <div className="pb-seg pb-use">{profileChip}</div>}
    </div>
  );
  // COMPACT's shell. The lead (tile, title, project, branch, PR, running app)
  // arrives flattened from Terminal; .pb-lead lays it out in index.css.
  const shell =
      <>
        <div className="pb-tabs pb-lead">{lead}{workTab}{queuedList}{ctxBlock}</div>
        {dock}
        {embedNote}
        <div {...boxProps} className="cmdbox pb-card">
          {ledger("")}
          <div className="pb-line">
            {plusBtn}{flowBtn}{pfx}{popovers}{presetPop}{flowPop}{flowsPop}
            <div className="pb-body">{attachRow}{editor}</div>
            <div className="pb-keys">{actions(false)}</div>
          </div>
          {rail}
        </div>
      </>;

  return (
    // Its own surface, at the island's strength: header and footer are the two
    // pieces of chrome bracketing the transcript, and a ground running under
    // them makes the chat look like it has no edges.
    <div className="composer" data-pb={shelled ? "tabs" : undefined} data-docked={dock ? "" : undefined} style={{ flex: "none", borderTop: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)", padding: "11px 16px", background: "color-mix(in srgb, var(--panel) 88%, transparent)" }}>
      {zoom && <ImageLightbox src={zoom} all={images.map((src) => ({ src }))} onClose={() => setZoom(null)} />}
      {openDrop && <div onClick={() => setOpenDrop("")}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setOpenDrop(""); }}
        style={{ position: "fixed", inset: 0, zIndex: 25 }} />}
      {shelled ? (
        <>
          {fileInput}
          {shell}
        </>
      ) : (
      <>
      {dryPill && <div style={{ marginBottom: 9 }}>{dryPill}</div>}
      {pills}
      {/* Paused: shown even when idle, because that's exactly when you can't tell
          from the transcript that the queue and the goal loop are being held. */}
      {paused && (
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 9, padding: "5px 9px", border: "1px solid color-mix(in srgb, var(--warn) 34%, transparent)", background: "color-mix(in srgb, var(--warn) 8%, transparent)" }}>
          <Pause size={11} strokeWidth={0} fill="var(--warn)" aria-hidden style={{ flex: "none" }} />
          <span style={{ fontSize: "var(--t10)", letterSpacing: 1, color: "var(--warn)", flex: "none" }}>PAUSED</span>
          <span style={{ fontSize: "var(--t105)", color: "var(--txl)", flex: 1, minWidth: 0 }}>
            {running ? "this turn finishes; nothing starts after it" : "nothing starts on its own"}
            {queued && queued.length > 0 ? ` — ${queued.length} held` : ""}
          </span>
          {onTogglePause && (
            <button onClick={onTogglePause} title="Let queued prompts and goal nudges run again"
              style={{ ...chip, flex: "none", cursor: "pointer", border: "1px solid var(--warn)", color: "var(--warn)" }}>
              RESUME
            </button>
          )}
        </div>
      )}
      {/* queued prompts — waiting to run after the current turn */}
      {queued && queued.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 9 }}>
          <span style={{ fontSize: "var(--t10)", letterSpacing: 1, color: "var(--purple)", flex: "none" }}>QUEUED · {queued.length}</span>
          {queued.map((q) => (
            <span key={q.id} title={q.text}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, maxWidth: 240, border: "1px solid color-mix(in srgb, var(--purple) 30%, transparent)", background: "color-mix(in srgb, var(--purple) 8%, transparent)", color: "var(--purple-h)", fontSize: "var(--t10)", letterSpacing: 0.5, padding: "2px 6px" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.text}</span>
              {running && onSteerQueued && (
                <button onClick={() => onSteerQueued(q.id)} title="Steer — fold this into the turn that's running now"
                  style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: "var(--purple)", lineHeight: 1, padding: 0, flex: "none", display: "flex" }}><SteerIcon size={11} /></button>
              )}
              {onEjectQueued && (
                <button onClick={() => onEjectQueued(q.id)} title="Run in a new session"
                  style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: "var(--purple)", fontSize: "var(--t11)", lineHeight: 1, padding: 0, flex: "none" }}>↗</button>
              )}
              {onCancelQueued && (
                <button onClick={() => onCancelQueued(q.id)} title="Remove from queue"
                  style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: "var(--purple)", fontSize: "var(--t11)", lineHeight: 1, padding: 0, flex: "none" }}>✕</button>
              )}
            </span>
          ))}
        </div>
      )}
      {embedNote}
      {/* image attachments */}
      {attachRow && <div style={{ marginBottom: 9 }}>{attachRow}</div>}

      {/* session controls — one line, two tiers. SETTINGS (what the next turn
          *is*) keep a box and carry their own field code, so no width can shed
          the name off a control. VERBS (things that fire now) have no box at
          all: bare tracked text reads as a command, a box reads as a setting,
          which is the distinction the old 12%-alpha fences were failing to
          make. The context meter closes the row as an instrument rather than
          spending a whole row of its own on a track that is empty most of the
          time. Layout ladder lives in index.css. */}
      <div className="ctrl-cq" style={{ marginBottom: 9, position: "relative", zIndex: 26 }}>
        <div className="ctrl-row">
          <div className="ctrl-set">
            {profileDrop(false)}
            {modelOpts.length > 0 && (
              <Drop label="MODEL" code={<Brain size={12} />} value={model} options={modelOpts} fallback={agentPick ? { id: model, label: model || "AGENT DEFAULT" } : undefined}
                open={openDrop === "model"} dot={own("model")}
                onToggle={() => setOpenDrop((d) => (d === "model" ? "" : "model"))}
                onPick={(id) => { onModel(id); setOpenDrop(""); }} />
            )}
            {(!agentPick || agentPick.effort) && (
              <Drop<string> label="EFFORT" code={<Gauge size={12} />} value={effort} options={agentPick?.effort ?? EFFORTS}
                fallback={agentPick ? { id: effort, label: effort || "AGENT DEFAULT" } : undefined} open={openDrop === "effort"} dot={own("effort")}
                onToggle={() => setOpenDrop((d) => (d === "effort" ? "" : "effort"))}
                onPick={(id) => { onEffort(id as EffortLevel | ""); setOpenDrop(""); }} />
            )}
            {permOpts.length > 0 && (
              <Drop label="MODE" code={<ShieldHalf size={12} />} value={perm} options={permOpts} fallback={modeRow(perm)} open={openDrop === "mode"} minWidth={104} dot={own("permission_mode")}
                onToggle={() => setOpenDrop((d) => (d === "mode" ? "" : "mode"))}
                onPick={(id) => { onPerm(id); setOpenDrop(""); }} />
            )}
            {ponyDrop(false)}
            {helpersChip}
          </div>
          {/* One verb list, rendered twice: inline across the row, and inside
              the ··· popover the container query swaps in once the row runs out
              of width. A narrow composer loses where the verbs sit, never what
              they are called — five unlabelled icons would be worse than none. */}
          <div className="ctrl-verbs">
            {verbs.map((v) => (
              <Tip key={v.key} text={v.tip} anchor={v.anchor} pin={false}>
                <button className="ctrl-verb" onClick={v.onClick} disabled={v.disabled}
                  style={v.hot ? { color: "var(--acc)" } : undefined}>
                  {v.label}
                  {v.stamp && <span className="stamp" style={v.stampTone ? { color: v.stampTone } : undefined}>{v.stamp}</span>}
                </button>
              </Tip>
            ))}
            <button className="ctrl-more" onClick={() => setOpenDrop((d) => (d === "verbs" ? "" : "verbs"))}
              title="More actions">···</button>
            {verbMenu}
          </div>
          {/* CONTEXT as an instrument: eight segments that only recolour when
              the window is actually filling, and a COMPACT that is always
              there, dim until past the point where pressing it is the right call. */}
          {ctxBlock}
        </div>
      </div>

      {/* command line */}
      {dock}
      <div {...boxProps} className="cmdbox">
        {pfx}
        {popovers}
        {editorCol}
        {actionCluster}
      </div>
      </>
      )}
    </div>
  );
}
