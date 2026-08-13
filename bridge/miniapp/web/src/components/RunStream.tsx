import { memo, useEffect, useState } from "react";
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
  GitCompare,
  Brain,
  ChevronDown,
} from "lucide-react";
import { api, type AnswerSelection, type PendingRequest, type RunEvent } from "../lib/api";
import { Card } from "./ui";
import { foldChips, runsOf } from "../lib/toolfold";
import { ImageLightbox } from "./ImageLightbox";
import { Markdown } from "./Markdown";
import { PermissionCard } from "./PermissionCard";
import { QuestionCard } from "./QuestionCard";
import { askBack } from "../lib/askback";
import { hostOf, mcpParts, toolAccent, toolKind } from "../lib/tools";

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
  if (!ms && !stat) return null;
  return (
    <span className="flex flex-none items-center gap-1 text-[9.5px] tracking-[1px] text-[var(--muted-2)]">
      {stat && (
        <span className="max-w-[120px] truncate" style={error ? { color: "var(--danger)" } : undefined}>
          {stat}
        </span>
      )}
      {stat && ms ? <span aria-hidden>·</span> : null}
      {ms ? <span>{dur(ms)}</span> : null}
    </span>
  );
}

/** A pause where the model reasoned, opening onto the reasoning itself — Claude
 *  Code records it and simply never prints it. Shut by default: a turn holds
 *  dozens, and the row alone already explains the one thing a list of tool cards
 *  can't, the gap between them. */
function ThinkingRow({ ms, text }: { ms?: number; text?: string }) {
  const [open, setOpen] = useState(false);
  const head = (
    <>
      <Brain size={12} className="flex-none" aria-hidden />
      <span className="flex-none text-[10px] tracking-[1px]">THOUGHT</span>
      <span aria-hidden className="h-px flex-1 bg-[var(--muted-2)] opacity-25" />
      <span className="flex-none text-[9.5px] tracking-[1px]">{dur(ms)}</span>
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

/** A delegated run (Task / Skill): a rail down the side and the brief it was
 *  handed, which is a paragraph, not a path — so it wraps instead of truncating. */
function AgentCard({ name, summary, ms, stat, error }: Res & { name: string; summary: string }) {
  const accent = toolAccent(name);
  return (
    <div
      className="flex items-start gap-2 rounded-lg border border-l-2 bg-[var(--ac-03)] px-2 py-1.5"
      style={{ borderColor: edge(accent), borderLeftColor: accent }}
    >
      <Bot size={12} className="mt-px flex-none" style={{ color: accent }} aria-hidden />
      <span className="min-w-0 flex-1 line-clamp-2 text-[11px] leading-relaxed text-[var(--tg-hint)]">{summary}</span>
      <span className="mt-px"><Took ms={ms} stat={stat} error={error} /></span>
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
  if (kind === "agent") return <AgentCard name={name} summary={summary} {...res} />;
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
        {total > 0 && <span className="flex-none text-[var(--muted-2)]">· {dur(total)}</span>}
      </div>
      {calls.map((c, k) => (
        <div key={k} className="flex items-center gap-2 border-t border-[var(--border)] px-2 py-1 first:border-t-0">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--foreground-bright)]">
            {kind === "mcp"
              ? [mcpParts(c.name).tool, c.summary].filter(Boolean).join(" · ")
              : hostOf(c.summary) || c.summary}
          </span>
          <Took ms={c.ms} stat={c.stat} error={c.error} />
        </div>
      ))}
    </div>
  );
}

/** One screenshot a tool handed back. The bytes come through the API instead of a
 *  plain <img src> because the Mini App's auth lives in a header (see
 *  api.attachmentUrl). The upload dir is pruned by age, so an old turn's image is
 *  gone — that thumbnail just doesn't appear. */
