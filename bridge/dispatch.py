"""Telegram message and callback dispatch (slash commands + plain-text prompts)."""

import os
import sys
import threading

from bridge import accounts, config, graphmap, ladder, report, state, store
from bridge.browser import browser_view, list_dirs, open_browser, rel, within_base
from bridge.devserver import handle_logs, handle_server, server_status
from bridge.runner import handle_task
from bridge.telegram import answer_cb, edit, panel_kb, send

HELP = (
    "Claude Code remote bridge.\n\n"
    f"Base path: {config.BASE_PATH}\n\n"
    "Pick a project, then send prompts to work on it.\n\n"
    "/projects — browse and select a project\n"
    "/project — show the active project\n"
    "/app — open the Mini App control panel\n"
    "/new — fresh Claude session for the active project\n"
    "/server [cmd] — start the dev server · /server stop\n"
    "/logs [n] — recent server output\n"
    "/map [query] — project map: summary · /map build · /map <thing>\n"
    "/next — ranked next steps across your recent repos · /next refresh\n"
    "/report — this week per project (time · tokens) · /report last\n"
    "/accounts — Claude logins and their usage · /accounts add\n"
    "/policy — what to do when a chat hits the usage limit\n"
    "/status — everything at a glance\n"
    "/help — this message")


def _open_app(chat_id: int):
    if not config.MINIAPP_ENABLE:
        send(chat_id, "Mini App is disabled (set MINIAPP_ENABLE=1 to enable).")
        return
    key = state.project_key(chat_id)
    s = store.latest_session(chat_id, key)
    kb = panel_kb(chat_id, s["id"] if s else None, key)
    if kb:
        send(chat_id, "🛠 Open the control panel:", kb)
    else:
        send(chat_id, "Mini App URL not ready yet — try again in a moment.")


def _handle_map(chat_id: int, arg: str):
    """Runs in a thread — graphify build/explain shell out for seconds."""
    cwd = state.project_dir(chat_id)
    # Switched off or not installed — say so once, before promising a build.
    blocked = graphmap.blocked_reason()
    if blocked:
        send(chat_id, blocked)
        return
    if arg == "build":
        send(chat_id, "🗺 Learning your project — better and faster responses…")
        ok, msg = graphmap.update(cwd)
        st = graphmap.graph_state(cwd)
        tag = f" (commit {st['built_commit']})" if ok and st["built_commit"] else ""
        send(chat_id, ("✅ " if ok else "⚠️ ") + msg + tag)
        return
    st = graphmap.graph_state(cwd)
    if not st["exists"]:
        send(chat_id, "No project map yet — /map build to create one.")
        return
    if arg:
        send(chat_id, graphmap.explain(cwd, arg))
        return
    stale = " · stale (repo has moved on)" if st["stale"] else ""
    send(chat_id, f"🗺 Map built @{st['built_commit']}{stale}\n\n"
                  f"{graphmap.graph_pack(cwd)}\n\n"
                  "/map <thing> to explain it · /map build to refresh")


_EFFORT_MARK = {"small": "·", "medium": "··", "large": "···"}


def _next_text(board: dict) -> tuple[str, dict | None]:
    items = board["items"][:5]
    if not items:
        return ("Nothing to suggest — no repo with session activity in the last "
                f"{config.NEXTUP_DAYS} days.", None)
    lines = ["🔭 Next up", ""]
    for n, it in enumerate(items, 1):
        lines.append(f"{n}. {it['title']}")
        lines.append(f"   {it['repo']} {_EFFORT_MARK.get(it['effort'], '··')} {it['why']}")
    if not board.get("enabled"):
        lines.append("\nRanking is off — this is the plain heuristic order. "
                     "Switch NEXT-UP BOARD on in the dashboard's AI tab.")
    kb = {"inline_keyboard": [
        [{"text": f"▸ {n}", "callback_data": f"nx:{it['id']}"}
         for n, it in enumerate(items, 1)],
        [{"text": "↻ refresh", "callback_data": "nx:*"}]]}
    return ("\n".join(lines), kb)


