import { useState } from "react";
import { FlaskConical } from "lucide-react";
import { setExperimental, useExperimental } from "../../lib/multistore";
import { HelpersRow } from "../HelpersRow";
import { CARD, MiniBtn, Row, Section, Switch } from "./SettingsModal";

/* SETTINGS ▸ System ▸ Experimental: the switch behind multi-agent chats and the limits a
   new chat starts from. docs/superpowers/plans/multi-agent-chats.md holds the rules. What's
   shared between models moved to SETTINGS ▸ Agent Tools (AgentToolsPage). */

/** SETTINGS ▸ System's EXPERIMENTAL block. `top` as Section's: it follows another. */
export function ExperimentalSection({ top, onOpenAgentTools }: { top?: boolean; onOpenAgentTools: () => void }) {
  const exp = useExperimental();
  const [error, setError] = useState<string | null>(null);
  const flip = () => {
    setError(null);
    setExperimental({ enabled: !exp.enabled }).catch((e: Error) => setError(e.message));
  };
  return (
    <>
      <Section title="EXPERIMENTAL" icon={FlaskConical} top={top}
        desc="Lets a chat switch provider between turns and run helper agents beside it, with MCP servers and skills shared across models."
        info={<>
          Off, the bridge and the dashboard behave as they did. Helpers cost tokens quickly: this suits review, research and
          well-separated pieces, and suits tightly linked coding less. What's sent to another provider goes to its vendor.
          One gap stays open: an agent with shell access could start Claude itself, outside these rules. Asking mode and deny rules are the mitigation.
        </>}>
        <div style={CARD}>
          <Row first label="MULTI-AGENT CHATS"
            desc={exp.stale ? "The bridge is running older code than this dashboard. Restart the bridge to use this." : undefined}>
            {exp.stale ? <span className="ma-tag" data-tone="warn">RESTART THE BRIDGE</span>
              : !exp.loaded ? <span className="ma-set-note" role="status">reading…</span>
              : <Switch on={exp.enabled} onClick={flip} label="Multi-agent chats" />}
          </Row>
          {error && <div className="ma-set-err" role="alert">{error}</div>}
          {exp.enabled && (
            <Row label="A NEW CHAT STARTS WITH" desc="Each chat can change these in its model picker. Lowering a limit stops nothing already running." />
          )}
          {exp.enabled && (
            <HelpersRow config={exp.defaults} onChange={(patch) => setExperimental({ defaults: patch }).catch((e: Error) => { setError(e.message); throw e; })} />
          )}
          {exp.enabled && (
            <Row label="SHARED SERVERS, SKILLS AND TOOLS" desc="Which agent can reach what, at the machine, a project or a chat, with rules and hooks beside them.">
              <MiniBtn onClick={onOpenAgentTools}>AGENT TOOLS ›</MiniBtn>
            </Row>
          )}
        </div>
      </Section>
    </>
  );
}
