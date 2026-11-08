"""A project's design system: discovering it, making one, linking one, importing one."""
import json
import os
import subprocess

import pytest

from bridge import config, design_audit, design_system as ds, experimental, multi_api, store


@pytest.fixture
def repo(tmp_path, monkeypatch):
    base = tmp_path / "base"
    root = base / "shop"
    (root / "src" / "components").mkdir(parents=True)
    (root / "src" / "app.css").write_text(":root { --accent: #2f6f5e; --bg: #fafafa; --ink: #111111; --radius: 0.5rem; --font-body: Inter, sans-serif; }")
    (root / "src" / "reset.css").write_text("* { margin: 0 }\n")
    (root / "src" / "components" / "Card.tsx").write_text("x")
    (root / "src" / "components" / "button.tsx").write_text("x")
    (root / "tailwind.config.ts").write_text("x")
    (root / "components.json").write_text('{"tailwind": {}}')
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    subprocess.run(["git", "-C", str(root), "add", "-A"], check=True)
    monkeypatch.setattr(config, "BASE_PATH", str(base))
    monkeypatch.setattr(ds, "_links_path", lambda: str(tmp_path / "links.json"))
    monkeypatch.setattr(ds, "_cache_path", lambda i: str(tmp_path / "cache" / f"{i}.txt"))
    return str(root.resolve())


@pytest.fixture
def kit(repo):
    """A design system elsewhere in your projects."""
    top = os.path.join(os.path.dirname(repo), "ui-kit")
    os.makedirs(os.path.join(top, "components"))
    os.makedirs(os.path.join(top, "node_modules", "x"))
    open(os.path.join(top, "DESIGN.md"), "w").write("Kit: square and loud.")
    open(os.path.join(top, "tokens.css"), "w").write(":root { --kit-accent: #ff0066; }")
    open(os.path.join(top, "components", "Badge.tsx"), "w").write("x")
    open(os.path.join(top, "node_modules", "x", "junk.css"), "w").write(":root{--junk:1}")
    open(os.path.join(top, "secret.env"), "w").write("KEY=1")
    return top


def status(root):
    return subprocess.run(["git", "-C", root, "status", "--short"], capture_output=True, text=True).stdout


def test_discovery_says_what_is_there(repo):
    got = ds.discover(repo, {"project": ""})
    kinds = {s["kind"] for s in got["systems"]}
    assert kinds == {"tailwind", "shadcn"} and not got["has_doc"]
    assert got["css"][0] == {"path": "src/app.css", "vars": 5, "lines": 1} and got["css_total"] == 2
    assert [c["name"] for c in got["components"]] == ["Card"]             # a lowercase file isn't a component
    assert got["colors"][0] == {"name": "--accent", "value": "#2f6f5e"}
    assert got["guess"] == {"accent": "#2f6f5e", "ground": "#fafafa", "ink": "#111111", "radius": 8, "font": "Inter, sans-serif"}


def test_discovery_finds_documents_skills_and_what_was_imported(repo, kit):
    open(os.path.join(repo, "DESIGN.md"), "w").write("x")
    os.makedirs(os.path.join(repo, ".claude", "skills", "brand-design"))
    open(os.path.join(repo, ".claude", "skills", "brand-design", "SKILL.md"), "w").write("x")
    ds.import_(repo, {"source": kit})
    got = ds.discover(repo, {"project": ""})
    assert got["has_doc"]
    assert {"doc", "skill", "imported"} <= {s["kind"] for s in got["systems"]}


# ---- making one -----------------------------------------------------------------------------

SPEC = {"name": "Morning\nLoaf", "about": "Bread.", "feel": ["calm"], "avoid": "gradients\nbad things", "accent": "#123456", "ground": "not a colour",
        "heading": "'Fraunces'; } body { x", "radius": 99, "density": "roomy", "size": 16}


