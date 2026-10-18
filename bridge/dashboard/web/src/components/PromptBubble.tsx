import type { ReactNode } from "react";
import { Markdown } from "./Markdown";
import { runtimeBadge } from "../lib/agents";
import { hhmm, useClock12 } from "../lib/surfaces";

/** What you said — a prompt, or a steer sent into a turn already running. The
 *  prompt glyph leads your words; one footer line says who (YOU, or ↳ STEER),
 *  which turn, which account or agent ran it when that wasn't the default
 *  (lib/agents runtimeBadge — it used to be a box of its own under the prompt),
 *  and when. Geometry and colour live in `.pbub` / `.pline` / `.pmeta`
 *  (index.css, DOSSIER tier 1); nothing here decides either. */
export function PromptBubble({ text, at, n, runtime, steer, children }: {
  text: string;
  at?: number;
  /** The turn's number, 1-based; a steer has none. */
  n?: number;
  /** 'claude:<slot>' | 'acp:<agent>'; null or absent = the default account, unmarked. */
  runtime?: string | null;
  steer?: boolean;
  /** Under your words, inside the plate: a steer's screenshots. */
  children?: ReactNode;
}) {
  const h12 = useClock12();
  const ran = runtime ? runtimeBadge(runtime) : null;
  return (
    <div className="pbub-row">
      <div className="pbub">
        <div className="pline">
          <span className="pglyph" aria-hidden>{steer ? "↳" : "❯"}</span>
          <div className="min-w-0">
            {/* Rendered as the same markdown the composer let you write it in. */}
            <Markdown breaks className="break-words leading-relaxed text-foreground-bright">{text}</Markdown>
            {children}
          </div>
        </div>
        <div className="pmeta">
          <b>{steer ? "↳ STEER" : "YOU"}</b>
          {!steer && n != null && <span>TURN {String(n).padStart(2, "0")}</span>}
          {ran && <span className="pacct" data-agent={ran.agent || undefined} title={ran.title}>{ran.text}</span>}
          {at != null && <span className="pstamp">{hhmm(at, h12)}</span>}
        </div>
      </div>
    </div>
  );
}
