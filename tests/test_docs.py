"""Unit tests for bridge.docs — the walk behind the dashboard's DOCS tab.
Pure filesystem code; a tmp_path repo is the whole fixture.
Run: `python3 -m pytest tests/test_docs.py -q`
"""

import os

from bridge import docs


def _write(root, rel, body="body\n"):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(body)
    return p


def test_lists_docs_with_title_and_subject_folder(tmp_path):
    root = str(tmp_path)
    _write(root, "docs/superpowers/specs/2026-08-25-flow-native-chat.md",
           "# Flow-native chat\n\nthe spec body.\n")
    _write(root, "README.md", "no heading here, just prose\n")

    by_path = {a["path"]: a for a in docs.docs(root)}
    assert set(by_path) == {
        "docs/superpowers/specs/2026-08-25-flow-native-chat.md", "README.md"}

    spec = by_path["docs/superpowers/specs/2026-08-25-flow-native-chat.md"]
    assert spec["dir"] == "docs/superpowers/specs"
    assert spec["title"] == "Flow-native chat"
    assert by_path["README.md"]["title"] == "README"
    assert by_path["README.md"]["dir"] == ""


def test_root_docs_are_titled_by_filename(tmp_path):
    """README.md and CLAUDE.md both open `# <repo name>` — headings would give
    the root two identical rows."""
    root = str(tmp_path)
    _write(root, "README.md", "# mystical-assistant\n")
    _write(root, "CLAUDE.md", "# mystical-assistant\n")
    _write(root, "docs/spec.md", "# A spec\n")

    by_path = {a["path"]: a["title"] for a in docs.docs(root)}
    assert by_path["README.md"] == "README"
    assert by_path["CLAUDE.md"] == "CLAUDE"
    assert by_path["docs/spec.md"] == "A spec"   # only the root is renamed


def test_title_falls_back_to_a_deslugged_filename(tmp_path):
    root = str(tmp_path)
    _write(root, "docs/2026-08-25-clip-panel-explains-itself.md", "prose, no heading\n")
    _write(root, "docs/design_notes.md", "prose\n")

    by_path = {a["path"]: a["title"] for a in docs.docs(root)}
    assert by_path["docs/2026-08-25-clip-panel-explains-itself.md"] == \
        "clip panel explains itself"
    assert by_path["docs/design_notes.md"] == "design notes"


def test_title_reads_past_front_matter(tmp_path):
    root = str(tmp_path)
    _write(root, "docs/post.md", "---\nname: whatever\n---\n\n# The real title\n\nbody\n")
    assert docs.docs(root)[0]["title"] == "The real title"


def test_skips_dependencies_tooling_and_generated_output(tmp_path):
    root = str(tmp_path)
    _write(root, "docs/spec.md", "# Mine\n")
    _write(root, "node_modules/pkg/README.md", "# Theirs\n")
    _write(root, ".claude/skills/design/SKILL.md", "# A skill\n")
    _write(root, ".superpowers/sdd/plan.md", "# Tooling\n")
    _write(root, "graphify-out/2026-09-01/report.md", "# Generated\n")
    _write(root, "web/dist/CHANGELOG.md", "# Built\n")

    assert {a["path"] for a in docs.docs(root)} == {"docs/spec.md"}


def test_skips_the_learn_shelf_but_not_the_rest_of_mystical(tmp_path):
    root = str(tmp_path)
    _write(root, ".mystical/learn/0042-a-lesson.md", "# A lesson\n")
    _write(root, ".mystical/docs/brief.md", "# A brief\n")
    _write(root, ".mystical/design-drafts/x/notes.md", "# Draft notes\n")

    assert {a["path"] for a in docs.docs(root)} == {
        ".mystical/docs/brief.md", ".mystical/design-drafts/x/notes.md"}


def test_skips_empty_files_and_dotfiles(tmp_path):
    root = str(tmp_path)
    _write(root, "real.md", "# Real\n")
    _write(root, "blank.md", "")
    _write(root, ".hidden.md", "# Hidden\n")

    assert {a["path"] for a in docs.docs(root)} == {"real.md"}


def test_newest_first(tmp_path):
    root = str(tmp_path)
    old = _write(root, "old.md", "# Old\n")
    new = _write(root, "new.md", "# New\n")
    os.utime(old, (1_000_000, 1_000_000))
    os.utime(new, (2_000_000, 2_000_000))
    assert [a["name"] for a in docs.docs(root)] == ["new.md", "old.md"]


def test_read_only_serves_what_the_walk_found(tmp_path):
    root = str(tmp_path)
    _write(root, "docs/page.md", "# Hello\n")
    _write(root, "node_modules/pkg/README.md", "# Theirs\n")
    outside = tmp_path.parent / "secret.md"
    outside.write_text("not yours")

    assert docs.read(root, "docs/page.md") == "# Hello\n"
    assert docs.read(root, "node_modules/pkg/README.md") is None   # skipped by the walk
    assert docs.read(root, "../secret.md") is None                 # never in the listing
    assert docs.read(root, "docs/../docs/page.md") is None


# --- dashboard routes, driven without sockets (mirrors test_graph_endpoints.py) ---

import subprocess  # noqa: E402

from bridge import config  # noqa: E402
from bridge.dashboard import server as dash  # noqa: E402


def _mkproject(name):
    d = os.path.join(config.BASE_PATH, name)
    os.makedirs(d, exist_ok=True)
    subprocess.run(["git", "init", "-q", d], check=True)
    return name, d


def _handler():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    h._send = lambda data, code, ctype, cache="no-cache": box.update(
        data=data, code=code, ctype=ctype)
    return h, box


def test_docs_endpoint_lists_a_repos_docs():
    name, d = _mkproject("proj_docs")
    _write(d, "docs/report.md", "# Report\n")
    h, box = _handler()
    h._get_api("/local/docs", {"project": [name]})
    assert box["code"] == 200
    assert [(a["path"], a["title"]) for a in box["obj"]["docs"]] == [("docs/report.md", "Report")]


def test_docs_endpoint_rejects_an_escaping_project():
    h, box = _handler()
    h._get_api("/local/docs", {"project": ["../../etc"]})
    assert box["code"] == 400


def test_docs_all_scope_tags_each_doc_with_its_project():
    name, d = _mkproject("proj_docs_all")
    _write(d, "one.md", "# One\n")
    h, box = _handler()
    h._get_api("/local/docs", {"project": ["*"]})
    assert box["code"] == 200
    mine = [a for a in box["obj"]["docs"] if a["path"] == "one.md"]
    assert [a["project"] for a in mine] == [f"/{name}"]


def test_docs_endpoint_returns_one_docs_body_and_404s_an_escape():
    name, d = _mkproject("proj_docs_read")
    _write(d, "page.md", "# Hello\n\nHELLO\n")
    h, box = _handler()
    h._get_api("/local/docs", {"project": [name], "path": ["page.md"]})
    assert box["code"] == 200 and "HELLO" in box["obj"]["body"]

    h2, box2 = _handler()
    h2._get_api("/local/docs", {"project": [name], "path": ["../escape.md"]})
    assert box2["code"] == 404
