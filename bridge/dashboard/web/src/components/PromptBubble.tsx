import type { ReactNode } from "react";
import { Markdown } from "./Markdown";
import { EFFORTS, PERMS } from "./Composer";
import type { Turn } from "../chat";
import { modelName } from "../models";
import { runtimeBadge } from "../lib/agents";
import { hhmm, useClock12 } from "../lib/surfaces";

type Run = Pick<Turn, "model" | "effort" | "permission_mode">;

/** What you said — a prompt, or a steer sent into a turn already running. The
 *  prompt glyph leads your words and the plate holds nothing else: the rest
 *  rides one tag pinned to the plate's lower edge — ↳ STEER or ⧖ WAIT OVER when
 *  it isn't a prompt of yours, the account or agent when it wasn't the default
 *  (lib/agents runtimeBadge), the model · effort · permission the turn ran with,
 *  and when. A value that moved since the turn before is lit; a turn from before
 *  turns recorded effort and mode shows only its model — nothing is borrowed from
 *  the session's current picks. Geometry and colour live in `.pbub` / `.pline` /
 *  `.pmeta` (index.css, DOSSIER tier 1); nothing here decides either. Design:
 *  .mystical/design-drafts/sent-prompt, B · RIM. */
export function PromptBubble({ text, at, runtime, run, prev, steer, children }: {
  text: string;
  at?: number;
  /** 'claude:<slot>' | 'acp:<agent>'; null or absent = the default account, unmarked. */
  runtime?: string | null;
  /** What this turn ran with, and what the turn before it ran with; a steer has neither. */
  run?: Run;
  prev?: Run;
  steer?: boolean;
  /** Under your words, inside the plate: a steer's screenshots. */
  children?: ReactNode;
}) {
  const h12 = useClock12();
  const ran = runtime ? runtimeBadge(runtime) : null;
  // The bridge's wake-up for a session that waited on another (bridge/waits.py):
  // its words, but not yours.
  const wake = !steer && text.startsWith("⧖ ");
  const purple = wake ? { color: "var(--purple)" } : undefined;
  // Pips lit = the effort's place in the picker (Auto 0 … Max 5); an agent's own
  // effort id isn't on that ladder and reads as its word alone.
  const lvl = run?.effort ? EFFORTS.findIndex((e) => e.id === (run.effort === "auto" ? "" : run.effort)) : -1;
  // Lit only when both turns recorded it: an older turn's unknown is no change.
  const moved = (k: keyof Run) => (prev?.[k] && run?.[k] && prev[k] !== run[k]) || undefined;
  const meta = [
    (wake || steer) && <b key="who" style={purple}>{wake ? "⧖ WAIT OVER" : "↳ STEER"}</b>,
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
    <div className="pbub-row">
      <div className="pbub">
        <div className="pline">
          <span className="pglyph" aria-hidden style={purple}>{wake ? "⧖" : steer ? "↳" : "❯"}</span>
          <div className="min-w-0">
            {/* Rendered as the same markdown the composer let you write it in. */}
            <Markdown breaks className="break-words leading-relaxed text-foreground-bright">{wake ? text.slice(2) : text}</Markdown>
            {children}
          </div>
        </div>
        {meta.length > 0 && <div className="pmeta">{meta}</div>}
      </div>
    </div>
  );
}