def _handle_next(chat_id: int, arg: str):
    """Runs in a thread — a cold board is one read-only agent per changed repo."""
    from bridge import nextup
    board = nextup.board(chat_id)
    if arg == "refresh" or not board["items"]:
        send(chat_id, "🔭 Looking over your recent repos…")
        board = nextup.refresh(chat_id)
    text, kb = _next_text(board)
    send(chat_id, text, kb)


def _next_callback(cb: dict, chat_id: int, msg_id: int, data: str) -> None:
    """▸ N starts the item in its own repo; ↻ recomputes the board."""
    from bridge import nextup
    ref = data.split(":", 1)[1]
    if ref == "*":
        answer_cb(cb["id"], "Refreshing…")
        edit(chat_id, msg_id, "🔭 Looking over your recent repos…")
        text, kb = _next_text(nextup.refresh(chat_id))
        edit(chat_id, msg_id, text, kb)
        return
    item = nextup.item(chat_id, ref)
    if not item:
        answer_cb(cb["id"], "That board is gone — /next again.")
        return
    # The bot runs in the chat's active project, so starting an item moves the
    # chat to its repo — the same switch the project browser's "use" makes.
    state.active[chat_id] = item["cwd"]
    session = store.create_session(chat_id, rel(item["cwd"]), origin="bot",
                                   cwd=item["cwd"])
    store.set_subject_title(session["id"], item["title"])
    if not state.acquire_run(session["id"], chat_id):
        answer_cb(cb["id"], "That session is busy.")
        return
    answer_cb(cb["id"], "Starting…")
    edit(chat_id, msg_id, f"▸ {item['title']}\n{rel(item['cwd'])}")
    threading.Thread(target=handle_task,
                     args=(chat_id, item["prompt"], session), daemon=True).start()


def on_message(msg: dict):
    chat_id = msg["chat"]["id"]
    text = (msg.get("text") or "").strip()

    if not config.ALLOWED_CHAT_IDS:
        print(f"[discovery] chat_id={chat_id} "
              f"({msg['chat'].get('username', '?')}) — add to ALLOWED_CHAT_IDS.")
        send(chat_id, f"Discovery mode. Your chat_id is {chat_id}. "
                      "Add it to ALLOWED_CHAT_IDS and restart.")
        return
    if chat_id not in config.ALLOWED_CHAT_IDS:
        print(f"[blocked] unauthorized chat_id={chat_id}", file=sys.stderr)
        return
    if not text:
        send(chat_id, "Send a text prompt, or /help.")
        return

    cmd0 = text.split()[0]
    if text in ("/start", "/help"):
        send(chat_id, HELP)
        return
    if cmd0 == "/projects":
        open_browser(chat_id)
        return
    if cmd0 == "/project":
        send(chat_id, f"Active project: {rel(state.project_dir(chat_id))}"
                      + ("" if chat_id in state.active else "  (default — none selected)"))
        return
    if cmd0 == "/app":
        _open_app(chat_id)
        return
    if text == "/new":
        key = state.project_key(chat_id)
        s = store.create_session(chat_id, key)
        send(chat_id, "🆕 Fresh Claude session.", panel_kb(chat_id, s["id"], key))
        return
    if cmd0 == "/server":
        threading.Thread(target=handle_server,
                         args=(chat_id, text[len("/server"):].strip()),
                         daemon=True).start()
        return
    if cmd0 == "/logs":
        handle_logs(chat_id, text[len("/logs"):].strip())
        return
    if cmd0 == "/map":
        threading.Thread(target=_handle_map,
                         args=(chat_id, text[len("/map"):].strip()),
                         daemon=True).start()
        return
    if cmd0 == "/next":
        # Scouting spawns a read-only agent per changed repo — always off-thread.
        threading.Thread(target=_handle_next,
                         args=(chat_id, text[len("/next"):].strip()),
                         daemon=True).start()
        return
    if cmd0 == "/report":
        back = 1 if text[len("/report"):].strip() == "last" else 0
        send(chat_id, report.render(report.weekly(chat_id, back=back)))
        return
    if cmd0 in ("/accounts", "/policy"):
        # /accounts reads every account's usage meter — network, so off-thread.
        threading.Thread(target=handle_fallback_command, args=(chat_id, text),
                         daemon=True).start()
        return
    if text == "/status":
        running = state.running_chats()
        st = f"busy · {len(running)} run(s)" if running else "idle"
        key = state.project_key(chat_id)
        s = store.latest_session(chat_id, key)
        sid = (s["title"] or s["id"][:8]) if s else "none yet"
        send(chat_id, f"Project: {rel(state.project_dir(chat_id))}\nClaude: {st}\n"
                      f"Server: {server_status()}\n"
                      f"Mini App: {'live' if state.miniapp_url else 'off'}\n"
                      f"Session: {sid}",
             panel_kb(chat_id, s["id"] if s else None, key))
        return

    # Plain text -> prompt to Claude in the active project. Claim this session's
    # run slot; a run in another project/session is unaffected.
    session = store.ensure_session(chat_id, state.project_key(chat_id))
    if not state.acquire_run(session["id"], chat_id):
        send(chat_id, "⏳ Still working on this session — please wait.")
        return
    threading.Thread(target=handle_task, args=(chat_id, text, session), daemon=True).start()


