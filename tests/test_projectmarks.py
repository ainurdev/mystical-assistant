"""bridge/projectmarks.py: a project's mark (letters, icon or logo, plus a
colour), the logo store, a repo's own pictures, PICK LOGOS and the stylist's
writes, and what becomes of the marks the retired Rivendell sync left.

GitHub and the downloads are stubbed: what is under test is which repo ends up
wearing what, and that a mark you set yourself is never overwritten.
Run: python -m pytest tests/test_projectmarks.py -v"""

import base64
import hashlib
import io
import struct
import subprocess

import pytest

from bridge import config, git, project_config, projectmarks

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24
PNG2 = b"\x89PNG\r\n\x1a\n" + b"\x01" * 24
SVG = b'<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'


@pytest.fixture(autouse=True)
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "project_config.json"))
    monkeypatch.setattr(projectmarks, "_PATH", str(tmp_path / "project_marks.json"))


# --- the mark itself ---------------------------------------------------------

def test_sniff_reads_the_bytes_not_a_name():
    assert projectmarks.sniff(PNG) == "png"
    assert projectmarks.sniff(b"\xff\xd8\xff\xe0rest") == "jpg"
    assert projectmarks.sniff(b"RIFF\x00\x00\x00\x00WEBPVP8 ") == "webp"
    assert projectmarks.sniff(SVG) == "svg"
    assert projectmarks.sniff(b"\xef\xbb\xbf  <svg/>") == "svg"
    assert projectmarks.sniff(b"<html><body>hi</body></html>") is None
    assert projectmarks.sniff(b"GIF89a") is None


def test_letters_without_a_colour_is_no_mark():
    assert projectmarks.set_mark("/r", {"kind": "letters"}) is None
    assert project_config.mark("/r") is None
    assert projectmarks.set_mark("/r", {"kind": "letters", "color": "#1d2b64"}) == {
        "kind": "letters", "color": "#1d2b64"}


def test_an_icon_mark_round_trips_and_bad_fields_are_refused():
    m = projectmarks.set_mark("/r", {"kind": "icon", "icon": "mountain-snow", "color": "var(--purple)"})
    assert m == {"kind": "icon", "icon": "mountain-snow", "color": "var(--purple)"}
    assert project_config.marks() == {"/r": m}
    for bad in ({"kind": "icon", "icon": "../x"}, {"kind": "icon", "icon": "a" * 60},
                {"kind": "letters", "color": "red; background:url(x)"},
                {"kind": "letters", "color": "color-mix(in srgb, red, blue)"},
                {"kind": "sticker"}, {"kind": "logo", "logo": "nope.png"}, "icon"):
        with pytest.raises(ValueError):
            projectmarks.set_mark("/r", bad)
    assert project_config.mark("/r") == m          # a refused edit changes nothing


def test_a_logo_is_stored_with_its_mark_and_served_by_its_hash():
    m = projectmarks.set_mark("/r", {"kind": "logo", "color": "#ff5b1f"},
                              logo_data=base64.b64encode(PNG).decode())
    assert m["kind"] == "logo" and "plate" not in m and m["logo"].endswith(".png")
    data, ctype = projectmarks.logo(m["logo"])
    assert data == PNG and ctype == "image/png"
    assert projectmarks.logo("../project_config.json") is None


def test_a_replaced_logo_is_dropped():
    first = projectmarks.set_mark("/r", {"kind": "logo"}, logo_data=base64.b64encode(PNG).decode())
    second = projectmarks.set_mark("/r", {"kind": "logo"},
                                   logo_data=base64.b64encode(SVG).decode())
    assert second["logo"].endswith(".svg")
    assert projectmarks.logo(first["logo"]) is None and projectmarks.logo(second["logo"]) is not None


def test_a_logo_that_is_not_an_image_or_too_big_is_refused():
    for raw in (b"<html>x</html>", b"\x89PNG\r\n\x1a\n" + b"\x00" * projectmarks.LOGO_MAX):
        with pytest.raises(ValueError):
            projectmarks.set_mark("/r", {"kind": "logo"}, logo_data=base64.b64encode(raw).decode())
    with pytest.raises(ValueError):
        projectmarks.set_mark("/r", {"kind": "logo"}, logo_data="not base64!!")
    assert project_config.mark("/r") is None


# --- downloads (PICK LOGOS' organization pictures) ----------------------------

