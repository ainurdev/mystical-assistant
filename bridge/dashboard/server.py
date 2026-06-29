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

import base64
import hmac
import json
import mimetypes
import os
import queue
import socket
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.parse import parse_qs, urlparse

import re

from bridge import (browser, config, devserver, git, github, native,
                    project_config, pubsub, runner, screenshot, shell, state,
                    store, sysinfo, terminals, tunnel, usage, weather, wsutil)
from bridge.miniapp.server import (_save_images, _session_brief,
                                   normalize_model_effort, normalize_permission_mode,
                                   transcript_for)

WEB_DIR = os.path.join(os.path.dirname(__file__), "web", "dist")
_HOSTS = {f"127.0.0.1:{config.DASH_PORT}", f"localhost:{config.DASH_PORT}",
          f"[::1]:{config.DASH_PORT}"}
_ORIGINS = {f"http://{h}" for h in _HOSTS}


def _tok_ok(tok: str) -> bool:
    return hmac.compare_digest(tok or "", config.DASH_TOKEN)


def _ws_authorized(host: str, origin: str, token: str) -> bool:
    """Gate the terminal websocket upgrade. WebSockets bypass the browser
    same-origin policy, so the Origin allow-list is checked explicitly
    (anti-CSWSH) on top of the Host allow-list and the per-process token."""
    return host in _HOSTS and origin in _ORIGINS and _tok_ok(token)


def _chat() -> int:
    return config.DASH_CHAT_ID


def web_built() -> bool:
    return os.path.isfile(os.path.join(WEB_DIR, "index.html"))


def _abs_project(project) -> str | None:
    if not project:
        return None
    cand = os.path.realpath(os.path.join(config.BASE_PATH, str(project).lstrip("/")))
    return cand if browser.within_base(cand) and os.path.isdir(cand) else None


# Managed git worktrees live under a hidden dir at the workspace root, so the
# project browser (which skips dotdirs) never surfaces them as projects.
_WT_ROOT = os.path.join(config.BASE_PATH, ".worktrees")
_SLUG_RE = re.compile(r"[^A-Za-z0-9._-]+")


def _slug(s: str) -> str:
    return _SLUG_RE.sub("-", (s or "").strip().strip("/")).strip("-") or "wt"


