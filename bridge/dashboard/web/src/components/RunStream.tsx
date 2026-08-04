import { memo, useEffect, useState } from "react";
import {
  TriangleAlert, CircleStop, Copy, Check, RotateCw, ChevronDown,
  Search, Globe, Bot, ListChecks, Plug,
} from "lucide-react";
import type { AnswerSelection, RunEvent } from "../api";
import type { PendingRequest } from "../chat";
import { SteerIcon } from "./Composer";
import { Markdown } from "./Markdown";
import { PermissionCard } from "./PermissionCard";
import { QuestionCard } from "./QuestionCard";
import { ckId, steerKey } from "../lib/checkpoints";
import { foldChips, runsOf } from "../lib/toolfold";
import { hostOf, mcpParts, toolAccent, toolKind } from "../lib/tools";

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

type Done = { ms?: number; output?: string; is_error?: boolean; patch?: string[] };

// Diff lines shown before a block folds — a turn can hold dozens.
const DIFF_PREVIEW = 20;

/** A failed Bash result opens with the shell's status line ("Exit code 2\n…").
 *  It belongs in the header as a badge, not in the body. */
const EXIT_RE = /^(?:Error: )?Exit code (\d+)\n?/;

function dur(ms?: number): string {
  if (!ms) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
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
      className="flex-none px-0.5 text-[10px] leading-none tracking-[1px] text-muted-2 hover:text-foreground-bright"
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
  onRerun,
}: Cmd & {
  newest: boolean;
  animate: boolean;
  autoOpen: boolean;
  onRerun?: (command: string) => void;
}) {
  const running = !done;
  const failed = !!done?.is_error;
  const raw = (done?.output ?? "").trimEnd();
  const exit = raw.match(EXIT_RE);
  const out = exit ? raw.slice(exit[0].length) : raw;
  const lines = out ? out.split("\n").length : 0;
  const [open, setOpen] = useState(autoOpen && (running || failed || newest));
  const dot = failed ? "var(--err)" : running ? "var(--warn)" : "var(--ok)";

  return (
    <div
      className="group/cmd border-t border-border first:border-t-0"
      style={animate ? { animation: "termLine .3s cubic-bezier(.2,.8,.2,1) both" } : undefined}
    >
      <div className="flex items-start gap-1 px-2.5 py-1.5 hover:bg-[var(--ac-03)]">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          title={open ? "hide output" : "show output"}
          className="flex min-w-0 flex-1 items-start gap-1.5 text-left"
        >
          <span
            className="mt-[3px] block h-[5px] w-[5px] flex-none"
            aria-hidden
            style={{ background: dot, animation: running ? "blink 1.1s steps(1) infinite" : undefined }}
          />
          <span className="flex-none select-none font-mono text-[12px] leading-relaxed" style={{ color: "var(--primary)" }}>
            ❯
          </span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed text-foreground-bright">
            {command}
            {running && (
              <span
                className="ml-px inline-block h-[1em] w-[7px] translate-y-[2px] bg-primary align-middle"
                style={{ animation: "caret 1s steps(1) infinite" }}
              />
            )}
          </span>
          <span className="mt-[3px] flex flex-none items-center gap-1.5 text-[9.5px] tracking-[1px] text-muted-2">
            {exit && <span style={{ color: "var(--err)" }}>EXIT {exit[1]}</span>}
            {done?.ms ? <span>{dur(done.ms)}</span> : null}
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
          className="max-h-[280px] overflow-auto whitespace-pre-wrap break-all px-2.5 pb-2 pl-[30px] text-[11.5px] leading-[1.55]"
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
      <div className="flex items-center gap-2 border-b border-border bg-[var(--ac-03)] px-2.5 py-1">
        <span className="flex flex-none gap-[3px]" aria-hidden>
          <i
            className="block h-[5px] w-[5px]"
            style={{
              background: accent,
              animation: running ? "blink 1.1s steps(1) infinite" : undefined,
            }}
          />
          <i className="block h-[5px] w-[5px] bg-[var(--txl)]" />
          <i className="block h-[5px] w-[5px] bg-[var(--txg)]" />
        </span>
        <span className="flex-none text-[9.5px] tracking-[2px]" style={{ color: accent }}>
          BASH // {running ? "RUNNING" : failed ? "FAILED" : "OK"}
        </span>
        {cmds.length > 1 && (
          <span className="flex-none text-[9.5px] tracking-[1px] text-muted-2">· {cmds.length} CMDS</span>
        )}
        {ms > 0 && <span className="flex-none text-[9.5px] tracking-[1px] text-muted-2">· {dur(ms)}</span>}
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
          <span className="flex-none text-[9.5px] tracking-[2px] text-success">
            {name.toUpperCase()} //
          </span>
          <span className="min-w-0 truncate font-mono text-[11px] text-foreground-bright">{path}</span>
          {ms ? (
            <span className="flex-none text-[9.5px] tracking-[1px] text-muted-2">· {dur(ms)}</span>
          ) : null}
          <ChevronDown
            size={12}
            aria-hidden
            className={`ml-auto flex-none text-muted-2 transition-transform duration-200 ${shownMax ? "" : "-rotate-90"}`}
          />
        </button>
        <span className="flex flex-none items-center gap-1.5">
          <span className="text-[9.5px] tracking-[1px]">
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
      <div className="overflow-x-auto px-2.5 py-1.5 font-mono text-[11.5px] leading-[1.55] empty:hidden">
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
    <span className="flex min-w-0 flex-1 font-mono text-[12px]" title={path}>
      <span className="truncate text-muted-2">{cut >= 0 ? path.slice(0, cut + 1) : ""}</span>
      <span className="flex-none text-foreground-bright">{path.slice(cut + 1)}</span>
    </span>
  );
}

