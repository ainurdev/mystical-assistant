"""The device side of device runs (bridge/device_side.py): a teammate's run on
this shared device, from the claim to the report.

Nothing here runs the helper, sudo or the network. `popen=` stands in for the
helper's start: FakeHelper does to the stage what the real one does (it notes
what the stage held, writes out/, takes the token). `call=` stands in for its
stop. The worker is a fake with the Worker's _api, _api_put_bytes,
_deliver_telegram, inst and name. The stage root is a temp dir, and the
snapshot download is a stub.
Run: python -m pytest tests/test_device_side.py -v
"""

import json
import os
import stat
import subprocess
import time
import types
import urllib.error

import pytest

from bridge import device_share, device_side as ds

RID = "0f8e7d6c-5b4a-4392-8170-6e5d4c3b2a19"
OTHER = "1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d"
HEAD = {"X-Mystical-Device-Id": "7c50be1739dfacbb"}
HELPER = "/usr/local/libexec/mystical-run-helper"
TOKEN = "sk-ant-oat01-a-teammates-token"
CODE = b"\x1f\x8b a snapshot"
DEV = "/Applications/Xcode.app/Contents/Developer"
CLAIM = {"requestId": RID, "prompt": "Test the login screen on the iOS simulator.",
         "snapshotUrl": "https://storage.example/snap?sig=1", "gitAuthorName": "Mahdi",
         "gitAuthorEmail": "mahdi@example.com", "claudeToken": TOKEN, "repository": "ainurhq/app",
         "commitSha": "abc1234", "dirty": False, "requester": {"name": "Mahdi"},
         "task": {"key": "RIV-42", "title": "Login"}, "pullRequest": None}
PNG = b"\x89PNG\r\n\x1a\n"
BASE = "/plugin/device-run-requests/" + RID


def _claude(summary="It works.", screens=()):
    """Claude's --output-format json, with the report the prompt asks it to end on."""
    text = "I built the app and ran it.\n\n" + json.dumps({"summary": summary, "screens": list(screens)})
    return json.dumps({"type": "result", "is_error": False, "result": text})


def _http(code):
    return urllib.error.HTTPError("http://api" + BASE, code, "err", None, None)


class Worker:
    """The parts of rivendell.Worker a device run uses."""

    def __init__(self, claim=CLAIM, claim_error=None, impl_timeout=600):
        self.inst = {"id": "t1", "name": "test", "impl_timeout": impl_timeout}
        self.name = "test"
        self.claim, self.claim_error = claim, claim_error
        self.api, self.puts, self.telegram = [], [], []
        self.result_errors = []          # raised by the next result POSTs, in order
        self.claimed = None              # the very dict the claim answered, as run() holds it

    def _api(self, path, payload=None, headers=None):
        self.api.append((path, payload, headers))
        if path.endswith("/prompt"):
            if callable(self.claim_error):
                self.claim_error = self.claim_error()
            if self.claim_error:
                raise self.claim_error
            self.claimed = dict(self.claim)
            return self.claimed
        if path.endswith("/result") and self.result_errors:
            raise self.result_errors.pop(0)
        return {}

    def _api_put_bytes(self, path, data, content_type, headers=None):
        self.puts.append((path, data, content_type, headers))

    def _deliver_telegram(self, text, kb):
        self.telegram.append(text)

    def results(self):
        return [payload for path, payload, _ in self.api if path.endswith("/result")]


