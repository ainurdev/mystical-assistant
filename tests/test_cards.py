"""Derived canvas cards: watermark caching, model-call guards, registry shape."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import cards  # noqa: E402


def _reg(monkeypatch, **over):
    """A one-card registry, so a test never depends on a real card's facts."""
    spec = {"key": "t", "title": "T", "scope": "session", "shape": "lines",
            "feature": None, "watermark": lambda ctx: "w1",
            "facts": lambda ctx: {"n": 1}, "prompt": None}
    spec.update(over)
    monkeypatch.setattr(cards, "CARDS", (spec,))
    return spec


def test_facts_are_the_body_when_there_is_no_prompt(tmp_path, monkeypatch):
    monkeypatch.setattr(cards, "_cache_path", lambda: str(tmp_path / "cards.json"))
    _reg(monkeypatch)
    out = cards.render("t", {"id": "s1"})
    assert out["body"] == {"n": 1} and out["stale"] is False


def test_same_watermark_is_served_from_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(cards, "_cache_path", lambda: str(tmp_path / "cards.json"))
    calls = []
    _reg(monkeypatch, prompt="say {facts}")
    monkeypatch.setattr(cards, "_one_shot", lambda *a, **k: calls.append(1) or "first")
    a = cards.render("t", {"id": "s1"})
    b = cards.render("t", {"id": "s1"})
    assert a["body"] == b["body"] == "first"
    assert len(calls) == 1, "a second render at the same watermark must not spend"


def test_moved_watermark_recomputes(tmp_path, monkeypatch):
    monkeypatch.setattr(cards, "_cache_path", lambda: str(tmp_path / "cards.json"))
    marks = iter(["w1", "w2"])
    _reg(monkeypatch, prompt="p", watermark=lambda ctx: next(marks))
    answers = iter(["one", "two"])
    monkeypatch.setattr(cards, "_one_shot", lambda *a, **k: next(answers))
    assert cards.render("t", {"id": "s1"})["body"] == "one"
    assert cards.render("t", {"id": "s1"})["body"] == "two"


def test_force_ignores_the_watermark(tmp_path, monkeypatch):
    monkeypatch.setattr(cards, "_cache_path", lambda: str(tmp_path / "cards.json"))
    _reg(monkeypatch, prompt="p")
    answers = iter(["one", "two"])
    monkeypatch.setattr(cards, "_one_shot", lambda *a, **k: next(answers))
    cards.render("t", {"id": "s1"})
    assert cards.render("t", {"id": "s1"}, force=True)["body"] == "two"


def test_a_failed_call_leaves_the_last_answer_standing(tmp_path, monkeypatch):
    monkeypatch.setattr(cards, "_cache_path", lambda: str(tmp_path / "cards.json"))
    marks = iter(["w1", "w2"])
    _reg(monkeypatch, prompt="p", watermark=lambda ctx: next(marks))

    def boom(*a, **k):
        raise RuntimeError("model down")

    monkeypatch.setattr(cards, "_one_shot", lambda *a, **k: "good")
    cards.render("t", {"id": "s1"})
    monkeypatch.setattr(cards, "_one_shot", boom)
    out = cards.render("t", {"id": "s1"})
    assert out["body"] == "good" and out["stale"] is True


def test_facts_raising_yields_an_error_body_not_an_exception(tmp_path, monkeypatch):
    monkeypatch.setattr(cards, "_cache_path", lambda: str(tmp_path / "cards.json"))

    def boom(ctx):
        raise OSError("no repo")

    _reg(monkeypatch, facts=boom)
    out = cards.render("t", {"id": "s1"})
    assert out["body"] is None and out["stale"] is True


def test_a_corrupt_cache_file_does_not_take_the_card_down(tmp_path, monkeypatch):
    p = tmp_path / "cards.json"
    p.write_text("{not json")
    monkeypatch.setattr(cards, "_cache_path", lambda: str(p))
    _reg(monkeypatch)
    assert cards.render("t", {"id": "s1"})["body"] == {"n": 1}


def test_unknown_key_returns_none():
    assert cards.card("nope") is None
