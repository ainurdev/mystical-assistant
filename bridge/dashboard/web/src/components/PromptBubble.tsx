import { useContext, useState, type ReactNode } from "react";
import { ArrowRight, Bot, ChevronDown, ChevronRight, Clock, Cpu, Flag, Leaf, ListTodo, MessageSquare, Plug, RotateCw, Send, Split, Ticket, Webhook, Zap, type LucideIcon } from "lucide-react";
import { Markdown } from "./Markdown";
import { EFFORTS, PERMS } from "./Composer";
import type { SlashCommand } from "../api";
import type { Turn } from "../chat";
import { modelName } from "../models";
import { runtimeBadge } from "../lib/agents";
import { leadCommand } from "../lib/slash";
import { hhmm, useClock12 } from "../lib/surfaces";
import { saverTag } from "../lib/savers";
import { parseCouncilPrompt, sevCount } from "../lib/council";
import type { MysticalNote as Note } from "../lib/sender";
import { SpunFrom } from "./SpinOffCard";
import { ProjectTile } from "./ui/ProjectTile";
import { openSession } from "../lib/devicerun";
import { projectName } from "../lib/surfaces";
import { shortKeys } from "../lib/spinoffs";

const KIND_ICON: Record<string, LucideIcon> = {
  mcp: Plug, nudge: Flag, wait: Clock, resume: RotateCw, automation: Zap, chat: MessageSquare,
  step: ArrowRight, device: Cpu, ticket: Ticket, work: ListTodo, job: Leaf, api: Webhook, spinoff: Split,
};

/** A prompt the bridge sent, not you (lib/sender): a diamond node on the spine,
 *  Mystical, what kind of note it is and its first line; tapped open, the exact
 *  words that went to Claude and the sender's why (.mystical/design-drafts/
 *  session-chat-items, A · SIGIL; spine.css .pmy). */
export function MysticalNote({ note, text, at }: { note: Note; text: string; at?: number }) {
  const h12 = useClock12();
  const [open, setOpen] = useState(false);
  const Icon = KIND_ICON[note.kind] ?? Bot;
  // A spin-off's first line says where it came from, the way back as a link (bridge/spinoffs.py).
  const from = useContext(SpunFrom);
  return (
    <div className="pmy" data-open={open || undefined}>
      <svg className="pmy-node" viewBox="0 0 24 24" aria-hidden>
        <path d="M12 2.5l8.5 9.5-8.5 9.5L3.5 12z" /><circle cx="12" cy="12" r="2.3" />
      </svg>
      <button type="button" className="pmy-row" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <b className="pmy-who">Mystical</b>
        <span className="pmy-kd"><Icon size={11} strokeWidth={2.4} aria-hidden />{note.label}</span>
        <span className="pmy-tx">{note.line}</span>
        {at != null && <span className="pmy-t">{hhmm(at, h12)}</span>}
        {open ? <ChevronDown size={13} aria-hidden className="pmy-chev" /> : <ChevronRight size={13} aria-hidden className="pmy-chev" />}
      </button>
      {note.kind === "spinoff" && from ? (
        <div className="pmy-from">
          <Split size={13} aria-hidden />from
          <button type="button" className="pmy-link" onClick={() => openSession(from.id)}>{from.title}</button>
          {from.project ? <>in <ProjectTile project={from.project} />{projectName(from.project)}</> : null}
          {from.keys.length ? <span>· {shortKeys(from.keys).join(" · ")}</span> : null}
        </div>
      ) : null}
      {open && (
        <div className="pmy-sent">
          <div className="pmy-q">{text}</div>
          <div className="pmy-why">
            {note.why && <span><b>Why</b> {note.why}</span>}
            <span className="pmy-r">Sent as a prompt · not typed by you</span>
          </div>
        </div>
      )}
    </div>
  );
}

type Run = Pick<Turn, "model" | "effort" | "permission_mode">;

/** A goal's re-prompt (bridge/goals.py _NUDGE): the bridge's words to the model,
 *  so it is drawn as a one-line stamp, not as a prompt of yours. Its first line
 *  is "[goal n/max] <title>"; older ones say a bare "[goal]" with neither. */
function parseNudge(text: string): { n?: string; max?: string; title?: string; objective: string } | null {
  const m = /^\[goal(?: (\d+)\/(\d+))?\]([^\n]*)\n/.exec(text);
  if (!m) return null;
  const body = /complete:\n\n([\s\S]*?)\n\nContinue working on it\./.exec(text);
  return { n: m[1], max: m[2], title: m[1] ? m[3].trim() : undefined, objective: body ? body[1].trim() : text };
}

/** What you said — a prompt, or a steer sent into a turn already running. A
 *  node on the session's spine (spine.css, .mystical/design-drafts/session-one-feel,
 *  C · SPINE) and a bubble: one header line — who (You, Steer, Goal,
 *  Council, a teammate's name), where you sent it from (via Telegram), the /command it ran, the account or agent when it
 *  wasn't the default (lib/agents runtimeBadge), the model · effort · permission
 *  the turn ran with, and when; a Savers trial's saver says so ("Trim tests · trial").
 *  A value that moved since the turn before is lit; a turn from before turns
 *  recorded effort and mode shows only its model — nothing is borrowed from the
 *  session's current picks. Then your words. Geometry and colour live in
 *  `.pbub` / `.pline` / `.pmeta` (index.css, DOSSIER tier 1; spine.css). */
