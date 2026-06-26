import type { AnswerSelection } from "../api";
import type { PendingRequest, Turn } from "../chat";
import { RunStream } from "./RunStream";
import { WorkingIndicator } from "./hud/WorkingIndicator";
import { RuneSpirit } from "./hud/RuneSpirit";

function Attachments({ items }: { items: string[] }) {
  const imgs = items.filter((a) => a.startsWith("data:") || a.startsWith("http"));
  const others = items.length - imgs.length;
  return (
    <div className="flex gap-[9px]">
      <span className="flex-none select-none text-violet opacity-0" aria-hidden>
        ~ ❯
      </span>
      <div className="flex flex-wrap items-center gap-2">
        {imgs.map((src, i) => (
          <img
            key={i}
            src={src}
            alt="attachment"
            className="h-16 w-16 border border-border object-cover"
          />
        ))}
        {others > 0 && (
          <span className="text-[11px] tracking-[0.5px] text-muted-2">
            📎 {others} image{others > 1 ? "s" : ""}
          </span>
        )}
      </div>
    </div>
  );
}

type Respond = (
  requestId: string,
  opts: { behavior?: "allow" | "deny"; answers?: AnswerSelection[] },
) => void;

export function Transcript({
  turns,
  activeId,
  onRespond,
  liveTurns,
  trailingWorking,
}: {
  turns: Turn[];
  activeId: string | null;
  onRespond: Respond;
  liveTurns?: Set<string>;
  trailingWorking?: boolean;
}) {
  if (!turns.length) {
    return <RuneSpirit variant="block" />;
  }
  return (
    <div className="flex flex-col gap-3">
      {turns.map((turn) => {
        const isActive = turn.id === activeId;
        const working = isActive && turn.status === "running" && turn.pending.length === 0;
        return (
          <div key={turn.id} className="flex flex-col gap-1.5">
            {turn.prompt && (
              <div className="flex gap-[9px]">
                <span className="flex-none text-violet">~ ❯</span>
                <span className="min-w-0 whitespace-pre-wrap break-words text-foreground-bright">
                  {turn.prompt}
                </span>
              </div>
            )}
            {turn.attachments && turn.attachments.length > 0 && (
              <Attachments items={turn.attachments} />
            )}
            {(turn.events.length > 0 || turn.status === "running") && (
              <RunStream
                events={turn.events}
                pending={turn.pending as PendingRequest[]}
                onRespond={isActive ? onRespond : undefined}
                animate={liveTurns?.has(turn.id) ?? false}
                turnId={turn.id}
              />
            )}
            {working && <WorkingIndicator />}
          </div>
        );
      })}
      {/* Native (VS Code) live session: no turn is ever "running", so the working
          state comes from the unified status map instead of turn.status. */}
      {trailingWorking && <WorkingIndicator />}
    </div>
  );
}
