import { useState } from "react";
import type { AccountInfo } from "../../api";
import type { AgentOption } from "../../models";
import { Drop } from "../Composer";

export interface StatusBarProps {
  mount: string;
  usedPct: number | null;      // null → usage unknown, shown as "—"
  resetLabel?: string | null;
  accounts?: AccountInfo[];    // >1 → per-account chips (multi-login fallback)
  agent?: AgentOption | null;  // who runs the next turn (composer's AGENT picker)
  agents?: AgentOption[];      // everything that pick could land on
  repo: string;
  changes: number;
  onPalette: () => void;
  // Same action as the composer's AGENT picker, so the footer switches who runs
  // the turn rather than only reporting it. Takes an agent option id.
  onPickAgent?: (id: string) => void;
}

export function StatusBar(props: StatusBarProps) {
  const { mount, usedPct, resetLabel, accounts = [], agent, agents = [], repo, changes,
          onPalette, onPickAgent } = props;
  const [hovered, setHovered] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);

  // A picker over one option is just a label with extra clicks, so the plain
  // read-only chip stays until there is somewhere else to land.
  const canPick = Boolean(onPickAgent) && agents.length > 1;

  // The meter has to belong to whoever is actually running the turns. usedPct
  // is the *ambient* login's 5-hour window (from /local/usage), so it only
  // stands for the default account; another login reports its own headroom, and
  // a free agent has no Claude quota to report at all.
  const free = agent?.free ?? false;
  const pct = !agent || agent.def ? usedPct
    : agent.left === null ? null : 100 - agent.left;
  const showReset = resetLabel && (!agent || agent.def);

  return (
    <div
      style={{
        flex: "none",
        display: "flex",
        alignItems: "center",
        gap: "16px",
        padding: "8px 16px",
        borderTop: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)",
        fontSize: "10px",
        letterSpacing: "1.5px",
        color: "var(--txl)",
        animation: "enterUp .55s cubic-bezier(.2,.8,.2,1) both .36s",
      }}
    >
      <span style={{ color: "var(--txd)" }}>
        MOUNT <span style={{ color: "var(--acc)" }}>{mount}</span>
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: "7px" }}>
        {free ? (
          <span style={{ color: "var(--warn)" }} title="Not your Claude subscription — no usage window to spend">
            NO CLAUDE QUOTA
          </span>
        ) : (
          <>
            USED {pct === null ? "—" : `${pct}%`}
            <span
              style={{
                width: "120px",
                height: "4px",
                background: "color-mix(in srgb, var(--acc) 12%, transparent)",
                display: "inline-block",
                position: "relative",
                overflow: "hidden",
              }}
              title={agent && !agent.def
                ? `${agent.label} — percent of its tighter usage window spent`
                : undefined}
            >
              <span
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: `${pct ?? 0}%`,
                  background: "var(--acc)",
                  animation: "grow 1.2s ease both .4s",
                }}
              />
            </span>
            {showReset && (
              <span style={{ color: "var(--txd)" }}>
                RESET <span style={{ color: "var(--tx)" }}>{resetLabel}</span>
              </span>
            )}
          </>
        )}
        {/* Who those numbers (and the next turn) belong to — and, once there is
            more than one candidate, where you change it. Same options and same
            action as the composer's AGENT picker; the menu opens upward, which
            is what Drop already does for the composer. */}
        {agent && canPick && (
          <>
            {pickOpen && (
              <div onClick={() => setPickOpen(false)}
                   style={{ position: "fixed", inset: 0, zIndex: 25 }} />
            )}
            <span style={{ position: "relative", zIndex: 26, color: free ? "var(--warn)" : "var(--acc)" }}>
              <Drop
                label="AGENT"
                showLabel={false}
                value={agent.id}
                // Dropping `short` leaves Drop on the full label, so the footer
                // keeps reading "A1 · you@example.com · 68% LEFT" as it did.
                options={agents.map((a) => ({ id: a.id, label: a.label }))}
                minWidth={0}
                open={pickOpen}
                onToggle={() => setPickOpen((v) => !v)}
                onPick={(id) => { onPickAgent?.(id); setPickOpen(false); }}
              />
            </span>
          </>
        )}
        {agent && !canPick && (
          <span
            title={free
              ? `Turns run on ${agent.label} via opencode — add another login or a free agent to switch`
              : `Turns run on ${agent.label} — add another login or a free agent to switch`}
            style={{
              border: "1px solid color-mix(in srgb, currentColor 35%, transparent)",
              padding: "2px 7px",
              color: free ? "var(--warn)" : "var(--acc)",
              maxWidth: "230px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {free ? "⚡ " : "◉ "}{agent.label}
          </span>
        )}
      </span>
      {accounts.length > 1 && (
        <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {accounts.map((a) => {
            const live = agent?.id === `claude:${a.slot}`;
            // A disabled button covers both "this login is switched off" and
            // "nobody wired a handler", so the chip stays one element either way.
            const off = a.disabled || !onPickAgent;
            return (
              <button
                key={a.slot}
                type="button"
                disabled={off}
                aria-pressed={live}
                onClick={() => onPickAgent?.(`claude:${a.slot}`)}
                title={`${a.email ?? "unknown"}${a.default ? " (default)" : ""}${a.disabled ? " (disabled)" : ""}${live ? " — running your turns" : " — click to run your turns on this login"}`}
                style={{
                  font: "inherit",
                  letterSpacing: "inherit",
                  border: `1px solid color-mix(in srgb, var(--acc) ${live ? 60 : 22}%, transparent)`,
                  background: live ? "color-mix(in srgb, var(--acc) 12%, transparent)" : "transparent",
                  padding: "2px 7px",
                  color: a.disabled ? "var(--txd)"
                    : a.left !== null && a.left <= 1 ? "var(--warn)" : "var(--tx)",
                  opacity: a.disabled ? 0.55 : 1,
                  cursor: off ? "default" : "pointer",
                }}
              >
                A{a.slot} {a.left === null ? "—" : `${a.left}%`}
              </button>
            );
          })}
        </span>
      )}
      <span style={{ flex: 1 }} />
      <span>
        REPO <span style={{ color: "var(--tx)" }}>{repo}</span>
      </span>
      <span style={{ color: "var(--warn)" }}>{changes} CHANGES</span>
      <button
        onClick={onPalette}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          appearance: "none",
          cursor: "pointer",
          border: "1px solid color-mix(in srgb, var(--acc) 22%, transparent)",
          background: hovered ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent",
          color: hovered ? "var(--tx)" : "var(--txd)",
          fontFamily: "inherit",
          fontSize: "10px",
          letterSpacing: "1.5px",
          padding: "4px 11px",
        }}
      >
        ⌘K COMMAND
      </button>
    </div>
  );
}
