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
