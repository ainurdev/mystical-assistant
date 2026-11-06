import { ChevronLeft } from "lucide-react";
import { useChat } from "../lib/chat";
import { providerName } from "../lib/multi";

export type AgentTab = "chat" | "agents" | "channel";

const TABS: { k: AgentTab; label: string }[] = [
  { k: "chat", label: "CHAT" },
  { k: "agents", label: "AGENTS" },
  { k: "channel", label: "CHANNEL" },
];

/** The bar over a multi-agent chat: a way back when you're inside a helper, and
 *  CHAT | AGENTS | CHANNEL. Sticks under the header so a long transcript keeps it. */
export function AgentBar({ tab, onTab, showTabs, needs, held }: {
  tab: AgentTab;
  onTab: (t: AgentTab) => void;
  showTabs: boolean;
  /** Agents waiting on you, marked on AGENTS so it's seen from the transcript. */
  needs: number;
  /** Messages held, marked on CHANNEL the same way. */
  held: number;
}) {
  const { openBrief, sessions, selectSession, experimental } = useChat();
  const parent = experimental ? openBrief?.parent_session ?? null : null;
  if (!parent && !showTabs) return null;
  const parentTitle = sessions.find((s) => s.id === parent)?.title;
  return (
    <div className="ag-bar">
      {parent && (
        <button type="button" className="ag-back" onClick={() => selectSession(parent)}>
          <ChevronLeft size={16} className="flex-none" aria-hidden />
          <span>Back to {parentTitle || "the main chat"}</span>
          <span className="ml-auto flex-none pl-2 text-[10px] tracking-[.08em] text-[var(--muted-2)]">
            {providerName(openBrief?.agent).toUpperCase()}
          </span>
        </button>
      )}
      {showTabs && (
        <div className="ag-tabs" role="tablist" aria-label="View">
          {TABS.map((t) => (
            <button key={t.k} type="button" role="tab" aria-selected={tab === t.k} onClick={(e) => {
              // The grid opens at its top, not at the transcript's scroll position.
              if (t.k !== "chat") e.currentTarget.closest(".overflow-y-auto")?.scrollTo({ top: 0 });
              onTab(t.k);
            }}>
              {t.label}
              {t.k === "agents" && needs > 0 ? <b>{needs}</b> : null}
              {t.k === "channel" && held > 0 ? <b>{held}</b> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
