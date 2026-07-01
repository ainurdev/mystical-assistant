# Easy Setup + Onboarding Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make first-run `git clone → ./setup.sh → message your bot` in under five minutes, with no build step and no hand-authored config.

**Architecture:** Split secrets out of a hand-written `run.sh` into a git-ignored `.env` loaded by a committed `run.sh`; ship prebuilt web assets so no build is needed; remove the maintainer's account from `config.py` defaults and make `/preview` fall back to an ephemeral tunnel; add a `setup.sh` wizard (prereq doctor → BotFather walkthrough → auto-capture chat id → link `mystical`).

**Tech Stack:** Python 3.9+ (stdlib + `requests`), bash, React 19 + Vite (prebuilt), Telegram Bot API, cloudflared (optional), SQLite. Tests: stdlib-style, run with `pytest`.

## Global Constraints

- Python floor **3.9+**; only third-party dep is `requests`. No new runtime deps.
- Secrets live **only** in the git-ignored `.env`. Committed files (`run.sh`, `.env.example`, `setup.sh`, `bridge/onboard.py`) must contain **no** tokens, ids, or hostnames.
- Package manager for the web clients is **npm** (never pnpm).
- Tests are stdlib `unittest`-style functions using `pytest` fixtures (`tmp_path`, `monkeypatch`), matching `tests/test_*.py`. Each test file ends with `if __name__ == "__main__": raise SystemExit(subprocess.call(["pytest", "-q", os.path.abspath(__file__)]))`.
- Run all tests with: `pytest -q` from the repo root.
- Match existing config idiom: `NAME = os.environ.get("NAME", default)`; booleans via `.lower() not in ("0","false","no","")`.

---

### Task 1: `.env` config split (committed `run.sh` + `.env.example` + `mystical` repoint)

Removes the "author a bash script from nothing" blocker. Migrates your existing secrets into `.env`, commits a secret-free `run.sh` that sources it, and repoints `bin/mystical` at `.env` (fixing the quoted-value grep bug).

**Files:**
- Migrate then create: `run.sh` (overwrite the git-ignored one with a committed launcher)
- Create: `.env` (git-ignored; holds migrated secrets — never committed)
- Create: `.env.example` (committed template)
- Modify: `.gitignore` (remove `run.sh`, add `.env`)
- Modify: `bin/mystical:16` (add `ENV_FILE`), `:42` (guard `.env`), `:56-62` (`dash_url` reads `.env`, quote-tolerant)
- Test: `tests/test_env_example.py`

**Interfaces:**
- Produces: a git-ignored `.env` with `KEY="value"` lines, auto-exported by `run.sh`. Consumed by `bridge/config.py` (unchanged) and later tasks (`setup.sh` writes it via `bridge/onboard.py`).

- [ ] **Step 1: Migrate your current secrets into `.env`**

Your existing git-ignored `run.sh` holds your working token/config. Preserve it before overwriting `run.sh`:

```bash
cd /home/mhzrerfani/projects/mystical-assistant
if [ -f run.sh ] && [ ! -f .env ]; then
  grep -E '^\s*export ' run.sh | sed -E 's/^\s*export //' > .env
  chmod 600 .env
fi
cat .env   # sanity check: TELEGRAM_BOT_TOKEN=..., BASE_PATH=..., ALLOWED_CHAT_IDS=..., DASH_TOKEN=...
```

- [ ] **Step 2: Overwrite `run.sh` with the committed, secret-free launcher**

```bash
#!/usr/bin/env bash
#
# Committed launcher for claude_telegram_bridge.py. Holds NO secrets — it loads
# them from the git-ignored .env (created by ./setup.sh). Safe to commit.

set -euo pipefail
cd "$(dirname "$(realpath "$0")")"

if [ ! -f .env ]; then
  echo "No .env found — run ./setup.sh first (it creates it)." >&2
  exit 1
fi

set -a
. ./.env
set +a

exec python3 claude_telegram_bridge.py
```

- [ ] **Step 3: Create `.env.example` (committed template)**