export function PromptBubble({ text, at, runtime, run, prev, steer, who, via, commands, savers, children }: {
  text: string;
  /** Where you sent it from when it wasn't the dashboard (lib/sender viaTag). */
  via?: string | null;
  /** The Savers trials this session drew the saver in (Transcript.savers). */
  savers?: string[];
  at?: number;
  /** The project's command list: a leading `/name` it knows is drawn as a command. */
  commands?: SlashCommand[];
  /** 'claude:<slot>' | 'acp:<agent>'; null or absent = the default account, unmarked. */
  runtime?: string | null;
  /** What this turn ran with, and what the turn before it ran with; a steer has neither. */
  run?: Run;
  prev?: Run;
  steer?: boolean;
  /** Whose words these are when they aren't yours: the teammate who asked for
   *  a device run (lib/devicerun). Their name leads the tag the way ↳ STEER does. */
  who?: string;
  /** Under your words, inside the plate: a steer's screenshots. */
  children?: ReactNode;
}) {
  const h12 = useClock12();
  const ran = runtime ? runtimeBadge(runtime) : null;
  const nudge = steer ? null : parseNudge(text);
  // The council's own prompts (bridge/council.py): stamped like a goal's re-prompt.
  const council = steer || nudge ? null : parseCouncilPrompt(text);
  const councilTag = !council ? "" : "advice" in council ? "Council · advice"
    : `Council ${council.round}/${council.max} · ${"fix" in council ? "fix" : `${council.score.toFixed(1)} of ${council.bar.toFixed(1)}`}`;
  const [brief, setBrief] = useState(false);
  const purple = nudge || council ? { color: "var(--acc)" } : undefined;
  const glyph = steer ? "↳" : nudge ? "◎" : council ? "⚖" : null;
  const cmd = steer || nudge || council || !commands ? null : leadCommand(text, undefined, commands);
  // Pips lit = the effort's place in the picker (Auto 0 … Max 5); an agent's own
  // effort id isn't on that ladder and reads as its word alone.
  const lvl = run?.effort ? EFFORTS.findIndex((e) => e.id === (run.effort === "auto" ? "" : run.effort)) : -1;
  // Lit only when both turns recorded it: an older turn's unknown is no change.
  const moved = (k: keyof Run) => (prev?.[k] && run?.[k] && prev[k] !== run[k]) || undefined;
  // Which node the session's spine draws for it (spine.css).
  const kind = steer ? "steer" : nudge ? "goal" : council ? "council" : who ? "who" : "you";
  const meta = [
    <b key="who" style={purple}>
      {steer ? "Steer" : nudge ? `Goal${nudge.n ? ` · auto ${nudge.n}/${nudge.max}` : ""}` : council ? councilTag : who || "You"}
    </b>,
    via && <span key="via" className="pvia"><Send size={11} aria-hidden />{via}</span>,
    cmd && <span key="cmd" className="pcmd" title={cmd.desc}>/{cmd.name}</span>,
    ...(run ? savers ?? [] : []).map((k) => (
      <span key={`saver-${k}`} className="psaver" title="this session drew the saver in a Savers trial (SETTINGS ▸ AI management ▸ Savers)">
        {saverTag(k)}
      </span>
    )),
    ran && <span key="acct" className="pacct" data-agent={ran.agent || undefined} title={ran.title}>{ran.text}</span>,
    run?.model && <span key="model" className="prun pmodel" data-new={moved("model")} title="model">{modelName(run.model)}</span>,
    run?.effort && (
      <span key="effort" className="prun" data-new={moved("effort")} title="effort">
        {lvl >= 0 && (
          <span className="ppips" aria-hidden>{[1, 2, 3, 4, 5].map((i) => <i key={i} data-on={i <= lvl || undefined} />)}</span>
        )}
        {lvl >= 0 ? EFFORTS[lvl].label : run.effort}
      </span>
    ),
    run?.permission_mode && (
      <span key="mode" className="prun" data-new={moved("permission_mode")} title="permission mode">
        {PERMS.find((p) => p.id === run.permission_mode)?.label ?? run.permission_mode}
      </span>
    ),
    at != null && <span key="at" className="pstamp">{hhmm(at, h12)}</span>,
  ].filter(Boolean);
  return (
    <div className="pbub-row" data-kind={kind}>
      <div className="pbub">
        <div className="pmeta">{meta}</div>
        <div className="pline" data-glyph={glyph ? "" : undefined}>
          {glyph && <span className="pglyph" aria-hidden style={purple}>{glyph}</span>}
          <div className="min-w-0">
            {nudge ? (
              <>
                {/* .md: the face and size the plate gives your own words. */}
                <div className="md">
                  <button className="pgoal-line" aria-expanded={brief} onClick={() => setBrief((b) => !b)} title={nudge.objective}>
                    <span><span className="pgoal-k">Keep going</span> — {nudge.title || nudge.objective}</span>
                    <span className="pgoal-t">{brief ? "brief ▴" : "brief ▾"}</span>
                  </button>
                </div>
                {brief && <Markdown breaks className="pgoal-brief break-words leading-relaxed">{nudge.objective}</Markdown>}
              </>
            ) : council ? (
              <>
                <div className="md">
                  <button className="pgoal-line" aria-expanded={brief} onClick={() => setBrief((b) => !b)}>
                    <span><span className="pgoal-k">{"advice" in council ? "Council advice" : "fix" in council ? "Fix this" : "Fix the findings"}</span> — {("score" in council && sevCount(council.body)) || council.body.split("\n")[0]}</span>
                    <span className="pgoal-t">{brief ? "prompt ▴" : "prompt ▾"}</span>
                  </button>
                </div>
                {brief && <Markdown breaks className="pgoal-brief break-words leading-relaxed">{council.body}</Markdown>}
              </>
            ) : (
              /* Rendered as the same markdown the composer let you write it in. */
              <Markdown breaks typed={!who} className="break-words leading-relaxed text-foreground-bright">{cmd ? text.slice(cmd.end) : text}</Markdown>
            )}
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
