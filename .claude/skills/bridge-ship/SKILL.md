---
name: bridge-ship
description: Use when a change to this repo needs to actually run — after editing anything under bridge/, or when the user says "restart the bridge", "is it live", "ship it", "rebuild the dashboard", or reports that a fix you already made isn't working. Covers the build/restart/verify loop and the ways restarting from inside a bridge session kills your own turn.
user-invocable: true
---

# Shipping a change to the running bridge

**Committed is not live.** The bridge process holds the code it was launched
with. Python edits need a restart; web edits need a rebuild *and* a restart to
be served. A user testing "your fix" against the old process is the single most
expensive failure mode in this repo — it looks like the fix didn't work.

## Before you touch anything: who is supervising?

```sh
mystical status
```

`supervised systemd` in the output means the user unit
(`mystical-assistant.service`) owns the process. That changes how you restart.

## The trap: you are inside the thing you are restarting

A Claude session hosted by the bridge is a child of the bridge process **and
shares its cgroup**:

```sh
cat /proc/self/cgroup     # .../app.slice/mystical-assistant.service
```

The unit is `KillMode=control-group`, so `systemctl --user stop` kills every
process in that cgroup. That includes your session — and it includes any
`setsid` child you spawn to do the restart, because `setsid` escapes the process
group, not the cgroup. Restart naively and you get: bridge stopped, restarter
dead, nothing comes back up.

**Escape the cgroup with a transient unit:**

```sh
systemd-run --user --quiet --collect --unit=bridge-restart-$$ \
  bash -c 'sleep 2; systemctl --user restart mystical-assistant.service'
```

If `mystical status` showed no systemd line (hand-launched bridge), `setsid` is
enough:

```sh
setsid bash -c 'sleep 2; mystical restart' >/dev/null 2>&1 &
```

Either way **your turn dies** when the bridge goes down. That is expected and
recoverable: `bridge/recovery.py` claims orphaned turns at boot and resumes the
resumable ones with `--resume` and a "you were interrupted, continue" nudge.
Commit first — an uncommitted edit plus a restart is how work gets lost.

**Tell the user before you do it.** Losing the turn mid-conversation is
surprising unless they asked for the restart.

## Web bundles

`dist/` is git-ignored and nothing is committed, so a surface with no bundle
serves **nothing** — not a stale page, a 404.

```sh
mystical build          # forces all three: dashboard, Mini App, site
```

`mystical start` builds only what looks stale (source newer than
`dist/index.html`), and reinstalls deps when `package-lock.json` is newer than
`node_modules/.package-lock.json`. Build output goes to
`~/.bridge_state/mystical.log`, not your terminal — read it there when a build
fails.

Building in a **worktree** does not work out of the box: worktrees have no
`node_modules`. Symlink the launch checkout's, build, then remove the symlink
(it is not gitignored at that path).

## Verify it is actually live

Don't claim it works because the file changed. Pick the cheapest real check:

```sh
mystical status                                   # process up, all three ports 2xx
curl -s 127.0.0.1:8790/local/state | head -c 300  # a route answering with new data
tail -30 ~/.bridge_state/mystical.log             # start-up errors
```

For frontend changes, look at the pixels — see the **bridge-eyes** skill.

## Order of operations

1. `python3 -m pytest tests/ -q` — green before you restart anything.
2. Commit.
3. `mystical build` if any `web/` or `site/` source changed.
4. Restart via the transient unit above; warn the user first.
5. After the session resumes: `mystical status` + one real check that the new
   behaviour is present.
