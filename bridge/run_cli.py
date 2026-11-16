"""`mystical prompt`, `run-status`, `runs`, `run-cancel`: the run API from a shell.

The client half of bridge/run_api.py, for scripts and other programs' servers.
It imports nothing from the bridge and reads one file, <state dir>/run-api.json
(the address and the run token the bridge wrote at boot), so it needs no .env,
starts in a few milliseconds and can't drag the bridge's config, or its
secrets, into the caller's process. bin/mystical runs it with `python3 -I`, as
the gateway relay is run: bridge/ holds modules named like other people's
(git.py, shell.py), and a script's own folder must not be on its import path.

Waiting is a loop of long polls (run_api.WAIT_MAX each), not one held request:
a bridge reloaded from the dashboard drops every connection, and the run
carries on in the new process. So a wait rides out RECONNECT_S of nobody
answering before it gives up.

Ending a wait (Ctrl-C, a timeout, the caller killing this process) never stops
the run: it is a session in the dashboard by then. `mystical run-cancel` does.

Exit codes, the same for every subcommand:
  0  fine: the run was accepted, listed, cancelled, or (when asked about one
     run, or waiting on it) it is done
  1  refused or anything else (a folder runs may not start in, a full queue,
     no such run)
  2  wrong usage
  3  the bridge isn't answering, or its run-api.json is missing or stale
  4  the run failed
  5  the run was cancelled
  6  the run isn't over: --wait SECONDS ran out, or run-status found it queued,
     running or waiting for input

Stdlib only.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

POLL_S = 25  # one long poll, under the server's WAIT_MAX
RECONNECT_S = 120  # how long a wait rides out a bridge that is restarting
EXIT = {"done": 0, "failed": 4, "cancelled": 5}
NOT_OVER = 6
USAGE = """usage:
  mystical prompt --cwd DIR [--title T] [--client NAME] [--ref R]
                  [--model M] [--effort low|medium|high]
                  [--wait [SECONDS]] [--json] <prompt | - | @file>
  mystical run-status ID [--wait [SECONDS]] [--json]
  mystical runs [--client NAME] [--limit N] [--json]
  mystical run-cancel ID [--json]

  prompt       start a session in DIR with that prompt and print the run's id.
               `-` reads the prompt from stdin, `@file` from a file. With
               --wait, block until the run ends (or SECONDS pass) and print
               its final response instead. --model picks the run's model
               (haiku, sonnet, opus, fable or a full id); without it the run
               gets the bridge's RUN_API_MODEL.
  run-status   one run: state, session link, and the response once done
  runs         recent runs, newest first
  run-cancel   stop a run (a queued one never starts)

  --json prints the run (or {"runs": [...]}) as one line of JSON.
  exit codes: 0 fine/done  1 refused/other  2 usage  3 bridge not answering
              4 failed  5 cancelled  6 not over yet (or --wait ran out)"""


class Down(Exception):
    """Nobody answered at the bridge's address."""


def _conn() -> dict:
    path = os.environ.get("MYSTICAL_RUN_API") or os.path.join(
        os.path.expanduser(os.environ.get("BRIDGE_STATE_DIR") or "~/.bridge_state"),
        "run-api.json",
    )
    try:
        with open(path, encoding="utf-8") as f:
            c = json.load(f)
        return {"url": str(c["url"]).rstrip("/"), "token": str(c["token"])}
    except (OSError, ValueError, KeyError, TypeError):
        raise Down(
            f"no run API address at {path}: is the bridge running, and new enough "
            "to have one? (mystical status)"
        )


_opener = urllib.request.build_opener(
    urllib.request.ProxyHandler({})
)  # loopback: never a proxy


def call(
    method: str, path: str, body: "dict | None" = None, timeout: float = 30
) -> "tuple[dict, int]":
    """One request. -> (json, status); raises Down when nothing answers."""
    c = _conn()
    req = urllib.request.Request(
        c["url"] + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"X-Run-Token": c["token"], "Content-Type": "application/json"},
    )
    try:
        with _opener.open(req, timeout=timeout) as r:
            return json.loads(r.read() or b"{}"), r.status
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read() or b"{}"), e.code
        except ValueError:
            return {"error": f"HTTP {e.code}"}, e.code
    except (OSError, ValueError) as e:  # refused, reset, timed out, half an answer
        raise Down(f"the bridge isn't answering at {c['url']}: {e}")