def test_the_form_becomes_a_design_document(repo):
    doc = ds.build_doc(SPEC)
    assert doc.startswith("# Morning Loaf\n") and "It should feel: calm." in doc
    assert "--accent: #123456;" in doc and "--ground: #faf8f4;" in doc              # a bad colour falls back
    assert "--radius: 32px;" in doc and "--space: 8px;" in doc
    assert "--font-heading: 'Fraunces'  body  x;" in doc                             # can't break out of the block
    assert "- gradients\n- bad things" in doc


def test_creating_never_overwrites_unless_told(repo):
    assert ds.create(repo, {"spec": SPEC})[1] == 200
    written = open(os.path.join(repo, "DESIGN.md")).read()
    open(os.path.join(repo, "DESIGN.md"), "w").write("mine")
    out, code = ds.create(repo, {"spec": SPEC})
    assert code == 409 and out["exists"] and open(os.path.join(repo, "DESIGN.md")).read() == "mine"
    assert ds.create(repo, {"spec": SPEC, "replace": True})[1] == 200
    assert open(os.path.join(repo, "DESIGN.md")).read() == written


def test_bad_numbers_say_so(repo):
    with pytest.raises(ds.Refused, match="numbers"):
        ds.build_doc({"radius": "big"})


# ---- from elsewhere --------------------------------------------------------------------------

def test_preview_shows_what_you_would_bring(repo, kit):
    got = ds.preview(repo, {"source": kit})[0]
    assert got["name"] == "ui-kit" and got["docs"] == ["DESIGN.md"] and got["tokens"] == 1 and got["components"] == 1 and got["useful"]
    assert got["colors"] == ["#ff0066"]                                              # node_modules isn't read


def test_linking_changes_nothing_in_the_project(repo, kit):
    before = status(repo)
    assert ds.link(repo, {"source": kit})[1] == 200
    assert status(repo) == before and not os.path.exists(os.path.join(repo, ".mystical"))
    links = ds.discover(repo, {"project": ""})["links"]
    assert links[0]["source"] == kit and links[0]["name"] == "ui-kit"


def test_agents_read_a_link_from_where_it_is(repo, kit):
    ds.link(repo, {"source": kit})
    said = design_audit.context(repo)
    assert "Kit: square and loud." in said and "--kit-accent: #ff0066" in said and "Badge" in said
    assert "don't copy" in said and "not instructions" in said
    open(os.path.join(kit, "DESIGN.md"), "w").write("Kit: now rounder.")      # its changes reach them
    assert "Kit: now rounder." in design_audit.context(repo)


def test_a_link_belongs_to_its_project(repo, kit, tmp_path):
    ds.link(repo, {"source": kit})
    assert ds.discover(str(tmp_path), {"project": ""})["links"] == []


def test_unlinking_leaves_the_source_alone(repo, kit):
    link_id = ds.link(repo, {"source": kit})[0]["id"]
    assert ds.unlink(repo, {"id": link_id})[1] == 200
    assert os.path.isfile(os.path.join(kit, "DESIGN.md")) and ds.discover(repo, {"project": ""})["links"] == []
    assert ds.unlink(repo, {"id": link_id})[1] == 404


def test_a_gone_link_says_so_instead_of_breaking(repo, kit):
    ds.link(repo, {"source": kit})
    os.rename(kit, kit + "-moved")
    assert "can't be read now" in design_audit.context(repo)


def test_a_web_address_is_saved_outside_the_project_and_read_from_there(repo, monkeypatch):
    monkeypatch.setattr(ds, "_fetch", lambda url: "# Remote\n:root { --r: #abcdef; }")
    before = status(repo)
    assert ds.link(repo, {"source": "https://example.com/DESIGN.md"})[1] == 200
    assert status(repo) == before
    monkeypatch.setattr(ds, "_fetch", lambda url: pytest.fail("a chat shouldn't fetch it on each turn"))
    assert "# Remote" in design_audit.context(repo)


