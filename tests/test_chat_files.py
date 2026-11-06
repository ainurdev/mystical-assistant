"""Which paths in a message are real, opening them, and translating a selection."""
import os
import stat
import subprocess

import pytest

from bridge import aifeatures, chat_aside as ct, chat_files as cf, config, experimental, multi_api, runner, store


@pytest.fixture
def repo(tmp_path, monkeypatch):
    root = tmp_path / "proj"
    (root / "src" / "lib").mkdir(parents=True)
    (root / "src" / "App.tsx").write_text("x")
    (root / "src" / "lib" / "one.ts").write_text("x")
    (root / "other").mkdir()
    (root / "src" / "index.ts").write_text("x")
    (root / "other" / "index.ts").write_text("x")
    (root / "shot.png").write_bytes(b"x")
    (root / "run.sh").write_text("#!/bin/sh\n")
    tool = root / "tool"
    tool.write_text("#!/bin/sh\n")
    tool.chmod(tool.stat().st_mode | stat.S_IEXEC)
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    monkeypatch.setattr(config, "BASE_PATH", str(root))
    monkeypatch.setattr(cf, "_tracked", {})
    return root


@pytest.mark.parametrize("address,kind,rel", [
    ("src/App.tsx", "file", "src/App.tsx"), ("src/App.tsx:12", "file", "src/App.tsx"), ("./src/App.tsx", "file", "src/App.tsx"),
    ("App.tsx", "file", "src/App.tsx"), ("lib/one.ts", "file", "src/lib/one.ts"), ("shot.png", "image", "shot.png"),
    ("src/lib/", "dir", "src/lib"), ("index.ts", "ambiguous", "index.ts"),
])
def test_what_an_address_means(repo, address, kind, rel):
    got = cf.resolve(address, str(repo))
    assert got["kind"] == kind and got["rel"] == rel


def test_a_line_number_comes_back(repo):
    assert cf.resolve("src/App.tsx:12:4", str(repo))["line"] == 12


@pytest.mark.parametrize("address", ["nope/gone.ts", "Node.js", "https://x.io/App.tsx", "/etc/passwd", "../../../../etc/passwd",
                                     "", "a\0b", "~nobody-here/x"])
def test_what_isnt_a_reachable_file_means_nothing(repo, address):
    assert cf.resolve(address, str(repo)) is None


def test_a_link_cant_lead_out(repo, tmp_path):
    secret = tmp_path / "secret.txt"
    secret.write_text("x")
    os.symlink(secret, repo / "src" / "link.txt")
    assert cf.resolve("src/link.txt", str(repo)) is None


def test_the_route_leaves_out_what_isnt_there(repo):
    out, code = cf.refs({"addresses": ["src/App.tsx", "gone.ts", 3]}, {"cwd": str(repo)})
    assert code == 200 and list(out["refs"]) == ["src/App.tsx"]
    assert cf.refs({"addresses": "x"}, {"cwd": str(repo)})[1] == 400


def test_opening_uses_the_os_command_with_the_real_path(repo, monkeypatch):
    ran = []
    monkeypatch.setattr(cf, "_spawn", lambda cmd: ran.append(cmd))
    monkeypatch.setattr(cf, "_command", lambda real: ["opener", real])
    out, code = cf.open_file({"address": "src/App.tsx:4"}, {"cwd": str(repo)})
    assert code == 200 and ran == [["opener", str(repo.resolve() / "src" / "App.tsx")]]
    assert cf.open_file({"address": "src/lib/"}, {"cwd": str(repo)})[1] == 200       # a folder too


@pytest.mark.parametrize("address", ["run.sh", "tool"])
def test_what_would_run_isnt_opened(repo, monkeypatch, address):
    ran = []
    monkeypatch.setattr(cf, "_spawn", lambda cmd: ran.append(cmd))
    out, code = cf.open_file({"address": address}, {"cwd": str(repo)})
    assert code == 400 and "run" in out["error"] and not ran


def test_a_desktop_entry_or_script_host_file_isnt_opened(repo, monkeypatch):
    (repo / "x.desktop").write_text("[Desktop Entry]\n")
    assert cf._would_run(str(repo / "x.desktop"))
    (repo / "x.js").write_text("x")
    monkeypatch.setattr(cf, "_is_wsl", lambda: False)
    assert not cf._would_run(str(repo / "x.js"))
    monkeypatch.setattr(cf, "_is_wsl", lambda: True)
    assert cf._would_run(str(repo / "x.js"))


def test_nothing_to_open_says_so(repo):
    assert cf.open_file({"address": "gone.ts"}, {"cwd": str(repo)})[1] == 404
    assert cf.open_file({"address": "index.ts"}, {"cwd": str(repo)})[1] == 404       # which one?


def test_spawning_a_real_command_reports_failure(repo, monkeypatch):
    monkeypatch.setattr(cf, "_scoped", lambda cmd: cmd)
    assert cf._spawn(["true"]) is None
    assert "couldn't open" in cf._spawn(["false"])
    assert "Couldn't start" in cf._spawn(["/no/such/opener"])