def _err(msg: str) -> None:
    print(f"mystical: {msg}", file=sys.stderr)


def _refused(out: dict, code: int) -> int:
    _err(out.get("error") or f"HTTP {code}")
    return 3 if code == 401 else 1


def _progress(run: dict, seen: list) -> None:
    """One stderr line per change of state, so a log shows where a wait stood."""
    now = (run["status"], run.get("detail") or "")
    if seen and seen[0] == now:
        return
    seen[:] = [now]
    if run["status"] in EXIT:
        return
    line = f"run {run['id']}: {run['status'].replace('_', ' ')}"
    if run["status"] == "queued" and run.get("queue_position"):
        line += f" (number {run['queue_position']} in line)"
    if now[1]:
        line += f": {now[1]}"
    if run["status"] == "waiting_for_input" and run.get("session_url"):
        line += f"; answer it at {run['session_url']}"
    _err(line)


def wait(run: dict, seconds: "float | None") -> dict:
    """Poll until the run is over or `seconds` pass (None: as long as it takes)."""
    deadline = None if seconds is None else time.monotonic() + seconds
    seen: list = []
    down_since = None
    while True:
        _progress(run, seen)
        if run["status"] in EXIT:
            return run
        left = None if deadline is None else deadline - time.monotonic()
        if left is not None and left <= 0:
            return run
        poll = POLL_S if left is None else max(1, min(POLL_S, int(left + 0.999)))
        try:
            out, code = call(
                "GET", f"/local/runs/{run['id']}?wait={poll}", timeout=poll + 15
            )
        except Down:
            down_since = down_since or time.monotonic()
            if time.monotonic() - down_since > RECONNECT_S:
                raise
            time.sleep(2)
            continue
        down_since = None
        if code != 200:
            raise SystemExit(_refused(out, code))
        run = out["run"]


def _show(run: dict, as_json: bool, answer_only: bool = False) -> int:
    """Print one run and return the exit code its state stands for."""
    code = EXIT.get(run["status"], NOT_OVER)
    if as_json:
        print(json.dumps(run))
        return code
    if answer_only:
        if run["status"] == "done":
            print(run.get("response") or "")
        elif run["status"] == "failed":
            _err(f"run {run['id']} failed: {run.get('error') or 'no reason given'}")
        elif run["status"] == "cancelled":
            _err(
                f"run {run['id']} was cancelled"
                + (f" ({run['detail']})" if run.get("detail") else "")
            )
        else:
            _err(
                f"run {run['id']} isn't over ({run['status'].replace('_', ' ')}); "
                f"it carries on: mystical run-status {run['id']}"
            )
        return code
    print(
        f"{run['id']}  {run['status']}"
        + (f"  ({run['detail']})" if run.get("detail") else "")
    )
    print(
        f"  client   {run['client']}"
        + (f"  ref {run['ref']}" if run.get("ref") else "")
    )
    print(f"  title    {run['title']}")
    print(f"  cwd      {run['cwd']}")
    if run.get("model") or run.get("effort"):
        print(
            f"  model    {run.get('model') or 'bridge default'}"
            + (f"  effort {run['effort']}" if run.get("effort") else "")
        )
    if run.get("session_url"):
        print(f"  session  {run['session_url']}")
    for label, key in (
        ("created", "created"),
        ("started", "started"),
        ("finished", "finished"),
    ):
        if run.get(key):
            print(
                f"  {label:<8} {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(run[key]))}"
            )
    if run.get("error"):
        print(f"  error    {run['error']}")
    if run["status"] == "done":
        print()
        print(run.get("response") or "")
    return code


def _read_prompt(words: list) -> str:
    if words == ["-"]:
        return sys.stdin.read()
    if len(words) == 1 and words[0].startswith("@") and len(words[0]) > 1:
        with open(os.path.expanduser(words[0][1:]), encoding="utf-8") as f:
            return f.read()
    return " ".join(words)


