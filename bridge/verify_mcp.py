"""Stdio MCP server giving the model eyes on a running page.

Spawned per interactive run via --mcp-config, alongside the goal server. A
screenshot comes back as an image content block, so "the layout is fixed" can be
looked at instead of asserted, and a recording -- which comes back only as its
final frame. A clip is tens of megabytes and the model cannot watch video
anyway, so Record returns a path, the runner moves it into the turn's
attachments where the human sees it, and the still is what keeps the model from
reporting success on a recording nobody has looked at.

Attach exists because Record only reaches what headless Chrome can load. A clip
of an Android emulator, an ffmpeg export, a downloaded PDF-turned-png -- the
model made the file, then wrote a line of prose about where it was, and the
human got nothing. Same contract as Record (first line is the path, the runner
matches on the tool name), except the file belongs to whoever made it, so the
runner copies rather than moves.

Run starts the project. A dev server the model spawns with background Bash is
owned by the run and invisible to the human, so "run the project" has to land in
the bridge's dev-server registry -- which is module state in the *bridge*
process, unreachable from this subprocess except over the wire. So Run POSTs to
the dashboard's own /local/server with the token the bridge handed us in the
environment: no second implementation of starting, detecting the port, or
tailing, and every surface sees the same server.

A DevLog tool would still be redundant -- `.mystical/dev.log` is a file on disk
and the system prompt already points at it, so Bash reads it for free.

Stdlib only, line-delimited JSON-RPC 2.0 on stdin/stdout. Nothing is logged to
stdout -- that channel is the protocol.
"""

import base64
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.request

from bridge import record, screenshot

PROTOCOL = "2024-11-05"

# Chrome renders at exactly the window size asked for, so this bounds the image
# and therefore its token cost (~1.4k at the default). Bigger reads no better on
# a phone-sized report.
MAX_W, MAX_H = 1600, 1600

# Both media tools take these, and neither one reads them: the runner picks them
# off the tool_use block and stamps them onto the event that carries the file, so
# the surfaces can say what the clip is evidence for. Declared here because this
# schema is the only thing that tells the model they exist.
NOTES = {
    "type": "string",
    "description": (
        "One or two sentences: what this clip shows, and what you fixed. The "
        "human sees it beside the player. Without it a recording is just motion "
        "-- they can see that something changed, never what."),
}
RESOLVES = {
    "type": "array",
    "items": {"type": "integer"},
    "description": (
        "Indices into your current TodoWrite list (0-based) that this clip is "
        "evidence for. The surfaces show your plan next to the clip with these "
        "lit. Omit if the clip does not close anything out."),
}

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
    {
        "name": "Record",
        "description": (
            "Screen-record a URL in headless Chrome. Use it when one frame "
            "cannot show the thing: a transition, a hover, a loading sequence, "
            "a click-through. The clip goes to the human in the chat; you get "
            "back only its final frame, which is all of it you can ever see -- "
            "so a recording on its own is not verification, and the frame is "
            "what you check before calling the change done. Prefer Screenshot "
            "when a still would do."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "Absolute URL, e.g. http://localhost:5173/",
                },
                "seconds": {
                    "type": "integer",
                    "description": "How long to watch after load. Default 8, max 60.",
                },
                "width": {"type": "integer", "description": "Default 1200."},
                "height": {"type": "integer", "description": "Default 900."},
                "steps": {
                    "type": "string",
                    "description": (
                        "Optional JS run in the page while recording, awaited: "
                        "an async IIFE that clicks and awaits between steps is "
                        "how you record an interaction rather than an idle page. "
                        "Call mark(\"what just happened\") between steps to name "
                        "the moments -- the recorder timestamps each one against "
                        "the video clock and they become the clip's chapter list. "
                        "You cannot watch the clip, so these are the only "
                        "timestamps that will be true."),
                },
                "notes": NOTES,
                "resolves": RESOLVES,
            },
            "required": ["url"],
        },
    },
    {
        "name": "Attach",
        "description": (
            "Put a file you already made in front of the human, in the chat. "
            "Use it for anything Record cannot reach: an adb screenrecord of an "
            "emulator, an ffmpeg export, a rendered chart, a downloaded asset. "
            "Writing \"the clip is at /tmp/x.mp4\" attaches nothing and the "
            "human sees nothing -- this is what actually delivers it. Images "
            "and video only; Read the file yourself if you also need to look "
            "at it."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": (
                        "Path to an image or video on this machine. A Windows "
                        "path has to come in as its /mnt/... form."),
                },
                "notes": NOTES,
                "resolves": RESOLVES,
            },
            "required": ["path"],
        },
    },
    {
        "name": "Run",
        "description": (
            "Start (or stop) this project's dev server, owned by the bridge. Use "
            "it instead of a background Bash command whenever the human asked you "
            "to run the project: what Run starts outlives your turn and shows up "
            "in the dashboard with its port and live logs, where they can watch "
            "it. Returns the URL it bound. Output is also tailed to "
            ".mystical/dev.log. One server per project -- stop before restarting."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": (
                        "Shell command to start it, e.g. `npm run dev`. Omit to "
                        "use the project's saved/detected run command."),
                },
                "action": {
                    "type": "string",
                    "enum": ["start", "stop"],
                    "description": "Default start.",
                },
            },
        },
    },
]