```bash
# ── mystical-assistant configuration ──────────────────────────────────────
# ./setup.sh writes your real .env for you; edit by hand only for advanced
# options. .env is git-ignored (it holds your bot token). Keep it chmod 600.

# ── required ───────────────────────────────────────────────────────────────
# Telegram bot token from @BotFather (https://t.me/BotFather → /newbot).
TELEGRAM_BOT_TOKEN=""
# Root folder the project browser starts in (the parent of your repos).
BASE_PATH="$HOME/projects"
# Your Telegram numeric chat id(s), comma-separated. setup.sh captures this;
# leave empty for first-run discovery mode.
ALLOWED_CHAT_IDS=""

# ── bot autonomy ───────────────────────────────────────────────────────────
# Plain-text bot path permission posture:
#   --permission-mode acceptEdits   (default, limited)
#   --dangerously-skip-permissions  (full autonomy — only with ALLOWED_CHAT_IDS locked)
EXTRA_CLAUDE_ARGS="--permission-mode acceptEdits"

# ── dashboard (localhost only) ─────────────────────────────────────────────
# Anti-CSRF token for the desktop dashboard. Empty disables the ?token= gate
# (localhost convenience). setup.sh generates a secret here.
DASH_TOKEN=""

# ── Mini App (optional; needs cloudflared) ─────────────────────────────────
# 0 disables the Telegram Mini App panel so cloudflared isn't required.
MINIAPP_ENABLE="1"

# ── named preview tunnel (optional) ────────────────────────────────────────
# Leave empty for ephemeral *.trycloudflare.com links on /preview. For a stable
# URL, provision a named Cloudflare Tunnel and set these four.
PREVIEW_HOSTNAME=""
TUNNEL_NAME=""
TUNNEL_ID=""
TUNNEL_CREDENTIALS_FILE=""
```

- [ ] **Step 4: Update `.gitignore`**

Remove the `run.sh` line (line 2) and add `.env`. Result near the top:

```
# Secrets — .env holds the Telegram bot token
.env
```

(Leave the `bridge/*/web/node_modules/` and `dist/` lines alone — Task 3 handles `dist/`.)

- [ ] **Step 5: Repoint `bin/mystical` at `.env` (and fix the quoted-value grep)**

Modify `bin/mystical`. After line 16 (`RUN_SH="$REPO/run.sh"`) add:

```bash
ENV_FILE="$REPO/.env"
```

Replace the guard at line 42:

```bash
[ -f "$ENV_FILE" ] || die ".env not found at $ENV_FILE — run ./setup.sh to create it."
```

Replace the body of `dash_url()` (lines 57-61) so it reads `.env` and tolerates quotes:

```bash
  local port token
  port="$(grep -oE 'DASH_PORT="?[0-9]+' "$ENV_FILE" 2>/dev/null | head -n1 | grep -oE '[0-9]+' || true)"; port="${port:-8790}"
  token="$(grep -oE 'DASH_TOKEN="?[A-Za-z0-9_-]+' "$ENV_FILE" 2>/dev/null | head -n1 | sed 's/.*=//; s/"//g' || true)"
  if [ -n "$token" ]; then printf 'http://127.0.0.1:%s/?token=%s' "$port" "$token"
  else printf 'http://127.0.0.1:%s/' "$port"; fi
```

- [ ] **Step 6: Write the failing drift test**

Create `tests/test_env_example.py`:

```python
"""`.env.example` stays in sync with config.py: every documented var is read by
config, and the required trio is present. Run: python tests/test_env_example.py"""
import os
import re
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent


def _example_keys():
    text = (ROOT / ".env.example").read_text()
    return [m.group(1) for m in re.finditer(r'^([A-Z_]+)=', text, re.M)]


def test_every_example_var_is_read_by_config():
    cfg = (ROOT / "bridge" / "config.py").read_text()
    for key in _example_keys():
        assert f'"{key}"' in cfg, f'{key} in .env.example but not read by config.py'


def test_required_vars_present():
    keys = set(_example_keys())
    assert {"TELEGRAM_BOT_TOKEN", "BASE_PATH", "ALLOWED_CHAT_IDS"} <= keys


if __name__ == "__main__":
    import subprocess
    raise SystemExit(subprocess.call(["pytest", "-q", os.path.abspath(__file__)]))
```

- [ ] **Step 7: Run the test — expect PASS**

