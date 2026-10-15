import { useEffect, useRef, useState, type ReactNode } from "react";
import { GitBranch } from "lucide-react";
import { api, type GitStatus } from "../../api";

/* The open session's git standing, behind one icon in the header's actions —
 * beside the bell. It used to be a chain of chips in a footer row under the
 * right panel; that row is gone and the chain became this popover's rows.
 * The icon carries the one thing worth seeing without opening it: an amber
 * dot when the tree has uncommitted work or the branch is off its remote.
 *
 * Where the branch stands against its remote: `upstream: ""` means the branch
 * was never pushed — ahead/behind are 0 there too, so the counts alone would
 * read as "in sync" for a branch the remote has never seen. Undefined upstream
 * = backend too old to report it; stay quiet rather than guess. Counts come
 * from the last fetch, so "SYNCED" means "synced as of what this checkout
 * knows", which the detail line says out loud. */
function syncState(git: GitStatus): { text: string; warn: boolean; detail: string } | null {
  if (git.upstream === undefined) return null;
  const { ahead, behind, upstream } = git;
  if (!upstream)
    return { text: "LOCAL", warn: true,
             detail: "No remote tracking branch — it exists only in this checkout" };
  if (ahead && behind)
    return { text: `↑${ahead} ↓${behind}`, warn: true,
             detail: `Diverged from ${upstream}: ${ahead} local, ${behind} remote, as of the last fetch` };
  if (ahead)
    return { text: `↑${ahead}`, warn: true,
             detail: `${ahead} unpushed commit${ahead === 1 ? "" : "s"} not yet on ${upstream}` };
  if (behind)
    return { text: `↓${behind}`, warn: true,
             detail: `${behind} commit${behind === 1 ? "" : "s"} on ${upstream} not pulled in, as of the last fetch` };
  return { text: "SYNCED", warn: false, detail: `Even with ${upstream} as of the last fetch` };
}

export interface GitPopoverProps {
  repo: string;                // the open session's project, "—" when none
  changes: number;
  git?: GitStatus | null;      // open session's working tree; null while loading
  // The worktree being reported on, so PUBLISH pushes that tree and not the
  // project checkout. Same value the git status was fetched with.
  branch?: string | null;
  // Push or pull landed — the owner of the 10s git poll re-reads it now
  // rather than leave a row you just changed stale.
  onSynced?: () => void;
  // A push git refused: hand it to a new session on this branch, git's
  // message as its unsent draft (App's pushFailedSession).
  onPushFailed?: (output: string) => void;
}

const label = (t: string): ReactNode => (
  <span style={{ width: 62, flex: "none", fontSize: "var(--t85)", letterSpacing: "1.5px", color: "var(--txd)" }}>{t}</span>
);

