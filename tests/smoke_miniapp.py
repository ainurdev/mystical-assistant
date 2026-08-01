"""End-to-end smoke test of the Mini App HTTP server (no Telegram, no Claude run).

Starts the real server on a test port and exercises auth, static serving, and the
read/select endpoints with a properly signed initData.
Run: `python3 tests/smoke_miniapp.py`
"""

import hashlib
import hmac
import json
import os
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["TELEGRAM_BOT_TOKEN"] = "12345:SMOKETOKEN"
os.environ["ALLOWED_CHAT_IDS"] = "555"
os.environ["BASE_PATH"] = "/home/mhzrerfani/projects"
os.environ["MINIAPP_PORT"] = "8799"

import requests  # noqa: E402

from bridge import config  # noqa: E402
from bridge.miniapp import server  # noqa: E402


def make_init_data(token, uid):
    params = {"auth_date": str(int(time.time())), "query_id": "x",
              "user": json.dumps({"id": uid, "first_name": "T"}, separators=(",", ":"))}
    check = "\n".join(f"{k}={params[k]}" for k in sorted(params))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    h = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    parts = {**params, "hash": h}
    return "&".join(f"{k}={urllib.parse.quote(v, safe='')}" for k, v in parts.items())


results = []


def check(name, cond, info=""):
    results.append(cond)
    print(("PASS" if cond else "FAIL"), name, f"({info})" if info else "")


server.start()
time.sleep(0.4)
base = f"http://127.0.0.1:{config.MINIAPP_PORT}"
H = {"X-Telegram-Init-Data": make_init_data(config.TOKEN, 555)}
BAD = {"X-Telegram-Init-Data": make_init_data("99999:WRONG", 555)}

try:
    r = requests.get(base + "/", timeout=5)
    check("GET / serves HTML", r.status_code == 200
          and "text/html" in r.headers.get("Content-Type", ""), r.status_code)

    r = requests.get(base + "/assets/", timeout=5)  # dir, not a file -> SPA fallback html
    check("unknown path -> SPA fallback 200", r.status_code == 200, r.status_code)

    r = requests.get(base + "/api/state", timeout=5)
    check("GET /api/state no auth -> 401", r.status_code == 401, r.status_code)

    r = requests.get(base + "/api/state", headers=BAD, timeout=5)
    check("GET /api/state bad sig -> 401", r.status_code == 401, r.status_code)

    r = requests.get(base + "/api/state", headers=H, timeout=5)
    js = r.json()
    check("GET /api/state authed", r.status_code == 200 and "server" in js and "preview" in js,
          r.status_code)

    r = requests.get(base + "/api/projects", headers=H, timeout=5)
    js = r.json()
    check("GET /api/projects lists base", r.status_code == 200 and "ainurhq" in js.get("dirs", []),
          js.get("dirs"))

    r = requests.get(base + "/api/projects?dir=/ainurhq", headers=H, timeout=5)
    js = r.json()
    check("GET /api/projects drill-in", r.status_code == 200 and js.get("can_up") is True,
          js.get("rel"))

    r = requests.post(base + "/api/select", headers=H, json={"dir": "/ainurhq"}, timeout=5)
    js = r.json()
    check("POST /api/select", r.status_code == 200 and js.get("project", {}).get("name") == "ainurhq",
          r.status_code)

    r = requests.post(base + "/api/select", headers=H, json={"dir": "/../etc"}, timeout=5)
    check("POST /api/select escapes base -> 400", r.status_code == 400, r.status_code)

    r = requests.get(base + "/api/run/does-not-exist", headers=H, timeout=5)
    check("GET /api/run/<unknown> -> 404", r.status_code == 404, r.status_code)
finally:
    server.stop()

fail = results.count(False)
print(f"\n{len(results) - fail}/{len(results)} passed")
raise SystemExit(1 if fail else 0)
