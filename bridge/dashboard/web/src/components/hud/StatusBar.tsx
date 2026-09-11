import { useState, type CSSProperties, type ReactNode } from "react";
import { api, type GitStatus } from "../../api";
import type { AgentOption } from "../../models";

/* Where the open session's branch stands against its remote. `upstream: ""`
   means the branch was never pushed — ahead/behind are 0 there too, so the
   counts alone would read as "in sync" for a branch the remote has never
   seen. Undefined upstream = backend too old to report it; stay quiet rather
   than guess. Counts come from the last fetch, so "SYNCED" means "synced as
   of what this checkout knows", which the tooltip says out loud. */
/* Segment texts are the mock's compact forms — the words live in the tooltip,
   the counts in the chain (a 296px zone can't carry "UNPUSHED" next to CHG and
   PUSH without invading the rail). */
function syncChip(git: GitStatus): { text: string; warn: boolean; title: string } | null {
  if (git.upstream === undefined) return null;
  const { ahead, behind, upstream } = git;
  if (!upstream)
    return { text: "LOCAL", warn: true,
             title: "This branch has no remote tracking branch — it exists only in this checkout" };
  if (ahead && behind)
    return { text: `↑${ahead} ↓${behind}`, warn: true,
             title: `Diverged from ${upstream}: ${ahead} local, ${behind} remote. Counts are from the last fetch.` };
  if (ahead)
    return { text: `↑${ahead}`, warn: true,
             title: `${ahead} unpushed commit${ahead === 1 ? "" : "s"} not yet on ${upstream}` };
  if (behind)
    return { text: `↓${behind}`, warn: true,
             title: `${behind} commit${behind === 1 ? "" : "s"} on ${upstream} not pulled in. Counts are from the last fetch.` };
  return { text: "SYNCED", warn: false,
           title: `Even with ${upstream} as of the last fetch` };
}

export interface StatusBarProps {
  usedPct: number | null;      // null → usage unknown, shown as "—"
  resetLabel?: string | null;
  agent?: AgentOption | null;  // who runs the next turn — the meter is theirs
  repo: string;
  changes: number;
  git?: GitStatus | null;      // open session's working tree; null while loading
  // The worktree the footer is reporting on, so PUBLISH pushes that tree and
  // not the project checkout. Same value the git status was fetched with.
  branch?: string | null;
  // Push or pull landed — the footer's git poll is 10s, too slow to watch a
  // chip you just changed, so the owner of that poll re-reads it now.
  onSynced?: () => void;
  onPalette: () => void;
  // Right panel expanded — the shell tracks (and zone layout) follow it.
  rightOpen: boolean;
}

/** Zone label — USED / RESET. */
const zlabel = (t: string): ReactNode => (
  <span style={{ fontSize: "var(--t95)", letterSpacing: "1.9px", color: "var(--txl)", flex: "none" }}>{t}</span>
);

/** The footer, as cells in the shell grid's bottom track rather than a row of
 *  its own: usage under SESSIONS, the branch chain and ⌘K under the right
 *  panel, and nothing under the chat, which runs to the bottom edge. Who runs
 *  the turn (and every login's windows) is the composer's AGENT picker; the
 *  context fill is its CTX lamps. */
