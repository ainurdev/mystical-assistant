"""
claude_telegram_bridge.py
-------------------------
A remote dev workflow over Telegram, backed by Claude Code on your machine. From
your phone you can:

  - /projects   browse the folders under BASE_PATH with tap buttons and pick one
  - /server     start that project's dev server (bot owns the process)
  - /logs       see the dev server's recent output
  - /preview    open a public link to the running server (cloudflared tunnel)
  - <message>   send a prompt to Claude Code in the selected project

Claude keeps a continuous conversation per chat (via session resume), and it is
nudged to STOP AND ASK one concise question when a task is ambiguous instead of
guessing. So a turn either comes back as a question (you reply, it continues) or
as a finished result.

Requirements
------------
- Python 3.9+, `pip install requests`
- `claude` CLI installed and logged in on this machine (auth is reused).
- `cloudflared` for /preview (optional).
- POSIX (macOS / Linux) for /server process-group control.

Setup
-----
1. Create a bot with @BotFather, copy the token.
2. Set TELEGRAM_BOT_TOKEN and BASE_PATH (the folder that holds your orgs/repos).
3. First run with no ALLOWED_CHAT_IDS: message the bot to learn your chat_id
   (printed to console), then set ALLOWED_CHAT_IDS and restart.

   >>> Read the SECURITY section at the bottom before exposing this. <<<
"""

import json
import os
import re
import shlex
import signal
import subprocess
import sys
import threading
import time
from collections import deque
from urllib.parse import urlencode

import requests

# ----------------------------------------------------------------------------
# Configuration (override via environment variables)
# ----------------------------------------------------------------------------

TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")

# Root folder the project browser starts in. Typically the parent of your
# orgs/repos, e.g. ~/code  (with ~/code/<org>/<repo> underneath).
BASE_PATH = os.path.realpath(os.path.expanduser(
    os.environ.get("BASE_PATH", os.getcwd())))

# Optional project selected by default until one is chosen via /projects.
DEFAULT_PROJECT = os.environ.get("DEFAULT_PROJECT", "") or None

ALLOWED_CHAT_IDS = {
    int(x) for x in os.environ.get("ALLOWED_CHAT_IDS", "").replace(" ", "").split(",") if x
}

# Permission posture for `claude -p`. See SECURITY notes.
#   --permission-mode acceptEdits     (default) edits files, limited
#   --dangerously-skip-permissions    full autonomy incl. running commands
EXTRA_CLAUDE_ARGS = os.environ.get("EXTRA_CLAUDE_ARGS", "--permission-mode acceptEdits")

# Appended to Claude's system prompt so it asks instead of guessing. Set empty
# to disable.
ASK_SYSTEM_PROMPT = os.environ.get("ASK_SYSTEM_PROMPT", (
    "You are operating through a Telegram bridge with a human who can reply. "
    "If a task is ambiguous, or you need a decision, a credential, or "
    "confirmation before doing something irreversible, STOP and ask exactly one "
    "concise question rather than guessing. Otherwise finish the task and report "
    "the result briefly."))

RUN_TIMEOUT = int(os.environ.get("RUN_TIMEOUT", "1800"))      # per Claude run (s)
PREVIEW_PORT = int(os.environ.get("PREVIEW_PORT", "3000"))    # default dev port
START_CMD = os.environ.get("START_CMD", "npm run dev")        # default /server cmd
CLOUDFLARED_BIN = os.environ.get("CLOUDFLARED_BIN", "cloudflared")

POLL_TIMEOUT = 30
API = f"https://api.telegram.org/bot{TOKEN}"
TG_MAX = 4000
MAX_BTNS = 40                     # folder buttons per browser screen
SKIP_DIRS = {"node_modules", "__pycache__", ".git", ".venv", "venv",
             "dist", "build", ".next", "target", ".cache"}

# ----------------------------------------------------------------------------
# Per-chat / shared state
# ----------------------------------------------------------------------------

