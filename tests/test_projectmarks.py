"""bridge/projectmarks.py: a project's mark (letters, icon or logo, plus a
colour), the logo store, and following Rivendell's client logos and colours.

Rivendell, the repos' remotes and the logo downloads are all stubbed: what is
under test is which repo ends up wearing what, and that a mark you set yourself
is never overwritten.
Run: python -m pytest tests/test_projectmarks.py -v"""

import base64
import io

import pytest

from bridge import project_config, projectmarks, rivendell

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24
PNG2 = b"\x89PNG\r\n\x1a\n" + b"\x01" * 24
SVG = b'<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'


@pytest.fixture(autouse=True)
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "project_config.json"))
    monkeypatch.setattr(projectmarks, "_PATH", str(tmp_path / "project_marks.json"))
    monkeypatch.setattr(projectmarks, "_seen", {"at": 0.0, "matches": {}, "errors": [], "listed": 0,
                                                "asked": False, "answered": False,
                                                "projects": [], "unlinked": [], "named_by": {}})


@pytest.fixture
def riv(monkeypatch):
    """Rivendell's /plugin/projects, the repos here (rel -> remotes) and the
    logo downloads, all stubbed. Mutate the dict to change what each says."""
    world = {"projects": [], "errors": [], "local": {}, "logos": {}, "downloads": []}
    monkeypatch.setattr(rivendell, "projects", lambda: (world["projects"], world["errors"]))
    monkeypatch.setattr(projectmarks, "_local_slugs", lambda: world["local"])

    def download(url):
        world["downloads"].append(url)
        return world["logos"].get(url)
    monkeypatch.setattr(projectmarks, "_download", download)
    return world


def client(cid, logo=None, color=None, logo_id=None):
    return {"id": cid, "name": cid.upper(), "logoUrl": logo, "brandColor": color,
            "logoId": logo_id or (f"doc-{cid}" if logo else None)}


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


# --- matching ----------------------------------------------------------------

def test_match_takes_any_remote_and_either_side_of_a_mirror():
    projects = [
        {"id": "p1", "repositories": ["NationaleRijschool/Portal", "ainurdev/apex"],
         "client": client("nr", logo="https://s3/nr.png")},
        {"id": "p2", "repositories": ["ainurhq/rivendell"], "client": None},          # internal
        {"id": "p3", "repositories": ["ainurhq/ib"], "client": client("ib", color="#1d2b64")},
        {"id": "p4", "repositories": ["ainurhq/plain"], "client": client("plain")},    # nothing to lend
    ]
    local = {"/nr/portal": {"nationalerijschool/portal"}, "/nr/apex": {"ainurdev/apex", "nr/apex"},
             "/rivendell": {"ainurhq/rivendell"}, "/ib": {"ainurhq/ib"}, "/plain": {"ainurhq/plain"}}
    got = projectmarks.match(projects, local)
    assert sorted(got) == ["/ib", "/nr/apex", "/nr/portal"]
    assert got["/nr/apex"]["id"] == "p1" and got["/ib"]["id"] == "p3"


# --- following Rivendell ------------------------------------------------------

def test_import_dresses_every_match_but_keeps_a_mark_you_set(riv):
    riv["projects"] = [
        {"id": "p1", "instance_id": "prod", "repositories": ["acme/apex", "acme/portal", "acme/mine"],
         "client": client("nr", logo="https://s3/nr.png", color="#ff5b1f")},
        {"id": "p2", "instance_id": "prod", "repositories": ["acme/ib"], "client": client("ib", color="#1d2b64")},
    ]
    riv["local"] = {"/apex": {"acme/apex"}, "/portal": {"acme/portal"}, "/mine": {"acme/mine"},
                    "/ib": {"acme/ib"}, "/other": {"acme/other"}}
    riv["logos"] = {"https://s3/nr.png": PNG}
    mine = projectmarks.set_mark("/mine", {"kind": "icon", "icon": "receipt"})

    out = projectmarks.import_all()
    assert out == {"following": 3, "kept": ["/mine"], "clients": 2}
    apex, portal, ib = (project_config.mark(r) for r in ("/apex", "/portal", "/ib"))
    assert apex["kind"] == "logo" and apex["source"] == "rivendell" and apex["color"] == "#ff5b1f"
    assert apex["rv"] == {"instance": "prod", "client": "nr", "name": "NR", "logo_id": "doc-nr"}
    assert portal["logo"] == apex["logo"]
    assert riv["downloads"] == ["https://s3/nr.png"]          # one client, one download
    assert ib == {"kind": "letters", "source": "rivendell", "color": "#1d2b64",
                  "rv": {"instance": "prod", "client": "ib", "name": "IB", "logo_id": None}}
    assert project_config.mark("/mine") == mine
    assert project_config.mark("/other") is None
    s = projectmarks.state()
    assert s["sync"] is True and s["following"] == 3 and s["offer"] is None and s["can_undo"]


