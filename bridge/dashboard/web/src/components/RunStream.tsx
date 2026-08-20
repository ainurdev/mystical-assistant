import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import {
  TriangleAlert, CircleStop, Copy, Check, RotateCw, ChevronDown, ChevronsUp,
  Search, Globe, Bot, ListChecks, Plug, Quote,
  BookOpen, PenLine, GitCompare, Terminal, Wrench, Layers, Brain,
  GitBranch, FileText, FilePen, Trash2, FolderTree, Play, Package,
  FlaskConical, Cpu, Database, Container,
} from "lucide-react";
import { api, type AnswerSelection, type RunEvent } from "../api";
import type { PendingRequest } from "../chat";
import { SteerIcon } from "./Composer";
import { Markdown, type OpenFile } from "./Markdown";
import { FileIcon } from "../lib/fileicon";
import { PermissionCard } from "./PermissionCard";
import { QuestionCard } from "./QuestionCard";
import { ImageLightbox, ZoomButton } from "./ImageLightbox";
import { askBack, type AskBack } from "../lib/askback";
import { ckId, steerKey } from "../lib/checkpoints";
import { foldChips, runsOf, headSafeCut, insideRun } from "../lib/toolfold";
import { cmdAbstract, cmdKind, hostOf, mcpParts, toolAccent, toolKind, type CmdKind } from "../lib/tools";

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

/** Tool kinds that draw a block of their own, so they never fold into a
 *  "N STEPS" chip with the quiet lookups. */
const BLOCK_KINDS = new Set(["bash", "agent", "web", "mcp"]);

/** Every tool card is drawn in its own accent (see lib/tools) — this is the two
 *  edges that accent draws: the card's hairline and the tag's box. */
const edge = (accent: string) => `color-mix(in srgb, ${accent} 24%, transparent)`;
const tagEdge = (accent: string) => `color-mix(in srgb, ${accent} 35%, transparent)`;

type Done = { ms?: number; output?: string; is_error?: boolean; patch?: string[]; stat?: string; images?: string[] };

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
function Lights({ accent, running }: { accent: string; running: boolean }) {
  return (
    <span className="flex flex-none gap-[3px]" aria-hidden>
      <i
        className="block h-[5px] w-[5px]"
        style={{ background: accent, animation: running ? "blink 1.1s steps(1) infinite" : undefined }}
      />
      <i className="block h-[5px] w-[5px] bg-[var(--txl)]" />
      <i className="block h-[5px] w-[5px] bg-[var(--txg)]" />
    </span>
  );
}

type Cmd = { command: string; done?: Done };

/** One command inside a terminal window: the prompt line is the toggle for its
 *  own output, so a long run reads as a list of commands until you open one.
 *  Stays shut by default; with AUTO-OPEN RESULTS on it opens itself while it
 *  runs, when it fails, and for the newest command. */