_sessions: dict[int, str] = {}    # chat_id -> Claude session_id
_active: dict[int, str] = {}      # chat_id -> selected project path
_browse: dict[int, str] = {}      # chat_id -> current browser directory

_busy = threading.Lock()
_busy_chat: int | None = None

_tunnel_proc: subprocess.Popen | None = None
_tunnel_url: str | None = None
_tunnel_port: int | None = None
_tunnel_lock = threading.Lock()

_server_proc: subprocess.Popen | None = None
_server_log: deque = deque(maxlen=300)
_server_cmd: str | None = None
_server_dir: str | None = None
_server_lock = threading.Lock()

# ----------------------------------------------------------------------------
# Telegram helpers
# ----------------------------------------------------------------------------

def tg(method: str, **params):
    try:
        r = requests.post(f"{API}/{method}", data=params, timeout=POLL_TIMEOUT + 15)
        data = r.json()
        if not data.get("ok"):
            print(f"[telegram] {method} error: {data}", file=sys.stderr)
            return None
        return data.get("result")
    except Exception as e:  # noqa: BLE001
        print(f"[telegram] {method} exception: {e}", file=sys.stderr)
        return None


def send(chat_id: int, text: str, reply_markup: dict | None = None):
    text = text or "(empty)"
    extra = {"reply_markup": json.dumps(reply_markup)} if reply_markup else {}
    for i in range(0, len(text), TG_MAX):
        tg("sendMessage", chat_id=chat_id, text=text[i:i + TG_MAX],
           disable_web_page_preview="true", **(extra if i == 0 else {}))


def edit(chat_id: int, message_id: int, text: str, reply_markup: dict | None = None):
    tg("editMessageText", chat_id=chat_id, message_id=message_id, text=text,
       reply_markup=json.dumps(reply_markup) if reply_markup else None,
       disable_web_page_preview="true")


def answer_cb(cb_id: str, text: str = ""):
    tg("answerCallbackQuery", callback_query_id=cb_id, text=text)


def typing(chat_id: int):
    tg("sendChatAction", chat_id=chat_id, action="typing")


def get_updates(offset: int):
    try:
        url = f"{API}/getUpdates?" + urlencode({
            "offset": offset, "timeout": POLL_TIMEOUT,
            "allowed_updates": '["message","callback_query"]',
        })
        r = requests.get(url, timeout=POLL_TIMEOUT + 15)
        data = r.json()
        return data.get("result", []) if data.get("ok") else []
    except requests.exceptions.ReadTimeout:
        return []
    except Exception as e:  # noqa: BLE001
        print(f"[telegram] getUpdates exception: {e}", file=sys.stderr)
        time.sleep(3)
        return []

# ----------------------------------------------------------------------------
# Project browser
# ----------------------------------------------------------------------------

def list_dirs(path: str) -> list[str]:
    try:
        return sorted(
            e.name for e in os.scandir(path)
            if e.is_dir() and not e.name.startswith(".") and e.name not in SKIP_DIRS
        )
    except OSError:
        return []


def within_base(path: str) -> bool:
    real = os.path.realpath(path)
    return real == BASE_PATH or real.startswith(BASE_PATH + os.sep)


def rel(path: str) -> str:
    r = os.path.relpath(path, BASE_PATH)
    return "/" if r == "." else "/" + r


def browser_view(chat_id: int) -> tuple[str, dict]:
    cur = _browse.get(chat_id, BASE_PATH)
    dirs = list_dirs(cur)
    shown = dirs[:MAX_BTNS]
    rows = [[{"text": "📁 " + d, "callback_data": f"nav:{i}"}]
            for i, d in enumerate(shown)]
    controls = []
    if os.path.realpath(cur) != BASE_PATH:
        controls.append({"text": "⬆️ Up", "callback_data": "up"})
    controls.append({"text": "✅ Use this folder", "callback_data": "use"})
    rows.append(controls)

    note = ""
    if len(dirs) > MAX_BTNS:
        note = f"\n(showing first {MAX_BTNS} of {len(dirs)} folders)"
    if not dirs:
        note = "\n(no subfolders — tap ✅ to use this one)"
    text = f"📂 {rel(cur)}{note}\n\nTap a folder to open it, or ✅ to select it."
    return text, {"inline_keyboard": rows}