# --- fallback ladder: the usage-limit approval card + /accounts, /policy ------

def _fallback_callback(cb: dict, chat_id: int, msg_id: int, data: str) -> None:
    """Buttons on the usage-limit card: fb:a:<sid>:<slot> | fb:f:<sid>:<provider>
    | fb:w:<sid>. Owner-scoped — a card only spends the accounts of the chat whose
    session it belongs to."""
    parts = data.split(":", 3)
    sid = parts[2] if len(parts) > 2 else ""
    session = store.get_session(sid) if sid else None
    if not session or session["chat_id"] != chat_id:
        answer_cb(cb["id"])
        return
    kind = parts[1]
    if kind == "w":
        answer_cb(cb["id"], "Waiting for reset")
        edit(chat_id, msg_id, "⏳ Waiting for the usage limit to reset.")
        return
    if kind == "a" and len(parts) == 4 and parts[3].isdigit():
        slot = int(parts[3])
        rung = {"kind": "account", "slot": slot, "label": f"account {slot}"}
    elif kind == "f" and len(parts) == 4 and parts[3]:
        rung = {"kind": "free", "provider": parts[3],
                "label": f"free agent ({parts[3]})"}
    else:
        answer_cb(cb["id"])
        return
    answer_cb(cb["id"], "Starting…")
    taken = ladder.take(session, chat_id, rung)
    edit(chat_id, msg_id,
         f"↪ Continuing on {rung['label']}." if taken else
         "⚠️ Couldn't hand the work over — still parked until the limit resets.")


def _policy_text() -> str:
    return ("Usage-limit fallback: what happens when a chat hits the limit.\n\n"
            f"Current default: {ladder.default_policy()}\n\n"
            "/policy ask — offer the choices, stay parked until you pick\n"
            "/policy auto — switch to the best account (or free agent) at once\n"
            "/policy wait — only wait for the reset\n\n"
            "Sets the active project's latest chat; new chats use the default.")


def _accounts_text() -> str:
    rows = accounts.list_accounts()
    if not rows:
        return ("No Claude login found. Run `claude /login` in a terminal, then "
                "/accounts add.")
    lines = []
    for a in rows:
        left = accounts.headroom(a["slot"])
        meter = f"{left}% left" if left is not None else "usage unknown"
        tags = " (default)" if a["default"] else ""
        tags += " (disabled)" if a["disabled"] else ""
        lines.append(f"{a['slot']}. {a['email'] or 'unknown'} — {meter}{tags}")
    return ("Claude accounts:\n" + "\n".join(lines) +
            "\n\n/accounts login — sign in as another account (link + code, no terminal)\n"
            "/accounts add — snapshot the login currently in ~/.claude\n"
            "/accounts remove <n> · /accounts disable <n> · /accounts enable <n>")


