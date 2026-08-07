"""Stdio MCP server giving the model eyes on a running page.

Spawned per interactive run via --mcp-config, alongside the goal server. One
tool: a screenshot comes back as an image content block, so "the layout is
fixed" can be looked at instead of asserted.

Only screenshotting lives here. A DevLog tool would have been redundant --
`.mystical/dev.log` is a file on disk and the system prompt already points at
it, so Bash reads it for free -- and a preview-URL tool cannot work at all from
here: devserver's registry is module state in the *bridge* process, and this
runs as its own subprocess, where it would always look empty. The URL is in
dev.log too.

Stdlib only, line-delimited JSON-RPC 2.0 on stdin/stdout. Nothing is logged to
stdout -- that channel is the protocol.
"""

import base64
import json
import sys

from bridge import screenshot

PROTOCOL = "2024-11-05"

# Chrome renders at exactly the window size asked for, so this bounds the image
# and therefore its token cost (~1.4k at the default). Bigger reads no better on
# a phone-sized report.
MAX_W, MAX_H = 1600, 1600

_TOOLS = [
    {
        "name": "Screenshot",
        "description": (
            "Load a URL in headless Chrome and look at it. Use this to check a "
            "UI change actually rendered before reporting it as done. The dev "
            "server's URL is printed in .mystical/dev.log."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "Absolute URL, e.g. http://localhost:5173/",
                },
                "width": {"type": "integer", "description": "Default 1200."},
                "height": {"type": "integer", "description": "Default 900."},
            },
            "required": ["url"],
        },
    },
]


def _clamp(val, default: int, hi: int) -> int:
    try:
        return max(200, min(hi, int(val)))
    except (TypeError, ValueError):
        return default


def _call(name: str, args: dict) -> list[dict]:
    """MCP content blocks for one tool call. Errors come back as text: a failed
    screenshot is something the model should read and route around, not a
    protocol fault."""
    if name != "Screenshot":
        return [{"type": "text", "text": f"Unknown tool: {name}"}]
    url = (args.get("url") or "").strip()
    if not url.startswith(("http://", "https://")):
        return [{"type": "text", "text": "url must be an absolute http(s) URL."}]
    try:
        png = screenshot.capture(url, _clamp(args.get("width"), 1200, MAX_W),
                                 _clamp(args.get("height"), 900, MAX_H))
    except Exception as e:  # noqa: BLE001 -- chrome missing, timeout, bad url
        return [{"type": "text", "text": f"Screenshot failed: {e}"}]
    return [
        {"type": "text", "text": f"Screenshot of {url}:"},
        {"type": "image", "data": base64.b64encode(png).decode(),
         "mimeType": "image/png"},
    ]


def _handle(req: dict) -> dict | None:
    """One JSON-RPC request in, one response out. None for notifications."""
    method, rid = req.get("method"), req.get("id")
    if method == "initialize":
        result = {"protocolVersion": PROTOCOL,
                  "capabilities": {"tools": {}},
                  "serverInfo": {"name": "mystical-verify", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": _TOOLS}
    elif method == "tools/call":
        params = req.get("params") or {}
        result = {"content": _call(params.get("name") or "",
                                   params.get("arguments") or {})}
    elif rid is None:
        return None                     # notification (e.g. initialized)
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
        except Exception as e:  # noqa: BLE001 -- a bad frame must not kill the server
            print(f"[verify_mcp] {e}", file=sys.stderr)
            continue
        if resp is not None:
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