def open_browser(chat_id: int):
    _browse[chat_id] = BASE_PATH
    text, kb = browser_view(chat_id)
    send(chat_id, text, reply_markup=kb)


def handle_callback(cb: dict):
    chat_id = cb["message"]["chat"]["id"]
    msg_id = cb["message"]["message_id"]
    data = cb.get("data", "")

    if ALLOWED_CHAT_IDS and chat_id not in ALLOWED_CHAT_IDS:
        answer_cb(cb["id"])
        return

    cur = _browse.get(chat_id, BASE_PATH)

    if data.startswith("nav:"):
        idx = int(data.split(":", 1)[1])
        dirs = list_dirs(cur)
        if 0 <= idx < len(dirs):
            target = os.path.join(cur, dirs[idx])
            if within_base(target):
                _browse[chat_id] = target
        answer_cb(cb["id"])
        text, kb = browser_view(chat_id)
        edit(chat_id, msg_id, text, kb)

    elif data == "up":
        parent = os.path.dirname(cur)
        _browse[chat_id] = parent if within_base(parent) else BASE_PATH
        answer_cb(cb["id"])
        text, kb = browser_view(chat_id)
        edit(chat_id, msg_id, text, kb)

    elif data == "use":
        _active[chat_id] = cur
        _sessions.pop(chat_id, None)   # fresh Claude session for the new project
        answer_cb(cb["id"], "Selected ✅")
        edit(chat_id, msg_id, f"✅ Active project: {rel(cur)}")
        send(chat_id,
             "Now you can:\n"
             "• send a prompt to work on it\n"
             f"• /server to start it (default: {START_CMD})\n"
             "• /preview to open it in your browser")
    else:
        answer_cb(cb["id"])

# ----------------------------------------------------------------------------
# Claude Code runner
# ----------------------------------------------------------------------------

def project_dir(chat_id: int) -> str:
    return _active.get(chat_id) or DEFAULT_PROJECT or BASE_PATH


def run_claude(chat_id: int, prompt: str):
    cmd = ["claude", "-p", prompt, "--output-format", "json"]
    sid = _sessions.get(chat_id)
    if sid:
        cmd += ["--resume", sid]
    if ASK_SYSTEM_PROMPT.strip():
        cmd += ["--append-system-prompt", ASK_SYSTEM_PROMPT]
    if EXTRA_CLAUDE_ARGS.strip():
        cmd += shlex.split(EXTRA_CLAUDE_ARGS)

    try:
        proc = subprocess.run(cmd, cwd=project_dir(chat_id), capture_output=True,
                              text=True, timeout=RUN_TIMEOUT)
    except subprocess.TimeoutExpired:
        return (f"⏱️ Timed out after {RUN_TIMEOUT // 60} min.", None, None, True)
    except FileNotFoundError:
        return ("❌ `claude` not found on PATH.", None, None, True)

    if not proc.stdout.strip():
        err = proc.stderr.strip() or f"claude exited {proc.returncode}"
        return (f"❌ No output.\n{err[:1500]}", None, None, True)

    try:
        d = json.loads(proc.stdout)
    except json.JSONDecodeError:
        raw = (proc.stdout or proc.stderr).strip()
        return (raw[:3500], None, None, proc.returncode != 0)

    return (d.get("result", "") or d.get("error", ""),
            d.get("session_id"), d.get("total_cost_usd"), bool(d.get("is_error")))