function ToolImage({ path, onZoom }: { path: string; onZoom: (src: string) => void }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let dead = false;
    api.attachmentUrl(path).then((u) => {
      url = u;
      if (dead) URL.revokeObjectURL(u);
      else setSrc(u);
    }).catch(() => {});
    return () => {
      dead = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);
  if (!src) return null;
  return (
    <button type="button" onClick={() => onZoom(src)} aria-label="Open screenshot" className="block">
      <img src={src} alt="tool output" className="h-20 w-auto max-w-[160px] rounded-lg object-cover" />
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

/** A failed Bash result opens with the shell's status line ("Exit code 2\n…").
 *  It belongs in the header as a badge, not in the body. */
const EXIT_RE = /^(?:Error: )?Exit code (\d+)\n?/;

function dur(ms?: number): string {
  if (!ms) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

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
        {done?.ms ? (
          <span className="flex-none text-[9.5px] tracking-[1px] text-[var(--muted-2)]">· {dur(done.ms)}</span>
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
          <span className="flex-none select-none text-[var(--brand-soft)]">❯</span>
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
 *  what changed instead of just which file was touched. */
function DiffBlock({
  name,
  path,
  patch,
  ms,
}: {
  name: string;
  path: string;
  patch: string[];
  ms?: number;
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
        {ms ? (
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
}: {
  events: RunEvent[];
  pending?: PendingRequest[];
  onRespond?: RespondFn;
  /** This turn's token spend; null = never reported (unknown, not free). */
  tokens?: number | null;
  /** Send a reply to a question the model asked in prose. Only the last, finished
   *  turn gets one — an old question is history, not something to answer. */
  onAnswer?: (text: string) => void;
  onWrite?: (question: string) => void;
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
    if (e.type !== "tool" || doneOf(e)?.patch) return null;
    if (e.name === "Bash") return null;      // a terminal per command, as before
    const kind = toolKind(e.name);
    if (kind === "mcp") return `mcp:${mcpParts(e.name).server}`;
    return BLOCK_KINDS.has(kind) ? kind : null;   // the quiet ones fold into chips
  };
  const { folds: groups, headOf: groupOf } = runsOf(events, groupKey, 2);

  // The turn's closing text arrives twice — streamed as a text block, then again
  // as the run's result — so only the result card draws it. A native session
  // emits no result event, so its final text keeps rendering as text.
  const resultText = events.find((e) => e.type === "result")?.result?.trim();

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
      {events.map((event, i) => {
        switch (event.type) {
          case "text":
            if (resultText && event.text.trim() === resultText) return null;
            // A turn ending on an AskUserQuestion emits no result event, so the
            // prose explaining the card used to render bare while every other
            // answer got a card. Box it like one.
            if (asksNext(i))
              return (
                <Card key={i} className="border border-[var(--tg-button)]/30">
                  <Markdown className="text-sm leading-normal">{event.text}</Markdown>
                </Card>
              );
            return (
              <Markdown key={i} className="text-sm leading-normal">
                {event.text}
              </Markdown>
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
            if (event.name === "Bash")
              return <TerminalBlock key={i} command={event.summary} done={done} />;
            if (done?.patch)
              return (
                <DiffBlock key={i} name={event.name} path={event.summary} patch={done.patch} ms={done.ms} />
              );
            if (groupOf.has(i)) return null;   // drawn by the run's head
            const run = groups.get(i);
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
                  stat={done?.stat}
                  error={done?.is_error}
                />
                {/* Screenshots the tool handed back — drawn under whatever card it
                    got, so every kind gets them without each card knowing. */}
                {done?.images?.length ? <ToolImages paths={done.images} /> : null}
              </div>
            );
          }
          case "thinking":
            return <ThinkingRow key={i} ms={event.ms} text={event.text} />;
          case "log":
            return (
              <LogRow key={i} src={event.src} label={event.label}
                      text={event.text} error={event.error} />
            );
          case "tool_done":
            return null;
          case "result":
            return (
              <FinalResult
                key={i}
                result={event.result}
                elapsed={event.elapsed}
                tokens={tokens}
                onAnswer={onAnswer}
                onWrite={onWrite}
              />
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
