from bridge import rivendell


def _answer(projects, tasks=()):
    return {"instances": 1, "links": [], "projects": list(projects), "tasks": list(tasks), "errors": []}


def test_slug_answer_merges_every_remote_that_names_a_project(monkeypatch):
    # An NR apex checkout: origin is on NR exam automation, the ainur remote on Apex.
    answers = {
        "nationalerijschool/apex": _answer([{"id": "nr", "instance_id": "w"}],
                                           [{"id": "t1", "instance_id": "w", "key": "NRA-1"}]),
        "ainurdev/apex": _answer([{"id": "apex", "instance_id": "w"}],
                                 [{"id": "t2", "instance_id": "w", "key": "NRF-1"}]),
        "zed/apex": _answer([]),
    }
    monkeypatch.setattr(rivendell, "_repo_slugs", lambda path: list(answers))
    monkeypatch.setattr(rivendell, "tasks", lambda slug: answers[slug])

    slug, d = rivendell._slug_answer("/x")

    assert slug == "nationalerijschool/apex, ainurdev/apex"
    assert [p["id"] for p in d["projects"]] == ["nr", "apex"]
    assert [t["key"] for t in d["tasks"]] == ["NRA-1", "NRF-1"]


def test_slug_answer_keeps_one_project_once_when_two_remotes_find_it(monkeypatch):
    both = _answer([{"id": "p", "instance_id": "w"}], [{"id": "t", "instance_id": "w"}])
    monkeypatch.setattr(rivendell, "_repo_slugs", lambda path: ["acme/app", "upstream/app"])
    monkeypatch.setattr(rivendell, "tasks", lambda slug: both)

    _, d = rivendell._slug_answer("/x")

    assert len(d["projects"]) == 1 and len(d["tasks"]) == 1


def test_slug_answer_with_one_hit_or_none_is_as_before(monkeypatch):
    answers = {"acme/app": _answer([]), "upstream/app": _answer([{"id": "p", "instance_id": "w"}])}
    monkeypatch.setattr(rivendell, "_repo_slugs", lambda path: list(answers))
    monkeypatch.setattr(rivendell, "tasks", lambda slug: answers[slug])
    assert rivendell._slug_answer("/x") == ("upstream/app", answers["upstream/app"])

    monkeypatch.setattr(rivendell, "_repo_slugs", lambda path: ["acme/app"])
    assert rivendell._slug_answer("/x") == ("acme/app", answers["acme/app"])
