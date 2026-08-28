import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import {
  TriangleAlert, CircleStop, Copy, Check, RotateCw, ChevronDown, ChevronsUp,
  Search, Globe, Quote,
  Terminal, Layers, Brain,
  GitBranch, FileText, FilePen, Trash2, FolderTree, Play, Package,
  FlaskConical, Cpu, Database, Container,
} from "lucide-react";
import { api, type AnswerSelection, type RunEvent, type TimedEvent } from "../api";
import type { PendingRequest } from "../chat";
import { SteerIcon } from "./Composer";
import { Markdown, type OpenFile } from "./Markdown";
import { PermissionCard } from "./PermissionCard";
import { QuestionCard } from "./QuestionCard";
import { ImageLightbox, ZoomButton } from "./ImageLightbox";
import { askBack, type AskBack } from "../lib/askback";
import { ckId, steerKey } from "../lib/checkpoints";
import { foldChips, runsOf, headSafeCut, insideRun, byFile, type EditEv } from "../lib/toolfold";
import { ToolWidget } from "./ResultWidgets";
import { widgetForRun, type ToolStyle, type WebSource } from "../lib/toolwidget";
import {
  cmdAbstract, cmdKind, hostOf, mcpParts, toolAccent, toolKind, toolShape, toolTag, toolTier,
  type CmdKind, type Shape, type Tier,
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
  const [n, setN] = useState(() => (animate && !typedResults.has(idKey) ? 0 : text.length));

  useEffect(() => {
    if (n >= text.length) return;
    typedResults.add(idKey);
    const step = Math.max(1, Math.ceil(text.length / 60)); // ~60 frames ≈ 2.1s, capped
    const id = setInterval(() => {
      setN((p) => {
        const next = p + step;
        if (next >= text.length) {
          clearInterval(id);
          return text.length;
        }
        return next;
      });
    }, 35);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (n >= text.length) return <Markdown className={className}>{text}</Markdown>;
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
  stat?: string; images?: string[]; sources?: WebSource[] };

// Diff lines shown before a block folds — a turn can hold dozens.
const DIFF_PREVIEW = 20;

/** Events of a turn that mount before the rest waits behind a button. Turn
 *  granularity is what the virtualizer windows on, so a session whose turns run
 *  to hundreds of events is three rows and nothing to window — the spec called
 *  this out ("<8k missed when trailing megaturns sit in view") and left
 *  event-level rows as the escalation. This is the cheap half of that: the tail
 *  is what you opened the turn to read, and the churn above it costs ~70 DOM
 *  nodes an event to mount. */
export const TURN_TAIL = 60;

/** Below this, hiding events isn't worth the button that reveals them. */
const TURN_TAIL_MIN = 10;

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

/** The glyph a command wears, so a terminal window reads as a list of actions
 *  rather than a wall of text. */
const CMD_ICON: Record<CmdKind, typeof Terminal> = {
  git: GitBranch, search: Search, read: FileText, edit: FilePen, delete: Trash2,
  fs: FolderTree, run: Play, pkg: Package, test: FlaskConical, net: Globe,
  proc: Cpu, db: Database, docker: Container, shell: Terminal,
};

/** The window's three lights, the one thing that says "terminal" at a glance.
 *  A lone command draws them itself — a header row for one line is all frame. */
function Lights({ running }: { running: boolean }) {
  return (
    <span className="ax-winlights" data-run={running ? "" : undefined} aria-hidden>
      <i /><i /><i />
    </span>
  );
}

type Cmd = { command: string; done?: Done };

/** One command as a row of the ledger: the phrase it amounts to, its own kind's
 *  glyph in front of it, and its output behind the chevron. Inside a window it
 *  wears no tag — the header already said BASH — and a lone command wears the
 *  three lights itself, because a window around one line is all frame.
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
  const Icon = CMD_ICON[cmdKind(command)];
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
      lead={<Icon size={12} />}
      animate={animate}
      running={running}
      error={failed}
      startOpen={autoOpen && (running || failed || newest)}
      stat={
        <>
          {exit && <span style={{ color: "var(--err)" }}>EXIT {exit[1]}</span>}
          {slow(done?.ms) ? <span>{dur(done?.ms)}</span> : null}
          {lines > 0 && <span>{lines}L</span>}
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
      <div className="ax-winhead">
        <Lights running={running} />
        {/* No `>_`: not one of the sheet's five columns draws a glyph here —
            the word is the label, and the run's state is the pip beside it. */}
        <span className="ax-wintag">BASH // {running ? "RUNNING" : failed ? "FAILED" : "OK"}</span>
        <i className="ax-winrule" aria-hidden />
        <span className="ax-winmeta">
          <span>{cmds.length} CMDS</span>
          {slow(ms) && <span>{dur(ms)}</span>}
        </span>
      </div>
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
      tag={bare ? undefined : toolTag(name)}
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
      <div className="ax-winhead">
        <span className="ax-wintag truncate">EDIT{failed ? " // FAILED" : ""}</span>
        <i className="ax-winrule" aria-hidden />
        {/* The last figure is the one the header exists for: what this whole run
            did to the tree, without opening a single drawer. */}
        <span className="ax-winmeta">
          <span>{files.length} FILES</span>
          {edits.length > files.length && <span>{edits.length} EDITS</span>}
          {slow(ms) && <span>{dur(ms)}</span>}
          <span className="ax-winnum">
            <span style={{ color: "var(--ok)" }}>+{add}</span>
            <span style={{ color: "var(--err)" }}>−{del}</span>
          </span>
        </span>
      </div>
      {files.map((f) => (
        <DiffBlock key={f.path} {...f} bare animate={false} autoOpen={autoOpen} />
      ))}
    </div>
  );
}