function Took({ ms }: { ms?: number }) {
  if (!ms) return null;
  return <span className="flex-none text-[9.5px] tracking-[1px] text-muted-2">{dur(ms)}</span>;
}

/** A read is a page glanced at: no box at all — a hairline gutter, the path, and
 *  the page's own ruled lines at the end, with a scanline crossing it once. The
 *  quietest card in a turn, because looking at a file changed nothing. */
function ReadCard({ path, ms, animate }: { path: string; ms?: number; animate: boolean }) {
  const accent = toolAccent("Read");
  return (
    <div
      className="relative my-1.5 ml-[18px] flex items-center gap-2.5 overflow-hidden py-1 pl-2.5 pr-2.5"
      style={{
        background: `linear-gradient(90deg, color-mix(in srgb, ${accent} 8%, transparent), transparent 55%)`,
        ...(animate ? { animation: "readIn .3s cubic-bezier(.2,.8,.2,1) both" } : {}),
      }}
    >
      <span className="flex-none text-[10px] tracking-[2px]" style={{ color: accent }}>
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
      <Took ms={ms} />
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
  animate,
}: {
  name: string;
  path: string;
  ms?: number;
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
        className="flex-none px-1.5 py-px text-[10px] tracking-[1px]"
        style={{ background: accent, color: "var(--acc-on)" }}
      >
        {name.toUpperCase()}
      </span>
      <FilePath path={path} />
      <Took ms={ms} />
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
  animate,
  children,
}: {
  accent: string;
  tag: string;
  icon: React.ReactNode;
  ms?: number;
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
        className="flex flex-none items-center gap-1.5 border px-1.5 py-px text-[10px] tracking-[1px]"
        style={{ color: accent, borderColor: tagEdge(accent) }}
      >
        {icon}
        {tag}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">
        {children}
      </span>
      <Took ms={ms} />
    </div>
  );
}

/** A lookup is a query typed into a field: everything dashed, because nothing here
 *  is committed yet — the pattern sits in its own inset box, as entered. */
function SearchCard({
  name,
  summary,
  ms,
  animate,
}: {
  name: string;
  summary: string;
  ms?: number;
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
      <span className="flex flex-none items-center gap-1.5 text-[10px] tracking-[1px]" style={{ color: accent }}>
        <Search size={11} aria-hidden />
        {name.toUpperCase()}
      </span>
      <span
        className="min-w-0 flex-1 truncate border border-dashed px-1.5 py-px font-mono text-[12px] text-foreground-bright"
        style={{ borderColor: edge(accent) }}
      >
        {summary}
      </span>
      <Took ms={ms} />
    </div>
  );
}

/** The one round card in a square UI, because the web is not this machine: a
 *  browser's address bar, host first, the rest of the URL dimmed behind it. */
function WebCard({
  name,
  summary,
  ms,
  animate,
}: {
  name: string;
  summary: string;
  ms?: number;
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
        className="flex flex-none items-center gap-1.5 rounded-full px-2 py-px text-[10px] tracking-[1px]"
        style={{ color: accent, background: `color-mix(in srgb, ${accent} 14%, transparent)` }}
      >
        <Globe size={11} aria-hidden />
        {name === "WebSearch" ? "SEARCH" : "FETCH"}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">
        {host ? (
          <>
            <span className="text-foreground-bright">{host}</span>
            <span className="text-muted-2">{summary.slice(summary.indexOf(host) + host.length)}</span>
          </>
        ) : (
          `“${summary}”`
        )}
      </span>
      <Took ms={ms} />
    </div>
  );
}

/** A call out of this process and into another one: no side edges, a patch cable
 *  running from the server's tag across to the tool it reached. */