def test_download_takes_only_https_and_never_raises(monkeypatch):
    seen = []

    class Resp:
        def __init__(self, body):
            self.body = body

        def read(self, n):
            return self.body[:n]

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    class Opener:
        def open(self, req, timeout):
            seen.append(req.full_url)
            if "redirect" in req.full_url:      # what _NoRedirect turns a 3xx into
                raise projectmarks.urllib.error.HTTPError(req.full_url, 302, "Found", {}, None)
            if "broken" in req.full_url:
                raise projectmarks.http_client_error("IncompleteRead")
            return Resp(b"<html>not a logo</html>" if "html" in req.full_url else PNG)
    monkeypatch.setattr(projectmarks, "_opener", Opener())
    monkeypatch.setattr(projectmarks, "http_client_error", RuntimeError, raising=False)
    assert projectmarks._download("https://s3.example/logo.png") == PNG
    assert projectmarks._download("http://localhost:3099/logo.png") is None
    assert projectmarks._download("http://evil.example/logo.png") is None
    assert projectmarks._download("file:///etc/passwd") is None
    assert projectmarks._download("https://s3.example/html") is None
    assert projectmarks._download("https://s3.example/redirect") is None
    assert projectmarks._download("https://s3.example/broken") is None
    assert projectmarks._download("https://[::1") is None          # urlparse itself raises
    assert projectmarks._download(None) is None
    assert seen == ["https://s3.example/logo.png", "https://s3.example/html",
                    "https://s3.example/redirect", "https://s3.example/broken"]


def test_a_download_takes_a_picture_up_to_the_bigger_cap(monkeypatch):
    big = PNG + b"\x00" * projectmarks.LOGO_MAX

    class Opener:
        def open(self, req, timeout):
            return io.BytesIO(PNG + b"\x00" * (projectmarks.RAW_MAX if "huge" in req.full_url
                                                else projectmarks.LOGO_MAX))
    monkeypatch.setattr(projectmarks, "_opener", Opener())
    assert len(projectmarks._download("https://s3.example/big.png")) == len(big)
    assert projectmarks._download("https://s3.example/huge.png") is None


def test_the_real_opener_follows_no_redirect():
    handler = projectmarks._NoRedirect()
    assert handler.redirect_request(None, None, 302, "Found", {}, "http://192.168.1.1/x") is None


# --- a background (plate) behind a logo ----------------------------------------

def test_a_plate_rides_only_on_a_logo():
    m = projectmarks.set_mark("/r", {"kind": "logo", "plate": "light"}, logo_data=base64.b64encode(PNG).decode())
    assert m["plate"] == "light"
    for bad in ({"kind": "logo", "logo": m["logo"], "plate": "pink"}, {"kind": "icon", "icon": "rocket", "plate": "dark"}):
        with pytest.raises(ValueError):
            projectmarks.set_mark("/r", bad)
    assert project_config.mark("/r") == m                          # a refused edit changes nothing


# --- the marks the retired Rivendell sync left ------------------------------------

def _rv_mark(rel, **kw):
    """A mark the Rivendell sync left: its client's logo, stored here, and who lent it."""
    m = projectmarks.set_mark(rel, {"kind": "logo"}, logo_data=base64.b64encode(SVG).decode())
    m = {**m, "source": "rivendell", "rv": {"instance": "prod", "client": "c1", "name": "ACME", "logo_id": "doc-c1"}, **kw}
    project_config.set_mark(rel, m)
    return m


def test_a_background_alone_on_a_mark_rivendell_left_makes_it_yours():
    left = _rv_mark("/a", color="#000000")
    shown = {k: v for k, v in left.items() if k not in ("source", "rv")}   # what the editor sends back
    assert projectmarks.set_mark("/a", {**shown, "plate": "light"}) == {**shown, "plate": "light"}


def test_a_save_drops_the_retired_sync_and_the_logos_only_its_undo_kept():
    worn = _rv_mark("/a")["logo"]
    d = projectmarks._load()
    d["logos"][named(PNG2)] = base64.b64encode(PNG2).decode()
    d["rivendell"] = {"sync": True, "undo": {"/b": {"kind": "logo", "logo": named(PNG2)}}, "dismissed": ["/b"]}
    projectmarks._save(d)
    projectmarks.set_mark("/c", {"kind": "icon", "icon": "car"})
    d = projectmarks._load()
    assert "rivendell" not in d and list(d["logos"]) == [worn]


# --- the repo's own logo -----------------------------------------------------

