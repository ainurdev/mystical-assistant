import { memo, useEffect, useState, type ReactNode } from "react";
import {
  PenLine,
  BookOpen,
  Terminal,
  Search,
  Wrench,
  TriangleAlert,
  CircleStop,
  Copy,
  Check,
  Globe,
  Bot,
  ListChecks,
  Plug,
  Layers,
  Merge,
  GitCompare,
  Brain,
  ChevronDown,
  ChevronsUp,
  GitBranch,
  FileText,
  FilePen,
  Trash2,
  FolderTree,
  Play,
  Package,
  FlaskConical,
  Cpu,
  Database,
  Container,
} from "lucide-react";
import { api, type AnswerSelection, type PendingRequest, type RunEvent } from "../lib/api";
import { Card } from "./ui";
import { foldChips, runsOf, headSafeCut, insideRun, byFile, type EditEv } from "../lib/toolfold";
import { ImageLightbox } from "./ImageLightbox";
import { Markdown } from "./Markdown";
import { PermissionCard } from "./PermissionCard";
import { QuestionCard } from "./QuestionCard";
import { askBack } from "../lib/askback";
import { hostOf, mcpParts, toolAccent, toolKind, cmdKind, type CmdKind } from "../lib/tools";

/** The two edges a tool's accent draws: the card's hairline and the tag's box. */
const edge = (accent: string) => `color-mix(in srgb, ${accent} 24%, transparent)`;
const tagEdge = (accent: string) => `color-mix(in srgb, ${accent} 35%, transparent)`;

/** The directory takes the truncation, the filename never gets cut — on a phone
 *  a middle-truncated path is the difference between useful and noise. */
function FilePath({ path }: { path: string }) {
  const cut = path.lastIndexOf("/");
  return (
    <span className="flex min-w-0 flex-1 font-mono text-[11px]" title={path}>
      <span className="truncate text-[var(--muted-2)]">{cut >= 0 ? path.slice(0, cut + 1) : ""}</span>
      <span className="flex-none text-[var(--foreground-bright)]">{path.slice(cut + 1)}</span>
    </span>
  );
}

/** The right-hand end of a tool card: what came back, then how long it took.
 *  Both are optional — an unfinished call has neither. */
/** What a finished call left behind: how long it took, how big the answer was,
 *  and whether it failed. Every card ends with these three. */
type Res = { ms?: number; stat?: string; error?: boolean };

function Took({ ms, stat, error }: { ms?: number; stat?: string; error?: boolean }) {
  if (!slow(ms) && !stat) return null;
  return (
    <span className="flex flex-none items-center gap-1 text-[9.5px] tracking-[1px] text-[var(--muted-2)]">
      {stat && (
        <span className="max-w-[120px] truncate" style={error ? { color: "var(--danger)" } : undefined}>
          {stat}
        </span>
      )}
      {stat && slow(ms) ? <span aria-hidden>·</span> : null}
      {slow(ms) ? <span>{dur(ms)}</span> : null}
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
      className="whitespace-pre-wrap break-words border-l-2 py-1 pl-2 font-mono text-[10.5px] leading-relaxed"
      style={{ color: "var(--danger)", borderColor: "var(--danger)" }}
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
    <div role="status" className="flex items-center gap-2 py-0.5 text-[var(--muted-2)]">
      <span aria-hidden
            className="h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-current motion-reduce:animate-none" />
      <span className="text-[10px] uppercase tracking-[1px]">{text}</span>
      <span aria-hidden className="h-px flex-1 bg-[var(--muted-2)] opacity-25" />
    </div>
  );
}

/** A pause with nothing recorded but its length — a hairline seam with the
 *  figure at its right edge. It used to be a zero-height overlay riding the
 *  next card's top edge, which put the figure on top of that row's numbers. */
function GapMark({ ms }: { ms: number }) {
  return (
    <div aria-hidden className="flex items-center gap-2 pr-1 text-[9.5px] tracking-[1px] text-[var(--muted-2)]">
      <span className="h-px min-w-0 flex-1 bg-[var(--muted-2)] opacity-25" />
      <span className="flex-none">+{dur(ms)}</span>
    </div>
  );
}

function ThinkingRow({ ms, text }: { ms?: number; text?: string }) {
  const [open, setOpen] = useState(false);
  // The row costs its height either way — the first line of the reasoning is what
  // makes it worth reading. Empty when the model recorded only the pause.
  const peek = (text ?? "").trim().split("\n").find((l) => l.trim()) ?? "";
  const head = (
    <>
      <Brain size={12} className="flex-none" aria-hidden />
      <span className="flex-none text-[10px] tracking-[1px]">THOUGHT</span>
      {peek && !open ? (
        <span className="min-w-0 flex-1 truncate text-[11px] italic opacity-75">{peek}</span>
      ) : (
        <span aria-hidden className="h-px flex-1 bg-[var(--muted-2)] opacity-25" />
      )}
      <span className="flex-none text-[9.5px] tracking-[1px]">{slow(ms)}</span>
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
    <div className="text-[var(--muted-2)]">
      {text ? (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-2 py-0.5 text-left"
        >
          {head}
        </button>
      ) : (
        <div className="flex items-center gap-2 py-0.5">{head}</div>
      )}
      {open && text ? (
        <div className="mt-1 whitespace-pre-wrap border-l border-[var(--muted-2)]/25 pl-2 text-[12px] leading-relaxed">
          {text}
        </div>
      ) : null}
    </div>
  );
}