def _split_wait(argv: list) -> list:
    """`--wait [SECONDS]` takes its number only when the next word is one, so
    `--wait "fix the tests"` keeps the prompt a prompt."""
    out, i = [], 0
    while i < len(argv):
        a = argv[i]
        if a == "--":
            return out + argv[i:]
        if a == "--wait":
            nxt = argv[i + 1] if i + 1 < len(argv) else ""
            try:
                float(nxt)
                out.append(f"--wait={nxt}")
                i += 2
                continue
            except ValueError:
                out.append("--wait=inf")
        else:
            out.append(a)
        i += 1
    return out


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        _err(message)
        print(USAGE, file=sys.stderr)
        raise SystemExit(2)


def _seconds(ns) -> "float | None":
    return None if ns.wait == float("inf") else max(0.0, ns.wait)


def main(argv: list) -> int:
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(USAGE)
        return 0 if argv else 2
    cmd, rest = argv[0], _split_wait(argv[1:])
    p = _Parser(prog=f"mystical {cmd}", add_help=False)
    p.add_argument("--json", action="store_true")
    if cmd == "prompt":
        p.add_argument("--cwd", required=True)
        p.add_argument("--title", default="")
        p.add_argument("--client", default="")
        p.add_argument("--ref", default="")
        p.add_argument("--model", default="")
        p.add_argument("--effort", default="")
        p.add_argument("--wait", type=float, default=None)
        p.add_argument("prompt", nargs="+")
    elif cmd == "run-status":
        p.add_argument("--wait", type=float, default=None)
        p.add_argument("id")
    elif cmd == "runs":
        p.add_argument("--client", default="")
        p.add_argument("--limit", type=int, default=20)
    elif cmd == "run-cancel":
        p.add_argument("id")
    else:
        _err(f"unknown command: {cmd}")
        print(USAGE, file=sys.stderr)
        return 2
    if any(a in ("-h", "--help") for a in rest):
        print(USAGE)
        return 0
    ns = p.parse_args(rest)

    if cmd == "prompt":
        try:
            prompt = _read_prompt(ns.prompt)
        except OSError as e:
            _err(f"can't read the prompt: {e}")
            return 2
        if not prompt.strip():
            _err("the prompt is empty")
            return 2
        body = {
            "cwd": os.path.abspath(os.path.expanduser(ns.cwd)),
            "prompt": prompt,
            "title": ns.title,
            "client": ns.client,
            "ref": ns.ref,
        }
        # Sent only when asked for; the bridge checks the names. One running
        # code from before these keys ignores them and uses its own default.
        if ns.model.strip():
            body["model"] = ns.model.strip()
        if ns.effort.strip():
            body["effort"] = ns.effort.strip()
        out, code = call("POST", "/local/runs", body)
        if code != 202:
            return _refused(out, code)
        run = out["run"]
        if ns.wait is None:
            print(json.dumps(run) if ns.json else run["id"])
            return 0
        _err(f"run {run['id']} submitted")
        return _show(wait(run, _seconds(ns)), ns.json, answer_only=True)

    if cmd == "run-status":
        out, code = call("GET", f"/local/runs/{urllib.parse.quote(ns.id, safe='')}")
        if code != 200:
            return _refused(out, code)
        run = out["run"]
        if ns.wait is not None:
            run = wait(run, _seconds(ns))
        return _show(run, ns.json)

    if cmd == "runs":
        q = urllib.parse.urlencode({"client": ns.client, "limit": ns.limit})
        out, code = call("GET", f"/local/runs?{q}")
        if code != 200:
            return _refused(out, code)
        if ns.json:
            print(json.dumps({"runs": out["runs"]}))
            return 0
        if not out["runs"]:
            print("No runs.")
        for r in out["runs"]:
            when = time.strftime("%m-%d %H:%M", time.localtime(r["created"]))
            print(
                f"{r['id']}  {r['status']:<17}  {when}  {r['client']:<10}  "
                f"{r.get('model') or '-':<8}  {r['title']}"
            )
        return 0

    out, code = call(
        "POST", f"/local/runs/{urllib.parse.quote(ns.id, safe='')}/cancel", {}
    )
    if code != 200:
        return _refused(out, code)
    if ns.json:
        print(json.dumps(out["run"]))
    else:
        r = out["run"]
        print(
            f"{r['id']}  {r['status']}"
            + (f"  ({r['detail']})" if r.get("detail") else "")
        )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Down as e:
        _err(str(e))
        sys.exit(3)
    except KeyboardInterrupt:
        sys.exit(130)