def handle_fallback_command(chat_id: int, text: str) -> bool:
    """Handle /accounts and /policy. Returns whether the text was ours."""
    cmd, _, arg = text.strip().partition(" ")
    arg = arg.strip()
    if cmd == "/policy":
        if not arg:
            send(chat_id, _policy_text())
        elif arg not in ladder.POLICIES:
            send(chat_id, f"Unknown policy {arg!r}. Use: " +
                 ", ".join(ladder.POLICIES))
        else:
            s = store.latest_session(chat_id, state.project_key(chat_id))
            if not s:
                send(chat_id, "No chat here yet — send a prompt first.")
            else:
                store.set_fallback_policy(s["id"], arg)
                send(chat_id, f"✅ Fallback policy for this chat: {arg}")
        return True
    if cmd != "/accounts":
        return False
    verb, _, rest = arg.partition(" ")
    rest = rest.strip()
    try:
        if verb == "add":
            send(chat_id, f"✅ Added the current login as account {accounts.add()}. "
                          "It stays available while you log back in as your usual one.")
        elif verb == "login":
            # The sign-in parks on its code prompt in a fresh profile; /accounts
            # code <code> finishes it. Nothing here touches the ambient login.
            began = accounts.begin_login()
            send(chat_id, f"Open this and sign in as the account you want to add:\n\n"
                          f"{began['url']}\n\nThen send: /accounts code <the code it gives you>")
        elif verb == "code" and rest:
            waiting = accounts.pending_login()
            if not waiting:
                send(chat_id, "No sign-in is waiting for a code. Start one with "
                              "/accounts login.")
            else:
                done = accounts.submit_login_code(waiting["slot"], rest)
                send(chat_id, f"✅ Added {done['email'] or 'the account'} as account "
                              f"{done['slot']}.")
        elif verb in ("remove", "disable", "enable") and rest.isdigit():
            getattr(accounts, verb)(int(rest))
            send(chat_id, f"✅ Account {rest} {verb}d.")
        else:
            send(chat_id, _accounts_text())
    except accounts.NoLogin:
        send(chat_id, "No login in ~/.claude to copy. Run `claude /login` in a "
                      "terminal first, then /accounts add.")
    except accounts.LoginFailed as e:
        send(chat_id, f"⚠️ {e}")
    except ValueError as e:
        send(chat_id, f"⚠️ {e}")
    return True


def handle_callback(cb: dict):
    chat_id = cb["message"]["chat"]["id"]
    msg_id = cb["message"]["message_id"]
    data = cb.get("data", "")

    if config.ALLOWED_CHAT_IDS and chat_id not in config.ALLOWED_CHAT_IDS:
        answer_cb(cb["id"])
        return

    cur = state.browse.get(chat_id, config.BASE_PATH)

    if data.startswith("nav:"):
        idx = int(data.split(":", 1)[1])
        dirs = list_dirs(cur)
        if 0 <= idx < len(dirs):
            target = os.path.join(cur, dirs[idx])
            if within_base(target):
                state.browse[chat_id] = target
        answer_cb(cb["id"])
        text, kb = browser_view(chat_id)
        edit(chat_id, msg_id, text, kb)

    elif data == "up":
        parent = os.path.dirname(cur)
        state.browse[chat_id] = parent if within_base(parent) else config.BASE_PATH
        answer_cb(cb["id"])
        text, kb = browser_view(chat_id)
        edit(chat_id, msg_id, text, kb)

    elif data == "use":
        state.active[chat_id] = cur   # per-project sessions resolve on first message
        answer_cb(cb["id"], "Selected ✅")
        edit(chat_id, msg_id, f"✅ Active project: {rel(cur)}")
        send(chat_id,
             "Now you can:\n"
             "• send a prompt to work on it\n"
             "• /app to open the control panel\n"
             f"• /server to start it (default: {config.START_CMD})\n"
             "• /preview to open it in your browser")

    elif data.startswith("fb:"):
        _fallback_callback(cb, chat_id, msg_id, data)

    elif data.startswith("nx:"):
        threading.Thread(target=_next_callback,
                         args=(cb, chat_id, msg_id, data), daemon=True).start()

    else:
        answer_cb(cb["id"])