ICO = b"\x00\x00\x01\x00\x01\x00\x10\x10" + b"\x00" * 30      # a real .ico: nothing here decodes one


def png(n):
    return b"\x89PNG\r\n\x1a\n" + bytes([n]) * 24


def svg(n):
    return f'<svg xmlns="http://www.w3.org/2000/svg"><title>{n}</title></svg>'.encode()


def named(data):
    return f"{hashlib.sha256(data).hexdigest()}.{projectmarks.sniff(data)}"


@pytest.fixture
def base(tmp_path, monkeypatch):
    """BASE_PATH in a temp dir, and nothing read from a repo yet."""
    root = tmp_path / "base"
    root.mkdir()
    monkeypatch.setattr(config, "BASE_PATH", str(root))
    monkeypatch.setattr(projectmarks, "_found", {})
    monkeypatch.setattr(projectmarks, "_read", {})
    return root


def repo(base, name, files):
    """A git repo under BASE_PATH whose index holds these files (path -> bytes)."""
    d = base / name
    d.mkdir(parents=True, exist_ok=True)
    for p, data in files.items():
        (d / p).parent.mkdir(parents=True, exist_ok=True)
        (d / p).write_bytes(data)
    subprocess.run(["git", "init", "-q", str(d)], check=True)
    subprocess.run(["git", "-C", str(d), "add", "-A"], check=True)
    return "/" + name


def test_a_repo_with_no_mark_wears_its_own_icon(base):
    rel = repo(base, "app", {"public/favicon.svg": svg(1), "public/logo.svg": svg(2), "README.md": b"# app"})
    assert projectmarks.marks([rel])[rel] == {"kind": "logo", "logo": named(svg(1)),
                                              "repo": "public/favicon.svg", "auto": True}
    assert projectmarks.logo(named(svg(1))) == (svg(1), "image/svg+xml")
    assert project_config.mark(rel) is None            # worn, never stored


def test_an_icon_beats_a_logo_and_a_bigger_icon_a_smaller_one(base):
    rel = repo(base, "app", {"logo.svg": svg(1), "public/favicon-16.png": png(1),
                             "assets/apple-touch-icon.png": png(2), "public/icon-512.png": png(3)})
    assert projectmarks.marks([rel])[rel]["repo"] == "public/icon-512.png"
    assert [i["path"] for i in projectmarks.repo_images(rel)] == [
        "public/icon-512.png", "assets/apple-touch-icon.png", "public/favicon-16.png", "logo.svg"]


def test_a_logo_alone_is_offered_but_never_worn(base):
    # a repo's logo.* is often a wordmark, too wide for a tile
    rel = repo(base, "site", {"public/logo.svg": svg(1)})
    assert rel not in projectmarks.marks([rel])
    assert projectmarks.repo_images(rel) == [{"path": "public/logo.svg", "logo": named(svg(1))}]


def test_a_tests_picture_a_real_ico_and_an_untracked_file_are_not_the_repos(base):
    rel = repo(base, "app", {"test/screenshots/brand/logo-dark.png": png(1), "public/favicon.ico": ICO,
                             "node_modules/x/icon.svg": svg(9)})
    (base / "app" / "public" / "icon.svg").write_bytes(svg(2))      # never added
    assert rel not in projectmarks.marks([rel]) and projectmarks.repo_images(rel) == []


def test_a_favicon_ico_with_a_png_inside_is_worn(base):
    rel = repo(base, "cloud", {"app/favicon.ico": png(1), "public/logo.svg": svg(1)})
    assert projectmarks.marks([rel])[rel]["repo"] == "app/favicon.ico"
    assert projectmarks.logo(named(png(1))) == (png(1), "image/png")


def test_a_mark_you_set_and_rivendells_logo_beat_the_repos_icon(base):
    a, b, c, e = (repo(base, n, {"public/icon.svg": svg(1)}) for n in ("a", "b", "c", "e"))
    project_config.set_mark(a, {"kind": "icon", "icon": "receipt"})
    project_config.set_mark(b, {"kind": "logo", "logo": "x.png", "source": "rivendell", "rv": {"name": "ACME"}})
    project_config.set_mark(c, {"kind": "letters", "source": "rivendell", "color": "#112233", "rv": {"name": "ACME"}})
    project_config.set_mark(e, {"kind": "letters"})                   # BACK TO LETTERS
    got = projectmarks.marks([a, b, c, e])
    assert got[a] == {"kind": "icon", "icon": "receipt"} and got[b]["logo"] == "x.png" and got[e] == {"kind": "letters"}
    # a colour-only mark the sync left (its client lent no logo): the repo's icon in that colour
    assert got[c] == {"kind": "logo", "source": "rivendell", "color": "#112233", "rv": {"name": "ACME"},
                      "logo": named(svg(1)), "repo": "public/icon.svg", "auto": True}