class FakeHelper:
    """`sudo -n mystical-run-helper start <id>` as the stage sees it. Started, it
    notes what the stage held and takes the token off the disk, as the helper
    does once it has read it; done, it writes out/ and exits `rc` with `stderr`. Until `hang` stops have come in (through `stops`,
    which the test also hands run() as its `call`), each wait for it times out,
    as a real one would while it runs."""

    def __init__(self, rc=0, exit=None, claude=None, screens=None, stderr="", hang=0, on_wait=None, on_start=None):
        self.rc, self.exit, self.stderr, self.hang, self.on_wait = rc, exit, stderr, hang, on_wait
        self.claude = _claude() if claude is None else claude
        self.screens, self.on_start = screens or {}, on_start
        self.argv = self.kw = self.saw = self.returncode = None
        self.stops = []

    def __call__(self, argv, **kw):
        self.argv, self.kw = argv, kw
        if self.on_start:
            self.on_start()
        self.stage = os.path.join(ds.STAGE_ROOT, argv[-1])
        files = {n: open(os.path.join(self.stage, n), "rb").read() for n in os.listdir(self.stage)}
        self.saw = {"job": json.loads(files["job.json"]), "token": files["token"].decode(),
                    "code": files["code.tar.gz"], "names": sorted(files),
                    "stage_mode": stat.S_IMODE(os.lstat(self.stage).st_mode),
                    "token_mode": stat.S_IMODE(os.lstat(os.path.join(self.stage, "token")).st_mode)}
        os.unlink(os.path.join(self.stage, "token"))   # read: the helper takes it off the disk at once
        return self

    def stop(self, argv, **kw):          # what run() is given as `call`
        self.stops.append(argv)
        return subprocess.CompletedProcess(argv, 0, "", "")

    def communicate(self, timeout=None):
        if self.on_wait:
            self.on_wait()
            self.on_wait = None
        if len(self.stops) < self.hang:
            raise subprocess.TimeoutExpired(self.argv, timeout)
        out = os.path.join(self.stage, "out")
        os.makedirs(os.path.join(out, "screens"))
        with open(os.path.join(out, "exit.json"), "w") as f:
            json.dump(self.exit or {"code": 0, "timedOut": False}, f)
        with open(os.path.join(out, "claude.json"), "w") as f:
            f.write(self.claude)
        for name, data in self.screens.items():
            with open(os.path.join(out, "screens", name), "wb") as f:
                f.write(data)
        self.returncode = self.rc
        return None, self.stderr


class Reply:
    def __init__(self, data):
        self.data = data

    def read(self, n=-1):
        return self.data if n < 0 else self.data[:n]

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture
def device(tmp_path, monkeypatch):
    """A READY device whose stage root is a temp dir; downloads come from a stub."""
    root = tmp_path / "Mystical Runs"
    root.mkdir()
    root.chmod(0o755)                  # as Set up makes it, whatever the umask
    monkeypatch.setattr(ds, "STAGE_ROOT", str(root))
    monkeypatch.setattr(ds, "headers", lambda inst: dict(HEAD))
    monkeypatch.setattr(device_share, "developer_dir", lambda *a, **k: DEV)
    d = types.SimpleNamespace(root=root, fetched=[], code=CODE, on_fetch=None)

    def urlopen(url, timeout=None):
        d.fetched.append((url, timeout))
        if d.on_fetch:
            d.on_fetch()
        return Reply(d.code)
    monkeypatch.setattr(ds.urllib.request, "urlopen", urlopen)
    ds._cancelled.clear()
    ds._interrupted.clear()
    yield d
    ds._cancelled.clear()
    ds._interrupted.clear()


@pytest.fixture(autouse=True)
def no_real_helper():
    """run(), stop() and sweep() reach sudo and the helper through their own
    defaults, which in production is right. Here every test hands them fakes;
    their defaults refuse, so nothing slips through to sudo, and a test that
    reaches one fails."""
    reached = []

    def refuse(argv, **kw):
        reached.append(list(argv))
        raise AssertionError("a command reached sudo without a fake: %r" % (argv,))
    saved = {f: f.__defaults__ for f in (ds.run, ds.stop, ds.sweep)}
    ds.run.__defaults__, ds.stop.__defaults__, ds.sweep.__defaults__ = (refuse, refuse), (refuse,), (refuse,)
    try:
        yield
    finally:
        for f, d in saved.items():
            f.__defaults__ = d
    assert not reached, "a command reached sudo without a fake: %r" % reached


def _run(w, helper, rid=RID):
    ds.run(w, rid, popen=helper, call=helper.stop)


# --- the claim ---------------------------------------------------------------------------------