def test_undo_puts_back_what_the_import_changed_and_stops_following(riv):
    riv["projects"] = [{"id": "p1", "repositories": ["acme/a", "acme/b"], "client": client("c", color="#123456")}]
    riv["local"] = {"/a": {"acme/a"}, "/b": {"acme/b"}}
    mine = projectmarks.set_mark("/b", {"kind": "letters", "color": "var(--ok)"})
    assert projectmarks.import_all()["kept"] == ["/b"]
    assert projectmarks.undo() == {"undone": 1}
    assert project_config.mark("/a") is None and project_config.mark("/b") == mine
    s = projectmarks.state()
    assert s["sync"] is False and not s["can_undo"]
    assert s["offer"] is None                            # undone repos count as seen


def test_follow_takes_one_project_even_from_a_mark_you_set(riv):
    riv["projects"] = [{"id": "p1", "repositories": ["acme/b"], "client": client("c", color="#123456")}]
    riv["local"] = {"/b": {"acme/b"}}
    mine = projectmarks.set_mark("/b", {"kind": "icon", "icon": "car"})
    assert projectmarks.import_all(only="/b")["following"] == 1
    assert project_config.mark("/b")["source"] == "rivendell"
    assert projectmarks.state()["sync"] is False         # one project, not the switch
    projectmarks.undo()
    assert project_config.mark("/b") == mine


def test_the_offer_waits_for_a_repo_it_has_not_shown(riv):
    riv["projects"] = [{"id": "p1", "repositories": ["acme/a", "acme/b"],
                        "client": client("c", logo="https://s3/c.png")}]
    riv["local"] = {"/a": {"acme/a"}}
    offer = projectmarks.state(force=True)["offer"]
    assert offer == {"count": 1, "clients": ["C"], "logos": [{"url": "https://s3/c.png", "color": None}]}
    projectmarks.dismiss()
    assert projectmarks.state(force=True)["offer"] is None
    riv["local"]["/b"] = {"acme/b"}                      # a new clone of that client's repo
    assert projectmarks.state(force=True)["offer"]["count"] == 2


def test_refresh_follows_a_changed_logo_and_new_repos_but_never_your_mark(riv):
    nr = client("nr", logo="https://s3/nr-1.png", color="#ff5b1f", logo_id="doc-1")
    riv["projects"] = [{"id": "p1", "repositories": ["acme/a", "acme/b", "acme/c"], "client": nr}]
    riv["local"] = {"/a": {"acme/a"}, "/b": {"acme/b"}}
    riv["logos"] = {"https://s3/nr-1.png": PNG, "https://s3/nr-2.png": PNG2}
    projectmarks.import_all()
    old = project_config.mark("/a")["logo"]
    mine = projectmarks.set_mark("/b", {"kind": "icon", "icon": "car"})  # you change one by hand

    nr.update(logoUrl="https://s3/nr-2.png", logoId="doc-2", brandColor="#ee4400")
    riv["local"]["/c"] = {"acme/c"}
    assert projectmarks.refresh() == {"following": 2}
    a, c = project_config.mark("/a"), project_config.mark("/c")
    assert a["logo"] != old and a["color"] == "#ee4400" and a["rv"]["logo_id"] == "doc-2"
    assert c["logo"] == a["logo"]                         # a new clone wears it too
    assert project_config.mark("/b") == mine
    assert projectmarks.logo(old) is None or old in {m.get("logo") for m in
                                                     (projectmarks._load()["rivendell"]["undo"] or {}).values() if m}


