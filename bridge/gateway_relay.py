"""The MCP server an agent actually starts. It knows nothing: every request goes
to the bridge (bridge/gateway.py) with this run's token, and the answer comes back.

A separate script because of who runs it. A third-party CLI spawns this with the
environment we hand it, so it must not import bridge.config, which would read
every secret the bridge has into a process that agent owns. All it ever holds is
a token that reaches POST /local/gateway for one session, for as long as one turn.

Stdlib only, nothing from bridge/: it runs as `python -I gateway_relay.py`. Line-
delimited JSON-RPC 2.0 on stdin/stdout, like goal_mcp; nothing else goes to stdout.
"""

import json
import os
import sys
import urllib.error
import urllib.request

PROTOCOL = "2024-11-05"
# Long, for Claude: its calls may wait on a person. An agent's own MCP timeout
# (Kimi Code's is 60 s) ends a call sooner, and the bridge never makes one wait.
TIMEOUT = 24 * 3600


def _ask(method: str, params: dict) -> dict:
    data = json.dumps({"method": method, "params": params}).encode()
    req = urllib.request.Request(
        os.environ.get("MYSTICAL_GATEWAY_URL", ""), data=data, method="POST",
        headers={"Content-Type": "application/json",
                 "X-Gateway-Token": os.environ.get("MYSTICAL_GATEWAY_TOKEN", "")})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.load(r)


def _handle(req: dict) -> "dict | None":
    method, rid = req.get("method"), req.get("id")
    if method == "initialize":
        result = {"protocolVersion": PROTOCOL, "capabilities": {"tools": {}},
                  "serverInfo": {"name": "mystical", "version": "1"}}
    elif method in ("tools/list", "tools/call"):
        try:
            result = _ask(method, req.get("params") or {})
        except (urllib.error.URLError, OSError, ValueError) as e:
            if method == "tools/list":
                result = {"tools": []}
            else:
                result = {"content": [{"type": "text", "text": f"Could not reach Mystical: {e}"}],
                          "isError": True}
    elif rid is None:
        return None
    else:
        return {"jsonrpc": "2.0", "id": rid,
                "error": {"code": -32601, "message": f"no method {method}"}}
    return {"jsonrpc": "2.0", "id": rid, "result": result}


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            resp = _handle(json.loads(line))
        except Exception as e:  # noqa: BLE001 - a bad frame must not kill the server
            print(f"[gateway_relay] {e!r}", file=sys.stderr)
            continue
        if resp is not None:
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