def test_a_claim_another_device_won_is_dropped_quietly(device):
    """The first free device takes a run; the others' claims get 409 and are not
    theirs to fail, nor to tell anyone about."""
    w, helper = Worker(claim_error=_http(409)), FakeHelper()
    _run(w, helper)
    assert [p for p, _, _ in w.api] == [BASE + "/prompt"] and w.api[0][2] == HEAD
    assert w.results() == [] and w.telegram == [] and helper.argv is None
    assert os.listdir(device.root) == []


def test_a_claim_that_fails_otherwise_posts_failed(device):
    """Any other claim error may still have claimed it: FAILED closes it then,
    and is refused harmlessly if not."""
    w = Worker(claim_error=_http(502))
    _run(w, FakeHelper())
    assert [r["status"] for r in w.results()] == ["FAILED"]


@pytest.mark.parametrize("rid", ["../../Users/me", RID.upper(), "", RID + "/x"])
def test_a_request_id_that_is_not_a_run_id_is_never_claimed(device, rid):
    """It names the stage the bridge later removes, so it must be a run id."""
    w = Worker()
    _run(w, FakeHelper(), rid)
    assert w.api == [] and os.listdir(device.root) == []


@pytest.mark.parametrize("state, facts, sends", [
    ("READY", {"id": "7c50be1739dfacbb"}, HEAD),
    ("READY", {"id": None}, None),                  # no id: Rivendell couldn't tell which device
    ("NEEDS_SETUP", {"id": "7c50be1739dfacbb"}, None),
    ("OFF", {"id": "7c50be1739dfacbb"}, None),
    ("NOT_MAC", None, None),
])
def test_a_device_names_itself_only_when_it_is_ready(monkeypatch, state, facts, sends):
    monkeypatch.setattr(device_share, "share_state", lambda inst: {"state": state, "checks": [], "facts": facts})
    assert ds.headers({"id": "t1"}) == sends


def test_a_device_that_is_no_longer_ready_claims_nothing(device, monkeypatch):
    monkeypatch.setattr(ds, "headers", lambda inst: None)
    w = Worker()
    _run(w, FakeHelper())
    assert w.api == []


# --- a run, start to finish ----------------------------------------------------------------------

def test_a_run_uploads_its_screens_and_posts_the_report_with_captions_in_index_order(device):
    screens = [{"file": "2.png", "caption": "The login screen"}, {"file": "1.png", "caption": "Home"}]
    helper = FakeHelper(claude=_claude("It works.", screens),
                        screens={"1.png": PNG + b"one", "2.png": PNG + b"two"})
    w = Worker()
    staged_at_fetch = []
    device.on_fetch = lambda: staged_at_fetch.append(sorted(os.listdir(ds.stage_dir(RID))))
    _run(w, helper)

    assert staged_at_fetch == [["job.json"]], "the token is staged last, once the code is in"
    assert helper.argv == ["/usr/bin/sudo", "-n", HELPER, "start", RID]
    assert helper.kw["start_new_session"] is True, "a bridge restart doesn't take the run down"
    assert helper.saw == {
        "job": {"prompt": CLAIM["prompt"], "gitAuthorName": "Mahdi", "gitAuthorEmail": "mahdi@example.com",
                "developerDir": DEV, "timeoutSeconds": 600, "instance": "t1"},
        "token": TOKEN, "code": CODE, "names": ["code.tar.gz", "job.json", "token"],
        "stage_mode": 0o700, "token_mode": 0o600}
    assert device.fetched == [(CLAIM["snapshotUrl"], 60)]
    assert w.telegram == ["Mahdi is testing ainurhq/app on this device."]
    assert w.puts == [(BASE + "/screens/1", PNG + b"two", "application/octet-stream", HEAD),
                      (BASE + "/screens/2", PNG + b"one", "application/octet-stream", HEAD)]
    assert w.results() == [{"status": "COMPLETED", "result": "It works.",
                            "screens": [{"index": 1, "caption": "The login screen"}, {"index": 2, "caption": "Home"}]}]
    assert all(h == HEAD for _, _, h in w.api), "every call says which device it is"
    assert os.listdir(device.root) == [], "the stage goes"
    last = device_share.last_run()
    assert last["by"] == "Mahdi" and last["task"] == "RIV-42" and abs(last["at"] - time.time()) < 60