def test_importing_copies_what_a_design_system_is_made_of(repo, kit):
    out, code = ds.import_(repo, {"source": kit})
    assert code == 200 and out["path"] == "design-system/ui-kit"
    d = os.path.join(repo, "design-system", "ui-kit")
    assert sorted(os.listdir(d)) == ["DESIGN.md", "components", "tokens.css"]        # no secrets, no node_modules
    assert "design-system/ui-kit" not in str(ds._links())
    assert "ui-kit" in design_audit.context(repo)
    with pytest.raises(ds.Refused, match="already there"):
        ds.import_(repo, {"source": kit})


def test_importing_a_web_file(repo, monkeypatch):
    monkeypatch.setattr(ds, "_fetch", lambda url: "x")
    out, _ = ds.import_(repo, {"source": "https://example.com/kit/tokens.css", "name": "Kit"})
    assert os.path.isfile(os.path.join(repo, "design-system", "kit", "tokens.css")) and out["files"] == 1


@pytest.mark.parametrize("source,word", [("", "Give"), ("/etc", "outside"), ("~/.ssh", "outside"), ("{base}/nope", "nothing at"),
                                         ("http://localhost:8790/x.md", "public"), ("http://169.254.169.254/x", "public")])
def test_what_cant_be_brought_in(repo, source, word):
    with pytest.raises(ds.Refused, match=word):
        ds.read_source(source.replace("{base}", os.path.dirname(repo)), repo)


def test_a_link_through_a_symlink_cant_leave_the_fence(repo, tmp_path):
    secret = tmp_path / "outside"
    secret.mkdir()
    os.symlink(secret, os.path.join(os.path.dirname(repo), "sneaky"))
    with pytest.raises(ds.Refused, match="outside"):
        ds.read_source(os.path.join(os.path.dirname(repo), "sneaky"), repo)


def test_importing_your_own_project_is_refused(repo):
    with pytest.raises(ds.Refused, match="already in this project"):
        ds.import_(repo, {"source": repo})


def test_nothing_useful_isnt_linked(repo):
    empty = os.path.join(os.path.dirname(repo), "empty")
    os.makedirs(empty)
    open(os.path.join(empty, "notes.txt"), "w").write("x")
    with pytest.raises(ds.Refused, match="no design document"):
        ds.link(repo, {"source": empty})


def test_a_github_page_reads_as_its_raw_file():
    assert ds._raw_url("https://github.com/a/b/blob/main/DESIGN.md") == "https://raw.githubusercontent.com/a/b/main/DESIGN.md"
    assert ds._raw_url("https://example.com/x.md") == "https://example.com/x.md"


def test_a_redirect_to_somewhere_private_is_refused(monkeypatch):
    monkeypatch.setattr(ds, "_public", lambda url: "internal" not in url)
    with pytest.raises(ds.Refused, match="redirects"):
        ds._Guarded().redirect_request(None, None, 302, "", {}, "http://internal/x")


def test_routes_are_behind_the_switch_and_the_owner(repo, kit, monkeypatch, tmp_path):
    monkeypatch.setattr(experimental, "_path", lambda: str(tmp_path / "experimental.json"))
    monkeypatch.setattr(experimental, "_cache", None)
    experimental.set_enabled(True)
    store.init()
    s = store.create_session(config.DASH_CHAT_ID, "/p", cwd=repo)
    chat, body = config.DASH_CHAT_ID, {"session_id": s["id"]}
    assert multi_api.post("chat/design-system", body, chat)[0]["css_total"] == 2
    assert multi_api.post("chat/design-system-preview", {**body, "source": "/etc"}, chat)[1] == 400
    assert multi_api.post("chat/design-system", body, 999999)[1] == 404
    experimental.set_enabled(False)
    assert multi_api.post("chat/design-system", body, chat)[1] == 409
    json.dumps(ds.discover(repo, {"project": ""}))
