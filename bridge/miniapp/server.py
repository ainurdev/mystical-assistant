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
                    hooks, httpgz, models, native, project_config, relevance,
                    runner, state, store, transcript_jsonl, transcript_page,
                    usage)

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


AUTOCOMPACT_MIN, AUTOCOMPACT_MAX = 100_000, 1_000_000


def normalize_autocompact(value) -> "tuple[bool, str | None]":
    """Validate a session's auto-compact window: "auto", a token count inside the
    100k–1M range `claude --autocompact` accepts, or None to pass no flag at all.

    Returns (ok, value). A bad value is rejected rather than coerced — a typo that
    silently moved the compaction point would be invisible until a session
    compacted at the wrong time. Counts are normalized to digits so the CLI never
    has to parse "150k"."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return True, None
    v = str(value).strip().lower()
    if v == "auto":
        return True, "auto"
    if v.endswith("k") and v[:-1].isdigit():
        v = str(int(v[:-1]) * 1000)
    if not v.isdigit() or not AUTOCOMPACT_MIN <= int(v) <= AUTOCOMPACT_MAX:
        return False, None
    return True, str(int(v))


def _session_brief(s: dict) -> dict:
    cwd = s.get("cwd")
    # The branch the session is *working* on: the worktree its shell moved into
    # (runner._note_work_cwd) before its own checkout. A recorded worktree that
    # has since been removed reports no branch, so the checkout answers instead —
    # and work_cwd goes out as None, so nothing labels a branch as a worktree it
    # can no longer see.
    wt = s.get("work_cwd") or ""
    wt_branch = git.current_branch_cached(wt) if wt else ""
    # …and which tree that branch is checked out in, when it isn't the project's
    # own checkout. A session created onto a worktree has that path as its cwd —
    # work_cwd only catches a shell that *moved* — so the name comes from the
    # working path either way.
    work = wt if wt_branch else (cwd or "")
    return {"id": s["id"], "title": s["title"], "project": s["project"],
            "updated": s["updated"], "archived": s["archived"],
            "origin": s.get("origin"), "cwd": cwd,
            "fallback_policy": s.get("fallback_policy"),
            "ctx_tokens": s.get("ctx_tokens"),
            "ctx_window": config.CONTEXT_WINDOW,
            "autocompact": s.get("autocompact"),
            "disabled_tools": store.parse_disabled_tools(s.get("disabled_tools")),
            "goal": store.parse_goal(s.get("goal")),
            "lifecycle": s.get("lifecycle"),
            "work_cwd": wt if wt_branch else None,
            "worktree": git.worktree_name(work),
            "branch": wt_branch or (git.current_branch_cached(cwd) if cwd else "")}


def _pre_title(s: dict, title) -> dict:
    """Name a freshly created, still-empty session (the relevance guardrail routes
    a split-off task into one pre-titled). Marks it manual so the auto-titler
    won't overwrite the name after the first turn."""
    title = " ".join(str(title or "").split())[:60]
    if not title:
        return s
    store.rename(s["id"], title)
    return store.get_session(s["id"])


def _qs_int(qs: dict, name: str) -> int | None:
    """Optional int query param; absent or malformed -> None."""
    try:
        v = qs.get(name, [None])[0]
        return int(v) if v is not None else None
    except (ValueError, TypeError):
        return None


