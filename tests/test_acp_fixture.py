"""Drift guard: a real opencode probe (tests/fixtures/acp/opencode-probe.json,
recorded from opencode 1.18.10) must still shape into model and mode pickers.
Re-record after an opencode upgrade; if this fails, _shape() no longer reads
what opencode advertises. opencode sends its modes as a `mode` config option
(`modes` is null), and no thought-level option."""
import json
import os

from bridge import acp_agents

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "acp", "opencode-probe.json")


def test_recorded_opencode_probe_shapes_into_pickers():
    rec = json.load(open(FIXTURE, encoding="utf-8"))
    got = acp_agents._shape(rec["options"], rec["modes"])
    assert got["model"] and all(m["value"] for m in got["model"])
    assert {m["value"] for m in got["mode"]} >= {"build", "plan"}
    assert got["effort"] == []