function McpCard({
  name,
  ms,
  animate,
}: {
  name: string;
  ms?: number;
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
        className="flex flex-none items-center gap-1.5 text-[10px] tracking-[1px]"
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
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground-bright">{tool}</span>
      <Took ms={ms} />
    </div>
  );
}

/** A delegated run (Task / Skill): a rail down the side and the brief it was
 *  handed, which is a paragraph, not a path — so it wraps instead of truncating. */
function AgentCard({
  name,
  summary,
  ms,
  animate,
}: {
  name: string;
  summary: string;
  ms?: number;
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
        className="mt-px flex flex-none items-center gap-1.5 border px-1.5 py-px text-[10px] tracking-[1px]"
        style={{ color: accent, borderColor: tagEdge(accent) }}
      >
        <Bot size={11} aria-hidden />
        {name.toUpperCase()}
      </span>
      <span className="min-w-0 flex-1 line-clamp-2 text-[12px] leading-relaxed text-muted-foreground">
        {summary}
      </span>
      {ms ? <span className="mt-[3px] flex-none text-[9.5px] tracking-[1px] text-muted-2">{dur(ms)}</span> : null}
    </div>
  );
}

/** Everything that isn't a terminal, a file, or a diff — each family drawn as
 *  what it actually did: a lookup, a fetch, a delegated run, a plan, an MCP call. */
function ToolCard({
  name,
  summary,
  ms,
  animate,
}: {
  name: string;
  summary: string;
  ms?: number;
  animate: boolean;
}) {
  const kind = toolKind(name);

  if (kind === "agent") return <AgentCard name={name} summary={summary} ms={ms} animate={animate} />;
  if (kind === "mcp") return <McpCard name={name} ms={ms} animate={animate} />;
  if (kind === "web") return <WebCard name={name} summary={summary} ms={ms} animate={animate} />;
  if (kind === "search") return <SearchCard name={name} summary={summary} ms={ms} animate={animate} />;
  if (kind === "plan")
    return (
      <ToolBox
        accent={toolAccent(name)}
        tag="PLAN"
        icon={<ListChecks size={11} aria-hidden />}
        ms={ms}
        animate={animate}
      >
        {summary || "checklist updated"}
      </ToolBox>
    );

  return (
    <ToolBox accent={toolAccent(name)} tag={name.toUpperCase()} icon={null} ms={ms} animate={animate}>
      {summary}
    </ToolBox>
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
      <span className="flex-none border border-border px-1.5 py-px text-[10px] tracking-[1px] text-muted-foreground">
        {names.length} STEPS
      </span>
      <span className="min-w-0 truncate text-[12px] text-muted-2">{label}</span>
      <span className="ml-auto flex-none text-[10px] text-muted-2">⌄</span>
    </button>
  );
}

type RespondFn = (
  requestId: string,
  opts: { behavior?: "allow" | "deny"; answers?: AnswerSelection[] },
) => void;