/** A hook's output, or a line the child wrote to stderr — the work either side of
 *  the conversation, which used to be visible only when a run died. */
function LogRow({ src, label, text, error }:
  { src: string; label?: string; text: string; error?: boolean }) {
  const [open, setOpen] = useState(false);
  const lines = text.split("\n");
  const more = lines.length - 1;
  return (
    <button
      type="button"
      onClick={() => more && setOpen((o) => !o)}
      className="flex w-full items-start gap-1.5 py-0.5 text-left font-mono text-[12px] leading-relaxed"
      style={{ color: error ? "var(--err)" : "var(--muted-2)" }}
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
  );
}

/** A read is a page glanced at: no box, just a tinted wash fading out to the
 *  right. The quietest row in a turn, because looking at a file changed nothing. */
function ReadCard({ path, ms, stat, error }: Res & { path: string }) {
  const accent = toolAccent("Read");
  return (
    <div
      className="flex items-center gap-2 rounded-lg py-1 pl-2 pr-2"
      style={{ background: `linear-gradient(90deg, color-mix(in srgb, ${accent} 10%, transparent), transparent 70%)` }}
    >
      <BookOpen size={12} className="flex-none" style={{ color: accent }} aria-hidden />
      <FilePath path={path} />
      <Took ms={ms} stat={stat} error={error} />
    </div>
  );
}

/** A write is a file changed: boxed, with a solid bar down the side and the tag
 *  filled in rather than outlined — the loudest one-line card, because it did
 *  something. */
function WriteCard({ name, path, ms, stat, error }: Res & { name: string; path: string }) {
  const accent = toolAccent(name);
  return (
    <div
      className="flex items-center gap-2 rounded-lg border border-l-[3px] bg-[var(--ac-03)] py-1.5 pl-2 pr-2"
      style={{ borderColor: edge(accent), borderLeftColor: accent }}
    >
      <span
        className="flex flex-none items-center gap-1 rounded px-1.5 py-px text-[9.5px] tracking-[1px]"
        style={{ background: accent, color: "var(--tg-button-text)" }}
      >
        <PenLine size={10} aria-hidden />
        {name.toUpperCase()}
      </span>
      <FilePath path={path} />
      <Took ms={ms} stat={stat} error={error} />
    </div>
  );
}

/** A lookup is a query typed into a field: everything dashed, because nothing
 *  here is committed yet — the pattern sits in its own inset box, as entered. */
function SearchCard({ name, summary, ms, stat, error }: Res & { name: string; summary: string }) {
  const accent = toolAccent(name);
  return (
    <div
      className="flex items-center gap-2 rounded-lg border border-dashed px-2 py-1.5"
      style={{ borderColor: tagEdge(accent) }}
    >
      <Search size={12} className="flex-none" style={{ color: accent }} aria-hidden />
      <span
        className="min-w-0 flex-1 truncate rounded border border-dashed px-1.5 py-px font-mono text-[11px] text-[var(--foreground-bright)]"
        style={{ borderColor: edge(accent) }}
      >
        {summary}
      </span>
      <Took ms={ms} stat={stat} error={error} />
    </div>
  );
}

/** The web is not this machine: a browser's address bar, fully round, host first
 *  with the rest of the URL dimmed behind it. */
function WebCard({ name, summary, ms, stat, error }: Res & { name: string; summary: string }) {
  const accent = toolAccent(name);
  const host = hostOf(summary);
  return (
    <div
      className="flex items-center gap-2 rounded-full border bg-[var(--ac-03)] py-1 pl-2 pr-3"
      style={{ borderColor: edge(accent) }}
    >
      <Globe size={12} className="flex-none" style={{ color: accent }} aria-hidden />
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--tg-hint)]">
        {host ? (
          <>
            <span className="text-[var(--foreground-bright)]">{host}</span>
            <span className="text-[var(--muted-2)]">{summary.slice(summary.indexOf(host) + host.length)}</span>
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
function McpCard({ name, summary, ms, stat, error }: Res & { name: string; summary: string }) {
  const accent = toolAccent(name);
  const { server, tool } = mcpParts(name);
  return (
    <div className="flex items-center gap-2 border-y bg-[var(--ac-03)] px-2 py-1.5" style={{ borderColor: edge(accent) }}>
      <Plug size={12} className="flex-none" style={{ color: accent }} aria-hidden />
      <span className="flex-none text-[9.5px] tracking-[1px]" style={{ color: accent }}>
        {server.toUpperCase()}
      </span>
      <span
        aria-hidden
        className="h-px w-4 flex-none"
        style={{ backgroundImage: `repeating-linear-gradient(90deg, ${accent} 0 2px, transparent 2px 5px)` }}
      />
      <span className="flex-none font-mono text-[11px] text-[var(--foreground-bright)]">{tool}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--muted-2)]">{summary}</span>
      <Took ms={ms} stat={stat} error={error} />
    </div>
  );
}