def test_a_logo_that_fails_to_download_is_tried_again_next_time(riv):
    riv["projects"] = [{"id": "p1", "repositories": ["acme/a"], "client": client("c", logo="https://s3/c.png",
                                                                              color="#336699")}]
    riv["local"] = {"/a": {"acme/a"}}
    projectmarks.import_all()                             # download fails: the colour still lands
    assert project_config.mark("/a")["kind"] == "letters" and project_config.mark("/a")["rv"]["logo_id"] is None
    riv["logos"]["https://s3/c.png"] = PNG
    projectmarks.refresh()
    assert project_config.mark("/a")["kind"] == "logo"
    assert riv["downloads"] == ["https://s3/c.png", "https://s3/c.png"]


def test_refresh_does_nothing_while_following_is_off(riv):
    riv["projects"] = [{"id": "p1", "repositories": ["acme/a"], "client": client("c", color="#336699")}]
    riv["local"] = {"/a": {"acme/a"}}
    assert projectmarks.refresh() == {"following": 0, "skipped": "off"}
    assert project_config.mark("/a") is None
    projectmarks.set_sync(True)                           # the switch catches up at once
    assert project_config.mark("/a")["color"] == "#336699"


def test_no_rivendell_means_nothing_to_offer(riv):
    riv["local"] = {"/r": {"acme/r"}}
    s = projectmarks.state(force=True)
    assert s["asked"] is False and s["available"] is False and s["offer"] is None
    assert s["unlinked"] == [] and s["projects"] == []                  # and nothing to LINK to
    riv["errors"] = [{"instance_id": "prod", "instance": "prod", "error": "not_deployed", "detail": "x"}]
    s = projectmarks.state(force=True)
    assert s["asked"] is True and s["available"] is False and s["errors"][0]["error"] == "not_deployed"


def test_download_takes_only_https_or_a_local_rivendell_and_never_raises(monkeypatch):
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
    assert projectmarks._download("http://localhost:3099/logo.png") == PNG
    assert projectmarks._download("http://evil.example/logo.png") is None
    assert projectmarks._download("file:///etc/passwd") is None
    assert projectmarks._download("https://s3.example/html") is None
    assert projectmarks._download("https://s3.example/redirect") is None
    assert projectmarks._download("https://s3.example/broken") is None
    assert projectmarks._download("https://[::1") is None          # urlparse itself raises
    assert projectmarks._download(None) is None
    assert seen == ["https://s3.example/logo.png", "http://localhost:3099/logo.png", "https://s3.example/html",
                    "https://s3.example/redirect", "https://s3.example/broken"]


def test_a_client_logo_may_be_bigger_than_one_you_drop(riv, monkeypatch):
    big = PNG + b"\x00" * projectmarks.LOGO_MAX                 # Elvou's is a 1024px PNG of 1.9 MB
    riv["projects"] = [{"id": "p1", "instance_id": "prod", "repositories": ["acme/a"],
                        "client": client("c", logo="https://s3/c.png", color="#123456")}]
    riv["local"] = {"/a": {"acme/a"}}
    riv["logos"] = {"https://s3/c.png": big}
    projectmarks.import_all()
    m = project_config.mark("/a")
    assert m["kind"] == "logo" and projectmarks.logo(m["logo"])[0] == big
    with pytest.raises(ValueError):                                # a drop keeps the small cap
        projectmarks.set_mark("/b", {"kind": "logo"}, logo_data=base64.b64encode(big).decode())


def test_a_download_takes_a_client_logo_up_to_the_bigger_cap(monkeypatch):
    big = PNG + b"\x00" * projectmarks.LOGO_MAX

    class Opener:
        def open(self, req, timeout):
            return io.BytesIO(PNG + b"\x00" * (projectmarks.RV_LOGO_MAX if "huge" in req.full_url
                                                else projectmarks.LOGO_MAX))
    monkeypatch.setattr(projectmarks, "_opener", Opener())
    assert len(projectmarks._download("https://s3.example/big.png")) == len(big)
    assert projectmarks._download("https://s3.example/huge.png") is None