Run: `pytest -q tests/test_env_example.py`
Expected: 2 passed. (If a key you added isn't in `config.py`, fix `.env.example`.)

- [ ] **Step 8: Verify the bridge still starts**

Run: `mystical restart && mystical status`
Expected: `running`, dashboard `HTTP 200`, and the printed `dashboard URL` includes `?token=` matching `DASH_TOKEN` in `.env`. Then `mystical stop`.

- [ ] **Step 9: Commit (never stage `.env`)**

```bash
git add run.sh .env.example .gitignore bin/mystical tests/test_env_example.py
git status   # confirm .env is NOT listed
git commit -m "feat(setup): .env config split + committed run.sh launcher"
```

---

### Task 2: Remove author-specific defaults + `/preview` quick-tunnel fallback

Fixes the correctness bug where a new user's `/preview` targets the maintainer's Cloudflare tunnel. Empties the account-specific defaults and makes `start_tunnel` fall back to an ephemeral `*.trycloudflare.com` tunnel when no named tunnel is configured.

**Files:**
- Modify: `bridge/config.py:73-79`
- Modify: `bridge/tunnel.py:140-168` (add `_named_configured()`, restructure `start_tunnel`)
- Test: `tests/test_preview_fallback.py`

**Interfaces:**
- Consumes: `tunnel.open_quick_tunnel(port) -> (proc, url) | (None, None)`, `tunnel._spawn_named(port) -> (proc, url) | (None, reason)`, `tunnel._which_cloudflared() -> bool` (all existing).
- Produces: `tunnel._named_configured() -> bool`; `start_tunnel(port) -> (url|None, message)` now choosing quick-vs-named by configuration.

- [ ] **Step 1: Write the failing test**

Create `tests/test_preview_fallback.py`:

```python
"""/preview falls back to an ephemeral quick tunnel when no named tunnel is
configured, and uses the named tunnel when one is. Run: python tests/test_preview_fallback.py"""
import os

from bridge import config, tunnel


class _FakeProc:
    def poll(self):
        return None  # "still running"


def _reset_globals(monkeypatch):
    monkeypatch.setattr(tunnel, "_tunnel_proc", None)
    monkeypatch.setattr(tunnel, "_tunnel_url", None)
    monkeypatch.setattr(tunnel, "_tunnel_port", None)


def test_quick_tunnel_when_unconfigured(monkeypatch):
    monkeypatch.setattr(config, "PREVIEW_HOSTNAME", "")
    monkeypatch.setattr(config, "TUNNEL_ID", "")
    _reset_globals(monkeypatch)

    def _no_named(port):
        raise AssertionError("named tunnel used despite empty config")

    monkeypatch.setattr(tunnel, "_spawn_named", _no_named)
    monkeypatch.setattr(tunnel, "open_quick_tunnel",
                        lambda port: (_FakeProc(), "https://demo.trycloudflare.com"))

    url, msg = tunnel.start_tunnel(4000)
    assert url == "https://demo.trycloudflare.com"
    assert "trycloudflare.com" in msg


def test_named_tunnel_when_configured(monkeypatch, tmp_path):
    cred = tmp_path / "cred.json"
    cred.write_text("{}")
    monkeypatch.setattr(config, "PREVIEW_HOSTNAME", "preview.example.com")
    monkeypatch.setattr(config, "TUNNEL_ID", "abc")
    monkeypatch.setattr(config, "TUNNEL_CREDENTIALS_FILE", str(cred))
    _reset_globals(monkeypatch)

    def _no_quick(port):
        raise AssertionError("quick tunnel used despite named config")

    monkeypatch.setattr(tunnel, "open_quick_tunnel", _no_quick)
    monkeypatch.setattr(tunnel, "_spawn_named",
                        lambda port: (_FakeProc(), "https://preview.example.com"))

    url, msg = tunnel.start_tunnel(4000)
    assert url == "https://preview.example.com"


if __name__ == "__main__":
    import subprocess
    raise SystemExit(subprocess.call(["pytest", "-q", os.path.abspath(__file__)]))
```

- [ ] **Step 2: Run the test — expect FAIL**

Run: `pytest -q tests/test_preview_fallback.py`
Expected: `test_quick_tunnel_when_unconfigured` FAILS — today `start_tunnel` returns the "not provisioned" error (missing credentials file) instead of calling `open_quick_tunnel`.

- [ ] **Step 3: Empty the author-specific defaults in `config.py`**

Replace `bridge/config.py:73-79` with:

```python
PREVIEW_HOSTNAME = os.environ.get("PREVIEW_HOSTNAME", "")
TUNNEL_NAME = os.environ.get("TUNNEL_NAME", "")
TUNNEL_ID = os.environ.get("TUNNEL_ID", "")
TUNNEL_CREDENTIALS_FILE = os.path.expanduser(os.environ.get("TUNNEL_CREDENTIALS_FILE", ""))
TUNNEL_CONFIG_FILE = os.path.expanduser(os.environ.get("TUNNEL_CONFIG_FILE", ""))
```

- [ ] **Step 4: Add the fallback in `tunnel.py`**

Add this helper just above `def start_tunnel(port: int):` (line 140):

```python
def _named_configured() -> bool:
    """A stable named tunnel is usable only if the hostname, id, and local
    credentials file are all present. Otherwise /preview uses a quick tunnel."""
    return bool(config.TUNNEL_ID and config.PREVIEW_HOSTNAME
                and os.path.isfile(config.TUNNEL_CREDENTIALS_FILE))
```

Replace the body of the `with _tunnel_lock:` block in `start_tunnel` (lines 148-168) with:

```python
    with _tunnel_lock:
        if _tunnel_proc and _tunnel_proc.poll() is None and _tunnel_url:
            if _tunnel_port == port:
                return _tunnel_url, f"🔗 Already live (port {port}):\n{_tunnel_url}"
            _stop_tunnel_locked()
        if not _named_configured():
            proc, url = open_quick_tunnel(port)
            if not proc or not url:
                if not _which_cloudflared():
                    return (None, "❌ `cloudflared` not found. Install it first.")
                return (None, "❌ Couldn't establish a quick tunnel.")
            _tunnel_proc, _tunnel_url, _tunnel_port = proc, url, port
            return url, (f"🔗 Preview live (port {port}):\n{url}\n\n"
                         "⚠️ Public link — anyone with it can reach your server while "
                         "it's running. /preview stop when done.")
        proc, info = _spawn_named(port)
        if not proc:
            if info == "missing-bin" or not _which_cloudflared():
                return (None, "❌ `cloudflared` not found. Install it first.")
            return (None, "❌ Couldn't establish the preview tunnel — cloudflared "
                          "didn't register with Cloudflare. Check the credentials "
                          f"file ({config.TUNNEL_CREDENTIALS_FILE}) and connectivity.")
        _tunnel_proc, _tunnel_url, _tunnel_port = proc, info, port
        return info, (f"🔗 Preview live (port {port}):\n{info}\n\n"
                      "⚠️ Public link — anyone with it can reach your server while "
                      "it's running. /preview stop when done.")
```

- [ ] **Step 5: Run the test — expect PASS**

Run: `pytest -q tests/test_preview_fallback.py`
Expected: 2 passed.

- [ ] **Step 6: Guard against regressions in the full suite**

Run: `pytest -q`
Expected: all pass (in particular any existing preview/tunnel tests). If `tests/test_preview_queue.py` or similar assumed named-tunnel defaults, update them to set `config.PREVIEW_HOSTNAME`/`TUNNEL_ID` explicitly via `monkeypatch`.

- [ ] **Step 7: Commit**

```bash
git add bridge/config.py bridge/tunnel.py tests/test_preview_fallback.py
git commit -m "feat(preview): drop maintainer defaults; quick-tunnel fallback when unconfigured"
```

---

### Task 3: Prebuilt web assets + npm standardization

Removes the build blocker: commit both `dist/` folders so a fresh clone runs without Node, and delete the dashboard's stray pnpm files so the one supported build path (npm) can't trip on esbuild.

**Files:**
- Modify: `.gitignore` (un-ignore both `dist/`)
- Delete: `bridge/dashboard/web/pnpm-lock.yaml`, `bridge/dashboard/web/pnpm-workspace.yaml`
- Add (build output): `bridge/miniapp/web/dist/**`, `bridge/dashboard/web/dist/**`

**Interfaces:**
- Produces: committed `bridge/miniapp/web/dist/index.html` and `bridge/dashboard/web/dist/index.html` so `miniapp.web_built()` (`claude_telegram_bridge.py:52`) is satisfied on a fresh clone.

- [ ] **Step 1: Un-ignore the built assets**

In `.gitignore`, delete these two lines (keep the `node_modules/` lines):
```
bridge/miniapp/web/dist/
bridge/dashboard/web/dist/
```

- [ ] **Step 2: Remove the pnpm files (standardize on npm)**

```bash
cd /home/mhzrerfani/projects/mystical-assistant
git rm --ignored -q bridge/dashboard/web/pnpm-lock.yaml bridge/dashboard/web/pnpm-workspace.yaml 2>/dev/null \
  || rm -f bridge/dashboard/web/pnpm-lock.yaml bridge/dashboard/web/pnpm-workspace.yaml
```

- [ ] **Step 3: Build both clients with npm (verify clean)**

```bash
npm --prefix bridge/dashboard/web ci && npm --prefix bridge/dashboard/web run build
npm --prefix bridge/miniapp/web  ci && npm --prefix bridge/miniapp/web  run build
test -f bridge/dashboard/web/dist/index.html && test -f bridge/miniapp/web/dist/index.html && echo OK
```
Expected: both builds succeed (`tsc -b && vite build`, no errors) and print `OK`. If the dashboard build fails referencing esbuild, ensure `node_modules` was reinstalled with npm (`rm -rf bridge/dashboard/web/node_modules` then `npm ci`).

- [ ] **Step 4: Verify assets are now tracked**

Run: `git status --short bridge/*/web/dist | head`
Expected: `dist/` files show as additions (`A`/`??`), not ignored.

- [ ] **Step 5: Verify a "no-build" start works**

Run: `mystical restart && mystical status`
Expected: `mini app 8787 : HTTP 200` (the prebuilt Mini App is served; `web_built()` passed). Then `mystical stop`.

- [ ] **Step 6: Commit**

```bash
git add .gitignore bridge/miniapp/web/dist bridge/dashboard/web/dist
git rm --cached -q bridge/dashboard/web/pnpm-lock.yaml bridge/dashboard/web/pnpm-workspace.yaml 2>/dev/null || true
git commit -m "feat(setup): ship prebuilt web assets; standardize on npm"
```

---

### Task 4: `bridge/onboard.py` — chat-id capture + `.env` writer

Two small, unit-tested helpers that keep `setup.sh` thin and free of `jq`: poll Telegram `getUpdates` for the user's chat id, and idempotently set a key in `.env`.

**Files:**
- Create: `bridge/onboard.py`
- Test: `tests/test_onboard.py`

**Interfaces:**
- Produces:
  - `onboard.poll_chat_id(token, *, get_updates, attempts=60, sleep=2, sleep_fn=time.sleep) -> int | None`
  - `onboard.set_env(path, key, value) -> None` (writes `key="value"`, update-or-append)
  - CLI: `python3 bridge/onboard.py capture-chat-id <token>` (prints id or exits 1); `python3 bridge/onboard.py set-env <path> <key> <value>`
- Consumed by: `setup.sh` (Task 5).

- [ ] **Step 1: Write the failing tests**

Create `tests/test_onboard.py`:

```python
"""onboard: chat-id polling + .env writer. Run: python tests/test_onboard.py"""
import os

from bridge import onboard


def test_poll_returns_first_chat_id():
    calls = {"n": 0}

    def fake_updates(token):
        calls["n"] += 1
        if calls["n"] < 2:
            return {"ok": True, "result": []}
        return {"ok": True, "result": [{"message": {"chat": {"id": 5116773453}}}]}

    cid = onboard.poll_chat_id("tok", get_updates=fake_updates, sleep=0, sleep_fn=lambda s: None)
    assert cid == 5116773453
    assert calls["n"] == 2


def test_poll_gives_up_returns_none():
    cid = onboard.poll_chat_id("tok", get_updates=lambda t: {"result": []},
                               attempts=3, sleep=0, sleep_fn=lambda s: None)
    assert cid is None


def test_poll_handles_edited_message():
    upd = {"result": [{"edited_message": {"chat": {"id": 42}}}]}
    cid = onboard.poll_chat_id("tok", get_updates=lambda t: upd, sleep_fn=lambda s: None)
    assert cid == 42


def test_set_env_appends_then_updates(tmp_path):
    p = tmp_path / ".env"
    onboard.set_env(str(p), "TELEGRAM_BOT_TOKEN", "abc")
    assert 'TELEGRAM_BOT_TOKEN="abc"' in p.read_text()
    onboard.set_env(str(p), "TELEGRAM_BOT_TOKEN", "xyz")
    body = p.read_text()
    assert 'TELEGRAM_BOT_TOKEN="xyz"' in body
    assert body.count("TELEGRAM_BOT_TOKEN=") == 1  # updated, not duplicated


if __name__ == "__main__":
    import subprocess
    raise SystemExit(subprocess.call(["pytest", "-q", os.path.abspath(__file__)]))
```

- [ ] **Step 2: Run the tests — expect FAIL**

Run: `pytest -q tests/test_onboard.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'bridge.onboard'`.

- [ ] **Step 3: Implement `bridge/onboard.py`**

```python
#!/usr/bin/env python3
"""Onboarding helpers for setup.sh — stdlib + `requests` (imported lazily so the
unit tests can inject a fake fetcher without the dependency)."""
import sys
import time


def poll_chat_id(token, *, get_updates, attempts=60, sleep=2, sleep_fn=time.sleep):
    """Poll Telegram getUpdates until a message arrives; return its chat id (int),
    or None if none arrives within `attempts` tries. `get_updates(token)` returns
    the parsed Telegram response dict (injectable for tests)."""
    for i in range(attempts):
        data = get_updates(token) or {}
        for upd in data.get("result", []):
            msg = upd.get("message") or upd.get("edited_message")
            if msg and isinstance(msg.get("chat"), dict) and "id" in msg["chat"]:
                return int(msg["chat"]["id"])
        if i < attempts - 1:
            sleep_fn(sleep)
    return None


def set_env(path, key, value):
    """Idempotently set key="value" in a .env file (update in place or append)."""
    import os
    lines = []
    if os.path.exists(path):
        with open(path) as f:
            lines = f.read().splitlines()
    out, found = [], False
    for ln in lines:
        if ln.startswith(f"{key}=") or ln.startswith(f"export {key}="):
            out.append(f'{key}="{value}"')
            found = True
        else:
            out.append(ln)
    if not found:
        out.append(f'{key}="{value}"')
    with open(path, "w") as f:
        f.write("\n".join(out) + "\n")


def _get_updates(token):
    import requests
    r = requests.get(f"https://api.telegram.org/bot{token}/getUpdates", timeout=30)
    return r.json()


def main(argv):
    if len(argv) >= 3 and argv[1] == "capture-chat-id":
        cid = poll_chat_id(argv[2], get_updates=_get_updates)
        if cid is None:
            return 1
        print(cid)
        return 0
    if len(argv) >= 5 and argv[1] == "set-env":
        set_env(argv[2], argv[3], argv[4])
        return 0
    print("usage: onboard.py capture-chat-id <token> | set-env <path> <key> <value>",
          file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
```

- [ ] **Step 4: Run the tests — expect PASS**

Run: `pytest -q tests/test_onboard.py`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add bridge/onboard.py tests/test_onboard.py
git commit -m "feat(setup): onboard helpers — chat-id capture + .env writer"
```

---

### Task 5: `setup.sh` wizard + `mystical doctor`

Ties it together: a prereq doctor, an inline @BotFather walkthrough, automatic chat-id capture (no log-reading), an optional Mini App toggle, a generated dashboard token, and `mystical` linked onto PATH. `mystical doctor` reuses the doctor via `--check-only`.

**Files:**
- Create: `setup.sh` (executable, committed)
- Modify: `bin/mystical` (add `doctor` command + usage line)

**Interfaces:**
- Consumes: `bridge/onboard.py` CLI (`capture-chat-id`, `set-env`), the `.env`/`.env.example` schema from Task 1.
- Produces: a populated `.env`; a `~/.local/bin/mystical` symlink; `./setup.sh --check-only` exit code (0 = prereqs OK).

- [ ] **Step 1: Write `setup.sh`**

```bash
#!/usr/bin/env bash
#
# setup.sh — one-command onboarding for mystical-assistant.
# Idempotent: re-run any time; it only asks for what's still missing.
#   ./setup.sh              full wizard
#   ./setup.sh --check-only prereq doctor, then exit (used by `mystical doctor`)

set -euo pipefail
REPO="$(cd "$(dirname "$(realpath "$0")")" && pwd)"
ENV_FILE="$REPO/.env"
ONBOARD=(python3 "$REPO/bridge/onboard.py")

c_g=$'\033[32m'; c_r=$'\033[31m'; c_y=$'\033[33m'; c_0=$'\033[0m'
ok()   { printf '%s✓%s %s\n' "$c_g" "$c_0" "$*"; }
bad()  { printf '%s✗%s %s\n' "$c_r" "$c_0" "$*"; }
warn() { printf '%s!%s %s\n' "$c_y" "$c_0" "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

doctor() {
  local hard=0
  if have claude; then ok "claude found"
  else bad "claude not found — install & log in: https://claude.com/claude-code"; hard=1; fi
  if have python3; then ok "python3 $(python3 -c 'import platform;print(platform.python_version())')"
  else bad "python3 not found (need 3.9+)"; hard=1; fi
  if python3 -c 'import requests' >/dev/null 2>&1; then ok "python 'requests' available"
  else bad "python 'requests' missing — pip install requests"; hard=1; fi
  if have cloudflared; then ok "cloudflared found"
  else warn "cloudflared not found — only needed for the Mini App panel and /preview"; fi
  if have npm; then ok "npm found (only needed to rebuild the web UI)"
  else warn "npm not found — fine unless you rebuild the web clients"; fi
  return $hard
}

get_env() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}\$/\1/p" "$ENV_FILE" | head -n1 || true; }

if [ "${1:-}" = "--check-only" ]; then doctor; exit $?; fi

echo "── mystical-assistant setup ──"
if ! doctor; then echo; bad "Fix the required items above, then re-run ./setup.sh."; exit 1; fi
touch "$ENV_FILE"; chmod 600 "$ENV_FILE"

# -- bot token ---------------------------------------------------------------
token="$(get_env TELEGRAM_BOT_TOKEN)"
if [ -z "$token" ]; then
  echo
  echo "Create a Telegram bot to get a token:"
  echo "  1. Open @BotFather:  https://t.me/BotFather"
  echo "  2. Send /newbot and follow the prompts (name + username)."
  echo "  3. Copy the token (looks like 123456:ABC-...)."
  printf "Paste your bot token: "; read -r token
  [ -n "$token" ] || { bad "No token entered."; exit 1; }
  "${ONBOARD[@]}" set-env "$ENV_FILE" TELEGRAM_BOT_TOKEN "$token"
  ok "token saved to .env"
fi

# -- BASE_PATH ---------------------------------------------------------------
if [ -z "$(get_env BASE_PATH)" ]; then
  printf "Root folder for your projects [%s]: " "$HOME/projects"
  read -r base; base="${base:-$HOME/projects}"
  "${ONBOARD[@]}" set-env "$ENV_FILE" BASE_PATH "$base"
  ok "BASE_PATH → $base"
fi

# -- dashboard token (stable + secure) ---------------------------------------
if [ -z "$(get_env DASH_TOKEN)" ]; then
  dtok="$(openssl rand -hex 24 2>/dev/null || python3 -c 'import secrets;print(secrets.token_urlsafe(24))')"
  "${ONBOARD[@]}" set-env "$ENV_FILE" DASH_TOKEN "$dtok"
fi

# -- chat id (auto-capture) --------------------------------------------------
if [ -z "$(get_env ALLOWED_CHAT_IDS)" ]; then
  echo
  echo "Now open Telegram and send your bot ANY message so it can learn your id…"
  cid="$("${ONBOARD[@]}" capture-chat-id "$token" || true)"
  if [ -n "$cid" ]; then
    "${ONBOARD[@]}" set-env "$ENV_FILE" ALLOWED_CHAT_IDS "$cid"
    ok "captured chat id $cid — you are the only allowed user"
  else
    warn "No message received in time. Re-run ./setup.sh, or start 'mystical',"
    warn "message the bot, and add the printed id to ALLOWED_CHAT_IDS in .env."
  fi
fi

# -- Mini App toggle ---------------------------------------------------------
if [ -z "$(get_env MINIAPP_ENABLE)" ]; then
  if have cloudflared; then
    printf "Enable the Telegram Mini App control panel? [Y/n]: "
    read -r ans; case "${ans:-y}" in [Nn]*) mini=0;; *) mini=1;; esac
  else
    warn "cloudflared missing — disabling the Mini App (bot + dashboard still work)."
    mini=0
  fi
  "${ONBOARD[@]}" set-env "$ENV_FILE" MINIAPP_ENABLE "$mini"