def _worktree_path(project_rel: str, branch: str) -> str:
    repo = _slug(os.path.basename((project_rel or "").rstrip("/")) or "repo")
    return os.path.join(_WT_ROOT, repo, _slug(branch))


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
            if path == "/local/ws/terminal":
                return self._terminal_ws(qs)
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
                "server": devserver.server_state(), "preview": tunnel.tunnel_state(),
                "dev_port": config.PREVIEW_PORT,
                "permission_mode": config.MINIAPP_PERMISSION_MODE})
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
        if path == "/local/history":
            native.refresh(chat)           # surface VSCode sessions in the history view
            archived = qs.get("archived", ["0"])[0] == "1"
            return self._json({"sessions": store.history(chat, include_archived=archived)})
        if path == "/local/running":
            return self._json(runner.running_snapshot(chat))
        if path == "/local/usage":
            return self._json(usage.get_usage())
        if path == "/local/sessions":
            native.refresh(chat)           # surface VSCode sessions started since last poll
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
            return self._json(transcript_for(s, cursor))
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
        if path == "/local/git":
            abs_p = _abs_project(qs.get("project", [None])[0])
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            return self._json(git.status(abs_p))
        if path == "/local/git/all":
            repos = {}
            seen = set()
            for s in store.list_sessions_all(chat):
                rel = s["project"]
                if rel in seen:
                    continue
                seen.add(rel)
                abs_p = _abs_project(rel)
                if abs_p is None:
                    continue
                b = git.badge(abs_p)
                if b is not None:
                    repos[rel] = b
            return self._json({"repos": repos})
        if path == "/local/git/diff":
            abs_p = _abs_project(qs.get("project", [None])[0])
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            fpath = qs.get("path", [""])[0]
            base = (qs.get("base", [""])[0] or "").strip()
            head = (qs.get("head", [""])[0] or "").strip()
            if base and head:
                refs = set(git.branches(abs_p)) | {git.default_branch(abs_p)}
                if base not in refs or head not in refs:
                    return self._json({"error": "invalid ref"}, 400)
                return self._json({"path": fpath, "diff": git.diff_ref(abs_p, base, head, fpath)})
            return self._json({"path": fpath, "diff": git.diff(abs_p, fpath)})
        if path == "/local/github/issues":
            abs_p = _abs_project(qs.get("project", [None])[0])
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            return self._json(github.issues(abs_p))
        if path == "/local/project/settings":
            rel = qs.get("project", [None])[0] or browser.rel(state.project_dir(chat))
            abs_p = _abs_project(rel)
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            return self._json({
                "scripts": project_config.package_scripts(abs_p),
                "run_cmd": project_config.run_cmd(rel),
                "prod_url": project_config.prod_url(rel),
                "default_cmd": config.START_CMD,
                "log_path": devserver.DEV_LOG_REL,
            })
        if path == "/local/shell":
            try:
                cursor = int(qs.get("cursor", ["0"])[0])
            except ValueError:
                cursor = 0
            return self._json(shell.snapshot(cursor))
        if path == "/local/terminals":
            return self._json({"terminals": terminals.info(qs.get("project", [None])[0])})
        if path == "/local/sysinfo":
            return self._json(sysinfo.host_stats())
        if path == "/local/weather":
            return self._json(weather.current())
        if path == "/local/git/branches":
            abs_p = _abs_project(qs.get("project", [None])[0])
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            return self._json({"branches": git.branches(abs_p),
                               "current": git.current_branch(abs_p),
                               "default": git.default_branch(abs_p)})
        if path == "/local/git/worktrees":
            abs_p = _abs_project(qs.get("project", [None])[0])
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            wts = git.worktrees(abs_p)
            for w in wts:
                w["rel"] = browser.rel(w["path"]) if browser.within_base(w["path"]) else None
            return self._json({"worktrees": wts})
        if path == "/local/git/compare":
            abs_p = _abs_project(qs.get("project", [None])[0])
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            base = (qs.get("base", ["main"])[0] or "main").strip()
            head = (qs.get("head", [""])[0] or git.current_branch(abs_p)).strip()
            three_dot = (qs.get("dots", ["3"])[0] or "3").strip() != "2"
            return self._json(git.compare(abs_p, base, head, three_dot))
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
        if path == "/local/shell":
            return self._json(shell.run(state.project_dir(chat), body.get("command", "")))
        if path == "/local/shell/kill":
            return self._json(shell.kill())
        if path == "/local/terminals":
            abs_p = _abs_project(body.get("cwd_rel") or body.get("project"))
            if abs_p is None:
                return self._json({"error": "invalid directory"}, 400)
            try:
                cols, rows = int(body.get("cols", 80)), int(body.get("rows", 24))
            except (ValueError, TypeError):
                cols, rows = 80, 24
            return self._json(terminals.create(abs_p, body.get("project", ""), cols, rows))
        if path.startswith("/local/terminals/") and path.endswith("/close"):
            return self._json(terminals.close(path[len("/local/terminals/"):-len("/close")]))
        if path == "/local/server":
            return self._server(chat, body)
        if path == "/local/preview":
            return self._preview(body)
        if path == "/local/preview/screenshot":
            return self._api_preview_screenshot(body)
        if path == "/local/select":
            return self._select(chat, body)
        if path == "/local/sessions":
            project = (body.get("project") or "").strip()
            # A worktree session runs in its own cwd (a linked worktree under
            # .worktrees) while still grouping under its logical project.
            wt = (body.get("cwd") or "").strip()
            wt_abs = os.path.realpath(wt) if wt else None
            cwd = (wt_abs if wt_abs and browser.within_base(wt_abs)
                   and os.path.isdir(wt_abs) else None) \
                or _abs_project(project) or state.project_dir(chat)
            s = store.create_session(chat, project, origin="dashboard", cwd=cwd,
                                     permission_mode=config.NEW_SESSION_PERMISSION_MODE)
            return self._json({"session": _session_brief(s)})
        if path.startswith("/local/sessions/") and path.endswith("/archive"):
            sid = path[len("/local/sessions/"):-len("/archive")]
            s = store.get_session(sid)
            if not s or s["chat_id"] != chat:
                return self._json({"error": "not found"}, 404)
            store.archive(sid)
            return self._json({"ok": True})
        if path == "/local/git/commit":
            abs_p = _abs_project(body.get("project"))
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            msg = (body.get("message") or "").strip()[:2000]
            if not msg:
                return self._json({"error": "empty commit message"}, 400)
            ok, output = git.commit(abs_p, msg)
            return self._json({"ok": ok, "output": output})
        if path == "/local/git/push":
            abs_p = _abs_project(body.get("project"))
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            ok, output = git.push(abs_p)
            return self._json({"ok": ok, "output": output})
        if path == "/local/github/issue":
            abs_p = _abs_project(body.get("project"))
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            title = (body.get("title") or "").strip()[:256]
            if not title:
                return self._json({"error": "empty title"}, 400)
            body_text = (body.get("body") or "")[:65536]
            ok, output = github.create_issue(abs_p, title, body_text)
            return self._json({"ok": ok, "output": output})
        if path == "/local/project/settings":
            rel = (body.get("project") or "").strip()
            if _abs_project(rel) is None:
                return self._json({"error": "invalid project"}, 400)
            out: dict = {"ok": True}
            if "run_cmd" in body:
                out["run_cmd"] = project_config.set_run_cmd(rel, (body.get("run_cmd") or "")[:1000])
            if "prod_url" in body:
                out["prod_url"] = project_config.set_prod_url(rel, (body.get("prod_url") or "")[:1000])
            return self._json(out)
        if path == "/local/git/checkout":
            abs_p = _abs_project(body.get("project"))
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            ok, output = git.checkout(abs_p, (body.get("ref") or "").strip())
            return self._json({"ok": ok, "output": output})
        if path == "/local/git/branch/delete":
            abs_p = _abs_project(body.get("project"))
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            ok, output = git.delete_branch(abs_p, (body.get("name") or "").strip(),
                                           force=bool(body.get("force")))
            return self._json({"ok": ok, "output": output})
        if path == "/local/git/merge":
            abs_p = _abs_project(body.get("project"))
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            branch = (body.get("branch") or "").strip()
            into = (body.get("into") or "").strip()
            if into and into != git.current_branch(abs_p):
                ok, output = git.checkout(abs_p, into)
                if not ok:
                    return self._json({"ok": False, "output": output})
            ok, output = git.merge(abs_p, branch)
            return self._json({"ok": ok, "output": output})
        if path == "/local/git/worktree":
            return self._worktree(body)
        if path == "/local/git/worktree/remove":
            abs_p = _abs_project(body.get("project"))
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            wt = os.path.realpath((body.get("path") or "").strip())
            if not browser.within_base(wt):
                return self._json({"error": "invalid path"}, 400)
            ok, output = git.worktree_remove(abs_p, wt)
            if ok and body.get("delete_branch") and body.get("branch"):
                git.delete_branch(abs_p, (body.get("branch") or "").strip(), force=True)
            return self._json({"ok": ok, "output": output})
        if path == "/local/github/pr":
            abs_p = _abs_project(body.get("project"))
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            head = (body.get("head") or git.current_branch(abs_p)).strip()
            base = (body.get("base") or git.default_branch(abs_p)).strip()
            title = (body.get("title") or "").strip()[:256] or f"Merge {head} into {base}"
            ok, info = github.create_pr(abs_p, head, base, title, (body.get("body") or "")[:65536])
            return self._json({"ok": ok, **info})
        if path == "/local/projects/create":
            return self._create_project(chat, body)
        if path == "/local/weather/city":
            return self._json(weather.set_location((body.get("city") or "")[:120]))
        if path == "/local/weather/unit":
            return self._json(weather.set_unit((body.get("unit") or "")[:20]))
        return self._json({"error": "not found"}, 404)

    def _worktree(self, body):
        """Create (or reuse) a git worktree for a branch and return its path so the
        client can start a session in it. `create` makes a new branch from `parent`;
        otherwise an existing branch is checked out into the worktree."""
        project = (body.get("project") or "").strip()
        abs_p = _abs_project(project)
        if abs_p is None:
            return self._json({"error": "invalid project"}, 400)
        branch = (body.get("branch") or "").strip()
        if not branch or branch in (".", ".."):
            return self._json({"error": "invalid branch"}, 400)
        wt = _worktree_path(project, branch)
        rel = browser.rel(wt)
        if os.path.isdir(wt):                      # already opened — reuse it
            return self._json({"ok": True, "path": wt, "rel": rel, "branch": branch,
                               "output": "worktree exists"})
        os.makedirs(os.path.dirname(wt), exist_ok=True)
        parent = (body.get("parent") or git.current_branch(abs_p) or "main").strip()
        create = body.get("create", True)
        ok, output = git.worktree_add(abs_p, wt, branch, parent, create=bool(create))
        if not ok:
            return self._json({"ok": False, "output": output})
        return self._json({"ok": True, "path": wt, "rel": rel, "branch": branch,
                           "output": output})

    def _create_project(self, chat, body):
        """Scaffold a new git repo under BASE_PATH and start a session on it with
        the user's first instruction streaming in immediately."""
        name = _slug((body.get("name") or "").strip().lower())
        prompt = (body.get("prompt") or "").strip()
        if not name or name.startswith("."):
            return self._json({"error": "invalid name"}, 400)
        dest = os.path.realpath(os.path.join(config.BASE_PATH, name))
        if not browser.within_base(dest):
            return self._json({"error": "invalid name"}, 400)
        if os.path.exists(dest):
            return self._json({"error": "already exists"}, 409)
        try:
            os.makedirs(dest)
        except OSError as e:
            return self._json({"error": str(e)}, 500)
        git._run(dest, "init")
        git._run(dest, "commit", "--allow-empty", "-m", "init")
        rel = browser.rel(dest)
        s = store.create_session(chat, rel, origin="dashboard", cwd=dest,
                                 permission_mode=config.NEW_SESSION_PERMISSION_MODE)
        job_id = None
        if prompt:
            job = runner.start_streaming_job(chat, prompt, [], dest,
                                             session_id=s["id"], origin="dashboard")
            job_id = job.id if job else None
        return self._json({"project": {"rel": rel, "name": name},
                           "session": _session_brief(store.get_session(s["id"])),
                           "job_id": job_id})

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
        permission_mode = normalize_permission_mode(body.get("permission_mode"))
        session_id = (body.get("session_id") or "").strip() or None
        job_id = uuid.uuid4().hex
        try:
            paths = _save_images(job_id, images) if images else []
        except ValueError as e:
            runner._cleanup_uploads(job_id)
            return self._json({"error": str(e)}, 413)
        job = runner.start_streaming_job(chat, prompt, paths, project_path, job_id=job_id,
                                         model=model, effort=effort,
                                         permission_mode=permission_mode,
                                         session_id=session_id, origin="dashboard")
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
            # Run in the project the caller names (the Design/Run tab's project),
            # falling back to the chat's active project. Without this, the cwd is
            # whatever is globally active — unset → BASE_PATH, which breaks install.
            cwd = _abs_project(body.get("project")) or state.project_dir(chat)
            cmd = ((body.get("cmd") or "").strip()
                   or project_config.run_cmd(browser.rel(cwd))
                   or config.START_CMD)
            msg = devserver.start_server(cmd, cwd)
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

    def _api_preview_screenshot(self, body: dict):
        url = tunnel.tunnel_state().get("url")
        if not url:
            return self._json({"error": "preview not running"}, 409)
        try:
            width = int(body.get("width") or 375)
        except (TypeError, ValueError):
            width = 375
        try:
            png = screenshot.capture(url, width)
        except Exception as e:  # noqa: BLE001
            return self._json({"error": f"{type(e).__name__}: {e}"}, 500)
        data_url = "data:image/png;base64," + base64.b64encode(png).decode()
        return self._json({"data_url": data_url})

    def _select(self, chat, body):
        d = (body.get("dir") or "").strip()
        cand = os.path.realpath(os.path.join(config.BASE_PATH, d.lstrip("/")))
        if not browser.within_base(cand) or not os.path.isdir(cand):
            return self._json({"error": "invalid dir"}, 400)
        state.active[chat] = cand
        self._json({"project": {"rel": browser.rel(cand), "name": os.path.basename(cand)}})

    # --- terminal websocket (Host + Origin + ?token= gated) ---
    def _terminal_ws(self, qs):
        """Upgrade to a websocket bound to terminal `id` and pump it bidirectionally.
        Client->server frames are binary with a 1-byte channel prefix: 0x00 = stdin,
        0x01 = UTF-8 JSON control ({type:"resize",cols,rows}). Server->client frames
        are binary PTY output."""
        if self.headers.get("Upgrade", "").lower() != "websocket":
            return self._json({"error": "expected websocket"}, 400)
        if not _ws_authorized(self.headers.get("Host", ""),
                              self.headers.get("Origin", ""),
                              qs.get("token", [""])[0]):
            return self._json({"error": "unauthorized"}, 401)
        tid = qs.get("id", [""])[0]
        if not any(t["id"] == tid for t in terminals.info(None)):
            return self._json({"error": "no such terminal"}, 404)
        key = self.headers.get("Sec-WebSocket-Key", "")
        if not key:
            return self._json({"error": "missing key"}, 400)

        self.close_connection = True
        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", wsutil.accept_key(key))
        self.end_headers()
        try:
            self.wfile.flush()
        except OSError:
            return

        send_lock = threading.Lock()

        def _send(data: bytes, opcode: int = wsutil.OP_BINARY) -> bool:
            with send_lock:
                try:
                    self.wfile.write(wsutil.encode_frame(data, opcode))
                    self.wfile.flush()
                    return True
                except OSError:
                    return False

        closed = threading.Event()

        def _on_close():            # PTY ended: notify the client + unblock recv
            _send(b"", wsutil.OP_CLOSE)
            closed.set()
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

        sub = terminals.attach(tid, lambda b: _send(b, wsutil.OP_BINARY), _on_close)
        if sub is None:
            return
        try:
            while not closed.is_set():
                frame = wsutil.decode_frame(self.rfile)
                if frame is None:
                    break
                op, payload = frame
                if op == wsutil.OP_CLOSE:
                    break
                if op == wsutil.OP_PING:
                    _send(payload, wsutil.OP_PONG)
                    continue
                if not payload:
                    continue
                channel, body = payload[0], payload[1:]
                if channel == 0x00:
                    terminals.write(tid, body)
                elif channel == 0x01:
                    try:
                        msg = json.loads(body.decode("utf-8", "replace"))
                        if msg.get("type") == "resize":
                            terminals.resize(tid, int(msg["cols"]), int(msg["rows"]))
                    except (ValueError, KeyError, TypeError):
                        pass
        finally:
            terminals.detach(tid, sub)

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