def test_the_real_opener_follows_no_redirect():
    handler = projectmarks._NoRedirect()
    assert handler.redirect_request(None, None, 302, "Found", {}, "http://192.168.1.1/x") is None


def test_an_edit_made_while_logos_download_is_never_overwritten(riv, monkeypatch):
    riv["projects"] = [{"id": "p1", "repositories": ["acme/a"], "client": client("c", logo="https://s3/c.png")}]
    riv["local"] = {"/a": {"acme/a"}}
    riv["logos"] = {"https://s3/c.png": PNG}
    real = projectmarks._fetch_logos

    def slow(matches, known):            # the user saves an icon mid-download
        projectmarks.set_mark("/a", {"kind": "icon", "icon": "car"})
        return real(matches, known)
    monkeypatch.setattr(projectmarks, "_fetch_logos", slow)
    assert projectmarks.import_all()["kept"] == ["/a"]
    assert project_config.mark("/a") == {"kind": "icon", "icon": "car"}


def test_back_to_letters_on_a_following_repo_stays_letters(riv):
    riv["projects"] = [{"id": "p1", "repositories": ["acme/a"], "client": client("c", color="#336699")}]
    riv["local"] = {"/a": {"acme/a"}}
    projectmarks.import_all()
    assert project_config.mark("/a")["source"] == "rivendell"
    assert projectmarks.set_mark("/a", None) == {"kind": "letters"}      # BACK TO LETTERS
    projectmarks.refresh()
    assert project_config.mark("/a") == {"kind": "letters"}
    assert projectmarks.set_mark("/fresh", None) is None                 # nothing to go back from: no mark


def test_undo_never_takes_back_a_mark_you_set_after_the_import(riv):
    riv["projects"] = [{"id": "p1", "repositories": ["acme/a", "acme/b"], "client": client("c", color="#336699")}]
    riv["local"] = {"/a": {"acme/a"}, "/b": {"acme/b"}}
    projectmarks.import_all()
    mine = projectmarks.set_mark("/b", {"kind": "icon", "icon": "rocket"})
    assert projectmarks.undo() == {"undone": 1}
    assert project_config.mark("/a") is None and project_config.mark("/b") == mine


def test_refresh_stops_if_following_is_switched_off_while_it_downloads(riv, monkeypatch):
    riv["projects"] = [{"id": "p1", "repositories": ["acme/a"], "client": client("c", logo="https://s3/c.png")}]
    riv["local"] = {"/a": {"acme/a"}}
    riv["logos"] = {"https://s3/c.png": PNG}
    projectmarks.set_sync(True)
    projectmarks.undo()                       # nothing imported yet: just make sure /a is plain
    projectmarks.set_mark("/a", None)
    real = projectmarks._fetch_logos

    def slow(matches, known):
        projectmarks.set_sync(False)          # the switch goes off mid-download
        return real(matches, known)
    with projectmarks._lock:
        d = projectmarks._load()
        d.setdefault("rivendell", {})["sync"] = True
        projectmarks._save(d)
    monkeypatch.setattr(projectmarks, "_fetch_logos", slow)
    assert projectmarks.refresh() == {"following": 0, "skipped": "off"}
    assert project_config.mark("/a") is None


# --- LINK: a repo no Rivendell project names ----------------------------------

def test_link_is_offered_for_a_repo_no_project_names_with_the_projects_that_lend_a_mark(riv):
    riv["projects"] = [
        {"id": "p-elvou", "instance_id": "prod", "name": "Elvou", "repositories": ["Elvou/elvou"],
         "client": client("elvou", logo="https://s3/elvou.png")},
        {"id": "p-rv", "instance_id": "prod", "name": "Rivendell", "repositories": ["ainurhq/rivendell"],
         "client": None},                                                   # internal: named, but lends nothing
        {"id": "p-plain", "instance_id": "prod", "name": "Plain", "repositories": [], "client": client("plain")},
    ]
    riv["local"] = {"/elvou": {"ainurdev/elvou"}, "/rivendell": {"ainurhq/rivendell"}, "/up": {"elvou/elvou"}}
    s = projectmarks.state(force=True)
    assert s["unlinked"] == ["/elvou"]
    assert s["projects"] == [{"instance": "prod", "id": "p-elvou", "name": "Elvou", "client": "ELVOU",
                              "logo": True, "color": None}]