def handle_task(chat_id: int, prompt: str):
    global _busy_chat
    try:
        typing(chat_id)
        send(chat_id, f"🤖 On it… ({rel(project_dir(chat_id))})")
        started = time.time()
        result, sid, cost, is_error = run_claude(chat_id, prompt)
        if sid:
            _sessions[chat_id] = sid
        footer = f"\n\n— {int(time.time() - started)}s"
        if cost is not None:
            footer += f" · ${cost:.4f}"
        send(chat_id, ("⚠️ " if is_error else "") + (result or "(no result)") + footer)
    finally:
        _busy_chat = None
        _busy.release()

# ----------------------------------------------------------------------------
# Preview tunnel (cloudflared quick tunnel)
# ----------------------------------------------------------------------------

_TRYCF_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")


def _drain(proc: subprocess.Popen):
    if proc.stdout:
        for _ in proc.stdout:
            pass


def _stop_tunnel_locked():
    global _tunnel_proc, _tunnel_url, _tunnel_port
    if _tunnel_proc and _tunnel_proc.poll() is None:
        _tunnel_proc.terminate()
        try:
            _tunnel_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _tunnel_proc.kill()
    _tunnel_proc = _tunnel_url = _tunnel_port = None


def start_tunnel(port: int):
    global _tunnel_proc, _tunnel_url, _tunnel_port
    with _tunnel_lock:
        if _tunnel_proc and _tunnel_proc.poll() is None and _tunnel_url:
            if _tunnel_port == port:
                return _tunnel_url, f"🔗 Already live:\n{_tunnel_url}"
            _stop_tunnel_locked()
        try:
            proc = subprocess.Popen(
                [CLOUDFLARED_BIN, "tunnel", "--url", f"http://localhost:{port}"],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        except FileNotFoundError:
            return (None, "❌ `cloudflared` not found. Install it first.")
        url, deadline = None, time.time() + 30
        assert proc.stdout is not None
        while time.time() < deadline:
            line = proc.stdout.readline()
            if not line:
                if proc.poll() is not None:
                    break
                continue
            m = _TRYCF_RE.search(line)
            if m:
                url = m.group(0)
                break
        if not url:
            proc.terminate()
            return (None, f"❌ Couldn't get a tunnel URL. Is something running on "
                          f"port {port}? (A config.yml in ~/.cloudflared blocks "
                          "quick tunnels.)")
        _tunnel_proc, _tunnel_url, _tunnel_port = proc, url, port
        threading.Thread(target=_drain, args=(proc,), daemon=True).start()
        return url, (f"🔗 Preview live (port {port}):\n{url}\n\n"
                     "⚠️ Public link — anyone with it can reach your server. "
                     "/preview stop when done.")


def stop_tunnel() -> str:
    with _tunnel_lock:
        if not (_tunnel_proc and _tunnel_proc.poll() is None):
            return "No preview tunnel is running."
        _stop_tunnel_locked()
        return "🛑 Preview tunnel stopped."


def handle_preview(chat_id: int, arg: str):
    if arg == "stop":
        send(chat_id, stop_tunnel())
        return
    try:
        port = int(arg) if arg else PREVIEW_PORT
    except ValueError:
        send(chat_id, "Usage: /preview [port]  or  /preview stop")
        return
    send(chat_id, f"🚇 Starting tunnel to localhost:{port}…")
    _, message = start_tunnel(port)
    send(chat_id, message)

# ----------------------------------------------------------------------------
# Dev server (long-lived background process owned by the bot)
# ----------------------------------------------------------------------------

def _server_alive() -> bool:
    return _server_proc is not None and _server_proc.poll() is None


def _server_reader(proc: subprocess.Popen):
    if proc.stdout:
        for line in proc.stdout:
            _server_log.append(line.rstrip("\n"))


def start_server(cmd: str, cwd: str) -> str:
    global _server_proc, _server_cmd, _server_dir
    with _server_lock:
        if _server_alive():
            return (f"⚙️ Server already running (pid {_server_proc.pid}) in "
                    f"{rel(_server_dir)}: {_server_cmd}\nUse /server stop first.")
        _server_log.clear()
        try:
            proc = subprocess.Popen(
                cmd, cwd=cwd, shell=True, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, text=True, bufsize=1,
                start_new_session=True)
        except Exception as e:  # noqa: BLE001
            return f"❌ Failed to start: {e}"
        _server_proc, _server_cmd, _server_dir = proc, cmd, cwd
        threading.Thread(target=_server_reader, args=(proc,), daemon=True).start()
        time.sleep(2)
        if proc.poll() is not None:
            tail = "\n".join(list(_server_log)[-15:]) or "(no output)"
            return f"❌ Server exited immediately (code {proc.returncode}):\n{tail}"
        return (f"✅ Server started (pid {proc.pid}) in {rel(cwd)}: {cmd}\n"
                f"/preview {PREVIEW_PORT} to open it · /logs to see output.")


def stop_server() -> str:
    global _server_proc
    with _server_lock:
        if not _server_alive():
            _server_proc = None
            return "No server is running."
        try:
            os.killpg(os.getpgid(_server_proc.pid), signal.SIGTERM)
            _server_proc.wait(timeout=8)
        except (ProcessLookupError, PermissionError):
            pass
        except subprocess.TimeoutExpired:
            os.killpg(os.getpgid(_server_proc.pid), signal.SIGKILL)
        _server_proc = None
        return "🛑 Server stopped."


def server_status() -> str:
    if _server_alive():
        return f"running (pid {_server_proc.pid}) in {rel(_server_dir)}: {_server_cmd}"
    if _server_proc is not None:
        return f"exited (code {_server_proc.returncode}): {_server_cmd}"
    return "not started"


def handle_server(chat_id: int, arg: str):
    parts = arg.split(maxsplit=1)
    sub = parts[0] if parts else "start"
    rest = parts[1] if len(parts) > 1 else ""
    if sub == "stop":
        send(chat_id, stop_server())
    elif sub == "status":
        send(chat_id, "Server: " + server_status())
    elif sub in ("start", ""):
        cmd = rest or START_CMD
        send(chat_id, f"🚀 Starting in {rel(project_dir(chat_id))}: {cmd}")
        send(chat_id, start_server(cmd, project_dir(chat_id)))
    else:
        send(chat_id, f"🚀 Starting in {rel(project_dir(chat_id))}: {arg}")
        send(chat_id, start_server(arg, project_dir(chat_id)))


def handle_logs(chat_id: int, arg: str):
    try:
        n = int(arg) if arg else 40
    except ValueError:
        n = 40
    lines = list(_server_log)[-n:]
    body = "\n".join(lines) if lines else "(no server output yet)"
    send(chat_id, f"📄 Last {len(lines)} log line(s):\n\n{body}")

# ----------------------------------------------------------------------------
# Message dispatch
# ----------------------------------------------------------------------------

HELP = (
    "Claude Code remote bridge.\n\n"
    f"Base path: {BASE_PATH}\n\n"
    "Pick a project, then send prompts to work on it.\n\n"
    "/projects — browse and select a project\n"
    "/project — show the active project\n"
    "/new — fresh Claude session for the active project\n"
    "/server [cmd] — start the dev server · /server stop\n"
    "/logs [n] — recent server output\n"
    f"/preview [port] — public link (default {PREVIEW_PORT}) · /preview stop\n"
    "/status — everything at a glance\n"
    "/help — this message")


def on_message(msg: dict):
    global _busy_chat
    chat_id = msg["chat"]["id"]
    text = (msg.get("text") or "").strip()

    if not ALLOWED_CHAT_IDS:
        print(f"[discovery] chat_id={chat_id} "
              f"({msg['chat'].get('username', '?')}) — add to ALLOWED_CHAT_IDS.")
        send(chat_id, f"Discovery mode. Your chat_id is {chat_id}. "
                      "Add it to ALLOWED_CHAT_IDS and restart.")
        return
    if chat_id not in ALLOWED_CHAT_IDS:
        print(f"[blocked] unauthorized chat_id={chat_id}", file=sys.stderr)
        return
    if not text:
        send(chat_id, "Send a text prompt, or /help.")
        return

    cmd0 = text.split()[0]
    if text in ("/start", "/help"):
        send(chat_id, HELP)
        return
    if cmd0 == "/projects":
        open_browser(chat_id)
        return
    if cmd0 == "/project":
        send(chat_id, f"Active project: {rel(project_dir(chat_id))}"
                      + ("" if chat_id in _active else "  (default — none selected)"))
        return
    if text == "/new":
        _sessions.pop(chat_id, None)
        send(chat_id, "🆕 Fresh Claude session.")
        return
    if cmd0 == "/server":
        threading.Thread(target=handle_server,
                         args=(chat_id, text[len("/server"):].strip()),
                         daemon=True).start()
        return
    if cmd0 == "/logs":
        handle_logs(chat_id, text[len("/logs"):].strip())
        return
    if cmd0 == "/preview":
        threading.Thread(target=handle_preview,
                         args=(chat_id, text[len("/preview"):].strip()),
                         daemon=True).start()
        return
    if text == "/status":
        state = f"busy with chat {_busy_chat}" if _busy_chat else "idle"
        tunnel = (f"{_tunnel_url} (port {_tunnel_port})"
                  if (_tunnel_proc and _tunnel_proc.poll() is None and _tunnel_url)
                  else "none")
        sid = _sessions.get(chat_id, "none yet")
        send(chat_id, f"Project: {rel(project_dir(chat_id))}\nClaude: {state}\n"
                      f"Server: {server_status()}\nPreview: {tunnel}\n"
                      f"Session: {sid}")
        return

    # Plain text -> prompt to Claude in the active project.
    if not _busy.acquire(blocking=False):
        send(chat_id, "⏳ Still working on a previous task — please wait.")
        return
    _busy_chat = chat_id
    threading.Thread(target=handle_task, args=(chat_id, text), daemon=True).start()

# ----------------------------------------------------------------------------
# Main loop
# ----------------------------------------------------------------------------

def main():
    if not TOKEN:
        sys.exit("Set TELEGRAM_BOT_TOKEN.")
    if not os.path.isdir(BASE_PATH):
        sys.exit(f"BASE_PATH does not exist: {BASE_PATH}")
    me = tg("getMe")
    if not me:
        sys.exit("Could not reach Telegram. Check the token / network.")
    print(f"Bridge online as @{me.get('username')}  base={BASE_PATH}")
    if not ALLOWED_CHAT_IDS:
        print("⚠️  No ALLOWED_CHAT_IDS — DISCOVERY mode (won't execute Claude).")

    offset = 0
    try:
        while True:
            for upd in get_updates(offset):
                offset = upd["update_id"] + 1
                try:
                    if "callback_query" in upd:
                        handle_callback(upd["callback_query"])
                    elif "message" in upd:
                        on_message(upd["message"])
                except Exception as e:  # noqa: BLE001
                    print(f"[handler] {e}", file=sys.stderr)
    except KeyboardInterrupt:
        print("\nShutting down…")
    finally:
        stop_tunnel()
        stop_server()


if __name__ == "__main__":
    main()

# ============================================================================
# SECURITY — read this
# ============================================================================
# Whoever is in ALLOWED_CHAT_IDS can run Claude Code AND start dev servers on
# this machine. Depending on EXTRA_CLAUDE_ARGS that can mean arbitrary command
# execution (remote code execution on your box). Mitigations:
#   1. Keep ALLOWED_CHAT_IDS locked to your own chat id(s). Never leave empty
#      in production — discovery mode is for setup only.
#   2. Treat TELEGRAM_BOT_TOKEN as a secret.
#   3. Pick your permission posture deliberately (acceptEdits vs skip-perms).
#   4. BASE_PATH bounds the browser, but Claude/servers can still act outside it
#      via shell. Prefer running this whole bot as a low-privilege user, or
#      inside a container/VM.
#   5. RUN_TIMEOUT caps runaway Claude runs; keep it sane.
# ============================================================================