def test_back_to_letters_on_a_repos_icon_sticks(base):
    rel = repo(base, "app", {"public/icon.svg": svg(1)})
    assert projectmarks.set_mark(rel, None) == {"kind": "letters"}
    assert projectmarks.marks([rel])[rel] == {"kind": "letters"}


def test_a_mark_on_one_of_the_repos_files_follows_that_file(base):
    rel = repo(base, "app", {"public/icon.svg": svg(1), "public/logo.svg": svg(2)})
    m = projectmarks.set_mark(rel, {"kind": "logo", "repo": "public/logo.svg", "logo": named(svg(2)),
                                    "auto": True, "color": "#112233"})
    # stored as the path, not the bytes; sent back as the listing shows it, so the tile needn't wait for one
    assert project_config.mark(rel) == {"kind": "logo", "repo": "public/logo.svg", "color": "#112233"}
    assert m == projectmarks.marks([rel])[rel] == {**project_config.mark(rel), "logo": named(svg(2))}
    (base / "app" / "public" / "logo.svg").write_bytes(svg(30))
    assert projectmarks.marks([rel])[rel]["logo"] == named(svg(30))
    assert projectmarks.logo(named(svg(2))) is None          # the old bytes are gone
    assert projectmarks.logo(named(svg(30))) == (svg(30), "image/svg+xml")


def test_a_mark_on_a_repo_file_must_be_one_of_its_images(base):
    rel = repo(base, "app", {"public/icon.svg": svg(1), "README.md": b"# hi", "notes/logo.txt": b"x"})
    repo(base, "other", {"public/icon.svg": svg(2)})
    (base / "app" / "public" / "brand.svg").write_bytes(svg(3))      # never added
    for path in ("README.md", "notes/logo.txt", "../other/public/icon.svg", "public/brand.svg", "/etc/hosts", ""):
        with pytest.raises(ValueError):
            projectmarks.set_mark(rel, {"kind": "logo", "repo": path})
    assert project_config.mark(rel) is None


def test_a_tracked_symlink_out_of_the_repo_is_never_read(base, tmp_path):
    secret = tmp_path / "secret.svg"
    secret.write_bytes(svg(1))
    (base / "app" / "public").mkdir(parents=True)
    (base / "app" / "public" / "icon.svg").symlink_to(secret)
    rel = repo(base, "app", {})
    assert rel not in projectmarks.marks([rel]) and projectmarks.repo_images(rel) == []
    with pytest.raises(ValueError):
        projectmarks.set_mark(rel, {"kind": "logo", "repo": "public/icon.svg"})


def test_a_dropped_logo_replaces_a_mark_on_a_repo_file(base):
    rel = repo(base, "app", {"public/icon.svg": svg(1)})
    m = projectmarks.set_mark(rel, {"kind": "logo", "repo": "public/icon.svg"},
                              logo_data=base64.b64encode(PNG).decode())
    assert m["logo"].endswith(".png") and "repo" not in m


def test_the_listing_asks_git_again_only_when_the_index_changes(base, monkeypatch):
    # the dashboard lists projects every ten seconds
    rel = repo(base, "app", {"public/icon.svg": svg(1)})
    calls = []
    real = git._run
    monkeypatch.setattr(git, "_run", lambda *a, **k: calls.append(a) or real(*a, **k))
    projectmarks.marks([rel])
    projectmarks.marks([rel])
    assert len(calls) == 1
    (base / "app" / "public" / "apple-touch-icon.png").write_bytes(png(1))
    subprocess.run(["git", "-C", str(base / "app"), "add", "-A"], check=True)
    assert len(projectmarks.repo_images(rel)) == 2 and len(calls) == 2


def test_letters_on_a_colour_only_rivendell_mark_wearing_the_repos_icon_is_yours(base):
    # LETTERS keeps the client's colour but drops the repo's icon: a change, so it's yours
    rel = repo(base, "app", {"public/icon.svg": svg(1)})
    project_config.set_mark(rel, {"kind": "letters", "source": "rivendell", "color": "#336699", "rv": {"name": "ACME"}})
    assert projectmarks.marks([rel])[rel]["auto"]
    assert projectmarks.set_mark(rel, {"kind": "letters", "color": "#336699"}) == {"kind": "letters", "color": "#336699"}
    assert projectmarks.marks([rel])[rel] == {"kind": "letters", "color": "#336699"}


