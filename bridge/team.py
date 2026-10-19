"""TEAM: which Rivendell teammates have Mystical on, and sending them a session, a
picture or a file (docs/superpowers/specs/team-share.md).

Rivendell carries all of it, over the link the bridge already holds
(ainurhq/rivendell, backend/src/team-shares):
  - GET /plugin/teammates is the roster. "On" means that person's Mystical holds the
    agent socket right now (AgentGateway.isOnline). Rivendell's web app tracks no
    presence, so someone working only in the browser reads as away.
  - A share is a row plus its files in Rivendell's storage: POST /plugin/shares,
    PUT each file, POST /send. Rivendell then pushes a `team-share` frame to the
    recipient's bridges, and GET /plugin/shares?box=in is the catch-up for a
    bridge that was off. Stamps (delivered, opened, continued, dismissed) go back
    as `team-share-update` frames to the sender.

What arrives is a teammate's, so nothing of it runs here without a tap:
  - A session becomes a read-only session (origin "team:<instance>", ref
    "share:<id>"). Its transcript is rebuilt from a whitelist of event types and
    fields (_sanitize); anything else in the payload is dropped. It keeps no Claude
    session id, opens no path a line names, and its pictures land under names made
    here. runner.start_streaming_job refuses a turn in it, store.claim_orphaned_turns
    leaves it alone, and store.latest_session never picks it, the same as a
    teammate's device run (bridge/device_view.py).
  - CONTINUE HERE starts your own session: the transcript as Markdown and the
    pictures go into the composer as attachments, the code (when it came) into a
    new worktree branch, and the opening prompt is an unsent draft.
  - A file is kept in the bridge's state folder, never in a project, and the
    dashboard hands it out only as a download.

Token-shaped text is blanked out before anything leaves (redact, broader than
device_side.redact: Rivendell and GitHub tokens, AWS keys, private-key blocks,
NAME_TOKEN=… lines), and again on arrival. .env files never go: not with the code
(device_ask.snapshot(env=False)) and not as a file.

Not built: watching a teammate's running session live, sending to a group, the
Mini App, Rivendell's own web bell, presence pushed by frames (the TEAM tab polls
while it is open).
"""

from bridge import device_view

ORIGIN = "team"
REFUSAL = "This is a teammate's session, read only here. CONTINUE HERE starts your own."


def is_team(origin) -> bool:
    """Is this the origin of a session a teammate sent?"""
    return isinstance(origin, str) and origin.startswith(ORIGIN + ":")


def refusal(origin) -> "str | None":
    """Why nothing may run in, title, copy or link a session of this origin, or None
    when it is yours: a teammate's device run or a session a teammate sent."""
    if device_view.is_device_run(origin):
        return device_view.REFUSAL
    return REFUSAL if is_team(origin) else None