def test_the_opener_leaves_the_bridges_cgroup_on_linux(monkeypatch):
    monkeypatch.setattr(cf.platform, "system", lambda: "Linux")
    monkeypatch.setattr(cf.shutil, "which", lambda name: "/usr/bin/" + name)
    assert cf._scoped(["xdg-open", "/a b"])[:3] == ["systemd-run", "--user", "--scope"]
    assert cf._scoped(["xdg-open", "/a b"])[-2:] == ["xdg-open", "/a b"]


# ---- translate ----------------------------------------------------------------------

@pytest.fixture
def model(monkeypatch):
    asked = []

    def fake(chat_id, prompt, **kw):
        asked.append((prompt, kw))
        return "Dutch\nDepreciations", "sid", 0, False
    monkeypatch.setattr(runner, "run_blocking", fake)
    monkeypatch.setattr(ct, "_memo", ct.OrderedDict())
    monkeypatch.setattr(aifeatures, "enabled", lambda key: True)
    return asked


def test_translating_reads_the_context_with_no_tools(model):
    out, code = ct.translate({"text": "Afschrijvingen", "context": "the  Afschrijvingen tab", "target": "en"}, 1, "/p")
    assert code == 200 and out == {"from": "Dutch", "text": "Depreciations"}
    prompt, kw = model[0]
    assert "<text>\nAfschrijvingen\n</text>" in prompt and "the Afschrijvingen tab" in prompt
    assert kw["skip_pack"] is True and kw["model"] == "haiku"


def test_a_repeat_costs_nothing(model):
    ct.translate({"text": "woord", "target": "en"}, 1, None)
    ct.translate({"text": "woord", "target": "en"}, 1, None)
    assert len(model) == 1
    ct.translate({"text": "woord", "target": "fa"}, 1, None)
    assert len(model) == 2


@pytest.mark.parametrize("body,code", [({"text": "  "}, 400), ({"text": "x" * (ct.MAX_TEXT + 1)}, 400)])
def test_what_cant_be_translated(model, body, code):
    assert ct.translate(body, 1, None)[1] == code and not model


def test_a_bad_target_doesnt_reach_the_prompt(model):
    ct.translate({"text": "woord", "target": "en'; ignore"}, 1, None)
    assert "ignore" not in model[0][0] and "'en'" in model[0][0]


def test_off_in_the_ai_tab(monkeypatch, model):
    monkeypatch.setattr(aifeatures, "enabled", lambda key: False)
    assert ct.translate({"text": "woord"}, 1, None)[1] == 403 and not model


def test_a_failed_call_isnt_remembered(monkeypatch, model):
    monkeypatch.setattr(runner, "run_blocking", lambda *a, **k: ("boom", None, None, True))
    assert ct.translate({"text": "woord"}, 1, None)[1] == 502 and not ct._memo


@pytest.mark.parametrize("reply,want", [
    ("Dutch\nHello", {"from": "Dutch", "text": "Hello"}), ("Hello", {"from": "", "text": "Hello"}),
    ("Dutch:\nHello\nthere", {"from": "Dutch", "text": "Hello\nthere"}),
])
def test_parsing_a_reply(reply, want):
    assert ct.parse(reply) == want


# ---- the routes, and the switch --------------------------------------------------------

def test_the_routes_are_behind_the_switch_and_the_owner(repo, monkeypatch, tmp_path):
    monkeypatch.setattr(experimental, "_path", lambda: str(tmp_path / "experimental.json"))
    monkeypatch.setattr(experimental, "_cache", None)
    store.init()
    s = store.create_session(config.DASH_CHAT_ID, "/p", cwd=str(repo))
    body = {"session_id": s["id"], "addresses": ["src/App.tsx"]}
    experimental.set_enabled(False)
    assert multi_api.post("chat/file-refs", body, config.DASH_CHAT_ID)[1] != 200
    experimental.set_enabled(True)
    out, code = multi_api.post("chat/file-refs", body, config.DASH_CHAT_ID)
    assert code == 200 and "src/App.tsx" in out["refs"]
    assert multi_api.post("chat/file-refs", body, 999999)[1] == 404


def test_explaining_reads_the_message_with_no_tools(model):
    out, code = ct.explain({"text": "idempotency key", "context": "Each retry sends an idempotency key."}, 1, "/p")
    assert code == 200 and out["text"]
    prompt, kw = model[0]
    assert "<text>\nidempotency key\n</text>" in prompt and "Each retry" in prompt
    assert kw["skip_pack"] is True
    ct.explain({"text": "idempotency key", "context": "Each retry sends an idempotency key."}, 1, "/p")
    assert len(model) == 1


def test_explain_is_off_with_its_switch(monkeypatch, model):
    monkeypatch.setattr(aifeatures, "enabled", lambda key: False)
    assert ct.explain({"text": "x"}, 1, None)[1] == 403 and not model