function CommandRow({
  command,
  done,
  newest,
  animate,
  autoOpen,
  lights,
  onRerun,
}: Cmd & {
  newest: boolean;
  animate: boolean;
  autoOpen: boolean;
  lights?: boolean;
  onRerun?: (command: string) => void;
}) {
  const running = !done;
  const failed = !!done?.is_error;
  const raw = (done?.output ?? "").trimEnd();
  const exit = raw.match(EXIT_RE);
  const out = exit ? raw.slice(exit[0].length) : raw;
  const lines = out ? out.split("\n").length : 0;
  const [open, setOpen] = useState(autoOpen && (running || failed || newest));
  // Colour is for exceptions: a command that simply worked stays quiet.
  const tint = failed ? "var(--err)" : running ? "var(--warn)" : "var(--muted-2)";
  const Icon = CMD_ICON[cmdKind(command)];
  // What the command did, in words. Empty when nothing beats the line itself,
  // and never while the row is open — reading output next to a paraphrase of
  // the command that made it is worse than reading the command.
  const said = open ? "" : cmdAbstract(command);

  return (
    <div
      className="group/cmd border-t border-border first:border-t-0"
      style={animate ? { animation: "termLine .3s cubic-bezier(.2,.8,.2,1) both" } : undefined}
    >
      <div className="flex items-start gap-1 px-2.5 py-1.5 transition-colors duration-200 hover:bg-[var(--ac-03)]">
        {lights && (
          <span className="mt-[6px] mr-1 flex-none">
            <Lights accent={failed ? "var(--err)" : running ? "var(--warn)" : "var(--ok)"} running={running} />
          </span>
        )}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          title={open ? "hide output" : "show output"}
          className="flex min-w-0 flex-1 items-start gap-1.5 text-left"
        >
          <span
            className={`mt-[3px] flex-none ${running ? "animate-pulse motion-reduce:animate-none" : ""}`}
            aria-hidden
            style={{ color: tint }}
          >
            <Icon size={12} />
          </span>
          <span
            className={`min-w-0 flex-1 font-mono text-[length:var(--t12)] leading-relaxed text-foreground-bright ${
              open ? "whitespace-pre-wrap break-all" : "truncate"
            }`}
          >
            {said ? (
              // A cut, not a fade. Cross-fading the two leaves ~70ms where both
              // are legible on top of each other, which is worse than any hard
              // swap; staggering them blanks the row instead, and a hover-intent
              // delay makes the row feel unresponsive. The tint carries the
              // smoothness — the text just changes.
              <>
                <span className="font-sans group-hover/cmd:hidden">{said}</span>
                <span className="hidden group-hover/cmd:inline">{command}</span>
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
          </span>
          <span className="mt-[3px] flex flex-none items-center gap-1.5 text-[length:var(--t95)] tracking-[1px] text-muted-2">
            {exit && <span style={{ color: "var(--err)" }}>EXIT {exit[1]}</span>}
            {done?.ms ? (
              <span className={slow(done.ms) ? "" : "opacity-0 transition-opacity group-hover/cmd:opacity-100"}>
                {dur(done.ms)}
              </span>
            ) : null}
            {lines > 0 && <span>{lines}L</span>}
          </span>
        </button>
        <span className="mt-[2px] flex flex-none items-center gap-1.5 opacity-0 transition-opacity group-hover/cmd:opacity-100">
          <CopyBtn text={command} title="copy command" />
          {onRerun && (
            <HeadBtn title="run this again in a terminal" onClick={() => onRerun(command)}>
              <RotateCw size={12} aria-hidden />
            </HeadBtn>
          )}
        </span>
        <span className="mt-[2px] flex flex-none items-center">
          <HeadBtn title={open ? "hide output" : "show output"} onClick={() => setOpen((o) => !o)}>
            <ChevronDown
              size={12}
              aria-hidden
              className={`transition-transform duration-200 ${open ? "" : "-rotate-90"}`}
            />
          </HeadBtn>
        </span>
      </div>
      {open && lines > 0 && (
        <pre
          className="max-h-[280px] overflow-auto whitespace-pre-wrap break-all px-2.5 pb-2 pl-[30px] text-[length:var(--t115)] leading-[1.55]"
          style={{
            color: failed ? "var(--err)" : "var(--muted-foreground)",
            animation: "termOpen .2s ease both",
          }}
        >
          {out}
        </pre>
      )}
    </div>
  );
}

/** A run of Bash calls drawn as the one terminal they actually ran in: a single
 *  window, one prompt line per command, each opening its own output. */
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

  return (
    <div
      className="my-1.5 ml-[18px] border bg-[var(--code-bg)]"
      style={{
        borderColor: failed ? "color-mix(in srgb, var(--err) 32%, transparent)" : "var(--border)",
        ...(animate ? { animation: "termIn .42s cubic-bezier(.2,.8,.2,1) both" } : {}),
      }}
    >
      {cmds.length > 1 && (
        <div className="flex items-center gap-2 border-b border-border bg-[var(--ac-03)] px-2.5 py-1">
          <Lights accent={accent} running={running} />
          <span className="flex flex-none items-center gap-1.5 text-[length:var(--t95)] tracking-[2px]" style={{ color: accent }}>
            <Terminal size={11} aria-hidden />
            BASH // {running ? "RUNNING" : failed ? "FAILED" : "OK"}
          </span>
          <span className="flex-none text-[length:var(--t95)] tracking-[1px] text-muted-2">· {cmds.length} CMDS</span>
          {slow(ms) && (
            <span className="flex-none text-[length:var(--t95)] tracking-[1px] text-muted-2">· {dur(ms)}</span>
          )}
        </div>
      )}
      {cmds.map((c, k) => (
        <CommandRow
          key={k}
          command={c.command}
          done={c.done}
          lights={cmds.length === 1}
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
 *  what changed instead of just which file was touched. The header is the toggle
 *  for its own body: `shownMax` is 0 (shut, the default), a preview, or all of
 *  it — one state instead of a collapsed flag plus an expanded one. */
function DiffBlock({
  name,
  path,
  patch,
  ms,
  animate,
  autoOpen,
}: {
  name: string;
  path: string;
  patch: string[];
  ms?: number;
  animate: boolean;
  autoOpen: boolean;
}) {
  const [shownMax, setShownMax] = useState(autoOpen ? DIFF_PREVIEW : 0);
  const shown = patch.slice(0, shownMax);
  const hidden = patch.length - shown.length;
  const add = patch.filter((l) => l.startsWith("+")).length;
  const del = patch.filter((l) => l.startsWith("-")).length;

  return (
    <div
      className="my-1.5 ml-[18px] border border-[color-mix(in_srgb,var(--ok)_24%,transparent)] bg-[var(--code-bg)]"
      style={animate ? { animation: "streamIn .34s cubic-bezier(.2,.8,.2,1) both" } : undefined}
    >
      <div className="flex items-center gap-2 border-b border-[color-mix(in_srgb,var(--ok)_16%,transparent)] bg-[var(--ac-03)] px-2.5 py-1 hover:bg-[var(--ac-03)]">
        <button
          type="button"
          onClick={() => setShownMax((m) => (m ? 0 : DIFF_PREVIEW))}
          title={shownMax ? "hide the diff" : "show the diff"}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="flex flex-none items-center gap-1.5 text-[length:var(--t95)] tracking-[2px] text-success">
            <GitCompare size={11} aria-hidden />
            {name.toUpperCase()} //
          </span>
          <FileIcon name={path} size={12} />
          <span className="min-w-0 truncate font-mono text-[length:var(--t11)] text-foreground-bright">{path}</span>
          {slow(ms) ? (
            <span className="flex-none text-[length:var(--t95)] tracking-[1px] text-muted-2">· {dur(ms)}</span>
          ) : null}
          <ChevronDown
            size={12}
            aria-hidden
            className={`ml-auto flex-none text-muted-2 transition-transform duration-200 ${shownMax ? "" : "-rotate-90"}`}
          />
        </button>
        <span className="flex flex-none items-center gap-1.5">
          <span className="text-[length:var(--t95)] tracking-[1px]">
            <span style={{ color: "var(--ok)" }}>+{add}</span>{" "}
            <span style={{ color: "var(--err)" }}>−{del}</span>
          </span>
          {shownMax > 0 && hidden > 0 && (
            <HeadBtn title="show the whole diff" onClick={() => setShownMax(patch.length)}>
              +{hidden} LINES ⌄
            </HeadBtn>
          )}
        </span>
      </div>
      <div className="overflow-x-auto px-2.5 py-1.5 font-mono text-[length:var(--t115)] leading-[1.55] empty:hidden">
        {shown.map((line, i) => (
          <div key={i} className="whitespace-pre" style={{ color: diffColor(line) }}>
            {line || " "}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The directory takes the truncation, the filename never gets cut. */
function FilePath({ path }: { path: string }) {
  const cut = path.lastIndexOf("/");
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-[length:var(--t12)]" title={path}>
      <FileIcon name={path} size={12} />
      <span className="truncate text-muted-2">{cut >= 0 ? path.slice(0, cut + 1) : ""}</span>
      <span className="flex-none text-foreground-bright">{path.slice(cut + 1)}</span>
    </span>
  );
}

/** The right-hand end of a tool card: what came back, then how long it took.
 *  Both are optional — an unfinished call has neither. */
function Took({ ms, stat, error }: { ms?: number; stat?: string; error?: boolean }) {
  if (!slow(ms) && !stat) return null;
  return (
    <span className="flex flex-none items-center gap-1.5 text-[length:var(--t95)] tracking-[1px]">
      {stat && (
        <span className="max-w-[220px] truncate" style={error ? { color: "var(--err)" } : undefined} title={stat}>
          {stat}
        </span>
      )}
      {stat && slow(ms) ? <span className="text-muted-2" aria-hidden>·</span> : null}
      {slow(ms) ? <span className="text-muted-2">{dur(ms)}</span> : null}
    </span>
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

/** A pause with nothing recorded but its length. A row of its own said only
 *  "there was a gap" four times a turn, so it rides the top edge of whatever ran
 *  next instead — a hairline slot of its own, right edge in the same column as
 *  the rows' chevrons, so it lines up instead of floating over the card.
 *  contentVisibility has to be inline: `.vskip-card > *` hands every child
 *  `content-visibility: auto`, a zero-height child reads as off-screen to the
 *  skipper, and its label never paints. A utility class ties on specificity and
 *  loses, being layered. */
function GapMark({ ms }: { ms: number }) {
  return (
    <div aria-hidden className="pointer-events-none relative z-10 h-0"
         style={{ contentVisibility: "visible" }}>
      <span className="absolute right-[11px] -top-[6px] text-[length:var(--t95)] tracking-[1px] text-muted-2">
        +{dur(ms)}
      </span>
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
      <span className="flex flex-none items-center gap-1.5 text-[length:var(--t10)] tracking-[2px]">
        <Brain size={11} aria-hidden />
        THOUGHT
      </span>
      {peek && !open ? (
        <span className="min-w-0 flex-1 truncate text-[length:var(--t11)] italic opacity-75">{peek}</span>
      ) : (
        <span aria-hidden className="h-px flex-1 bg-border" />
      )}
      <span className="flex-none text-[length:var(--t95)] tracking-[1px]">{slow(ms)}</span>
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
      className="my-1.5 ml-[18px] text-muted-2"
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
      className="my-1.5 ml-[18px] text-muted-2"
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

/** A read is a page glanced at: no box at all — a hairline gutter, the path, and
 *  the page's own ruled lines at the end, with a scanline crossing it once. The
 *  quietest card in a turn, because looking at a file changed nothing. */
function ReadCard({ path, ms, stat, error, animate }:
  { path: string; ms?: number; stat?: string; error?: boolean; animate: boolean }) {
  const accent = toolAccent("Read");
  return (
    <div
      className="relative my-1.5 ml-[18px] flex items-center gap-2.5 overflow-hidden py-1 pl-2.5 pr-2.5"
      style={{
        background: `linear-gradient(90deg, color-mix(in srgb, ${accent} 8%, transparent), transparent 55%)`,
        ...(animate ? { animation: "readIn .3s cubic-bezier(.2,.8,.2,1) both" } : {}),
      }}
    >
      <span className="flex flex-none items-center gap-1.5 text-[length:var(--t10)] tracking-[2px]" style={{ color: accent }}>
        <BookOpen size={11} aria-hidden />
        READ
      </span>
      <span aria-hidden className="h-3 w-px flex-none" style={{ background: tagEdge(accent) }} />
      <FilePath path={path} />
      {/* the lines of the page we read but don't show */}
      <span aria-hidden className="flex flex-none flex-col gap-[2px] opacity-45">
        {[14, 9, 12].map((w) => (
          <i key={w} className="block h-px" style={{ width: w, background: accent }} />
        ))}
      </span>
      <Took ms={ms} stat={stat} error={error} />
      {animate && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 h-px"
          style={{ background: accent, boxShadow: `0 0 8px ${accent}`, animation: "scanread .6s ease-out both" }}
        />
      )}
    </div>
  );
}

/** A write is a file changed: boxed, a solid bar down the side and the tag filled
 *  in rather than outlined — the loudest one-line card, because it did something.
 *  Written on left to right. */
function WriteCard({
  name,
  path,
  ms,
  stat,
  error,
  animate,
}: {
  name: string;
  path: string;
  ms?: number;
  stat?: string;
  error?: boolean;
  animate: boolean;
}) {
  const accent = toolAccent(name);
  return (
    <div
      className="relative my-1.5 ml-[18px] flex items-center gap-2.5 overflow-hidden border border-l-[3px] bg-[var(--ac-03)] py-1.5 pl-2.5 pr-2.5"
      style={{
        borderColor: edge(accent),
        borderLeftColor: accent,
        ...(animate ? { animation: "writeOn .42s cubic-bezier(.2,.8,.2,1) both" } : {}),
      }}
    >
      <span
        className="flex flex-none items-center gap-1.5 px-1.5 py-px text-[length:var(--t10)] tracking-[1px]"
        style={{ background: accent, color: "var(--acc-on)" }}
      >
        <PenLine size={11} aria-hidden />
        {name.toUpperCase()}
      </span>
      <FilePath path={path} />
      <Took ms={ms} stat={stat} error={error} />
    </div>
  );
}

/** The shell the one-line tool cards share: a hairline box in the tool's accent,
 *  an icon + tag, that tool's own line, then how long it took. */
function ToolBox({
  accent,
  tag,
  icon,
  ms,
  stat,
  error,
  animate,
  children,
}: {
  accent: string;
  tag: string;
  icon: React.ReactNode;
  ms?: number;
  stat?: string;
  error?: boolean;
  animate: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="my-1.5 ml-[18px] flex items-center gap-2.5 border bg-[var(--ac-03)] px-2.5 py-1.5"
      style={{
        borderColor: edge(accent),
        ...(animate ? { animation: "streamIn .34s cubic-bezier(.2,.8,.2,1) both" } : {}),
      }}
    >
      <span
        className="flex flex-none items-center gap-1.5 border px-1.5 py-px text-[length:var(--t10)] tracking-[1px]"
        style={{ color: accent, borderColor: tagEdge(accent) }}
      >
        {icon}
        {tag}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--t12)] text-muted-foreground">
        {children}
      </span>
      <Took ms={ms} stat={stat} error={error} />
    </div>
  );
}

/** A lookup is a query typed into a field: everything dashed, because nothing here
 *  is committed yet — the pattern sits in its own inset box, as entered. */
function SearchCard({
  name,
  summary,
  ms,
  stat,
  error,
  animate,
}: {
  name: string;
  summary: string;
  ms?: number;
  stat?: string;
  error?: boolean;
  animate: boolean;
}) {
  const accent = toolAccent(name);
  return (
    <div
      className="my-1.5 ml-[18px] flex items-center gap-2.5 border border-dashed px-2.5 py-1.5"
      style={{
        borderColor: tagEdge(accent),
        ...(animate ? { animation: "streamIn .34s cubic-bezier(.2,.8,.2,1) both" } : {}),
      }}
    >
      <span className="flex flex-none items-center gap-1.5 text-[length:var(--t10)] tracking-[1px]" style={{ color: accent }}>
        <Search size={11} aria-hidden />
        {name.toUpperCase()}
      </span>
      <span
        className="min-w-0 flex-1 truncate border border-dashed px-1.5 py-px font-mono text-[length:var(--t12)] text-foreground-bright"
        style={{ borderColor: edge(accent) }}
      >
        {summary}
      </span>
      <Took ms={ms} stat={stat} error={error} />
    </div>
  );
}

/** The one round card in a square UI, because the web is not this machine: a
 *  browser's address bar, host first, the rest of the URL dimmed behind it. */
function WebCard({
  name,
  summary,
  ms,
  stat,
  error,
  animate,
}: {
  name: string;
  summary: string;
  ms?: number;
  stat?: string;
  error?: boolean;
  animate: boolean;
}) {
  const accent = toolAccent(name);
  const host = hostOf(summary);
  return (
    <div
      className="my-1.5 ml-[18px] flex items-center gap-2 rounded-full border bg-[var(--ac-03)] py-1 pl-1.5 pr-3"
      style={{
        borderColor: edge(accent),
        ...(animate ? { animation: "streamIn .34s cubic-bezier(.2,.8,.2,1) both" } : {}),
      }}
    >
      <span
        className="flex flex-none items-center gap-1.5 rounded-full px-2 py-px text-[length:var(--t10)] tracking-[1px]"
        style={{ color: accent, background: `color-mix(in srgb, ${accent} 14%, transparent)` }}
      >
        <Globe size={11} aria-hidden />
        {name === "WebSearch" ? "SEARCH" : "FETCH"}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--t12)] text-muted-foreground">
        {host ? (
          <>
            <span className="text-foreground-bright">{host}</span>
            <span className="text-muted-2">{summary.slice(summary.indexOf(host) + host.length)}</span>
          </>
        ) : (
          `“${summary}”`
        )}
      </span>
      <Took ms={ms} stat={stat} error={error} />
    </div>
  );
}

/** A call out of this process and into another one: no side edges, a patch cable
 *  running from the server's tag across to the tool it reached, then what it was
 *  called with — "get task" alone never said which task. */
function McpCard({
  name,
  summary,
  ms,
  stat,
  error,
  animate,
}: {
  name: string;
  summary: string;
  ms?: number;
  stat?: string;
  error?: boolean;
  animate: boolean;
}) {
  const accent = toolAccent(name);
  const { server, tool } = mcpParts(name);
  return (
    <div
      className="my-1.5 ml-[18px] flex items-center gap-2 border-y bg-[var(--ac-03)] px-2.5 py-1.5"
      style={{
        borderColor: edge(accent),
        ...(animate ? { animation: "streamIn .34s cubic-bezier(.2,.8,.2,1) both" } : {}),
      }}
    >
      <span
        className="flex flex-none items-center gap-1.5 text-[length:var(--t10)] tracking-[1px]"
        style={{ color: accent }}
      >
        <Plug size={11} aria-hidden />
        {server.toUpperCase()}
      </span>
      <span
        aria-hidden
        className="h-px w-5 flex-none"
        style={{ backgroundImage: `repeating-linear-gradient(90deg, ${accent} 0 2px, transparent 2px 5px)` }}
      />
      <span className="flex-none font-mono text-[length:var(--t12)] text-foreground-bright">{tool}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--t12)] text-muted-2">{summary}</span>
      <Took ms={ms} stat={stat} error={error} />
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
    <div className="my-1.5 ml-[18px] flex flex-wrap gap-2">
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

/** A run of back-to-back calls of one kind drawn as one card, the way Bash calls
 *  share a terminal: the tag once in the header, a row per call. Eight MCP calls
 *  used to say the server's name eight times. */
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
  const tag = kind === "mcp" ? mcpParts(name).server : kind;
  const total = calls.reduce((t, c) => t + (c.ms ?? 0), 0);

  return (
    <div
      className="my-1.5 ml-[18px] border bg-[var(--ac-03)]"
      style={{
        borderColor: edge(accent),
        ...(animate ? { animation: "streamIn .34s cubic-bezier(.2,.8,.2,1) both" } : {}),
      }}
    >
      <div
        className="flex items-center gap-2 border-b px-2.5 py-1 text-[length:var(--t95)] tracking-[2px]"
        style={{ borderColor: edge(accent), color: accent }}
      >
        {kind === "mcp" ? <Plug size={11} aria-hidden /> : kind === "web" ? <Globe size={11} aria-hidden /> : <Bot size={11} aria-hidden />}
        <span className="truncate">{tag.toUpperCase()}</span>
        <span className="flex-none tracking-[1px] text-muted-2">· {calls.length} CALLS</span>
        {slow(total) && <span className="flex-none tracking-[1px] text-muted-2">· {dur(total)}</span>}
      </div>
      {calls.map((c, k) => (
        <div key={k} className="border-t border-border first:border-t-0">
          <div className="flex items-center gap-2.5 px-2.5 py-1">
            <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--t12)] text-foreground-bright">
              {callLine(c.name, c.summary)}
            </span>
            <Took ms={c.ms} stat={c.error ? undefined : c.stat} error={c.error} />
          </div>
          {c.error && c.stat ? (
            <div className="px-2.5 pb-1.5"><ErrLine text={c.stat} /></div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** A delegated run (Task / Skill): a rail down the side and the brief it was
 *  handed, which is a paragraph, not a path — so it wraps instead of truncating. */
function AgentCard({
  name,
  summary,
  ms,
  stat,
  error,
  animate,
}: {
  name: string;
  summary: string;
  ms?: number;
  stat?: string;
  error?: boolean;
  animate: boolean;
}) {
  const accent = toolAccent(name);
  return (
    <div
      className="my-1.5 ml-[18px] flex items-start gap-2.5 border border-l-2 bg-[var(--ac-03)] px-2.5 py-1.5"
      style={{
        borderColor: edge(accent),
        borderLeftColor: accent,
        ...(animate ? { animation: "streamIn .34s cubic-bezier(.2,.8,.2,1) both" } : {}),
      }}
    >
      <span
        className="mt-px flex flex-none items-center gap-1.5 border px-1.5 py-px text-[length:var(--t10)] tracking-[1px]"
        style={{ color: accent, borderColor: tagEdge(accent) }}
      >
        <Bot size={11} aria-hidden />
        {name.toUpperCase()}
      </span>
      <span className="min-w-0 flex-1 line-clamp-2 text-[length:var(--t12)] leading-relaxed text-muted-foreground">
        {summary}
      </span>
      <span className="mt-[3px]"><Took ms={ms} stat={stat} error={error} /></span>
    </div>
  );
}

/** Everything that isn't a terminal, a file, or a diff — each family drawn as
 *  what it actually did: a lookup, a fetch, a delegated run, a plan, an MCP call. */
function ToolCard({
  name,
  summary,
  ms,
  stat,
  error,
  animate,
}: {
  name: string;
  summary: string;
  ms?: number;
  stat?: string;
  error?: boolean;
  animate: boolean;
}) {
  const kind = toolKind(name);
  const rest = { ms, stat, error, animate };

  if (kind === "agent") return <AgentCard name={name} summary={summary} {...rest} />;
  if (kind === "mcp") return <McpCard name={name} summary={summary} {...rest} />;
  if (kind === "web") return <WebCard name={name} summary={summary} {...rest} />;
  if (kind === "search") return <SearchCard name={name} summary={summary} {...rest} />;
  if (kind === "plan")
    return (
      <ToolBox
        accent={toolAccent(name)}
        tag="PLAN"
        icon={<ListChecks size={11} aria-hidden />}
        {...rest}
      >
        {summary || "checklist updated"}
      </ToolBox>
    );

  return (
    <ToolBox
      accent={toolAccent(name)}
      tag={name.toUpperCase()}
      icon={<Wrench size={11} aria-hidden />}
      {...rest}
    >
      {summary}
    </ToolBox>
  );
}

/** One block of the model's prose, with the two things you actually want to do
 *  with it. The buttons float over the text on hover rather than taking a row of
 *  their own — a transcript is mostly prose, and a permanent toolbar per
 *  paragraph would read as chrome. */
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
    <div ref={ref} className="group/msg relative">
      {children}
      <div className="absolute right-1 top-0 flex gap-1 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100">
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
    </div>
  );
}

/** A run of plain lookups (reads, greps, globs) collapsed to one line, so the
 *  turn reads as the commands and edits that actually changed something. */
function FoldedChips({ names, onOpen }: { names: string[]; onOpen: () => void }) {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  const label = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(" · ");
  return (
    <button
      type="button"
      onClick={onOpen}
      title="show these steps"
      className="my-1.5 ml-[18px] flex w-[calc(100%-18px)] items-center gap-2.5 border border-border bg-[var(--ac-03)] px-2.5 py-1.5 text-left hover:border-[var(--border-bright)]"
    >
      <span className="flex flex-none items-center gap-1.5 border border-border px-1.5 py-px text-[length:var(--t10)] tracking-[1px] text-muted-foreground">
        <Layers size={11} aria-hidden />
        {names.length} STEPS
      </span>
      <span className="min-w-0 truncate text-[length:var(--t12)] text-muted-2">{label}</span>
      <span className="ml-auto flex-none text-[length:var(--t10)] text-muted-2">⌄</span>
    </button>
  );
}

type RespondFn = (
  requestId: string,
  opts: { behavior?: "allow" | "deny"; answers?: AnswerSelection[] },
) => void | Promise<boolean | void>;

// Memoized: a long session's past turns keep the same `events`/`pending` arrays
// across polls (see mergeDelta), so only the live turn re-renders.
export const RunStream = memo(function RunStream({
  events,
  pending = [],
  onRespond,
  animate = false,
  turnId = "",
  tokens = null,
  openResults = false,
  onRunCommand,
  onQuote,
  onOpenFile,
  onAnswer,
  ended = false,
  showAll = false,
  boot = null,
}: {
  events: RunEvent[];
  pending?: PendingRequest[];
  onRespond?: RespondFn;
  /** What this turn is waiting on before its first token, or null. */
  boot?: string | null;
  animate?: boolean;
  turnId?: string;
  /** This turn's token spend; null = never reported (unknown, not free). */
  tokens?: number | null;
  openResults?: boolean;
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
  const { folds, headOf } = foldChips(events, (i) => {
    const e = events[i];
    if (e.type !== "tool") return false;
    return BLOCK_KINDS.has(toolKind(e.name)) || !!doneOf(e)?.patch;
  });
  // Back-to-back calls of one kind share a card — Bash a terminal window, the
  // rest a CallGroup; the head draws them all, the rest render nothing. MCP
  // groups by server, so two servers in a row stay two cards.
  const groupKey = (i: number): string | null => {
    const e = events[i];
    if (e.type !== "tool" || doneOf(e)?.patch) return null;
    if (e.name === "Bash") return "bash";
    const kind = toolKind(e.name);
    if (kind === "mcp") return `mcp:${mcpParts(e.name).server}`;
    return BLOCK_KINDS.has(kind) ? kind : null; // the quiet ones fold into chips
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
  const resultText = events.find((e) => e.type === "result")?.result?.trim();

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
          className="ml-[18px] flex items-center gap-1.5 border border-border px-2.5 py-1 text-[length:var(--t95)] tracking-[1px] text-muted-2 hover:text-foreground-bright"
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
          case "text":
            if (resultText && event.text.trim() === resultText) return null;
            if (asksNext(i))
              return (
                <FinalResult
                  key={i}
                  result={event.text}
                  label="RESULT // ASK"
                  animate={animate}
                  idKey={`${turnId}:${i}`}
                />
              );
            return (
              <div key={i} style={animate ? { animation: "streamIn .34s cubic-bezier(.2,.8,.2,1) both" } : undefined}>
                <MessageBlock text={event.text} onQuote={onQuote}>
                  {/* The agent talking, drawn as the mirror of your prompt bubble: a
                      solid bar down the left where yours wears one down the right.
                      Bare prose between boxed, labelled cards is the one thing in a
                      turn with nothing to catch a scrolling eye — and it is the part
                      worth reading. No box and no tag, so it stays the quietest
                      member of the family; just enough edge to be findable. */}
                  <Markdown
                    className="my-2 ml-[18px] border-l-2 border-[var(--acc)] pl-2 leading-relaxed text-[var(--tx)]"
                    onOpenFile={onOpenFile}
                  >{event.text}</Markdown>
                </MessageBlock>
              </div>
            );
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
            if (run.length > 1)
              return (
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
            if (done?.patch)
              return (
                <DiffBlock
                  key={i}
                  name={event.name}
                  path={event.summary}
                  patch={done.patch}
                  ms={done.ms}
                  animate={animate}
                  autoOpen={openResults}
                />
              );
            const kind = toolKind(event.name);
            if (kind === "read" && event.summary)
              return (
                <ReadCard
                  key={i}
                  path={event.summary}
                  ms={done?.ms}
                  stat={done?.stat}
                  error={done?.is_error}
                  animate={animate}
                />
              );
            if (kind === "write" && event.summary)
              return (
                <WriteCard
                  key={i}
                  name={event.name}
                  path={event.summary}
                  ms={done?.ms}
                  stat={done?.stat}
                  error={done?.is_error}
                  animate={animate}
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
                />
                {done?.is_error && done.stat ? (
                  <div className="my-1.5 ml-[18px]"><ErrLine text={done.stat} /></div>
                ) : null}
                {/* Screenshots the tool handed back — Playwright, chrome-devtools,
                    Figma. Drawn under whatever card the tool got, so every kind
                    gets them without each card learning about images. */}
                {done?.images?.length ? <ToolImages paths={done.images} /> : null}
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
            // Sent into this turn while it was already running — shown so the
            // transcript explains why the agent changed course mid-task.
            return (
              <div key={i} id={ckId(turnId, steerKey(i))} className="my-1.5 ml-[18px] scroll-mt-[44px] border-l-2 border-[var(--violet)] py-0.5 pl-2.5 text-[length:var(--t12)] leading-relaxed text-[var(--violet)]">
                <div className="flex items-start gap-2">
                  <span className="mt-0.5"><SteerIcon size={12} /></span>
                  <span>{event.text}</span>
                </div>
                {event.images && event.images.length > 0 && (
                  <ToolImages paths={event.images} />
                )}
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
                className="ml-[18px] flex items-start gap-1.5 rounded-lg bg-red-500/15 px-2 py-1 text-sm text-red-300"
                style={animate ? { animation: "streamIn .34s cubic-bezier(.2,.8,.2,1) both" } : undefined}
              >
                <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
                <span>{event.message}</span>
              </div>
            );
          case "permission":
            return (
              <div key={i} className="ml-[18px]">
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
              <div key={i} id={ckId(turnId, event.request_id)} className="ml-[18px] scroll-mt-[44px]">
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
                className="ml-[18px] flex items-center gap-1.5 text-xs text-[var(--tg-hint)]"
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
    <div
      className="group/res my-2 ml-[18px] border"
      style={{
        borderColor: `color-mix(in srgb, ${tone} 28%, transparent)`,
        background: `color-mix(in srgb, ${tone} 4%, transparent)`,
        animation: flash ? "resultflash 1.2s ease both" : undefined,
      }}
    >
      <div
        className="flex items-center gap-2 border-b px-3 py-1.5 text-[length:var(--t95)] tracking-[2px]"
        style={{ borderColor: `color-mix(in srgb, ${tone} 18%, transparent)`, color: tone }}
      >
        <span>{label ?? `RESULT // ${isError ? "ERROR" : "OK"}`}</span>
        <span className="ml-auto flex items-center gap-2 tracking-[1px] text-muted-2">
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
        <div className="relative px-3 py-2.5">
          <div className={open ? undefined : "max-h-[380px] overflow-hidden"}>
            <Typewriter text={body} animate={animate} idKey={idKey} className="leading-relaxed text-foreground-bright" />
          </div>
          {!open && (
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 h-20"
              style={{ background: "linear-gradient(to bottom, transparent, var(--background))" }}
              aria-hidden
            />
          )}
        </div>
      )}
      {ask && <AskBackBar ask={ask} onAnswer={onAnswer!} onQuote={onQuote} />}
      {lines > RESULT_FOLD_LINES && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center justify-center gap-1.5 border-t px-3 py-1 text-[length:var(--t95)] tracking-[1.5px] text-muted-2 hover:text-foreground-bright"
          style={{ borderColor: `color-mix(in srgb, ${tone} 14%, transparent)` }}
        >
          <ChevronDown size={11} aria-hidden className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
          {open ? "FOLD" : `SHOW ALL // ${lines} LINES`}
        </button>
      )}
    </div>
  );
}
