"""Unit tests for bridge.artifacts — the walk behind the dashboard's ARTIFACTS
tab. Pure filesystem code; a tmp_path repo is the whole fixture.
Run: `python3 -m pytest tests/test_artifacts.py -q`
"""

import os

from bridge import artifacts


def _write(root, rel, body=""):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(body)
    return p


def test_lists_pages_with_title_and_subject_folder(tmp_path):
    root = str(tmp_path)
    _write(root, ".mystical/design-drafts/agent-block/dashboard.html",
           "<!doctype html><head><title>Agent Block &mdash;  dashboard</title></head><body>")
    _write(root, "notes.html", "<body>no head at all")

    by_path = {a["path"]: a for a in artifacts.artifacts(root)}
    assert set(by_path) == {".mystical/design-drafts/agent-block/dashboard.html", "notes.html"}

    draft = by_path[".mystical/design-drafts/agent-block/dashboard.html"]
    assert draft["dir"] == ".mystical/design-drafts/agent-block"
    # Whitespace collapsed, entities decoded — a <title> is markup, not a string.
    assert draft["title"] == "Agent Block — dashboard"
    assert by_path["notes.html"] == {**by_path["notes.html"], "dir": "", "title": ""}


def test_skips_build_output_and_bundler_entry_points(tmp_path):
    root = str(tmp_path)
    _write(root, "web/package.json", "{}")
    _write(root, "web/index.html", "<body>vite entry")          # entry, not a page
    _write(root, "web/report.html", "<body>a page")             # a page
    _write(root, "docs/index.html", "<body>a real index page")  # no package.json here
    _write(root, "node_modules/pkg/demo.html", "<body>")
    _write(root, "web/dist/index.html", "<body>")

    assert {a["path"] for a in artifacts.artifacts(root)} == {"web/report.html", "docs/index.html"}


def test_skips_fragments_that_are_not_whole_pages(tmp_path):
    root = str(tmp_path)
    _write(root, "d/01-ladder.html", "<!doctype html><body>the page")
    _write(root, "d/_body-01.html", '<div class="hd"><h1>inlined into the page</h1></div>')
    _write(root, "d/_sprite.html", '<svg xmlns="http://www.w3.org/2000/svg"><symbol/></svg>')
    _write(root, "d/miniapp.part.html", "a title line\n<style>.wrap { position: fixed }</style>")
    _write(root, "d/snippet.html", "<script>analytics()</script>")

    assert {a["path"] for a in artifacts.artifacts(root)} == {"d/01-ladder.html"}


def test_skips_package_source_and_skill_assets(tmp_path):
    root = str(tmp_path)
    _write(root, "src/popup.html", "<!doctype html><body>extension source")
    _write(root, "vendor/dompdf/lib/mustRead.html", "<html><body>vendored readme")
    _write(root, ".claude/skills/design/guidelines/type-scale.html", "<html><body>swatch")
    _write(root, ".mystical/design-drafts/x/dashboard.html", "<!doctype html><body>a mockup")

    assert {a["path"] for a in artifacts.artifacts(root)} == {
        ".mystical/design-drafts/x/dashboard.html"}


def test_newest_first(tmp_path):
    root = str(tmp_path)
    old = _write(root, "old.html", "<body>")
    new = _write(root, "new.html", "<body>")
    os.utime(old, (1_000_000, 1_000_000))
    os.utime(new, (2_000_000, 2_000_000))
    assert [a["name"] for a in artifacts.artifacts(root)] == ["new.html", "old.html"]


def test_read_only_serves_what_the_walk_found(tmp_path):
    root = str(tmp_path)
    _write(root, "docs/page.html", "<body>hello")
    _write(root, "web/package.json", "{}")
    _write(root, "web/index.html", "<body>entry")
    outside = tmp_path.parent / "secret.html"
    outside.write_text("<body>not yours")

    assert artifacts.read(root, "docs/page.html") == b"<body>hello"
    assert artifacts.read(root, "web/index.html") is None      # skipped by the walk
    assert artifacts.read(root, "../secret.html") is None      # never in the listing
    assert artifacts.read(root, "docs/../docs/page.html") is None


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


def test_artifacts_endpoint_lists_a_repos_pages():
    name, d = _mkproject("proj_artifacts")
    _write(d, "docs/report.html", "<!doctype html><title>Report</title><body>")
    h, box = _handler()
    h._get_api("/local/artifacts", {"project": [name]})
    assert box["code"] == 200
    assert [(a["path"], a["title"]) for a in box["obj"]["artifacts"]] == [("docs/report.html", "Report")]


def test_artifacts_endpoint_rejects_an_escaping_project():
    h, box = _handler()
    h._get_api("/local/artifacts", {"project": ["../../etc"]})
    assert box["code"] == 400


def test_artifacts_all_scope_tags_each_page_with_its_project():
    name, d = _mkproject("proj_artifacts_all")
    _write(d, "one.html", "<body>")
    h, box = _handler()
    h._get_api("/local/artifacts", {"project": ["*"]})
    assert box["code"] == 200
    mine = [a for a in box["obj"]["artifacts"] if a["path"] == "one.html"]
    assert [a["project"] for a in mine] == [f"/{name}"]


def test_artifacts_raw_serves_html_and_404s_as_html():
    name, d = _mkproject("proj_artifacts_raw")
    _write(d, "page.html", "<body>HELLO")
    h, box = _handler()
    h._get_api("/local/artifacts/raw", {"project": [name], "path": ["page.html"]})
    assert box["code"] == 200 and b"HELLO" in box["data"]
    assert box["ctype"].startswith("text/html")

    # A missing page is iframed too, so its 404 body must still be HTML.
    h2, box2 = _handler()
    h2._get_api("/local/artifacts/raw", {"project": [name], "path": ["../escape.html"]})
    assert box2["code"] == 404 and box2["ctype"].startswith("text/html")