export function GitPopover({ repo, changes, git, branch, onSynced, onPushFailed }: GitPopoverProps) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [busy, setBusy] = useState(false);
  const [syncErr, setSyncErr] = useState("");
  const [pushErr, setPushErr] = useState("");   // git's refusal of a push, for NEW SESSION
  const [actHov, setActHov] = useState(false);
  const [newHov, setNewHov] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const noRepo = repo === "—";
  const pending = git == null && !noRepo;
  const sync = git?.is_repo ? syncState(git) : null;

  // Moving commits either direction, offered only where a plain command can
  // succeed: push when the remote is missing commits (or the whole branch),
  // pull when this checkout is strictly behind (git.pull is --ff-only).
  // Diverged offers neither — that needs a merge/rebase decision, not a tap.
  const canPush = !!git?.is_repo && !noRepo && !git.behind &&
    git.upstream !== undefined && (git.upstream === "" || git.ahead > 0);
  const canPull = !!git?.is_repo && !noRepo && !!git.upstream &&
    git.behind > 0 && !git.ahead;
  async function doSync(kind: "push" | "pull") {
    if (noRepo || busy) return;
    setBusy(true);
    setSyncErr("");
    setPushErr("");
    try {
      const r = kind === "push"
        ? await api.gitPush(repo, branch || undefined)
        : await api.gitPull(repo, branch || undefined);
      if (!r.ok) {
        setSyncErr(r.output || `${kind} failed`);
        if (kind === "push") setPushErr(r.output || "push failed");
      }
      else onSynced?.();
    } catch (e) { setSyncErr((e as Error).message); }
    finally { setBusy(false); }
  }
  // canPush and canPull are mutually exclusive (each requires the other's
  // count to be zero), so this is one slot, not a row of buttons.
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

  // A clean, synced tree is the quiet norm; the dot only speaks up when there
  // is something to do.
  const attention = !noRepo && !!git?.is_repo && (changes > 0 || !!sync?.warn);
  const row = { display: "flex", alignItems: "baseline", gap: 8, padding: "7px 11px",
                borderTop: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)" } as const;
  const mono = { fontFamily: "var(--mono)", fontSize: "var(--t105)", letterSpacing: "normal" } as const;

  return (
    <span ref={wrapRef} style={{ position: "relative", flex: "none", display: "flex" }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title={git?.branch ? `Git — ⎇ ${git.branch}` : "Git"}
        aria-label="Git status"
        aria-expanded={open}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          appearance: "none", cursor: "pointer", position: "relative", border: 0,
          background: "transparent", color: open || hover ? "var(--txb)" : "var(--txm)",
          fontFamily: "inherit", padding: 0, width: 22, height: 22,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        <GitBranch size={15} strokeWidth={1.5} aria-hidden />
        {attention && (
          <span aria-hidden style={{ position: "absolute", top: 1, right: 1, width: 6, height: 6, borderRadius: 3, background: "var(--warn)" }} />
        )}
      </button>

      {open && (
        <div
          style={{
            position: "absolute", top: "calc(100% + 8px)", right: 0, zIndex: 60, width: 280,
            border: "1px solid color-mix(in srgb, var(--acc) 40%, transparent)",
            background: "color-mix(in srgb, var(--panel2) 99%, transparent)",
            boxShadow: "0 16px 44px var(--shadow-pop)",
            animation: "mslide .16s ease both",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "11px 11px 9px" }}>
            <span style={{ fontSize: "var(--t9)", letterSpacing: 2, color: "var(--acc)" }}>GIT</span>
            <span style={{ flex: 1 }}></span>
            {!noRepo && (
              <span style={{ fontFamily: "var(--mono)", fontSize: "var(--t9)", color: "var(--txf)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 170 }}>
                {repo.split("/").pop()}
              </span>
            )}
          </div>

          {noRepo || (git && !git.is_repo) ? (
            <div style={{ ...row, justifyContent: "center", padding: "16px 11px", fontSize: "var(--t10)", letterSpacing: 1.5, color: "var(--txl)" }}>
              {noRepo ? "NO SESSION OPEN" : "NOT A GIT REPOSITORY"}
            </div>
          ) : pending ? (
            <div style={{ ...row, justifyContent: "center", padding: "16px 11px", fontSize: "var(--t10)", letterSpacing: 1.5, color: "var(--txl)" }}>
              READING…
            </div>
          ) : (
            <>
              <div style={row}>
                {label("BRANCH")}
                <span style={{ ...mono, color: "var(--tx)", overflowWrap: "anywhere" }}>⎇ {git?.branch || "(detached)"}</span>
              </div>
              {sync && (
                <div style={row}>
                  {label("REMOTE")}
                  <span style={{ minWidth: 0 }}>
                    <span style={{ ...mono, color: sync.warn ? "var(--warn)" : "var(--txd)" }}>{sync.text}</span>
                    <span style={{ display: "block", marginTop: 3, fontSize: "var(--t9)", lineHeight: 1.45, color: "var(--txl)" }}>{sync.detail}</span>
                  </span>
                </div>
              )}
              <div style={row}>
                {label("CHANGES")}
                <span style={{ ...mono, color: changes ? "var(--warn)" : "var(--txd)" }}>
                  {changes ? `${changes} uncommitted file${changes === 1 ? "" : "s"}` : "clean"}
                </span>
              </div>
              {/* VS Code's "publish branch" / "sync": the one fix the state
                  above allows. FAILED keeps git's message below and retries. */}
              {action && (
                <div style={{ padding: "4px 11px 11px" }}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void doSync(action.kind)}
                    title={action.title}
                    onMouseEnter={() => setActHov(true)}
                    onMouseLeave={() => setActHov(false)}
                    style={{
                      width: "100%", appearance: "none", fontFamily: "inherit", fontSize: "var(--t10)", letterSpacing: 1.5, padding: 8,
                      border: `1px solid color-mix(in srgb, ${syncErr ? "var(--err)" : "var(--acc)"} 30%, transparent)`,
                      background: syncErr ? "color-mix(in srgb, var(--err) 10%, transparent)"
                        : busy ? "transparent"
                        : `color-mix(in srgb, var(--acc) ${actHov ? 18 : 9}%, transparent)`,
                      color: syncErr ? "var(--err)" : busy ? "var(--txd)" : "var(--acc)",
                      cursor: busy ? "default" : "pointer",
                    }}
                  >
                    {busy ? action.busyLabel : !syncErr ? action.label
                      : action.kind === "push" ? `${action.label} FAILED` : `${action.label} FAILED — RETRY`}
                  </button>
                  {syncErr && (
                    <div style={{ marginTop: 6, fontFamily: "var(--mono)", fontSize: "var(--t85)", lineHeight: 1.45, color: "var(--err)", overflowWrap: "anywhere", maxHeight: 120, overflowY: "auto" }}>
                      {syncErr}
                    </div>
                  )}
                  {/* A failed push isn't retried here or by an agent in the
                      session that saw it (runner._PUSH_NOTE): it goes to a new
                      session on the branch. */}
                  {pushErr && onPushFailed && (
                    <button
                      type="button"
                      onClick={() => { onPushFailed(pushErr); setPushErr(""); setSyncErr(""); setOpen(false); }}
                      title="Handle it in a new session on this branch, with git's message as an unsent draft"
                      onMouseEnter={() => setNewHov(true)}
                      onMouseLeave={() => setNewHov(false)}
                      style={{
                        width: "100%", marginTop: 8, appearance: "none", cursor: "pointer",
                        fontFamily: "inherit", fontSize: "var(--t10)", letterSpacing: 1.5, padding: 8,
                        border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)",
                        background: `color-mix(in srgb, var(--acc) ${newHov ? 18 : 9}%, transparent)`,
                        color: "var(--acc)",
                      }}
                    >
                      NEW SESSION
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </span>
  );
}