def test_link_saves_the_link_in_rivendell_then_follows_its_client(riv, monkeypatch):
    elvou = {"id": "p-elvou", "instance_id": "prod", "name": "Elvou", "repositories": ["Elvou/elvou"],
             "client": client("elvou", logo="https://s3/elvou.png", color="#133c2c")}
    riv["projects"] = [elvou]
    riv["local"] = {"/elvou": {"ainurdev/elvou"}}
    riv["logos"] = {"https://s3/elvou.png": PNG}
    calls = []

    def link_repo(instance, project_id, slugs):
        calls.append((instance, project_id, slugs))
        elvou["repositories"].append("ainurdev/elvou")      # what /plugin/projects lists from then on
        return "ainurdev/elvou"
    monkeypatch.setattr(rivendell, "link_repo", link_repo)
    projectmarks.set_mark("/elvou", {"kind": "icon", "icon": "leaf"})   # LINK is asking for the client's mark
    assert projectmarks.state(force=True)["unlinked"] == ["/elvou"]

    out = projectmarks.link("/elvou", "prod", "p-elvou")

    assert calls == [("prod", "p-elvou", {"ainurdev/elvou"})]
    assert out["linked"] == "ainurdev/elvou" and out["following"] == 1
    m = project_config.mark("/elvou")
    assert m["kind"] == "logo" and m["source"] == "rivendell" and m["color"] == "#133c2c"
    assert projectmarks.state()["unlinked"] == []


def test_link_takes_only_a_project_rivendell_listed_and_a_repo_with_a_remote(riv, monkeypatch):
    riv["projects"] = [{"id": "p1", "instance_id": "prod", "name": "P", "repositories": [],
                        "client": client("c", color="#123456")}]
    riv["local"] = {"/r": {"acme/r"}}
    monkeypatch.setattr(rivendell, "link_repo", lambda *a: pytest.fail("reached Rivendell"))
    for args in (("/r", "prod", "../../source-control/sync"), ("/r", "other", "p1"), ("/none", "prod", "p1")):
        with pytest.raises(ValueError):
            projectmarks.link(*args)


# --- a project's own logo (Rivendell's /plugin/projects logoId/logoUrl) --------

def test_a_projects_own_logo_beats_its_clients(riv):
    riv["projects"] = [{"id": "p1", "instance_id": "prod", "name": "NR exam automation", "repositories": ["acme/a"],
                        "logoId": "u1", "logoUrl": "https://s3/own.png",
                        "client": client("nr", logo="https://s3/nr.png", color="#ea5b13")}]
    riv["local"] = {"/a": {"acme/a"}}
    riv["logos"] = {"https://s3/own.png": PNG2, "https://s3/nr.png": PNG}

    projectmarks.import_all()

    m = project_config.mark("/a")
    assert projectmarks.logo(m["logo"])[0] == PNG2 and m["color"] == "#ea5b13"
    assert m["rv"] == {"instance": "prod", "client": "nr", "name": "NR exam automation", "logo_id": "u1", "own": True}
    assert riv["downloads"] == ["https://s3/own.png"]         # the client's isn't fetched once the project's is kept


def test_an_internal_project_with_its_own_logo_matches(riv):
    riv["projects"] = [{"id": "p-rv", "instance_id": "prod", "name": "Rivendell", "internal": True,
                        "repositories": ["ainurhq/rivendell"], "logoId": "u2", "logoUrl": "https://s3/rv.png",
                        "client": None}]
    riv["local"] = {"/rivendell": {"ainurhq/rivendell"}}
    riv["logos"] = {"https://s3/rv.png": PNG}

    s = projectmarks.state(force=True)
    assert s["matches"]["/rivendell"] == {"client": "Rivendell", "logo": True, "color": None, "own": True}
    assert s["projects"] == [{"instance": "prod", "id": "p-rv", "name": "Rivendell", "client": None,
                              "logo": True, "color": None}]                        # LINK can offer it
    projectmarks.import_all()
    m = project_config.mark("/rivendell")
    assert m["kind"] == "logo" and "color" not in m and m["rv"]["own"] is True and m["rv"]["name"] == "Rivendell"