# devserver.start blocks up to DETECT_TIMEOUT (8s) waiting for the framework to
# print its URL, so this outwaits it rather than reporting a false failure.
RUN_TIMEOUT = 25


def _clamp(val, default: int, hi: int) -> int:
    try:
        return max(200, min(hi, int(val)))
    except (TypeError, ValueError):
        return default


def _call(name: str, args: dict) -> list[dict]:
    """MCP content blocks for one tool call. Errors come back as text: a failed
    screenshot is something the model should read and route around, not a
    protocol fault."""
    if name == "Run":
        return [{"type": "text", "text": _run(args)}]
    if name == "Attach":
        return [{"type": "text", "text": _attach(args)}]
    if name not in ("Screenshot", "Record"):
        return [{"type": "text", "text": f"Unknown tool: {name}"}]
    url = (args.get("url") or "").strip()
    if not url.startswith(("http://", "https://")):
        return [{"type": "text", "text": "url must be an absolute http(s) URL."}]
    if name == "Record":
        try:
            path, still, chapters = record.capture(
                url, args.get("seconds") or 8,
                _clamp(args.get("width"), 1200, MAX_W),
                _clamp(args.get("height"), 900, MAX_H),
                args.get("steps") or "")
        except Exception as e:  # noqa: BLE001 -- node missing, chrome missing, timeout
            return [{"type": "text", "text": f"Recording failed: {e}"}]
        # Line 1 is the path and line 2 (when there is one) is the chapters, and
        # the runner reads exactly those: it matches on this tool's name, so this
        # is our own output shape rather than text sniffed out of a tool result.
        chapter_line = f"CHAPTERS {json.dumps(chapters)}\n" if chapters else ""
        blocks = [{"type": "text", "text": (
            f"{path}\n{chapter_line}"
            f"Recorded {url}. The clip itself goes to the human in the "
            f"chat. You cannot watch it -- what follows is its final frame, so "
            f"check that before calling the recording proof of anything.")}]
        if still:
            try:
                with open(still, "rb") as f:
                    blocks.append({"type": "image",
                                   "data": base64.b64encode(f.read()).decode(),
                                   "mimeType": "image/jpeg"})
            except OSError:
                pass                    # the clip is the deliverable; the still is a bonus
        return blocks
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


def _attach(args: dict) -> str:
    """First line is the path, exactly as Record does it -- that is the shape the
    runner reads. Everything after it is for the model, and says plainly that the
    file has landed, so it stops describing files instead of sending them."""
    path = os.path.abspath(os.path.expanduser((args.get("path") or "").strip()))
    if not os.path.isfile(path):
        return f"Nothing to attach: {path} is not a file."
    kind = mimetypes.guess_type(path)[0] or ""
    if not kind.startswith(("image/", "video/")):
        return (f"Not an image or video: {path} ({kind or 'unknown type'}). The "
                f"chat only shows those.")
    return (f"{path}\nAttached to the chat -- the human can see it now. You "
            f"cannot; Read the file if you need to check it yourself.")


def _run(args: dict) -> str:
    """Ask the bridge to start/stop the dev server for this run's cwd."""
    base = os.environ.get("MYSTICAL_DASH")
    if not base:
        return ("The dashboard is not running, so the bridge cannot own a dev "
                "server. Start it with Bash and say so -- the human will not be "
                "able to follow it from the dashboard.")
    body = json.dumps({"action": "stop" if args.get("action") == "stop" else "start",
                       "cwd": os.getcwd(),
                       "cmd": (args.get("command") or "").strip()}).encode()
    req = urllib.request.Request(
        base.rstrip("/") + "/local/server", data=body, method="POST",
        headers={"Content-Type": "application/json",
                 "X-Dash-Token": os.environ.get("MYSTICAL_DASH_TOKEN", "")})
    try:
        with urllib.request.urlopen(req, timeout=RUN_TIMEOUT) as r:
            data = json.load(r)
    except (urllib.error.URLError, OSError, ValueError) as e:  # noqa: BLE001
        return f"Could not reach the bridge to start it: {e}"
    msg = data.get("message") or ""
    srv = data.get("server") or {}
    if srv.get("url"):
        msg += f"\nThe human can follow it in the dashboard: {srv['url']}"
    return msg or "Done."


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