def test_the_claim_lets_go_of_the_token_once_it_is_staged(device):
    """From then on only the stage holds it, and the helper takes it from there."""
    w = Worker()
    held = []
    helper = FakeHelper(on_start=lambda: held.append("claudeToken" in w.claimed))
    _run(w, helper)
    assert held == [False] and helper.saw["token"] == TOKEN


def test_unlisted_pngs_follow_the_listed_screens_by_name(device):
    helper = FakeHelper(claude=_claude("Done.", [{"file": "b.png", "caption": "B"}]),
                        screens={"c.png": PNG + b"c", "a.png": PNG + b"a", "b.png": PNG + b"b", "notes.txt": b"x"})
    w = Worker()
    _run(w, helper)
    assert [(p.rsplit("/", 1)[1], d) for p, d, _, _ in w.puts] == [("1", PNG + b"b"), ("2", PNG + b"a"), ("3", PNG + b"c")]
    assert w.results()[0]["screens"] == [{"index": 1, "caption": "B"}, {"index": 2, "caption": ""},
                                         {"index": 3, "caption": ""}]


def test_a_screen_over_5_mb_is_left_out_with_a_note(device):
    helper = FakeHelper(claude=_claude("It works.", [{"file": "1.png", "caption": "Home"},
                                                     {"file": "2.png", "caption": "Huge"}]),
                        screens={"1.png": PNG, "2.png": PNG + b"x" * (6 * 1024 * 1024)})
    w = Worker()
    _run(w, helper)
    assert [p for p, _, _, _ in w.puts] == [BASE + "/screens/1"]
    assert w.results() == [{"status": "COMPLETED", "result": "It works.\n\nScreenshots over 5 MB were left out: 2.png.",
                            "screens": [{"index": 1, "caption": "Home"}]}]


def test_at_most_20_screens_go_up(device):
    helper = FakeHelper(screens={"%02d.png" % i: PNG for i in range(25)})
    w = Worker()
    _run(w, helper)
    assert len(w.puts) == 20 and [s["index"] for s in w.results()[0]["screens"]] == list(range(1, 21))


def test_a_report_naming_files_outside_its_screens_folder_uploads_none_of_them(device):
    """The report is the run's to write: a name that leads out of out/screens (to
    the stage's token, say, or the owner's files) is never read."""
    names = ["../../token", "/etc/hosts", "..", "../exit.json"]
    w = Worker()
    _run(w, FakeHelper(claude=_claude("Look.", [{"file": n, "caption": n} for n in names])))
    assert w.puts == [] and w.results()[0]["screens"] == []


def test_a_screen_rivendell_refuses_is_left_out_of_the_result(device):
    """A result naming a screen that never landed is refused whole (400)."""
    helper = FakeHelper(screens={"1.png": b"GIF89a, not a PNG", "2.png": PNG})
    w = Worker()
    puts = []

    def put(path, data, content_type, headers=None):
        puts.append((path, data))
        if not data.startswith(PNG):
            raise _http(400)                 # "Send a PNG or JPEG."
    w._api_put_bytes = put
    _run(w, helper)
    assert puts == [(BASE + "/screens/1", b"GIF89a, not a PNG"), (BASE + "/screens/1", PNG)], \
        "the next screen takes the index"
    assert w.results()[0]["screens"] == [{"index": 1, "caption": ""}]


# --- how a run can fail ----------------------------------------------------------------------------

@pytest.mark.parametrize("how", ["the helper exits 3", "Claude exits 3"])
def test_a_run_that_stopped_with_an_exit_code_fails_with_it(device, how):
    helper = FakeHelper(rc=3) if how == "the helper exits 3" else FakeHelper(exit={"code": 3, "timedOut": False})
    w = Worker()
    _run(w, helper)
    assert w.results() == [{"status": "FAILED", "error": "The run stopped with exit code 3.", "screens": []}]
    assert w.puts == []