def test_an_android_launcher_icon_counts_as_an_icon(base):
    rel = repo(base, "app", {"public/android-chrome-512x512.png": png(1),
                             "android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png": png(2)})
    assert projectmarks.marks([rel])[rel]["repo"] == "public/android-chrome-512x512.png"
    assert [i["path"] for i in projectmarks.repo_images(rel)] == [
        "public/android-chrome-512x512.png", "android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png"]


def test_a_name_git_cant_decode_or_a_bad_stored_path_never_sinks_the_listing(base, monkeypatch):
    rel = repo(base, "app", {"public/icon.svg": svg(1)})
    other = repo(base, "other", {"public/icon.svg": svg(2)})
    project_config.set_mark(other, {"kind": "logo", "repo": "public/\x00icon.svg"})     # a hand-edited config

    def undecodable(*a, **k):
        raise UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid start byte")       # a tracked name that isn't UTF-8
    monkeypatch.setattr(git, "_run", undecodable)
    got = projectmarks.marks([rel, other])
    assert rel not in got and got[other] == {"kind": "logo", "repo": "public/\x00icon.svg"}


# --- PICK LOGOS and the AUTO background ---------------------------------------

def _ihdr(w, h):
    return b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + struct.pack(">II", w, h) + b"\x08\x02\x00\x00\x00"


@pytest.fixture
def offline(monkeypatch):
    """No GitHub here: the organization source finds nothing."""
    monkeypatch.setattr(projectmarks, "_org", lambda rel, seen: None)


def test_pick_gives_a_backend_its_frontends_logo(base, offline):
    front = repo(base, "mono/unideck", {"public/icon.svg": svg(1)})
    back = repo(base, "mono/unideck-api", {"README.md": b"# api"})
    assert projectmarks.pick_all() == {"picked": [{"rel": back, "how": "frontend", "from": front}], "none": []}
    m = project_config.mark(back)
    assert m["source"] == "pick" and m["pick"] == {"how": "frontend", "from": front}
    assert projectmarks.logo(m["logo"]) == (svg(1), "image/svg+xml")        # a copy, kept in the store


def test_pick_takes_a_brand_file_named_for_the_repo_but_not_a_clients(base, offline):
    own = repo(base, "kantoor", {"public/brand/kantoor-logo-dark.svg": svg(1)})
    plain = repo(base, "shop", {"src/assets/logo.svg": svg(2)})
    hub = repo(base, "hub", {"raw/brand/elvou/elvou-logo.svg": svg(3), "assets/logo/unideck-logo-primary.svg": svg(4)})
    got = projectmarks.pick_all()
    assert {p["rel"]: p["how"] for p in got["picked"]} == {own: "brand", plain: "brand"} and got["none"] == [hub]
    assert project_config.mark(own) == {"kind": "logo", "repo": "public/brand/kantoor-logo-dark.svg",
                                         "source": "pick", "pick": {"how": "brand"}}
    assert projectmarks.marks([own])[own]["logo"] == named(svg(1))           # kept by path, read afresh


def test_pick_takes_an_organizations_picture_but_not_a_person_or_githubs_default(base, monkeypatch):
    users = {"acme": ("Organization", "https://avatars.example/u/1?v=4"),
             "jane": ("User", "https://avatars.example/u/2?v=4"),
             "fresh": ("Organization", "https://avatars.example/u/3?v=4")}
    pics = {"https://avatars.example/u/1?v=4&s=256": _ihdr(256, 256),
            "https://avatars.example/u/2?v=4&s=256": _ihdr(256, 256),
            "https://avatars.example/u/3?v=4&s=256": _ihdr(420, 420)}     # GitHub's generated default ignores s=
    a, b, c = (repo(base, n, {"README.md": b"x"}) for n in ("a", "b", "c"))
    monkeypatch.setattr(projectmarks, "_owner", lambda rel: {a: "acme", b: "jane", c: "fresh"}.get(rel))
    monkeypatch.setattr(projectmarks, "_github_user", lambda owner: users.get(owner))
    monkeypatch.setattr(projectmarks, "_download", lambda url: pics.get(url))
    got = projectmarks.pick_all()
    assert got == {"picked": [{"rel": a, "how": "org", "from": "acme"}], "none": [b, c]}
    assert projectmarks.logo(project_config.mark(a)["logo"])[0] == _ihdr(256, 256)