export function StatusBar(props: StatusBarProps) {
  const { usedPct, resetLabel, agent, repo, changes, git, branch, onSynced, onPalette, rightOpen } = props;
  const [hovered, setHovered] = useState(false);

  // A switch settles the session-scoped chips in the way the right panel's
  // .swapin regions do. Keyed on their VALUE, not the session — a chip whose
  // text survives the switch (same repo, same count) has nothing new to show
  // and must not replay. Branch and sync animate on their own mount when the
  // git fetch lands. mfadeup carries no opacity, so nothing blinks out.
  const swap = { animation: "mfadeup .32s cubic-bezier(.2,.8,.2,1) both" };
  // Branch and sync arrive with that fetch, well after the switch — dim
  // stand-ins hold their slots so the chain doesn't collapse and then shove
  // everything around when they land.
  const gitPending = git == null && repo !== "—";

  // The meter has to belong to whoever is actually running the turns. usedPct
  // is the *ambient* login's 5-hour window (from /local/usage), so it only
  // stands for the default account; another login reports its own headroom, and
  // a free agent has no Claude quota to report at all.
  const sync = git?.is_repo ? syncChip(git) : null;
  // Every link of the branch chain is the same box; .chain draws the hairline
  // between them, since inline styles can't say :first-child.
  const seg = { padding: "2px 8px", display: "inline-block" } as const;

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

  // The branch chain — one bordered group, under the CHANGES panel it
  // describes (or at the end of the chat's strip when that track is collapsed).
  const chain = (
    <span className="chain" style={{
      // overflow hidden: at the narrowest widths the chain clips inside its own
      // border instead of painting over the rail's ⌘K.
      display: "inline-flex", alignItems: "center", minWidth: 0, maxWidth: "100%", overflow: "hidden",
      fontFamily: "var(--mono)", fontSize: "var(--t95)", letterSpacing: "normal",
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
              style={{ ...seg, ...swap, color: "var(--tx)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 104 }}>
          ⎇ {git.branch}
        </span>
      )}
      {sync && (
        <span title={sync.title}
              style={{ ...seg, ...swap, color: sync.warn ? "var(--warn)" : "var(--txd)", flex: "none" }}>
          {sync.text}
        </span>
      )}
      {/* A clean tree is the quiet norm, not a warning — it only speaks up
          (amber, a count) once there is something uncommitted. */}
      <span key={`chg:${changes}`}
            title={changes
              ? `${changes} uncommitted file${changes === 1 ? "" : "s"} in the working tree`
              : "Working tree clean"}
            style={{ ...seg, ...swap, color: changes ? "var(--warn)" : "var(--txd)", flex: "none" }}>
        {changes ? `${changes} CHG` : "CLEAN"}
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
            flex: "none",
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
  );

  // Each cell carries its column's hairline down to the bottom edge, the way
  // the caps carry it up to the top.
  const foot: CSSProperties = {
    gridRow: 2, display: "flex", alignItems: "center", minWidth: 0,
    borderTop: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)",
    fontSize: "var(--t10)", letterSpacing: "1.5px", color: "var(--txl)",
  };
  const enter = "enterUp .55s cubic-bezier(.2,.8,.2,1) both .36s";

  return (
    <>
      {/* L — the usage ledger, under SESSIONS. The track takes whatever the
          column leaves, which is less than the old centre zone had. */}
      <div style={{ ...foot, gridColumn: 1, gap: 11, padding: "0 12px", borderRight: "1px solid var(--border)", animation: enter }}>
        {free ? (
          <span style={{ color: "var(--warn)", flex: "none" }} title="Not your Claude subscription — no usage window to spend">
            NO CLAUDE QUOTA
          </span>
        ) : (
          <>
            {zlabel("USED")}
            <span style={{ fontFamily: "var(--mono)", fontSize: "var(--t105)", letterSpacing: "normal", color: "var(--txh)", flex: "none" }}>
              {pct === null ? "—" : `${pct}%`}
            </span>
            <span
              style={{
                flex: 1,
                minWidth: 24,
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
              <span style={{ display: "flex", alignItems: "baseline", gap: 5, flex: "none" }}>
                {zlabel("RESET")}
                <span style={{ fontFamily: "var(--mono)", fontSize: "var(--t105)", letterSpacing: "normal", color: "var(--txm)" }}>{resetLabel}</span>
              </span>
            )}
          </>
        )}
      </div>

      {/* C — only while the right panel is folded to the rail: the chain keeps
          the strip it has always had there. Open, the chat runs to the bottom
          edge instead. */}
      {!rightOpen && (
        <div style={{ ...foot, gridColumn: 2, justifyContent: "flex-end", padding: "0 14px" }}>
          {chain}
        </div>
      )}

      {/* R — the chain under the CHANGES panel it describes, + ⌘K on the rail. */}
      <div style={{ ...foot, gridColumn: 3, alignItems: "stretch", animation: enter }}>
        {rightOpen && (
          <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", padding: "0 12px", borderLeft: "1px solid var(--border)" }}>
            {chain}
          </div>
        )}
        {/* The rail's own width, hairline and ground, so the rail reads as
            running to the bottom. */}
        <div style={{ width: 48, flex: "none", marginLeft: "auto", display: "flex", alignItems: "center", justifyContent: "center", borderLeft: "1px solid var(--border)", background: "var(--panel3)" }}>
          <button
            onClick={onPalette}
            title="⌘K — command palette"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            style={{
              appearance: "none",
              cursor: "pointer",
              width: 26,
              height: 22,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              border: "1px solid color-mix(in srgb, var(--acc) 22%, transparent)",
              background: hovered ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent",
              color: hovered ? "var(--txb)" : "var(--txm)",
              fontFamily: "var(--mono)",
              fontSize: "var(--t10)",
              letterSpacing: "normal",
              padding: 0,
            }}
          >
            ⌘K
          </button>
        </div>
      </div>
    </>
  );
}