fi

# -- link `mystical` onto PATH -----------------------------------------------
mkdir -p "$HOME/.local/bin"
ln -sf "$REPO/bin/mystical" "$HOME/.local/bin/mystical"
ok "linked 'mystical' → ~/.local/bin/mystical"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) : ;;
  *) warn "~/.local/bin isn't on PATH. Add:  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

echo; ok "Setup complete."
echo "Start it:   mystical"
port="$(get_env DASH_PORT)"; port="${port:-8790}"
echo "Dashboard:  http://127.0.0.1:$port/?token=$(get_env DASH_TOKEN)"
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x setup.sh`

- [ ] **Step 3: Add `doctor` to `bin/mystical`**

Add a command function near `cmd_run` (after line 122):

```bash
cmd_doctor() { exec "$REPO/setup.sh" --check-only; }
```

Add a case branch in the `case` block (after the `run|fg)` line):

```bash
  doctor)           cmd_doctor ;;
```

Add a usage line in `usage()` after the `run` line:

```bash
  mystical doctor    check prerequisites (claude, python, cloudflared, npm)
```

- [ ] **Step 4: Verify the doctor path**

Run: `./setup.sh --check-only; echo "exit=$?"` and `mystical doctor`
Expected: both print the ✓/✗ prereq list; `exit=0` when `claude`, `python3`, and `requests` are present.

- [ ] **Step 5: Verify idempotent wizard (no clobber)**

Run: `./setup.sh`
Expected: because `.env` already has token/BASE_PATH/ALLOWED_CHAT_IDS/MINIAPP_ENABLE, the wizard asks nothing, re-links `mystical`, and prints the dashboard URL. Confirm `.env` is unchanged (`git status` still shows `.env` untracked/ignored, values intact).

- [ ] **Step 6: Commit**

```bash
git add setup.sh bin/mystical
git commit -m "feat(setup): setup.sh onboarding wizard + mystical doctor"
```

---

### Task 6: README rewrite for a public landing

Replace the multi-command quick start with the three-line happy path; move the manual/advanced details below. (The demo GIF and `LICENSE` are produced in the separate marketing track — this task only leaves a clearly-marked placeholder for the GIF and does **not** add a license.)

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a description + demo placeholder at the top**

Under the `# mystical-assistant` title, before "Surfaces", insert:

