"""The routes for multi-agent chats, in one place for both servers.

The dashboard calls these under /local/, the Mini App under /api/, and each passes the
path past that prefix: same JSON from the same function (bridge-feature-slice's "two
servers, one shape"). Only the routes differ in who may call: the servers' own auth has
already run. Settings like the switch answer whatever it says; everything else is a 409
while it's off, so a stale page reads a plain reason instead of acting.

get() and post() return (body, status), or None for a path that isn't theirs.
"""

import urllib.parse

from bridge import (acp_agents, agent_tree, channel, experimental, handoff, mcp_oauth, mcp_share,
                    profiles, project_config, skill_share, store)

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


def get(path: str, qs: dict, chat_id: int) -> "tuple[dict, int] | None":
    if path == "experimental":
        return experimental.state(), 200
    if path not in ("tree", "channel", "session/handoff", "mcp-share", "skill-share"):
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
        return {**channel.view(chat), "chat": chat["id"], "rows": agent_tree.tree(chat)}, 200
    if path == "session/handoff":
        s = _owned(chat_id, _one(qs, "session"))
        if not s:
            return {"error": "not found"}, 404
        pid = _one(qs, "profile")
        target = profiles.get(pid) if pid else {}
        if pid and target is None:
            return {"error": "no such profile"}, 404
        return handoff.preview(s, target or {}), 200
    if path == "mcp-share":
        return {"servers": mcp_share.state(_one(qs, "cwd") or None, _agents()), "agents": _agents()}, 200
    if path == "skill-share":
        return {"skills": skill_share.state(_one(qs, "cwd") or None)}, 200
    return None


def post(path: str, body: dict, chat_id: int) -> "tuple[dict, int] | None":
    if path == "experimental":
        if "enabled" in body:
            experimental.set_enabled(body["enabled"] is True)
        if isinstance(body.get("defaults"), dict):
            try:
                experimental.set_defaults(body["defaults"])
            except ValueError as e:
                return {"error": str(e)}, 400
        return experimental.state(), 200
    if not path.startswith(("chat/", "channel/", "mcp-share", "skill-share", "project/helper")):
        return None
    if not experimental.enabled():
        return _OFF
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