// Memoized: a long session's past turns keep the same `events`/`pending` arrays
// across polls (see mergeDelta), so only the live turn re-renders.
export const RunStream = memo(function RunStream({
  events,
  pending = [],
  onRespond,
  animate = false,
  turnId = "",
  openResults = false,
  onRunCommand,
  ended = false,
}: {
  events: RunEvent[];
  pending?: PendingRequest[];
  onRespond?: RespondFn;
  animate?: boolean;
  turnId?: string;
  openResults?: boolean;
  onRunCommand?: (command: string) => void;
  ended?: boolean;
}) {
  const [openFolds, setOpenFolds] = useState<Set<number>>(new Set());
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
  // Back-to-back Bash calls share one terminal window (see TerminalGroup); the
  // head draws them all, the rest render nothing.
  const isBash = (i: number) => {
    const e = events[i];
    return e.type === "tool" && e.name === "Bash";
  };
  const { folds: shells, headOf: shellOf } = runsOf(events, isBash, 2);

  // The turn's closing text arrives twice — once streamed as a text block, once
  // as the run's result — so the same words used to print twice, the second time
  // in the RESULT box. Only the box is drawn. A native session emits no result
  // event, so its final text keeps rendering as text.
  const resultText = events.find((e) => e.type === "result")?.result?.trim();

  return (
    // vskip-card: a turn runs to hundreds of events, so each card skips layout
    // and paint while it's off-screen (see .vskip-card in index.css).
    <div className="space-y-2 vskip-card">
      {events.map((event, i) => {
        switch (event.type) {
          case "text":
            if (resultText && event.text.trim() === resultText) return null;
            return (
              <div key={i} style={animate ? { animation: "streamIn .34s cubic-bezier(.2,.8,.2,1) both" } : undefined}>
                <Markdown className="pl-[18px] leading-relaxed text-[var(--txm)]">{event.text}</Markdown>
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
            if (event.name === "Bash") {
              if (shellOf.has(i)) return null; // drawn by the run's head
              const run = shells.get(i) ?? [i];
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
            }
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
              return <ReadCard key={i} path={event.summary} ms={done?.ms} animate={animate} />;
            if (kind === "write" && event.summary)
              return (
                <WriteCard
                  key={i}
                  name={event.name}
                  path={event.summary}
                  ms={done?.ms}
                  animate={animate}
                />
              );
            return (
              <ToolCard
                key={i}
                name={event.name}
                summary={event.summary}
                ms={done?.ms}
                animate={animate}
              />
            );
          }
          case "tool_done":
            return null;
          case "steer":
            // Sent into this turn while it was already running — shown so the
            // transcript explains why the agent changed course mid-task.
            return (
              <div key={i} id={ckId(turnId, steerKey(i))} className="my-1.5 ml-[18px] flex scroll-mt-2 items-start gap-2 border-l-2 border-[var(--violet)] py-0.5 pl-2.5 text-[12px] leading-relaxed text-[var(--violet)]">
                <span className="mt-0.5"><SteerIcon size={12} /></span>
                <span>{event.text}</span>
              </div>
            );
          case "result":
            return (
              <FinalResult
                key={i}
                result={event.result}
                elapsed={event.elapsed}
                cost={event.cost}
                isError={event.is_error}
                animate={animate}
                idKey={`${turnId}:${i}`}
              />
            );
          case "error":
            return (
              <div
                key={i}
                className="flex items-start gap-1.5 rounded-lg bg-red-500/15 px-2 py-1 text-sm text-red-300"
                style={animate ? { animation: "streamIn .34s cubic-bezier(.2,.8,.2,1) both" } : undefined}
              >
                <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
                <span>{event.message}</span>
              </div>
            );
          case "permission":
            return (
              <PermissionCard
                key={i}
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
            );
          case "question":
            return (
              <div key={i} id={ckId(turnId, event.request_id)} className="scroll-mt-2">
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
                className="flex items-center gap-1.5 text-xs text-[var(--tg-hint)]"
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

/** Lines a result prints before it folds — long enough that an ordinary answer
 *  never folds, short enough that a 300-line report doesn't bury the transcript. */
const RESULT_FOLD_LINES = 30;

function FinalResult({
  result,
  elapsed,
  cost,
  isError,
  animate,
  idKey,
}: {
  result: string;
  elapsed?: number;
  cost?: number | null;
  isError?: boolean;
  animate: boolean;
  idKey: string;
}) {
  const flash = animate && !typedResults.has(idKey);
  const tone = isError ? "var(--err)" : "var(--ok)";
  const lines = result.split("\n").length;
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
        className="flex items-center gap-2 border-b px-3 py-1.5 text-[9.5px] tracking-[2px]"
        style={{ borderColor: `color-mix(in srgb, ${tone} 18%, transparent)`, color: tone }}
      >
        <span>RESULT // {isError ? "ERROR" : "OK"}</span>
        <span className="ml-auto flex items-center gap-2 tracking-[1px] text-muted-2">
          {typeof elapsed === "number" && elapsed > 0 && (
            <span title="wall time">{elapsed < 60 ? `${Math.round(elapsed)}S` : `${(elapsed / 60).toFixed(1)}M`}</span>
          )}
          {cost ? <span title="cost of this turn">${cost < 1 ? cost.toFixed(4) : cost.toFixed(2)}</span> : null}
        </span>
        <span className="flex-none opacity-0 transition-opacity group-focus-within/res:opacity-100 group-hover/res:opacity-100">
          <CopyBtn text={result} title="copy result" />
        </span>
      </div>
      <div className="relative px-3 py-2.5">
        <div className={open ? undefined : "max-h-[380px] overflow-hidden"}>
          <Typewriter text={result} animate={animate} idKey={idKey} className="leading-relaxed text-foreground-bright" />
        </div>
        {!open && (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-20"
            style={{ background: "linear-gradient(to bottom, transparent, var(--background))" }}
            aria-hidden
          />
        )}
      </div>
      {lines > RESULT_FOLD_LINES && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center justify-center gap-1.5 border-t px-3 py-1 text-[9.5px] tracking-[1.5px] text-muted-2 hover:text-foreground-bright"
          style={{ borderColor: `color-mix(in srgb, ${tone} 14%, transparent)` }}
        >
          <ChevronDown size={11} aria-hidden className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
          {open ? "FOLD" : `SHOW ALL // ${lines} LINES`}
        </button>
      )}
    </div>
  );
}
