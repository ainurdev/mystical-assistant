"""The bridge's own OAuth login to a shared MCP server (MCP authorization, stdlib).

Claude's tokens for a server are Claude's: bridge/mcp.py says `claude` owns that
state, and a second reader of a rotating refresh token can log Claude out. So a
server shared through the gateway gets a separate login, under its own client
registration: discovery (RFC 9728 + 8414), dynamic registration (RFC 7591), and an
authorization code with PKCE (RFC 7636). It is the same dance `claude mcp login`
does, with the redirect pointed at the dashboard.

Tokens live in ~/.mystical/mcp-oauth.json, 0600, and are never returned by a route
or handed to an agent.

The redirect is 127.0.0.1, because that is where the dashboard listens, so a login
has to finish in a browser on this machine: the same limit `claude mcp login` has.

Not built: a server with no dynamic registration, which would need a client id
pasted by hand. It reports that as its error.
"""

import base64
import hashlib
import json
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from bridge import config

_FILE = os.path.expanduser(os.environ.get("MCP_OAUTH_FILE", "~/.mystical/mcp-oauth.json"))
_lock = threading.Lock()
_pending: dict = {}          # state -> a login waiting for its redirect
_TTL = 900
_SKEW = 60


def _load() -> dict:
    try:
        with open(_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(data: dict) -> None:
    os.makedirs(os.path.dirname(_FILE), mode=0o700, exist_ok=True)
    tmp = _FILE + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, _FILE)


def _json(url: str, data: "bytes | None" = None, headers: "dict | None" = None) -> dict:
    req = urllib.request.Request(url, data=data, headers={"Accept": "application/json", **(headers or {})})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def _origin(url: str) -> str:
    u = urllib.parse.urlsplit(url)
    return f"{u.scheme}://{u.netloc}"


def _discover(url: str) -> dict:
    """The authorization server's metadata for this MCP server's URL."""
    meta_url = ""
    try:
        urllib.request.urlopen(urllib.request.Request(url, method="GET"), timeout=15).close()
    except urllib.error.HTTPError as e:
        m = re.search(r'resource_metadata="([^"]+)"', e.headers.get("WWW-Authenticate") or "")
        meta_url = m.group(1) if m else ""
    except (urllib.error.URLError, OSError):
        pass
    issuer = _origin(url)
    for candidate in (meta_url, f"{_origin(url)}/.well-known/oauth-protected-resource"):
        if not candidate:
            continue
        try:
            found = _json(candidate).get("authorization_servers") or []
            if found:
                issuer = found[0]
                break
        except (urllib.error.URLError, OSError, ValueError):
            continue
    u = urllib.parse.urlsplit(issuer)
    path = u.path.rstrip("/")
    for well in (f"{u.scheme}://{u.netloc}/.well-known/oauth-authorization-server{path}",
                 f"{u.scheme}://{u.netloc}/.well-known/openid-configuration{path}"):
        try:
            return _json(well)
        except (urllib.error.URLError, OSError, ValueError):
            continue
    raise ValueError("this server doesn't publish how to log in to it")


def redirect_uri() -> str:
    return f"http://127.0.0.1:{config.DASH_PORT}/local/mcp-share/callback"


def begin(server: str, url: str) -> str:
    """Start a login; returns the URL to open."""
    meta = _discover(url)
    reg = meta.get("registration_endpoint")
    if not reg:
        raise ValueError("this server doesn't allow dynamic client registration")
    client = _json(reg, json.dumps({
        "client_name": "Mystical", "redirect_uris": [redirect_uri()],
        "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"],
        "token_endpoint_auth_method": "none"}).encode(), {"Content-Type": "application/json"})
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(24)
    with _lock:
        now = time.time()
        for k in [k for k, v in _pending.items() if v["at"] < now - _TTL]:
            _pending.pop(k)
        _pending[state] = {"server": server, "url": url, "verifier": verifier, "at": now,
                           "token_endpoint": meta["token_endpoint"], "client_id": client["client_id"],
                           "client_secret": client.get("client_secret")}
    return meta["authorization_endpoint"] + "?" + urllib.parse.urlencode({
        "response_type": "code", "client_id": client["client_id"], "redirect_uri": redirect_uri(),
        "state": state, "code_challenge": challenge, "code_challenge_method": "S256",
        "resource": url})


def finish(state: str, code: str) -> str:
    """The redirect came back. Returns the server's name; ValueError when this
    isn't a login we started."""
    with _lock:
        p = _pending.pop(state, None)
    if not p:
        raise ValueError("no login is waiting for this answer")
    body = {"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri(),
            "client_id": p["client_id"], "code_verifier": p["verifier"], "resource": p["url"]}
    if p.get("client_secret"):
        body["client_secret"] = p["client_secret"]
    tok = _json(p["token_endpoint"], urllib.parse.urlencode(body).encode(),
                {"Content-Type": "application/x-www-form-urlencoded"})
    _store(p["server"], tok, p)
    return p["server"]


def _store(server: str, tok: dict, p: dict) -> None:
    with _lock:
        data = _load()
        data[server] = {
            "access": tok["access_token"], "refresh": tok.get("refresh_token") or (data.get(server) or {}).get("refresh"),
            "expires": time.time() + float(tok.get("expires_in") or 3600),
            "token_endpoint": p["token_endpoint"], "client_id": p["client_id"],
            "client_secret": p.get("client_secret"), "resource": p.get("url") or p.get("resource")}
        data[server]["resource"] = data[server]["resource"] or ""
        _save(data)


def token(server: str) -> "str | None":
    """A live bearer token for this server, refreshed if due; None without a login."""
    row = _load().get(server)
    if not row:
        return None
    if row.get("expires", 0) - _SKEW > time.time():
        return row.get("access")
    if not row.get("refresh"):
        return None
    body = {"grant_type": "refresh_token", "refresh_token": row["refresh"], "client_id": row["client_id"]}
    if row.get("client_secret"):
        body["client_secret"] = row["client_secret"]
    if row.get("resource"):
        body["resource"] = row["resource"]
    try:
        tok = _json(row["token_endpoint"], urllib.parse.urlencode(body).encode(),
                    {"Content-Type": "application/x-www-form-urlencoded"})
    except (urllib.error.URLError, OSError, ValueError, KeyError):
        return None
    _store(server, tok, row)
    return tok.get("access_token")


def logged_in(server: str) -> bool:
    return server in _load()


def logout(server: str) -> None:
    with _lock:
        data = _load()
        if data.pop(server, None) is not None:
            _save(data)
