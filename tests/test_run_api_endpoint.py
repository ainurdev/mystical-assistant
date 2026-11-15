"""The run API over a real socket: the dashboard's gates in front of
bridge/run_api.py, and bin/mystical's four subcommands against it."""
import json
import os
import subprocess
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

from bridge import config, run_api
from bridge.dashboard import server as dash
from tests.test_run_api import job_of, until, world  # noqa: F401 - `world` is the fixture

MYSTICAL = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin", "mystical")


@pytest.fixture
def served(world, monkeypatch):  # noqa: F811
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), dash.Handler)
    port = httpd.server_address[1]
    monkeypatch.setattr(config, "DASH_PORT", port)
    monkeypatch.setattr(dash, "_HOSTS", {f"127.0.0.1:{port}"})
    monkeypatch.setattr(dash, "_ORIGINS", {f"http://127.0.0.1:{port}"})
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    run_api.boot()
    world.update(port=port, url=f"http://127.0.0.1:{port}", token=run_api.token())
    yield world
    httpd.shutdown()
    httpd.server_close()


def http(served, method, path, body=None, **headers):
    req = urllib.request.Request(served["url"] + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers=headers)
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=10) as r:
            return json.loads(r.read()), r.status
    except urllib.error.HTTPError as e:
        return json.loads(e.read() or b"{}"), e.code


def cli(served, *args, stdin=None, timeout=30):
    p = subprocess.run([MYSTICAL, *args], capture_output=True, text=True, input=stdin, timeout=timeout,
                       env={**os.environ, "MYSTICAL_RUN_API": run_api.conn_path()})
    return p.returncode, p.stdout, p.stderr


# --- the gates ---------------------------------------------------------------------

def test_a_run_goes_in_and_comes_back_over_http(served):
    tok = {"X-Run-Token": served["token"]}
    out, code = http(served, "POST", "/local/runs",
                     {"cwd": served["atlas"], "prompt": "Do the jobs.", "client": "atlas"}, **tok)
    assert code == 202 and out["run"]["status"] == "running"
    rid = out["run"]["id"]
    threading.Timer(0.2, lambda: job_of(served, rid).end("done", result="3 jobs done.")).start()
    out, code = http(served, "GET", f"/local/runs/{rid}?wait=10", **tok)
    assert code == 200 and out["run"]["status"] == "done" and out["run"]["response"] == "3 jobs done."
    assert [r["id"] for r in http(served, "GET", "/local/runs?client=atlas", **tok)[0]["runs"]] == [rid]


def test_no_token_no_run_and_the_dashboard_token_is_not_it(served):
    body = {"cwd": served["atlas"], "prompt": "x"}
    assert http(served, "POST", "/local/runs", body)[1] == 401
    assert http(served, "POST", "/local/runs", body, **{"X-Dash-Token": config.DASH_TOKEN})[1] == 401
    assert http(served, "POST", "/local/runs", body, **{"X-Run-Token": "guess"})[1] == 401
    assert http(served, "GET", "/local/runs")[1] == 401
    assert http(served, "GET", "/local/runs/abc")[1] == 401
    assert not served["calls"]


def test_the_run_token_opens_nothing_else(served):
    tok = {"X-Run-Token": served["token"]}
    assert http(served, "POST", "/local/select", {"project": "/atlas"}, **tok)[1] == 401
    assert http(served, "POST", "/local/run", {"prompt": "x"}, **tok)[1] == 401
    assert http(served, "POST", "/local/sessions", {"project": "/atlas"}, **tok)[1] == 401


def test_the_loopback_gates_still_apply(served):
    tok = {"X-Run-Token": served["token"]}
    body = {"cwd": served["atlas"], "prompt": "x"}
    assert http(served, "GET", "/local/runs", Host="evil.example", **tok)[1] == 403          # DNS rebinding
    assert http(served, "POST", "/local/runs", body, Host="evil.example", **tok)[1] == 403
    assert http(served, "POST", "/local/runs", body, Origin="https://evil.example", **tok)[1] == 403
    assert http(served, "GET", "/local/runs", **{"Sec-Fetch-Site": "cross-site"}, **tok)[1] == 403
    assert not served["calls"]


def test_a_folder_runs_may_not_start_in_is_a_403(served):
    out, code = http(served, "POST", "/local/runs", {"cwd": served["loose"], "prompt": "x"},
                     **{"X-Run-Token": served["token"]})
    assert code == 403 and "git repository" in out["error"]


# --- bin/mystical --------------------------------------------------------------------

def test_prompt_prints_the_run_id_and_returns(served):
    code, out, err = cli(served, "prompt", "--cwd", served["atlas"], "--client", "atlas",
                         "--title", "Queue", "--ref", "r1", "Work", "through", "the", "queue.")
    assert code == 0, err
    rid = out.strip()
    run = run_api.get(rid)
    assert (run["status"], run["client"], run["title"], run["ref"]) == ("running", "atlas", "Queue", "r1")
    assert served["calls"][0]["prompt"].startswith("Work through the queue.")


def test_prompt_wait_prints_the_answer_and_exits_0(served):
    def finish():
        until(lambda: run_api.listed())
        job_of(served, run_api.listed()[0]["id"]).end("done", result="Finished 2 jobs.\nNone failed.")
    threading.Thread(target=finish, daemon=True).start()
    code, out, err = cli(served, "prompt", "--cwd", served["atlas"], "--wait", "Do it.")
    assert code == 0, err
    assert out == "Finished 2 jobs.\nNone failed.\n"
    assert "submitted" in err and served["calls"][0]["prompt"].startswith("Do it.")


