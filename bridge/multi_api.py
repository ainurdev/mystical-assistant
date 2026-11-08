"""The routes for multi-agent chats, in one place for both servers.

The dashboard calls these under /local/, the Mini App under /api/, and each passes the
path past that prefix: same JSON from the same function (bridge-feature-slice's "two
servers, one shape"). Only the routes differ in who may call: the servers' own auth has
already run. Settings like the switch answer whatever it says; everything else is a 409
while it's off, so a stale page reads a plain reason instead of acting.

get() and post() return (body, status), or None for a path that isn't theirs.
"""

import mimetypes
import os
import urllib.parse

from bridge import (acp_agents, agent_tools, agent_tree, automations, channel, chat_files, chat_images, chat_aside, chat_search, config, design_audit, design_board, design_system, project_docs, experimental,
                    handoff, hooks_config, mcp_oauth, mcp_share, mystical_dir, profiles, project_config, rules, saved_views, skill_share, store,
                    tool_policy, worklist)

_OFF = ({"error": "The experimental features are off. Turn them on in Settings."}, 409)
_AGENTS_EXTRA = ("claude",)


def _owned(chat_id: int, sid: "str | None") -> "dict | None":
    s = store.get_session(sid) if sid else None
    return s if s and s["chat_id"] == chat_id else None


def _chat_of(s: dict) -> dict:
    return store.get_session(s["parent_session"]) if s.get("parent_session") else s


def _one(qs: dict, key: str) -> str:
    v = qs.get(key)
    return (v[0] if isinstance(v, list) else v) or ""


def _agents() -> list:
    return [*_AGENTS_EXTRA, *[p["id"] for p in acp_agents.available() if p.get("installed")]]


def image_root(chat_id: int, session: "str | None", project: "str | None") -> "str | None":
    """Where a chat's images live: its session's project, or for a chat that doesn't
    exist yet, the project it will start in."""
    s = _owned(chat_id, session)
    if s:
        return chat_images.root_of(s.get("cwd"))
    rel = (project or "").lstrip("/")
    if not rel:
        return None
    d = os.path.realpath(os.path.join(config.BASE_PATH, rel))
    base = os.path.realpath(config.BASE_PATH)
    return chat_images.root_of(d) if d.startswith(base + os.sep) else None


def image_file(qs: dict, chat_id: int) -> "tuple[bytes, str] | None":
    """The bytes behind an address in a message (GET chat-images/file), or None. Binary,
    so each server sends it; only the checks live here."""
    if not experimental.enabled():
        return None
    root = image_root(chat_id, _one(qs, "session"), _one(qs, "project"))
    real = chat_images.resolve(_one(qs, "path"), root)
    if not real:
        return None
    try:
        with open(real, "rb") as f:
            return f.read(), mimetypes.guess_type(real)[0] or "application/octet-stream"
    except OSError:
        return None


def _work_root(chat_id: int, session: "str | None", project: "str | None") -> "tuple[str | None, str | None]":
    """(the project's main checkout, the chat it's seen from). Named by an owned chat, or by the
    project when you're the owner and no chat is open."""
    s = _owned(chat_id, session)
    if s:
        return worklist.root_of(s.get("cwd")), _chat_of(s)["id"]
    return (image_root(chat_id, None, project), None) if config.is_owner(chat_id) else (None, None)


