import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import {
  TriangleAlert, CircleStop, Copy, Check, RotateCw, RotateCcw, ChevronDown, ChevronLeft, ChevronRight,
  Quote, Layers, Image as ImageIcon, Terminal, FileText, Pencil, FilePlus, Search, Globe,
  Plug, Bot, Sparkles, Webhook, ScrollText, CircleX, Wrench, Circle, type LucideIcon,
} from "lucide-react";
import { api, type AnswerSelection, type RunEvent, type TimedEvent } from "../api";
import type { PendingRequest } from "../chat";
import { Markdown, type OpenFile } from "./Markdown";
import { selectionMd } from "../lib/selmd";
import { PermissionCard } from "./PermissionCard";
import { QuestionCard } from "./QuestionCard";
import { ImageLightbox, MediaThumb, ZoomButton, type Clip, type Shown } from "./ImageLightbox";
import { askBack, type AskBack } from "../lib/askback";
import { hhmm, useClock12, wall } from "../lib/surfaces";
import { ckId, steerKey } from "../lib/checkpoints";
import { foldChips, runsOf, insideRun, byFile, type EditEv } from "../lib/toolfold";
import { segmentsOf, stepsTitle, type Seg, type StepCat } from "../lib/segments";
import { chapterStarts, kindsOf, stretchesOf, workTitle, zonesOf, TOP_TYPES, type Mark } from "../lib/dossier";
import { PromptBubble } from "./PromptBubble";
import { WorkingIndicator } from "./hud/WorkingIndicator";
import type { HudSettings } from "../lib/theme";
import { markShotSeen, shotUnseen, useSeenShots } from "../lib/seenshots";
import { fmtSpan, openAgent, useAgentFor } from "../lib/subagents";
import { ToolWidget } from "./ResultWidgets";
import { jobView, type JobViewInput } from "./JobViews";
import { JobTag } from "./hud/JobTag";
import { shotName, shotTitle, widgetForRun, type ToolStyle, type WebSource } from "../lib/toolwidget";
import {
  cmdAbstract, hostOf, mcpParts, toolAccent, toolKind, toolShape, toolTag, toolTier,
  type Shape, type Tier, type ToolKind,
} from "../lib/tools";

// Result blocks already "printed" this session — guards against re-typing when a
// session is reopened or the transcript re-renders.
const typedResults = new Set<string>();

/** Types `text` out left-to-right (plain) the first time a live result lands,
 *  then swaps to formatted Markdown. Non-live results render instantly. */
function Typewriter({
  text,
  animate,
  idKey,
  className,
}: {
  text: string;
  animate: boolean;
  idKey: string;
  className?: string;
}) {
  // -1 is "done typing". A `n >= text.length` test can't stand in for it: `text`
  // grows under a mounted block when FinalResult folds the ask-back question back
  // into the body (the turn stopped being the last one), and a finished block that
  // falls back to the plain branch prints raw markdown under a stuck caret.
  const [n, setN] = useState(() => (animate && !typedResults.has(idKey) ? 0 : -1));

  useEffect(() => {
    if (n < 0) return;
    typedResults.add(idKey);
    const step = Math.max(1, Math.ceil(text.length / 60)); // ~60 frames ≈ 2.1s, capped
    const id = setInterval(() => {
      setN((p) => {
        const next = p + step;
        if (next >= text.length) {
          clearInterval(id);
          return -1;
        }
        return next;
      });
    }, 35);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (n < 0) return <Markdown className={className}>{text}</Markdown>;
  return (
    <div className={`${className ?? ""} whitespace-pre-wrap break-words`}>
      {text.slice(0, n)}
      <span
        className="ml-px inline-block h-[1em] w-[7px] translate-y-[2px] bg-primary align-middle"
        style={{ animation: "caret 1s steps(1) infinite" }}
      />
    </div>
  );
}

/** Every tool card is drawn in its own accent (see lib/tools) — this is the two
 *  edges that accent draws: the card's hairline and the tag's box. */
const edge = (accent: string) => `color-mix(in srgb, ${accent} 24%, transparent)`;
const tagEdge = (accent: string) => `color-mix(in srgb, ${accent} 35%, transparent)`;

type Done = { ms?: number; output?: string; is_error?: boolean; patch?: string[];
  stat?: string; images?: string[]; clip?: Clip; sources?: WebSource[] };

// Diff lines shown before a block folds — a turn can hold dozens.
const DIFF_PREVIEW = 20;

/** The virtualizer's guess at a turn's height caps the event count here
 *  (Transcript estimateSize): the work sits in zones that are shut unless you
 *  open them, so a turn's length overstates what it draws. The tail window this
 *  once sized — the last 60 events, the rest behind an EARLIER STEPS button —
 *  is gone for the same reason: a shut zone costs nothing to hold the whole
 *  turn, and the plate's figure counts all of it. */
export const TURN_TAIL = 60;

/** A failed Bash result opens with the shell's status line ("Exit code 2\n…").
 *  It belongs in the header as a badge, not in the body. */
const EXIT_RE = /^(?:Error: )?Exit code (\d+)\n?/;

function dur(ms?: number): string {
  if (!ms) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** The duration worth printing. Under a second nothing was slow, so the figure
 *  is noise on every row — the ones that matter are the ones that waited. */
function slow(ms?: number): string {
  return ms && ms >= 1000 ? dur(ms) : "";
}

/** Header affordance — small, quiet, brightens on hover. Never a <button> inside
 *  another one, so the surrounding header stays a plain row. */
function HeadBtn({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex-none px-0.5 text-[length:var(--t10)] leading-none tracking-[1px] text-muted-2 hover:text-foreground-bright"
    >
      {children}
    </button>
  );
}

function CopyBtn({ text, title }: { text: string; title: string }) {
  const [hit, setHit] = useState(false);
  return (
    <HeadBtn
      title={title}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setHit(true);
          setTimeout(() => setHit(false), 1200);
        });
      }}
    >
      {hit ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
    </HeadBtn>
  );
}

/** The mark a tool's row wears on the WORK zone's spine — the same mark the
 *  zone's header chips count it under (lib/dossier kindsOf). */
const KIND_MARK: Partial<Record<ToolKind, Mark>> = {
  bash: "command", read: "read", write: "write", search: "search", web: "fetch",
  mcp: "call", agent: "agent",
};
const kindMark = (name: string): Mark => KIND_MARK[toolKind(name)] ?? "step";

/** What a mark looks like: the icon is the row's kind, so the zone needs no
 *  column of kind words (they stay in the row, for a screen reader). A note
 *  and a thought are a dot and a ring drawn by index.css; their icons serve
 *  the header's chips. */
const MARK_ICON: Record<Mark, LucideIcon> = {
  command: Terminal, read: FileText, edit: Pencil, write: FilePlus, search: Search,
  fetch: Globe, call: Plug, agent: Bot, skill: Sparkles, hook: Webhook, log: ScrollText,
  fail: CircleX, step: Wrench, note: Circle, think: Circle,
};
function MarkIcon({ mark, size = 14 }: { mark: Mark; size?: number }) {
  const I = MARK_ICON[mark];
  return <I size={size} strokeWidth={size > 12 ? 1.9 : 2.2} aria-hidden />;
}

/** The tag a row wears — in the WORK zone it is what a screen reader hears, the
 *  icon on the spine being what you see: a longer name (TOOLSEARCH, MULTIEDIT,
 *  BASHOUTPUT) says its family's word. */
const KIND_WORD: Record<ToolKind, string> = {
  bash: "BASH", read: "READ", write: "EDIT", search: "SEARCH", web: "WEB",
  agent: "AGENT", plan: "PLAN", mcp: "MCP", plain: "TOOL",
};
const kindTag = (name: string): string => {
  const t = toolTag(name);
  return t.length > 7 ? KIND_WORD[toolKind(name)] : t;
};

type Cmd = { command: string; done?: Done };

/** One command as a row of the ledger: the phrase it amounts to, and its output
 *  behind the chevron. Inside a run it wears no tag and no mark — the run's head
 *  row already said BASH, and the member hangs off it.
 *  With AUTO-OPEN RESULTS on it opens itself while it runs, when it fails, and
 *  for the newest command. */
function CommandRow({
  command,
  done,
  newest,
  animate,
  autoOpen,
  tag,
  onRerun,
}: Cmd & {
  newest: boolean;
  animate: boolean;
  autoOpen: boolean;
  /** Set only for a lone command — inside a window the header carries it. */
  tag?: string;
  onRerun?: (command: string) => void;
}) {
  const running = !done;
  const failed = !!done?.is_error;
  const raw = (done?.output ?? "").trimEnd();
  const exit = raw.match(EXIT_RE);
  const out = exit ? raw.slice(exit[0].length) : raw;
  const lines = out ? out.split("\n").length : 0;
  // What the command did, in words. Empty when nothing beats the line itself.
  // A cut, not a cross-fade: two legible strings on one row is worse than any
  // hard swap, and staggering them blanks the row instead.
  const said = cmdAbstract(command);

  return (
    <ActionRow
      tier={failed ? "mark" : "reach"}
      shape={tag ? "term" : undefined}
      accent="var(--acc)"
      tag={tag}
      mark={tag ? "command" : undefined}
      animate={animate}
      running={running}
      error={failed}
      startOpen={autoOpen && (running || failed || newest)}
      stat={
        <>
          {exit && <span style={{ color: "var(--err)" }}>EXIT {exit[1]}</span>}
          {slow(done?.ms) ? <span>{dur(done?.ms)}</span> : null}
          {lines > 0 && <span>{lines} line{lines === 1 ? "" : "s"}</span>}
        </>
      }
      drawer={
        lines > 0 || running
          ? () => (
              <>
                <DrawerHead
                  mark="$"
                  text={command}
                  onRerun={onRerun && (() => onRerun(command))}
                />
                {lines > 0 ? <DrawerText text={out} error={failed} /> : null}
                <DrawerFoot>
                  {exit ? <span style={{ color: "var(--err)" }}>EXIT {exit[1]}</span> : null}
                  {done?.ms ? <span>{dur(done.ms)}</span> : null}
                  {lines > 0 ? <span>{lines} LINES</span> : null}
                </DrawerFoot>
              </>
            )
          : undefined
      }
    >
      {said ? (
        <>
          <span className="font-sans group-hover/act:hidden">{said}</span>
          <span className="hidden group-hover/act:inline">{command}</span>
        </>
      ) : (
        command
      )}
      {running && (
        <span
          className="ml-px inline-block h-[1em] w-[7px] translate-y-[2px] bg-primary align-middle"
          style={{ animation: "caret 1s steps(1) infinite" }}
        />
      )}
    </ActionRow>
  );
}

/** A run of Bash calls drawn as the one terminal they actually ran in. The box
 *  is the one this file kept: it earns its frame by holding n commands, not one.
 *  A single command is a ledger row like any other action. */
function TerminalGroup({
  cmds,
  animate,
  autoOpen,
  onRerun,
}: {
  cmds: Cmd[];
  animate: boolean;
  autoOpen: boolean;
  onRerun?: (command: string) => void;
}) {
  const running = cmds.some((c) => !c.done);
  const failed = cmds.some((c) => c.done?.is_error);
  const ms = cmds.reduce((t, c) => t + (c.done?.ms ?? 0), 0);
  const accent = failed ? "var(--err)" : running ? "var(--warn)" : "var(--ok)";

  if (cmds.length === 1)
    return (
      <CommandRow
        command={cmds[0].command}
        done={cmds[0].done}
        tag="BASH"
        newest
        animate={animate}
        autoOpen={autoOpen}
        onRerun={onRerun}
      />
    );

  return (
    <div
      className="ax-window"
      data-err={failed ? "" : undefined}
      style={{
        ...({ "--h": accent } as React.CSSProperties),
        ...(animate ? { animation: "termIn .42s cubic-bezier(.2,.8,.2,1) both" } : {}),
      }}
    >
      <ActionRow tier="reach" mark="command" accent={accent} tag="BASH" running={running} animate={false}
        stat={slow(ms) ? <span>{dur(ms)}</span> : null}>
        {cmds.length} commands
      </ActionRow>
      {cmds.map((c, k) => (
        <CommandRow
          key={k}
          command={c.command}
          done={c.done}
          newest={k === cmds.length - 1}
          animate={animate}
          autoOpen={autoOpen}
          onRerun={onRerun}
        />
      ))}
    </div>
  );
}

function diffColor(line: string): string {
  if (line.startsWith("@@")) return "var(--purple)";
  if (line.startsWith("+")) return "var(--ok)";
  if (line.startsWith("-")) return "var(--err)";
  return "var(--muted-foreground)";
}

/** An edit shown as the diff Claude Code already computed for it, so a turn says
 *  what changed instead of just which file was touched. A mark row like any
 *  other write — the patch lives in its drawer, where the row's `+n −n` is the
 *  promise of what you'll find. `shownMax` is a preview or the lot; a diff can
 *  run to hundreds of lines and the drawer is the wrong place for all of them
 *  by default.
 *
 *  One row is one *file*, not one call: `count` is how many edits landed on it
 *  and the drawer holds all their hunks in order. `bare` drops the tag for a row
 *  inside an EDIT window, where the header already said it — and no lead glyph
 *  takes its place, because inside that window every row is the same verb. */
function DiffBlock({
  name,
  path,
  patch,
  ms,
  animate,
  autoOpen,
  count = 1,
  error = false,
  bare = false,
}: {
  name: string;
  path: string;
  patch: string[];
  ms?: number;
  animate: boolean;
  autoOpen: boolean;
  count?: number;
  error?: boolean;
  bare?: boolean;
}) {
  const [shownMax, setShownMax] = useState(DIFF_PREVIEW);
  const add = patch.filter((l) => l.startsWith("+")).length;
  const del = patch.filter((l) => l.startsWith("-")).length;

  return (
    <ActionRow
      tier="mark"
      shape={bare ? undefined : toolShape(name)}
      accent={toolAccent(name)}
      tag={bare ? undefined : kindTag(name)}
      mark={bare ? undefined : name === "Write" ? "write" : "edit"}
      animate={animate}
      error={error}
      startOpen={autoOpen}
      stat={
        <>
          {count > 1 && <span style={{ color: "var(--txm)" }}>×{count}</span>}
          <span style={{ color: "var(--ok)" }}>+{add}</span>
          <span style={{ color: "var(--err)" }}>−{del}</span>
          {slow(ms) ? <span>{dur(ms)}</span> : null}
        </>
      }
      drawer={() => {
        const shown = patch.slice(0, shownMax);
        const hidden = patch.length - shown.length;
        return (
          <>
            <DrawerHead mark="@" text={path} />
            <div
              className="max-h-[180px] overflow-auto border-l border-[var(--ac-08)] pl-2.5 leading-[1.55]"
              onClick={(e) => e.stopPropagation()}
            >
              {shown.map((line, i) => (
                <div key={i} className="whitespace-pre" style={{ color: diffColor(line) }}>
                  {line || " "}
                </div>
              ))}
            </div>
            <DrawerFoot>
              <span>{add} ADDED · {del} REMOVED</span>
              {count > 1 ? <span>{count} EDITS</span> : null}
              {ms ? <span>{dur(ms)}</span> : null}
              {hidden > 0 && (
                <HeadBtn title="show the whole diff" onClick={() => setShownMax(patch.length)}>
                  +{hidden} LINES ⌄
                </HeadBtn>
              )}
            </DrawerFoot>
          </>
        );
      }}
    >
      <FilePath path={path} />
    </ActionRow>
  );
}

/** A run of edits drawn the way a run of commands is: the tag once in the
 *  header, a row per *file* — seven edits to one seeder used to print its name
 *  seven times, each with its own two-line diffstat, and the turn read as a
 *  stutter instead of as work. Here they are one row wearing ×7, with every
 *  hunk in its drawer, and the header carries what the whole run cost.
 *
 *  One file needs no window: the merged row is already the card, the same way a
 *  lone command is a ledger row and not a terminal. */