def test_a_run_that_timed_out_fails_and_its_stage_goes(device):
    helper = FakeHelper(exit={"code": -15, "timedOut": True}, screens={"1.png": PNG})
    w = Worker()
    _run(w, helper)
    assert w.results() == [{"status": "FAILED", "error": "The run timed out after 10 min.", "screens": []}]
    assert os.listdir(device.root) == []


def test_the_helpers_refusal_is_the_error(device):
    w = Worker()
    _run(w, FakeHelper(rc=2, stderr="mystical-run-helper: The code snapshot didn't unpack.\n"))
    assert w.results()[0]["error"] == "The code snapshot didn't unpack."


def test_a_run_cannot_post_the_askers_token(device):
    """A prompt-injected run can write the token it runs under into its report:
    the summary and every caption go out with token-shaped text redacted."""
    leak = f"{TOKEN} and CLAUDE_CODE_OAUTH_TOKEN={TOKEN}"
    helper = FakeHelper(claude=_claude(f"It works. {leak}", [{"file": "1.png", "caption": f"Home {TOKEN}"}]),
                        screens={"1.png": PNG})
    w = Worker()
    _run(w, helper)
    assert w.results() == [{"status": "COMPLETED", "result": "It works. [redacted] and [redacted]",
                            "screens": [{"index": 1, "caption": "Home [redacted]"}]}]


def test_a_failed_run_cannot_post_the_askers_token_in_its_error(device):
    w = Worker()
    _run(w, FakeHelper(rc=1, stderr=f"mystical-run-helper: CLAUDE_CODE_OAUTH_TOKEN={TOKEN} was refused\n"))
    assert w.results() == [{"status": "FAILED", "error": "[redacted] was refused", "screens": []}]


@pytest.mark.parametrize("claude", ["", json.dumps({"type": "result", "result": ""}), "not json"])
def test_no_report_is_a_failure(device, claude):
    w = Worker()
    _run(w, FakeHelper(claude=claude))
    assert w.results() == [{"status": "FAILED", "error": "No report came back.", "screens": []}]


def test_a_helper_still_going_past_the_deadline_is_stopped(device, monkeypatch):
    """The helper times Claude out itself; past that and the slack, the bridge
    stops it and calls the run timed out."""
    monkeypatch.setattr(ds, "_SLACK", -600)        # the deadline is now
    helper = FakeHelper(hang=1, exit={"code": -15, "timedOut": False})
    w = Worker()
    _run(w, helper)
    assert helper.stops == [["/usr/bin/sudo", "-n", HELPER, "stop", RID]]
    assert w.results()[0]["error"] == "The run timed out after 10 min."


def test_a_helper_that_ignores_its_stop_is_given_up_on(device, monkeypatch):
    monkeypatch.setattr(ds, "_SLACK", -600)
    monkeypatch.setattr(ds, "_GIVE_UP", 0.05)
    helper = FakeHelper(hang=10 ** 9)
    w = Worker()
    _run(w, helper)
    assert helper.stops and w.results()[0]["error"] == "The run timed out after 10 min."
    assert os.listdir(device.root) == [], "the stage goes all the same"


def test_a_snapshot_address_that_is_not_the_web_is_never_read(device):
    """file:// would hand the run one of the owner's own files as its code."""
    w = Worker(claim={**CLAIM, "snapshotUrl": "file:///Users/me/backup.tar.gz"})
    helper = FakeHelper()
    _run(w, helper)
    assert device.fetched == [] and helper.argv is None
    assert w.results()[0]["status"] == "FAILED" and os.listdir(device.root) == []


def test_a_snapshot_over_9_mb_is_refused(device):
    device.code = b"x" * (9 * 1024 * 1024 + 1)
    w, helper = Worker(), FakeHelper()
    _run(w, helper)
    assert helper.argv is None and w.results()[0]["status"] == "FAILED"