```markdown
> Control Claude Code on your own machine from your phone — Telegram-native.

<!-- DEMO_GIF: 45–60s screen recording (marketing track) goes here -->
```

Also set the GitHub repo description to match: `Control Claude Code from your phone — a Telegram-native remote (bot + Mini App) + localhost dashboard.`

- [ ] **Step 2: Replace the "Quick start" section**

Replace the entire `## Quick start` section (through the end of the `mystical` command table) with:

```markdown
## Quick start

**Prerequisites:** the `claude` CLI (installed and logged in) and Python 3.9+
with `requests`. `cloudflared` and Node are optional (only for the Mini App
panel and rebuilding the web UI).

```bash
git clone https://github.com/mhzrerfani/mystical-assistant
cd mystical-assistant
./setup.sh      # checks prereqs, walks you through @BotFather, writes .env
mystical        # start it — then message your bot
```

`./setup.sh` captures your Telegram chat id automatically (just message the bot
when it asks) and links a `mystical` launcher onto your PATH:

```
mystical            start in the background (logs → ~/.bridge_state/mystical.log)
mystical stop       graceful stop
mystical restart    stop, then start
mystical status     running? + ports, dashboard URL, tunnel link
mystical doctor     check prerequisites
mystical logs       follow the log
mystical run        run in the foreground
```

The prebuilt web clients ship in the repo, so there is no build step. To hack on
the UI, rebuild with `npm --prefix bridge/<dashboard|miniapp>/web ci && … run build`.
```