function EditGroup({
  edits,
  animate,
  autoOpen,
}: {
  edits: EditEv[];
  animate: boolean;
  autoOpen: boolean;
}) {
  const files = byFile(edits);
  if (files.length === 1)
    return <DiffBlock {...files[0]} animate={animate} autoOpen={autoOpen} />;

  const accent = toolAccent("Edit");
  const failed = files.some((f) => f.error);
  const lines = files.flatMap((f) => f.patch);
  const add = lines.filter((l) => l.startsWith("+")).length;
  const del = lines.filter((l) => l.startsWith("-")).length;
  const ms = files.reduce((t, f) => t + f.ms, 0);

  return (
    <div
      className="ax-window"
      data-err={failed ? "" : undefined}
      style={{
        ...({ "--h": accent } as React.CSSProperties),
        ...(animate ? { animation: "termIn .42s cubic-bezier(.2,.8,.2,1) both" } : {}),
      }}
    >
      {/* The last figure is the one the head exists for: what this whole run
          did to the tree, without opening a single drawer. */}
      <ActionRow tier="mark" mark="edit" accent={accent} tag="EDIT" animate={false}
        stat={
          <>
            {slow(ms) ? <span>{dur(ms)}</span> : null}
            <span style={{ color: "var(--ok)" }}>+{add}</span>
            <span style={{ color: "var(--err)" }}>−{del}</span>
          </>
        }>
        {files.length} files{edits.length > files.length ? ` · ${edits.length} edits` : ""}
      </ActionRow>
      {files.map((f) => (
        <DiffBlock key={f.path} {...f} bare animate={false} autoOpen={autoOpen} />
      ))}
    </div>
  );
}

/** A path in the form a reader uses: the filename, and the one directory it
 *  sits in. The head of an absolute path is a mount point
 *  nobody reads — and it is exactly what a plain truncation keeps, cutting off
 *  the one part that identifies the file. */
function shortDir(dir: string): string {
  const parts = dir.split("/").filter(Boolean);
  return parts.length > 1 ? `\u2026/${parts[parts.length - 1]}/` : dir;
}

/** The directory takes the truncation, the filename never gets cut. A flex row,
 *  not one truncating line: `text-overflow` cuts the tail, and the tail is the
 *  filename — so the directory is the part allowed to shrink. */
function FilePath({ path }: { path: string }) {
  const cut = path.lastIndexOf("/");
  const dir = cut >= 0 ? path.slice(0, cut + 1) : "";
  const short = shortDir(dir);
  return (
    <span className="ax-path" title={path}>
      {/* Resting, the path shows the tail that identifies the file; hovering
          swaps in the real one, head and all. Both are rendered and toggled in
          CSS — the same hard cut a command's phrase makes. */}
      <span className="d text-muted-2">
        {short === dir ? dir : (
          <>
            <span className="group-hover/act:hidden">{short}</span>
            <span className="hidden group-hover/act:inline">{dir}</span>
          </>
        )}
      </span>
      <span className="n text-foreground-bright">{path.slice(cut + 1)}</span>
    </span>
  );
}

/** What came back, then how long it took — the ledger's consequence cell. Both
 *  are optional; an unfinished call has neither. Under a second nothing was
 *  slow, so the figure is noise on every row and only the waits are printed. */
function Took({ ms, stat, error }: { ms?: number; stat?: string; error?: boolean }) {
  if (!slow(ms) && !stat) return null;
  return (
    <>
      {stat && (
        <span className="max-w-[220px] truncate" style={error ? { color: "var(--err)" } : undefined} title={stat}>
          {stat}
        </span>
      )}
      {slow(ms) ? <span>{dur(ms)}</span> : null}
    </>
  );
}

/** Why a call failed, in full — its own wrapped line under the card, not a chip
 *  squeezed into the row. The reason is a sentence ("MCP requests not allowed
 *  for free accounts") and it lands after the summary, so a clipped one shows
 *  only the half that says nothing. */
function ErrLine({ text }: { text: string }) {
  return (
    <div
      className="whitespace-pre-wrap break-words border-l-2 py-1 pl-2 font-mono text-[length:var(--t11)] leading-relaxed"
      style={{ color: "var(--err)", borderColor: "var(--err)" }}
    >
      {text}
    </div>
  );
}

/** A pause where the model reasoned, opening onto the reasoning itself — Claude
 *  Code records it and simply never prints it. Shut by default: a turn holds
 *  dozens, and the row alone already explains the one thing a list of tool cards
 *  can't, the gap between them. */
/** The gap between spawning the child and its first token — spent connecting MCP
 *  servers and loading the transcript. An empty stream reads as a hang, so name
 *  the wait. Live status, not an event: real output replaces it. */