def test_the_result_is_retried_through_a_hiccup_but_not_a_refusal(device, monkeypatch):
    monkeypatch.setattr(ds, "_RETRIES", (0, 0, 0))
    w = Worker()
    w.result_errors = [_http(502)]
    _run(w, FakeHelper())
    assert [r["status"] for r in w.results()] == ["COMPLETED", "COMPLETED"]
    w = Worker()
    w.result_errors = [_http(400)]
    _run(w, FakeHelper())
    assert len(w.results()) == 1, "Rivendell refusing this very body: waiting can't change it"


# --- a cancel -------------------------------------------------------------------------------------

def test_stop_asks_the_helper_to_stop_the_run():
    calls = []
    ds.stop(RID, run=lambda argv, **kw: calls.append(argv) or subprocess.CompletedProcess(argv, 0, "", ""))
    assert calls == [["/usr/bin/sudo", "-n", HELPER, "stop", RID]]
    ds._cancelled.clear()


def test_stop_never_passes_on_what_is_not_a_run_id():
    calls = []
    ds.stop("../x", run=lambda argv, **kw: calls.append(argv))
    assert calls == []


def test_a_cancel_while_the_code_unpacks_is_not_lost(device):
    """The helper's stop finds no run until Claude has started, so a cancel that
    lands while the code is unpacking would be lost: the bridge stops it again on
    each beat while the start goes on. A cancelled run posts nothing; Rivendell
    has closed it."""
    helper = FakeHelper(hang=3)
    helper.on_wait = lambda: ds.stop(RID, run=helper.stop)    # the cancel frame, mid-unpack
    w = Worker()
    _run(w, helper)
    assert len(helper.stops) == 3 and set(map(tuple, helper.stops)) == {("/usr/bin/sudo", "-n", HELPER, "stop", RID)}
    assert w.results() == [] and os.listdir(device.root) == []


def test_a_cancel_before_the_helper_starts_starts_nothing(device):
    w, helper = Worker(), FakeHelper()
    device.on_fetch = lambda: ds.stop(RID, run=helper.stop)    # lands while the code downloads
    _run(w, helper)
    assert helper.argv is None and w.results() == [] and os.listdir(device.root) == []


def test_a_run_cancelled_while_it_waited_is_never_claimed(device):
    ds.stop(RID, run=_no_helper)
    w = Worker()
    _run(w, FakeHelper())
    assert w.api == [] and os.listdir(device.root) == [] and RID not in ds._cancelled


@pytest.mark.parametrize("how", ["another device took it (409)", "the claim failed (502)", "no longer ready"])
def test_a_cancel_is_forgotten_however_the_run_ends(device, monkeypatch, how):
    """A cancel landing mid-claim, or while the device stops being ready, doesn't
    stay behind in _cancelled."""
    cancel = lambda: ds.stop(RID, run=_no_helper)    # noqa: E731
    w = Worker()
    if how == "no longer ready":
        monkeypatch.setattr(ds, "headers", lambda inst: cancel())
    else:
        error = _http(409 if "409" in how else 502)
        w.claim_error = lambda: (cancel(), error)[1]
    _run(w, FakeHelper())
    assert RID not in ds._cancelled and os.listdir(device.root) == []


def test_a_malformed_claim_fails_like_any_other_failure(device):
    """requester and task that aren't objects: FAILED, with the device header,
    and nothing raised out of run()."""
    w = Worker(claim={**CLAIM, "requester": "Mahdi", "task": "RIV-42"})
    helper = FakeHelper()
    _run(w, helper)
    (path, body, head), = [c for c in w.api if c[0].endswith("/result")]
    assert body["status"] == "FAILED" and head == HEAD and helper.argv is None
    assert os.listdir(device.root) == []


# --- what a report is -------------------------------------------------------------------------------