- [ ] **Step 3: Add a "Manual / advanced" subsection**

Immediately after the Quick start, add:

```markdown
### Manual / advanced setup

- **Config lives in `.env`** (git-ignored; `setup.sh` writes it). See
  `.env.example` for every option. Required: `TELEGRAM_BOT_TOKEN`, `BASE_PATH`,
  `ALLOWED_CHAT_IDS`.
- **Dashboard only (no cloudflared):** set `MINIAPP_ENABLE="0"` in `.env`.
- **Stable preview URL:** by default `/preview` uses ephemeral
  `*.trycloudflare.com` links. To get a fixed hostname, provision a named
  Cloudflare Tunnel and set `PREVIEW_HOSTNAME`/`TUNNEL_NAME`/`TUNNEL_ID`/
  `TUNNEL_CREDENTIALS_FILE` in `.env`.
- **First-run discovery mode:** if chat-id capture times out, start `mystical`
  with `ALLOWED_CHAT_IDS` empty, message the bot, and copy the printed id.
```

- [ ] **Step 4: Update the SECURITY section token reference**

In the `## Security` section, replace the `TELEGRAM_BOT_TOKEN`/`run.sh` bullet so it points at `.env`:

```markdown
- Treat `TELEGRAM_BOT_TOKEN` as a secret (it also signs Mini App `initData`).
  It lives in `.env`, which is git-ignored; keep it `chmod 600`.
```

