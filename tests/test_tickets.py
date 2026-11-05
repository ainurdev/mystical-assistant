import json
import os

import pytest

from bridge import tickets


def _write(folder, n, title, blocked="None (can start immediately)"):
    with open(os.path.join(folder, f"{n}-x.md"), "w") as f:
        f.write(f"# {n}: {title}\n\n**What to build:** x\n\n**Blocked by:** {blocked}\n\n"
                "**Status:** ready-for-agent\n\n- [ ] ok\n")


def test_parse_numbers_titles_and_none(tmp_path):
    d = str(tmp_path)
    _write(d, "01", "Base")
    _write(d, "02", "Api", "#1")
    _write(d, "03", "Ui", "02 and base")
    _write(d, "04", "Docs", "#02, 3")
    _write(d, "05", "Poly", "None")
    ts = {t.n: t for t in tickets.parse_dir(d)}
    assert ts["01"].title == "Base" and ts["01"].blocked_by == ()
    assert ts["02"].blocked_by == ("01",)
    assert ts["03"].blocked_by == ("02", "01")
    assert ts["04"].blocked_by == ("02", "03")
    assert ts["05"].blocked_by == ()


def test_order_lowest_first(tmp_path):
    d = str(tmp_path)
    _write(d, "01", "A")
    _write(d, "02", "B", "05")
    _write(d, "03", "C")
    _write(d, "05", "E", "01")
    assert tickets.order(tickets.parse_dir(d)) == ["01", "03", "05", "02"]


def test_cycle_names_the_loop(tmp_path):
    d = str(tmp_path)
    _write(d, "01", "A")
    _write(d, "02", "B", "05")
    _write(d, "05", "E", "02")
    with pytest.raises(tickets.TicketError) as e:
        tickets.order(tickets.parse_dir(d))
    assert str(e.value) == "cycle: #02 → #05 → #02"


def test_missing_blocker_named(tmp_path):
    d = str(tmp_path)
    _write(d, "06", "F", "#9")
    with pytest.raises(tickets.TicketError) as e:
        tickets.parse_dir(d)
    assert str(e.value) == "#06 is blocked by #09, which doesn't exist"


def test_set_json_round_trip(tmp_path):
    d = str(tmp_path / "set")
    os.makedirs(d)
    assert tickets.load(d) == {}
    st = {"slug": "f", "parent_session": "s1", "status": "building", "tickets": {}}
    tickets.save(d, st)
    assert tickets.load(d) == st
    assert not os.path.exists(os.path.join(d, "set.json.tmp"))
    tickets.register(d, "proj", "f")
    assert tickets.sets()[0]["folder"] == d
    assert tickets.summary_for("s1")["slug"] == "f"
    assert tickets.summary_for("nope") is None


@pytest.mark.parametrize("line", ["Blocked by: #1, #3", "**Blocked by**: 01 and 3", "- **Blocked by:** 01, 03",
                                  "* blocked by: #1, 03.", "**Blocked by:** #01 (Base), #3 (Ui)."])
def test_blocked_by_variants(tmp_path, line):
    d = str(tmp_path)
    _write(d, "01", "A")
    _write(d, "03", "C")
    with open(os.path.join(d, "04-x.md"), "w") as f:
        f.write(f"# 04: D\n\n{line}\n\n**Status:** ready-for-agent\n")
    t = {t.n: t for t in tickets.parse_dir(d)}["04"]
    assert set(t.blocked_by) == {"01", "03"}


def test_unreadable_blocked_by_raises(tmp_path):
    d = str(tmp_path)
    with open(os.path.join(d, "01-x.md"), "w") as f:
        f.write("# 01: A\n\n**Blocked by:** (see above)\n")
    with pytest.raises(tickets.TicketError, match=r"#01.*see above"):
        tickets.parse_dir(d)


def test_duplicate_number_raises(tmp_path):
    d = str(tmp_path)
    _write(d, "01", "A")
    with open(os.path.join(d, "01-y.md"), "w") as f:
        f.write("# 1: B\n")
    with pytest.raises(tickets.TicketError, match="two tickets are numbered #01"):
        tickets.parse_dir(d)


@pytest.mark.parametrize("body", ["[1]", "not json", '"x"'])
def test_wrong_shape_files_give_none(tmp_path, body):
    d = str(tmp_path)
    with open(os.path.join(d, "set.json"), "w") as f:
        f.write(body)
    assert tickets.load(d) == {}
    tickets.register(d, "p", "s")
    assert tickets.summary_for("zz") is None
    with open(tickets._path(), "w") as f:
        f.write(body)
    assert tickets.summary_for("zz") is None
    with open(tickets._path(), "w") as f:
        json.dump([{"slug": "x"}, 5, {"folder": 3}], f)
    assert tickets.summary_for("zz") is None


def _t4(tmp_path, body):
    d = str(tmp_path)
    _write(d, "01", "A")
    _write(d, "03", "C")
    with open(os.path.join(d, "04-x.md"), "w") as f:
        f.write(body)
    return {t.n: t for t in tickets.parse_dir(d)}["04"]


def test_list_under_empty_label(tmp_path):
    t = _t4(tmp_path, "# 04: D\n\n**Blocked by:**\n- #1\n* 3\n\n- #9\n**Status:** x\n")
    assert set(t.blocked_by) == {"01", "03"}
    t = _t4(tmp_path / "n", "# 04: D\n\n**Blocked by:**\n1. #1\n2. #3\n") if os.makedirs(tmp_path / "n") is None else None
    assert set(t.blocked_by) == {"01", "03"}


def test_comma_in_parenthetical(tmp_path):
    assert _t4(tmp_path, "# 04: D\n\n**Blocked by:** #1 (Base, shared)\n").blocked_by == ("01",)


def test_no_line_and_empty_label_mean_no_blockers(tmp_path):
    assert _t4(tmp_path, "# 04: D\n\nstuff\n").blocked_by == ()
    assert _t4(tmp_path / "e", "# 04: D\n\n**Blocked by:**\n\n**Status:** x\n").blocked_by == () \
        if os.makedirs(tmp_path / "e") is None else None


def test_bad_created_does_not_break_summary(tmp_path):
    d = str(tmp_path)
    tickets.save(d, {"parent_session": "cr", "slug": "good"})
    with open(tickets._path(), "w") as f:
        json.dump([{"folder": "/nope", "created": "x"}, {"folder": d, "created": None},
                   {"folder": d, "created": 5}], f)
    assert tickets.summary_for("cr")["slug"] == "good"