def test_prompt_reads_stdin_and_files_and_json_is_the_run(served, tmp_path):
    f = tmp_path / "p.md"
    f.write_text("From a file.\n")
    code, out, _ = cli(served, "prompt", "--cwd", served["atlas"], "--json", f"@{f}")
    assert code == 0 and json.loads(out)["status"] == "running"
    code, out, _ = cli(served, "prompt", "--json", "--cwd", served["shop"], "-", stdin="From stdin.\n")
    assert code == 0 and json.loads(out)["cwd"] == served["shop"]
    assert [c["prompt"].split("\n")[0] for c in served["calls"]] == ["From a file.", "From stdin."]


def test_exit_codes_tell_failed_cancelled_and_timed_out_apart(served):
    def end(how, **kw):
        def go():
            until(lambda: run_api.listed() and run_api.listed()[0]["status"] == "running"
                  and run_api.listed()[0]["id"] not in seen)
            run = run_api.listed()[0]
            seen.add(run["id"])
            if how == "cancel":
                run_api.cancel(run["id"])
            else:
                job_of(served, run["id"]).end(how, **kw)
        threading.Thread(target=go, daemon=True).start()
    seen: set = set()

    end("error", error="the model refused")
    code, out, err = cli(served, "prompt", "--cwd", served["atlas"], "--wait", "a")
    assert (code, out) == (4, "") and "the model refused" in err

    end("cancel")
    code, out, err = cli(served, "prompt", "--cwd", served["atlas"], "--wait", "60", "b")
    assert (code, out) == (5, "") and "cancelled" in err

    t0 = time.time()
    code, out, err = cli(served, "prompt", "--cwd", served["atlas"], "--wait", "1", "--json", "c")
    assert code == 6 and time.time() - t0 < 15
    run = json.loads(out)
    assert run["status"] == "running" and run_api.get(run["id"])["status"] == "running"   # it carries on


def test_run_status_runs_and_run_cancel(served):
    _, out, _ = cli(served, "prompt", "--cwd", served["atlas"], "--client", "atlas", "x")
    rid = out.strip()
    code, out, _ = cli(served, "run-status", rid)
    assert code == 6 and rid in out and "running" in out and "/?s=" in out
    code, out, _ = cli(served, "runs", "--client", "atlas", "--json")
    assert code == 0 and [r["id"] for r in json.loads(out)["runs"]] == [rid]
    code, out, _ = cli(served, "runs", "--client", "cron")
    assert code == 0 and out.strip() == "No runs."
    code, out, _ = cli(served, "run-cancel", rid)
    assert code == 0 and rid in out
    code, out, _ = cli(served, "run-status", rid, "--wait", "10", "--json")
    assert code == 5 and json.loads(out)["status"] == "cancelled"
    code, _, err = cli(served, "run-cancel", rid)
    assert code == 1 and "already cancelled" in err
    assert cli(served, "run-status", "nope")[0] == 1


def test_run_status_of_a_done_run_shows_the_answer(served):
    _, out, _ = cli(served, "prompt", "--cwd", served["atlas"], "x")
    rid = out.strip()
    job_of(served, rid).end("done", result="The answer.")
    code, out, _ = cli(served, "run-status", rid, "--wait")
    assert code == 0 and out.rstrip().endswith("The answer.")


def test_refusals_usage_and_a_bridge_that_is_not_there(served, tmp_path):
    code, _, err = cli(served, "prompt", "--cwd", served["loose"], "x")
    assert code == 1 and "git repository" in err
    assert cli(served, "prompt", "x")[0] == 2                       # no --cwd
    assert cli(served, "prompt", "--cwd", served["atlas"])[0] == 2  # no prompt
    assert cli(served, "prompt", "--cwd", served["atlas"], "-", stdin="  ")[0] == 2
    assert cli(served, "run-status")[0] == 2
    assert not served["calls"]
    env = {**os.environ, "MYSTICAL_RUN_API": str(tmp_path / "none.json")}
    p = subprocess.run([MYSTICAL, "runs"], capture_output=True, text=True, env=env)
    assert p.returncode == 3 and "bridge" in p.stderr
    (tmp_path / "stale.json").write_text(json.dumps({"url": "http://127.0.0.1:9", "token": "t"}))
    env["MYSTICAL_RUN_API"] = str(tmp_path / "stale.json")
    assert subprocess.run([MYSTICAL, "runs"], capture_output=True, text=True, env=env).returncode == 3
    (tmp_path / "wrong.json").write_text(json.dumps({"url": served["url"], "token": "old"}))
    env["MYSTICAL_RUN_API"] = str(tmp_path / "wrong.json")
    assert subprocess.run([MYSTICAL, "runs"], capture_output=True, text=True, env=env).returncode == 3


def test_help_names_the_four_commands():
    out = subprocess.run([MYSTICAL, "help"], capture_output=True, text=True).stdout
    for word in ("prompt", "run-status", "runs", "run-cancel", "--wait"):
        assert word in out
    p = subprocess.run([MYSTICAL, "prompt", "--help"], capture_output=True, text=True)
    assert p.returncode == 0 and "exit codes" in p.stdout
