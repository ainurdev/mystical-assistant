"""Localhost-only desktop dashboard: a full-parity Claude client + live log
streaming over the SAME store/runner/devserver as the Mini App.

SECURITY (critical): bound to 127.0.0.1 and NEVER tunneled (tunnel.start_tunnel
refuses DASH_PORT). Any web page the user visits can reach 127.0.0.1:DASH_PORT, so:
  - EVERY request must carry an allow-listed Host header  -> defeats DNS-rebinding;
  - every state-changing (POST) request must carry the per-process secret
    DASH_TOKEN in X-Dash-Token plus an allow-listed Origin  -> defeats CSRF;
  - SSE streams carry the token in ?token= (EventSource cannot set headers); read
    GETs are further protected by the browser same-origin policy.
The dashboard operates as config.DASH_CHAT_ID, sharing that user's store sessions
and active project with the Telegram bot + Mini App.
"""

import hmac
import json
import mimetypes
import os
import queue
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.parse import parse_qs, urlparse

from bridge import browser, config, devserver, pubsub, runner, state, store, tunnel
from bridge.miniapp.server import _save_images, _session_brief, normalize_model_effort

WEB_DIR = os.path.join(os.path.dirname(__file__), "web", "dist")
_HOSTS = {f"127.0.0.1:{config.DASH_PORT}", f"localhost:{config.DASH_PORT}",
          f"[::1]:{config.DASH_PORT}"}
_ORIGINS = {f"http://{h}" for h in _HOSTS}


def _tok_ok(tok: str) -> bool:
    return hmac.compare_digest(tok or "", config.DASH_TOKEN)


def _chat() -> int:
    return config.DASH_CHAT_ID


def web_built() -> bool:
    return os.path.isfile(os.path.join(WEB_DIR, "index.html"))


def _abs_project(project) -> str | None:
    if not project:
        return None
    cand = os.path.realpath(os.path.join(config.BASE_PATH, str(project).lstrip("/")))
    return cand if browser.within_base(cand) and os.path.isdir(cand) else None


