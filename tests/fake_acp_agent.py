"""A scripted ACP v1 agent for tests/test_acp.py (a script, not a test module).

Env FAKE_ACP scripts it: caps, new_error, prompt_error, options, modes, replay,
open_delay, stop, ignore_cancel, and turn, a list of steps: update, permission,
vendor, stdout, wait_cancel, sleep, exit, orphan (the leader exits, a child holds
its stdout), helper (a child; stdout on /dev/null unless keep_stdout). Messages
received go to env FAKE_ACP_LOG as JSON lines, the environ to LOG + ".env".

One reader (the main thread) dispatches every line: replies to its own requests,
notifications (session/cancel sets a flag), client requests. The prompt runs on
its own thread, waiting on the reader's state, so a cancel lands mid-wait.
"""
import itertools
import json
import os
import subprocess
import sys
import threading
import time

S = json.loads(os.environ.get("FAKE_ACP") or "{}")
LOG = os.environ.get("FAKE_ACP_LOG")
cond = threading.Condition()
replies, flags = {}, {"cancel": False}
wlock, ids = threading.Lock(), itertools.count(1)


def write(raw: bytes):
    with wlock:
        sys.stdout.buffer.write(raw + b"\n")
        sys.stdout.buffer.flush()


def send(**msg):
    write(json.dumps({"jsonrpc": "2.0", **msg}).encode())


def update(sid, u):
    send(method="session/update", params={"sessionId": sid, "update": u})


def cancelled():
    return flags["cancel"] and not S.get("ignore_cancel")


def ask(method, params):
    """A request of the agent's own: blocks until the reader has the reply."""
    rid = next(ids)
    send(id=rid, method=method, params=params)
    with cond:
        cond.wait_for(lambda: rid in replies)
        return replies.pop(rid)


def state():
    return {k: S[v] for k, v in (("configOptions", "options"), ("modes", "modes")) if v in S}


def spawn(secs, name, **kw):
    """A child in this group, pid in LOG.<name>; pgrep -f fake_acp_agent finds it."""
    child = subprocess.Popen([sys.executable, "-c",
                              f"import time; time.sleep({secs})  # fake_acp_agent {name}"], **kw)
    with open(f"{LOG}.{name}", "w") as f:
        f.write(str(child.pid))


def prompt(rid, sid):
    if S.get("prompt_error"):
        return send(id=rid, error=S["prompt_error"])
    for step in S.get("turn", []):
        if cancelled():
            break
        if "update" in step:
            update(sid, step["update"])
        elif "permission" in step:
            ask("session/request_permission", {"sessionId": sid, **step["permission"]})
        elif "vendor" in step:
            ask(step["vendor"], {"sessionId": sid})
        elif "stdout" in step:
            write(step["stdout"].encode())
        elif "wait_cancel" in step:
            with cond:
                cond.wait_for(lambda: flags["cancel"])
        elif "sleep" in step:
            with cond:
                cond.wait_for(cancelled, step["sleep"])
        elif "exit" in step:
            sys.stderr.write(f"fake agent: dying with {step['exit']}\n")
            sys.stderr.flush()
            os._exit(step["exit"])
        elif "orphan" in step:
            spawn(step["orphan"], "child")
            os._exit(0)
        elif "helper" in step:
            spawn(step["helper"], "helper",
                  stdout=None if step.get("keep_stdout") else subprocess.DEVNULL)
    send(id=rid, result={"stopReason": "cancelled" if cancelled() else S.get("stop", "end_turn")})


def handle(rid, method, p):
    if method in ("session/new", "session/load", "session/resume"):
        time.sleep(S.get("open_delay", 0))
    if method == "initialize":
        res = {"protocolVersion": 1, "agentCapabilities": S.get("caps", {"loadSession": True}),
               "agentInfo": {"name": "fake", "version": "0"}}
    elif method == "session/new":
        if S.get("new_error"):
            return send(id=rid, error=S["new_error"])
        res = {"sessionId": f"s-{os.getpid()}", **state()}
    elif method in ("session/load", "session/resume"):
        for u in S.get("replay", []) if method == "session/load" else []:
            update(p["sessionId"], u)
        res = state()
    elif method == "session/set_config_option":
        res = {"configOptions": S.get("options", [])}
    elif method in ("session/set_mode", "session/delete", "session/close"):
        res = {}
    elif method == "session/prompt":
        return threading.Thread(target=prompt, args=(rid, p["sessionId"]), daemon=True).start()
    else:
        return send(id=rid, error={"code": -32601, "message": f"unknown method {method}"})
    send(id=rid, result=res)


def main():
    if LOG:
        open(LOG, "w").close()
        with open(LOG + ".env", "w") as f:
            json.dump(dict(os.environ), f)
    for line in sys.stdin.buffer:
        msg = json.loads(line)
        if LOG:
            with open(LOG, "a") as f:
                f.write(json.dumps(msg) + "\n")
        if "method" not in msg:                     # a reply to one of ours
            with cond:
                replies[msg["id"]] = msg
                cond.notify_all()
        elif "id" not in msg:                       # a notification
            if msg["method"] == "session/cancel":
                with cond:
                    flags["cancel"] = True
                    cond.notify_all()
        else:
            handle(msg["id"], msg["method"], msg.get("params") or {})
    os._exit(0)   # stdin closed: the client is done with us, even mid-step


main()