def test_pick_leaves_yours_rivendells_and_auto_icons_alone(base, offline):
    files = {"src/assets/logo.svg": svg(1)}
    yours, back, riv = (repo(base, n, files) for n in ("yours", "back", "riv"))
    auto = repo(base, "auto", {"public/icon.svg": svg(2), **files})
    project_config.set_mark(yours, {"kind": "icon", "icon": "receipt"})
    project_config.set_mark(back, {"kind": "letters"})                       # BACK TO LETTERS
    project_config.set_mark(riv, {"kind": "letters", "source": "rivendell", "color": "#112233"})
    assert projectmarks.pick_all() == {"picked": [], "none": []}
    assert project_config.mark(auto) is None and project_config.mark(back) == {"kind": "letters"}


def test_a_pick_made_while_you_set_a_mark_is_dropped(base, offline, monkeypatch):
    rel = repo(base, "shop", {"src/assets/logo.svg": svg(1)})
    real = projectmarks._brand

    def brand_then_you(r):
        project_config.set_mark(rel, {"kind": "icon", "icon": "receipt"})   # set while the pick looked
        return real(r)
    monkeypatch.setattr(projectmarks, "_brand", brand_then_you)
    assert projectmarks.pick_all()["picked"] == []
    assert project_config.mark(rel) == {"kind": "icon", "icon": "receipt"}


def test_undo_takes_back_only_picks_still_as_picked(base, offline):
    a, b = (repo(base, n, {"src/assets/logo.svg": svg(i)}) for i, n in enumerate(("a", "b")))
    projectmarks.pick_all()
    projectmarks.set_mark(b, {"kind": "icon", "icon": "receipt"})          # you changed one since
    assert projectmarks.undo_picks() == {"undone": 1}
    assert project_config.mark(a) is None and project_config.mark(b) == {"kind": "icon", "icon": "receipt"}
    assert projectmarks.undo_picks() == {"undone": 0}


def test_a_repo_icon_beats_an_earlier_pick(base, offline):
    rel = repo(base, "app", {"src/assets/logo.svg": svg(1)})
    projectmarks.pick_all()
    (base / "app" / "public").mkdir()
    (base / "app" / "public" / "icon.svg").write_bytes(svg(2))
    subprocess.run(["git", "-C", str(base / "app"), "add", "-A"], check=True)
    assert projectmarks.marks([rel])[rel] == {"kind": "logo", "logo": named(svg(2)), "repo": "public/icon.svg", "auto": True}


def test_none_pins_no_background_and_auto_stores_nothing():
    m = projectmarks.set_mark("/r", {"kind": "logo", "plate": "none"}, logo_data=base64.b64encode(PNG).decode())
    assert m["plate"] == "none"
    assert "plate" not in projectmarks.set_mark("/r", {"kind": "logo", "logo": m["logo"]})   # AUTO: nothing stored


def test_pick_matches_the_repos_name_as_a_word_never_a_lookalike(base, offline):
    app = repo(base, "app", {"src/assets/auth/apple-logo.svg": svg(1)})            # "app" isn't apple
    notes = repo(base, "ai-notes", {"docs/airtable-logo.svg": svg(2)})            # "ai" isn't airtable
    scratch = repo(base, "_scratch", {"x/brand/acme-logo.svg": svg(3)})           # no name to match: nothing
    nr = repo(base, "nr-kantoor", {"public/brand/NR-rgb_logo_default.svg": svg(4)})  # the word nr, as NR's file says
    got = projectmarks.pick_all()
    assert [p["rel"] for p in got["picked"]] == [nr] and sorted(got["none"]) == sorted([app, notes, scratch])


def test_a_bare_logo_counts_only_when_it_is_the_repos_one(base, offline):
    hub = repo(base, "hub", {"clients/acme/logo.svg": svg(1), "clients/zeta/logo.svg": svg(2)})
    shop = repo(base, "shop", {"src/assets/logo.svg": svg(3), "public/logo.svg": svg(3)})   # the same file twice
    got = projectmarks.pick_all()
    assert [p["rel"] for p in got["picked"]] == [shop] and got["none"] == [hub]


def test_a_frontend_counts_only_in_the_same_folder(base, offline):
    repo(base, "client-b/portal", {"public/icon.svg": svg(1)})
    api = repo(base, "client-a/portal-api", {"README.md": b"x"})
    assert projectmarks.pick_all() == {"picked": [], "none": [api]}


