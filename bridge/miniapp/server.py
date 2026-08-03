"""HTTP server for the Telegram Mini App.

Serves the built React app (web/dist) and a small JSON API. Every /api/* request
must carry a valid, signed Telegram `initData` (header X-Telegram-Init-Data) for a
user in ALLOWED_CHAT_IDS — the same trust boundary as the bot's chat-id gate.
"""

import base64
import binascii
import hashlib
import hmac
import json
import mimetypes
import os
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

from bridge import (agents, browser, config, devserver, git, github,
                    models, native, project_config, relevance, runner, state,
                    store, transcript_jsonl, tunnel, usage)

WEB_DIR = os.path.join(os.path.dirname(__file__), "web", "dist")

_EXT = {"image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg",
        "image/webp": "webp", "image/gif": "gif"}


def validate_init_data(init_data: str) -> int | None:
    """Verify Telegram WebApp initData. Returns the user id if valid+allowed, else None."""
    if not init_data:
        return None
    data: dict[str, str] = {}
    for pair in init_data.split("&"):
        if not pair:
            continue
        k, _, v = pair.partition("=")
        data[k] = unquote(v)
    recv_hash = data.pop("hash", None)
    if not recv_hash:
        return None
    check = "\n".join(f"{k}={data[k]}" for k in sorted(data))
    secret = hmac.new(b"WebAppData", config.TOKEN.encode(), hashlib.sha256).digest()
    calc = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(calc, recv_hash):
        return None
    try:
        if time.time() - int(data.get("auth_date", "0")) > 86400:
            return None
    except ValueError:
        return None
    try:
        uid = int(json.loads(data.get("user", "{}")).get("id"))
    except (ValueError, TypeError, json.JSONDecodeError):
        return None
    # Fail closed: this server is reachable from the public internet through the
    # public tunnel, and an empty allowlist must never mean "allow anyone".
    if not config.ALLOWED_CHAT_IDS or uid not in config.ALLOWED_CHAT_IDS:
        return None
    return uid


def normalize_model_effort(model, effort) -> tuple[bool, str | None, str | None]:
    """Validate a run's requested model/effort. Returns (ok, model, effort):
    ok=False means an unknown model (the caller should 400). A blank model or
    effort becomes None (use the CLI default); an unknown effort is dropped."""
    m = (model or "").strip() or None
    e = (effort or "").strip() or None
    if (m is not None and m not in models.model_ids()
            and m not in config.MINIAPP_MODELS and not m.startswith("claude-")):
        return False, None, None
    if e is not None and e not in config.MINIAPP_EFFORTS:
        e = None
    return True, m, e


def normalize_permission_mode(mode) -> str | None:
    """Validate a run's requested permission/operating mode. Unknown or blank ->
    None, so the caller falls back to config.MINIAPP_PERMISSION_MODE."""
    m = (mode or "").strip() or None
    if m is not None and m not in config.MINIAPP_PERMISSION_MODES:
        return None
    return m


def _session_brief(s: dict) -> dict:
    cwd = s.get("cwd")
    return {"id": s["id"], "title": s["title"], "project": s["project"],
            "updated": s["updated"], "archived": s["archived"],
            "origin": s.get("origin"), "cwd": cwd,
            "fallback_policy": s.get("fallback_policy"),
            "branch": git.current_branch_cached(cwd) if cwd else ""}


def _pre_title(s: dict, title) -> dict:
    """Name a freshly created, still-empty session (the relevance guardrail routes
    a split-off task into one pre-titled). Marks it manual so the auto-titler
    won't overwrite the name after the first turn."""
    title = " ".join(str(title or "").split())[:60]
    if not title:
        return s
    store.rename(s["id"], title)
    return store.get_session(s["id"])


def transcript_for(session: dict, cursor: int = 0) -> dict:
    """Unified transcript loader. A session that still lives only as native JSONL
    (started in VSCode and not yet continued through the bridge) renders from that
    JSONL on demand; everything else renders from the store. Same shape either way."""
    if session.get("origin") in ("vscode", "terminal"):
        path = transcript_jsonl.find_transcript(session.get("claude_session_id"))
        data = (transcript_jsonl.parse_jsonl(path, cursor) if path
                else {"turns": [], "events": [], "next_cursor": cursor})
        return {"session": session, **data}
    data = store.transcript(session["id"], cursor)
    # Fallback: a bridge row whose conversation actually lives in the native JSONL
    # (shares a claude_session_id but was never journaled) -> render from JSONL.
    if not data["turns"] and session.get("claude_session_id"):
        path = transcript_jsonl.find_transcript(session["claude_session_id"])
        if path:
            jdata = transcript_jsonl.parse_jsonl(path, cursor)
            if jdata["turns"]:
                return {"session": session, **jdata}
    return data