def _post_design(path: str, body: dict, s: dict, chat_id: int) -> "tuple[dict, int]":
    """The design view (bridge/design_board.py, design_audit.py)."""
    root = chat_images.root_of(s.get("cwd"))
    if not root:
        return {"error": "This chat has no project folder."}, 400
    try:
        if path == "chat/design":
            return design_board.poll(root, body)
        if path == "chat/design-comments":
            return design_board.edit_comments(root, body)
        if path == "chat/design-boards":
            return design_board.listed(root)
        if path == "chat/design-url":
            return design_board.live(root, body)
        if path == "chat/design-live":
            return design_board.proxied(root, body)
        if path == "chat/design-delete":
            return design_board.delete(root, body.get("board"))
        if path == "chat/design-version":
            html = design_board.read_version(root, str(body.get("board") or ""), str(body.get("page") or ""), int(body.get("version") or 0))
            return ({"html": html}, 200) if html is not None else ({"error": "No such version."}, 404)
        if path == "chat/design-critique":
            return design_audit.critique(root, {"board": body.get("board"), "page": body.get("page"), "fresh": body.get("fresh") is True}, chat_id), 200
        if path == "chat/design-reference":
            return design_audit.reference(root, body)
        if path == "chat/design-system":
            return design_system.discover(root, s), 200
        if path == "chat/design-system-preview":
            return design_system.preview(root, body)
        if path == "chat/design-system-create":
            return design_system.create(root, body)
        if path == "chat/design-system-link":
            return design_system.link(root, body)
        if path == "chat/design-system-unlink":
            return design_system.unlink(root, body)
        if path == "chat/design-system-import":
            return design_system.import_(root, body)
        if path == "chat/design-references":
            return {"references": design_audit.references(root)}, 200
    except (design_board.Refused, design_system.Refused, ValueError) as e:
        return {"error": str(e)}, 400
    except OSError as e:
        return {"error": f"Couldn't do that: {e}"}, 500
    return {"error": "No such route."}, 404


def get(path: str, qs: dict, chat_id: int) -> "tuple[dict, int] | None":
    if path == "experimental":
        return experimental.state(), 200
    if path == "automations":
        if not experimental.enabled():
            return _OFF
        return (automations.listed(), 200) if chat_id == config.DASH_CHAT_ID else ({"error": "Only the owner can see automations."}, 403)
    if path == "worklist":
        if not experimental.enabled():
            return _OFF
        from bridge import workrun
        root, chat = _work_root(chat_id, _one(qs, "session"), _one(qs, "project"))
        return ({**worklist.view(root, chat), **workrun.run_view(root)}, 200) if root else ({"error": "No project here."}, 404)
    if path == "saved-views":
        if not experimental.enabled():
            return _OFF
        return saved_views.listed(image_root(chat_id, _one(qs, "session"), _one(qs, "project")))
    if path == "chat-images":
        return {"mode": chat_images.mode()}, 200
    if path not in ("tree", "channel", "session/handoff", "session/brief", "project/helper",
                    "mcp-share", "skill-share", "agent-tools", "rules", "rules/log", "mystical-dir",
                    "mystical-dir/read", "chat-search", "chat-report", "hooks"):
        return None
    if not experimental.enabled():
        return _OFF
    if path == "tree":
        one = _one(qs, "session")
        if one:
            s = _owned(chat_id, one)
            return ({"rows": agent_tree.tree(s)}, 200) if s else ({"error": "not found"}, 404)
        ids = [i for i in _one(qs, "ids").split(",") if i]
        return {"trees": agent_tree.trees(ids, chat_id)}, 200
    if path == "channel":
        s = _owned(chat_id, _one(qs, "session"))
        if not s:
            return {"error": "not found"}, 404
        chat = _chat_of(s)
        return {**channel.view(chat), "chat": chat["id"], "main": agent_tree.main_row(chat),
                "rows": agent_tree.tree(chat)}, 200
    if path == "session/brief":
        # A helper is in no list, so opening one by id reads it here.
        s = _owned(chat_id, _one(qs, "session"))
        if not s:
            return {"error": "not found"}, 404
        from bridge.miniapp.server import _session_brief   # lazy: that server imports this
        return {"session": _session_brief(s)}, 200
    if path == "project/helper":
        return {"profile_id": project_config.helper(_one(qs, "project")) or ""}, 200
    if path == "session/handoff":
        s = _owned(chat_id, _one(qs, "session"))
        if not s:
            return {"error": "not found"}, 404
        pid = _one(qs, "profile")
        target = profiles.get(pid) if pid else {}
        if pid and target is None:
            return {"error": "no such profile"}, 404
        return handoff.preview(s, target or {}), 200
    if path == "hooks":
        s = _owned(chat_id, _one(qs, "session"))
        return hooks_config.listing(_cwd_of(s, _one(qs, "project") or (s or {}).get("project"))), 200
    if path == "agent-tools":
        s = _owned(chat_id, _one(qs, "session"))
        project = _one(qs, "project") or (s or {}).get("project")
        return agent_tools.grid(_cwd_of(s, project), project, s), 200
    if path == "rules":
        s = _owned(chat_id, _one(qs, "session"))
        return {"rules": rules.listing(_one(qs, "project") or (s or {}).get("project"), s)}, 200
    if path == "rules/log":
        return {"rows": rules.recent(_one(qs, "session") or None)}, 200
    if path in ("mystical-dir", "mystical-dir/read"):
        root = image_root(chat_id, _one(qs, "session"), _one(qs, "project"))
        if not root:
            return {"error": "no project"}, 404
        if path.endswith("/read"):
            text = mystical_dir.read_text(root, _one(qs, "path"))
            return ({"text": text}, 200) if text is not None else ({"error": "not readable here"}, 404)
        return {**mystical_dir.listing(root, _one(qs, "sub")),
                "stale": [r["path"] for r in mystical_dir.stale(root)] if not _one(qs, "sub") else []}, 200
    if path == "chat-search":
        s = _owned(chat_id, _one(qs, "session"))
        if not s:
            return {"error": "not found"}, 404
        return {"hits": chat_search.in_chat(s["id"], _one(qs, "q"))}, 200
    if path == "chat-report":
        root = image_root(chat_id, _one(qs, "session"), _one(qs, "project"))
        real = os.path.realpath(os.path.join(root or "", _one(qs, "path")))
        if not root or not real.startswith(os.path.realpath(root) + os.sep) or not real.endswith((".md", ".markdown", ".txt")):
            return {"error": "not found"}, 404
        try:
            with open(real, encoding="utf-8", errors="replace") as f:
                return {"text": f.read(400_000)}, 200
        except OSError:
            return {"error": "not found"}, 404
    if path == "mcp-share":
        return {"servers": mcp_share.state(_one(qs, "cwd") or None, _agents()), "agents": _agents()}, 200
    if path == "skill-share":
        return {"skills": skill_share.state(_one(qs, "cwd") or None)}, 200
    return None