def test_a_run_that_picks_nothing_keeps_the_last_undo(base, offline):
    rel = repo(base, "shop", {"src/assets/logo.svg": svg(1)})
    assert len(projectmarks.pick_all()["picked"]) == 1
    assert projectmarks.pick_all() == {"picked": [], "none": []}          # pressed again: nothing left to pick
    assert projectmarks.undo_picks() == {"undone": 1} and project_config.mark(rel) is None


# --- the logo stylist (bridge/logostyle.py runs it) ----------------------------

def _cands(rel):
    return next(p for p in projectmarks.style_candidates()["projects"] if p["rel"] == rel)


def test_style_candidates_offer_what_it_wears_its_frontend_and_its_pictures_once(base):
    front = repo(base, "mono/unideck", {"public/icon.svg": svg(1), "src/logo-text.svg": svg(2)})
    back = repo(base, "mono/unideck-api", {"README.md": b"# Unideck API\n\nThe deck's backend.\n"})
    app = repo(base, "app", {"public/favicon.svg": svg(3), "web/public/favicon.svg": svg(3), "src/logo.svg": svg(4)})
    mine = repo(base, "mine", {"public/icon.svg": svg(5)})
    projectmarks.set_mark(mine, {"kind": "icon", "icon": "receipt"})
    got = projectmarks.style_candidates()
    assert got["yours"] == [mine] and {p["rel"] for p in got["projects"]} == {front, back, app}
    assert _cands(app)["cands"] == [
        {"id": "c1", "logo": named(svg(3)), "src": "now", "path": "public/favicon.svg"},
        {"id": "c2", "logo": named(svg(4)), "src": "repo", "path": "src/logo.svg"}]       # the copy counts once
    assert _cands(back)["cands"] == [{"id": "c1", "logo": named(svg(1)), "src": "frontend", "from": front}]
    assert _cands(back)["about"] == "Unideck API — The deck's backend." and _cands(back)["wears"] == "letters"
    assert _cands(front)["wears"] == "auto" and _cands(front)["name"] == "unideck"
    assert got["sig"] == projectmarks.style_candidates()["sig"]                          # stable while nothing moves


def test_style_candidates_stop_at_eight(base):
    repo(base, "big", {f"public/icon-{n}.png": png(n) for n in range(1, 13)})
    assert len(projectmarks.style_candidates()["projects"][0]["cands"]) == projectmarks.STYLE_CANDS == 8


def test_the_stylist_may_restyle_a_mark_rivendell_left_and_undo_brings_it_back(base):
    rel = repo(base, "ib", {"apps/mobile/assets/icon.png": png(1)})
    wordmark = _rv_mark(rel, color="#000000", plate="light")["logo"]
    p = _cands(rel)
    assert p["wears"] == "rivendell" and [c["src"] for c in p["cands"]] == ["now", "repo"]
    got = projectmarks.apply_style(rel, p["cands"][1], plate="auto", color="#3168d0", why="its own app icon", run="r1")
    assert got["how"] == ["logo", "background", "colour"] and got["before"]["logo"] == wordmark
    assert project_config.mark(rel) == {"kind": "logo", "repo": "apps/mobile/assets/icon.png", "color": "#3168d0",
                                         "source": "style", "styled": "its own app icon"}
    assert projectmarks.logo(wordmark) is not None                    # the wordmark waits for Undo
    assert _cands(rel)["wears"] == "style"                              # and the next run may redo it
    assert projectmarks.undo_style() == {"undone": 1}
    back = project_config.mark(rel)
    assert back["source"] == "rivendell" and back["logo"] == wordmark and back["plate"] == "light"


def test_keeping_a_logo_rivendell_left_makes_it_the_stylists(base):
    rel = repo(base, "efas", {"public/favicon.svg": svg(1)})
    left = _rv_mark(rel, color="#234b3f")
    got = projectmarks.apply_style(rel, _cands(rel)["cands"][0], plate="none", color="#3f8f75", why="its own mark",
                                   run="r1")
    assert got["how"] == ["background", "colour"]
    assert project_config.mark(rel) == {"kind": "logo", "logo": left["logo"], "color": "#3f8f75", "plate": "none",
                                         "source": "style", "styled": "its own mark"}