def transcript_for(session: dict, cursor: int = 0,
                   tail: int | None = None, before: int | None = None) -> dict:
    """Unified transcript loader. A session that still lives only as native JSONL
    (started in VSCode and not yet continued through the bridge) renders from that
    JSONL on demand; everything else renders from the store. Same shape either way.
    `tail`/`before` window the events to the last N event-bearing turns
    (transcript_page.tail_slice) — turns and next_cursor always ship whole, so
    forward polling is unaffected. Without `tail` the shape is unchanged."""
    def page(d: dict) -> dict:
        d = transcript_page.tail_slice(d, tail, before) if tail is not None else d
        # A turn that has spawned but not yet spoken shows an empty stream, which
        # reads as a hang. Say what it is waiting on — live, so it disappears on
        # the first token rather than being journaled into the transcript.
        boot = runner.boot_phase(session["id"])
        return {**d, "boot": boot} if boot else d
    if session.get("origin") in ("vscode", "terminal"):
        path = transcript_jsonl.find_transcript(session.get("claude_session_id"))
        data = (transcript_jsonl.parse_jsonl(path, cursor) if path
                else {"turns": [], "events": [], "next_cursor": cursor})
        return page({"session": session, **data})
    data = store.transcript(session["id"], cursor)
    # Fallback: a bridge row whose conversation actually lives in the native JSONL
    # (shares a claude_session_id but was never journaled) -> render from JSONL.
    if not data["turns"] and session.get("claude_session_id"):
        path = transcript_jsonl.find_transcript(session["claude_session_id"])
        if path:
            jdata = transcript_jsonl.parse_jsonl(path, cursor)
            if jdata["turns"]:
                return page({"session": session, **jdata})
    return page(data)


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
        raw, zipped = httpgz.maybe_gzip(
            json.dumps(obj).encode(), self.headers.get("Accept-Encoding", ""))
        if not zipped:
            return self._send_bytes(raw, code, "application/json")
        # Inlined _send_bytes plus the one extra header (it has no header hook).
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
            raw = self.rfile.read(length) if length else b"{}"
            return json.loads(raw or b"{}")
        except (ValueError, json.JSONDecodeError):
            return None

    def _auth(self) -> int | None:
        return validate_init_data(self.headers.get("X-Telegram-Init-Data", ""))

    def _hook(self, token: str):
        """Receive one inbound event.

        404 covers every reason we won't accept it, so a probe cannot tell an
        unknown token from a correct one that failed its signature. A genuine
        crash answers 500 instead: telling a sender "wrong token" when the fault
        was ours sends whoever configured it to debug the wrong end.
        """
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
        except ValueError:
            return self._json({"error": "not found"}, 404)
        if length > hooks.MAX_BODY:
            return self._json({"error": "too large"}, 413)
        raw = self.rfile.read(length) if length else b""
        try:
            ev = hooks.receive(unquote(token), raw, self.headers)
        except Exception:
            return self._json({"error": "error"}, 500)
        if ev is None:
            return self._json({"error": "not found"}, 404)
        return self._json({"ok": True, "id": ev["id"]})

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
                if path == "/api/queue":
                    return self._api_queue_get(chat_id)
                if path == "/api/commands":
                    return self._api_commands(chat_id)
                if path == "/api/nextup":
                    from bridge import nextup
                    return self._json(nextup.board(chat_id))
                if path == "/api/goal":
                    return self._api_goal(chat_id, qs)
                if path == "/api/files":
                    return self._json(
                        {"files": git.list_tree(state.project_dir(chat_id))})
                if path == "/api/files/read":
                    return self._json(git.read_file(state.project_dir(chat_id),
                                                    qs.get("path", [""])[0]))
                if path == "/api/attachment":
                    return self._api_attachment(qs.get("path", [""])[0])
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
            # Inbound hooks answer above the initData gate: a webhook sender
            # cannot produce one, so the token in the path is the credential
            # instead. See bridge/hooks.py for what that does and doesn't buy.
            if path.startswith("/hook/"):
                return self._hook(path[len("/hook/"):])
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
            # "No" to a closing question: nothing to run, just stop the row asking.
            if path.startswith("/api/sessions/") and path.endswith("/dismiss-ask"):
                return self._json({"ok": runner.dismiss_ask(
                    path[len("/api/sessions/"):-len("/dismiss-ask")])})
            if path.startswith("/api/sessions/") and path.endswith("/policy"):
                return self._api_session_policy(
                    chat_id, path[len("/api/sessions/"):-len("/policy")], body)
            if path.startswith("/api/sessions/") and path.endswith("/autocompact"):
                return self._api_session_autocompact(
                    chat_id, path[len("/api/sessions/"):-len("/autocompact")], body)
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
            if path == "/api/files/write":
                return self._api_file_write(chat_id, body)
            if path == "/api/queue":
                return self._api_queue_post(chat_id, body)
            if path == "/api/nextup/refresh":
                from bridge import nextup
                threading.Thread(target=nextup.refresh, args=(chat_id,),
                                 daemon=True).start()
                return self._json(nextup.board(chat_id))
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
        # An explicit cwd wins over the project dir, so a session split off from a
        # worktree session runs on that worktree's branch instead of landing in the
        # main checkout (mirrors the dashboard's /local/sessions).
        cand = [os.path.realpath(p) for p in
                ((body.get("cwd") or "").strip(),
                 os.path.join(config.BASE_PATH, project.lstrip("/"))) if p]
        cwd = next((p for p in cand if browser.within_base(p) and os.path.isdir(p)),
                   state.project_dir(chat_id))
        s = store.create_session(chat_id, project, origin="miniapp", cwd=cwd,
                                 permission_mode=config.NEW_SESSION_PERMISSION_MODE)
        self._json({"session": _session_brief(_pre_title(s, body.get("title")))})

    def _api_session_get(self, chat_id: int, rest: str, qs):
        sid = rest.split("/")[0]
        s = store.get_session(sid)
        if not s or s["chat_id"] != chat_id:
            return self._json({"error": "not found"}, 404)
        if rest.endswith("/breakdown"):
            from bridge import attribution
            return self._json(attribution.breakdown(sid))
        try:
            cursor = int(qs.get("cursor", ["0"])[0])
        except ValueError:
            cursor = 0
        self._json(transcript_for(s, cursor,
                                  tail=_qs_int(qs, "tail"), before=_qs_int(qs, "before")))

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

    def _api_session_autocompact(self, chat_id: int, sid: str, body: dict):
        """Set the window size at which this session auto-compacts; null leaves
        claude's own default. Takes effect on the next turn."""
        s = store.get_session(sid)
        if not s or s["chat_id"] != chat_id:
            return self._json({"error": "not found"}, 404)
        ok, value = normalize_autocompact(body.get("autocompact"))
        if not ok:
            return self._json({"error": "autocompact must be 'auto' or 100000-1000000"}, 400)
        store.set_autocompact(sid, value)
        self._json({"ok": True, "autocompact": value})

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

    def _api_file_write(self, chat_id: int, body: dict):
        """Save an edit from the Mini App's file view. git.write_file rejects
        anything outside the project, so a crafted path can't escape it."""
        content = body.get("content")
        if not isinstance(content, str):
            return self._json({"error": "content must be a string"}, 400)
        ok, res = git.write_file(state.project_dir(chat_id),
                                 str(body.get("path") or ""), content)
        self._json({"ok": ok, "path": res} if ok else {"error": res}, 200 if ok else 400)

    # --- queue / next up / goal (the WORK tab + the chat's goal pill) --------
    def _owned_session(self, chat_id: int, sid: str):
        s = store.get_session(sid) if sid else None
        return s if s and s["chat_id"] == chat_id else None

    def _api_attachment(self, p: str):
        """Serve one screenshot a tool handed back, so the phone shows the image
        instead of nothing (the dashboard has served these from /local/attachment
        for a while). Confined to UPLOAD_DIR — the only paths _save_result_images
        writes — so nothing else on disk is readable through it. A run deletes its
        uploads when it ends, so a miss is normal and the card just drops the
        image."""
        up = os.path.realpath(config.UPLOAD_DIR)
        fp = os.path.realpath(p or "")
        ctype = mimetypes.guess_type(fp)[0] or ""
        if (not fp.startswith(up + os.sep) or not os.path.isfile(fp)
                or not ctype.startswith("image/")):
            return self._json({"error": "not found"}, 404)
        with open(fp, "rb") as f:
            self._send_bytes(f.read(), 200, ctype, cache="private, max-age=300")

    def _api_commands(self, chat_id: int):
        """What `/` offers in the composer, for the chat's active project."""
        from bridge import commands
        self._json({"commands": commands.available(state.project_dir(chat_id))})

    def _api_queue_get(self, chat_id: int):
        """Every queue of this chat that still holds something. The phone's WORK
        tab lists prompts across chats, so it asks for all of them at once."""
        from bridge import queue_manager
        out = []
        for sid in queue_manager.sessions():
            s = self._owned_session(chat_id, sid)
            if not s:
                continue
            snap = queue_manager.snapshot(sid)
            out.append({**snap, "title": s.get("title"), "project": s.get("project")})
        self._json({"queues": out})

    def _api_queue_post(self, chat_id: int, body: dict):
        from bridge import queue_manager
        op = (body.get("op") or "").strip()
        sid = (body.get("session_id") or "").strip()
        s = self._owned_session(chat_id, sid)
        if not s:
            return self._json({"error": "not found"}, 404)
        if op == "enqueue":
            prompt = (body.get("prompt") or body.get("text") or "").strip()
            if not prompt:
                return self._json({"error": "empty prompt"}, 400)
            ok, model, effort = normalize_model_effort(body.get("model"), body.get("effort"))
            if not ok:
                return self._json({"error": "invalid model"}, 400)
            images = body.get("images") or []
            if not isinstance(images, list) or len(images) > config.UPLOAD_MAX_COUNT:
                return self._json({"error": f"too many images (max {config.UPLOAD_MAX_COUNT})"}, 413)
            project = os.path.realpath(
                os.path.join(config.BASE_PATH, str(s.get("project") or "").lstrip("/")))
            run_job_id = uuid.uuid4().hex
            try:
                paths = _save_images(run_job_id, images) if images else []
            except ValueError as e:
                runner._cleanup_uploads(run_job_id)
                return self._json({"error": str(e)}, 413)
            queue_manager.enqueue(
                sid, text=prompt, prompt=prompt, images=paths, model=model, effort=effort,
                permission_mode=normalize_permission_mode(body.get("permission_mode")),
                width=0, sel=[], surface="miniapp", chat_id=chat_id,
                project=project if browser.within_base(project) else None,
                run_job_id=run_job_id)
        elif op in ("pause", "resume", "clear_done"):
            getattr(queue_manager, op)(sid)
        elif op in ("remove", "bump", "cancel", "retry"):
            item_id = (body.get("item_id") or "").strip()
            if not item_id:
                return self._json({"error": "item required"}, 400)
            getattr(queue_manager, op)(sid, item_id)
        else:
            return self._json({"error": "unknown queue op"}, 404)
        self._json(queue_manager.snapshot(sid))

    def _api_goal(self, chat_id: int, qs):
        """The session's objective, for the chat header's goal pill (read-only:
        the model owns the verdict — see goals.py)."""
        from bridge import goals
        s = self._owned_session(chat_id, qs.get("session", [""])[0])
        if not s:
            return self._json({"error": "not found"}, 404)
        self._json({"goal": goals.get(s["id"]), "max_iter": goals.MAX_ITER})

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
