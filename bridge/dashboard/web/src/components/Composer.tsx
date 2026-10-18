import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Brain, ChevronRight, ChevronsRight, DraftingCompass, Gauge, Merge, Paperclip, Pause, Pin, Scissors, ShieldHalf, SlidersHorizontal, Square, UserRound } from "lucide-react";
import { api, type AccountInfo, type EffortLevel, type GraphState, type ModelId, type SlashCommand, type UsageInfo } from "../api";
import { chipWindow, deadLogin, loginSlot, loginWindows, modelRows, type Window } from "../models";
import { describe, slotHue, type Profile } from "../lib/profiles";
import type { AgentPickers } from "../lib/agents";
import { ago, fmtReset } from "../lib/surfaces";
import { openSettings } from "../lib/opensettings";
import { useIntegrations } from "../lib/integrations";
import { ImageLightbox, MediaThumb, ZoomButton, isFileUrl, withName } from "./ImageLightbox";
import { FileIcon } from "../lib/fileicon";
import { ICON_BODY } from "../lib/fileicons.gen";
import { applyMention, mentionAt, rankPaths, type Mention } from "../lib/mention";
import { isExact, rankCommands, slashAt } from "../lib/slash";
import { Tip } from "./ui/Tip";
import { useChatChrome } from "../lib/chatchrome";
import { MarkdownInput, type MarkdownInputHandle } from "./MarkdownInput";

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
const PONYTAIL_TIP = "PONYTAIL — code-minimalism for this session's runs.\n\nClaude answers as a lazy senior dev: reuse what's already in the repo, stdlib or native platform before a new dependency, shortest diff that works, no speculative abstractions.\n\nOff = normal. Lite → Full → Ultra = increasing pressure to write less code. Default keeps whatever the bridge is configured with.";

// hint → a quieter second line under the label (what a mode does); tag → a
// small pill after it (the run sheet's PROFILE, on the row the profile sets)
type DropOption<T extends string> = { id: T; label: string; short?: string; group?: string; tail?: ReactNode; title?: string; tone?: string; hint?: string; tag?: string };

/** The rows of a picker menu — shared by the chip dropdowns and the COMPACT
 *  layout's run popover, which lists the same models (with the same usage
 *  meters) and the same permission modes inline. */
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
function OverrideDot() {
  return <span title={OVERRIDE_TIP} style={{ color: "var(--acc)", flex: "none" }}>•</span>;
}

