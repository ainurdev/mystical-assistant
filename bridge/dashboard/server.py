"""Localhost-only desktop dashboard: a full-parity Claude client + live log
streaming over the SAME store/runner/devserver as the Mini App.

SECURITY (critical): bound to 127.0.0.1 and never exposed publicly — the only
tunnel this bridge runs fronts the Mini App, never DASH_PORT. Any web page the
user visits can reach 127.0.0.1:DASH_PORT, so:
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
import shutil
import socket
import subprocess
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.parse import parse_qs, quote, urlparse

import re

from bridge import (agents, attribution, browser, config, devserver, flow, fmt, git,
                    github, graphmap, httpgz,
                    models, native, preview_detect, project_config,
                    pubsub, queue_manager, relevance, report, runner, selfupdate,
                    share,
                    shell, skills, state, store, sysinfo, terminals, titler, usage,
                    weather, wsutil)
from bridge.miniapp.server import (_pre_title, _qs_int, _resolve_stype, _retype_action,
                                   _save_images,
                                   _session_brief, _stage_action,
                                   normalize_model_effort, normalize_permission_mode,
                                   transcript_for)

WEB_DIR = os.path.join(os.path.dirname(__file__), "web", "dist")
_HOSTS = {f"127.0.0.1:{config.DASH_PORT}", f"localhost:{config.DASH_PORT}",
          f"[::1]:{config.DASH_PORT}"}
_ORIGINS = {f"http://{h}" for h in _HOSTS}


def _tok_ok(tok: str) -> bool:
    if not config.DASH_TOKEN:          # gate disabled via DASH_TOKEN="" (see config)
        return True
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


def _abs_within(path: str) -> str | None:
    """Resolve an absolute path that must live under BASE_PATH (e.g. a session's
    worktree cwd). Returns the realpath, or None if it escapes the workspace."""
    if not path:
        return None
    cand = os.path.realpath(path)
    return cand if browser.within_base(cand) and os.path.isdir(cand) else None


def _server_cwd(chat, body) -> str:
    """The run directory a dev-server request targets: an absolute
    worktree cwd if given, else a project rel, else the chat's active project.
    Mirrors the worktree resolution used by /local/sessions."""
    return (_abs_within((body.get("cwd") or "").strip())
            or _abs_project(body.get("cwd_rel") or body.get("project"))
            or state.project_dir(chat))


# Managed git worktrees live under a hidden dir at the workspace root, so the
# project browser (which skips dotdirs) never surfaces them as projects.
_WT_ROOT = os.path.join(config.BASE_PATH, ".worktrees")
_SLUG_RE = re.compile(r"[^A-Za-z0-9._-]+")


def _slug(s: str) -> str:
    return _SLUG_RE.sub("-", (s or "").strip().strip("/")).strip("-") or "wt"


def _worktree_path(project_rel: str, branch: str) -> str:
    repo = _slug(os.path.basename((project_rel or "").rstrip("/")) or "repo")
    return os.path.join(_WT_ROOT, repo, _slug(branch))


def _worktree_for_branch(abs_p: str, branch: str) -> "str | None":
    """The worktree git already has checked out on `branch`, wherever it lives, or
    None. Git is the source of truth here, not our naming convention: a branch can
    be checked out in exactly one tree, and that tree may be Claude Code's native
    `<repo>/.claude/worktrees/<slug>`, a hand-made `git worktree add`, or the
    project checkout itself. Paths outside BASE_PATH are ignored — we can't hand
    those to a session — which leaves git to report the collision."""
    if not branch:
        return None
    for w in git.worktrees(abs_p):
        if w.get("branch") == branch:
            return _abs_within(w.get("path") or "")
    return None


def _free_agents() -> dict:
    """Every free-agent rung and what it still needs, for the Accounts tab. The
    unconfigured ones are listed too: the tab is where you set them up, so it
    has to show the rungs you don't have yet."""
    try:
        from bridge import freeagent
        return freeagent.status()
    except Exception:  # noqa: BLE001
        return {"installed": False, "providers": []}


def _worktree_cwd(project, branch) -> "str | None":
    """The working-tree dir to operate on for a project+branch: the branch's linked
    worktree when one exists on disk, else the project checkout. None if the project
    is invalid. Lets status/diff/commit target the right tree per selected branch."""
    abs_p = _abs_project(project)
    if abs_p is None:
        return None
    b = (branch or "").strip()
    if b:
        wt = _worktree_for_branch(abs_p, b)          # git first
        if wt is not None:
            return wt
        # Only then the naming convention, and only if the dir agrees it's on that
        # branch: a session can `git checkout` a managed worktree onto another one.
        wt = _abs_within(_worktree_path(str(project), b))
        if wt is not None and git.current_branch_cached(wt) in (b, ""):
            return wt
    return abs_p


# Headless one-shot prompt for "generate commit message" (mirrors preview_detect).
# Tagged so its throwaway session is kept out of the unified list (native.scan).
_COMMIT_MSG_PROMPT = (
    native.INTERNAL_ONESHOT_TAG + "\n"
    "Write a single git commit message for the staged changes below. Use the "
    "Conventional Commits format — `type(scope): summary`, with an imperative "
    "summary under 72 chars; add a short body only if it conveys real information. "
    "Respond with ONLY the commit message: no markdown, no code fences, no "
    "preamble.\n\nDIFF:\n"
)