- [ ] **Step 5: Verify the README renders and links resolve**

Run: `grep -n "run.sh" README.md`
Expected: no stale references implying the user must author `run.sh` by hand (the launcher is now committed; config is `.env`).

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README around ./setup.sh happy path"
```

---

## Self-Review

**Spec coverage:**
- §1 `.env` config → Task 1. §2 prebuilt + npm → Task 3. §3 remove author defaults + preview fallback → Task 2. §4 `setup.sh` wizard → Tasks 4+5. §5 `mystical doctor` → Task 5. §6 README → Task 6. §7 tests → drift test (Task 1), preview fallback (Task 2), onboard helpers (Task 4). All spec sections map to a task.
- Spec §6 `LICENSE`: intentionally deferred to the marketing track; Task 6 notes it and does not add one. No gap — it's out of scope by the spec's own "choice deferred" note.

**Placeholder scan:** No `TBD`/`TODO`/"handle edge cases"/"similar to Task N". The one `<!-- DEMO_GIF … -->` is a deliberate, labeled hand-off to the marketing track, not a plan gap.

**Type consistency:** `poll_chat_id`, `set_env`, `_named_configured`, `open_quick_tunnel`, `_spawn_named`, `_which_cloudflared`, `start_tunnel(port) -> (url|None, message)`, and the `capture-chat-id`/`set-env` CLI verbs are used identically across Tasks 4, 5, and 2. `.env` key names match `.env.example` (Task 1), `config.py`, and every `set-env` call in `setup.sh` (Task 5).