def post(path: str, body: dict, chat_id: int) -> "tuple[dict, int] | None":
    if path == "experimental":
        if "enabled" in body:
            experimental.set_enabled(body["enabled"] is True)
            rules.sync_agents()     # Kimi's managed block goes in or comes out with the switch
        if isinstance(body.get("defaults"), dict):
            try:
                experimental.set_defaults(body["defaults"])
            except ValueError as e:
                return {"error": str(e)}, 400
        return experimental.state(), 200
    if path.startswith("chat-images") and not experimental.enabled():
        return _OFF
    if path == "chat-images":
        try:
            return {"mode": chat_images.set_mode(str(body.get("mode") or ""))}, 200
        except ValueError as e:
            return {"error": str(e)}, 400
    if path == "chat-images/upload":
        return chat_images.upload(body, image_root(chat_id, body.get("session_id"), body.get("project")))
    if path.startswith("automations"):
        return automations.api(path, body, chat_id) if experimental.enabled() else _OFF
    if path.startswith("worklist"):
        if not experimental.enabled():
            return _OFF
        root, chat = _work_root(chat_id, body.get("session_id"), body.get("project"))
        if path.startswith("worklist/run/"):
            from bridge import workrun
            return workrun.api(path, body, root, store.get_session(chat) if chat else None)
        out, status = worklist.api(path, body, root, chat)
        if status == 200:
            from bridge import workrun
            out.update(workrun.run_view(root))
        return out, status
    if path == "design-theme":
        return design_board.save_theme(body) if experimental.enabled() else _OFF
    if path.startswith("saved-views"):
        if not experimental.enabled():
            return _OFF
        if path == "saved-views/send":
            return saved_views.send(body, chat_id)
        return saved_views.delete(image_root(chat_id, body.get("session_id"), body.get("project")), body.get("id"))
    if not path.startswith(("chat/", "channel/", "mcp-share", "skill-share", "project/helper", "tool-policy",
                            "rules", "mystical-dir", "hooks")):
        return None
    if not experimental.enabled():
        return _OFF
    if path.startswith(("tool-policy", "rules")):
        return _post_policy(path, body, chat_id)
    if path.startswith("mystical-dir"):
        return _post_dir(path, body, chat_id)
    if path == "hooks":
        return _post_hooks(body, chat_id)
    if path == "project/helper":
        pid = str(body.get("profile_id") or "")
        if pid and not profiles.get(pid):
            return {"error": "no such profile"}, 404
        project_config.set_helper(str(body.get("project") or ""), pid)
        return {"ok": True}, 200
    if path.startswith("mcp-share"):
        return _post_mcp(path, body)
    if path == "skill-share":
        skill_share.set_share(str(body.get("key") or ""), body.get("on") is True, body.get("cwd") or None)
        return {"ok": True, "skills": skill_share.state(body.get("cwd") or None)}, 200
    s = _owned(chat_id, str(body.get("session_id") or ""))
    if not s:
        return {"error": "not found"}, 404
    chat = _chat_of(s)
    if path == "chat/file-refs":
        return chat_files.refs(body, s)
    if path == "chat/open-file":
        return chat_files.open_file(body, s)
    if path == "chat/translate":
        return chat_aside.translate(body, chat_id, s.get("cwd"))
    if path == "chat/explain":
        return chat_aside.explain(body, chat_id, s.get("cwd"))
    if path.startswith("chat/design"):
        return _post_design(path, body, s, chat_id)
    if path in ("chat/docs", "chat/doc-read"):
        root = chat_images.root_of(s.get("cwd"))
        if not root:
            return {"error": "This chat has no project folder."}, 400
        return (project_docs.listed(root), 200) if path == "chat/docs" else project_docs.read(root, body)
    if path == "chat/view-save":
        return saved_views.save(chat_images.root_of(s.get("cwd")), body.get("view"))
    if path == "chat/config":
        try:
            return {"ok": True, "config": channel.set_config(chat, body.get("config") or {})}, 200
        except ValueError as e:
            return {"error": str(e)}, 400
    if path == "channel/send":
        text = str(body.get("text") or "").strip()
        if not text:
            return {"error": "nothing to send"}, 400
        to = str(body.get("to") or channel.MAIN)
        if to != "all" and channel._target(chat, to) is None:
            return {"error": f"no agent called {to}"}, 404
        return {"ok": True, "message": channel.human_message(chat, to, text)}, 200
    if path == "channel/hold":
        return {"ok": True, "config": channel.set_held(chat, body.get("held") is True)}, 200
    if path == "channel/edit":
        done = channel.edit_held(chat, str(body.get("id") or ""), body.get("body"), body.get("drop") is True)
        return ({"ok": True}, 200) if done else ({"error": "only a held message can change"}, 409)
    if path == "channel/stop":
        return {"ok": True, "stopped": channel.stop_all(chat)}, 200
    if path == "channel/merge":
        name, act = str(body.get("name") or ""), str(body.get("action") or "")
        fn = {"merge": channel.merge, "discard": channel.discard, "undo": channel.undo_merge,
              "review": channel.changes}.get(act)
        if not fn:
            return {"error": "action must be merge, discard, undo or review"}, 400
        return {"ok": True, "text": fn(chat, name)}, 200
    return None