/** What a delegated run knows about itself past its brief: which agent took the
 *  work, and the short name the caller gave the job. Both are absent on turns
 *  recorded before the bridge carried them (bridge/transcript_jsonl.agent_meta),
 *  so every part of the header is optional — the frame is not. */
type AgentMeta = { type?: string; title?: string };

/** One delegation, as the block draws it. */
type AgentRun = Res & { name: string; summary: string; meta?: AgentMeta; running?: boolean };

/** Teal for an agent, violet for a skill (the model's own kit, and violet is
 *  already the model's colour), salmon when it failed. */
function agentHue({ name, error }: { name: string; error?: boolean }): string {
  if (error) return "var(--danger)";
  return name === "Skill" ? "var(--violet)" : toolAccent(name);
}

/** How long a run has been out.
 *  ponytail: mount time is the start, so reopening the chat mid-run restarts the
 *  count — a tool event carries no timestamp. Stamp one on the event if the
 *  figure ever has to survive a reload. */
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
 *  this was, who took it, and — on a phone, where the header has no room for
 *  numbers — how far it has got. */
function AgentHead({ kind, type, running, state }: {
  kind: string; type?: string; running?: boolean; state?: React.ReactNode;
}) {
  return (
    <div className="agb-head">
      <span className="agb-mark" aria-hidden>{running ? "\u25c8" : "\u25c7"}</span>
      <span className="agb-kind">{kind} //</span>
      {type ? <span className="agb-type" title={type}>{type}</span> : null}
      <span className="agb-rule" aria-hidden />
      {state ? <span className="agb-state">{state}</span> : null}
    </div>
  );
}

/** A delegated run: the one card that keeps a frame, because it is a turn nested
 *  inside your turn. The agent that took the work is the tag — "AGENT" alone was
 *  the same word for a one-file lookup and a four-minute fan-out — and the brief
 *  is the body rather than a paragraph clipped into a line. */
function AgentBlock({ run, live }: { run: AgentRun; live?: boolean }) {
  const [open, setOpen] = useState(false);
  const { name, summary, meta, ms, stat, error, running } = run;
  const title = meta?.title ?? "";
  return (
    <div
      className="agb"
      data-run={running ? "" : undefined}
      data-err={error ? "" : undefined}
      data-open={open ? "" : undefined}
      style={{ "--h": agentHue(run) } as React.CSSProperties}
    >
      <i className="agb-rail" aria-hidden />
      {running ? <span className="agb-sweep" aria-hidden><i /></span> : null}
      <AgentHead
        kind={name === "Skill" ? "SKILL" : "AGENT"}
        type={meta?.type}
        running={running}
        // The clock only runs on the turn streaming into this chat; on an older
        // one it would be counting from when you scrolled to it, not from when
        // the agent went out.
        state={running ? (live ? <LiveClock /> : null)
                       : error ? <span style={{ color: "var(--danger)" }}>FAILED</span> : null}
      />
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
      {/* While it is out, the only true figures are that it is working and for
          how long — what it will report does not exist yet. */}
      <button
        type="button"
        className="agb-nums"
        onClick={() => setOpen((o) => !o)}
        title={open ? "clip the brief" : "the whole brief"}
      >
        {running ? <span style={{ color: "var(--h)" }}>WORKING</span> : null}
        {stat && !error && !running ? <b>{stat}</b> : null}
        {slow(ms) ? <span>{dur(ms)}</span> : null}
        <i aria-hidden />
        {summary ? <span className="go">{open ? "\u2303" : "\u2304"} BRIEF</span> : null}
      </button>
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
function AgentFan({ runs, live }: { runs: AgentRun[]; live?: boolean }) {
  const out = runs.filter((r) => r.running).length;
  const total = runs.reduce((t, r) => t + (r.ms ?? 0), 0);
  return (
    <div className="agb" data-run={out ? "" : undefined}
         style={{ "--h": "var(--primary)" } as React.CSSProperties}>
      <i className="agb-rail" aria-hidden />
      {out ? <span className="agb-sweep" aria-hidden><i /></span> : null}
      <AgentHead
        kind="AGENTS"
        type={`${runs.length} RUNS`}
        running={!!out}
        state={out ? <><span style={{ color: "var(--h)" }}>{out} WORKING</span>{live ? <> <LiveClock /></> : null}</>
                   : slow(total) ? dur(total) : null}
      />
      {runs.map((r, k) => <AgentFanRow key={k} run={r} />)}
    </div>
  );
}

/** The shell the remaining one-line cards share: a hairline box in the tool's
 *  accent, an icon, that tool's own line, then how long it took. */
function ToolBox({
  accent, icon, ms, stat, error, children,
}: Res & {
  accent: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex items-center gap-2 rounded-lg border bg-[var(--ac-03)] px-2 py-1.5"
      style={{ borderColor: edge(accent) }}
    >
      <span className="flex-none" style={{ color: accent }}>{icon}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--tg-hint)]">{children}</span>
      <Took ms={ms} stat={stat} error={error} />
    </div>
  );
}