function Drop<T extends string>({
  label, code, value, options, fallback, open, onToggle, onPick, minWidth = 78, align = "left", title, dot, tone, meter, menu,
}: {
  label: string;
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
    <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 6 }}>
      <button className="drop-btn" onClick={onToggle} title={title ?? `${label} — ${cur.label}`} style={btn}>
        {code && <span className="ctrl-fld">{code}</span>}
        <span className="drop-val" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: code ? 1 : undefined }}>{cur.short ?? cur.label}</span>
        {dot && <OverrideDot />}
        {meter}
        <span style={{ color: code ? "var(--txl)" : "var(--txd)", fontSize: "var(--t8)", flex: "none" }}>▾</span>
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
function ProfileRows({ profiles, accounts, value, defaultId, onPick, onDefault }: {
  profiles: Profile[];
  accounts?: AccountInfo[];
  value: string;
  defaultId?: string | null;   // undefined: a bridge too old to say, so no pill and no pin
  onPick: (id: string) => void;
  onDefault?: (id: string) => void;
}) {
  const key = (id: string) => (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(id); }
  };
  return (
    <div role="listbox" aria-label="Profiles">
      {profiles.map((p) => {
        const on = p.id === value;
        const dead = deadLogin(accounts, p.agent, p.account);
        const wins = dead === null ? loginWindows(accounts?.find((a) => a.slot === loginSlot(p.agent, p.account))) : [];
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
                : wins.length > 0 && <span className="pm-fuel">{wins.map((w) => <Fuel key={w.tag} w={w} />)}</span>}
            </span>
            {defaultId !== undefined && (
              <span className="pm-tail">
                {p.id === defaultId
                  ? <span className="pm-tag" title="new sessions get this profile unless their project names another">DEFAULT</span>
                  : <button type="button" className="pm-pin" aria-label="Make default"
                      title="Make default · new sessions start on this profile, unless their project names another"
                      onClick={(e) => { e.stopPropagation(); onDefault?.(p.id); }}><Pin size={13} /></button>}
              </span>
            )}
          </div>
        );
      })}
      <button type="button" className="pm-row pm-new" onClick={() => onPick(NEW_PROFILE)}>+ NEW PROFILE</button>
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
function Fuel({ w }: { w: Window }) {
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

/** COMPACT layout's one run control, in two pieces: the chip in the footer
 *  (RunTrigger) and the sheet it opens (RunSheet), which the Composer renders
 *  among the cmdbox's popovers so it spans the box in every layout — hung from
 *  the chip, a sheet this wide ran off the column. Model, mode and effort are
 *  all on show at once, each under its own head with a word on what it
 *  decides, nothing nested: the popover this replaces opened the two lists
 *  inside itself one at a time, reflowing under an effort slider whose stops
 *  had no names. A pick applies at once and the sheet stays open (it is a
 *  settings sheet, not a menu — all three get set in one visit); a click
 *  away or Esc closes it. Design: drafts/run-picker. */
type RunProps<M extends string> = {
  model: M;
  modelOpts: DropOption<M>[];
  perm: string;
  permOpts: DropOption<string>[];
  effort: EffortLevel | "";
  /** Another agent: modelOpts/permOpts are already its own; its effort is its
   *  own list (or none), and its name stands in for an unset model. */
  agent?: AgentPickers | null;
  overrides?: string[]; // the knobs set by hand over the session's profile (OverrideDot)
};

/** The effort's row: Claude's ladder, or the agent's own list, an unset one
 *  reading AGENT DEFAULT. */
function effortRow(effort: string, agent?: AgentPickers | null): { id: string; label: string } {
  if (agent) return agent.effort?.find((o) => o.id === effort) ?? { id: effort, label: effort || "AGENT DEFAULT" };
  return EFFORTS.find((e) => e.id === effort) ?? EFFORTS[0];
}

function RunTrigger<M extends string>({ open, onToggle, model, modelOpts, perm, permOpts, effort, agent, overrides }: RunProps<M> & {
  open: boolean;
  onToggle: () => void;
}) {
  const own = (k: string) => !!overrides?.includes(k);
  const cur = modelOpts.find((o) => o.id === model) ?? modelOpts[0];
  const modelName = agent && !model ? agent.label : cur ? cur.short ?? cur.label : String(model);
  const permRow = permOpts.find((o) => o.id === perm) ?? modeRow(perm);
  const effRow = effortRow(effort, agent);
  const sep = <span className="run-sep" aria-hidden>·</span>;
  return (
    // A chip like the PROFILE and PONYTAIL chips beside it: the field's glyph
    // in a tile, the model bold, the mode and effort quieter, a caret.
    <button className="run-trigger" onClick={onToggle}
      title={`Model ${modelName} · mode ${permRow.label} · effort ${effRow.label}`}
      style={{ appearance: "none", cursor: "pointer", border: 0, padding: 0, background: "transparent",
               fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 7, color: "var(--txd)",
               whiteSpace: "nowrap", minWidth: 0, maxWidth: "100%" }}>
      <span className="ctrl-fld"><SlidersHorizontal size={12} /></span>
      <span style={{ fontWeight: 600, color: open ? "var(--acc)" : "var(--txb)", fontSize: "var(--t105)", overflow: "hidden", textOverflow: "ellipsis" }}>{modelName}{own("model") && <OverrideDot />}</span>
      {perm !== "" && <>{sep}<span style={{ fontSize: "var(--t10)" }}>{permRow.label}{own("permission_mode") && <OverrideDot />}</span></>}
      {effort !== "" && <>{sep}<span style={{ fontSize: "var(--t10)" }}>{effRow.label}{own("effort") && <OverrideDot />}</span></>}
      <span className="run-car" aria-hidden style={{ color: open ? "var(--acc)" : "var(--txl)", fontSize: "var(--t8)", flex: "none" }}>▾</span>
    </button>
  );
}

function RunSheet<M extends string>({ model, modelOpts, onModel, perm, permOpts, onPerm, effort, onEffort, agent, overrides, profile }: RunProps<M> & {
  onModel: (m: M) => void;
  onPerm: (p: string) => void;
  onEffort: (e: EffortLevel | "") => void;
  /** The profile the session is bound to: what a knob set by hand overrides. */
  profile?: { model: string; mode: string; effort: string } | null;
}) {
  const own = (k: string) => !!overrides?.includes(k);
  const effOpts: DropOption<string>[] = agent ? agent.effort ?? [] : EFFORTS;
  // The profile's own value for a knob this session overrides — the row the
  // OverrideDot's "pick the profile's value to follow it again" means, which
  // nothing named before. null while the knob follows the profile, or the
  // profile leaves it unset.
  const from = {
    model: own("model") && profile?.model ? profile.model : null,
    perm: own("permission_mode") && profile?.mode ? profile.mode : null,
    effort: own("effort") && profile?.effort ? profile.effort : null,
  };
  const tagged = <T extends string>(opts: DropOption<T>[], id: string | null) =>
    id === null ? opts : opts.map((o) => (o.id === id ? { ...o, tag: "PROFILE" } : o));
  const head = (label: string, hint: string, opts: { id: string; label: string }[], id: string | null) => (
    <div className="rp-hd">
      <b>{label}</b>
      {id === null
        ? <i>{hint}</i>
        : <i title={OVERRIDE_TIP}><span className="rp-dot">•</span> set here · profile: {opts.find((o) => o.id === id)?.label ?? id.replace(/^claude-/, "")}</i>}
    </div>
  );
  return (
    <div role="dialog" aria-label="Model, mode and effort" className="rp-sheet"
      style={{
        position: "absolute", left: -1, right: -1, bottom: "calc(100% + 9px)", zIndex: 30,
        border: "1px solid color-mix(in srgb, var(--acc) 35%, transparent)",
        background: "color-mix(in srgb, var(--panel2) 98%, transparent)",
        boxShadow: "0 -8px 26px var(--shadow-pop)", animation: "mpop .12s ease",
      }}>
      <div className="rp-grid">
        <div className="rp-sec">
          {head("MODEL", "what runs the turn", modelOpts, from.model)}
          <div className="rp-list">
            {modelOpts.length
              ? <MenuRows options={tagged(modelOpts, from.model)} value={model} onPick={onModel} />
              : <div className="rp-none">this agent hasn't listed its models yet — TEST it in Settings ▸ Accounts</div>}
          </div>
        </div>
        {permOpts.length > 0 && (
          <div className="rp-sec">
            {head("MODE", "what it may do without asking", permOpts, from.perm)}
            <div className="rp-list"><MenuRows options={tagged(permOpts, from.perm)} value={perm} onPick={onPerm} /></div>
          </div>
        )}
      </div>
      {effOpts.length > 0 && (
        <div className="rp-eff">
          {head("EFFORT", "how hard it thinks", effOpts, from.effort)}
          {/* One named stop per level — the slider it replaces had ticks and no names. */}
          <div className="rp-seg" role="group" aria-label="Effort">
            {effOpts.map((e) => (
              <button key={e.id || "auto"} type="button" className="rp-sg" aria-pressed={e.id === effort}
                data-on={e.id === effort ? "" : undefined} data-prof={e.id === from.effort ? "" : undefined}
                title={e.id === from.effort ? "your profile's pick" : undefined}
                onClick={() => onEffort(e.id as EffortLevel | "")}>{e.label}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function Composer({
  disabled, running, model, models, usage, accounts, agentPick, profile, profiles, onProfile, defaultProfile, onDefaultProfile, overrides, effort, perm, onPerm, ponytail, onPonytail, showPonytail, injectedText, injectNonce, sessionId,
  draft, onDraft, contextTokens, contextWindow, onModel, onEffort, onSend, onSteer, onStop, onCompact,
  queued, onCancelQueued, onEjectQueued, onSteerQueued, project, onOpenMap, paused, onTogglePause, pills, fileSink,
}: {
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
  onSend: (text: string, images: string[]) => void;
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
  fileSink?: { current: ((files: FileList) => void) | null };
}) {
  const text = draft;
  const setText = onDraft;
  const [images, setImages] = useState<string[]>([]);
  const [zoom, setZoom] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [openDrop, setOpenDrop] = useState<"" | "profile" | "model" | "effort" | "mode" | "pony" | "verbs" | "run" | "plus" | "queued">("");
  // The run sheet stays open across picks, so it takes a dialog's Esc as well
  // as a click away; the other drops close on their pick.
  useEffect(() => {
    if (openDrop !== "run") return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpenDrop(""); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [openDrop]);
  const { compact, lead, composer, sendKey } = useChatChrome();
  const plugins = useIntegrations();   // the DESIGN button exists while Claude Design is installed
  // TABS / CONSOLE: COMPACT's new composers. CLASSIC is the old markup.
  const shelled = compact && composer !== "classic";
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

  useEffect(() => {
    if (injectNonce) {
      setText(injectedText ?? "");
      taRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [injectNonce]);

  // Focus the command line whenever a session is opened or switched (and on
  // first mount) so you can start typing immediately without clicking in.
  useEffect(() => {
    taRef.current?.focus();
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
  const mention = tree.length ? mentionAt(text, caret) : null;
  const hits = mention ? rankPaths(tree, mention.q) : [];
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
  useEffect(() => {
    if (!slashOn) { setSlashDismissed(false); return; }
    let live = true;
    void api.commands(project)
      .then((r) => { if (live) { setCmds(r.commands); setCmdsStale(false); } })
      .catch(() => { if (live) setCmdsStale(true); });
    return () => { live = false; };
  }, [slashOn, project]);
  const shits = slash ? rankCommands(cmds, slash.q) : [];
  const slashOpen = !!slash && !slashDismissed && (shits.length > 0 || cmdsStale);
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
    if (e.key === "Tab" || (e.key === "Enter" && !isExact(pick, slash!.q))) {
      e.preventDefault();
      splice(slash!, `/${pick.name}`);
      return true;
    }
    return false;
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

  function addFiles(files: FileList | File[] | null) {
    if (!files) return;
    Array.from(files).forEach((f) => {
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
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t, images);
    setText("");
    setImages([]);
  }

  // Land the text — and anything in the attachment tray — in the turn that's
  // already running.
  function steer() {
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
    const t = text.trim();
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
    {
      key: "grill",
      label: "GRILL",
      tip: "GRILL — a relentless interview before any code gets written.\n\nIt asks one question at a time until every open branch of the decision is closed, then you have something worth building from.\n\nType first to grill a specific idea; leave the box empty to grill the conversation so far.\n\nNeeds a grill skill installed — SKILLS ▸ PLUGINS.",
      disabled,
      onClick: () => { const t = text.trim(); setText(""); onSend(t ? `/grill-me ${t}` : "/grill-me", []); },
    },
    ...(showPonytail ? [
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
  // COMPACT moves the profile and ponytail chips to the row's right end and
  // folds model / mode / effort into the run sheet (RunTrigger + RunSheet) over SEND. A profile the
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
  // profile the list lacks has no known login, so neither reads. A meter the
  // usage endpoint won't serve (an idle login's access token lapsed; the CLI
  // renews it on that login's next turn) reads UNKNOWN rather than nothing.
  const chipSlot = agentPick || (profile && !bound) ? null : loginSlot(bound?.agent, bound?.account);
  const chipAcct = chipSlot === null ? undefined : accounts?.find((a) => a.slot === chipSlot);
  const chipWins = loginWindows(chipAcct);
  const chipWin = chipWindow(chipWins);
  const chipMeter = chipWin
    ? <span className="ctrl-meter" style={{ fontSize: "var(--t9)", letterSpacing: .5, flex: "none" }}>
        <span style={{ color: sevColor(chipWin.severity) }}>{chipWin.left}%</span>
        <span style={{ color: "var(--txd)" }}>{fmtReset(chipWin.resets_at)}</span>
      </span>
    : chipAcct && chipAcct.left === null && !chipAcct.disabled
      ? <span className="ctrl-meter" style={{ fontSize: "var(--t9)", letterSpacing: .5, color: "var(--txd)", flex: "none" }}>UNKNOWN</span>
      : undefined;
  const chipName = `PROFILE — ${bound?.name ?? (profile || "NO PROFILE")}`;
  const chipTitle = chipWins.length
    ? `${chipName} · ${chipWins.map((w) => `${w.name}: ${w.left}% left${w.resets}`).join(" · ")}`
    : chipMeter ? `${chipName} · usage unknown: this login's access token has lapsed; its meter reads again once it runs a turn` : undefined;
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
  const profileDrop = (right: boolean) => profiles && (
    <Drop label="PROFILE" code={agentPick ? <UserRound size={12} /> : <ClaudeLogo />} value={profile} options={profileOpts}
      fallback={{ id: profile, label: profile || "NO PROFILE" }} minWidth={104} align={right ? "right" : "left"} open={openDrop === "profile"}
      tone={boundDead !== null ? "var(--err)" : undefined} meter={boundDead !== null ? undefined : chipMeter}
      title={boundDead !== null ? `PROFILE — ${bound?.name}: account ${boundDead}'s Claude login has expired; pick it in this menu to sign in again.` : chipTitle}
      onToggle={() => setOpenDrop((d) => (d === "profile" ? "" : "profile"))}
      onPick={pickProfileRow}
      menu={<ProfileRows profiles={profiles} accounts={accounts} value={profile} defaultId={defaultProfile} onPick={pickProfileRow} onDefault={onDefaultProfile} />} />
  );
  // Which agent runs this session, when it isn't Claude. A label, not a
  // control: a session keeps the agent it first ran on.
  const agentChip = agentPick && (
    <span title={`Runs on ${agentPick.label}, not Claude — its own models and modes. Change it with a new session.`}
      style={{ ...chip, flex: "none", cursor: "help", color: "var(--warn)", whiteSpace: "nowrap",
               borderColor: "color-mix(in srgb, var(--warn) 40%, transparent)" }}>
      ◇ {agentPick.label}
    </span>
  );
  const ponyDrop = (right: boolean) => showPonytail && (
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
  const plusBtn = (
    <div style={{ position: "relative", flex: "none" }}>
      <button className="pb-plus" onClick={() => setOpenDrop((d) => (d === "plus" ? "" : "plus"))}
        title={["Attach a file", ...verbs.map((v) => v.label)].join(" · ")} aria-label="Attach or run a verb">+</button>
      {openDrop === "plus" && menuOf([{ key: "attach", label: "ATTACH A FILE", tip: "Attach a file", onClick: () => fileRef.current?.click() }, ...verbs])}
    </div>
  );
  const ctxBlock = (
    <div className="ctrl-ctx" title={`Context — ${ctxPct}% of ${fmtTokens(ctxMax)}${ctx > 0 ? ` (${ctx.toLocaleString()} tokens on the last request)` : ", not measured yet"}`}>
      <span className="lbl">CTX</span>
      <span className="seg">
        {Array.from({ length: CTX_SEGMENTS }, (_, i) => (
          <i key={i} style={i < ctxSegs ? { background: ctxColor } : undefined} />
        ))}
      </span>
      <span style={{ color: suggest ? ctxColor : "var(--txd)", fontSize: "var(--t10)", letterSpacing: .5, flex: "none" }}>{ctxPct}%</span>
      {suggest && ctx > 0 && <span style={{ flex: "none" }}>~{fmtTokens(ctx)}</span>}
      {onCompact && (!shelled || suggest) && (
        // Whatever is in the box rides along as compaction instructions ("keep
        // the auth work, drop the log spelunking") — Piebald opens a dialog for
        // this; we already have a text box right there.
        <button onClick={() => { onCompact(text.trim()); setText(""); }} disabled={disabled || running}
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
  const designBtn = plugins.design && (
    <button className="act-alt neutral" onClick={design} disabled={disabled || !text.trim()}
      title={"DESIGN — design before code.\n\nSends the box to /design-first: Claude drafts the screens with the design system, screenshots them into the transcript, pushes the draft to the linked Claude Design project, and waits for your approval before implementing.\n\nNeeds text in the box; syncing needs a linked design project (the chat header's project name ▸ ◇ Design system)."}>
      DESIGN <DraftingCompass size={12} strokeWidth={1.8} aria-hidden /></button>
  );
  /* Exactly one primary. STOP and PAUSE are rare and modal and one of
     them is destructive, so they sit as recessive glyphs and only take
     their colour when you reach for them — their labels live in the
     tooltip. STEER is the alternate target for the same text, so it
     stays an outline. QUEUE/SEND is what Enter does, so it is the only
     filled control on the line. */
  const actions = (withDesign: boolean) => running ? (
    <>
      <button className="act-glyph stop" onClick={onStop} aria-label="Stop"
        title="STOP — interrupt this turn now">
        <Square size={11} strokeWidth={0} fill="currentColor" aria-hidden /></button>
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
        <button className="act-alt" onClick={steer} disabled={!text.trim()}
          title="STEER — fold this into the turn that's running now (falls back to queueing if the run just ended)">
          STEER <SteerIcon /></button>
      )}
      <button className="act-pri queue" onClick={submit} disabled={disabled || !text.trim()}
        title="QUEUE — run this prompt after the current turn (Enter)">
        QUEUE <ChevronsRight size={13} strokeWidth={1.8} aria-hidden /></button>
    </>
  ) : (
    <>
      {withDesign && designBtn}
      <button className="act-pri" onClick={submit} disabled={disabled || !text.trim()} title="SEND (Enter)">
        SEND <ChevronRight size={13} strokeWidth={1.8} aria-hidden /></button>
    </>
  );
  const actionCluster = (<>{fileInput}{paperclip}{actions(true)}</>);

  // Pieces the compact shells arrange (.mystical/design-drafts/prompt-box):
  // every row the composer can show, as one node each, placed by TABS and
  // CONSOLE below. DEFAULT keeps its own markup further down.
  const pausedPill = paused && (
    <span className="pb-paused" title={running ? "this turn finishes; nothing starts after it" : "nothing starts on its own"}>
      <Pause size={10} strokeWidth={0} fill="currentColor" aria-hidden />
      paused{queued && queued.length > 0 ? ` · ${queued.length} held` : ""}
      {onTogglePause && <button onClick={onTogglePause} title="Let queued prompts and goal nudges run again">RESUME</button>}
    </span>
  );
  // Not positioned itself: the list anchors to .pb-ledger's left edge, so it
  // never runs off the column when the chip sits late in a wrapped line.
  const queuedChip = queued && queued.length > 0 && (
    <div>
      <button className="pb-queued" onClick={() => setOpenDrop((d) => (d === "queued" ? "" : "queued"))} title={queued.map((q) => q.text).join("\n")}>
        {queued.length} queued <span aria-hidden style={{ fontSize: "var(--t8)", opacity: .8 }}>▾</span>
      </button>
      {openDrop === "queued" && (
        <div style={{ position: "absolute", bottom: "calc(100% + 6px)", left: 0, zIndex: 30, minWidth: 260, maxWidth: 440, border: "1px solid color-mix(in srgb, var(--purple) 34%, transparent)", background: "color-mix(in srgb, var(--panel2) 98%, transparent)", boxShadow: "0 -8px 26px var(--shadow-pop)", animation: "mpop .12s ease" }}>
          {queued.map((q) => (
            <div key={q.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderBottom: "1px solid color-mix(in srgb, var(--acc) 8%, transparent)", fontSize: "var(--t105)", color: "var(--txh)" }}>
              <span title={q.text} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.text}</span>
              {running && onSteerQueued && <button onClick={() => onSteerQueued(q.id)} title="Steer — fold this into the turn that's running now" style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: "var(--purple)", lineHeight: 1, padding: 0, flex: "none", display: "flex" }}><SteerIcon size={11} /></button>}
              {onEjectQueued && <button onClick={() => onEjectQueued(q.id)} title="Run in a new session" style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: "var(--purple)", fontSize: "var(--t11)", lineHeight: 1, padding: 0, flex: "none" }}>↗</button>}
              {onCancelQueued && <button onClick={() => onCancelQueued(q.id)} title="Remove from queue" style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: "var(--purple)", fontSize: "var(--t11)", lineHeight: 1, padding: 0, flex: "none" }}>✕</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
  // CSS hides an empty ledger and, past one live item, every pill's
  // description (.pill-desc) — busy means terse.
  const ledger = (className: string) => (
    <div className={`pb-ledger ${className}`}>{pills}{pausedPill}{queuedChip}</div>
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
  const settingsChips = (right: boolean) => (<>{profileDrop(right)}{agentPick && agentChip}{ponyDrop(right)}</>);
  const runTrigger = (
    <RunTrigger open={openDrop === "run"} onToggle={() => setOpenDrop((d) => (d === "run" ? "" : "run"))}
      model={model} modelOpts={modelOpts} perm={perm} permOpts={permOpts} effort={effort}
      agent={agentPick} overrides={overrides} />
  );
  const popovers = (
    <>
      {openDrop === "run" && (
        <RunSheet model={model} modelOpts={modelOpts} onModel={onModel}
          perm={perm} permOpts={permOpts} onPerm={onPerm}
          effort={effort} onEffort={onEffort}
          agent={agentPick} overrides={overrides} profile={bound} />
      )}
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
              onMouseDown={(e) => { e.preventDefault(); splice(slash!, `/${c.name}`); }}
              onMouseEnter={() => setSlashPick(i)}
              title={c.description}
              style={{ appearance: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", border: 0, borderLeft: `2px solid ${i === slashPick ? "var(--acc)" : "transparent"}`, background: i === slashPick ? "color-mix(in srgb, var(--acc) 10%, transparent)" : "transparent", color: i === slashPick ? "var(--txb)" : "var(--txh)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t115)", padding: "5px 10px" }}
            >
              <span style={{ flex: "none", color: "var(--acc)" }}>/{c.name}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--txl)" }}>{c.description}</span>
              <span style={{ flex: "none", fontSize: "var(--t8)", letterSpacing: 1, color: "var(--txd)" }}>{c.scope === "builtin" ? "CLI" : c.scope.toUpperCase()}</span>
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
              <FileIcon name={p} size={14} />
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", direction: "rtl", textAlign: "left" }}>{p}</span>
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
      onChange={(t, c) => { setText(t); setCaret(c); }}
      onCaret={setCaret}
      onKeyDown={(e) => {
        if (mentionKey(e) || slashKey(e)) return;
        // Ctrl+R is the browser's reload; in the command line it's the shell's
        // history search, which is what the hands in this box expect.
        if (e.key === "r" && e.ctrlKey) { e.preventDefault(); setRsearch(""); return; }
        // CTRL+ENTER mode leaves a bare Enter to the editor, which makes it
        // the markdown-aware newline Shift+Enter is in the default mode.
        const send = sendKey === "ctrl-enter" ? e.ctrlKey || e.metaKey : !e.shiftKey;
        if (e.key === "Enter" && send) { e.preventDefault(); submit(); }
      }}
      onPaste={(e) => { const imgs = imagesFrom(e.clipboardData?.items); if (imgs.length) { e.preventDefault(); addFiles(imgs); } }}
      placeholder={disabled ? "working…" : running ? "queue a prompt — runs after the current turn…" : "message claude — describe a change, paste an error…"}
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
  const hint = (
    <span className="pb-hint" aria-hidden>
      {sendKey === "ctrl-enter" ? `⌘↵ ${running ? "queue" : "send"} · ↵ newline` : `↵ ${running ? "queue" : "send"} · ⇧↵ newline`}
    </span>
  );

  // The two new COMPACT composers (CLASSIC is the old markup further down).
  // The lead (tile, title, project, branch, PR, running app) arrives flattened
  // from Terminal; .pb-lead lays it out per shell in index.css.
  const shell =
    composer === "console" ? (
      <>
        {attachRow}
        <div {...boxProps} className="cmdbox pb-cmd">
          {pfx}
          {popovers}
          {editor}
          {hint}
          <div className="pb-acts">{actions(true)}</div>
        </div>
        <div className="pb-place pb-lead">{lead}</div>
        {ledger("pb-activity")}
        <div className="pb-set">
          {ctxBlock}
          {runTrigger}
          {settingsChips(false)}
          <span className="sp" />
          {plusBtn}
        </div>
      </>
    ) : (
      <>
        <div className="pb-tabs pb-lead">{lead}{ctxBlock}</div>
        <div {...boxProps} className="cmdbox pb-card">
          {ledger("")}
          {attachRow}
          <div className="pb-line">{pfx}{popovers}{editor}</div>
          {/* DESIGN steps out while a turn runs (it could only queue): that is
              what keeps this footer on one line at 787px with both sidebars open. */}
          <div className="pb-foot"><div className="pb-l">{plusBtn}{settingsChips(false)}</div><div className="pb-r">{runTrigger}{actions(!running)}</div></div>
        </div>
      </>
    );

  return (
    // Its own surface, at the island's strength: header and footer are the two
    // pieces of chrome bracketing the transcript, and a ground running under
    // them makes the chat look like it has no edges.
    <div className="composer" data-pb={shelled ? composer : undefined} style={{ flex: "none", borderTop: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)", padding: "11px 16px", background: "color-mix(in srgb, var(--panel) 88%, transparent)" }}>
      {zoom && <ImageLightbox src={zoom} all={images.map((src) => ({ src }))} onClose={() => setZoom(null)} />}
      {openDrop && <div onClick={() => setOpenDrop("")} style={{ position: "fixed", inset: 0, zIndex: 25 }} />}
      {shelled ? (
        <>
          {fileInput}
          {shell}
        </>
      ) : (
      <>
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
      {compact ? (
        // CLASSIC: the session's nameplate on the left (moved down from the
        // header), everything left in this row packed to the right.
        <div className="ctrl-cq" style={{ marginBottom: 9, position: "relative", zIndex: 26 }}>
          <div className="ctrl-row ctrl-row-compact">
            <div className="ctrl-lead">{lead}</div>
            <div className="ctrl-verbs ctrl-verbs-compact">
              <button className="ctrl-more" onClick={() => setOpenDrop((d) => (d === "verbs" ? "" : "verbs"))}
                title="More actions">···</button>
              {verbMenu}
            </div>
            {ctxBlock}
            <div className="ctrl-set">
              {profileDrop(true)}
              {agentPick && agentChip}
              {ponyDrop(true)}
            </div>
          </div>
        </div>
      ) : (
      <div className="ctrl-cq" style={{ marginBottom: 9, position: "relative", zIndex: 26 }}>
        <div className="ctrl-row">
          <div className="ctrl-set">
            {profileDrop(false)}
            {agentPick && agentChip}
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
      )}

      {/* command line */}
      <div {...boxProps} className="cmdbox">
        {pfx}
        {popovers}
        {editor}
        {compact ? (
          // CLASSIC: the run popover's trigger sits over the send cluster, on
          // its own line, so the box's right edge reads model-then-send.
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 7, flex: "none", maxWidth: "50%", position: "relative", zIndex: 27 }}>
            {runTrigger}
            <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
              {actionCluster}
            </div>
          </div>
        ) : actionCluster}
      </div>
      </>
      )}
    </div>
  );
}
