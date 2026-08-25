import { useState } from "react";
import { api, type AccountInfo, type GitStatus } from "../../api";
import type { AgentOption } from "../../models";
import { Drop } from "../Composer";

/* Where the open session's branch stands against its remote. `upstream: ""`
   means the branch was never pushed — ahead/behind are 0 there too, so the
   counts alone would read as "in sync" for a branch the remote has never
   seen. Undefined upstream = backend too old to report it; stay quiet rather
   than guess. Counts come from the last fetch, so "SYNCED" means "synced as
   of what this checkout knows", which the tooltip says out loud. */
function syncChip(git: GitStatus): { text: string; warn: boolean; title: string } | null {
  if (git.upstream === undefined) return null;
  const { ahead, behind, upstream } = git;
  if (!upstream)
    return { text: "LOCAL ONLY", warn: true,
             title: "This branch has no remote tracking branch — it exists only in this checkout" };
  if (ahead && behind)
    return { text: `↑${ahead} ↓${behind} DIVERGED`, warn: true,
             title: `Diverged from ${upstream}: ${ahead} local, ${behind} remote. Counts are from the last fetch.` };
  if (ahead)
    return { text: `↑${ahead} UNPUSHED`, warn: true,
             title: `${ahead} commit${ahead === 1 ? "" : "s"} not yet on ${upstream}` };
  if (behind)
    return { text: `↓${behind} BEHIND`, warn: true,
             title: `${behind} commit${behind === 1 ? "" : "s"} on ${upstream} not pulled in. Counts are from the last fetch.` };
  return { text: "SYNCED", warn: false,
           title: `Even with ${upstream} as of the last fetch` };
}

export interface StatusBarProps {
  mount: string;
  usedPct: number | null;      // null → usage unknown, shown as "—"
  resetLabel?: string | null;
  accounts?: AccountInfo[];    // >1 → per-account chips (multi-login fallback)
  agent?: AgentOption | null;  // who runs the next turn (composer's AGENT picker)
  agents?: AgentOption[];      // everything that pick could land on
  repo: string;
  changes: number;
  git?: GitStatus | null;      // open session's working tree; null while loading
  // Open session's context-window fill, measured on its last request. Both null
  // until a turn has run under the meter, and then the chip stays hidden.
  ctxTokens?: number | null;
  ctxWindow?: number | null;
  // Swap key for the CTX chip only — a new session is a new measurement even
  // when the percent happens to match.
  sessionId?: string | null;
  // The worktree the footer is reporting on, so PUBLISH pushes that tree and
  // not the project checkout. Same value the git status was fetched with.
  branch?: string | null;
  // Push or pull landed — the footer's git poll is 10s, too slow to watch a
  // chip you just changed, so the owner of that poll re-reads it now.
  onSynced?: () => void;
  onPalette: () => void;
  // Same action as the composer's AGENT picker, so the footer switches who runs
  // the turn rather than only reporting it. Takes an agent option id.
  onPickAgent?: (id: string) => void;
}