/** Everything that isn't a terminal or a diff, drawn as what it actually did. */
function ToolCard({ name, summary, ms, stat, error }: Res & { name: string; summary: string }) {
  const kind = toolKind(name);
  const accent = toolAccent(name);

  const res = { ms, stat, error };

  if (kind === "read" && summary) return <ReadCard path={summary} {...res} />;
  if (kind === "write" && summary) return <WriteCard name={name} path={summary} {...res} />;
  if (kind === "mcp") return <McpCard name={name} summary={summary} {...res} />;
  if (kind === "web") return <WebCard name={name} summary={summary} {...res} />;
  if (kind === "search") return <SearchCard name={name} summary={summary} {...res} />;
  if (kind === "plan")
    return (
      <ToolBox accent={accent} icon={<ListChecks size={12} aria-hidden />} {...res}>
        {summary || "checklist updated"}
      </ToolBox>
    );
  return (
    <ToolBox accent={accent} icon={<Wrench size={12} aria-hidden />} {...res}>
      {name}
      {summary ? `: ${summary}` : ""}
    </ToolBox>
  );
}

/** A run of back-to-back calls of one kind drawn as one card, the way Bash calls
 *  share a terminal: the tag once in the header, a row per call. Eight MCP calls
 *  said the server's name eight times. */
function CallGroup({ name, calls }: {
  name: string;
  calls: { name: string; summary: string; ms?: number; stat?: string; error?: boolean }[];
}) {
  const kind = toolKind(name);
  const accent = toolAccent(name);
  const tag = kind === "mcp" ? mcpParts(name).server : kind;
  const total = calls.reduce((t, c) => t + (c.ms ?? 0), 0);
  return (
    <div className="rounded-lg border bg-[var(--ac-03)]" style={{ borderColor: edge(accent) }}>
      <div
        className="flex items-center gap-2 border-b px-2 py-1 text-[9.5px] tracking-[1.5px]"
        style={{ borderColor: edge(accent), color: accent }}
      >
        {kind === "mcp" ? <Plug size={11} aria-hidden /> : kind === "web" ? <Globe size={11} aria-hidden /> : <Bot size={11} aria-hidden />}
        <span className="truncate">{tag.toUpperCase()}</span>
        <span className="flex-none text-[var(--muted-2)]">· {calls.length} CALLS</span>
        {slow(total) && <span className="flex-none text-[var(--muted-2)]">· {dur(total)}</span>}
      </div>
      {calls.map((c, k) => (
        <div key={k} className="border-t border-[var(--border)] first:border-t-0">
          <div className="flex items-center gap-2 px-2 py-1">
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--foreground-bright)]">
              {kind === "mcp"
                ? [mcpParts(c.name).tool, c.summary].filter(Boolean).join(" · ")
                : hostOf(c.summary) || c.summary}
            </span>
            <Took ms={c.ms} stat={c.error ? undefined : c.stat} error={c.error} />
          </div>
          {c.error && c.stat ? <div className="px-2 pb-1.5"><ErrLine text={c.stat} /></div> : null}
        </div>
      ))}
    </div>
  );
}

/** One screenshot from the upload dir — a tool's output, or one you attached to a
 *  prompt. The bytes come through the API instead of a plain <img src> because the
 *  Mini App's auth lives in a header (see api.attachmentUrl). The dir is pruned by
 *  age, so an old turn's image is gone: `fallback` is what shows in its place. */
export function ToolImage({ path, alt = "tool output", className = "h-20 w-auto max-w-[160px] rounded-lg object-cover", fallback = null, onZoom }: {
  path: string;
  alt?: string;
  className?: string;
  fallback?: ReactNode;
  onZoom: (src: string) => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    let url: string | null = null;
    let dead = false;
    api.attachmentUrl(path).then((u) => {
      url = u;
      if (dead) URL.revokeObjectURL(u);
      else setSrc(u);
    }).catch(() => { if (!dead) setGone(true); });
    return () => {
      dead = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);
  if (!src) return gone ? <>{fallback}</> : null;
  return (
    <button type="button" onClick={() => onZoom(src)} aria-label={`Open ${alt}`} className="block">
      <img src={src} alt={alt} className={className} />
    </button>
  );
}

function ToolImages({ paths }: { paths: string[] }) {
  const [zoom, setZoom] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap gap-2">
      {zoom && <ImageLightbox src={zoom} alt="tool output" onClose={() => setZoom(null)} />}
      {paths.map((p) => <ToolImage key={p} path={p} onZoom={setZoom} />)}
    </div>
  );
}

/** Tool kinds that draw a block of their own, so they never fold into a
 *  "N steps" chip with the quiet lookups. */
const BLOCK_KINDS = new Set(["bash", "agent", "web", "mcp"]);

type Done = { ms?: number; output?: string; is_error?: boolean; patch?: string[];
               stat?: string; images?: string[] };