def _save_images(job_id: str, images: list) -> list[str]:
    paths: list[str] = []
    d = os.path.join(config.UPLOAD_DIR, job_id)
    os.makedirs(d, exist_ok=True)
    for i, durl in enumerate(images):
        if not isinstance(durl, str) or "," not in durl:
            continue
        header, _, b64 = durl.partition(",")
        mime = "image/png"
        if header.startswith("data:") and ";" in header:
            mime = header[5:].split(";")[0] or "image/png"
        ext = _EXT.get(mime, "png")
        try:
            raw = base64.b64decode(b64)
        except (binascii.Error, ValueError):
            continue
        if len(raw) > config.UPLOAD_MAX_MB * 1024 * 1024:
            raise ValueError(f"image {i + 1} exceeds {config.UPLOAD_MAX_MB} MB")
        p = os.path.join(d, f"shot{i + 1}.{ext}")
        with open(p, "wb") as f:
            f.write(raw)
        paths.append(p)
    return paths


class Handler(BaseHTTPRequestHandler):
    server_version = "ClaudeBridgeMiniApp"

    # --- low-level helpers ---------------------------------------------------
    def _send_bytes(self, data: bytes, code: int, ctype: str, cache: str = "no-cache"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, obj: dict, code: int = 200):
        self._send_bytes(json.dumps(obj).encode(), code, "application/json")

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
            raw = self.rfile.read(length) if length else b"{}"
            return json.loads(raw or b"{}")
        except (ValueError, json.JSONDecodeError):
            return None

    def _auth(self) -> int | None:
        return validate_init_data(self.headers.get("X-Telegram-Init-Data", ""))

    def log_message(self, *args):  # silence default stderr logging
        pass

    # --- routing -------------------------------------------------------------
    def do_GET(self):
        try:
            u = urlparse(self.path)
            path, qs = u.path, parse_qs(u.query)
            if path.startswith("/api/"):
                chat_id = self._auth()
                if chat_id is None:
                    return self._json({"error": "unauthorized"}, 401)
                if path == "/api/state":
                    return self._api_state(chat_id)
                if path == "/api/projects":
                    return self._api_projects(qs)
                if path == "/api/history":
                    return self._api_history(chat_id, qs)
                if path == "/api/running":
                    return self._api_running(chat_id)
                if path == "/api/agents":
                    return self._api_agents(chat_id, qs)
                if path == "/api/agents/activity":
                    return self._api_agent_activity(chat_id, qs)
                if path == "/api/usage":
                    return self._json(usage.get_usage())
                if path == "/api/github/issues":
                    return self._json(github.issues(state.project_dir(chat_id)))
                if path == "/api/sessions":
                    return self._api_sessions_list(chat_id, qs)
                if path.startswith("/api/sessions/"):
                    return self._api_session_get(
                        chat_id, path[len("/api/sessions/"):], qs)
                if path.startswith("/api/run/"):
                    return self._api_run_poll(chat_id, path[len("/api/run/"):], qs)
                return self._json({"error": "not found"}, 404)
            self._serve_static(path)
        except Exception as e:  # noqa: BLE001
            self._safe_500(e)

    def do_POST(self):
        try:
            path = urlparse(self.path).path
            if not path.startswith("/api/"):
                return self._json({"error": "not found"}, 404)
            chat_id = self._auth()
            if chat_id is None:
                return self._json({"error": "unauthorized"}, 401)
            body = self._read_json()
            if body is None:
                return self._json({"error": "bad json"}, 400)
            if path == "/api/select":
                return self._api_select(chat_id, body)
            if path == "/api/sessions":
                return self._api_sessions_create(chat_id, body)
            if path.startswith("/api/sessions/") and path.endswith("/archive"):
                return self._api_session_archive(
                    chat_id, path[len("/api/sessions/"):-len("/archive")], body)
            if path.startswith("/api/sessions/") and path.endswith("/policy"):
                return self._api_session_policy(
                    chat_id, path[len("/api/sessions/"):-len("/policy")], body)
            if path.startswith("/api/run/") and path.endswith("/respond"):
                return self._api_run_respond(
                    chat_id, path[len("/api/run/"):-len("/respond")], body)
            if path.startswith("/api/run/") and path.endswith("/interrupt"):
                return self._api_run_interrupt(
                    chat_id, path[len("/api/run/"):-len("/interrupt")], body)
            if path == "/api/run":
                return self._api_run(chat_id, body)
            if path == "/api/server":
                return self._api_server(chat_id, body)
            if path == "/api/preview":
                return self._api_preview(chat_id, body)
            return self._json({"error": "not found"}, 404)
        except Exception as e:  # noqa: BLE001
            self._safe_500(e)

    def _safe_500(self, e: Exception):
        try:
            self._json({"error": f"{type(e).__name__}: {e}"}, 500)
        except Exception:  # noqa: BLE001
            pass

    # --- API handlers --------------------------------------------------------
    def _api_state(self, chat_id: int):
        pd = state.project_dir(chat_id)
        self._json({
            "project": {"rel": browser.rel(pd), "name": os.path.basename(pd)} if pd else None,
            "busy": state.any_running(),
            "server": devserver.server_state(pd),
            "preview": tunnel.tunnel_state(),
            "permission_mode": config.MINIAPP_PERMISSION_MODE,
            "models": models.get_models(),
        })

    def _api_projects(self, qs):
        relp = (qs.get("dir", [""])[0] or "").strip()
        if relp in ("", "/"):
            cur = config.BASE_PATH
        else:
            cur = os.path.realpath(os.path.join(config.BASE_PATH, relp.lstrip("/")))
        if not browser.within_base(cur) or not os.path.isdir(cur):
            cur = config.BASE_PATH
        real = os.path.realpath(cur)
        self._json({
            "rel": browser.rel(cur),
            "at_base": real == config.BASE_PATH,
            "can_up": real != config.BASE_PATH,
            "dirs": browser.list_dirs(cur),
            "projects": browser.list_projects(),
        })

    def _api_select(self, chat_id: int, body: dict):
        d = (body.get("dir") or "").strip()
        cand = os.path.realpath(os.path.join(config.BASE_PATH, d.lstrip("/")))
        if not browser.within_base(cand) or not os.path.isdir(cand):
            return self._json({"error": "invalid dir"}, 400)
        state.active[chat_id] = cand
        self._json({"project": {"rel": browser.rel(cand), "name": os.path.basename(cand)}})

    def _api_run(self, chat_id: int, body: dict):
        prompt = (body.get("prompt") or "").strip()
        images = body.get("images") or []
        if not prompt and not images:
            return self._json({"error": "empty prompt"}, 400)
        if not isinstance(images, list) or len(images) > config.UPLOAD_MAX_COUNT:
            return self._json({"error": f"too many images (max {config.UPLOAD_MAX_COUNT})"}, 413)
        project_path = None
        project = body.get("project")
        if project:
            cand = os.path.realpath(os.path.join(config.BASE_PATH, str(project).lstrip("/")))
            if browser.within_base(cand) and os.path.isdir(cand):
                project_path = cand
        ok, model, effort = normalize_model_effort(body.get("model"), body.get("effort"))
        if not ok:
            return self._json({"error": "invalid model"}, 400)
        permission_mode = normalize_permission_mode(body.get("permission_mode"))
        ponytail = runner.normalize_ponytail(body.get("ponytail"))
        session_id = (body.get("session_id") or "").strip() or None
        # Hold a prompt that doesn't belong in the session it would resume; the
        # client re-sends with force=true (or against a fresh session). Before
        # _save_images so a held prompt writes nothing.
        held = relevance.gate(chat_id, project_path, session_id, prompt,
                              bool(body.get("force")))
        if held:
            return self._json(held)
        job_id = uuid.uuid4().hex
        try:
            paths = _save_images(job_id, images) if images else []
        except ValueError as e:
            runner._cleanup_uploads(job_id)
            return self._json({"error": str(e)}, 413)
        job = runner.start_streaming_job(chat_id, prompt, paths, project_path,
                                         job_id=job_id, model=model, effort=effort,
                                         permission_mode=permission_mode,
                                         session_id=session_id, origin="miniapp",
                                         ponytail=ponytail)
        if job is None:
            runner._cleanup_uploads(job_id)
            return self._json({"error": "busy"}, 409)
        self._json({"job_id": job.id, "session_id": job.store_session_id})

    def _owned_job(self, chat_id: int, job_id: str):
        """Fetch a job only if it belongs to this chat. On the public miniapp,
        another allowed user must not poll/answer/interrupt someone else's run."""
        job = runner.get_job(job_id)
        if not job or job.chat_id != chat_id:
            return None
        return job

    def _api_run_poll(self, chat_id: int, job_id: str, qs):
        try:
            cursor = int(qs.get("cursor", ["0"])[0])
        except ValueError:
            cursor = 0
        job = self._owned_job(chat_id, job_id)
        if not job:
            return self._json({"error": "not found"}, 404)
        self._json(job.snapshot(cursor))

    def _api_history(self, chat_id: int, qs):
        native.refresh(chat_id)            # surface VSCode sessions in the history view
        archived = qs.get("archived", ["0"])[0] == "1"
        self._json({"sessions": store.history(chat_id, include_archived=archived)})

    def _api_running(self, chat_id: int):
        self._json(runner.running_snapshot(chat_id))

    def _agents_session(self, chat_id: int, qs):
        sid = qs.get("session", [""])[0]
        s = store.get_session(sid) if sid else None
        if not s or s["chat_id"] != chat_id:
            return None
        return s

    def _api_agents(self, chat_id: int, qs):
        s = self._agents_session(chat_id, qs)
        if not s:
            return self._json({"error": "not found"}, 404)
        self._json(agents.session_agents(s))

    def _api_agent_activity(self, chat_id: int, qs):
        s = self._agents_session(chat_id, qs)
        if not s:
            return self._json({"error": "not found"}, 404)
        try:
            cursor = int(qs.get("cursor", ["0"])[0])
        except ValueError:
            cursor = 0
        self._json(agents.agent_activity(s, qs.get("agent", [""])[0], cursor,
                                          qs.get("workflow", [""])[0] or None))

    def _api_sessions_list(self, chat_id: int, qs):
        native.refresh(chat_id)            # surface VSCode sessions started since last poll
        project = (qs.get("project", [""])[0] or "").strip()
        rows = (store.list_sessions(chat_id, project) if project
                else store.list_sessions_all(chat_id))    # no project -> all sessions
        # Sessions of a since-deleted dir (e.g. a removed worktree checkout)
        # stay out of the lists; their transcripts remain viewable by id.
        rows = [r for r in rows if browser.project_exists(r["project"])]
        self._json({"sessions": [_session_brief(s) for s in rows]})

    def _api_sessions_create(self, chat_id: int, body: dict):
        project = (body.get("project") or "").strip()
        cand = os.path.realpath(os.path.join(config.BASE_PATH, project.lstrip("/")))
        cwd = (cand if browser.within_base(cand) and os.path.isdir(cand)
               else state.project_dir(chat_id))
        s = store.create_session(chat_id, project, origin="miniapp", cwd=cwd,
                                 permission_mode=config.NEW_SESSION_PERMISSION_MODE)
        self._json({"session": _session_brief(_pre_title(s, body.get("title")))})

    def _api_session_get(self, chat_id: int, rest: str, qs):
        sid = rest.split("/")[0]
        s = store.get_session(sid)
        if not s or s["chat_id"] != chat_id:
            return self._json({"error": "not found"}, 404)
        try:
            cursor = int(qs.get("cursor", ["0"])[0])
        except ValueError:
            cursor = 0
        self._json(transcript_for(s, cursor))

    def _api_session_archive(self, chat_id: int, sid: str, body: dict):
        s = store.get_session(sid)
        if not s or s["chat_id"] != chat_id:
            return self._json({"error": "not found"}, 404)
        store.archive(sid)
        self._json({"ok": True})

    def _api_session_policy(self, chat_id: int, sid: str, body: dict):
        """Set what a usage-limit death does to this session (ask/auto/wait);
        null clears back to the configured default."""
        from bridge import ladder
        s = store.get_session(sid)
        if not s or s["chat_id"] != chat_id:
            return self._json({"error": "not found"}, 404)
        policy = body.get("policy") or None
        if policy is not None and policy not in ladder.POLICIES:
            return self._json({"error": f"policy must be one of {ladder.POLICIES}"}, 400)
        store.set_fallback_policy(sid, policy)
        self._json({"ok": True, "fallback_policy": policy})

    def _api_run_respond(self, chat_id: int, job_id: str, body: dict):
        """Answer a pending permission (Allow/Deny) or AskUserQuestion for a job."""
        job = self._owned_job(chat_id, job_id)
        if not job:
            return self._json({"error": "not found"}, 404)
        request_id = (body.get("request_id") or "").strip()
        if not request_id:
            return self._json({"error": "missing request_id"}, 400)
        behavior = "deny" if body.get("behavior") == "deny" else "allow"
        ok = job.respond(request_id, behavior=behavior, answers=body.get("answers"))
        if not ok:
            return self._json({"error": "no such pending request"}, 409)
        try:
            cursor = int(body.get("cursor") or 0)
        except (ValueError, TypeError):
            cursor = 0
        self._json(job.snapshot(cursor))

    def _api_run_interrupt(self, chat_id: int, job_id: str, body: dict):
        """Stop a running turn. The session is preserved, so the next message
        resumes the conversation."""
        job = self._owned_job(chat_id, job_id)
        if not job:
            return self._json({"error": "not found"}, 404)
        if not job.interrupt():
            return self._json({"error": "not running"}, 409)
        try:
            cursor = int(body.get("cursor") or 0)
        except (ValueError, TypeError):
            cursor = 0
        self._json(job.snapshot(cursor))

    def _api_server(self, chat_id: int, body: dict):
        pd = state.project_dir(chat_id)
        action = body.get("action", "start")
        if action == "stop":
            msg = devserver.stop_server(pd)
        else:
            cmd = ((body.get("cmd") or "").strip()
                   or project_config.run_cmd(state.project_key(chat_id))
                   or config.START_CMD)
            msg = devserver.start_server(cmd, pd)
        self._json({"server": devserver.server_state(pd), "message": msg})

    def _api_preview(self, chat_id: int, body: dict):
        action = body.get("action", "start")
        if action == "stop":
            msg = tunnel.stop_tunnel()
        else:
            try:
                port = int(body.get("port") or config.PREVIEW_PORT)
            except (ValueError, TypeError):
                port = config.PREVIEW_PORT
            _, msg = tunnel.start_tunnel(port)
        self._json({"preview": tunnel.tunnel_state(), "message": msg})

    # --- static (SPA) --------------------------------------------------------
    def _serve_static(self, path: str):
        if path in ("", "/"):
            path = "/index.html"
        fp = os.path.normpath(os.path.join(WEB_DIR, path.lstrip("/")))
        if fp != WEB_DIR and not fp.startswith(WEB_DIR + os.sep):
            return self._send_bytes(b"forbidden", 403, "text/plain")
        cache = "no-cache"
        if not os.path.isfile(fp):
            fp = os.path.join(WEB_DIR, "index.html")  # SPA fallback
            if not os.path.isfile(fp):
                return self._send_bytes(
                    b"Mini App not built. Run: "
                    b"npm --prefix bridge/miniapp/web ci && "
                    b"npm --prefix bridge/miniapp/web run build",
                    503, "text/plain")
        else:
            if "/assets/" in path:
                cache = "public, max-age=31536000, immutable"
        ctype = mimetypes.guess_type(fp)[0] or "application/octet-stream"
        with open(fp, "rb") as f:
            self._send_bytes(f.read(), 200, ctype, cache=cache)


_httpd: ThreadingHTTPServer | None = None


def web_built() -> bool:
    return os.path.isfile(os.path.join(WEB_DIR, "index.html"))


def start() -> ThreadingHTTPServer:
    """Start the HTTP server thread on 127.0.0.1:MINIAPP_PORT."""
    global _httpd
    os.makedirs(config.UPLOAD_DIR, exist_ok=True)
    _httpd = ThreadingHTTPServer(("127.0.0.1", config.MINIAPP_PORT), Handler)
    threading.Thread(target=_httpd.serve_forever, daemon=True).start()
    return _httpd


def stop():
    global _httpd
    if _httpd is not None:
        _httpd.shutdown()
        _httpd = None