def test_a_project_logo_that_cant_be_kept_falls_back_to_the_clients(riv):
    riv["projects"] = [{"id": "p1", "instance_id": "prod", "name": "P", "repositories": ["acme/a"],
                        "logoId": "u1", "logoUrl": "https://s3/too-big.png",
                        "client": client("c", logo="https://s3/c.png", color="#123456")}]
    riv["local"] = {"/a": {"acme/a"}}
    riv["logos"] = {"https://s3/c.png": PNG}                   # the project's own never downloads

    projectmarks.import_all()

    m = project_config.mark("/a")
    assert m["kind"] == "logo" and projectmarks.logo(m["logo"])[0] == PNG
    assert m["rv"]["logo_id"] == "doc-c" and "own" not in m["rv"] and m["rv"]["name"] == "C"
    assert riv["downloads"] == ["https://s3/too-big.png", "https://s3/c.png"]   # its own was tried first


# --- a background (plate) behind a logo ----------------------------------------

def test_a_plate_rides_only_on_a_logo():
    m = projectmarks.set_mark("/r", {"kind": "logo", "plate": "light"}, logo_data=base64.b64encode(PNG).decode())
    assert m["plate"] == "light"
    for bad in ({"kind": "logo", "logo": m["logo"], "plate": "pink"}, {"kind": "icon", "icon": "rocket", "plate": "dark"}):
        with pytest.raises(ValueError):
            projectmarks.set_mark("/r", bad)
    assert project_config.mark("/r") == m                          # a refused edit changes nothing


def _ib(riv, logo="https://s3/ib.svg", logo_id=None):
    riv["projects"] = [{"id": "p1", "instance_id": "prod", "repositories": ["acme/a"],
                        "client": client("ib", logo=logo, color="#000000", logo_id=logo_id)}]
    riv["local"] = {"/a": {"acme/a"}}


def test_a_plate_alone_keeps_a_mark_following(riv):
    _ib(riv)
    riv["logos"] = {"https://s3/ib.svg": SVG}
    projectmarks.import_all()
    followed = project_config.mark("/a")
    shown = {k: v for k, v in followed.items() if k not in ("source", "rv")}   # what the editor sends back

    m = projectmarks.set_mark("/a", {**shown, "plate": "dark"})
    assert m["source"] == "rivendell" and m["rv"] == followed["rv"] and m["plate"] == "dark"
    assert project_config.mark("/a") == m
    m = projectmarks.set_mark("/a", shown)                        # back to NONE, still following
    assert m == followed
    m = projectmarks.set_mark("/a", {**shown, "plate": "light", "color": "#ffffff"})
    assert "source" not in m and m["plate"] == "light"             # anything more makes it yours


def test_refresh_keeps_the_plate(riv):
    _ib(riv)
    riv["logos"] = {"https://s3/ib.svg": SVG, "https://s3/ib-white.png": PNG}
    projectmarks.import_all()
    shown = {k: v for k, v in project_config.mark("/a").items() if k not in ("source", "rv")}
    projectmarks.set_mark("/a", {**shown, "plate": "light"})
    _ib(riv, logo="https://s3/ib-white.png", logo_id="doc-ib-2")   # the client's logo changes in Rivendell

    projectmarks.refresh()

    m = project_config.mark("/a")
    assert m["plate"] == "light" and m["source"] == "rivendell" and projectmarks.logo(m["logo"])[0] == PNG


# --- From Rivendell (the gallery) -----------------------------------------------

def test_the_gallery_lists_the_images_of_the_client_whose_project_names_the_repo(riv, monkeypatch):
    riv["projects"] = [{"id": "p1", "instance_id": "prod", "name": "P", "repositories": ["acme/a"],
                        "client": {"id": "c-plain", "name": "Plain", "logoUrl": None, "brandColor": None}}]  # lends nothing
    riv["local"] = {"/a": {"acme/a"}, "/b": {"acme/b"}}
    asked = []
    monkeypatch.setattr(rivendell, "client_images",
                        lambda inst, cid: asked.append((inst, cid)) or [{"id": "d1", "name": "x.png", "url": "https://s/1"}])
    assert projectmarks.gallery("/a") == {"client": "Plain", "images": [{"id": "d1", "name": "x.png", "url": "https://s/1"}]}
    assert asked == [("prod", "c-plain")]
    assert projectmarks.gallery("/b") == {"client": None, "images": []}           # no project names it