def _cwd_of(s: "dict | None", project: "str | None") -> "str | None":
    if s:
        return s.get("cwd")
    rel = (project or "").lstrip("/")
    return os.path.join(config.BASE_PATH, rel) if rel else None


def _post_policy(path: str, body: dict, chat_id: int) -> "tuple[dict, int]":
    """SETTINGS > Agent Tools: a level's pick. `on` null clears it."""
    s = _owned(chat_id, body.get("session_id"))
    project = body.get("project") or (s or {}).get("project")
    level = str(body.get("level") or "machine")
    on = body.get("on")
    try:
        if path == "tool-policy":
            tool_policy.set_pick(level, str(body.get("section")), str(body.get("name")), str(body.get("agent")),
                                 None if on is None else on is True, project, s)
            return {"ok": True}, 200
        if path == "tool-policy/patterns":
            return {"patterns": tool_policy.set_patterns(level, body.get("patterns") or [], project, s)}, 200
        if path == "rules":
            rules.set_rule(level, str(body.get("id")), None if on is None else on is True, body.get("fields"), project, s)
            return {"ok": True, "rules": rules.listing(project, _owned(chat_id, body.get("session_id")))}, 200
    except ValueError as e:
        return {"error": str(e)}, 400
    return {"error": "not found"}, 404


