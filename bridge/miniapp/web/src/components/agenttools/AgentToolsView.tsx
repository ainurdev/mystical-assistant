import { useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "../../lib/api";
import { LEVELS, levelsOpen, levelWord, type Level, type ToolScope } from "../../lib/agenttools";
import { useChat } from "../../lib/chat";
import { DirPane } from "./DirPane";
import { HooksPane } from "./HooksPane";
import { Fail, Loading, useBackLayer } from "./parts";
import { RulesPane } from "./RulesPane";
import { McpPane, MysticalPane, SkillsPane, ToolsPane, type ToolsEnv } from "./ToolLists";

/* SYSTEM ▸ AGENT TOOLS, while the experimental switch is on: the dashboard's page of what each
   agent can use, folded into a phone. One section at a time, every section's name always in
   view, the level the switches write at under them, because which level a change lands at is
   the thing you most need to see while you make it. Sections with no levels hide the picker. */

type Section = "mcp" | "skills" | "tools" | "mystical" | "rules" | "hooks" | "dir";

const SECTIONS: { id: Section; label: string; about: string; levels?: boolean }[] = [
  { id: "mcp", label: "MCP", about: "Which agent may use which server, through Mystical.", levels: true },
  { id: "skills", label: "Skills", about: "A shared skill is one folder every agent reads. Nothing is copied." },
  { id: "tools", label: "Tools", about: "Claude's built-in tools. Other agents take no tool list, so they can't be switched here.", levels: true },
  { id: "mystical", label: "Mystical tools", about: "What Mystical itself gives each agent.", levels: true },
  { id: "rules", label: "Rules", about: "\"When X, do Y\" for any agent, without writing a hook.", levels: true },
  { id: "hooks", label: "Hooks", about: "" },
  { id: "dir", label: ".mystical", about: "This project's folder: git never sees it, and nothing in it cleans itself." },
];

function ToolSection({ section, scope, cwd, level }: { section: Section; scope: ToolScope; cwd: string | null; level: Level }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["at-grid", scope.session, scope.project], queryFn: () => api.agentTools(scope) });
  if (q.isLoading) return <Loading what="tools" />;
  if (!q.data) return <Fail error={q.error} onRetry={() => void q.refetch()} />;
  const env: ToolsEnv = { grid: q.data, scope, cwd, level, refresh: () => qc.invalidateQueries({ queryKey: ["at-grid"] }) };
  return (
    <>
      {q.isError && <Fail error={q.error} onRetry={() => void q.refetch()} />}
      {section === "mcp" && <McpPane env={env} />}
      {section === "skills" && <SkillsPane env={env} />}
      {section === "tools" && <ToolsPane env={env} />}
      {section === "mystical" && <MysticalPane env={env} />}
    </>
  );
}

function AgentToolsView({ onClose }: { onClose: () => void }) {
  const { sessionId, project, openBrief } = useChat();
  const scope: ToolScope = { session: sessionId, project: openBrief?.project ?? project };
  const cwd = openBrief?.cwd ?? null;
  const open = levelsOpen(scope);
  const [section, setSection] = useState<Section>("mcp");
  const [picked, setPicked] = useState<Level>("machine");
  // The chat this was opened on can go away underneath, and a level with nothing to write to errors.
  const level: Level = open[picked] ? picked : "machine";
  const here = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  const name = scope.project?.split("/").pop();
  useBackLayer(onClose);
  return createPortal(
    <div className="atv-view" role="dialog" aria-label="Agent Tools">
      <div className="atv-head">
        <button type="button" onClick={onClose} aria-label="Back to System" className="flex h-11 w-11 flex-none items-center justify-center">
          <ChevronLeft size={18} aria-hidden />
        </button>
        <span className="glow flex-none text-[13px] tracking-[3px] text-foreground-bright">AGENT TOOLS</span>
        {name && <span className="min-w-0 flex-1 truncate pr-3 text-right text-[10px] tracking-wider text-[var(--tg-hint)]">{name.toUpperCase()}</span>}
      </div>
      <div className="atv-tabs" role="tablist" aria-label="Sections">
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" role="tab" aria-selected={section === s.id} onClick={() => setSection(s.id)}>{s.label}</button>
        ))}
      </div>
      {here.levels && (
        <div className="atv-levels">
          <div className="sseg atv-seg" role="group" aria-label="Level changes apply at">
            {LEVELS.map((l) => (
              <button key={l.value} type="button" aria-pressed={level === l.value} disabled={!open[l.value]} onClick={() => setPicked(l.value)}>{l.label}</button>
            ))}
          </div>
          <div className="atv-sub">
            {level === "machine" ? "Changes apply everywhere, unless a project or chat says otherwise."
              : level === "project" ? "Changes apply to this project, unless a chat says otherwise."
              : `Changes apply to this chat only. ${levelWord("chat")} wins over the rest.`}
          </div>
        </div>
      )}
      <div className="atv-body" key={section}>
        {here.about && <div className="atv-sub mb-2.5">{here.about}</div>}
        {section === "rules" ? <RulesPane scope={scope} level={level} />
          : section === "hooks" ? <HooksPane scope={scope} />
          : section === "dir" ? <DirPane scope={scope} />
          : <ToolSection section={section} scope={scope} cwd={cwd} level={level} />}
      </div>
    </div>,
    document.body,
  );
}

/** The SYSTEM tab's way in. Only drawn while the experimental switch is on. */
export function AgentToolsEntry() {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2">
      <div className="sset-head">Agents</div>
      <div className="sset">
        <button type="button" onClick={() => setOpen(true)} className="atv-item-head">
          <span className="min-w-0 flex-1">
            <span className="sset-key block">Agent Tools</span>
            <span className="sset-desc block">MCP, skills, tools, rules, hooks and the .mystical folder.</span>
          </span>
          <ChevronRight size={15} aria-hidden className="flex-none text-[var(--tg-hint)]" />
        </button>
      </div>
      {open && <AgentToolsView onClose={() => setOpen(false)} />}
    </div>
  );
}