def test_the_report_is_the_last_json_object_after_the_prose():
    text = ('I opened the app {not json}. Then:\n```json\n'
            '{"summary": "Login works.", "screens": [{"file": "1.png", "caption": "Login"}, {"file": "2.png"}]}\n```')
    assert ds.parse_report(json.dumps({"result": text})) == (
        "Login works.", [{"file": "1.png", "caption": "Login"}, {"file": "2.png", "caption": ""}])


def test_prose_alone_is_the_whole_report():
    assert ds.parse_report(json.dumps({"result": "It crashed on launch."})) == ("It crashed on launch.", [])


def test_of_two_reports_the_last_counts_and_other_objects_do_not():
    text = '{"summary": "draft"} then {"summary": "final", "screens": []} and {"other": 1}'
    assert ds.parse_report(json.dumps({"result": text})) == ("final", [])


@pytest.mark.parametrize("claude", ["", "nope", "[1]", json.dumps({"result": 7})])
def test_output_that_isnt_claudes_json_is_no_report(claude):
    assert ds.parse_report(claude) == ("", [])


def test_a_stage_is_its_run_id_under_the_stage_root(device):
    assert ds.stage_dir(RID) == os.path.join(str(device.root), RID)


# --- a bridge that stopped mid-run -------------------------------------------------------------------

def test_a_bridge_start_clears_stages_left_mid_run_token_first(device, tmp_path):
    """The helper outlives a bridge restart (its own session), so a stale stage's
    run may still be going, with or without a token on disk (the helper takes it
    as it starts): every one is told to stop, which does nothing unless that run
    holds the helper's lock. Then the token goes, then the rest, whatever else
    can't go."""
    def stage(rid, token=True):
        d = device.root / rid
        (d / "out").mkdir(parents=True)
        (d / "out" / "claude.json").write_text("{}")
        (d / "job.json").write_text("{}")
        if token:
            (d / "token").write_text(TOKEN)
        return d
    going, done = stage(RID), stage(OTHER, token=False)
    going.chmod(0o300)                                 # it can't even be listed, so rmtree takes nothing
    (device.root / "notes").mkdir()                    # not a stage
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "token").write_text("keep")
    (device.root / "2b3c4d5e-6f7a-4b2c-8d3e-4f5a6b7c8d9e").symlink_to(elsewhere)
    calls = []
    try:
        ds.sweep(run=lambda argv, **kw: calls.append(argv) or subprocess.CompletedProcess(argv, 0, "", ""))
        assert sorted(calls) == sorted([["/usr/bin/sudo", "-n", HELPER, "stop", RID],
                                        ["/usr/bin/sudo", "-n", HELPER, "stop", OTHER]]), "the one with no token too"
        going.chmod(0o700)
        assert not (going / "token").exists(), "the token went first, by name"
        assert not done.exists() and (device.root / "notes").is_dir()
        assert (elsewhere / "token").read_text() == "keep", "a link is not followed"
    finally:
        going.chmod(0o700)


def _stale(device, rid, instance, token=True):
    """A stage as a bridge that stopped mid-run leaves it."""
    d = device.root / rid
    (d / "out").mkdir(parents=True)
    (d / "job.json").write_text(json.dumps({"prompt": "p", "timeoutSeconds": 600, "instance": instance}))
    if token:
        (d / "token").write_text(TOKEN)
    return d


def _no_helper(argv, **kw):
    return subprocess.CompletedProcess(argv, 0, "", "")


def test_a_run_cut_short_by_a_restart_is_reported_failed_to_its_instance_once(device):
    """M12: the stage names its instance. At bridge start the stage goes; once
    that instance's device is connected again (Rivendell takes a device's result
    only then), the run is posted FAILED there, once, with the device header."""
    _stale(device, RID, "t1")
    _stale(device, OTHER, "t2", token=False)
    ds.sweep(run=_no_helper)
    assert os.listdir(device.root) == []
    mine, theirs = Worker(), Worker()
    theirs.inst = {**theirs.inst, "id": "t2"}
    ds.report_interrupted(mine, HEAD)
    ds.report_interrupted(mine, HEAD)
    assert mine.api == [(BASE + "/result", {"status": "FAILED", "error": "The device restarted during the run.",
                                            "screens": []}, HEAD)], "one post, to its own instance"
    ds.report_interrupted(theirs, HEAD)
    assert [p for p, _, _ in theirs.api] == ["/plugin/device-run-requests/" + OTHER + "/result"]


