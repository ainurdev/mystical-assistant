"""The hook an agent actually runs: post the event to the bridge, do what it says.

Stdlib only, nothing from bridge/: it runs as `python -I hook_dispatch.py <event>` in the
agent's environment, so it must not import bridge.config and read every secret the bridge
has. With no MYSTICAL_HOOK_TOKEN in the environment (a terminal `kimi`, a terminal `claude`)
it exits at once and changes nothing, which is why the managed block in Kimi's config is safe.
A bridge it can't reach, or an answer it can't read, lets the action through.

Answers, in the shape both Claude Code and Kimi Code read:
  block       exit 2, reason on stderr
  ask         Claude's permissionDecision "ask"
  context     hookSpecificOutput.additionalContext
  output      Claude's updatedToolOutput
  keep_going  Stop: decision "block", which keeps the agent working
"""

import json
import os
import sys
import urllib.error
import urllib.request


def main(event: str) -> int:
    tok, url = os.environ.get("MYSTICAL_HOOK_TOKEN"), os.environ.get("MYSTICAL_HOOK_URL")
    if not tok or not url:
        return 0
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        payload = {}
    req = urllib.request.Request(url, data=json.dumps({"event": event, "payload": payload}).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "X-Gateway-Token": tok})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            ans = json.load(r)
    except (urllib.error.URLError, OSError, ValueError):
        return 0
    if ans.get("block"):
        print(ans["block"], file=sys.stderr)
        return 2
    out = {"hookEventName": event}
    if ans.get("ask"):
        out.update(permissionDecision="ask", permissionDecisionReason=ans["ask"])
    if ans.get("context"):
        out["additionalContext"] = ans["context"]
    if ans.get("output") is not None:
        out["updatedToolOutput"] = ans["output"]
    if ans.get("keep_going"):
        print(json.dumps({"decision": "block", "reason": ans["keep_going"]}))
    elif len(out) > 1:
        print(json.dumps({"hookSpecificOutput": out}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else ""))