export function StatusBar(props: StatusBarProps) {
  const { mount, usedPct, resetLabel, accounts = [], agent, agents = [], repo, changes,
          git, ctxTokens, ctxWindow, sessionId, branch, onSynced, onPalette, onPickAgent } = props;
  // Window fill of the open session. Unmeasured (no turn yet under the meter)
  // shows nothing rather than 0%, which would read as "plenty of room".
  const ctxPct = ctxTokens && ctxWindow ? Math.round((ctxTokens / ctxWindow) * 100) : null;
  const [hovered, setHovered] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);

  // A picker over one option is just a label with extra clicks, so the plain
  // read-only chip stays until there is somewhere else to land.
  const canPick = Boolean(onPickAgent) && agents.length > 1;

  // A switch settles the session-scoped chips in the way the right panel's
  // .swapin regions do. Keyed on their VALUE, not the session — a chip whose
  // text survives the switch (same repo, same count) has nothing new to show
  // and must not replay. Branch and sync animate on their own mount when the
  // git fetch lands. mfadeup carries no opacity, so nothing blinks out.
  const swap = { animation: "mfadeup .32s cubic-bezier(.2,.8,.2,1) both" };
  // Branch and sync arrive with that fetch, well after the switch — dim
  // stand-ins hold their slots so the right cluster doesn't collapse and then
  // shove everything left of ⌘K around when they land.
  const gitPending = git == null && repo !== "—";

  // The meter has to belong to whoever is actually running the turns. usedPct
  // is the *ambient* login's 5-hour window (from /local/usage), so it only
  // stands for the default account; another login reports its own headroom, and
  // a free agent has no Claude quota to report at all.
  const sync = git?.is_repo ? syncChip(git) : null;
  // Every link of the branch chain is the same box; .chain draws the hairline
  // between them, since inline styles can't say :first-child.
  const seg = { padding: "2px 9px", display: "inline-block" } as const;

  // Moving commits either direction, offered only where a plain command can
  // succeed: push when the remote is missing commits (or the whole branch),
  // pull when this checkout is strictly behind (git.pull is --ff-only).
  // Diverged offers neither — that needs a merge/rebase decision, not a tap.
  const canPush = !!git?.is_repo && repo !== "—" && !git.behind &&
    git.upstream !== undefined && (git.upstream === "" || git.ahead > 0);
  const canPull = !!git?.is_repo && repo !== "—" && !!git.upstream &&
    git.behind > 0 && !git.ahead;
  const [busy, setBusy] = useState(false);
  const [syncErr, setSyncErr] = useState("");
  const [actHov, setActHov] = useState(false);
  async function doSync(kind: "push" | "pull") {
    if (repo === "—" || busy) return;
    setBusy(true);
    setSyncErr("");
    try {
      const r = kind === "push"
        ? await api.gitPush(repo, branch || undefined)
        : await api.gitPull(repo, branch || undefined);
      if (!r.ok) setSyncErr(r.output || `${kind} failed`);
      else onSynced?.();
    } catch (e) { setSyncErr((e as Error).message); }
    finally { setBusy(false); }
  }
  // The one button the chain earns right now. canPush and canPull are mutually
  // exclusive (each requires the other's count to be zero), so this is a slot,
  // not a row of buttons.
  const action = canPush
    ? { kind: "push" as const,
        label: git?.upstream ? "↑ PUSH" : "↑ PUBLISH",
        busyLabel: "SENDING…",
        title: git?.upstream
          ? `Push ${git.ahead} commit${git.ahead === 1 ? "" : "s"} to ${git.upstream}`
          : `Publish ${git?.branch} to origin — it exists only in this checkout` }
    : canPull
    ? { kind: "pull" as const,
        label: "↓ PULL",
        busyLabel: "PULLING…",
        title: `Fast-forward ${git?.behind} commit${git?.behind === 1 ? "" : "s"} from ${git?.upstream}` }
    : null;
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
        fontSize: "var(--t10)",
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
      {ctxPct !== null && (
        <span
          key={`ctx:${sessionId}`}
          title={`This session's last request filled ${ctxTokens?.toLocaleString()} of ${ctxWindow?.toLocaleString()} context tokens. Right-click the session to change when it compacts.`}
          style={{ ...swap, color: ctxPct >= 90 ? "var(--warn)" : "var(--txd)" }}
        >
          CTX <span style={{ color: ctxPct >= 75 ? "var(--warn)" : "var(--tx)" }}>{ctxPct}%</span>
        </span>
      )}
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
      <span key={`repo:${repo}`} style={swap}>
        REPO <span style={{ color: "var(--tx)" }}>{repo}</span>
      </span>
      {/* One chain, not three loose labels: the branch and the two facts that
          are only true *of that branch* — where it stands against its remote,
          and what its working tree is holding — welded into a single bordered
          group whose segments are separated by hairlines (.chain). */}
      <span className="chain" style={{
        display: "flex", alignItems: "center",
        border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)",
      }}>
        {gitPending && (
          <>
            <span aria-hidden style={{ ...seg, color: "var(--txd)", opacity: 0.4, minWidth: "60px" }}>⎇ ···</span>
            <span aria-hidden style={{ ...seg, color: "var(--txd)", opacity: 0.4, minWidth: "70px" }}>···</span>
          </>
        )}
        {git?.branch && (
          <span title={`Branch checked out in the open session's working tree`}
                style={{ ...seg, ...swap, color: "var(--tx)" }}>
            ⎇ {git.branch}
          </span>
        )}
        {sync && (
          <span title={sync.title}
                style={{ ...seg, ...swap, color: sync.warn ? "var(--warn)" : "var(--txd)" }}>
            {sync.text}
          </span>
        )}
        {/* A clean tree is the quiet norm, not a warning — it only speaks up
            (amber, a count) once there is something uncommitted. */}
        <span key={`chg:${changes}`}
              title={changes
                ? `${changes} uncommitted file${changes === 1 ? "" : "s"} in the working tree`
                : "Working tree clean"}
              style={{ ...seg, ...swap, color: changes ? "var(--warn)" : "var(--txd)" }}>
          {changes ? `${changes} CHANGES` : "CLEAN"}
        </span>
        {/* VS Code's "publish branch" / "sync", in the link of the chain the
            state it fixes lives in. Tinted so it reads as the one pressable
            segment; FAILED keeps git's message in the tooltip and retries on
            click. */}
        {action && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void doSync(action.kind)}
            title={syncErr || action.title}
            style={{
              ...seg,
              font: "inherit",
              letterSpacing: "inherit",
              border: 0,
              background: syncErr ? "color-mix(in srgb, var(--err) 10%, transparent)"
                : busy ? "transparent"
                : `color-mix(in srgb, var(--acc) ${actHov ? 18 : 9}%, transparent)`,
              color: syncErr ? "var(--err)" : busy ? "var(--txd)" : "var(--acc)",
              cursor: busy ? "default" : "pointer",
            }}
            onMouseEnter={() => setActHov(true)}
            onMouseLeave={() => setActHov(false)}
          >
            {busy ? action.busyLabel : syncErr ? "FAILED" : action.label}
          </button>
        )}
      </span>
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
          fontSize: "var(--t10)",
          letterSpacing: "1.5px",
          padding: "4px 11px",
        }}
      >
        ⌘K COMMAND
      </button>
    </div>
  );
}