function BootRow({ text }: { text: string }) {
  return (
    <div role="status" className="flex items-center gap-2 py-0.5 text-muted-2">
      <span aria-hidden
            className="h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-current motion-reduce:animate-none" />
      <span className="text-[length:var(--t10)] uppercase tracking-[2px]">{text}</span>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}

/** A line in a teammate's device run that isn't the run's own ("Mystical
 *  restarted 17:31 · this run kept going"): BootRow's look on the zone's spine,
 *  a refresh glyph for its node and a dashed rule to the row's end. */
function DividerRow({ text }: { text: string }) {
  return (
    <div role="note" className="zrow text-muted-2" style={{ ["--m" as string]: "var(--txm)" }}>
      <i className="ax-bar" aria-hidden><RotateCcw size={14} /></i>
      <span className="zo flex items-center gap-3">
        <span className="flex-none text-[length:var(--t10)] uppercase tracking-[2px]">{text}</span>
        <span aria-hidden className="flex-1 border-t border-dashed border-border" />
      </span>
    </div>
  );
}

/** A pause with nothing recorded but its length — a dashed stretch of the
 *  spine, the figure in the figure column. A full-width hairline read as a
 *  section break between things that were one stretch of work. A pause before
 *  a note isn't drawn here: the note wears it (renderEvent). */
function GapMark({ ms }: { ms: number }) {
  return (
    <div aria-hidden className="zrow gap">
      <i className="ax-bar" />
      <span className="ax-stat">{dur(ms)}</span>
    </div>
  );
}

/** What a fold's header says about the work under it: still going, how much
 *  of it failed, how long the lot took. */
type FoldStat = { running?: boolean; failed?: number; ms?: number };

/** A stretch of the model's work under one row — STEPS, what it ran, edited,
 *  read (see lib/segments). The prose and thoughts either side stay in the
 *  flow at full size; this is what makes them readable.
 *
 *  The row wears the thought row's chrome (`.thk`, `.thk-lab`, `.thk-peek`,
 *  `.thk-ms`): every language already draws that row its own way, and a fold
 *  is the same row said of more than one event. `data-kind` lets a language
 *  tell it from a thought where it wants to. The body is a SIBLING of the row,
 *  not a child — STAMP hatches the row's plate and SIGNAL pads it a gutter and
 *  a level cell to the right, and neither belongs on the rows inside.
 *
 *  Shut or open on mount is the reader's setting (HudSettings.foldsOpen); a
 *  change to it re-sets every mounted fold, and a click moves only that fold. */
function Fold({ label, icon, title, stat, defaultOpen, animate, children }: {
  label: string;
  icon: ReactNode;
  /** The fold's summary is the row's name. */
  title: string;
  stat: FoldStat;
  defaultOpen: boolean;
  animate: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => { setOpen(defaultOpen); }, [defaultOpen]);
  const what = label.toLowerCase();
  return (
    <div
      className="fold ml-[var(--rail)]"
      data-kind="steps"
      data-open={open ? "" : undefined}
      data-run={stat.running ? "" : undefined}
      data-err={stat.failed ? "" : undefined}
      style={animate ? { animation: "streamIn .34s cubic-bezier(.2,.8,.2,1) both" } : undefined}
    >
      <div className="thk text-muted-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          title={open ? `hide the ${what}` : `show the ${what}`}
          className="flex w-full items-center gap-2.5 py-0.5 text-left"
        >
          <span className="thk-lab flex flex-none items-center gap-1.5 text-[length:var(--t10)] tracking-[1.5px]">
            {icon}
            {label}
          </span>
          {title ? (
            <span className="thk-peek min-w-0 flex-1 truncate text-[length:var(--t11)]">
              {title}
            </span>
          ) : (
            <span aria-hidden className="h-px flex-1 bg-border" />
          )}
          <span className="thk-ms flex flex-none items-center gap-2 text-[length:var(--t95)] tracking-[1px]">
            {stat.failed ? <span className="fold-fail">{"\u2715"} {stat.failed} FAILED</span> : null}
            {stat.running ? <span className="fold-run">RUNNING</span> : slow(stat.ms) ? <span>{dur(stat.ms)}</span> : null}
          </span>
          <ChevronDown
            size={12}
            aria-hidden
            className={`flex-none transition-transform duration-200 ${open ? "" : "-rotate-90"}`}
          />
        </button>
      </div>
      {open ? <div className="fold-body space-y-2">{children}</div> : null}
    </div>
  );
}

/** One picture a zone holds: its upload path, the name its call gave it
 *  (lib/toolwidget shotName), and whether you have had it on screen yet. */
type Pic = { path: string; name: string; unseen: boolean };

/** A row arriving in a zone you open prints in from the line above it, with
 *  the phosphor flash new stream content wears (streamIn). */
const ROW_IN: Keyframe[] = [
  { opacity: 0, transform: "translateY(-5px)", filter: "brightness(1.75)" },
  { opacity: 1, transform: "none", filter: "none" },
];

/** DOSSIER's tier 3: everything a turn did between what you asked and what it
 *  answered, under one header (lib/dossier) — a plate with a ringed node, WORK
 *  and the figure on one line and the kind chips under it: the marks the rows
 *  inside wear on the spine, with a number; the old sentence is their tooltip.
 *  Pictures are the one result a header loses, so the shut plate shows every
 *  one of them in one row of equal tiles that scrolls sideways, tap one to
 *  open it. While any is unseen
 *  (lib/seenshots) the plate lights — accent border, edge and node, a solid NEW
 *  badge — and that picture wears the accent and a NEW tag in the row; seen,
 *  it goes grey and stays. Being on screen in the row does not count as seen
 *  (the badge would clear as you scrolled past); opening one does, as does
 *  paging to it in the lightbox (ImageLightbox marks the one on screen), and
 *  half a thumbnail in view once the zone is open. It follows the COLLAPSE
 *  STEPS switch like a STEPS fold does. The last zone of a running turn is
 *  live and hosts the working indicator: the ORBIT form is the plate itself —
 *  THINKING or WORKING with the seconds in that state where the figure was, a
 *  ripple in the node while the model thinks, a comet on its ring while a tool
 *  runs (both inside the node's track, since the turn row's paint containment
 *  clips anything past the plate), a caret on the step that is out — and every
 *  other form (STATUS, the cat) draws as a row inside the plate
 *  instead of under the turn. */
function WorkZone({ cats, notes, steps, failed, pics, gallery, state, since, hud, events, started, live, span, chapters, defaultOpen, animate, children }: {
  /** What the zone ran, by kind, and how often the agent spoke inside it. */
  cats: StepCat[];
  notes: number;
  /** Everything the zone holds, for the figure. */
  steps: number;
  failed: number;
  /** Pictures tools came back with, in order. */
  pics: Pic[];
  /** The zone's pictures, for the lightbox's paging. */
  gallery: Shown[];
  /** What the turn is doing right now, when this is its live zone. */
  state: "think" | "work" | null;
  /** When that state began, epoch seconds; the mount clock stands in. */
  since?: number;
  /** The indicator's form, and what the other forms read (lib/workstate). */
  hud?: HudSettings;
  events: TimedEvent[];
  started?: number;
  /** What is out right now, named after the chips while it runs. */
  live: string;
  /** Wall time the zone covered, already formatted; "" when unknown. */
  span: string;
  /** How many chapters a long zone opens on (WorkChapter); 0 for a list of rows. */
  chapters: number;
  defaultOpen: boolean;
  animate: boolean;
  /** The zone's rows, in order. */
  children: ReactNode[];
}) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => { setOpen(defaultOpen); }, [defaultOpen]);
  // Pinned: the sticky header (index.css) is holding at its top offset — at
  // rest it sits below that line, stuck it sits on it, and leaving with the
  // zone's end it rides above it. Measured on scroll, like Terminal's peek,
  // and against the offset as it is now: an IntersectionObserver's margin is
  // fixed at creation, and the offset moves when the island's LAST row opens.
  const head = useRef<HTMLButtonElement>(null);
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    const el = head.current, root = el?.closest(".mscroll");
    if (!open || !el || !root) { setPinned(false); return; }
    let raf = 0;
    const measure = () => {
      raf = 0;
      const r = el.getBoundingClientRect(), rootTop = root.getBoundingClientRect().top;
      setPinned(r.top - rootTop <= (parseFloat(getComputedStyle(el).top) || 0) + 0.5 && r.bottom > rootTop);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => { root.removeEventListener("scroll", onScroll); cancelAnimationFrame(raf); };
  }, [open]);
  // Shut from the pinned header, the shut line stays on the pin line, so it
  // keeps the pinned header's dress (index.css: VEIL's fade lifts, the pill's
  // chips hide) until a scroll moves it off.
  const [landed, setLanded] = useState(false);
  useEffect(() => {
    const el = head.current, root = el?.closest(".mscroll");
    if (!landed || !el || !root) return;
    const off = () => {
      const line = root.getBoundingClientRect().top + (parseFloat(getComputedStyle(root).getPropertyValue("--isle-b")) || 0);
      if (Math.abs(el.getBoundingClientRect().top - line) > 2) setLanded(false);
    };
    root.addEventListener("scroll", off, { passive: true });
    return () => root.removeEventListener("scroll", off);
  }, [landed]);
  // A toggle glides (index.css, THE FOLD): the box under the header runs from
  // the height it had to the height it gets while the part you leave keeps its
  // place, lifted out of the flow and fading, and opened rows print in from the
  // top. Measured rather than keyframed to `auto` (WebKit can't interpolate to
  // it), and from what is on screen: shut from the pinned header, the zone's
  // top is far above you. A click mid-glide starts from where the box is.
  const fold = useRef<HTMLDivElement>(null);
  const [motion, setMotion] = useState(false);
  // How many of the zone's rows are mounted. Opening, only those the glide can
  // show (a row is 28px or more, so this many fill the scroller under the
  // header), the rest once it has played out. Built whole in the click, a zone
  // of a thousand rows held it for most of a second, and the glide was over
  // before its first frame.
  // shortcut: the rest lands in one go: ~0.5s for 1300 rows in WebKit, but a
  // zone over 200 steps opens on its chapters (WorkChapter), so ~150 rows at
  // most now. A few rows a frame cost more in all, since each insertion
  // restyles the whole stream (in Chrome, the TABS composer's :has() rules);
  // revisit with those.
  const [cap, setCap] = useState(Infinity);
  const anims = useRef<Animation[]>([]);
  const toggle = (b: HTMLButtonElement) => {
    const f = fold.current, sc = b.closest<HTMLElement>(".mscroll");
    const y = b.getBoundingClientRect().top, was = f?.getBoundingClientRect();
    for (const a of anims.current) a.cancel();
    const mine: Animation[] = [];
    anims.current = mine;
    // WebKit starts an animation's clock before this task's work (the rows
    // built and laid out) is done, so a glide's first frame landed well into
    // it; each starts on the frame that first draws it.
    requestAnimationFrame(() => { if (anims.current === mine) for (const a of mine) a.startTime = document.timeline.currentTime; });
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    // The box keeps its height through the swap: a page that just lost a tall
    // zone would clamp its scroll before the glide began.
    if (f && was && !still) f.style.height = `${was.height}px`;
    const rows = Math.ceil(Math.max(0, (sc?.getBoundingClientRect().bottom ?? Infinity) + 40 - (was?.top ?? 0)) / 28);
    flushSync(() => { setOpen(!open); setMotion(!still); setLanded(open && pinned); if (!open) setCap(still || !was ? Infinity : rows); });
    // Folded from the pinned header, the shut line lands where the header
    // was (the ANSWER's FOLD does the same): a zone of a thousand pixels
    // collapsing above the viewport would otherwise drop you on whatever
    // sat below it.
    if (open && sc) sc.scrollTop += b.getBoundingClientRect().top - y;
    if (!f || !was) return;
    const run = (el: Element, k: Keyframe[], o: KeyframeAnimationOptions) => {
      const a = el.animate(k, o);
      anims.current.push(a);
      return a;
    };
    const now = f.getBoundingClientRect();
    const arriving = f.querySelector(":scope > :not([data-leaving], [hidden])");
    if (still) { if (arriving) run(arriving, [{ opacity: 0 }, { opacity: 1 }], { duration: 160 }); return; }
    // The part you left fades first and the arriving one after, so the two
    // barely overlap; shut, the rows drift up a little as they go.
    const leaving = f.querySelector<HTMLElement>(":scope > [data-leaving]");
    if (leaving) {
      leaving.style.top = `${was.top - now.top}px`;
      run(leaving, open ? [{ opacity: 1 }, { opacity: 0, transform: "translateY(-6px)" }] : [{ opacity: 1 }, { opacity: 0 }],
        { duration: open ? 130 : 90, easing: "ease-in", fill: "forwards" });
    }
    // Below the scroller's foot nothing shows, so the glide spends itself on what does.
    const foot = (sc?.getBoundingClientRect().bottom ?? Infinity) + 40 - now.top;
    const from = Math.max(0, Math.min(was.bottom - now.top, foot));
    const to = Math.min(arriving?.getBoundingClientRect().height ?? 0, foot);
    run(f, [{ height: `${from}px` }, { height: `${to}px` }], open
      ? { duration: 220, easing: "cubic-bezier(.4,0,.2,1)" }
      : { duration: 260, easing: "cubic-bezier(.2,.8,.2,1)" }).onfinish = () => setMotion(false);
    f.style.height = "";
    if (open) { if (arriving) run(arriving, [{ opacity: 0 }, { opacity: 1 }], { duration: 170, delay: 90, fill: "backwards" }); }
    else arriving?.querySelectorAll(":scope > .dwork-body > *").forEach((el, i) => {
      if (i < 24) run(el, ROW_IN, { duration: 240, delay: 40 + Math.min(i, 12) * 16, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" });
    });
    // after the rows' print-in too, so the long mount can't stall a fade on screen
    Promise.all(mine.map((a) => a.finished)).then(() => setCap(Infinity), () => {});
  };
  // The lightbox lives here, not in the row: opening a picture marks it seen,
  // and the row it was tapped in re-renders while you are still looking.
  const [zoom, setZoom] = useState<string | null>(null);
  const orbit = hud?.indicator === "orbit";
  // Seconds in the state, on the store's clock (the event's `at`) so the count
  // survives the zone remounting; ticks only while ORBIT draws it.
  const mountAt = useRef(Date.now() / 1000);
  const [now, setNow] = useState(mountAt.current);
  useEffect(() => {
    if (!state || !orbit) return;
    const tick = () => setNow(Date.now() / 1000);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [state, orbit, since]);
  const secs = Math.max(0, Math.floor(now - (since ?? mountAt.current)));
  // The step that is out is named once: after the chips while the plate is
  // shut, unless the hosted form already says it (STATUS does; the cat
  // doesn't) — and never while open, where the running row itself does.
  const namesStep = open || hud?.indicator === "status";
  // The other forms, hosted by the plate: shut, under the header; open, at the foot.
  const ind = state && !orbit ? (
    <div className="dwork-ind"><WorkingIndicator hud={hud} events={events} started={started} /></div>
  ) : null;
  const fresh = pics.filter((p) => p.unseen);
  const words = workTitle(stepsTitle(cats), notes);
  const picsWord = `${pics.length} picture${pics.length === 1 ? "" : "s"}`;
  return (
    <div
      className="dwork"
      data-open={open ? "" : undefined}
      data-pinned={pinned ? "" : undefined}
      data-landed={landed ? "" : undefined}
      data-live={state ?? undefined}
      data-ind={orbit ? "orbit" : undefined}
      data-err={failed ? "" : undefined}
      data-shots={fresh.length ? "new" : undefined}
      style={animate ? { animation: "streamIn .34s cubic-bezier(.2,.8,.2,1) both" } : undefined}
    >
      <button
        ref={head}
        type="button"
        onClick={(e) => toggle(e.currentTarget)}
        aria-expanded={open}
        title={open ? "hide the work" : "show the work"}
        className="dwork-head"
      >
        <span className="dwork-node" aria-hidden>
          <ChevronDown size={11} className={`transition-transform duration-200 ${open ? "" : "-rotate-90"}`} />
        </span>
        <span className="dwork-l1">
          <span className="dwork-lab">WORK</span>
          <span className="dwork-ms">
            {state && orbit ? (
              <>
                <b className="dwork-st">{state === "work" ? "WORKING" : "THINKING"}{state === "think" ? <i className="dwork-dots" aria-hidden /> : null}</b>
                <span className="dwork-secs">{secs}s</span>
              </>
            ) : [`${steps} step${steps === 1 ? "" : "s"}`, chapters ? `${chapters} chapters` : "", span].filter(Boolean).join(" · ")}
          </span>
        </span>
        <span className="dwork-l2">
          <span className="dwork-kinds" title={words} aria-label={words}>
            {kindsOf(cats, notes).map((k) => (
              <span key={k.m} className="dwork-k" data-m={k.m}><i aria-hidden><MarkIcon mark={k.m} size={10} /></i>{k.n}</span>
            ))}
          </span>
          {state === "work" && live && !namesStep ? <><span className="dwork-live">{live}</span>{orbit ? <i className="dwork-caret" aria-hidden /> : null}</> : null}
        </span>
        <span className="dwork-right">
          {failed ? <span className="dwork-k" data-m="fail" title={`${failed} failed`}><i aria-hidden><MarkIcon mark="fail" size={10} /></i>{failed}</span> : null}
          {fresh.length ? (
            <span className="dwork-badge" title={`${fresh.length} of ${picsWord} not seen yet`}>
              <ImageIcon size={11} strokeWidth={2.2} aria-hidden />{fresh.length} NEW
            </span>
          ) : pics.length ? (
            <span className="dwork-k" data-m="shot" title={picsWord}><i aria-hidden><ImageIcon size={10} strokeWidth={2.2} /></i>{pics.length}</span>
          ) : null}
        </span>
      </button>
      {zoom && <ImageLightbox src={zoom} all={gallery} onClose={() => setZoom(null)} />}
      {/* Mid-glide both parts are here, the one you left marked data-leaving.
          The shut part stays mounted while open, hidden: remounted on shutting,
          WebKit lays its lazy thumbnails out at no width and the glide aims short. */}
      <div ref={fold} className="dwork-fold" data-moving={motion ? "" : undefined}>
        {ind || pics.length ? (
          <div className="dwork-part" data-leaving={open && motion ? "" : undefined} hidden={open && !motion}>
            {!open ? ind : null}
            {pics.length ? <ShotRow pics={pics} shut={!open} label={picsWord} onOpen={setZoom} /> : null}
          </div>
        ) : null}
        {open || motion ? (
          <div className="dwork-part" data-leaving={open ? undefined : ""}>
            <div className="dwork-body">{children.slice(0, cap)}</div>
            {open ? ind : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** One chapter of a long WORK zone (lib/dossier chapterStarts): a line on the
 *  zone's spine (its number, when it began, the note it opens on, what failed,
 *  its pictures and size) over rows built only while it is open. That is what
 *  keeps a 1,600-step zone quick to open and to scroll, and the lines read as
 *  the zone's contents. Open, the line pins under the zone's header (index.css)
 *  so you know which part you are in. While the turn runs, its last chapter is
 *  live and opens by itself, and shuts when the next one takes over, unless you
 *  opened or shut it by hand. */
function WorkChapter({ n, at, title, steps, span, failed, pics, live, rows }: {
  n: number;
  /** When its first step landed, epoch seconds. */
  at?: number;
  title: string;
  steps: number;
  /** Wall time it covered, already formatted; "" when unknown. */
  span: string;
  failed: number;
  pics: number;
  live: boolean;
  /** Its rows, built when it opens. */
  rows: () => ReactNode[];
}) {
  const [open, setOpen] = useState(live);
  const byHand = useRef(false);
  useEffect(() => { if (!byHand.current) setOpen(live); }, [live]);
  const h12 = useClock12();
  const body = useRef<HTMLDivElement>(null);
  const toggle = (b: HTMLButtonElement) => {
    byHand.current = true;
    const sc = b.closest<HTMLElement>(".mscroll"), y = b.getBoundingClientRect().top;
    flushSync(() => setOpen(!open));
    // Shut from its pinned line, the line lands where it was, as the zone's does;
    // opened, its rows print in the way a zone's do.
    if (open) { if (sc) sc.scrollTop += b.getBoundingClientRect().top - y; return; }
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    Array.from(body.current?.children ?? []).slice(0, 12).forEach((el, i) =>
      el.animate(ROW_IN, { duration: 240, delay: 40 + i * 16, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" }));
  };
  const picsWord = `${pics} picture${pics === 1 ? "" : "s"}`;
  return (
    <div className="wzc" data-open={open ? "" : undefined} data-live={live ? "" : undefined}>
      <button type="button" className="wzc-head" onClick={(e) => toggle(e.currentTarget)} aria-expanded={open}
        title={open ? "hide this part of the work" : "show this part of the work"}>
        <span className="wzc-node" aria-hidden>{String(n).padStart(2, "0")}</span>
        <span className="wzc-obj">
          {at != null ? <span className="wzc-t">{hhmm(at, h12)}</span> : null}
          <span className="wzc-title">{title}</span>
        </span>
        <span className="wzc-fig">
          <span className="wzc-c">
            {failed ? <span className="dwork-k" data-m="fail" title={`${failed} failed`}><i aria-hidden><MarkIcon mark="fail" size={10} /></i>{failed}</span> : null}
          </span>
          <span className="wzc-c">
            {pics ? <span className="dwork-k" data-m="shot" title={picsWord}><i aria-hidden><ImageIcon size={10} strokeWidth={2.2} /></i>{pics}</span> : null}
          </span>
          <span className="wzc-n">{live ? <b>NOW</b> : [`${steps} step${steps === 1 ? "" : "s"}`, span].filter(Boolean).join(" · ")}</span>
        </span>
        <ChevronDown size={12} aria-hidden className={`wzc-chev transition-transform duration-200 ${open ? "" : "-rotate-90"}`} />
      </button>
      {open ? <div ref={body} className="wzc-body">{rows()}</div> : null}
    </div>
  );
}

/** DOSSIER: a piece of the agent's words with the work it led to (lib/dossier
 *  stretchesOf). An open zone reads as the words: what ran after them rides at
 *  the end of their last line as a tally (the header's kind chips on a pill, a
 *  failure in red) and opens under them, built only while open, like a
 *  chapter. In a recent zone half the stretches are one call, so a row of
 *  their own would only trade one row for another. The pictures the work came
 *  back with never fold: they sit under the words, one row of tiles. The
 *  working stretch of a live zone stays open and folds into its tally once the
 *  next words land, unless you opened or shut it by hand; COLLAPSE STEPS off
 *  mounts every stretch open. Work with no words before it gets a row of its own. */
function WorkStretch({ words, cats, failed, live, defaultOpen, pics, rows }: {
  /** The words, wearing the tally they're given; null draws the tally on a row of its own. */
  words: ((tally: ReactNode) => ReactNode) | null;
  /** What the work ran, by kind, and how much of it failed. None: words alone. */
  cats: StepCat[];
  failed: number;
  /** The working stretch of a live zone. */
  live: boolean;
  defaultOpen: boolean;
  /** The pictures the work came back with, each call's own gallery. */
  pics: ReactNode[];
  /** The work's rows, built when it opens. */
  rows: () => ReactNode[];
}) {
  const [open, setOpen] = useState(defaultOpen || live);
  const byHand = useRef(false);
  useEffect(() => { if (!byHand.current) setOpen(defaultOpen || live); }, [defaultOpen, live]);
  const body = useRef<HTMLDivElement>(null);
  const toggle = () => {
    byHand.current = true;
    flushSync(() => setOpen(!open));
    // opened, its rows print in the way a zone's do
    if (open || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    Array.from(body.current?.children ?? []).slice(0, 12).forEach((el, i) =>
      el.animate(ROW_IN, { duration: 240, delay: 40 + i * 16, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" }));
  };
  const what = [stepsTitle(cats), failed ? `${failed} failed` : ""].filter(Boolean).join(" · ");
  const tally = cats.length ? (
    <button type="button" className="wtally" onClick={toggle} aria-expanded={open} aria-label={what}
      title={`${what} · ${open ? "hide" : "show"} the steps`}
      data-err={failed ? "" : undefined} data-live={live ? "" : undefined}>
      {kindsOf(cats, 0).map((k) => (
        <span key={k.m} className="dwork-k" data-m={k.m}><i aria-hidden><MarkIcon mark={k.m} size={10} /></i>{k.n}</span>
      ))}
      {failed ? <span className="dwork-k" data-m="fail"><i aria-hidden><MarkIcon mark="fail" size={10} /></i>{failed}</span> : null}
      <ChevronDown size={10} strokeWidth={2.4} aria-hidden className="wtally-chev" />
    </button>
  ) : null;
  return (
    <>
      {words ? words(tally) : tally ? <div className="zrow wlead"><i className="ax-bar" aria-hidden /><span className="zo">{tally}</span></div> : null}
      {pics.length ? <div className="wstrip">{pics}</div> : null}
      {open && tally ? <div ref={body} className="wbody">{rows()}</div> : null}
    </>
  );
}

/** The shut plate's pictures, one row of equal tiles (index.css .dwork-row).
 *  It opens on the newest and glides to each picture that lands, even when you
 *  had scrolled back. A side holding pictures out of view fades under their
 *  count, which wears the accent while one of them is unseen; a tap pages that way.
 *  A mouse drags it sideways, and let go while moving it flies on, slowing. */
function ShotRow({ pics, shut, label, onOpen }: {
  pics: Pic[];
  /** The zone is shut, so the row is the part on screen. */
  shut: boolean;
  label: string;
  onOpen: (src: string) => void;
}) {
  const row = useRef<HTMLDivElement>(null);
  // Tiles out of view on each side: a tile is once its middle is in the faint
  // half of the edge's 64px fade (index.css). Hidden while open, so not measured.
  const [edge, setEdge] = useState({ l: 0, r: 0 });
  const measure = () => {
    const el = row.current;
    if (!el?.clientWidth) return;
    const from = el.scrollLeft + 32, to = el.scrollLeft + el.clientWidth - 32;
    let l = 0, r = 0;
    for (const f of Array.from(el.children) as HTMLElement[]) {
      const mid = f.offsetLeft + f.offsetWidth / 2;
      if (mid < from) l++;
      else if (mid > to) r++;
    }
    setEdge((o) => (o.l === l && o.r === r ? o : { l, r }));
  };
  // One glide moves the row for the wheel, a fling, a pill and a picture
  // landing, so a wheel notch eases over instead of jumping 40px: it closes on
  // its goal, most of the way in about `tau` ms, and a new aim moves the goal.
  const g = useRef({ goal: 0, pos: 0, t: 0, tau: 120, raf: 0 });
  const stop = () => { cancelAnimationFrame(g.current.raf); g.current.raf = 0; };
  const aim = () => (g.current.raf ? g.current.goal : row.current?.scrollLeft ?? 0);
  const glide = (left: number, tau = 120) => {
    const el = row.current, s = g.current;
    if (!el) return;
    s.goal = Math.max(0, Math.min(left, el.scrollWidth - el.clientWidth));
    s.tau = tau;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { stop(); el.scrollLeft = s.goal; return; }
    if (s.raf) return;
    s.pos = el.scrollLeft;
    s.t = performance.now();
    const step = (now: number) => {
      s.pos += (s.goal - s.pos) * (1 - Math.exp(-Math.max(0, now - s.t) / s.tau));
      s.t = now;
      const done = Math.abs(s.goal - s.pos) < 0.5;
      el.scrollLeft = done ? s.goal : s.pos;
      s.raf = done ? 0 : requestAnimationFrame(step);
    };
    s.raf = requestAnimationFrame(step);
  };
  // Drawn (mounted, or the zone shut again) it jumps to its end; a picture
  // landing while it shows glides it there.
  const was = useRef({ n: 0, shut: false });
  useLayoutEffect(() => {
    const el = row.current, w = was.current;
    was.current = { n: pics.length, shut };
    if (!el || !shut) return;
    if (w.shut && pics.length > w.n) glide(el.scrollWidth);
    else { stop(); el.scrollLeft = el.scrollWidth; }
    measure();
  }, [pics.length, shut]);
  useEffect(() => {
    const el = row.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; measure(); }); };
    // A vertical wheel moves the row while it has room that way, and at either
    // end goes on to the transcript. By hand: React's wheel listener is passive.
    const onWheel = (e: WheelEvent) => {
      // a sideways swipe scrolls it natively
      if (e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) { stop(); return; }
      const at = aim();
      if (e.deltaY < 0 ? at <= 0 : at >= el.scrollWidth - el.clientWidth - 1) return;
      e.preventDefault();
      glide(at + e.deltaY * (e.deltaMode === 1 ? 16 : 1));
    };
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
      stop();
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
    };
  }, []);
  // A mouse drags the row: a press that moves 5px is a drag, not a tap, and
  // the click its release makes opens nothing. Touch and pens pan it natively.
  const drag = useRef<{ id: number; x: number; left: number; t: number; v: number } | null>(null);
  const dragged = useRef(false);
  const [grabbing, setGrabbing] = useState(false);
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    // the scrollbar under the tiles keeps its own drag
    if (e.pointerType !== "mouse" || e.button !== 0 || e.clientY > el.getBoundingClientRect().top + el.clientTop + el.clientHeight) return;
    stop();
    dragged.current = false;
    drag.current = { id: e.pointerId, x: e.clientX, left: el.scrollLeft, t: e.timeStamp, v: 0 };
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current, el = e.currentTarget;
    if (d?.id !== e.pointerId) return;
    if (!dragged.current) {
      if (Math.abs(e.clientX - d.x) < 5) return;
      dragged.current = true;
      el.setPointerCapture(e.pointerId);
      setGrabbing(true);
    }
    stop();
    const from = el.scrollLeft;
    el.scrollLeft = d.left - (e.clientX - d.x);
    // its speed in px/ms, smoothed over the last few moves, for the fling
    if (e.timeStamp > d.t) d.v = 0.7 * ((el.scrollLeft - from) / (e.timeStamp - d.t)) + 0.3 * d.v;
    d.t = e.timeStamp;
  };
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d?.id !== e.pointerId) return;
    drag.current = null;
    if (!dragged.current) return;
    setGrabbing(false);
    setTimeout(() => { dragged.current = false; });
    // Let go while moving, it flies on, slowing: starting at the hand's speed,
    // it covers speed × tau. Reduced motion stops where you let go.
    if (e.type === "pointerup" && e.timeStamp - d.t < 60 && !matchMedia("(prefers-reduced-motion: reduce)").matches)
      glide(e.currentTarget.scrollLeft + d.v * 325, 325);
  };
  const more = (side: "l" | "r") => {
    const n = edge[side];
    if (!n) return null;
    const fresh = (side === "l" ? pics.slice(0, n) : pics.slice(-n)).filter((p) => p.unseen).length;
    const words = `${n} more picture${n === 1 ? "" : "s"} to the ${side === "l" ? "left" : "right"}${fresh ? `, ${fresh} not seen yet` : ""}`;
    // A rowful, less one tile (96px and its 10px gap), so you keep your place.
    const page = () => glide(aim() + (side === "l" ? -1 : 1) * ((row.current?.clientWidth ?? 0) - 106));
    return (
      <button type="button" className="dwork-more" data-side={side} data-lit={fresh ? "" : undefined} onClick={page} title={words} aria-label={words}>
        {side === "l" ? <><ChevronLeft size={11} strokeWidth={2.4} aria-hidden />{n}</> : <>{n}<ChevronRight size={11} strokeWidth={2.4} aria-hidden /></>}
      </button>
    );
  };
  return (
    <div className="dwork-row">
      <div ref={row} className="dwork-row-thumbs" role="group" aria-label={label} data-drag={grabbing ? "" : undefined}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onLostPointerCapture={onUp}
        onClickCapture={(e) => { if (dragged.current) { e.stopPropagation(); e.preventDefault(); } }}
        onDragStart={(e) => e.preventDefault()}>
        {pics.map((p) => {
          const src = api.attachmentUrl(p.path);
          return (
            <figure key={p.path} data-new={p.unseen ? "" : undefined}>
              <ZoomButton onOpen={() => onOpen(src)}>
                {/* A picture the upload dir has pruned can't be seen: marking it
                    seen is what clears the badge it would otherwise hold lit. */}
                <MediaThumb src={src} alt={p.name} onError={() => markShotSeen(p.path)} />
              </ZoomButton>
              <figcaption>{p.name}</figcaption>
            </figure>
          );
        })}
      </div>
      {more("l")}
      {more("r")}
    </div>
  );
}

/** A thought, in the flow where it was said (lib/segments) — the agent's own
 *  status line, often a message the CLI handed back reworded. A row on the
 *  zone's grid with the whole text in it, italic, one ink tier under a note. */
function ThoughtRow({ ms, pause, text, animate, onOpenFile, toolStyle, tail }: {
  ms?: number;
  /** The pause right before it (RunStream pauseAt), worn as its figure. */
  pause?: number;
  text: string;
  animate: boolean;
  onOpenFile?: OpenFile;
  toolStyle?: ToolStyle;
  /** Worn after the last word (DOSSIER: the tally of the work it led to, WorkStretch). */
  tail?: ReactNode;
}) {
  return (
    <div
      className="zrow thought"
      data-pause={pause ? "" : undefined}
      style={animate ? { animation: "streamIn .34s cubic-bezier(.2,.8,.2,1) both" } : undefined}
    >
      <i className="ax-bar" aria-hidden />
      <span className="ax-tagcell"><span className="ax-tag">THINK</span></span>
      {tail ? (
        <div className="zo zo-tail">
          <Markdown className="thought-text" onOpenFile={onOpenFile} toolStyle={toolStyle}>{text}</Markdown><span className="wsp"> </span>{tail}
        </div>
      ) : <Markdown className="thought-text zo" onOpenFile={onOpenFile} toolStyle={toolStyle}>{text}</Markdown>}
      <span className="ax-stat" title={pause ? `${dur(pause)} before this thought` : undefined}>
        {slow(ms) ? dur(ms) : pause ? dur(pause) : null}
      </span>
    </div>
  );
}

/** A hook's output, or a line the child wrote to stderr: the work either side of
 *  the conversation, which used to be visible only when a run died. Shut by
 *  default past the first line — most of it is one line and says everything.
 *  A hook that ran clean only injected context (ponytail's preamble, the same
 *  every turn), so shut it is its icon on the spine alone, its first line the
 *  tooltip and all of it a tap away; one that failed or blocked keeps its words. */
function LogRow({ src, label, text, error, animate }:
  { src: string; label?: string; text: string; error?: boolean; animate: boolean }) {
  const [open, setOpen] = useState(false);
  const lines = text.split("\n");
  const more = lines.length - 1;
  const quiet = src === "hook" && !error;
  const opens = more > 0 || quiet;
  return (
    <button
      type="button"
      onClick={() => opens && setOpen((o) => !o)}
      aria-expanded={opens ? open : undefined}
      className="zrow log"
      data-err={error ? "" : undefined}
      data-quiet={quiet && !open ? "" : undefined}
      title={quiet && !open ? `${label ? `${label} · ` : ""}${lines[0]}`
        : more ? (open ? "hide the rest" : `show ${more} more line${more > 1 ? "s" : ""}`) : undefined}
      style={animate ? { animation: "streamIn .34s cubic-bezier(.2,.8,.2,1) both" } : undefined}
    >
      <i className="ax-bar" aria-hidden><MarkIcon mark={error ? "fail" : src === "hook" ? "hook" : "log"} /></i>
      <span className="ax-tagcell"><span className="ax-tag">{src.toUpperCase()}</span></span>
      <span className="zo">
        {label ? <span className="text-muted-2">{label} · </span> : null}
        {open ? text : lines[0]}
      </span>
      <span className="ax-stat">{more && !open ? `+${more} lines` : null}</span>
      <span className="ax-chev">
        {more ? <ChevronDown size={12} aria-hidden className={`transition-transform duration-200 ${open ? "" : "-rotate-90"}`} /> : null}
      </span>
    </button>
  );
}

/** One thing the model did, as a row of the ledger: a bar in the tool's accent,
 *  a tag wearing that kind's shape, what it acted on, what came back — and, when
 *  there is a payload worth reading, a drawer that opens under it in place.
 *
 *  The row replaces the nine bordered cards this file used to draw. Those cards
 *  each had their own frame, their own left edge and their own height, and a
 *  turn of seven of them read as seven grey slabs: the shapes told them apart
 *  only once you stopped to look. So the frames went and the shapes moved onto
 *  the tag, whose cell is a fixed width for every kind — alignment from the
 *  cell, character from what's drawn inside it.
 *
 *  `drawer` is a thunk: a shut row must not build a body it isn't showing, and
 *  most rows in a long turn are shut. */
/** A row telling the rest of its block to match it. Shift-click is one gesture
 *  for "open all of these", and a block is exactly a run of adjacent rows in the
 *  DOM — so the rows talk to each other through it rather than through a context
 *  that would have to know what a block is. */
const BULK = "ax-bulk";

function ActionRow({
  tier,
  shape,
  accent,
  tag,
  mark,
  stat,
  drawer,
  animate,
  running,
  error,
  t,
  startOpen = false,
  children,
}: {
  tier: Tier;
  shape?: Shape;
  accent: string;
  /** Turn-relative clock, already formatted. Only SIGNAL LOG draws it (its
   *  gutter is `content: attr(data-t)`); every other language ignores it. */
  t?: string;
  /** Omitted inside a terminal window — its header already said BASH. */
  tag?: string;
  /** The icon this row wears on the WORK zone's spine (MARK_ICON); a failure
   *  wears the fail mark instead. Unset for a run's members: they are small
   *  dots on the spine under the run's head. */
  mark?: Mark;
  stat?: ReactNode;
  drawer?: () => ReactNode;
  animate: boolean;
  running?: boolean;
  error?: boolean;
  startOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(startOpen);
  const ref = useRef<HTMLDivElement>(null);
  const hasDrawer = !!drawer;

  useEffect(() => {
    const el = ref.current;
    if (!el || !hasDrawer) return;
    const on = (e: Event) => setOpen((e as CustomEvent<boolean>).detail);
    el.addEventListener(BULK, on);
    return () => el.removeEventListener(BULK, on);
  }, [hasDrawer]);

  const toggle = hasDrawer
    ? (e?: React.MouseEvent | React.KeyboardEvent) => {
        const next = !open;
        setOpen(next);
        // Shift takes the block with it. A drawer exists to save you opening
        // rows one at a time; on a turn that ran nine commands, doing it nine
        // times is the thing it was meant to spare you.
        if (!e?.shiftKey || !ref.current) return;
        for (const dir of ["previousElementSibling", "nextElementSibling"] as const) {
          let n = ref.current[dir];
          while (n instanceof HTMLElement &&
                 (n.classList.contains("actrow") || n.classList.contains("ax-drawer"))) {
            if (n.classList.contains("actrow"))
              n.dispatchEvent(new CustomEvent(BULK, { detail: next }));
            n = n[dir];
          }
        }
      }
    : undefined;
  return (
    <>
      <div
        ref={ref}
        className="actrow group/act"
        data-t={t}
        data-tier={tier}
        data-err={error ? "" : undefined}
        data-run={running ? "" : undefined}
        style={{
          ...({ "--h": accent } as React.CSSProperties),
          ...(animate ? { animation: "streamIn .34s cubic-bezier(.2,.8,.2,1) both" } : {}),
        }}
        role={toggle ? "button" : undefined}
        tabIndex={toggle ? 0 : undefined}
        aria-expanded={toggle ? open : undefined}
        title={hasDrawer ? "click to open · shift-click for the whole block" : undefined}
        onClick={toggle}
        onKeyDown={
          toggle &&
          ((e: React.KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggle(e);
            }
          })
        }
      >
        <i className="ax-bar" aria-hidden>{mark ? <MarkIcon mark={error ? "fail" : mark} /> : null}</i>
        <span className="ax-tagcell">
          {tag !== undefined && (
            <span className="ax-tag" data-shape={shape}>
              <span className="ax-tagtext">{tag}</span>
            </span>
          )}
        </span>
        <span className="ax-obj">{children}</span>
        <span className="ax-stat">{stat}</span>
        <span className="ax-chev">
          {drawer && (
            <ChevronDown
              size={12}
              aria-hidden
              className={`transition-transform duration-200 ${open ? "" : "-rotate-90"}`}
            />
          )}
        </span>
      </div>
      {open && drawer ? <div className="ax-drawer">{drawer()}</div> : null}
    </>
  );
}

/** The head of a drawer: the exact thing that ran, and the two things you might
 *  want to do with it. Selectable — the row above it is a button, this isn't. */
function DrawerHead({
  mark,
  text,
  onRerun,
  children,
}: {
  mark: string;
  text: string;
  onRerun?: () => void;
  children?: ReactNode;
}) {
  return (
    <div
      className="flex items-start gap-2 break-all pb-1.5 text-[var(--txm)]"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="flex-none text-[var(--txg)]" aria-hidden>{mark}</span>
      <span className="min-w-0 flex-1">{children ?? text}</span>
      <span className="ml-auto flex flex-none gap-2">
        <CopyBtn text={text} title="copy" />
        {onRerun && (
          <HeadBtn title="run this again in a terminal" onClick={onRerun}>
            <RotateCw size={12} aria-hidden />
          </HeadBtn>
        )}
      </span>
    </div>
  );
}

/** The body of a drawer that is just text — output, a response, a brief. */
function DrawerText({ text, error }: { text: string; error?: boolean }) {
  return (
    <pre
      className="max-h-[180px] overflow-auto whitespace-pre-wrap break-all border-l pl-2.5 leading-[1.55]"
      style={{
        color: error ? "var(--err)" : "var(--txd)",
        borderColor: error ? "color-mix(in srgb, var(--err) 30%, transparent)" : "var(--ac-08)",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {text}
    </pre>
  );
}

/** The foot of a drawer: the numbers, in the HUD's own voice. */
function DrawerFoot({ children }: { children: ReactNode }) {
  return (
    <div className="mt-1.5 flex gap-3.5 font-[family-name:var(--font-display)] text-[length:var(--t95)] uppercase tracking-[1.5px] text-[var(--txf)]">
      {children}
    </div>
  );
}

/** A read only looked at a page, so it is the quietest row there is. */
function ReadCard({ path, ms, stat, error, animate, t }:
  { path: string; ms?: number; stat?: string; error?: boolean; animate: boolean; t?: string }) {
  return (
    <ActionRow
          t={t}
      tier="glance"
      shape={toolShape("Read")}
      accent={toolAccent("Read")}
      tag="READ"
      mark="read"
      animate={animate}
      error={error}
      stat={<Took ms={ms} stat={stat} error={error} />}
    >
      <FilePath path={path} />
    </ActionRow>
  );
}

/** A write is filled in — dark text on solid hue, the loudest a tag gets —
 *  because something on disk is different now. */
function WriteCard({ name, path, ms, stat, error, animate, t }: {
  name: string; path: string; ms?: number; stat?: string; error?: boolean; animate: boolean;
  t?: string;
}) {
  return (
    <ActionRow
          t={t}
      tier="mark"
      shape={toolShape(name)}
      accent={toolAccent(name)}
      tag={kindTag(name)}
      mark={name === "Write" ? "write" : "edit"}
      animate={animate}
      error={error}
      stat={<Took ms={ms} stat={stat} error={error} />}
    >
      <FilePath path={path} />
    </ActionRow>
  );
}

/** A lookup is a query as entered: the pattern sits in its own dashed inset,
 *  because nothing here is committed yet. */
function SearchCard({ name, summary, ms, stat, error, animate, t }: {
  name: string; summary: string; ms?: number; stat?: string; error?: boolean; animate: boolean;
  t?: string;
}) {
  return (
    <ActionRow
          t={t}
      tier="glance"
      shape={toolShape(name)}
      accent={toolAccent(name)}
      tag={kindTag(name)}
      mark="search"
      animate={animate}
      error={error}
      stat={<Took ms={ms} stat={stat} error={error} />}
    >
      <span className="ax-q">{summary}</span>
      {/* the search icon is Grep's too, and "select:…" alone says nothing */}
      {name === "ToolSearch" ? <span className="ax-hint">tool search</span> : null}
    </ActionRow>
  );
}

/** The one round tag in a square UI, because the web is not this machine: the
 *  host reads bright, the rest of the URL dims behind it. */
function WebCard({ name, summary, ms, stat, error, animate, t }: {
  name: string; summary: string; ms?: number; stat?: string; error?: boolean; animate: boolean;
  t?: string;
}) {
  const host = hostOf(summary);
  return (
    <ActionRow
          t={t}
      tier="reach"
      shape={toolShape(name)}
      accent={toolAccent(name)}
      tag={kindTag(name)}
      mark="fetch"
      animate={animate}
      error={error}
      // Round at both ends: the tag and what came back. There is no status code
      // to show — the stream carries a size, not a response — so the pill holds
      // the real figure rather than a fabricated 200.
      stat={
        stat && !error
          ? <><span className="ax-pill">{stat}</span>{slow(ms) ? <span>{dur(ms)}</span> : null}</>
          : <Took ms={ms} stat={stat} error={error} />
      }
    >
      {host ? (
        <>
          <span className="text-foreground-bright">{host}</span>
          <span className="text-muted-2">{summary.slice(summary.indexOf(host) + host.length)}</span>
        </>
      ) : (
        <span className="ax-q">{summary}</span>
      )}
    </ActionRow>
  );
}

/** A call out of this process and into another one: the server, then the tool
 *  it reached — "get task" alone never said which task, so what it was called
 *  with follows. The tag says MCP for every server, so the server leads the
 *  object; as a tag it ran past the cell (PLAYWRIGHT, CLOUDFLARE). */
function McpCard({ name, summary, ms, stat, error, animate, t }: {
  name: string; summary: string; ms?: number; stat?: string; error?: boolean; animate: boolean;
  t?: string;
}) {
  const { tool } = mcpParts(name);
  return (
    <ActionRow
          t={t}
      tier="reach"
      shape={toolShape(name)}
      accent={toolAccent(name)}
      tag="MCP"
      mark="call"
      animate={animate}
      error={error}
      stat={<Took ms={ms} stat={stat} error={error} />}
    >
      <span className="text-muted-2">{toolTag(name).toLowerCase()} · </span>
      <span className="text-foreground-bright">{tool}</span>
      {summary ? <span className="text-muted-2">{` · ${summary}`}</span> : null}
    </ActionRow>
  );
}

/** What a delegated run knows about itself past its brief: which agent took the
 *  work, and the short name the caller gave the job. Both are absent on turns
 *  recorded before the bridge carried them (bridge/transcript_jsonl.agent_meta),
 *  so every part of the header is optional — the frame is not. */
type AgentMeta = { type?: string; title?: string };

/** One delegation, as the block draws it. */
type AgentRun = {
  name: string; summary: string; meta?: AgentMeta;
  ms?: number; stat?: string; error?: boolean; running?: boolean;
  /** The Agent call's tool_use id — how the roster (lib/subagents) finds it. */
  id?: string;
};

/** The hue a delegation wears: teal for an agent, violet for a skill (the
 *  model's own kit, and violet is already the model's colour), salmon when it
 *  failed. */
function agentHue({ name, error }: { name: string; error?: boolean }): string {
  if (error) return "var(--err)";
  return name === "Skill" ? "var(--purple)" : toolAccent(name);
}

/** How long a run has been out. Mounted only on a turn streaming into this
 *  session, so mount time is when the call started.
 *  ponytail: reopening a session mid-run restarts the count — a tool event
 *  carries no timestamp. Stamp one on the event if the figure ever has to
 *  survive a reload. */
function LiveClock() {
  const [t0] = useState(() => Date.now());
  const [s, setS] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setS(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, [t0]);
  return <span className="agb-live">{Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}</span>;
}

/** While a run is out there is nothing true to print but that it is out, and for
 *  how long — the tool count and the token spend do not exist until it returns.
 *  The clock only runs on a turn streaming live; on a reopened one it would be
 *  counting from when you scrolled to it. */
function agentNums(r: AgentRun, animate: boolean): ReactNode {
  if (r.running)
    return <><span style={{ color: "var(--h)" }}>WORKING</span>{animate ? <LiveClock /> : null}</>;
  return (
    <>
      {r.error ? <span style={{ color: "var(--err)" }}>FAILED</span> : null}
      {r.stat && !r.error ? <b>{r.stat}</b> : null}
      {slow(r.ms) ? <span>{dur(r.ms)}</span> : null}
    </>
  );
}

/** A run's figure once the roster knows its agent: what the agent did and
 *  whether it is still at it, which a background agent's own call can't say
 *  (its tool_result is the launch receipt, "6 lines"), and open ↗ into the
 *  AGENTS modal. A skill, a failed call, or an agent the roster doesn't know
 *  keeps what the call said. */
function AgentStat({ run, children }: { run: AgentRun; children: ReactNode }) {
  const a = useAgentFor(run.id);
  if (!a || run.error) return <>{children}</>;
  return (
    <>
      {a.status === "running" ? <span style={{ color: "var(--h)" }}>WORKING</span>
        : <span>{fmtSpan(a.updated_at - a.started_at)}</span>}
      {a.tools ? <b>{a.tools} tools</b> : null}
      <button type="button" className="agb-open" title="open this agent's run"
        onClick={(e) => { e.stopPropagation(); openAgent(a.agent_id); }}>open ↗</button>
    </>
  );
}

/** A delegated run is not a step of your turn but a turn nested inside it —
 *  its own tool calls, its own minutes, its own report — so its row sits on a
 *  plate with the brief under it, two lines shut and all of it on a click. The
 *  agent that took the work leads the object ("AGENT" alone was the same word
 *  for a one-file lookup and a four-minute fan-out). A skill only loaded a kit,
 *  so it is a plain row: the kit's name, and no brief to plate. */
function AgentBlock({ run, animate }: { run: AgentRun; animate: boolean }) {
  const [open, setOpen] = useState(false);
  const { name, summary, meta, stat, error, running } = run;
  const skill = name === "Skill";
  const title = meta?.title ?? "";
  const brief = skill ? "" : summary;
  return (
    <div
      className="agb"
      data-plate={brief ? "" : undefined}
      data-open={open ? "" : undefined}
      style={animate ? { animation: "streamIn .34s cubic-bezier(.2,.8,.2,1) both" } : undefined}
    >
      <ActionRow tier="reach" mark={skill ? "skill" : "agent"} accent={agentHue(run)} tag={skill ? "SKILL" : "AGENT"}
        running={running} error={error} animate={false} stat={<AgentStat run={run}>{agentNums(run, animate)}</AgentStat>}>
        <span className="text-foreground-bright">{meta?.type || (skill ? summary : "agent")}</span>
        {title ? <span className="text-muted-2">{` \u2014 ${title}`}</span> : null}
        {skill ? <span className="ax-hint">skill</span> : null}
      </ActionRow>
      {brief ? (
        <button type="button" className="agb-brief" onClick={() => setOpen((o) => !o)}
          title={open ? "clip the brief" : "the whole brief"}>
          <span>{brief}</span>
        </button>
      ) : null}
      {/* The reason belongs to this run, so it sits on its plate, not under it. */}
      {error && stat ? <div className="agb-err">{stat}</div> : null}
    </div>
  );
}

/** A run of delegations, drawn the way any run is: a head row, and a member per
 *  agent hanging off it. It says how many ran, not that they ran at once — the
 *  event stream can't tell a fan-out from four in a row. No clock per member:
 *  one interval per row to say what the head's own clock already says. */
function AgentFan({ runs, animate }: { runs: AgentRun[]; animate: boolean }) {
  const live = runs.filter((r) => r.running).length;
  const total = runs.reduce((t, r) => t + (r.ms ?? 0), 0);
  return (
    <div
      className="ax-window"
      style={animate ? { animation: "streamIn .34s cubic-bezier(.2,.8,.2,1) both" } : undefined}
    >
      <ActionRow tier="reach" mark="agent" accent="var(--acc)" tag="AGENTS" running={!!live} animate={false}
        stat={live
          ? <><span style={{ color: "var(--h)" }}>{live} WORKING</span>{animate ? <LiveClock /> : null}</>
          : slow(total) ? <span>{dur(total)}</span> : null}>
        {runs.length} runs
      </ActionRow>
      {runs.map((r, k) => {
        const said = r.meta?.title || r.summary;
        const done = r.stat || slow(r.ms);
        return (
          <ActionRow key={k} tier="reach" accent={agentHue(r)} running={r.running} error={r.error} animate={false}
            stat={<AgentStat run={r}>{r.error ? <span style={{ color: "var(--err)" }}>FAILED</span>
              : r.running ? <span style={{ color: "var(--h)" }}>WORKING</span>
              : done ? <span>{done}</span> : null}</AgentStat>}>
            <span className="text-foreground-bright">{r.meta?.type || (r.name === "Skill" ? "skill" : "agent")}</span>
            {said ? <span className="text-muted-2">{` \u2014 ${said}`}</span> : null}
          </ActionRow>
        );
      })}
    </div>
  );
}

/** Thumbnails for images a tool returned, clickable into the lightbox the
 *  transcript already uses for prompt attachments; `all` is the turn's whole
 *  set, so the lightbox pages past this row. The upload dir is pruned by age,
 *  so an old turn's screenshot 404s — that row just disappears rather than
 *  leaving a broken-image glyph. */
/** `at` is the call's clock: with it a thumbnail knows whether you have seen it
 *  (lib/seenshots) and wears the accent until you have. Your own steer's
 *  pictures pass none — you sent them. */
function ToolImages({ paths, all, at }: { paths: string[]; all: Shown[]; at?: number }) {
  const [zoom, setZoom] = useState<string | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const live = paths.filter((p) => !gone.has(p));
  if (!live.length) return null;
  return (
    <div className="zx mt-2 ml-[var(--rail)] flex flex-wrap gap-2">
      {zoom && <ImageLightbox src={zoom} all={all} onClose={() => setZoom(null)} />}
      {live.map((p) => {
        const src = api.attachmentUrl(p);
        return (
          <ZoomButton key={p} onOpen={() => setZoom(src)}>
            <MediaThumb
              src={src}
              alt="tool output"
              onError={() => setGone((g) => new Set(g).add(p))}
              onSeen={() => markShotSeen(p)}
              fresh={shotUnseen(p, at)}
              className="h-24 w-auto max-w-[240px] border border-border object-cover"
            />
          </ZoomButton>
        );
      })}
    </div>
  );
}

/** What one call says inside a CallGroup — the header already carries the server
 *  or the kind, so the row is only what this call reached for. */
function callLine(name: string, summary: string): string {
  if (toolKind(name) !== "mcp") return hostOf(summary) || summary;
  const { tool } = mcpParts(name);
  return summary ? `${tool} · ${summary}` : tool;
}

/** A run of back-to-back calls of one kind, drawn the way a run of commands is:
 *  one window, the tag once in its header, a row per call. Eight MCP calls used
 *  to say the server's name eight times. */
function CallGroup({
  name,
  calls,
  animate,
}: {
  name: string;
  calls: { name: string; summary: string; ms?: number; stat?: string; error?: boolean }[];
  animate: boolean;
}) {
  const kind = toolKind(name);
  const accent = toolAccent(name);
  const tag = kind === "mcp" ? "MCP" : kind === "plain" ? "TOOL" : kind.toUpperCase();
  const total = calls.reduce((t, c) => t + (c.ms ?? 0), 0);
  const failed = calls.some((c) => c.error);

  return (
    <div
      className="ax-window"
      data-err={failed ? "" : undefined}
      style={{
        ...({ "--h": accent } as React.CSSProperties),
        ...(animate ? { animation: "streamIn .34s cubic-bezier(.2,.8,.2,1) both" } : {}),
      }}
    >
      <ActionRow tier="reach" mark={kindMark(name)} accent={accent} tag={tag} animate={false}
        stat={slow(total) ? <span>{dur(total)}</span> : null}>
        {kind === "mcp" ? toolTag(name).toLowerCase() : kind === "plain" ? name : null}
        <span className="text-muted-2">{kind === "mcp" || kind === "plain" ? " · " : ""}{calls.length} calls</span>
      </ActionRow>
      {calls.map((c, k) => (
        <ActionRow
          key={k}
          tier="reach"
          accent={accent}
          animate={false}
          error={c.error}
          stat={<Took ms={c.ms} stat={c.error ? undefined : c.stat} error={c.error} />}
          drawer={c.error && c.stat ? () => <ErrLine text={c.stat as string} /> : undefined}
        >
          {callLine(c.name, c.summary)}
        </ActionRow>
      ))}
    </div>
  );
}

/** Everything that isn't a terminal, a file or a diff — each family drawn as
 *  what it actually did: a lookup, a fetch, a delegated run, a plan, an MCP
 *  call. The shape it wears is its kind's, and its tier is its consequence.
 *  Exported for the OUTPUT STYLE previews: PLAIN means "this row and nothing
 *  else", which is only legible next to the row itself. */
export function ToolCard({
  name,
  summary,
  ms,
  stat,
  error,
  animate,
  t,
}: {
  name: string;
  summary: string;
  ms?: number;
  stat?: string;
  error?: boolean;
  animate: boolean;
  /** Turn-relative clock for SIGNAL LOG's gutter (see ActionRow). */
  t?: string;
}) {
  const kind = toolKind(name);
  const rest = { ms, stat, error, animate, t };

  if (kind === "mcp") return <McpCard name={name} summary={summary} {...rest} />;
  if (kind === "web") return <WebCard name={name} summary={summary} {...rest} />;
  if (kind === "search") return <SearchCard name={name} summary={summary} {...rest} />;

  // A tool with no family of its own says TOOL and names itself in the object:
  // its own name as a tag ran past the cell (TOOLSEARCH, TASKUPDATE).
  const plain = kind === "plain";
  return (
    <ActionRow
          t={t}
      tier={toolTier(name)}
      shape={toolShape(name)}
      accent={toolAccent(name)}
      tag={plain ? "TOOL" : kindTag(name)}
      mark={kindMark(name)}
      animate={animate}
      error={error}
      stat={<Took ms={ms} stat={stat} error={error} />}
    >
      {plain ? <><span className="text-foreground-bright">{name}</span>{summary ? <span className="text-muted-2"> · </span> : null}</> : null}
      {summary || (kind === "plan" ? "checklist updated" : "")}
    </ActionRow>
  );
}

/** Where the agent speaks, marked on the rail the turn hangs off — the diamond
 *  the rail used to wear once at the top of a turn, now one per message, with a
 *  tick into the bubble so it reads as that message's and not as a bead on the
 *  line. Drawn inside the row's own box (the row pads past the gutter instead of
 *  margining past it): .vskip-card paint-contains each row, so a mark hung
 *  outside it would be clipped. */
/** Where the agent spoke, marked on the turn's rail. A diamond and its stub are
 *  WIRE's vocabulary, not everyone's — a ledger press marks a section with a §,
 *  a log marks it with a level chip, and a halo marks it by floating — so the
 *  glyph is two empty classes here and each language draws (or hides) its own.
 *  Colours are not inline for the same reason: nothing overrides an inline rule. */
function RailNode() {
  return (
    <>
      <span aria-hidden className="rail-node" />
      <span aria-hidden className="rail-stub" />
    </>
  );
}

/** One block of the model's prose, drawn as the mirror of your prompt bubble —
 *  teal where yours is violet, the solid bar down the left where yours wears one
 *  down the right, shrink-wrapped to at most the same 78% — so the two sides of
 *  the conversation read as two sides. Filling the turn's column instead was
 *  tried and reverted: it squares the right edge against the tool cards, but a
 *  message then reads as another card rather than as the other half of a
 *  conversation, which is the distinction worth keeping. Its padding matches the
 *  cards' so the prose still starts in their text column. The two things you
 *  actually want to do with it appear on hover rather than taking a row of their
 *  own: a transcript is mostly prose, and a permanent toolbar per paragraph
 *  would read as chrome. They ride beside the bubble as a flex sibling, not
 *  floated over its corner: an absolute overlay covered the first line of prose
 *  and, because an opacity-0 element still hit-tests, ate clicks on any link
 *  under it even unhovered. In flow they reserve their own width, so the bubble
 *  shrinks to make room instead of hiding behind them at any pane size. */
function MessageBlock({
  text, onQuote, tail, children,
}: {
  text: string;
  onQuote?: (text: string) => void;
  /** Worn after the last word (DOSSIER: the tally of the work it led to, WorkStretch). */
  tail?: ReactNode;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  /** Your selection if it's inside this block, else the whole block. Quoting a
   *  sentence is the common case; quoting the lot is the fallback. */
  function selected(): string {
    const sel = window.getSelection();
    const t = sel?.toString().trim();
    if (!t || !sel?.anchorNode || !ref.current?.contains(sel.anchorNode)) return text;
    return selectionMd() ?? t;
  }

  return (
    <>
      <div
        ref={ref}
        // Colours live in .abub (index.css) rather than inline: a style has to
        // be able to take the fill off, and nothing overrides an inline rule.
        className={`abub min-w-0 max-w-[78%] break-words border border-l-[3px] px-2.5 py-1.5 text-foreground-bright${tail ? " abub-tail" : ""}`}
      >
        {children}
        {tail ? <><span className="wsp"> </span>{tail}</> : null}
      </div>
      <div className="flex flex-none gap-1 pl-1 pt-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/msg:opacity-100">
        <button
          onClick={() => {
            try { void navigator.clipboard?.writeText(text); } catch { /* ignore */ }
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          title="Copy this message"
          className="flex items-center gap-1 border border-[var(--ac-20)] bg-[var(--panel3)] px-1.5 py-0.5 text-[length:var(--t85)] tracking-[1px] text-muted-2 hover:text-[var(--acc)]"
        >
          {copied ? <Check size={9} aria-hidden /> : <Copy size={9} aria-hidden />}
          {copied ? "COPIED" : "COPY"}
        </button>
        {onQuote && (
          <button
            onClick={() => onQuote(selected())}
            title="Quote into the prompt box — your selection if you have one, else the whole message"
            className="flex items-center gap-1 border border-[var(--ac-20)] bg-[var(--panel3)] px-1.5 py-0.5 text-[length:var(--t85)] tracking-[1px] text-muted-2 hover:text-[var(--acc)]"
          >
            <Quote size={9} aria-hidden /> QUOTE
          </button>
        )}
      </div>
    </>
  );
}

/** A run of plain lookups (reads, greps, globs) collapsed to one line, so a turn
 *  reads as the commands and edits that actually changed something. It wears the
 *  bare tag too — folded or not, looking at a file is the quiet thing. */
function FoldedChips({ names, onOpen }: { names: string[]; onOpen: () => void }) {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  const label = [...counts].map(([n, c]) => (c > 1 ? `${n} \u00d7${c}` : n)).join(" · ");
  return (
    <div
      className="actrow"
      data-tier="glance"
      role="button"
      tabIndex={0}
      title="show these steps"
      style={{ "--h": "var(--purple)" } as React.CSSProperties}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <i className="ax-bar" aria-hidden><MarkIcon mark="read" /></i>
      <span className="ax-tagcell">
        <span className="ax-tag" data-shape="bare">LOOKUPS</span>
      </span>
      <span className="ax-obj">{label}</span>
      <span className="ax-stat">{names.length}</span>
      <span className="ax-chev">
        <ChevronDown size={12} aria-hidden className="-rotate-90" />
      </span>
    </div>
  );
}

type RespondFn = (
  requestId: string,
  opts: { behavior?: "allow" | "deny"; answers?: AnswerSelection[] },
) => void | Promise<boolean | void>;

// Memoized: a long session's past turns keep the same `events`/`pending` arrays
// across polls (see mergeDelta), so only the live turn re-renders.
export const RunStream = memo(function RunStream({
  events: allEvents,
  pending = [],
  onRespond,
  animate = false,
  turnId = "",
  tokens = null,
  openResults = false,
  toolStyle = "dossier",
  turnStarted,
  onRunCommand,
  onQuote,
  onOpenFile,
  onAnswer,
  ended = false,
  unfinished = false,
  readOnly = false,
  working = false,
  hud,
  boot = null,
  foldsOpen = false,
  compact = false,
  view = null,
}: {
  events: TimedEvent[];
  pending?: PendingRequest[];
  onRespond?: RespondFn;
  /** What this turn is waiting on before its first token, or null. */
  boot?: string | null;
  animate?: boolean;
  turnId?: string;
  /** This turn's token spend; null = never reported (unknown, not free). */
  tokens?: number | null;
  openResults?: boolean;
  /** How a structured result is drawn — the transcript's OUTPUT STYLE setting.
   *  "plain" draws no widget at all (see lib/toolwidget). */
  toolStyle?: ToolStyle;
  /** Epoch seconds the turn opened. With each event's own `at` (store.transcript)
   *  this is the turn-relative clock SIGNAL LOG prints in its gutter. Absent on
   *  a turn the store hasn't echoed back, which leaves the gutter empty. */
  turnStarted?: number;
  onRunCommand?: (command: string) => void;
  onQuote?: (text: string) => void;
  onOpenFile?: OpenFile;
  /** Send a reply to a question the model asked in prose. Only the last, finished
   *  turn gets one — an old question is history, not something to answer. */
  onAnswer?: (text: string) => void;
  ended?: boolean;
  /** Sent by a teammate while it still ran: its last words are where it was, not its answer. */
  unfinished?: boolean;
  /** Someone else's turn, a teammate's device run: nothing in it is yours to continue. */
  readOnly?: boolean;
  /** Running and waiting on nothing (Transcript's working): the last WORK zone
   *  is live and hosts the indicator, or, with no zone to carry it, the working
   *  row draws at the foot. */
  working?: boolean;
  hud?: HudSettings;
  /** Whether a STEPS fold mounts open (the COLLAPSE STEPS switch, inverted).
   *  Off by default: the work sits under one line until you ask for it, and
   *  the words stay the thing you see. */
  foldsOpen?: boolean;
  /** The COMPACT chat layout: a run that came back with pictures is drawn as
   *  its pictures alone. */
  compact?: boolean;
  /** A Rivendell job's first turn: its answer is drawn as the job's view (FinalResult, JobViews). */
  view?: JobViewInput | null;
}) {
  // An ask is drawn by its question card and by nothing else. A live run also
  // emits it as a tool: the bridge answers the control request with a `deny`
  // carrying the user's choice (runner.py _format_answers), so the row lands as
  // an empty ASKUSERQUESTION tag over a red "The user answered…" — the same
  // exchange a second time, dressed as a failure. Dropped here rather than at
  // the source because attribution.py reads those stored events for `waiting_s`,
  // and dropped before folding/grouping so a phantom can't head a run — which
  // also lets the prose above it see the question and earn its RESULT box.
  // The native reader already omits the row (transcript_jsonl.py, tool_use).
  const events = allEvents.filter(
    (e) => !(e.type === "tool" && e.name === "AskUserQuestion"),
  );
  // T+ for SIGNAL LOG's gutter. Every other language ignores `data-t`, so this
  // costs one subtraction per row and nothing else.
  const clockAt = (e: TimedEvent): string | undefined => {
    if (turnStarted == null || e.at == null) return undefined;
    const s = Math.max(0, e.at - turnStarted);
    return s < 100 ? s.toFixed(1) : String(Math.round(s));
  };
  const [openFolds, setOpenFolds] = useState<Set<number>>(new Set());
  // A WORK zone's chip reads lib/seenshots: re-render when a shot gets seen.
  useSeenShots();
  const pendingIds = new Set(pending.map((p) => p.request_id));
  // A card still waiting on you draws at the turn's foot (lib/segments atFoot).
  const waiting = (i: number) => {
    const e = events[i];
    return (e.type === "question" || e.type === "permission") && pendingIds.has(e.request_id);
  };
  const permResolved = new Map<string, "allow" | "deny">();
  const qAnswered = new Map<string, AnswerSelection[]>();
  const toolDone = new Map<string, Done>();
  for (const e of events) {
    if (e.type === "permission_resolved") permResolved.set(e.request_id, e.behavior);
    if (e.type === "question_answered") qAnswered.set(e.request_id, e.answers);
    if (e.type === "tool_done" && e.id) toolDone.set(e.id, e);
  }
  // Turns recorded before tool events carried ids can't be paired, so they read
  // as finished commands instead of stuck carets.
  const doneOf = (e: RunEvent): Done | undefined =>
    e.type === "tool" ? (e.id ? toolDone.get(e.id) : {}) : undefined;

  // Every picture this turn's work produced, in order, named for the lightbox's
  // title (lib/toolwidget shotTitle), and each event's own (shotsOf): opened on
  // any row it pages through the lot of its zone — in DOSSIER the WORK zone it
  // sits in (galleryAt, below), elsewhere the turn — since the shot you want
  // next is rarely the same row's. A clip rides on its own row's entries only,
  // so the chapter rail stays with its video. A tool's shot carries its path
  // and clock, so paging to it sees it; a steer's carries no clock — you sent it.
  // shortcut: a shot another row found 404'd still sits in the strip (each row
  // knows only its own); fine while the upload dir prunes a whole turn at once.
  const shots: Shown[] = [];
  const shotsOf = new Map<number, Shown[]>();
  const addShots = (ev: number, call: string, about: string, paths: string[] = [], clip?: Clip, at?: number) => {
    const own = paths.map((p, i) => ({ src: api.attachmentUrl(p), name: shotTitle(call, about, i, paths.length), clip, path: p, at }));
    shots.push(...own);
    shotsOf.set(ev, own);
  };
  events.forEach((e, i) => {
    if (e.type === "steer") addShots(i, "STEER", e.text, e.images);
    else if (e.type === "tool") { const d = doneOf(e); addShots(i, e.name, e.summary, d?.images, d?.clip, e.at); }
  });

  // Only the quiet steps fold away — a terminal, a diff, a delegated run, a
  // fetch or an MCP call each carry their own block and break the run instead.
  // A glance that came back with a shot carries one too: chips would hide the
  // picture, which is the whole result.
  // A thought breaks a run the way prose does: lib/segments draws it between
  // the rows it fell between, so a card can't span one.
  const { folds, headOf } = foldChips(events, (i) => {
    const e = events[i];
    if (e.type !== "tool") return false;
    const d = doneOf(e);
    return toolTier(e.name) !== "glance" || !!d?.patch || !!d?.images?.length;
  });
  // Back-to-back calls of one kind share a card — Bash a terminal window, the
  // rest a CallGroup; the head draws them all, the rest render nothing. MCP
  // groups by server, so two servers in a row stay two cards.
  const groupKey = (i: number): string | null => {
    const e = events[i];
    if (e.type !== "tool") return null;
    if (e.name === "Bash") return "bash";
    // Edits group too, and their card merges them by file — a run of them is
    // the same file over and over far more often than it is many files.
    if (doneOf(e)?.patch) return "edit";
    const kind = toolKind(e.name);
    if (kind === "mcp") return `mcp:${mcpParts(e.name).server}`;
    // Shots group across tools: a chain of Reads that each came back with a PNG
    // is one contact sheet, not five galleries a screen tall each.
    if (toolTier(e.name) === "glance")
      return doneOf(e)?.images?.length ? "shots" : null; // the quiet ones fold into chips
    return kind;
  };
  const { folds: groups, headOf: groupOf } = runsOf(events, groupKey, 2);
  // A picture is the result, so a run that came back with one is drawn in the
  // flow with the words — a shut STEPS fold would hide it. The whole run goes:
  // its head draws every member, and a member left behind would head an empty fold.
  const inFlow = (i: number) =>
    (groups.get(groupOf.get(i) ?? i) ?? [i]).some((j) => !!doneOf(events[j])?.images?.length);

  // The turn's closing text arrives twice — once streamed as a text block, once
  // as the run's result — so the same words used to print twice, the second time
  // in the RESULT box. Only the box is drawn. A native session emits no result
  // event, so its final text keeps rendering as text.
  const resultText = (events.find((e) => e.type === "result")?.result ?? "").trim();
  const dossier = toolStyle === "dossier";
  // A native session emits no result event, so its closing words are a plain
  // `text`. DOSSIER still has to draw them as the answer — the answer is half of
  // tier 1 — so in a finished turn with no result, the last text that nothing
  // but bookkeeping follows is it.
  const finalText = (() => {
    if (!dossier || !ended || resultText || unfinished) return -1;
    for (let j = events.length - 1; j >= 0; j--) {
      const t = events[j].type;
      if (t === "text") return (events[j] as { text?: string }).text ? j : -1;
      if (t === "tool" || t === "question" || t === "permission") return -1;
    }
    return -1;
  })();

  // A turn that ends on an AskUserQuestion emits no result event, so the prose
  // explaining the card used to render as bare text while every other answer got
  // the RESULT box. This is the text that belongs to the card below it.
  const asksNext = (i: number): boolean => {
    for (let j = i + 1; j < events.length; j++) {
      const t = events[j].type;
      if (t === "tool_done" || t === "permission_resolved" || t === "question_answered"
          || t === "thinking" || t === "log") continue;
      return t === "question";
    }
    return false;
  };

  /** In DOSSIER a pause (a thought with nothing recorded but its length) that
   *  comes right before the agent's words — a note, or a thought with no figure
   *  of its own — is drawn on them, as their figure: on a row of its own under
   *  the steps it read as part of the step above it. */
  const wearsPause = (j: number): boolean => {
    const e = events[j];
    if (e?.type === "thinking") return !!e.text && !slow(e.ms);
    return e?.type === "text" && !!e.text && !(resultText && e.text.trim() === resultText)
      && !(asksNext(j) || (dossier && j === finalText));
  };
  const pauseAt = (j: number): number => {
    const e = events[j];
    return e?.type === "thinking" && !e.text && e.ms && !insideRun(j, groups, folds) ? e.ms : 0;
  };

  /** One event as its row. Indices stay absolute: foldChips, runsOf and the
   *  tool_done pairing all key off position in the full array. DOSSIER's
   *  stretches (WorkStretch) ask for parts of one: `tail` is worn after a
   *  note's or a thought's last word, "pics" is a picture call's pictures alone
   *  (the strip under the words), "bare" its row without them (the open work). */
  const renderEvent = (i: number, part?: "pics" | "bare", tail?: ReactNode): ReactNode => {
    const event = events[i];
    switch (event.type) {
      case "text": {
        const text = event.text;
        if (!text) return null;
        if (resultText && text.trim() === resultText) return null;
        if (asksNext(i) || (dossier && i === finalText))
          return (
            <FinalResult
              key={i}
              result={text}
              label={i === finalText ? "ANSWER" : dossier ? "ANSWER // ASK" : "RESULT // ASK"}
              animate={animate}
              idKey={`${turnId}:${i}`}
              view={i === finalText ? view : null}
            />
          );
        const pause = dossier ? pauseAt(i - 1) : 0;
        return (
          <div
            key={i}
            className="group/msg relative flex items-start pl-[var(--rail)]"
            style={animate ? { animation: "streamIn .34s cubic-bezier(.2,.8,.2,1) both" } : undefined}
          >
            <RailNode />
            {/* The agent talking. Bare prose between boxed, labelled cards was
                the one thing in a turn with nothing to catch a scrolling eye —
                and it is the part worth reading — so it gets a bubble of its
                own (MessageBlock) and a node on the rail where it starts. */}
            <MessageBlock text={text} onQuote={onQuote} tail={tail}>
              <Markdown className="leading-relaxed" onOpenFile={onOpenFile} toolStyle={toolStyle}>{text}</Markdown>
            </MessageBlock>
            {pause ? <span className="zpause" title={`${dur(pause)} before this note`}>{dur(pause)}</span> : null}
          </div>
        );
      }
      case "tool": {
        const head = headOf.get(i);
        if (head !== undefined && !openFolds.has(head)) return null;
        const fold = folds.get(i);
        if (fold && !openFolds.has(i))
          return (
            <FoldedChips
              key={i}
              names={fold.map((j) => (events[j] as { name: string }).name)}
              onOpen={() => setOpenFolds((s) => new Set(s).add(i))}
            />
          );
        const done = doneOf(event);
        if (groupOf.has(i)) return null; // drawn by the run's head
        const run = groups.get(i) ?? [i];
        // What structure the run's results carried, if any. Null keeps the
        // plain row — which is every tool without a table entry. Built from
        // the whole run rather than this event: the head draws the group's
        // one card, so a member's shots or sources would be drawn by nobody.
        const spec = widgetForRun(run.map((j) => ({ done: doneOf(events[j]), summary: (events[j] as { summary?: string }).summary, at: events[j].at })));
        // Hung under whichever card this tool got, not just the default one:
        // a Read of a PNG returns an image and takes the ReadCard branch, and
        // that is 715 of the 729 image results in this store — a widget only
        // the default branch could show would be one almost nobody sees.
        // Every style draws its widget now: PLAIN, the one that opted out
        // of them, has no column on the sheet and was replaced by a fifth
        // look (lib/toolwidget TOOL_STYLES).
        const media = spec ? (
          <div className="zx ml-[var(--rail)]">
            <ToolWidget spec={spec} accent={toolAccent(event.name)} style={toolStyle} gallery={galleryAt(i)} />
          </div>
        ) : done?.images?.length ? <ToolImages paths={done.images} all={galleryAt(i)} at={event.at} /> : null;
        if (part === "pics") return media ? <Fragment key={i}>{media}</Fragment> : null;
        // In an open stretch a picture call is a plain row: its pictures stay in the strip.
        const extra = part === "bare" && inFlow(i) ? null : media;
        const withExtra = (node: ReactNode) =>
          extra ? <div key={i}>{node}{extra}</div> : node;
        // COMPACT reads as a chat, and there the pictures are the reply: the
        // Read or Attach that fetched them is plumbing, so its row goes. In
        // DOSSIER a plain row stands in for it, so the pictures hang off the
        // zone's grid instead of floating beside the spine.
        if (compact && extra && inFlow(i)) {
          const n = run.reduce((t, j) => t + (doneOf(events[j])?.images?.length ?? 0), 0);
          return (
            <div key={i}>
              {dossier ? (
                <div className="zrow shots">
                  <i className="ax-bar" aria-hidden><ImageIcon size={14} strokeWidth={1.9} /></i>
                  <span className="ax-tagcell"><span className="ax-tag">SHOTS</span></span>
                  <span className="ax-obj">{n} picture{n === 1 ? "" : "s"}</span>
                </div>
              ) : null}
              {extra}
            </div>
          );
        }
        // A delegation is a turn nested inside this one, so it is drawn as
        // its own framed block — and a run of them as one fan, not as N
        // identical rows or a generic "AGENT · 4 CALLS" box.
        if (toolKind(event.name) === "agent") {
          const runs = run.map((j) => {
            const e = events[j] as { name: string; summary: string; agent?: AgentMeta; id?: string };
            const d = doneOf(events[j]);
            return { name: e.name, summary: e.summary, meta: e.agent, ms: d?.ms,
                     stat: d?.stat, error: d?.is_error, running: !d, id: e.id };
          });
          return runs.length > 1
            ? <AgentFan key={i} runs={runs} animate={animate} />
            : <AgentBlock key={i} run={runs[0]} animate={animate} />;
        }
        if (event.name === "Bash")
          return (
            <TerminalGroup
              key={i}
              cmds={run.map((j) => ({
                command: (events[j] as { summary: string }).summary,
                done: doneOf(events[j]),
              }))}
              animate={animate}
              autoOpen={openResults}
              onRerun={onRunCommand}
            />
          );
        if (done?.patch)
          return (
            <EditGroup
              key={i}
              edits={run.map((j) => {
                const e = events[j] as { name: string; summary: string };
                const d = doneOf(events[j]);
                return { name: e.name, path: e.summary, patch: d?.patch, ms: d?.ms,
                         error: d?.is_error };
              })}
              animate={animate}
              autoOpen={openResults}
            />
          );
        if (run.length > 1)
          return withExtra(
            <CallGroup
              key={i}
              name={event.name}
              calls={run.map((j) => {
                const e = events[j] as { name: string; summary: string };
                const d = doneOf(events[j]);
                return { name: e.name, summary: e.summary, ms: d?.ms, stat: d?.stat,
                         error: d?.is_error };
              })}
              animate={animate}
            />
          );
        const kind = toolKind(event.name);
        if (kind === "read" && event.summary)
          return withExtra(
            <ReadCard
              key={i}
              path={event.summary}
              ms={done?.ms}
              stat={done?.stat}
              error={done?.is_error}
              animate={animate}
              t={clockAt(event)}
            />
          );
        if (kind === "write" && event.summary)
          return withExtra(
            <WriteCard
              key={i}
              name={event.name}
              path={event.summary}
              ms={done?.ms}
              stat={done?.stat}
              error={done?.is_error}
              animate={animate}
              t={clockAt(event)}
            />
          );
        return (
          <div key={i}>
            <ToolCard
              name={event.name}
              summary={event.summary}
              ms={done?.ms}
              stat={done?.is_error ? undefined : done?.stat}
              error={done?.is_error}
              animate={animate}
              t={clockAt(event)}
            />
            {done?.is_error && done.stat ? (
              <div className="zx mt-2 ml-[var(--rail)]"><ErrLine text={done.stat} /></div>
            ) : null}
            {extra}
          </div>
        );
      }
      case "thinking":
        // A pause swallowed by a group is drawn by nobody: its mark would land
        // at the foot of the card instead of between the rows it fell between,
        // and two of them would stack on the same pixel. One right before the
        // agent's words is drawn on them (wearsPause).
        if (!event.text)
          return event.ms && !insideRun(i, groups, folds) && !(dossier && wearsPause(i + 1))
            ? <GapMark key={i} ms={event.ms} /> : null;
        return (
          <ThoughtRow key={i} ms={event.ms} text={event.text} animate={animate}
            pause={dossier && !slow(event.ms) ? pauseAt(i - 1) : 0}
            onOpenFile={onOpenFile} toolStyle={toolStyle} tail={tail} />
        );
      case "log":
        return (
          <LogRow
            key={i}
            src={event.src}
            label={event.label}
            text={event.text}
            error={event.error}
            animate={animate}
          />
        );
      case "tool_done":
        return null;
      case "steer":
        // Sent into this turn while it was already running — still you, so it
        // reads the way your prompt does (lib/dossier TOP_TYPES keeps it out of
        // the work), between the work it interrupted and the work it caused.
        return (
          <div key={i} id={ckId(turnId, steerKey(i))} className="dprompt scroll-mt-[94px]">
            <PromptBubble steer text={event.text} at={event.at}>
              {event.images && event.images.length > 0 && <ToolImages paths={event.images} all={galleryAt(i)} />}
            </PromptBubble>
          </div>
        );
      case "result":
        return (
          <FinalResult
            key={i}
            result={event.result}
            // A stored event knows when it landed; a live one doesn't carry
            // `at` yet, so the turn's own start plus its wall time says it.
            at={event.at ?? (turnStarted && event.elapsed ? turnStarted + event.elapsed : undefined)}
            elapsed={event.elapsed}
            tokens={tokens}
            isError={event.is_error}
            animate={animate}
            idKey={`${turnId}:${i}`}
            dossier={dossier}
            onAnswer={onAnswer}
            onQuote={onQuote}
            view={view}
          />
        );
      case "error":
        return (
          <div
            key={i}
            // Coloured by .ev-err off --err, not a Tailwind red: a fixed red-300
            // is unreadable on every light ground and gets hue-rotated on AURORA.
            className="ev-err ml-[var(--rail)] flex items-start gap-1.5 px-2 py-1 text-sm"
            style={animate ? { animation: "streamIn .34s cubic-bezier(.2,.8,.2,1) both" } : undefined}
          >
            <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
            <span>{event.message}</span>
          </div>
        );
      case "permission":
        return (
          <div key={i} className="ml-[var(--rail)]">
            <PermissionCard
              toolName={event.tool_name}
              summary={event.summary}
              detail={event.detail}
              active={!!onRespond && pendingIds.has(event.request_id)}
              resolved={permResolved.get(event.request_id)}
              // The run this belonged to is gone (restart, Stop, crash), so
              // nothing is listening for an answer any more.
              stale={ended && !permResolved.has(event.request_id)}
              onAllow={() => onRespond?.(event.request_id, { behavior: "allow" })}
              onDeny={() => onRespond?.(event.request_id, { behavior: "deny" })}
            />
          </div>
        );
      case "question":
        return (
          <div key={i} id={ckId(turnId, event.request_id)} className="ml-[var(--rail)] scroll-mt-[94px]">
            <QuestionCard
              questions={event.questions}
              requestId={event.request_id}
              active={!!onRespond && pendingIds.has(event.request_id)}
              answered={qAnswered.get(event.request_id)}
              stale={ended && !qAnswered.has(event.request_id)}
              onSubmit={(answers) => onRespond?.(event.request_id, { answers })}
            />
          </div>
        );
      case "stopped":
        return (
          <div
            key={i}
            className="ev-stop ml-[var(--rail)] flex items-center gap-1.5 text-xs"
          >
            <CircleStop size={14} className="shrink-0" aria-hidden />
            <span>{readOnly ? "Stopped" : "Stopped — send a message to continue."}</span>
          </div>
        );
      case "divider":
        return <DividerRow key={i} text={event.text} />;
      case "permission_resolved":
      case "question_answered":
        return null; // shown inside the relevant card
    }
  };

  /** What one step was, for the STEPS fold's title. An Edit still running has
   *  no patch yet but is an edit all the same; only Write makes a file. */
  const catOf = (e: { name: string }, d: Done | undefined): StepCat => {
    if (e.name === "Bash") return "command";
    if (d?.patch) return "edit";
    switch (toolKind(e.name)) {
      case "write": return e.name === "Write" ? "write" : "edit";
      case "read": return "read";
      case "search": return "search";
      case "web": return "fetch";
      case "mcp": return "call";
      case "agent": return "agent";
      default: return "step";
    }
  };

  const stepsFold = (seg: Seg) => {
    const cats: StepCat[] = [];
    let ms = 0, failed = 0, running = false, live = "";
    for (const i of seg.idx) {
      const e = events[i];
      if (e.type === "log") { cats.push("log"); if (e.error) failed++; continue; }
      if (e.type !== "tool") continue;
      const d = doneOf(e);
      cats.push(catOf(e, d));
      if (!d) { running = true; live = e.summary; }
      else { ms += d.ms ?? 0; if (d.is_error) failed++; }
    }
    const title = stepsTitle(cats);
    // Inside a WORK zone a STEPS row would be a fold inside a fold: the zone
    // already is the one line the work sits under.
    // Keyed by where the stretch starts (lib/segments), not by its first row on
    // screen, which the tail window moves: a new key remounts what you opened.
    if (dossier) return <div key={`f${seg.start}`} className="dsteps">{seg.idx.map((i) => renderEvent(i))}</div>;
    return (
      <Fold
        key={`f${seg.start}`}
        label="STEPS"
        icon={<Layers size={11} aria-hidden />}
        // While one is out, the row names it: on a phone this line is the
        // whole view of what the machine is doing right now.
        title={running && live ? `${title} \u2014 ${live}` : title}
        stat={{ running, failed, ms }}
        defaultOpen={foldsOpen}
        animate={animate}
      >
        {seg.idx.map((i) => renderEvent(i))}
      </Fold>
    );
  };

  const segs = segmentsOf(events, 0, inFlow, waiting);
  // Tier 1 and 2 (lib/dossier): the answer, the prose that introduces a card,
  // the cards, your steers, and what ends a turn. Everything else is work.
  const topAt = (i: number): boolean => {
    const e = events[i];
    if (e.type === "text") return i === finalText || asksNext(i);
    return TOP_TYPES.has(e.type);
  };
  const isTop = (seg: Seg): boolean => seg.kind === "prose" && topAt(seg.idx[0]);
  // A step is what a zone's figure counts: a note or thought with words, a
  // hook, a tool call.
  const isStep = (e: RunEvent) => ((e.type === "thinking" || e.type === "text") && !!e.text) || e.type === "log" || e.type === "tool";
  /** What a stretch of the work holds, for a WORK zone's header and a chapter's line. */
  const tally = (zsegs: Seg[]) => {
    const cats: StepCat[] = [];
    const pics: Pic[] = [];
    let notes = 0, steps = 0, failed = 0, running = false, live = "", openAt: number | undefined, first: number | undefined, last: number | undefined;
    for (const seg of zsegs) for (const i of seg.idx) {
      const e = events[i];
      if (e.at != null) { first ??= e.at; last = e.at; }
      if (isStep(e)) steps++;
      if (e.type === "thinking" || e.type === "text") { if (e.text) notes++; }
      else if (e.type === "log") { cats.push("log"); if (e.error) failed++; }
      else if (e.type === "tool") {
        const d = doneOf(e), c = catOf(e, d);
        cats.push(c);
        if (!d) { running = true; live = e.summary; openAt = e.at; }
        else if (d.is_error) failed++;
        for (const p of d?.images ?? []) pics.push({ path: p, name: shotName(e.summary) || p.split("/").pop() || p, unseen: shotUnseen(p, e.at) });
        if (d?.ms && e.at != null) last = Math.max(last ?? 0, e.at + d.ms / 1000);
      }
    }
    const secs = first != null && last != null ? last - first : 0;
    return { cats, pics, notes, steps, failed, running, live, openAt, first, last, span: secs >= 1 ? wall(secs) : "" };
  };
  /** A chapter's name: the note it opens on (lib/dossier cuts there), else
   *  the first words or call in it — one line, without the code ticks. */
  const titleOf = (zsegs: Seg[]): string => {
    const evs = zsegs.flatMap((s) => s.idx.map((i) => events[i]));
    const e = evs.find((x) => x.type === "text" && x.text) ?? evs.find((x) => (x.type === "thinking" && x.text) || x.type === "tool");
    const words = !e ? "" : e.type === "tool" ? e.summary : e.type === "text" || e.type === "thinking" ? e.text ?? "" : "";
    return words.trim().split("\n")[0].replace(/`/g, "");
  };
  /** What a stretch ran, for its tally (WorkStretch): the header's kinds and
   *  what failed. A hook that ran clean is context, not work: it isn't counted,
   *  and work that is nothing else stays where it is, a bare icon on the spine. */
  const workOf = (zsegs: Seg[]) => {
    const cats: StepCat[] = [];
    let failed = 0;
    for (const seg of zsegs) for (const i of seg.idx) {
      const e = events[i];
      if (e.type === "log") { if (e.src !== "hook" || e.error) { cats.push("log"); if (e.error) failed++; } }
      else if (e.type === "tool") { const d = doneOf(e); cats.push(catOf(e, d)); if (d?.is_error) failed++; }
    }
    return { cats, failed };
  };
  const rowOf = (seg: Seg) => (seg.kind === "prose" ? renderEvent(seg.idx[0]) : stepsFold(seg));
  /** A zone's rows, or a chapter's (DOSSIER only): the agent's words, each
   *  wearing the work it led to (lib/dossier stretchesOf, WorkStretch). A
   *  picture call is work too, but its pictures stay out, under the words.
   *  `live`: the zone is running, so its last stretch is the one working. */
  const rowsOf = (zsegs: Seg[], live = false) =>
    stretchesOf(zsegs.map((s) => s.kind === "prose" && events[s.idx[0]].type !== "tool")).flatMap(({ words, work }, k, all) => {
      const head = words < 0 ? undefined : zsegs[words];
      const w = work.map((j) => zsegs[j]);
      const { cats, failed } = workOf(w);
      const i = head?.idx[0], e = i === undefined ? undefined : events[i];
      // A note or a thought that draws wears the tally; anything else (a device
      // run's divider, the answer's streamed copy, which draws nothing) keeps
      // its own row, and the tally gets one of its own.
      const wears = !!e && ((e.type === "thinking" && !!e.text)
        || (e.type === "text" && !!e.text && !(resultText && e.text.trim() === resultText)));
      const quiet = !cats.length;
      return [
        head && !wears ? rowOf(head) : null,
        wears || !quiet ? (
          <WorkStretch
            key={`w${(head ?? w[0]).start}`}
            words={wears ? (t) => renderEvent(i!, undefined, t) : null}
            cats={cats}
            failed={failed}
            live={live && k === all.length - 1}
            defaultOpen={foldsOpen}
            pics={quiet ? [] : w.filter((s) => s.kind === "prose").map((s) => renderEvent(s.idx[0], "pics")).filter((p) => p !== null)}
            rows={() => w.map((s) => (s.kind === "prose" ? renderEvent(s.idx[0], "bare") : stepsFold(s)))}
          />
        ) : null,
        ...(quiet ? w.map(rowOf) : []),
      ];
    }).filter((r) => r !== null);
  const workZone = (zsegs: Seg[], lastZone: boolean) => {
    const { cats, pics, notes, steps, failed, running, live, openAt, last, span } = tally(zsegs);
    // The last zone of a running turn is live: a tool out is WORKING since it
    // started, nothing out is THINKING since the last thing finished. A card
    // waiting on you is neither — the plate rests until it is answered.
    const state = working && lastZone ? (running ? "work" as const : "think" as const) : null;
    // A long zone opens on its chapters, and a chapter builds its rows only
    // while open (lib/dossier chapterStarts); a chapter opens on a note.
    const starts = chapterStarts(
      zsegs.map((s) => s.idx.filter((i) => isStep(events[i])).length),
      zsegs.map((s) => s.kind === "prose" && events[s.idx[0]].type === "text"),
    );
    const rows = !starts.length ? rowsOf(zsegs, !!state) : starts.map((at, k) => {
      const segs = zsegs.slice(at, starts[k + 1]);
      const c = tally(segs);
      return (
        <WorkChapter
          key={`c${segs[0].start}`}
          n={k + 1}
          at={c.first}
          title={titleOf(segs)}
          steps={c.steps}
          span={c.span}
          failed={c.failed}
          pics={c.pics.length}
          live={!!state && k === starts.length - 1}
          rows={() => rowsOf(segs, !!state && k === starts.length - 1)}
        />
      );
    });
    // Keyed by the tier-1/2 row before it (or a card drawn at the foot), so the
    // zone you opened stays the same zone as rows land.
    let start = zsegs[0].start;
    while (start > 0 && (waiting(start - 1) || !topAt(start - 1))) start--;
    return (
      <WorkZone
        key={`z${start}`}
        cats={cats}
        notes={notes}
        steps={steps}
        failed={failed}
        pics={pics}
        gallery={galleryAt(zsegs[0].idx[0])}
        state={state}
        since={running ? openAt : last}
        hud={hud}
        events={events}
        started={turnStarted}
        live={live}
        span={span}
        chapters={starts.length}
        defaultOpen={foldsOpen}
        animate={animate}
      >
        {rows}
      </WorkZone>
    );
  };

  const zones = dossier ? zonesOf(segs, isTop) : [];
  // Each zone's pictures, for every event in it: a lightbox opened in a WORK
  // zone (or on a steer) pages through those, never another zone's.
  const zoneShots = new Map<number, Shown[]>();
  for (const z of zones) {
    const idx = z.segs.flatMap((s) => s.idx);
    const own = idx.flatMap((i) => shotsOf.get(i) ?? []);
    for (const i of idx) zoneShots.set(i, own);
  }
  const galleryAt = (i: number) => zoneShots.get(i) ?? shots;
  // Whether a WORK zone is there to carry the working indicator (the last zone,
  // while it runs); otherwise the indicator draws at the foot — before the
  // first event, or after a steer the model is still reading.
  const carried = working && zones.length > 0 && zones[zones.length - 1].kind === "work";
  return (
    // vskip-card: a turn runs to hundreds of events, so each card skips layout
    // and paint while it's off-screen (see .vskip-card in index.css).
    <div className="rstream space-y-2 vskip-card">
      {boot ? <BootRow text={boot} /> : null}
      {/* The words in the flow, the work under a row each (lib/segments) —
          or, in DOSSIER, under one WORK zone per stretch (lib/dossier). */}
      {dossier
        ? zones.map((z, i) =>
            z.kind === "top" ? renderEvent(z.segs[0].idx[0]) : workZone(z.segs, i === zones.length - 1))
        : segs.map((seg) => (seg.kind === "prose" ? renderEvent(seg.idx[0]) : stepsFold(seg)))}
      {working && !carried ? <WorkingIndicator hud={hud} events={events} boot={boot} started={turnStarted} /> : null}
    </div>
  );
});

/** "A · TOKEN" (lib/askback's lettered options) wears its key as a badge, the
 *  same one the question card's rows carry. */
function chipLabel(o: string) {
  const k = /^([A-D1-4]) · (.+)$/.exec(o);
  return k ? <span className="inline-flex items-center gap-1.5"><span className="qkey qkey-chip rounded">{k[1]}</span>{k[2]}</span> : o;
}

/** The question a result ended on, lifted out of its body: highlighted the way a
 *  question card is, with the replies it was waiting for as one-tap chips. The
 *  chips send their own label as the next prompt — nothing is answered for you,
 *  and "write answer" hands the question to the prompt box instead. */
function AskBackBar({
  ask,
  onAnswer,
  onQuote,
}: {
  ask: AskBack;
  onAnswer: (text: string) => void;
  onQuote?: (text: string) => void;
}) {
  const [sent, setSent] = useState<string | null>(null);
  const chip = "border px-2 py-1 text-[length:var(--t12)] disabled:opacity-40";
  return (
    <div
      className="border-t px-3 py-2.5"
      style={{
        borderColor: "color-mix(in srgb, var(--acc) 18%, transparent)",
        background: "color-mix(in srgb, var(--acc) 6%, transparent)",
      }}
    >
      <div className="flex items-start gap-2">
        <span className="mt-1 flex-none text-[length:var(--t95)] tracking-[2px] text-[var(--acc)]">
          ASK //
        </span>
        <Markdown className="min-w-0 leading-relaxed text-foreground-bright">{ask.question}</Markdown>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {ask.options.map((o) => (
          <button
            key={o}
            type="button"
            disabled={sent !== null}
            onClick={() => { setSent(o); onAnswer(o); }}
            title={o === "No" ? "Drop the question — nothing runs" : `Reply "${o}"`}
            className={`${chip} border-[var(--ac-22)] bg-[var(--ac-08)] text-foreground-bright hover:border-[var(--acc)] ${
              sent === o ? "border-[var(--acc)]" : ""
            }`}
          >
            {chipLabel(o)}
          </button>
        ))}
        {onQuote && (
          <button
            type="button"
            disabled={sent !== null}
            onClick={() => onQuote(ask.question)}
            title="Quote the question into the prompt box and answer in your own words"
            className={`${chip} border-border bg-[var(--panel3)] tracking-[1px] text-muted-2 hover:text-[var(--acc)]`}
          >
            <Quote size={9} className="mr-1 inline" aria-hidden />
            WRITE ANSWER
          </button>
        )}
        {/* Two named alternatives, or an open question, carry no "No" chip — so
            the only way out was answering, and the session sat in ASK until you
            did. Same drop-it path the "No" chip takes: nothing runs. */}
        {!ask.options.includes("No") && (
          <button
            type="button"
            disabled={sent !== null}
            onClick={() => { setSent("No"); onAnswer("No"); }}
            title="Drop the question — nothing runs"
            className={`${chip} border-border bg-[var(--panel3)] tracking-[1px] text-muted-2 hover:text-[var(--acc)]`}
          >
            DISMISS
          </button>
        )}
      </div>
    </div>
  );
}

/** Lines a result prints before it folds — long enough that an ordinary answer
 *  never folds, short enough that a 300-line report doesn't bury the transcript. */
const RESULT_FOLD_LINES = 30;

export function FinalResult({
  result,
  at,
  elapsed,
  tokens,
  isError,
  animate,
  idKey,
  label,
  dossier = false,
  onAnswer,
  onQuote,
  view,
}: {
  result: string;
  /** Epoch seconds the answer landed, for the clock in the meta row. */
  at?: number;
  elapsed?: number;
  tokens?: number | null;
  isError?: boolean;
  animate: boolean;
  idKey: string;
  /** Overrides "RESULT // OK" — the accent-toned box drawn above a question card. */
  label?: string;
  /** DOSSIER calls the box what it is to the reader: the turn's answer. */
  dossier?: boolean;
  onAnswer?: (text: string) => void;
  onQuote?: (text: string) => void;
  /** Set on a Rivendell job's turn: an answer its kind can read is drawn as the
   *  job's view (a brief, minutes, a review, the newspaper…) instead of as text. */
  view?: JobViewInput | null;
}) {
  const h12 = useClock12();
  const flash = animate && !typedResults.has(idKey);
  const drawn = useMemo(() => (view ? jobView(view, result) : null), [view, result]);
  // The CLI answers a slash command it doesn't have with one line and a clean
  // exit, so the turn arrives is_error:false and drew green — "RESULT // OK",
  // body "Unknown command: /design-first". Nothing ran; say so.
  const bad = isError || result.startsWith("Unknown command:");
  const tone = bad ? "var(--err)" : label ? "var(--acc)" : "var(--ok)";
  // The model asked in prose instead of using a question card: lift the question
  // out of the body so it reads as an ask, and offer the answers it expected.
  // A job's view is its deliverable: an open question in a task or a brief is for its readers, not for you.
  const ask = onAnswer && !bad && !drawn ? askBack(result) : null;
  const body = ask ? ask.body : result;
  const lines = body.split("\n").length;
  // A live result stays open — you're watching it land. Long ones from earlier in
  // the session arrive folded.
  const [open, setOpen] = useState(flash || lines <= RESULT_FOLD_LINES);
  return (
    // `--tone` rather than four inline colours: the answer is the loudest thing
    // in a turn, so every language has to be able to re-draw it (a plate, a pair
    // of rules, a level bar, a margin note, a floating surface) — and nothing
    // overrides an inline rule. See `.res` in index.css and THE SESSION'S IDIOM.
    <div className="resblk relative my-2 pl-[var(--rail)]" data-bad={bad ? "" : undefined} data-paper={drawn ? "" : undefined}
      style={{ "--tone": tone } as React.CSSProperties}>
      <RailNode />
      <div
        className="res group/res"
        style={flash ? { animation: "resultflash 1.2s ease both" } : undefined}
      >
        <div className="res-head">
          <span className="res-lab">{label ?? (dossier ? (bad ? "ANSWER // ERROR" : "ANSWER") : `RESULT // ${bad ? "ERROR" : "OK"}`)}</span>
          {drawn && view?.job.kind && <span className="res-kind"><JobTag job={view.job} /></span>}
          <span className="res-meta">
            {at != null && <span title="when the answer landed">{hhmm(at, h12)}</span>}
            {typeof elapsed === "number" && elapsed > 0 && (
              <span title="wall time">{wall(elapsed)}</span>
            )}
            {typeof tokens === "number" && tokens > 0 && (
              <span title="tokens this turn spent">
                {tokens < 1000 ? tokens : `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}K`} TOK
              </span>
            )}
          </span>
          <span className="flex-none opacity-0 transition-opacity group-focus-within/res:opacity-100 group-hover/res:opacity-100">
            <CopyBtn text={result} title="copy result" />
          </span>
        </div>
        {drawn ?? (body && (
          <div className="res-body relative">
            <div className={open ? undefined : "max-h-[380px] overflow-hidden"}>
              <Typewriter text={body} animate={animate} idKey={idKey} className="leading-relaxed text-foreground-bright" />
            </div>
            {!open && <div className="res-fade" aria-hidden />}
          </div>
        ))}
        {ask && <AskBackBar ask={ask} onAnswer={onAnswer!} onQuote={onQuote} />}
        {!drawn && body && lines > RESULT_FOLD_LINES && (
          <button
            type="button"
            onClick={(e) => {
              // FOLD sits under the box it shrinks, so folding pulled it out of
              // view and the page landed on whatever was below — the session's
              // end, near the end. Scroll anchoring doesn't catch it (WebKit and
              // Chrome both anchor on the clipped text, which never moves), so
              // the transcript is scrolled back under the button.
              const b = e.currentTarget, y = b.getBoundingClientRect().top;
              flushSync(() => setOpen((o) => !o));
              const sc = b.closest(".mscroll");
              if (open && sc) sc.scrollTop += b.getBoundingClientRect().top - y;
            }}
            className="res-fold"
          >
            <ChevronDown size={11} aria-hidden className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
            {open ? "FOLD" : `SHOW ALL // ${lines} LINES`}
          </button>
        )}
      </div>
    </div>
  );
}