def test_the_gallery_is_empty_without_a_rivendell_a_client_or_an_answer(riv, monkeypatch):
    riv["local"] = {"/a": {"acme/a"}}
    assert projectmarks.gallery("/a") == {"client": None, "images": []}           # no Rivendell at all

    def down(inst, cid):
        raise rivendell.TasksError("unreachable", "unreachable: timed out")
    riv["projects"] = [{"id": "p1", "instance_id": "prod", "name": "P", "repositories": ["acme/a"],
                        "client": client("c", logo="https://s3/c.png")}]
    monkeypatch.setattr(rivendell, "client_images", down)
    projectmarks._seen["at"] = 0.0
    assert projectmarks.gallery("/a") == {"client": None, "images": []}

    riv["projects"] = [{"id": "p2", "instance_id": "prod", "name": "Ours", "internal": True,
                        "repositories": ["acme/a"], "client": None}]
    projectmarks._seen["at"] = 0.0
    assert projectmarks.gallery("/a") == {"client": None, "images": []}           # internal: no client documents


def test_a_gallery_image_must_be_one_the_strip_lists(riv, monkeypatch):
    riv["projects"] = [{"id": "p1", "instance_id": "prod", "name": "P", "repositories": ["acme/a"],
                        "client": client("c", logo="https://s3/c.png")}]
    riv["local"] = {"/a": {"acme/a"}}
    riv["logos"] = {"https://s/dl1": SVG}
    monkeypatch.setattr(rivendell, "client_images", lambda inst, cid: [{"id": "d1", "name": "x.svg", "url": "https://s/1"}])
    monkeypatch.setattr(rivendell, "client_image_url", lambda inst, cid, doc: f"https://s/dl{doc[1:]}")
    assert projectmarks.gallery_image("/a", "d1") == (SVG, "image/svg+xml")
    assert projectmarks.gallery_image("/a", "d9") is None                         # not in the strip
    assert riv["downloads"] == ["https://s/dl1"]                                    # d9 was never fetched


def test_a_new_logo_that_fails_to_fetch_keeps_the_last_one_and_its_plate(riv):
    _ib(riv)
    riv["logos"] = {"https://s3/ib.svg": SVG}
    projectmarks.import_all()
    shown = {k: v for k, v in project_config.mark("/a").items() if k not in ("source", "rv")}
    projectmarks.set_mark("/a", {**shown, "plate": "light"})
    old = project_config.mark("/a")
    _ib(riv, logo="https://s3/ib-new.png", logo_id="doc-ib-2")     # changed in Rivendell, and its download fails

    projectmarks.refresh()
    m = project_config.mark("/a")
    assert m["kind"] == "logo" and m["logo"] == old["logo"] and m["plate"] == "light"   # no flash to letters

    riv["logos"]["https://s3/ib-new.png"] = PNG                      # it comes through on the next pass
    projectmarks.refresh()
    m = project_config.mark("/a")
    assert projectmarks.logo(m["logo"])[0] == PNG and m["plate"] == "light" and m["rv"]["logo_id"] == "doc-ib-2"


def test_a_logo_that_cant_be_had_is_tried_once_per_pass_not_once_per_repo(riv):
    riv["projects"] = [{"id": "p1", "instance_id": "prod", "name": "P", "repositories": ["acme/a", "acme/b", "acme/c"],
                        "logoId": "u1", "logoUrl": "https://s3/too-big.png",
                        "client": client("c", logo="https://s3/c.png")}]
    riv["local"] = {"/a": {"acme/a"}, "/b": {"acme/b"}, "/c": {"acme/c"}}
    riv["logos"] = {"https://s3/c.png": PNG}
    projectmarks.import_all()
    assert riv["downloads"] == ["https://s3/too-big.png", "https://s3/c.png"]