def test_a_restart_report_that_fails_is_tried_again_on_the_next_connect(device, capsys):
    """A failed post is logged and kept for the next READY connect, until it
    lands. The stage went at bridge start either way."""
    _stale(device, RID, "t1")
    ds.sweep(run=_no_helper)
    assert os.listdir(device.root) == []
    w = Worker()
    w.result_errors = [_http(502)]
    ds.report_interrupted(w, HEAD)
    assert len(w.results()) == 1 and RID in capsys.readouterr().out and ds._interrupted == {"t1": [RID]}
    ds.report_interrupted(w, HEAD)                    # the next connect: it lands
    ds.report_interrupted(w, HEAD)                    # and is not posted again
    assert len(w.results()) == 2 and ds._interrupted == {}


def test_a_restart_report_rivendell_answers_409_is_settled(device):
    """409: the run has ended there already, so there is nothing left to report."""
    _stale(device, RID, "t1")
    ds.sweep(run=_no_helper)
    w = Worker()
    w.result_errors = [_http(409)]
    ds.report_interrupted(w, HEAD)
    ds.report_interrupted(w, HEAD)
    assert len(w.results()) == 1 and ds._interrupted == {}


def test_a_device_never_set_up_has_nothing_to_sweep(device, monkeypatch):
    monkeypatch.setattr(ds, "STAGE_ROOT", str(device.root / "missing"))
    ds.sweep(run=lambda argv, **kw: pytest.fail("nothing to stop"))


@pytest.mark.parametrize("there", [RID, OTHER], ids=["a folder named like this run", "another run's folder"])
def test_a_stage_root_planted_as_a_link_is_never_followed(device, tmp_path, monkeypatch, there):
    """/Users/Shared is anyone's to write: "Mystical Runs" could be a link into
    this account's home, planted there before Set up made the folder. Nothing is
    swept, staged or removed through it, the owner isn't pinged, and the run is
    posted FAILED, saying why. A folder there named like this run is what the
    run's own clean-up would take; another run's, what the sweep would."""
    home = tmp_path / "home"
    (home / there).mkdir(parents=True)
    (home / there / "keep").write_text("mine")
    (home / there / "token").write_text("mine too")
    planted = tmp_path / "planted"
    planted.symlink_to(home)
    monkeypatch.setattr(ds, "STAGE_ROOT", str(planted))
    calls = []
    ds.sweep(run=lambda argv, **kw: calls.append(argv))
    w, helper = Worker(), FakeHelper()
    _run(w, helper)                                   # always RID
    assert calls == [] and helper.argv is None and w.telegram == []
    assert sorted(os.listdir(home)) == [there], "nothing written there, nothing removed"
    assert (home / there / "keep").read_text() == "mine" and (home / there / "token").read_text() == "mine too"
    assert [(r["status"], h) for (p, r, h) in w.api if p.endswith("/result")] == [("FAILED", HEAD)]


@pytest.mark.parametrize("how", ["group-writable", "someone else's"])
def test_a_stage_root_others_could_change_is_left_alone(device, monkeypatch, how):
    stale = _stale(device, RID, "t1")
    if how == "group-writable":
        device.root.chmod(0o775)
    else:
        mine = os.getuid()
        monkeypatch.setattr(ds.os, "getuid", lambda: mine + 1)
    calls = []
    ds.sweep(run=lambda argv, **kw: calls.append(argv))
    assert calls == [] and (stale / "token").exists() and ds._interrupted == {}
    w, helper = Worker(), FakeHelper()
    _run(w, helper, rid=OTHER)                        # a run with no stage there yet
    assert helper.argv is None and w.results()[0]["status"] == "FAILED" and w.telegram == []
    assert sorted(os.listdir(device.root)) == [RID], "nothing staged there, and nothing removed"