def _plain_commit_message(paths: "list[str]") -> str:
    """What SHIP commits with when generated messages are switched off: the files
    that moved, not a guess at why."""
    names = [p.split("/")[-1] for p in paths]
    head = ", ".join(names[:3])
    rest = len(names) - 3
    return f"update {head}{f' and {rest} more' if rest > 0 else ''}" if names else "update"


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
        raw, zipped = httpgz.maybe_gzip(
            json.dumps(obj).encode(), self.headers.get("Accept-Encoding", ""))
        if not zipped:
            return self._send(raw, code, "application/json")
        # Inlined _send plus the one extra header (_send has no header hook).
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
            n = int(self.headers.get("Content-Length", 0) or 0)
            return json.loads(self.rfile.read(n) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return None

    def _host_ok(self) -> bool:
        return self.headers.get("Host", "") in _HOSTS

    # --- routing ---
    def do_GET(self):
        try:
            u = urlparse(self.path)
            path, qs = u.path, parse_qs(u.query)
            # Before the Host gate on purpose: a share link has to open on a
            # phone, which is never `localhost`. The unguessable token in the
            # path is the authorisation, and the page it returns is one
            # session's transcript, read-only, with no API behind it. Every
            # other route stays loopback-only. (See bridge/share.py.)
            if path.startswith("/share/"):
                return self._share(path[len("/share/"):])
            if not self._host_ok():
                return self._json({"error": "bad host"}, 403)
            if path == "/local/ws/terminal":
                return self._terminal_ws(qs)
            if path.startswith("/local/stream/"):
                return self._stream(path[len("/local/stream/"):], qs)
            if path.startswith("/local/"):
                return self._get_api(path, qs)
            if path == "/manifest.webmanifest":
                return self._manifest()
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
                "server": devserver.server_state(),
                "servers": devserver.list_servers(),
                "dev_port": config.PREVIEW_PORT,
                "permission_mode": config.MINIAPP_PERMISSION_MODE,
                "models": models.get_models()})
        if path == "/local/projects":
            relp = (qs.get("dir", [""])[0] or "").strip()
            cur = config.BASE_PATH if relp in ("", "/") else os.path.realpath(
                os.path.join(config.BASE_PATH, relp.lstrip("/")))
            if not browser.within_base(cur) or not os.path.isdir(cur):
                cur = config.BASE_PATH
            real = os.path.realpath(cur)
            return self._json({"rel": browser.rel(cur), "at_base": real == config.BASE_PATH,
                               "can_up": real != config.BASE_PATH,
                               "dirs": browser.list_dirs(cur),
                               "projects": browser.list_projects(),
                               "hidden": project_config.hidden_projects()})
        if path == "/local/history":
            native.refresh(chat)           # surface VSCode sessions in the history view
            archived = qs.get("archived", ["0"])[0] == "1"
            return self._json({"sessions": store.history(chat, include_archived=archived)})
        if path == "/local/running":
            return self._json(runner.running_snapshot(chat))
        if path == "/local/queue":
            sid = (qs.get("session", [""])[0] or "").strip()
            return self._json(queue_manager.snapshot(sid) if sid else
                              {"session_id": "", "seq": 0, "paused": False, "items": []})
        if path == "/local/usage":
            return self._json(usage.get_usage())
        if path == "/local/today":
            # Local midnight, not "24h ago" — the header chip reads "TODAY".
            import datetime
            midnight = datetime.datetime.now().replace(
                hour=0, minute=0, second=0, microsecond=0).timestamp()
            return self._json(store.today(chat, midnight))
        if path == "/local/flows":
            flows = flow.load_flows()
            cat = flow.catalog()
            # The editor needs the templates themselves, which the catalog
            # deliberately withholds (a picker wants shape, not prompts).
            cat["full"] = {st: {k: v for k, v in f.items() if k != "_custom"}
                           for st, f in flows.items()}
            cat["all"] = [{"stype": st, "label": f.get("label", st.upper()),
                           "source": "custom" if f.get("_custom") else "builtin",
                           "disabled": bool(f.get("disabled"))}
                          for st, f in sorted(flows.items())]
            return self._json(cat)
        if path == "/local/report":
            # back=1 → the completed week (what the Monday push covers).
            return self._json(report.weekly(chat, back=_qs_int(qs, "back") or 0))
        if path == "/local/accounts":
            from bridge import accounts, ladder
            return self._json({
                "accounts": [{**a, "left": accounts.headroom(a["slot"])}
                             for a in accounts.list_accounts()],
                "default_policy": ladder.default_policy(),
                "pending_login": accounts.pending_login(),
                "free_agents": _free_agents()})
        if path == "/local/aifeatures":
            from bridge import aifeatures
            return self._json({"features": aifeatures.state()})
        if path == "/local/envsettings":
            from bridge import envsettings
            return self._json({"settings": envsettings.state()})
        if path == "/local/agentconfig":
            from bridge import agentconfig
            return self._json(agentconfig.state())
        if path == "/local/startup":
            from bridge import startup
            return self._json(startup.state())
        if path == "/local/next":
            from bridge import nextup
            return self._json(nextup.board(chat))
        if path == "/local/sessions":
            native.refresh(chat)           # surface VSCode sessions started since last poll
            project = qs.get("project", [None])[0]
            rows = (store.list_sessions(chat, project) if project is not None
                    else store.list_sessions_all(chat))
            # Sessions of a since-deleted dir (e.g. a removed worktree checkout)
            # stay out of the lists; their transcripts remain viewable by id.
            rows = [r for r in rows if browser.project_exists(r["project"])]
            return self._json({"sessions": [_session_brief(s) for s in rows]})
        # Before the transcript route below, which would otherwise swallow this
        # (it takes the first path segment and ignores the rest).
        if path.startswith("/local/sessions/") and path.endswith("/breakdown"):
            sid = path[len("/local/sessions/"):-len("/breakdown")]
            s = store.get_session(sid)
            if not s or s["chat_id"] != chat:
                return self._json({"error": "not found"}, 404)
            return self._json(attribution.breakdown(sid))
        if path.startswith("/local/sessions/"):
            sid = path[len("/local/sessions/"):].split("/")[0]
            s = store.get_session(sid)
            if not s or s["chat_id"] != chat:
                return self._json({"error": "not found"}, 404)
            try:
                cursor = int(qs.get("cursor", ["0"])[0])
            except ValueError:
                cursor = 0
            return self._json(transcript_for(s, cursor,
                                             tail=_qs_int(qs, "tail"),
                                             before=_qs_int(qs, "before")))
        if path == "/local/attachment":
            return self._attachment(qs.get("path", [""])[0])
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
            cwd = _worktree_cwd(qs.get("project", [None])[0],
                                (qs.get("branch", [""])[0] or "").strip())
            if cwd is None:
                return self._json({"error": "invalid project"}, 400)
            return self._json(git.status(cwd))
        if path == "/local/git/log":
            cwd = _worktree_cwd(qs.get("project", [None])[0],
                                (qs.get("branch", [""])[0] or "").strip())
            if cwd is None:
                return self._json({"error": "invalid project"}, 400)
            try:
                limit = int(qs.get("limit", ["200"])[0])
            except ValueError:
                limit = 200
            return self._json({"commits": git.log_graph(cwd, limit)})
        if path == "/local/git/show":
            # One commit from the graph: its changed files, or one file's diff.
            cwd = _worktree_cwd(qs.get("project", [None])[0],
                                (qs.get("branch", [""])[0] or "").strip())
            if cwd is None:
                return self._json({"error": "invalid project"}, 400)
            sha = (qs.get("sha", [""])[0] or "").strip()
            fpath = qs.get("path", [""])[0]
            if fpath:
                return self._json({"path": fpath, "diff": git.show_file(cwd, sha, fpath)})
            return self._json(git.commit_files(cwd, sha))
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
            project = qs.get("project", [None])[0]
            abs_p = _abs_project(project)
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
            # working-tree diff: target the selected branch's worktree
            cwd = _worktree_cwd(project, (qs.get("branch", [""])[0] or "").strip())
            return self._json({"path": fpath, "diff": git.diff(cwd, fpath)})
        if path == "/local/files/tree":
            # EDITOR tab: the whole working tree of the selected branch/worktree
            cwd = _worktree_cwd(qs.get("project", [None])[0],
                                (qs.get("branch", [""])[0] or "").strip())
            if cwd is None:
                return self._json({"error": "invalid project"}, 400)
            return self._json({"files": git.list_tree(cwd),
                               "ignored": git.ignored_paths(cwd)})
        if path == "/local/files/read":
            cwd = _worktree_cwd(qs.get("project", [None])[0],
                                (qs.get("branch", [""])[0] or "").strip())
            if cwd is None:
                return self._json({"error": "invalid project"}, 400)
            rel = qs.get("path", [""])[0]
            out = git.read_file(cwd, rel)
            if out.get("ok"):
                # Indent rules ride along with the content so the editor can
                # configure the buffer without a second round trip.
                out.update(fmt.indent_for(cwd, out.get("path") or rel))
                out["formatter"] = fmt.formatters_for(cwd, rel)[0] is not None
            return self._json(out)
        if path == "/local/files/grep":
            # EDITOR search-in-files (the palette's `#` mode)
            cwd = _worktree_cwd(qs.get("project", [None])[0],
                                (qs.get("branch", [""])[0] or "").strip())
            if cwd is None:
                return self._json({"error": "invalid project"}, 400)
            return self._json({"hits": git.grep(cwd, (qs.get("q", [""])[0] or "")[:200])})
        if path == "/local/github/issues":
            abs_p = _abs_project(qs.get("project", [None])[0])
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            return self._json(github.issues(abs_p))
        if path == "/local/project/settings":
            abs_p = (_abs_within((qs.get("cwd", [""])[0] or "").strip())
                     or _abs_project(qs.get("cwd_rel", [None])[0] or qs.get("project", [None])[0])
                     or state.project_dir(chat))
            rel = browser.rel(abs_p)
            branch = (qs.get("branch", [""])[0] or "").strip() or None
            return self._json({
                "scripts": project_config.package_scripts(abs_p),
                "run_cmd": project_config.run_cmd(rel, branch),
                "prod_url": project_config.prod_url(rel, branch),
                "design_project": project_config.design_project(rel, branch),
                "default_cmd": config.START_CMD,
                "log_path": devserver.DEV_LOG_REL,
            })
        if path == "/local/design/prompt":
            from bridge import aifeatures, designsync
            if not aifeatures.enabled("design"):
                return self._json({"error": "design system switch is off"}, 400)
            abs_p = (_abs_within((qs.get("cwd", [""])[0] or "").strip())
                     or _abs_project(qs.get("cwd_rel", [None])[0]
                                     or qs.get("project", [None])[0])
                     or state.project_dir(chat))
            rel = browser.rel(abs_p)
            branch = (qs.get("branch", [""])[0] or "").strip() or None
            kind = (qs.get("kind", [""])[0] or "").strip()
            if kind == "link":
                return self._json({"prompt": designsync.link_prompt(rel)})
            pid = project_config.design_project(rel, branch)
            if not pid:
                return self._json({"error": "no design project linked"}, 400)
            if kind == "pull":
                name = (qs.get("name", [""])[0] or "").strip()
                return self._json({"prompt": designsync.pull_prompt(
                    pid, rel, designsync.slug(name))})
            if kind == "push":
                return self._json({"prompt": designsync.push_prompt(pid, rel)})
            return self._json({"error": "unknown kind"}, 400)
        if path == "/local/shell":
            try:
                cursor = int(qs.get("cursor", ["0"])[0])
            except ValueError:
                cursor = 0
            return self._json(shell.snapshot(cursor))
        if path == "/local/terminals":
            return self._json({"terminals": terminals.info(qs.get("project", [None])[0])})
        if path == "/local/servers":
            return self._json({"servers": devserver.list_servers()})
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
            # Branch names, not per-worktree flags: the WORKTREES tab lists
            # branches without a worktree too, and marks both from one set.
            return self._json({"worktrees": wts, "merged": git.merged_branches(abs_p)})
        if path == "/local/git/since":
            # Drift since a checkpoint's commit (turns.sha).
            cwd = _worktree_cwd(qs.get("project", [None])[0],
                                (qs.get("branch", [""])[0] or "").strip())
            if cwd is None:
                return self._json({"error": "invalid project"}, 400)
            return self._json(git.since(cwd, (qs.get("sha", [""])[0] or "").strip()))
        if path == "/local/git/compare":
            abs_p = _abs_project(qs.get("project", [None])[0])
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            base = (qs.get("base", ["main"])[0] or "main").strip()
            head = (qs.get("head", [""])[0] or git.current_branch(abs_p)).strip()
            three_dot = (qs.get("dots", ["3"])[0] or "3").strip() != "2"
            return self._json(git.compare(abs_p, base, head, three_dot))
        if path == "/local/agents":
            sid = qs.get("session", [""])[0]
            s = store.get_session(sid) if sid else None
            if not s or s["chat_id"] != chat:
                return self._json({"error": "not found"}, 404)
            return self._json(agents.session_agents(s))
        if path == "/local/agents/activity":
            sid = qs.get("session", [""])[0]
            s = store.get_session(sid) if sid else None
            if not s or s["chat_id"] != chat:
                return self._json({"error": "not found"}, 404)
            try:
                cursor = int(qs.get("cursor", ["0"])[0])
            except ValueError:
                cursor = 0
            return self._json(agents.agent_activity(s, qs.get("agent", [""])[0], cursor,
                                                    qs.get("workflow", [""])[0] or None))
        if path == "/local/graph/state":
            abs_p = _abs_project(qs.get("project", [None])[0])
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            return self._json(graphmap.graph_state(abs_p))
        if path == "/local/graph/html":
            abs_p = _abs_project(qs.get("project", [None])[0])
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            fp = os.path.join(abs_p, graphmap.OUT_DIR, "graph.html")
            if not os.path.isfile(fp):
                # the MAP tab iframes this, so a JSON body renders as a raw blob
                return self._send(b"<!doctype html><body style='background:#0a0a0a;"
                                  b"color:#888;font:12px monospace;padding:14px'>"
                                  b"no map on disk - build one from the MAP tab.",
                                  404, "text/html; charset=utf-8")
            with open(fp, "rb") as f:
                return self._send(f.read(), 200, "text/html; charset=utf-8")
        if path == "/local/graph/explain":
            abs_p = _abs_project(qs.get("project", [None])[0])
            q = (qs.get("q", [""])[0] or "").strip()
            if abs_p is None or not q:
                return self._json({"error": "invalid project or query"}, 400)
            return self._json({"text": graphmap.explain(abs_p, q)})
        if path == "/local/learn":
            from bridge import learn
            project = qs.get("project", [None])[0]
            if project == "*":
                # ALL scope — every repo's lessons in one list. No single repo to
                # report a switch for, so the tab hides the per-repo toggle here.
                return self._json({"lessons": learn.all_lessons(), "repo_enabled": True})
            abs_p = _abs_project(project)
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            name = (qs.get("file", [""])[0] or "").strip()
            if name:
                body = learn.read(abs_p, name)
                if body is None:
                    return self._json({"error": "not found"}, 404)
                return self._json({"file": name, "body": body})
            return self._json({"lessons": learn.lessons(abs_p),
                               "repo_enabled": learn.repo_enabled(browser.rel(abs_p))})
        if path == "/local/inspector":
            from bridge import inspector
            return self._json({"on": inspector.running(),
                               "base_url": inspector.base_url(),
                               "entries": inspector.entries()})
        if path == "/local/toolsets":
            from bridge import toolsets
            return self._json({"builtins": toolsets.BUILTINS,
                               "servers": toolsets.servers(),
                               "default": store.default_disabled_tools()})
        if path == "/local/mcp":
            # refresh=1 re-runs the health check (seconds, all servers) — the
            # panel asks for it on demand, never on first paint.
            from bridge import mcp as mcpmod
            return self._json({"servers": mcpmod.servers(refresh=bool(_qs_int(qs, "refresh"))),
                               "pending": mcpmod.pending(),
                               "scopes": list(mcpmod.SCOPES),
                               "transports": list(mcpmod.TRANSPORTS)})
        if path == "/local/hooks":
            # Secrets never leave the DB — list_hooks turns each into a bool, so
            # the panel can say "signed" without being able to re-show it.
            from bridge import hooks
            return self._json({
                "hooks": [dict(h, url=hooks.hook_url(h["token"]))
                          for h in store.list_hooks()],
                "events": store.list_hook_events(_qs_int(qs, "limit") or 50),
                "sources": list(hooks.SOURCES),
                "public": bool(config.PREVIEW_HOSTNAME)})
        if path == "/local/tags":
            return self._json({"tags": store.tag_counts()})
        if path == "/local/prompts":
            return self._json({"prompts": store.prompt_history()})
        if path == "/local/skills":
            # A blank/unknown project is fine — the system list still applies.
            return self._json({**skills.installed(_abs_project(qs.get("project", [None])[0])),
                               "catalog": skills.catalog()})
        if path == "/local/plugins":
            # Two `claude plugin` calls; slow enough to be worth its own fetch,
            # so the SKILLS panel paints before this lands.
            from bridge import plugins
            return self._json(plugins.listing())
        if path == "/local/commands":
            # What `/` offers in the composer — the project's, the user's, the
            # enabled plugins', the CLI's own. Blank/unknown project: the rest.
            from bridge import commands
            return self._json({"commands": commands.available(_abs_project(qs.get("project", [None])[0]))})
        if path == "/local/update":
            # the platform's own checkout — new commits waiting upstream?
            return self._json(selfupdate.check())
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
        if path == "/local/graph/update":
            abs_p = _abs_project(body.get("project"))
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            return self._json(graphmap.update_async(abs_p))
        if path == "/local/learn/toggle":
            from bridge import learn
            abs_p = _abs_project(body.get("project"))
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            on = learn.set_repo_enabled(browser.rel(abs_p), bool(body.get("on")))
            return self._json({"repo_enabled": on})
        if path.startswith("/local/queue/"):
            return self._queue(path[len("/local/queue/"):], chat, body)
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
        if path == "/local/preview/detect":
            return self._preview_detect(chat, body)
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
            stype, stage, err = _resolve_stype(body.get("stype"))
            if err:
                return self._json({"error": err}, 400)
            s = store.create_session(chat, project, origin="dashboard", cwd=cwd,
                                     permission_mode=config.NEW_SESSION_PERMISSION_MODE,
                                     stype=stype, stage=stage)
            s = _pre_title(s, body.get("title"))
            return self._json({"session": _session_brief(s)})
        if path.startswith("/local/sessions/") and path.endswith("/archive"):
            sid = path[len("/local/sessions/"):-len("/archive")]
            s = store.get_session(sid)
            if not s or s["chat_id"] != chat:
                return self._json({"error": "not found"}, 404)
            store.archive(sid)
            return self._json({"ok": True})
        # "No" to a closing question: nothing to run, just stop the row asking.
        if path.startswith("/local/sessions/") and path.endswith("/dismiss-ask"):
            sid = path[len("/local/sessions/"):-len("/dismiss-ask")]
            return self._json({"ok": runner.dismiss_ask(sid)})
        if path == "/local/policy/default":
            from bridge import ladder
            try:
                return self._json({"ok": True,
                                   "policy": ladder.set_default_policy(
                                       body.get("policy") or None)})
            except ValueError as e:
                return self._json({"error": str(e)}, 400)
        if path == "/local/accounts":
            from bridge import accounts
            action = (body.get("action") or "").strip()
            try:
                if action == "add":
                    return self._json({"ok": True, "slot": accounts.add()})
                # login_begin returns the URL to sign in at; the code the user
                # gets back comes to login_submit. Both are slow-ish (a child
                # process and an OAuth round-trip) but bounded by their timeouts.
                if action == "login_begin":
                    # With a slot the sign-in re-authenticates that account in
                    # place (an expired login); without one it adds a new one.
                    slot = body.get("slot")
                    return self._json({"ok": True, **accounts.begin_login(
                        slot=slot if isinstance(slot, int) else None)})
                if action == "login_submit":
                    slot = body.get("slot")
                    if not isinstance(slot, int):
                        return self._json({"error": "slot must be a number"}, 400)
                    return self._json({"ok": True, **accounts.submit_login_code(
                        slot, str(body.get("code") or ""))})
                if action == "login_cancel":
                    slot = body.get("slot")
                    if isinstance(slot, int):
                        accounts.cancel_login(slot)
                    return self._json({"ok": True})
                if action in ("remove", "disable", "enable"):
                    slot = body.get("slot")
                    if not isinstance(slot, int):
                        return self._json({"error": "slot must be a number"}, 400)
                    getattr(accounts, action)(slot)
                    return self._json({"ok": True})
            except accounts.NoLogin:
                return self._json({"error": "No login in ~/.claude to copy. Run "
                                            "`claude /login` in a terminal first."}, 400)
            except accounts.LoginFailed as e:
                return self._json({"error": str(e)}, 400)
            except ValueError as e:
                return self._json({"error": str(e)}, 400)
            return self._json({"error": f"unknown action {action!r}"}, 400)
        if path == "/local/hooks":
            from bridge import hooks
            action = (body.get("action") or "").strip()
            if action == "create":
                source = (body.get("source") or "generic").strip()
                if source not in hooks.SOURCES:
                    return self._json({"error": f"unknown source {source!r}"}, 400)
                # The token is shown once, on this response. Re-reading the list
                # gives you the row but never a second look at the secret you set.
                row = store.create_hook(str(body.get("label") or "")[:60], source,
                                        str(body.get("secret") or "")[:200])
                return self._json({"ok": True, "hook": dict(row, url=hooks.hook_url(row["token"]))})
            if action == "delete":
                return self._json({"ok": bool(store.delete_hook(
                    str(body.get("token") or "")))})
            return self._json({"error": f"unknown action {action!r}"}, 400)
        if path == "/local/mcp":
            # Every mutation is `claude mcp`, which owns validation and state;
            # we hand back its freshly health-checked list, so an add costs one
            # health check before the panel repaints.
            from bridge import mcp as mcpmod
            action = (body.get("action") or "").strip()
            name = str(body.get("name") or "")[:200]
            if action == "login_begin":
                got = mcpmod.begin_login(name)
                if got.get("error"):
                    return self._json(got, 400)
                return self._json({"ok": True, **got})
            if action == "login_submit":
                ok, err = mcpmod.submit_login(str(body.get("url") or ""))
                return self._json({"ok": ok, "error": err or None,
                                   "servers": mcpmod.servers()}, 200 if ok else 400)
            if action == "login_cancel":
                mcpmod.cancel_login()
                return self._json({"ok": True})
            acts = {
                "add": lambda: mcpmod.add(name, str(body.get("target") or ""),
                                          str(body.get("transport") or "http"),
                                          str(body.get("scope") or "user")),
                "remove": lambda: mcpmod.remove(name),
                "logout": lambda: mcpmod.logout(name),
            }
            if action not in acts:
                return self._json({"error": f"unknown action {action!r}"}, 400)
            ok, err = acts[action]()
            return self._json({"ok": ok, "error": err or None,
                               "servers": mcpmod.servers()}, 200 if ok else 400)
        if path == "/local/aifeatures":
            from bridge import aifeatures
            try:
                aifeatures.set_enabled(str(body.get("key") or ""), body.get("enabled"))
            except ValueError as e:
                return self._json({"error": str(e)}, 400)
            return self._json({"ok": True, "features": aifeatures.state()})
        if path == "/local/envsettings":
            from bridge import envsettings
            try:
                # A missing "value" clears the override; an explicit null does too.
                envsettings.set_value(str(body.get("key") or ""), body.get("value"))
            except ValueError as e:
                return self._json({"error": str(e)}, 400)
            return self._json({"ok": True, "settings": envsettings.state()})
        if path == "/local/agentconfig":
            # Each AI tool's own global config file, written verbatim.
            from bridge import agentconfig
            try:
                agentconfig.write(str(body.get("id") or ""), body.get("content"))
            except ValueError as e:
                return self._json({"error": str(e)}, 400)
            except OSError as e:
                return self._json({"error": f"could not write it — {e}"}, 400)
            return self._json({"ok": True, **agentconfig.state()})
        if path == "/local/startup":
            from bridge import startup
            try:
                st = startup.apply(bool(body.get("login")), bool(body.get("window")),
                                   body.get("profile") or None)
            except (RuntimeError, OSError, subprocess.SubprocessError) as e:
                return self._json({"error": str(e)}, 400)
            return self._json({"ok": True, "startup": st})
        if path == "/local/next":
            # Scouts take a minute; answer now with the cached board and let the
            # client's poll pick up the new one. Concurrent refreshes collapse.
            from bridge import nextup
            Thread(target=nextup.refresh, args=(chat,), daemon=True).start()
            return self._json({"ok": True, **nextup.board(chat)})
        if path == "/local/freeagents":
            from bridge import freeagent
            try:
                freeagent.set_setting(str(body.get("name") or ""),
                                      body.get("value"))
            except ValueError as e:
                return self._json({"error": str(e)}, 400)
            return self._json({"ok": True, "free_agents": _free_agents()})
        if path.startswith("/local/sessions/") and path.endswith("/policy"):
            from bridge import ladder
            sid = path[len("/local/sessions/"):-len("/policy")]
            s = store.get_session(sid)
            if not s or s["chat_id"] != chat:
                return self._json({"error": "not found"}, 404)
            policy = body.get("policy") or None
            if policy is not None and policy not in ladder.POLICIES:
                return self._json(
                    {"error": f"policy must be one of {ladder.POLICIES}"}, 400)
            store.set_fallback_policy(sid, policy)
            return self._json({"ok": True, "fallback_policy": policy})
        if path.startswith("/local/sessions/") and path.endswith("/autocompact"):
            from bridge.miniapp.server import normalize_autocompact
            sid = path[len("/local/sessions/"):-len("/autocompact")]
            s = store.get_session(sid)
            if not s or s["chat_id"] != chat:
                return self._json({"error": "not found"}, 404)
            ok, value = normalize_autocompact(body.get("autocompact"))
            if not ok:
                return self._json(
                    {"error": "autocompact must be 'auto' or 100000-1000000"}, 400)
            store.set_autocompact(sid, value)
            return self._json({"ok": True, "autocompact": value})
        if path == "/local/inspector":
            from bridge import inspector
            action = body.get("action")
            if action == "on":
                inspector.start()
            elif action == "off":
                inspector.stop()
            elif action == "clear":
                inspector.clear()
            else:
                return self._json({"error": "action must be on | off | clear"}, 400)
            # A turn already running keeps the base URL it was spawned with, so a
            # switch here lands on the next turn.
            return self._json({"ok": True, "on": inspector.running(),
                               "base_url": inspector.base_url()})
        if path == "/local/toolsets/default":
            from bridge import toolsets
            # What a session with no choice of its own runs with. Stored, so it
            # takes effect on the next turn rather than needing a restart.
            rules = toolsets.clean(body.get("disabled_tools"))
            store.set_setting(store.DEFAULT_TOOLS_KEY, json.dumps(rules))
            return self._json({"ok": True, "default": rules})
        if path.startswith("/local/sessions/") and path.endswith("/tools"):
            from bridge import toolsets
            sid = path[len("/local/sessions/"):-len("/tools")]
            s = store.get_session(sid)
            if not s or s["chat_id"] != chat:
                return self._json({"error": "not found"}, 404)
            rules = toolsets.clean(body.get("disabled_tools"))
            store.set_disabled_tools(sid, rules)
            return self._json({"ok": True, "disabled_tools": rules})
        if path.startswith("/local/sessions/") and path.endswith("/goal"):
            from bridge import goals
            sid = path[len("/local/sessions/"):-len("/goal")]
            s = store.get_session(sid)
            if not s or s["chat_id"] != chat:
                return self._json({"error": "not found"}, 404)
            objective = (body.get("objective") or "").strip()[:2000]
            if not objective:
                goals.clear(sid)          # empty objective = abandon the goal
                return self._json({"ok": True, "goal": None})
            return self._json({"ok": True, "goal": goals.create(sid, objective)})
        if path.startswith("/local/sessions/") and path.endswith("/stype"):
            return _retype_action(
                self, chat, path[len("/local/sessions/"):-len("/stype")], body)
        if path.startswith("/local/sessions/") and path.endswith("/stage"):
            return _stage_action(
                self, chat, path[len("/local/sessions/"):-len("/stage")], body)
        if path.startswith("/local/flows/") and path.endswith("/delete"):
            return self._json({"ok": flow.delete_custom(
                path[len("/local/flows/"):-len("/delete")])})
        if path.startswith("/local/flows/"):
            errs = flow.save_custom(path[len("/local/flows/"):], body)
            return self._json({"errors": errs}, 400) if errs \
                else self._json({"ok": True})
        if path.startswith("/local/sessions/") and path.endswith("/lifecycle"):
            sid = path[len("/local/sessions/"):-len("/lifecycle")]
            s = store.get_session(sid)
            if not s or s["chat_id"] != chat:
                return self._json({"error": "not found"}, 404)
            state = body.get("lifecycle") or None
            if state is not None and state not in store.LIFECYCLES:
                return self._json(
                    {"error": f"lifecycle must be one of {store.LIFECYCLES}"}, 400)
            store.set_lifecycle(sid, state)
            return self._json({"ok": True, "lifecycle": state})
        if path.startswith("/local/sessions/") and path.endswith("/tags"):
            sid = path[len("/local/sessions/"):-len("/tags")]
            s = store.get_session(sid)
            if not s or s["chat_id"] != chat:
                return self._json({"error": "not found"}, 404)
            tags = body.get("tags")
            if not isinstance(tags, list):
                return self._json({"error": "tags must be a list"}, 400)
            # store.set_tags normalizes and caps; it returns what it kept.
            return self._json({"ok": True, "tags": store.set_tags(sid, tags)})
        if path == "/local/tags":
            # Rename a tag everywhere, or drop it (new omitted/empty). Renaming
            # onto a tag that already exists is how you merge two.
            old = (body.get("tag") or "").strip()
            if not old:
                return self._json({"error": "tag required"}, 400)
            new = (body.get("new") or "").strip() or None
            changed = store.retag(old, new)
            return self._json({"ok": True, "changed": changed, "tags": store.tag_counts()})
        if path.startswith("/local/sessions/") and path.endswith("/retitle"):
            sid = path[len("/local/sessions/"):-len("/retitle")]
            s = store.get_session(sid)
            if not s or s["chat_id"] != chat:
                return self._json({"error": "not found"}, 404)
            title = (body.get("title") or "").strip()
            if title:
                store.rename(sid, title[:80])      # a rename sticks: title_source=manual
                return self._json({"ok": True, "session": _session_brief(store.get_session(sid))})
            # No title given: hand it back to the model. Runs in a thread and
            # lands on the next session poll, like the automatic titling does.
            if not titler.regenerate(chat, s):
                return self._json({"error": "nothing to title yet"}, 400)
            return self._json({"ok": True, "generating": True})
        if path.startswith("/local/sessions/") and path.endswith("/share"):
            sid = path[len("/local/sessions/"):-len("/share")]
            s = store.get_session(sid)
            if not s or s["chat_id"] != chat:
                return self._json({"error": "not found"}, 404)
            if body.get("revoke"):
                return self._json({"ok": True, "revoked": store.revoke_shares(sid),
                                   "shares": []})
            row = store.create_share(sid, int(body.get("days") or 7))
            store.prune_shares()
            return self._json({"ok": True, "token": row["token"],
                               "expires": row["expires"],
                               "url": f"/share/{row['token']}"})
        if path.startswith("/local/sessions/") and path.endswith("/duplicate"):
            sid = path[len("/local/sessions/"):-len("/duplicate")]
            s = store.get_session(sid)
            if not s or s["chat_id"] != chat:
                return self._json({"error": "not found"}, 404)
            copy = store.duplicate(sid)
            return self._json({"ok": True, "session": _session_brief(copy)})
        if path.startswith("/local/sessions/") and path.endswith("/relocate"):
            sid = path[len("/local/sessions/"):-len("/relocate")]
            s = store.get_session(sid)
            if not s or s["chat_id"] != chat:
                return self._json({"error": "not found"}, 404)
            # Same containment rule as every other path the dashboard accepts —
            # relocating is not a way to point a session outside BASE_PATH.
            dest = _worktree_cwd(body.get("project"), (body.get("branch") or "").strip())
            if dest is None:
                return self._json({"error": "invalid project"}, 400)
            rewritten = store.relocate(sid, dest)
            return self._json({"ok": True, "cwd": dest, "rewritten": rewritten,
                               "session": _session_brief(store.get_session(sid))})
        if path == "/local/git/commit":
            cwd = _worktree_cwd(body.get("project"), (body.get("branch") or "").strip())
            if cwd is None:
                return self._json({"error": "invalid project"}, 400)
            msg = (body.get("message") or "").strip()[:2000]
            if not msg:
                return self._json({"error": "empty commit message"}, 400)
            paths = body.get("paths")
            if isinstance(paths, list) and paths:
                ok, output = git.commit_paths(cwd, msg, [str(p) for p in paths][:500])
            else:
                ok, output = git.commit(cwd, msg)
            return self._json({"ok": ok, "output": output})
        if path == "/local/git/op":
            # CHANGES panel — stage / unstage / discard working-tree paths.
            cwd = _worktree_cwd(body.get("project"), (body.get("branch") or "").strip())
            if cwd is None:
                return self._json({"error": "invalid project"}, 400)
            fn = {"stage": git.stage, "unstage": git.unstage,
                  "discard": git.discard}.get((body.get("op") or "").strip())
            if fn is None:
                return self._json({"error": "unknown op"}, 400)
            paths = [str(x) for x in (body.get("paths") or [])][:500]
            ok, output = fn(cwd, paths)
            return self._json({"ok": ok, "output": output})
        if path == "/local/git/commit-message":
            return self._commit_message(chat, body)
        if path == "/local/git/push":
            cwd = _worktree_cwd(body.get("project"), (body.get("branch") or "").strip())
            if cwd is None:
                return self._json({"error": "invalid project"}, 400)
            ok, output = git.push(cwd)
            return self._json({"ok": ok, "output": output})
        if path == "/local/git/pull":
            # fast-forward only — a diverged or dirty tree fails with git's
            # own message rather than merging behind the user's back.
            cwd = _worktree_cwd(body.get("project"), (body.get("branch") or "").strip())
            if cwd is None:
                return self._json({"error": "invalid project"}, 400)
            ok, output = git.pull(cwd)
            return self._json({"ok": ok, "output": output})
        if path == "/local/update":
            # pull the platform's new commits; on success the bridge restarts
            # shortly after this response flushes.
            ok, output = selfupdate.update()
            return self._json({"ok": ok, "output": output})
        if path == "/local/update/publish":
            return self._publish_update(chat)
        if path == "/local/restart":
            # no pull, no rebuild — just re-exec the bridge (and with it this
            # dashboard) so code already on disk becomes the code running.
            selfupdate.restart()
            return self._json({"ok": True})
        if path == "/local/files/write":
            # EDITOR tab :w / Ctrl-S — save a working-tree file to disk
            cwd = _worktree_cwd(body.get("project"), (body.get("branch") or "").strip())
            if cwd is None:
                return self._json({"error": "invalid project"}, 400)
            rel = (body.get("path") or "").strip()
            if not rel:
                return self._json({"error": "no path"}, 400)
            content = body.get("content")
            if not isinstance(content, str):
                return self._json({"error": "content must be a string"}, 400)
            if len(content) > 5_000_000:
                return self._json({"error": "file too large"}, 413)
            ok, output = git.write_file(cwd, rel, content)
            return self._json({"ok": ok} if ok else {"ok": False, "error": output})
        if path == "/local/files/format":
            # EDITOR Shift-Alt-F — run the project's own formatter over the
            # buffer. Nothing is written; the editor swaps the text and the
            # user still saves explicitly.
            cwd = _worktree_cwd(body.get("project"), (body.get("branch") or "").strip())
            if cwd is None:
                return self._json({"error": "invalid project"}, 400)
            rel = (body.get("path") or "").strip()
            content = body.get("content")
            if not rel or not isinstance(content, str):
                return self._json({"error": "path and content required"}, 400)
            if len(content) > 5_000_000:
                return self._json({"ok": False, "error": "file too large to format"}, 413)
            return self._json(fmt.format_source(cwd, rel, content))
        if path == "/local/files/op":
            # EDITOR explorer file management — new file/folder, rename, delete
            cwd = _worktree_cwd(body.get("project"), (body.get("branch") or "").strip())
            if cwd is None:
                return self._json({"error": "invalid project"}, 400)
            rel = (body.get("path") or "").strip()
            op = (body.get("op") or "").strip()
            if not rel:
                return self._json({"error": "no path"}, 400)
            if op == "new" or op == "newdir":
                ok, output = git.create_path(cwd, rel, directory=op == "newdir")
            elif op == "rename":
                ok, output = git.rename_path(cwd, rel, (body.get("to") or "").strip())
            elif op == "delete":
                ok, output = git.delete_path(cwd, rel)
            else:
                return self._json({"error": "unknown op"}, 400)
            return self._json({"ok": ok, "path": output} if ok else {"ok": False, "error": output})
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
            abs_p = (_abs_within((body.get("cwd") or "").strip())
                     or _abs_project(body.get("cwd_rel") or body.get("project")))
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            rel = browser.rel(abs_p)
            branch = (body.get("branch") or "").strip() or None
            out: dict = {"ok": True}
            if "run_cmd" in body:
                out["run_cmd"] = project_config.set_run_cmd(rel, (body.get("run_cmd") or "")[:1000], branch)
            if "prod_url" in body:
                out["prod_url"] = project_config.set_prod_url(rel, (body.get("prod_url") or "")[:1000], branch)
            if "design_project" in body:
                out["design_project"] = project_config.set_design_project(
                    rel, (body.get("design_project") or "")[:200], branch)
            if "hidden" in body:
                out["hidden"] = project_config.set_hidden(rel, bool(body.get("hidden")))
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
        if path == "/local/skills/check":
            # Network sweep (one request per installed catalog skill), so it is
            # a POST behind the token rather than a free GET.
            return self._json(skills.check_updates(_abs_project(body.get("project"))))
        if path in ("/local/skills/install", "/local/skills/remove"):
            scope = body.get("scope")
            if scope not in ("project", "system"):
                return self._json({"error": "bad scope"}, 400)
            abs_p = _abs_project(body.get("project"))
            if scope == "project" and abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            act = skills.install if path.endswith("/install") else skills.remove
            ok, err = act(str(body.get("id", ""))[:100], scope, abs_p)
            return self._json({"ok": ok, "error": err or None,
                               **skills.installed(abs_p)}, 200 if ok else 400)
        if path.startswith("/local/plugins/"):
            # Marketplace and plugin mutations. Every one runs `claude plugin`,
            # which owns validation and state; we return its fresh listing.
            from bridge import plugins
            action = path[len("/local/plugins/"):]
            name = str(body.get("id", ""))[:200]
            acts = {
                "market/add": lambda: plugins.add_marketplace(name),
                "market/remove": lambda: plugins.remove_marketplace(name),
                "install": lambda: plugins.install(name, str(body.get("scope") or "user")),
                "uninstall": lambda: plugins.uninstall(name),
                "update": lambda: plugins.update(name),
                "enable": lambda: plugins.set_enabled(name, bool(body.get("enabled"))),
            }
            if action not in acts:
                return self._json({"error": "not found"}, 404)
            ok, err = acts[action]()
            return self._json({"ok": ok, "error": err or None, **plugins.listing()},
                              200 if ok else 400)
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
        # Ask git where the branch lives before trusting our own naming: the branch
        # may be checked out somewhere else entirely (git would refuse a second
        # worktree for it), and the dir named after it may have been switched to
        # another branch from inside a session — reusing that hands back the wrong
        # tree, which is how a session opens on a branch you didn't pick.
        existing = _worktree_for_branch(abs_p, branch)
        if existing is not None:
            return self._json({"ok": True, "path": existing,
                               "rel": browser.rel(existing), "branch": branch,
                               "output": f"branch already checked out at {existing}"})
        wt = base = _worktree_path(project, branch)
        n = 2
        while os.path.isdir(wt):     # taken by another branch — pick a free path
            wt, n = f"{base}-{n}", n + 1
        rel = browser.rel(wt)
        os.makedirs(os.path.dirname(wt), exist_ok=True)
        parent = (body.get("parent") or git.current_branch(abs_p) or "main").strip()
        create = body.get("create", True)
        ok, output = git.worktree_add(abs_p, wt, branch, parent, create=bool(create))
        if not ok:
            return self._json({"ok": False, "output": output})
        # git checks out tracked files only, so everything git-ignored is missing —
        # .env above all, without which this repo's own bin/mystical dies on every
        # command. Copying it is what the worktree skill tells a human to do by
        # hand; doing it here is why a worktree session isn't born broken.
        # ponytail: .env only. node_modules is a build concern — symlink the launch
        # checkout's if you must build inside the worktree.
        src_env = os.path.join(abs_p, ".env")
        dst_env = os.path.join(wt, ".env")
        if os.path.isfile(src_env) and not os.path.exists(dst_env):
            try:
                shutil.copy2(src_env, dst_env)
            except OSError as e:
                output = f"{output}\nworktree created, .env not copied: {e}".strip()
        return self._json({"ok": True, "path": wt, "rel": rel, "branch": branch,
                           "output": output})

    def _commit_message(self, chat, body):
        """Generate a commit message for the selected files via a one-shot headless
        Claude run over their diff (same pattern as preview_detect)."""
        cwd = _worktree_cwd(body.get("project"), (body.get("branch") or "").strip())
        if cwd is None:
            return self._json({"error": "invalid project"}, 400)
        paths = body.get("paths")
        paths = [str(p) for p in paths][:500] if isinstance(paths, list) else []
        if not paths:
            return self._json({"error": "no files selected"}, 400)
        from bridge import aifeatures
        if not aifeatures.enabled("commitmsg"):
            return self._json({"error": "commit messages are switched off in the AI tab"}, 403)
        diff = git.diff_multi(cwd, paths)
        if not diff.strip():
            return self._json({"error": "no changes to describe"}, 400)
        result, _sid, _cost, is_error = runner.run_blocking(
            chat, _COMMIT_MSG_PROMPT + diff, cwd=cwd, timeout=120,
            model="haiku", skip_pack=True)
        if is_error or not (result or "").strip():
            return self._json({"error": "could not generate message"}, 502)
        return self._json({"message": git.clean_commit_message(result)})

    def _publish_update(self, chat):
        """The header button's other half: commit the platform checkout's own work
        with a generated message (same one-shot as the git tab) and push it."""
        from bridge import aifeatures
        st = git.status(selfupdate.REPO)
        message = ""
        if st["dirty"]:
            paths = [f["path"] for f in st["files"]][:500]
            if not aifeatures.enabled("commitmsg"):
                # Switched off, SHIP still ships — it just says what moved.
                message = _plain_commit_message(paths)
            else:
                diff = git.diff_multi(selfupdate.REPO, paths)
                result, _sid, _cost, is_error = runner.run_blocking(
                    chat, _COMMIT_MSG_PROMPT + diff, cwd=selfupdate.REPO, timeout=180,
                    model="haiku", skip_pack=True)
                message = "" if is_error else git.clean_commit_message(result)
                if not message:
                    return self._json({"ok": False, "message": "",
                                       "output": "could not generate a commit message"})
        ok, output = selfupdate.publish(message)
        return self._json({"ok": ok, "output": output, "message": message})

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
        ponytail = runner.normalize_ponytail(body.get("ponytail"))
        try:
            from bridge import ladder
            account_slot, runtime = ladder.resolve_agent(body.get("agent") or "")
        except ValueError as e:
            return self._json({"error": str(e)}, 400)
        session_id = (body.get("session_id") or "").strip() or None
        # Hold a prompt that doesn't belong in the session it would resume; the
        # client re-sends with force=true (or against a fresh session). Before
        # _save_images so a held prompt writes nothing.
        held = relevance.gate(chat, project_path, session_id, prompt,
                              bool(body.get("force")))
        if held:
            return self._json(held)
        job_id = uuid.uuid4().hex
        try:
            paths = _save_images(job_id, images) if images else []
        except ValueError as e:
            runner._cleanup_uploads(job_id)
            return self._json({"error": str(e)}, 413)
        job = runner.start_streaming_job(chat, prompt, paths, project_path, job_id=job_id,
                                         model=model, effort=effort,
                                         permission_mode=permission_mode,
                                         session_id=session_id, origin="dashboard",
                                         ponytail=ponytail, account_slot=account_slot,
                                         runtime=runtime)
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

    def _queue(self, op, chat, body):
        """Per-session prompt queue. Runs are keyed by the store session id —
        the same key the run slot uses — so queued prompts serialise with normal
        chat runs in that session and run strictly one at a time."""
        sid = (body.get("session_id") or "").strip()
        if op == "enqueue":
            if not sid:
                return self._json({"error": "session required"}, 400)
            text = (body.get("text") or "").strip()
            prompt = (body.get("prompt") or text).strip()
            if not prompt:
                return self._json({"error": "empty prompt"}, 400)
            images = body.get("images") or []
            if not isinstance(images, list) or len(images) > config.UPLOAD_MAX_COUNT:
                return self._json({"error": f"too many images (max {config.UPLOAD_MAX_COUNT})"}, 413)
            ok, model, effort = normalize_model_effort(body.get("model"), body.get("effort"))
            if not ok:
                return self._json({"error": "invalid model"}, 400)
            permission_mode = normalize_permission_mode(body.get("permission_mode"))
            agent = (body.get("agent") or "").strip()
            try:
                from bridge import ladder
                ladder.resolve_agent(agent)      # reject a dead pick at enqueue time
            except ValueError as e:
                return self._json({"error": str(e)}, 400)
            run_job_id = uuid.uuid4().hex
            try:
                paths = _save_images(run_job_id, images) if images else []
            except ValueError as e:
                runner._cleanup_uploads(run_job_id)
                return self._json({"error": str(e)}, 413)
            sel = body.get("sel") if isinstance(body.get("sel"), list) else []
            try:
                width = int(body.get("width") or 0)
            except (ValueError, TypeError):
                width = 0
            item_id = queue_manager.enqueue(
                sid, text=(text or prompt), prompt=prompt, images=paths, model=model,
                effort=effort, permission_mode=permission_mode, width=width, sel=sel,
                surface=(body.get("surface") or "dashboard"), chat_id=chat,
                project=_abs_project(body.get("project")), run_job_id=run_job_id,
                agent=agent or None)
            return self._json({"item_id": item_id, **queue_manager.snapshot(sid)})
        if not sid:
            return self._json({"error": "session required"}, 400)
        if op == "steer":
            # Not a queue op: goes straight into the running turn (see runner.steer).
            text = (body.get("text") or "").strip()
            if not text:
                return self._json({"error": "empty prompt"}, 400)
            images = body.get("images") or []
            if not isinstance(images, list) or len(images) > config.UPLOAD_MAX_COUNT:
                return self._json({"error": f"too many images (max {config.UPLOAD_MAX_COUNT})"}, 413)
            # Their own dir, not the running turn's: the steer can arrive after
            # that turn's uploads were written, and pruning is by age anyway.
            shot_id = uuid.uuid4().hex
            try:
                paths = _save_images(shot_id, images) if images else []
            except ValueError as e:
                runner._cleanup_uploads(shot_id)
                return self._json({"error": str(e)}, 413)
            if not runner.steer(sid, text, paths):
                runner._cleanup_uploads(shot_id)
                return self._json({"error": "nothing running"}, 409)
            return self._json(queue_manager.snapshot(sid))
        item_id = (body.get("item_id") or "").strip()
        if op == "remove":
            queue_manager.remove(sid, item_id)
        elif op == "edit":
            text = (body.get("text") or "").strip()
            queue_manager.edit(sid, item_id, text, (body.get("prompt") or text).strip())
        elif op == "reorder":
            queue_manager.reorder(sid, (body.get("from") or "").strip(),
                                  (body.get("to") or "").strip())
        elif op == "bump":
            queue_manager.bump(sid, item_id)
        elif op == "move":
            queue_manager.move(sid, item_id, (body.get("to") or "").strip())
        elif op == "pause":
            queue_manager.pause(sid)
        elif op == "resume":
            queue_manager.resume(sid)
        elif op == "cancel":
            queue_manager.cancel(sid, item_id)
        elif op == "retry":
            queue_manager.retry(sid, item_id)
        elif op == "clear-done":
            queue_manager.clear_done(sid)
        else:
            return self._json({"error": "unknown queue op"}, 404)
        return self._json(queue_manager.snapshot(sid))

    def _server(self, chat, body):
        # A dev server targets one run directory (a project, or a linked worktree
        # with its own branch), so several can run concurrently on their own
        # ports. The caller names the cwd/branch; we fall back to the active one.
        cwd = _server_cwd(chat, body)
        rel = browser.rel(cwd)
        branch = (body.get("branch") or "").strip()
        action = body.get("action", "start")
        if action == "stop":
            msg = devserver.stop(cwd)
        else:
            cmd = ((body.get("cmd") or "").strip()
                   or project_config.run_cmd(rel, branch or None)
                   or config.START_CMD)
            msg = devserver.start(cwd, cmd, project=(body.get("project") or rel), branch=branch)
        self._json({"server": devserver.state_for(cwd),
                    "servers": devserver.list_servers(), "message": msg})

    def _preview_detect(self, chat, body):
        # Learn how to start this project (heuristic, falling back to Claude for
        # ambiguous repos), persist the chain per project+branch, and return it.
        cwd = _server_cwd(chat, body)
        rel = browser.rel(cwd)
        branch = (body.get("branch") or "").strip() or None
        res = preview_detect.detect(cwd, chat)
        cmd = (res.get("command") or "").strip()
        if cmd:
            project_config.set_run_cmd(rel, cmd, branch)
        self._json({"command": cmd, "source": res.get("source"),
                    "explanation": res.get("explanation", "")})

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
        elif rest.startswith("queue/"):
            sid = rest[len("queue/"):].split("/")[0]
            try:
                cursor = int(qs.get("cursor", ["0"])[0])
            except ValueError:
                cursor = 0
            self._sse(f"queue:{sid}", lambda c: queue_manager.backfill(sid, c), cursor)
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
            ok, last = self._emit_backfill(backfill, cursor, last)
            if not ok:
                return
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

    def _emit_backfill(self, backfill, cursor, last):
        """Emit the backfill in ONE pass and return (ok, max_seq_emitted). A single
        backfill() call closes the window where an event published between two
        calls would bump `last` without ever being framed (then get deduped away)."""
        for ev in backfill(cursor):
            last = self._max_seq([ev], last)
            if not self._frame(ev):
                return False, last
        return True, last

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
    def _share(self, token: str):
        """A shared session's page. Unknown, revoked and expired tokens are one
        answer — 404 — so a probe learns nothing from the difference."""
        page = share.render((token or "").strip("/").split("/")[0])
        if page is None:
            return self._send(b"Not found or expired.", 404, "text/plain; charset=utf-8",
                              cache="no-store")
        self._send(page.encode(), 200, "text/html; charset=utf-8", cache="no-store")

    def _attachment(self, p: str):
        """Serve one uploaded screenshot back to the transcript, so a rehydrated
        turn shows the image instead of a chip. Confined to UPLOAD_DIR (the paths
        _save_images wrote) — nothing else on disk is readable through this. A run
        cleans its uploads up when it ends, so a miss is normal: the transcript
        falls back to the chip when the image 404s."""
        up = os.path.realpath(config.UPLOAD_DIR)
        fp = os.path.realpath(p or "")
        ctype = mimetypes.guess_type(fp)[0] or ""
        if (not fp.startswith(up + os.sep) or not os.path.isfile(fp)
                or not ctype.startswith("image/")):
            return self._json({"error": "not found"}, 404)
        with open(fp, "rb") as f:
            self._send(f.read(), 200, ctype, cache="private, max-age=300")

    def _manifest(self):
        """The PWA manifest, built here rather than shipped in dist/ so start_url
        carries the live DASH_TOKEN — an installed app then always launches
        authenticated, and a rotated token is picked up next load (hence
        no-cache) instead of going stale in a file on disk.

        Handing out the token is safe exactly where the read GETs above are: the
        Host allow-list has already run (so DNS-rebinding is out), the bind is
        loopback, and a cross-origin fetch can't read the response because
        nothing here sends CORS headers."""
        start = f"/?token={quote(config.DASH_TOKEN, safe='')}" if config.DASH_TOKEN else "/"
        body = json.dumps({
            "name": "mystical//assistant",
            "short_name": "mystical",
            "description": "A full desktop Claude client for the mystical-assistant bridge.",
            "start_url": start,
            "scope": "/",
            "display": "standalone",
            "background_color": "#060a0a",
            "theme_color": "#060a0a",
            "icons": [
                {"src": "/icon-192.png", "sizes": "192x192", "type": "image/png"},
                {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png"},
                {"src": "/icon-512-maskable.png", "sizes": "512x512", "type": "image/png",
                 "purpose": "maskable"},
            ],
        }).encode()
        self._send(body, 200, "application/manifest+json")

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
            data = f.read()
        if os.path.basename(fp) == "index.html":
            # Tell the SPA whether the ?token= gate is live so it only nags about
            # a missing token when one is actually required (not when DASH_TOKEN="").
            flag = b"true" if config.DASH_TOKEN else b"false"
            data = data.replace(
                b"<head>", b"<head><script>window.__DASH_AUTH_REQUIRED__=" + flag + b"</script>", 1)
        self._send(data, 200, ctype, cache=cache)


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
