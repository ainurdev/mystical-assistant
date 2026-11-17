import { useState, type ReactNode } from "react";
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
 *  C · SPINE) and a bubble: one header line — who (You, Steer, Wait over, Goal,
 *  Council, a teammate's name), the /command it ran, the account or agent when it
 *  wasn't the default (lib/agents runtimeBadge), the model · effort · permission
 *  the turn ran with, and when; a Savers trial's saver says so ("Concise · trial").
 *  A value that moved since the turn before is lit; a turn from before turns
 *  recorded effort and mode shows only its model — nothing is borrowed from the
 *  session's current picks. Then your words. Geometry and colour live in
 *  `.pbub` / `.pline` / `.pmeta` (index.css, DOSSIER tier 1; spine.css). */
export function PromptBubble({ text, at, runtime, run, prev, steer, who, commands, savers, children }: {
  text: string;
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
  // The bridge's wake-up for a session that waited on another (bridge/waits.py):
  // its words, but not yours.
  const wake = !steer && text.startsWith("⧖ ");
  const nudge = steer || wake ? null : parseNudge(text);
  // The council's own prompts (bridge/council.py): stamped like a goal's re-prompt.
  const council = steer || wake || nudge ? null : parseCouncilPrompt(text);
  const councilTag = !council ? "" : "advice" in council ? "Council · advice"
    : `Council ${council.round}/${council.max} · ${"fix" in council ? "fix" : `${council.score.toFixed(1)} of ${council.bar.toFixed(1)}`}`;
  const [brief, setBrief] = useState(false);
  const purple = wake ? { color: "var(--purple)" } : nudge || council ? { color: "var(--acc)" } : undefined;
  const glyph = wake ? "⧖" : steer ? "↳" : nudge ? "◎" : council ? "⚖" : null;
  const cmd = steer || wake || nudge || council || !commands ? null : leadCommand(text, undefined, commands);
  // Pips lit = the effort's place in the picker (Auto 0 … Max 5); an agent's own
  // effort id isn't on that ladder and reads as its word alone.
  const lvl = run?.effort ? EFFORTS.findIndex((e) => e.id === (run.effort === "auto" ? "" : run.effort)) : -1;
  // Lit only when both turns recorded it: an older turn's unknown is no change.
  const moved = (k: keyof Run) => (prev?.[k] && run?.[k] && prev[k] !== run[k]) || undefined;
  // Which node the session's spine draws for it (spine.css).
  const kind = wake ? "wake" : steer ? "steer" : nudge ? "goal" : council ? "council" : who ? "who" : "you";
  const meta = [
    <b key="who" style={purple}>
      {wake ? "Wait over" : steer ? "Steer" : nudge ? `Goal${nudge.n ? ` · auto ${nudge.n}/${nudge.max}` : ""}` : council ? councilTag : who || "You"}
    </b>,
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
              <Markdown breaks typed={!wake && !who} className="break-words leading-relaxed text-foreground-bright">{cmd ? text.slice(cmd.end) : wake ? text.slice(2) : text}</Markdown>
            )}
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