def _post_hooks(body: dict, chat_id: int) -> "tuple[dict, int]":
    s = _owned(chat_id, body.get("session_id"))
    cwd = _cwd_of(s, body.get("project") or (s or {}).get("project"))
    act = str(body.get("action") or "")
    try:
        if act == "add":
            hooks_config.add(str(body.get("agent")), str(body.get("scope") or "user"), str(body.get("event")),
                             str(body.get("matcher") or ""), str(body.get("command") or ""), cwd, body.get("timeout"))
        elif act == "edit":
            hooks_config.edit(str(body.get("id")), str(body.get("event")), str(body.get("matcher") or ""),
                              str(body.get("command") or ""), cwd, body.get("timeout"))
        elif act == "remove":
            hooks_config.remove(str(body.get("id")), cwd)
        elif act == "copy":
            hooks_config.copy_to(str(body.get("id")), str(body.get("agent")), cwd)
        else:
            return {"error": "action must be add, edit, remove or copy"}, 400
    except ValueError as e:
        return {"error": str(e)}, 400
    return hooks_config.listing(cwd), 200


def _post_dir(path: str, body: dict, chat_id: int) -> "tuple[dict, int]":
    root = image_root(chat_id, body.get("session_id"), body.get("project"))
    if not root:
        return {"error": "no project"}, 404
    try:
        if path == "mystical-dir/delete":
            mystical_dir.delete(root, str(body.get("path") or ""), body.get("confirm") is True)
            return {"ok": True}, 200
        if path == "mystical-dir/keep":
            mystical_dir.set_keep(root, str(body.get("path") or ""), body.get("on") is True)
            return {"ok": True}, 200
        if path == "mystical-dir/clear":
            return mystical_dir.clear_stale(root, int(body.get("days") or 30)), 200
    except (ValueError, OSError) as e:
        return {"error": str(e)}, 400
    return {"error": "not found"}, 404


def _post_mcp(path: str, body: dict) -> "tuple[dict, int]":
    name = str(body.get("name") or "")
    cwd = body.get("cwd") or None
    d = (mcp_share.definitions(cwd).get(name) or {}).get("def")
    if d is None:
        return {"error": "no such server"}, 404
    if path == "mcp-share":
        if "tool" in body:
            mcp_share.set_tool(name, str(body["tool"]), body.get("on") is True)
        else:
            mcp_share.set_share(name, str(body.get("agent") or ""), body.get("on") is True)
        return {"ok": True}, 200
    if path == "mcp-share/tools":
        try:
            tools = mcp_share.tools_of(name, d, refresh=True)
        except Exception as e:  # noqa: BLE001 - the row says why
            return {"error": str(e)}, 502
        return {"tools": [{"name": t.get("name"), "sensitive": bool(mcp_share.SENSITIVE.search(t.get("name") or "")),
                           "on": mcp_share.tool_allowed(name, t.get("name") or "")} for t in tools]}, 200
    if path == "mcp-share/login":
        if not d.get("url"):
            return {"error": "only a remote server has a login"}, 400
        try:
            return {"url": mcp_oauth.begin(name, d["url"])}, 200
        except Exception as e:  # noqa: BLE001
            return {"error": str(e)}, 502
    if path == "mcp-share/logout":
        mcp_oauth.logout(name)
        return {"ok": True}, 200
    return {"error": "not found"}, 404


def oauth_callback(qs: dict) -> str:
    """The browser's landing page after a login: plain words."""
    state, code = _one(qs, "state"), _one(qs, "code")
    if _one(qs, "error"):
        return f"The login didn't finish: {urllib.parse.unquote(_one(qs, 'error'))}. You can close this tab."
    try:
        name = mcp_oauth.finish(state, code)
    except Exception as e:  # noqa: BLE001
        return f"The login didn't finish: {e}. You can close this tab."
    return f"Logged in to {name} for shared use. You can close this tab."