/** A path in the form a reader uses: the filename, and just enough directory in
 *  front of it to place the file. The head of an absolute path is a mount point
 *  nobody reads — and it is exactly what a plain truncation keeps, cutting off
 *  the one part that identifies the file. */
function shortDir(dir: string): string {
  const parts = dir.split("/").filter(Boolean);
  return parts.length > 2 ? `\u2026/${parts.slice(-2).join("/")}/` : dir;
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

/** The ruled lines of the page a read looked at but never showed you. */
function PageLines() {
  return (
    <span className="ax-page" aria-hidden>
      {[13, 8, 11].map((w) => <i key={w} style={{ width: w }} />)}
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

/** A pause with nothing recorded but its length — a hairline seam with the
 *  figure at its right edge, in the same column as the rows' stats. It used to
 *  be a zero-height overlay riding the next card's top edge, which put the
 *  figure on top of that row's own numbers. */
function GapMark({ ms }: { ms: number }) {
  return (
    <div aria-hidden className="ml-[var(--rail)] flex items-center gap-2 pr-[18px] text-[length:var(--t95)] tracking-[1px] text-muted-2">
      <span className="h-px min-w-0 flex-1 bg-border" />
      <span className="flex-none">+{dur(ms)}</span>
    </div>
  );
}

function ThinkingRow({ ms, text, animate }: { ms?: number; text?: string; animate: boolean }) {
  const [open, setOpen] = useState(false);
  // The row costs its height either way — the first line of the reasoning is
  // what makes it worth reading, and it is the one thing the tool cards can't say.
  const peek = (text ?? "").trim().split("\n").find((l) => l.trim()) ?? "";
  const head = (
    <>
      <span className="thk-lab flex flex-none items-center gap-1.5 text-[length:var(--t10)] tracking-[1.5px]">
        <Brain size={11} aria-hidden />
        THOUGHT
      </span>
      {peek && !open ? (
        <span className="thk-peek min-w-0 flex-1 truncate text-[length:var(--t11)] italic opacity-75">{peek}</span>
      ) : (
        <span aria-hidden className="h-px flex-1 bg-border" />
      )}
      <span className="thk-ms flex-none text-[length:var(--t95)] tracking-[1px]">{slow(ms)}</span>
      {text ? (
        <ChevronDown
          size={12}
          aria-hidden
          className={`flex-none transition-transform duration-200 ${open ? "" : "-rotate-90"}`}
        />
      ) : null}
    </>
  );
  return (
    <div
      className="thk ml-[var(--rail)] text-muted-2"
      style={animate ? { animation: "streamIn .34s cubic-bezier(.2,.8,.2,1) both" } : undefined}
    >
      {text ? (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          title={open ? "hide the reasoning" : "show the reasoning"}
          className="flex w-full items-center gap-2.5 py-0.5 text-left"
        >
          {head}
        </button>
      ) : (
        <div className="flex items-center gap-2.5 py-0.5">{head}</div>
      )}
      {open && text ? (
        <div className="mt-1 whitespace-pre-wrap border-l border-border pl-2.5 text-[length:var(--t11)] leading-relaxed">
          {text}
        </div>
      ) : null}
    </div>
  );
}

/** A hook's output, or a line the child wrote to stderr: the work either side of
 *  the conversation, which used to be visible only when a run died. Shut by
 *  default past the first line — most of it is one line and says everything. */
function LogRow({ src, label, text, error, animate }:
  { src: string; label?: string; text: string; error?: boolean; animate: boolean }) {
  const [open, setOpen] = useState(false);
  const lines = text.split("\n");
  const more = lines.length - 1;
  const color = error ? "var(--err)" : undefined;
  return (
    <div
      className="thk thk-log ml-[var(--rail)] text-muted-2"
      style={animate ? { animation: "streamIn .34s cubic-bezier(.2,.8,.2,1) both" } : undefined}
    >
      <button
        type="button"
        onClick={() => more && setOpen((o) => !o)}
        className="flex w-full items-start gap-2 py-0.5 text-left font-mono text-[length:var(--t11)] leading-relaxed"
        style={{ color }}
        title={more ? (open ? "hide the rest" : `show ${more} more line${more > 1 ? "s" : ""}`) : undefined}
      >
        <Terminal size={11} aria-hidden className="mt-1 flex-none" />
        <span className="flex-none tracking-[1px] opacity-70">
          {(label ? `${src}:${label}` : src).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
          {open ? text : lines[0]}
        </span>
        {more && !open ? <span className="flex-none opacity-70">+{more}</span> : null}
      </button>
    </div>
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
  lead,
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
  /** A glyph in front of the object, where it says something the tag can't. */
  lead?: ReactNode;
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
        <i className="ax-bar" aria-hidden />
        <span className="ax-tagcell">
          {tag !== undefined && (
            <span className="ax-tag" data-shape={shape}>
              {shape === "term" && (
                <span className="ax-lights" aria-hidden>
                  <i /><i /><i />
                </span>
              )}
              <span className="ax-tagtext">{tag}</span>
            </span>
          )}
        </span>
        <span className="ax-obj">
          {lead ? <span className="ax-lead" aria-hidden>{lead}</span> : null}
          {children}
        </span>
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

/** A read only looked at a page, so it wears no frame at all and ends in the
 *  ruled lines of what it read. The quietest row there is. */
function ReadCard({ path, ms, stat, error, animate, t }:
  { path: string; ms?: number; stat?: string; error?: boolean; animate: boolean; t?: string }) {
  return (
    <ActionRow
          t={t}
      tier="glance"
      shape={toolShape("Read")}
      accent={toolAccent("Read")}
      tag="READ"
      animate={animate}
      error={error}
      stat={<><PageLines /><Took ms={ms} stat={stat} error={error} /></>}
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
      tag={toolTag(name)}
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
      tag={toolTag(name)}
      animate={animate}
      error={error}
      stat={<Took ms={ms} stat={stat} error={error} />}
    >
      <span className="ax-q">{summary}</span>
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
      tag={toolTag(name)}
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

/** A call out of this process and into another one, so the server's tag trails a
 *  patch cable across to the tool it reached — "get task" alone never said which
 *  task, so what it was called with follows. */
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
      tag={toolTag(name)}
      animate={animate}
      error={error}
      stat={<Took ms={ms} stat={stat} error={error} />}
    >
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

/** The chrome every delegation block wears: the mark, what kind of delegation
 *  this was, who took it, and the run's own numbers. */
function AgentHead({ kind, type, running, nums }: {
  kind: string; type?: string; running?: boolean; nums: ReactNode;
}) {
  return (
    <div className="agb-head">
      <span className="agb-mark" aria-hidden>{running ? "\u25c8" : "\u25c7"}</span>
      <span className="agb-kind">{kind}{type ? <span aria-hidden>//</span> : null}</span>
      {type ? <span className="agb-type" title={type}>{type}</span> : null}
      <span className="agb-rule" aria-hidden />
      <span className="agb-nums">{nums}</span>
    </div>
  );
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

/** A delegated run: the one thing in the stream that keeps a frame, because it
 *  is not a step of your turn but a turn nested inside it — its own tool calls,
 *  its own minutes, its own report. The agent that took the work is the tag
 *  ("AGENT" alone was the same word for a one-file lookup and a four-minute
 *  fan-out), and the brief is the body rather than a paragraph clipped into a
 *  one-line cell. */
function AgentBlock({ run, animate }: { run: AgentRun; animate: boolean }) {
  const [open, setOpen] = useState(false);
  const { name, summary, meta, stat, error, running } = run;
  const kind = name === "Skill" ? "SKILL" : "AGENT";
  const title = meta?.title ?? "";
  return (
    <div
      className="agb panel"
      data-run={running ? "" : undefined}
      data-err={error ? "" : undefined}
      data-open={open ? "" : undefined}
      style={{
        ...({ "--h": agentHue(run) } as React.CSSProperties),
        ...(animate ? { animation: "streamIn .34s cubic-bezier(.2,.8,.2,1) both" } : {}),
      }}
    >
      <i className="agb-rail" aria-hidden />
      {running ? <span className="agb-sweep" aria-hidden><i /></span> : null}
      <AgentHead kind={kind} type={meta?.type} running={running} nums={agentNums(run, animate)} />
      {title || summary ? (
        <div className="agb-brief">
          {title ? <b>{title}</b> : null}
          {title && summary ? " \u2014 " : null}
          {summary}
        </div>
      ) : null}
      {/* The reason lives inside the frame, not under it: it belongs to this run,
          and a block with a border makes a line floating below it read as loose. */}
      {error && stat ? <div className="agb-err">{stat}</div> : null}
      {summary ? (
        <button
          type="button"
          className="agb-foot"
          onClick={() => setOpen((o) => !o)}
          title={open ? "clip the brief" : "the whole brief"}
        >
          <span>{open ? "\u2303" : "\u2304"} BRIEF</span>
          <i aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

/** One delegation inside a fan: its agent, what it was asked for, and where it
 *  got to. No clock of its own — one interval per row to say what the block's
 *  own clock already says. */
function AgentFanRow({ run }: { run: AgentRun }) {
  const { name, summary, meta, ms, stat, error, running } = run;
  const label = meta?.type || (name === "Skill" ? "SKILL" : "AGENT");
  const said = meta?.title || summary;
  return (
    <div
      className="agb-fan"
      data-state={running ? "run" : error ? "err" : "done"}
      style={{ "--h": agentHue(run) } as React.CSSProperties}
    >
      <i className="agb-dot" aria-hidden />
      <span className="t" title={label}>{label}</span>
      <span className="d" title={said}>{said}</span>
      <span className="n">{error ? "FAILED" : running ? "" : stat || slow(ms)}</span>
    </div>
  );
}

/** A run of delegations under one frame, drawn as the fan it is: a diamond per
 *  agent, the ones still out lit. It says how many ran, not that they ran at
 *  once — the event stream can't tell a fan-out from four in a row. */
function AgentFan({ runs, animate }: { runs: AgentRun[]; animate: boolean }) {
  const live = runs.filter((r) => r.running).length;
  const total = runs.reduce((t, r) => t + (r.ms ?? 0), 0);
  return (
    <div
      className="agb panel"
      data-run={live ? "" : undefined}
      style={{
        ...({ "--h": "var(--acc)" } as React.CSSProperties),
        ...(animate ? { animation: "streamIn .34s cubic-bezier(.2,.8,.2,1) both" } : {}),
      }}
    >
      <i className="agb-rail" aria-hidden />
      {live ? <span className="agb-sweep" aria-hidden><i /></span> : null}
      <AgentHead
        kind="AGENTS"
        type={`${runs.length} RUNS`}
        running={!!live}
        nums={
          live ? (
            <><span style={{ color: "var(--h)" }}>{live} WORKING</span>{animate ? <LiveClock /> : null}</>
          ) : slow(total) ? <span>{dur(total)}</span> : null
        }
      />
      {runs.map((r, k) => <AgentFanRow key={k} run={r} />)}
    </div>
  );
}

/** Thumbnails for images a tool returned, clickable into the lightbox the
 *  transcript already uses for prompt attachments. The upload dir is pruned by
 *  age, so an old turn's screenshot 404s — that row just disappears rather than
 *  leaving a broken-image glyph. */
function ToolImages({ paths }: { paths: string[] }) {
  const [zoom, setZoom] = useState<string | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const live = paths.filter((p) => !gone.has(p));
  if (!live.length) return null;
  return (
    <div className="mt-2 ml-[var(--rail)] flex flex-wrap gap-2">
      {zoom && <ImageLightbox src={zoom} onClose={() => setZoom(null)} />}
      {live.map((p) => {
        const src = api.attachmentUrl(p);
        return (
          <ZoomButton key={p} onOpen={() => setZoom(src)}>
            <img
              src={src}
              alt="tool output"
              onError={() => setGone((g) => new Set(g).add(p))}
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
  const tag = kind === "mcp" ? toolTag(name) : kind.toUpperCase();
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
      <div className="ax-winhead">
        <span className="ax-wintag truncate">{tag}</span>
        <i className="ax-winrule" aria-hidden />
        <span className="ax-winmeta">
          <span>{calls.length} CALLS</span>
          {slow(total) && <span>{dur(total)}</span>}
        </span>
      </div>
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

  return (
    <ActionRow
          t={t}
      tier={toolTier(name)}
      shape={toolShape(name)}
      accent={toolAccent(name)}
      tag={toolTag(name)}
      animate={animate}
      error={error}
      stat={<Took ms={ms} stat={stat} error={error} />}
    >
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
  text, onQuote, children,
}: {
  text: string;
  onQuote?: (text: string) => void;
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
    return t;
  }

  return (
    <>
      <div
        ref={ref}
        // Colours live in .abub (index.css) rather than inline: a style has to
        // be able to take the fill off, and nothing overrides an inline rule.
        className="abub min-w-0 max-w-[78%] break-words border border-l-[3px] px-2.5 py-1.5 text-foreground-bright"
      >
        {children}
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
      <i className="ax-bar" aria-hidden />
      <span className="ax-tagcell">
        <span className="ax-tag" data-shape="bare">
          <Layers size={11} aria-hidden />
          LOOKUPS
        </span>
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
  toolStyle = "stamp",
  turnStarted,
  onRunCommand,
  onQuote,
  onOpenFile,
  onAnswer,
  ended = false,
  showAll = false,
  boot = null,
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
  /** Ctrl-F mounted the whole transcript — the tail cap would hide text the
   *  browser's find is about to look for. */
  showAll?: boolean;
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
  // Derived from the length rather than stored as an index, so a running turn's
  // window slides with its tail instead of freezing where it was opened.
  const [wholeTurn, setWholeTurn] = useState(false);
  const tailFrom = wholeTurn || showAll ? 0 : Math.max(0, events.length - TURN_TAIL);
  const pendingIds = new Set(pending.map((p) => p.request_id));
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

  // Only the quiet steps fold away — a terminal, a diff, a delegated run, a
  // fetch or an MCP call each carry their own block and break the run instead.
  // A glance that came back with a shot carries one too: chips would hide the
  // picture, which is the whole result.
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

  // Never cut a folded run away from the head that draws it. A cut that ends up
  // hiding only a handful buys nothing and reads as a button in front of
  // nothing, so it collapses to showing the lot.
  const cut = headSafeCut(events.length, tailFrom, headOf, groupOf);
  const from = cut < TURN_TAIL_MIN ? 0 : cut;

  // The turn's closing text arrives twice — once streamed as a text block, once
  // as the run's result — so the same words used to print twice, the second time
  // in the RESULT box. Only the box is drawn. A native session emits no result
  // event, so its final text keeps rendering as text.
  const resultText = (events.find((e) => e.type === "result")?.result ?? "").trim();

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

  return (
    // vskip-card: a turn runs to hundreds of events, so each card skips layout
    // and paint while it's off-screen (see .vskip-card in index.css).
    <div className="space-y-2 vskip-card">
      {boot ? <BootRow text={boot} /> : null}
      {from > 0 && (
        <button
          type="button"
          onClick={() => setWholeTurn(true)}
          className="ml-[var(--rail)] flex items-center gap-1.5 border border-border px-2.5 py-1 text-[length:var(--t95)] tracking-[1px] text-muted-2 hover:text-foreground-bright"
        >
          <ChevronsUp size={11} aria-hidden />
          {from} EARLIER STEP{from === 1 ? "" : "S"}
        </button>
      )}
      {/* Indices stay absolute: foldChips, runsOf and the tool_done pairing all
          key off position in the full array. */}
      {events.slice(from).map((event, k) => {
        const i = k + from;
        switch (event.type) {
          case "text": {
            const text = event.text;
            if (!text) return null;
            if (resultText && text.trim() === resultText) return null;
            if (asksNext(i))
              return (
                <FinalResult
                  key={i}
                  result={text}
                  label="RESULT // ASK"
                  animate={animate}
                  idKey={`${turnId}:${i}`}
                />
              );
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
                <MessageBlock text={text} onQuote={onQuote}>
                  <Markdown className="leading-relaxed" onOpenFile={onOpenFile} toolStyle={toolStyle}>{text}</Markdown>
                </MessageBlock>
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
            const spec = widgetForRun(run.map((j) => doneOf(events[j])));
            // Hung under whichever card this tool got, not just the default one:
            // a Read of a PNG returns an image and takes the ReadCard branch, and
            // that is 715 of the 729 image results in this store — a widget only
            // the default branch could show would be one almost nobody sees.
            // Every style draws its widget now: PLAIN, the one that opted out
            // of them, has no column on the sheet and was replaced by a fifth
            // look (lib/toolwidget TOOL_STYLES).
            const extra = spec ? (
              <div className="ml-[var(--rail)]">
                <ToolWidget spec={spec} accent={toolAccent(event.name)} style={toolStyle} />
              </div>
            ) : done?.images?.length ? <ToolImages paths={done.images} /> : null;
            const withExtra = (node: ReactNode) =>
              extra ? <div key={i}>{node}{extra}</div> : node;
            // A delegation is a turn nested inside this one, so it is drawn as
            // its own framed block — and a run of them as one fan, not as N
            // identical rows or a generic "AGENT · 4 CALLS" box.
            if (toolKind(event.name) === "agent") {
              const runs = run.map((j) => {
                const e = events[j] as { name: string; summary: string; agent?: AgentMeta };
                const d = doneOf(events[j]);
                return { name: e.name, summary: e.summary, meta: e.agent, ms: d?.ms,
                         stat: d?.stat, error: d?.is_error, running: !d };
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
                  <div className="mt-2 ml-[var(--rail)]"><ErrLine text={done.stat} /></div>
                ) : null}
                {extra}
              </div>
            );
          }
          case "thinking":
            // A pause swallowed by a group is drawn by nobody: its mark would
            // land at the foot of the card instead of between the rows it fell
            // between, and two of them would stack on the same pixel.
            if (!event.text)
              return event.ms && !insideRun(i, groups, folds) ? <GapMark key={i} ms={event.ms} /> : null;
            return <ThinkingRow key={i} ms={event.ms} text={event.text} animate={animate} />;
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
            // Sent into this turn while it was already running — drawn with the
            // prompt bubble's geometry (right-aligned, bordered, tinted) so it
            // reads as the user speaking, not another agent row; violet + the
            // STEER tag keep it distinct from the turn-opening prompt.
            return (
              <div key={i} id={ckId(turnId, steerKey(i))} className="my-2 flex scroll-mt-[44px] justify-end">
                <div
                  className="max-w-[78%] border border-r-[3px] px-3 py-1.5"
                  style={{
                    borderColor: "color-mix(in srgb, var(--violet) 26%, transparent)",
                    borderRightColor: "var(--violet)",
                    background: "color-mix(in srgb, var(--violet) 7%, transparent)",
                  }}
                >
                  <div className="mb-0.5 flex items-center justify-end gap-1.5 text-[length:var(--t10)] tracking-[1.6px] text-[var(--violet)]">
                    STEER <SteerIcon size={11} />
                  </div>
                  <span className="block whitespace-pre-wrap break-words text-[length:var(--t12)] leading-relaxed text-foreground-bright">
                    {event.text}
                  </span>
                  {event.images && event.images.length > 0 && (
                    <ToolImages paths={event.images} />
                  )}
                </div>
              </div>
            );
          case "result":
            return (
              <FinalResult
                key={i}
                result={event.result}
                elapsed={event.elapsed}
                tokens={tokens}
                isError={event.is_error}
                animate={animate}
                idKey={`${turnId}:${i}`}
                onAnswer={onAnswer}
                onQuote={onQuote}
              />
            );
          case "error":
            return (
              <div
                key={i}
                className="ml-[var(--rail)] flex items-start gap-1.5 rounded-lg bg-red-500/15 px-2 py-1 text-sm text-red-300"
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
              <div key={i} id={ckId(turnId, event.request_id)} className="ml-[var(--rail)] scroll-mt-[44px]">
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
                className="ml-[var(--rail)] flex items-center gap-1.5 text-xs text-[var(--tg-hint)]"
              >
                <CircleStop
                  size={14}
                  className="shrink-0 text-[var(--brand-soft)]"
                  aria-hidden
                />
                <span>Stopped — send a message to continue.</span>
              </div>
            );
          case "permission_resolved":
          case "question_answered":
            return null; // shown inside the relevant card
        }
      })}
    </div>
  );
});

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
            {o}
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

function FinalResult({
  result,
  elapsed,
  tokens,
  isError,
  animate,
  idKey,
  label,
  onAnswer,
  onQuote,
}: {
  result: string;
  elapsed?: number;
  tokens?: number | null;
  isError?: boolean;
  animate: boolean;
  idKey: string;
  /** Overrides "RESULT // OK" — the accent-toned box drawn above a question card. */
  label?: string;
  onAnswer?: (text: string) => void;
  onQuote?: (text: string) => void;
}) {
  const flash = animate && !typedResults.has(idKey);
  const tone = isError ? "var(--err)" : label ? "var(--acc)" : "var(--ok)";
  // The model asked in prose instead of using a question card: lift the question
  // out of the body so it reads as an ask, and offer the answers it expected.
  const ask = onAnswer && !isError ? askBack(result) : null;
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
    <div className="resblk relative my-2 pl-[var(--rail)]" style={{ "--tone": tone } as React.CSSProperties}>
      <RailNode />
      <div
        className="res group/res"
        style={flash ? { animation: "resultflash 1.2s ease both" } : undefined}
      >
        <div className="res-head">
          <span className="res-lab">{label ?? `RESULT // ${isError ? "ERROR" : "OK"}`}</span>
          <span className="res-meta">
            {typeof elapsed === "number" && elapsed > 0 && (
              <span title="wall time">{elapsed < 60 ? `${Math.round(elapsed)}S` : `${(elapsed / 60).toFixed(1)}M`}</span>
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
        {body && (
          <div className="res-body relative">
            <div className={open ? undefined : "max-h-[380px] overflow-hidden"}>
              <Typewriter text={body} animate={animate} idKey={idKey} className="leading-relaxed text-foreground-bright" />
            </div>
            {!open && <div className="res-fade" aria-hidden />}
          </div>
        )}
        {ask && <AskBackBar ask={ask} onAnswer={onAnswer!} onQuote={onQuote} />}
        {body && lines > RESULT_FOLD_LINES && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
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