// Output/diff lines shown before a block folds — a turn can hold dozens.
const OUT_PREVIEW = 6;
const DIFF_PREVIEW = 20;

/** Events of a turn that mount before the rest waits behind a button. The
 *  virtualizer windows on turns, so a session whose turns run to hundreds of
 *  events is a handful of rows and nothing to window — and this is a phone. The
 *  tail is what you opened the turn to read. */
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
 *  is noise on every card — the ones that matter are the ones that waited. */
function slow(ms?: number): string {
  return ms && ms >= 1000 ? dur(ms) : "";
}

/** The glyph a command wears, so a run reads as an action before it is read. */
const CMD_ICON: Record<CmdKind, typeof Terminal> = {
  git: GitBranch, search: Search, read: FileText, edit: FilePen, delete: Trash2,
  fs: FolderTree, run: Play, pkg: Package, test: FlaskConical, net: Globe,
  proc: Cpu, db: Database, docker: Container, shell: Terminal,
};

/** A Bash call drawn as the terminal it actually is: the command at a prompt, a
 *  live caret while it runs, then its output. Failed commands open themselves. */
function TerminalBlock({
  command,
  done,
}: {
  command: string;
  done?: Done;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const running = !done;
  const failed = !!done?.is_error;
  const raw = (done?.output ?? "").trimEnd();
  const exit = raw.match(EXIT_RE);
  const out = exit ? raw.slice(exit[0].length) : raw;
  const lines = out ? out.split("\n") : [];
  const shown = open || failed ? lines : lines.slice(0, OUT_PREVIEW);
  const hidden = lines.length - shown.length;
  const accent = failed ? "var(--danger)" : running ? "var(--warning)" : "var(--success)";
  const CmdIcon = CMD_ICON[cmdKind(command)];

  return (
    <div
      className="overflow-hidden rounded-lg border bg-black/25"
      style={{
        borderColor: failed ? "color-mix(in srgb, var(--danger) 32%, transparent)" : "var(--border)",
      }}
    >
      <div className="flex w-full items-center gap-2 border-b border-[var(--border)] bg-[var(--ac-03)] px-2.5 py-1.5">
        <span className="flex flex-none gap-[3px]" aria-hidden>
          <i
            className="block h-[5px] w-[5px] rounded-full"
            style={{
              background: accent,
              animation: running ? "caret 1.1s steps(1) infinite" : undefined,
            }}
          />
          <i className="block h-[5px] w-[5px] rounded-full bg-[var(--muted-2)]" />
          <i className="block h-[5px] w-[5px] rounded-full bg-[var(--muted-2)]" />
        </span>
        <span className="flex flex-none items-center gap-1 text-[9.5px] tracking-[2px]" style={{ color: accent }}>
          <Terminal size={11} aria-hidden />
          BASH // {running ? "RUNNING" : failed ? "FAILED" : "OK"}
        </span>
        {slow(done?.ms) ? (
          <span className="flex-none text-[9.5px] tracking-[1px] text-[var(--muted-2)]">· {dur(done?.ms)}</span>
        ) : null}
        {exit && (
          <span className="flex-none text-[9.5px] tracking-[1px]" style={{ color: "var(--danger)" }}>
            · EXIT {exit[1]}
          </span>
        )}
        <span className="ml-auto flex flex-none items-center gap-2.5">
          <button
            type="button"
            title="copy command"
            onClick={() => {
              void navigator.clipboard?.writeText(command).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              });
            }}
            className="text-[var(--tg-hint)]"
          >
            {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
          </button>
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="text-[9.5px] tracking-[1px] text-[var(--tg-hint)]"
            >
              +{hidden} LINES ⌄
            </button>
          )}
        </span>
      </div>
      <div className="px-2.5 py-2 font-mono text-xs leading-relaxed">
        <div className="flex gap-1.5">
          <CmdIcon size={13} className="mt-[2px] flex-none text-[var(--muted-2)]" aria-hidden />
          <span className="min-w-0 break-all whitespace-pre-wrap text-[var(--foreground-bright)]">
            {command}
            {running && (
              <span
                className="ml-px inline-block h-[1em] w-[6px] translate-y-[2px] bg-[var(--brand-soft)] align-middle"
                style={{ animation: "caret 1s steps(1) infinite" }}
              />
            )}
          </span>
        </div>
        {shown.length > 0 && (
          <pre
            className="mt-1.5 break-all whitespace-pre-wrap text-[11px] leading-[1.55]"
            style={{ color: failed ? "var(--danger)" : "var(--tg-hint)" }}
          >
            {shown.join("\n")}
          </pre>
        )}
      </div>
    </div>
  );
}

function diffColor(line: string): string {
  if (line.startsWith("@@")) return "var(--violet)";
  if (line.startsWith("+")) return "var(--success)";
  if (line.startsWith("-")) return "var(--danger)";
  return "var(--tg-hint)";
}

/** An edit shown as the diff Claude Code already computed for it, so a turn says
 *  what changed instead of just which file was touched. One box is one *file*:
 *  `count` is how many edits landed on it, and the hunks below are all of them
 *  in the order they were applied. */