class Handler(BaseHTTPRequestHandler):
    server_version = "ClaudeBridgeDashboard"

    def log_message(self, *a):  # silence default logging
        pass

    # --- low-level ---
    def _send(self, data: bytes, code: int, ctype: str, cache: str = "no-cache"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, obj, code: int = 200):
        self._send(json.dumps(obj).encode(), code, "application/json")

    def _read_json(self):
        try:
            n = int(self.headers.get("Content-Length", 0) or 0)
            return json.loads(self.rfile.read(n) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return None

    def _host_ok(self) -> bool:
        return self.headers.get("Host", "") in _HOSTS

    # --- routing ---
    def do_GET(self):
        try:
            if not self._host_ok():
                return self._json({"error": "bad host"}, 403)
            u = urlparse(self.path)
            path, qs = u.path, parse_qs(u.query)
            if path.startswith("/local/stream/"):
                return self._stream(path[len("/local/stream/"):], qs)
            if path.startswith("/local/"):
                return self._get_api(path, qs)
            return self._static(path)
        except Exception as e:  # noqa: BLE001
            self._safe500(e)

    def do_POST(self):
        try:
            if not self._host_ok():
                return self._json({"error": "bad host"}, 403)
            origin = self.headers.get("Origin")
            if origin is not None and origin not in _ORIGINS:
                return self._json({"error": "bad origin"}, 403)
            if not _tok_ok(self.headers.get("X-Dash-Token", "")):
                return self._json({"error": "unauthorized"}, 401)
            path = urlparse(self.path).path
            body = self._read_json()
            if body is None:
                return self._json({"error": "bad json"}, 400)
            return self._post_api(path, body)
        except Exception as e:  # noqa: BLE001
            self._safe500(e)

    def _safe500(self, e):
        try:
            self._json({"error": f"{type(e).__name__}: {e}"}, 500)
        except Exception:  # noqa: BLE001
            pass

    # --- GET reads (Host-gated; SOP protects responses) ---
    def _get_api(self, path, qs):
        chat = _chat()
        if path == "/local/state":
            pd = state.project_dir(chat)
            return self._json({
                "project": {"rel": browser.rel(pd), "name": os.path.basename(pd)},
                "busy": state.busy_chat is not None, "busy_chat": state.busy_chat,
                "server": devserver.server_state(), "preview": tunnel.tunnel_state()})
        if path == "/local/projects":
            relp = (qs.get("dir", [""])[0] or "").strip()
            cur = config.BASE_PATH if relp in ("", "/") else os.path.realpath(
                os.path.join(config.BASE_PATH, relp.lstrip("/")))
            if not browser.within_base(cur) or not os.path.isdir(cur):
                cur = config.BASE_PATH
            real = os.path.realpath(cur)
            return self._json({"rel": browser.rel(cur), "at_base": real == config.BASE_PATH,
                               "can_up": real != config.BASE_PATH,
                               "dirs": browser.list_dirs(cur)})
        if path == "/local/sessions":
            project = qs.get("project", [None])[0]
            rows = (store.list_sessions(chat, project) if project is not None
                    else store.list_sessions_all(chat))
            return self._json({"sessions": [_session_brief(s) for s in rows]})
        if path.startswith("/local/sessions/"):
            sid = path[len("/local/sessions/"):].split("/")[0]
            s = store.get_session(sid)
            if not s or s["chat_id"] != chat:
                return self._json({"error": "not found"}, 404)
            try:
                cursor = int(qs.get("cursor", ["0"])[0])
            except ValueError:
                cursor = 0
            return self._json(store.transcript(sid, cursor))
        if path.startswith("/local/run/"):
            job = runner.get_job(path[len("/local/run/"):])
            if not job:
                return self._json({"error": "not found"}, 404)
            try:
                cursor = int(qs.get("cursor", ["0"])[0])
            except ValueError:
                cursor = 0
            return self._json(job.snapshot(cursor))
        if path == "/local/logs":
            try:
                n = int(qs.get("n", ["200"])[0])
            except ValueError:
                n = 200
            return self._json({"lines": devserver.log_tail(n)})
        return self._json({"error": "not found"}, 404)

    # --- POST control (Host + Origin + token gated) ---
    def _post_api(self, path, body):
        chat = _chat()
        if path == "/local/run":
            return self._run(chat, body)
        if path.startswith("/local/run/") and path.endswith("/respond"):
            return self._respond(path[len("/local/run/"):-len("/respond")], body)
        if path.startswith("/local/run/") and path.endswith("/interrupt"):
            return self._interrupt(path[len("/local/run/"):-len("/interrupt")], body)
        if path == "/local/server":
            return self._server(chat, body)
        if path == "/local/preview":
            return self._preview(body)
        if path == "/local/select":
            return self._select(chat, body)
        if path == "/local/sessions":
            project = (body.get("project") or "").strip()
            return self._json({"session": _session_brief(store.create_session(chat, project))})
        if path.startswith("/local/sessions/") and path.endswith("/archive"):
            sid = path[len("/local/sessions/"):-len("/archive")]
            s = store.get_session(sid)
            if not s or s["chat_id"] != chat:
                return self._json({"error": "not found"}, 404)
            store.archive(sid)
            return self._json({"ok": True})
        return self._json({"error": "not found"}, 404)

    def _run(self, chat, body):
        prompt = (body.get("prompt") or "").strip()
        images = body.get("images") or []
        if not prompt and not images:
            return self._json({"error": "empty prompt"}, 400)
        if not isinstance(images, list) or len(images) > config.UPLOAD_MAX_COUNT:
            return self._json({"error": f"too many images (max {config.UPLOAD_MAX_COUNT})"}, 413)
        project_path = _abs_project(body.get("project"))
        ok, model, effort = normalize_model_effort(body.get("model"), body.get("effort"))
        if not ok:
            return self._json({"error": "invalid model"}, 400)
        session_id = (body.get("session_id") or "").strip() or None
        job_id = uuid.uuid4().hex
        try:
            paths = _save_images(job_id, images) if images else []
        except ValueError as e:
            runner._cleanup_uploads(job_id)
            return self._json({"error": str(e)}, 413)
        job = runner.start_streaming_job(chat, prompt, paths, project_path, job_id=job_id,
                                         model=model, effort=effort, session_id=session_id)
        if job is None:
            runner._cleanup_uploads(job_id)
            return self._json({"error": "busy"}, 409)
        self._json({"job_id": job.id, "session_id": job.store_session_id})

    def _respond(self, job_id, body):
        job = runner.get_job(job_id)
        if not job:
            return self._json({"error": "not found"}, 404)
        rid = (body.get("request_id") or "").strip()
        if not rid:
            return self._json({"error": "missing request_id"}, 400)
        behavior = "deny" if body.get("behavior") == "deny" else "allow"
        if not job.respond(rid, behavior=behavior, answers=body.get("answers")):
            return self._json({"error": "no such pending request"}, 409)
        self._json(job.snapshot(_cursor(body)))

    def _interrupt(self, job_id, body):
        job = runner.get_job(job_id)
        if not job:
            return self._json({"error": "not found"}, 404)
        if not job.interrupt():
            return self._json({"error": "not running"}, 409)
        self._json(job.snapshot(_cursor(body)))

    def _server(self, chat, body):
        action = body.get("action", "start")
        if action == "stop":
            msg = devserver.stop_server()
        else:
            cmd = (body.get("cmd") or "").strip() or config.START_CMD
            msg = devserver.start_server(cmd, state.project_dir(chat))
        self._json({"server": devserver.server_state(), "message": msg})

    def _preview(self, body):
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

    def _select(self, chat, body):
        d = (body.get("dir") or "").strip()
        cand = os.path.realpath(os.path.join(config.BASE_PATH, d.lstrip("/")))
        if not browser.within_base(cand) or not os.path.isdir(cand):
            return self._json({"error": "invalid dir"}, 400)
        state.active[chat] = cand
        self._json({"project": {"rel": browser.rel(cand), "name": os.path.basename(cand)}})

    # --- SSE live streams (?token= gated) ---
    def _stream(self, rest, qs):
        if not _tok_ok(qs.get("token", [""])[0]):
            return self._json({"error": "unauthorized"}, 401)
        if rest.startswith("session/"):
            sid = rest[len("session/"):].split("/")[0]
            try:
                cursor = int(qs.get("cursor", ["0"])[0])
            except ValueError:
                cursor = 0
            self._sse(f"session:{sid}", lambda c: store.transcript(sid, c)["events"], cursor)
        elif rest == "logs":
            self._sse("logs", lambda c: [{"line": ln} for ln in devserver.log_tail(200)], 0)
        else:
            self._json({"error": "not found"}, 404)

    def _sse(self, topic, backfill, cursor):
        self.close_connection = True   # close-delimited framing, no keep-alive reuse
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
        except (BrokenPipeError, ConnectionResetError):
            return
        q = pubsub.subscribe(topic)    # subscribe FIRST, then backfill, dedupe by seq
        last = cursor - 1
        try:
            if not self._emit_backfill(backfill, cursor, lambda s: None):
                return
            last = self._max_seq(backfill(cursor), last)
            try:
                self.connection.settimeout(120)
            except OSError:
                pass
            while True:
                try:
                    item = q.get(timeout=15)
                except queue.Empty:
                    if not self._comment("keepalive"):
                        return
                    continue
                if item is pubsub.SHUTDOWN:
                    return
                if item is pubsub.RESYNC:
                    for ev in backfill(last + 1):
                        last = self._max_seq([ev], last)
                        if not self._frame(ev):
                            return
                    continue
                if isinstance(item, dict) and "seq" in item:
                    if item["seq"] <= last:
                        continue
                    last = item["seq"]
                if not self._frame(item):
                    return
        finally:
            pubsub.unsubscribe(topic, q)

    def _emit_backfill(self, backfill, cursor, _):
        for ev in backfill(cursor):
            if not self._frame(ev):
                return False
        return True

    @staticmethod
    def _max_seq(evs, last):
        for ev in evs:
            if isinstance(ev, dict) and "seq" in ev:
                last = max(last, ev["seq"])
        return last

    def _frame(self, obj) -> bool:
        try:
            self.wfile.write(f"data: {json.dumps(obj)}\n\n".encode())
            self.wfile.flush()
            return True
        except (BrokenPipeError, ConnectionResetError, OSError):
            return False

    def _comment(self, txt) -> bool:
        try:
            self.wfile.write(f": {txt}\n\n".encode())
            self.wfile.flush()
            return True
        except (BrokenPipeError, ConnectionResetError, OSError):
            return False

    # --- static (SPA) ---
    def _static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        fp = os.path.normpath(os.path.join(WEB_DIR, path.lstrip("/")))
        if fp != WEB_DIR and not fp.startswith(WEB_DIR + os.sep):
            return self._send(b"forbidden", 403, "text/plain")
        cache = "no-cache"
        if not os.path.isfile(fp):
            fp = os.path.join(WEB_DIR, "index.html")
            if not os.path.isfile(fp):
                return self._send(
                    b"Dashboard not built. Run: npm --prefix bridge/dashboard/web ci "
                    b"&& npm --prefix bridge/dashboard/web run build", 503, "text/plain")
        elif "/assets/" in path:
            cache = "public, max-age=31536000, immutable"
        ctype = mimetypes.guess_type(fp)[0] or "application/octet-stream"
        with open(fp, "rb") as f:
            self._send(f.read(), 200, ctype, cache=cache)


def _cursor(body) -> int:
    try:
        return int(body.get("cursor") or 0)
    except (ValueError, TypeError):
        return 0


_httpd: ThreadingHTTPServer | None = None


def start() -> ThreadingHTTPServer:
    global _httpd
    _httpd = ThreadingHTTPServer((config.DASH_HOST, config.DASH_PORT), Handler)
    Thread(target=_httpd.serve_forever, daemon=True).start()
    return _httpd


def stop():
    global _httpd
    if _httpd is not None:
        _httpd.shutdown()
        _httpd = None