def test_the_stylist_names_an_icon_when_nothing_is_the_projects_own(base):
    rel = repo(base, "yggdrasil", {"raw/brand/elvou/elvou-app-icon.png": png(1)})
    got = projectmarks.apply_style(rel, None, icon="tree-deciduous", color="#57ab5a", why="a world tree", run="r1")
    assert got["how"] == ["icon", "colour"]
    assert project_config.mark(rel) == {"kind": "icon", "icon": "tree-deciduous", "color": "#57ab5a",
                                         "source": "style", "styled": "a world tree"}


def test_keeping_its_own_icon_stores_it_by_path_with_its_colour(base):
    rel = repo(base, "osanwe", {"apps/web/public/favicon.svg": svg(1)})
    got = projectmarks.apply_style(rel, _cands(rel)["cands"][0], plate="auto", color="#0b57d0", why="blue", run="r1")
    assert got["how"] == ["colour"]
    assert project_config.mark(rel) == {"kind": "logo", "repo": "apps/web/public/favicon.svg", "color": "#0b57d0",
                                         "source": "style", "styled": "blue"}
    assert projectmarks.marks([rel])[rel]["logo"] == named(svg(1))


def test_an_answer_that_changes_nothing_writes_nothing(base):
    rel = repo(base, "app", {"public/icon.svg": svg(1)})
    assert projectmarks.apply_style(rel, _cands(rel)["cands"][0], plate="auto", why="right", run="r1")["how"] == []
    assert project_config.mark(rel) is None


def test_a_backend_takes_a_copy_of_its_frontends_logo(base):
    repo(base, "mono/unideck", {"public/icon.svg": svg(1)})
    back = repo(base, "mono/unideck-api", {"README.md": b"x"})
    got = projectmarks.apply_style(back, _cands(back)["cands"][0], color="#3757f9", why="its frontend's", run="r1")
    assert got["how"] == ["logo", "colour"]
    m = project_config.mark(back)
    assert m["source"] == "style" and projectmarks.logo(m["logo"]) == (svg(1), "image/svg+xml")


def test_undo_style_puts_back_only_what_is_still_as_styled(base):
    a, b = repo(base, "a", {"public/icon.svg": svg(1)}), repo(base, "b", {"public/icon.svg": svg(2)})
    for rel in (a, b):
        projectmarks.apply_style(rel, _cands(rel)["cands"][0], color="#112233", why="x", run="r1")
    projectmarks.set_mark(b, {"kind": "icon", "icon": "car"})           # changed by hand since: yours
    assert projectmarks.style_candidates()["yours"] == [b]
    assert projectmarks.undo_style(a) == {"undone": 1} and project_config.mark(a) is None
    assert projectmarks.undo_style() == {"undone": 0} and project_config.mark(b) == {"kind": "icon", "icon": "car"}


def test_a_new_run_starts_a_new_undo(base):
    a = repo(base, "a", {"public/icon.svg": svg(1)})
    projectmarks.apply_style(a, _cands(a)["cands"][0], color="#112233", why="x", run="r1")
    projectmarks.apply_style(a, _cands(a)["cands"][0], color="#445566", why="y", run="r2")
    projectmarks.undo_style()
    assert project_config.mark(a)["color"] == "#112233"                  # what r2 found, not what r1 did


def test_a_colour_a_glance_cant_tell_apart_is_no_change(base):
    rel = repo(base, "apex", {"README.md": b"x"})
    _rv_mark(rel, color="#ea5b13")
    got = projectmarks.apply_style(rel, _cands(rel)["cands"][0], plate="auto", color="#e8562a", why="the lion", run="r1")
    assert got["how"] == [] and project_config.mark(rel)["color"] == "#ea5b13" and "styled" not in project_config.mark(rel)
    got = projectmarks.apply_style(rel, _cands(rel)["cands"][0], plate="auto", color="#5a7d6a", why="greener", run="r1")
    assert got["how"] == ["colour"] and project_config.mark(rel)["color"] == "#5a7d6a"


def test_a_mark_you_set_while_a_run_looks_stands(base):
    rel = repo(base, "app", {"public/icon.svg": svg(1), "src/logo.svg": svg(2)})
    c2 = _cands(rel)["cands"][1]                                        # offered: it wore its own icon then
    projectmarks.set_mark(rel, {"kind": "icon", "icon": "car"})          # then you set one by hand
    assert projectmarks.apply_style(rel, c2, color="#112233", why="x", run="r1")["how"] == []
    assert project_config.mark(rel) == {"kind": "icon", "icon": "car"}