function DiffBlock({
  name,
  path,
  patch,
  ms,
  count = 1,
}: {
  name: string;
  path: string;
  patch: string[];
  ms?: number;
  count?: number;
}) {
  const [open, setOpen] = useState(false);
  const shown = open ? patch : patch.slice(0, DIFF_PREVIEW);
  const hidden = patch.length - shown.length;
  const add = patch.filter((l) => l.startsWith("+")).length;
  const del = patch.filter((l) => l.startsWith("-")).length;

  return (
    <div className="overflow-hidden rounded-lg border border-[color-mix(in_srgb,var(--success)_24%,transparent)] bg-black/25">
      <div className="flex items-center gap-2 border-b border-[color-mix(in_srgb,var(--success)_16%,transparent)] bg-[var(--ac-03)] px-2.5 py-1.5">
        <span className="flex flex-none items-center gap-1 text-[9.5px] tracking-[2px] text-[var(--success)]">
          <GitCompare size={11} aria-hidden />
          {name.toUpperCase()} //
        </span>
        <span className="min-w-0 truncate font-mono text-[11px] text-[var(--foreground-bright)]">{path}</span>
        {count > 1 ? (
          <span className="flex-none text-[9.5px] tracking-[1px] text-[var(--muted-2)]">×{count}</span>
        ) : null}
        {slow(ms) ? (
          <span className="flex-none text-[9.5px] tracking-[1px] text-[var(--muted-2)]">· {dur(ms)}</span>
        ) : null}
        <span className="ml-auto flex flex-none items-center gap-2.5 text-[9.5px] tracking-[1px]">
          <span>
            <span style={{ color: "var(--success)" }}>+{add}</span>{" "}
            <span style={{ color: "var(--danger)" }}>−{del}</span>
          </span>
          {hidden > 0 && (
            <button type="button" onClick={() => setOpen(true)} className="text-[var(--tg-hint)]">
              +{hidden} ⌄
            </button>
          )}
        </span>
      </div>
      <div className="overflow-x-auto px-2.5 py-1.5 font-mono text-[11px] leading-[1.55]">
        {shown.map((line, i) => (
          <div key={i} className="whitespace-pre" style={{ color: diffColor(line) }}>
            {line || " "}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A run of edits, merged by file. Seven edits to one seeder used to be seven
 *  boxes on a phone screen that fits two — here they are one box wearing ×7 with
 *  every hunk in it. No frame around the run: each file already carries its own,
 *  and a box inside a box is chrome nobody asked for at 360px. */
function EditGroup({ edits }: { edits: EditEv[] }) {
  return (
    <div className="space-y-2">
      {byFile(edits).map((f) => <DiffBlock key={f.path} {...f} />)}
    </div>
  );
}

/** Where the agent speaks, marked on the rail the turn hangs off (run.tsx): the
 *  diamond the rail used to wear once at its top, now one per message, with a
 *  tick into the bubble so it reads as that message's. Drawn inside the row's
 *  own box — the row pulls back over the gutter with -ml-3/pl-3 — because
 *  .vskip-card paint-contains each row and would clip a mark hung outside it. */
function RailNode() {
  return (
    <>
      <span
        aria-hidden
        className="pointer-events-none absolute left-0 top-[15px] h-[6px] w-[6px] rotate-45 border"
        style={{ borderColor: "var(--brand-soft)", background: "var(--tg-bg)" }}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute left-[7px] top-[18px] h-px w-[5px]"
        style={{ background: "color-mix(in srgb, var(--brand-soft) 40%, transparent)" }}
      />
    </>
  );
}

/** A run of plain lookups collapsed to one line — on a phone the chips are most
 *  of the scroll. */
function FoldedChips({ names, onOpen }: { names: string[]; onOpen: () => void }) {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  const label = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(" · ");
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-1.5 font-mono text-xs text-[var(--tg-hint)]"
    >
      <Layers size={13} className="shrink-0 text-[var(--brand-soft)]" aria-hidden />
      <span className="min-w-0 truncate text-left">
        {names.length} steps — {label}
      </span>
      <span className="ml-auto flex-none">⌄</span>
    </button>
  );
}

function FinalResult({
  result,
  elapsed,
  tokens,
  onAnswer,
  onWrite,
}: {
  result: string;
  elapsed?: number;
  tokens?: number | null;
  onAnswer?: (text: string) => void;
  onWrite?: (question: string) => void;
}) {
  const [sent, setSent] = useState<string | null>(null);
  // The model asked in prose instead of using a question card: lift the question
  // out of the body so it reads as an ask, and offer the answers it expected.
  const ask = onAnswer ? askBack(result) : null;
  return (
    <Card className="space-y-2 border border-[var(--tg-button)]/30">
      {(ask ? ask.body : result) && (
        <Markdown className="text-sm leading-normal">{ask ? ask.body : result}</Markdown>
      )}
      {ask && (
        <div className="space-y-2 rounded-lg border border-[var(--tg-button)]/40 bg-[var(--tg-bg)] p-2.5">
          <Markdown className="text-sm font-medium leading-normal">{ask.question}</Markdown>
          <div className="flex flex-wrap gap-1.5">
            {ask.options.map((o) => (
              <button
                key={o}
                type="button"
                disabled={sent !== null}
                onClick={() => { setSent(o); onAnswer!(o); }}
                className="rounded-lg bg-[var(--tg-button)] px-3 py-1.5 text-sm text-[var(--tg-button-text)] active:opacity-70 disabled:opacity-40"
              >
                {o}
              </button>
            ))}
            {onWrite && (
              <button
                type="button"
                disabled={sent !== null}
                onClick={() => onWrite(ask.question)}
                className="rounded-lg px-3 py-1.5 text-sm text-[var(--tg-hint)] active:opacity-70 disabled:opacity-40"
              >
                Write answer…
              </button>
            )}
            {/* No "No" chip on two alternatives or an open question, so there was
                no way to close the ask without answering. Drops it, runs nothing. */}
            {!ask.options.includes("No") && (
              <button
                type="button"
                disabled={sent !== null}
                onClick={() => { setSent("No"); onAnswer!("No"); }}
                className="rounded-lg px-3 py-1.5 text-sm text-[var(--tg-hint)] active:opacity-70 disabled:opacity-40"
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
      )}
      {typeof elapsed === "number" && (
        <div className="text-xs text-[var(--tg-hint)]">
          {elapsed.toFixed(1)}s
          {typeof tokens === "number" && tokens > 0
            ? ` · ${tokens < 1000 ? tokens : `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`} tok`
            : ""}
        </div>
      )}
    </Card>
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
  onAnswer,
  onWrite,
  tokens = null,
  ended = false,
  boot = null,
  live = false,
}: {
  events: RunEvent[];
  pending?: PendingRequest[];
  onRespond?: RespondFn;
  /** What this turn is waiting on before its first token, or null. */
  boot?: string | null;
  /** This turn's token spend; null = never reported (unknown, not free). */
  tokens?: number | null;
  /** Send a reply to a question the model asked in prose. Only the last, finished
   *  turn gets one — an old question is history, not something to answer. */
  onAnswer?: (text: string) => void;
  onWrite?: (question: string) => void;
  ended?: boolean;
  /** Is this the turn streaming into the chat right now? Only it may run a
   *  clock — on an older turn the figure would start when you scrolled to it. */
  live?: boolean;
}) {
  const [openFolds, setOpenFolds] = useState<Set<number>>(new Set());
  // Derived from the length rather than stored as an index, so a running turn's
  // window slides with its tail instead of freezing where it was opened.
  const [wholeTurn, setWholeTurn] = useState(false);
  const tailFrom = wholeTurn ? 0 : Math.max(0, events.length - TURN_TAIL);
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

  // Only the quiet steps fold away. A terminal, a diff, a delegated run, a fetch
  // or an MCP call each carry their own block and break the run instead —
  // otherwise the cards they just earned never get drawn.
  const { folds, headOf } = foldChips(events, (i) => {
    const e = events[i];
    if (e.type !== "tool") return false;
    return BLOCK_KINDS.has(toolKind(e.name)) || !!doneOf(e)?.patch;
  });
  // Back-to-back calls of one kind share a card, so six MCP calls read as one
  // block with six rows instead of six cards. MCP groups by server.
  const groupKey = (i: number): string | null => {
    const e = events[i];
    if (e.type !== "tool") return null;
    if (e.name === "Bash") return null;      // a terminal per command, as before
    // Edits group so their card can merge them by file — a run of them is the
    // same file over and over far more often than it is many files.
    if (doneOf(e)?.patch) return "edit";
    const kind = toolKind(e.name);
    if (kind === "mcp") return `mcp:${mcpParts(e.name).server}`;
    return BLOCK_KINDS.has(kind) ? kind : null;   // the quiet ones fold into chips
  };
  const { folds: groups, headOf: groupOf } = runsOf(events, groupKey, 2);

  // Never cut a folded run away from the head that draws it. A cut that ends up
  // hiding only a handful buys nothing and reads as a button in front of
  // nothing, so it collapses to showing the lot.
  const cut = headSafeCut(events.length, tailFrom, headOf, groupOf);
  const from = cut < TURN_TAIL_MIN ? 0 : cut;

  // The turn's closing text arrives twice — streamed as a text block, then again
  // as the run's result — so only the result card draws it. A native session
  // emits no result event, so its final text keeps rendering as text.
  const resultText = (events.find((e) => e.type === "result")?.result ?? "").trim();

  // Is the next thing the model does asking a question card?
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
    // vskip-card: off-screen event cards skip layout/paint (see index.css).
    <div className="space-y-2 vskip-card">
      {boot ? <BootRow text={boot} /> : null}
      {from > 0 && (
        <button
          type="button"
          onClick={() => setWholeTurn(true)}
          className="ml-[18px] flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[10px] tracking-wider text-[var(--tg-hint)] active:opacity-70"
        >
          <ChevronsUp size={11} aria-hidden />
          {from} earlier step{from === 1 ? "" : "s"}
        </button>
      )}
      {/* Indices stay absolute: the folding, grouping and tool_done pairing all
          key off position in the full array. */}
      {events.slice(from).map((event, k) => {
        const i = k + from;
        switch (event.type) {
          case "text": {
            const text = event.text;
            if (!text) return null;
            if (resultText && text.trim() === resultText) return null;
            // A turn ending on an AskUserQuestion emits no result event, so the
            // prose explaining the card used to render bare while every other
            // answer got a card. Box it like one.
            if (asksNext(i))
              return (
                <div key={i} className="relative -ml-3 pl-3">
                  <RailNode />
                  <Card className="border border-[var(--tg-button)]/30">
                    <Markdown className="text-sm leading-normal">{text}</Markdown>
                  </Card>
                </div>
              );
            // The agent talking, drawn as the mirror of your bubble: rounded and
            // tailed at the bottom-left where yours is at the bottom-right, at most
            // the same 85%, shrink-wrapped, with a node on the rail where it
            // starts. Bare prose between filled cards was the one thing in a turn
            // with nothing to catch a scrolling eye — and it is the part worth
            // reading.
            return (
              <div key={i} className="relative -ml-3 flex pl-3">
                <RailNode />
                <Markdown className="min-w-0 max-w-[85%] break-words rounded-2xl rounded-bl-sm border border-border bg-[var(--ac-06)] px-3 py-2 text-sm leading-normal">
                  {text}
                </Markdown>
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
            if (event.name === "Bash")
              return <TerminalBlock key={i} command={event.summary} done={done} />;
            if (groupOf.has(i)) return null;   // drawn by the run's head
            const run = groups.get(i);
            // A delegation is a turn nested inside this one, so it is drawn as
            // its own framed block — and a run of them as one fan, not as N
            // identical cards or a generic "AGENT · 4 CALLS" box.
            if (toolKind(event.name) === "agent") {
              const runs = (run ?? [i]).map((j) => {
                const e = events[j] as { name: string; summary: string; agent?: AgentMeta };
                const d = doneOf(events[j]);
                return { name: e.name, summary: e.summary, meta: e.agent, ms: d?.ms,
                         stat: d?.stat, error: d?.is_error, running: !d };
              });
              return runs.length > 1
                ? <AgentFan key={i} runs={runs} live={live} />
                : <AgentBlock key={i} run={runs[0]} live={live} />;
            }
            if (done?.patch)
              return (
                <EditGroup
                  key={i}
                  edits={(run ?? [i]).map((j) => {
                    const e = events[j] as { name: string; summary: string };
                    const d = doneOf(events[j]);
                    return { name: e.name, path: e.summary, patch: d?.patch, ms: d?.ms,
                             error: d?.is_error };
                  })}
                />
              );
            if (run)
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
                />
              );
            return (
              <div key={i} className="space-y-2">
                <ToolCard
                  name={event.name}
                  summary={event.summary}
                  ms={done?.ms}
                  stat={done?.is_error ? undefined : done?.stat}
                  error={done?.is_error}
                />
                {done?.is_error && done.stat ? <ErrLine text={done.stat} /> : null}
                {/* Screenshots the tool handed back — drawn under whatever card it
                    got, so every kind gets them without each card knowing. */}
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
            return <ThinkingRow key={i} ms={event.ms} text={event.text} />;
          case "log":
            return (
              <LogRow key={i} src={event.src} label={event.label}
                      text={event.text} error={event.error} />
            );
          case "tool_done":
            return null;
          case "steer":
            // Sent into this turn while it was already running — drawn as your
            // bubble (right-aligned, button color, out of the agent rail) so
            // mid-turn words read as yours; the tag marks them as a steer.
            return (
              <div key={i} className="-ml-3 flex justify-end">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-[var(--tg-button)] px-3 py-2 text-sm text-[var(--tg-button-text)]">
                  <div className="mb-0.5 flex items-center justify-end gap-1 text-[11px] uppercase tracking-wide opacity-70">
                    steer <Merge size={11} strokeWidth={1.8} style={{ transform: "rotate(90deg)" }} aria-hidden />
                  </div>
                  {event.text}
                  {event.images && event.images.length > 0 && (
                    <ToolImages paths={event.images} />
                  )}
                </div>
              </div>
            );
          case "result":
            return (
              <div key={i} className="relative -ml-3 pl-3">
                <RailNode />
                <FinalResult
                  result={event.result}
                  elapsed={event.elapsed}
                  tokens={tokens}
                  onAnswer={onAnswer}
                  onWrite={onWrite}
                />
              </div>
            );
          case "error":
            return (
              <div
                key={i}
                className="flex items-start gap-1.5 rounded-lg bg-red-500/15 px-2 py-1 text-sm text-red-300"
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
              <QuestionCard
                key={i}
                questions={event.questions}
                requestId={event.request_id}
                active={!!onRespond && pendingIds.has(event.request_id)}
                answered={qAnswered.get(event.request_id)}
                stale={ended && !qAnswered.has(event.request_id)}
                onSubmit={(answers) => onRespond?.(event.request_id, { answers })}
              />
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
