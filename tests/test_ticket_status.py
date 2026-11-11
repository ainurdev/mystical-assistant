"""bin/ticket-status: one read-only call that says what every ticket set is doing. The sessions
are made through the real store, so a renamed column fails here."""

import json
import os
import subprocess
import sys
import uuid

from bridge import config, store

TOOL = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin", "ticket-status")


def _turn(tmp_path, status, *events):
    store.init()
    sid = store.create_session(1, "proj", cwd=str(tmp_path))["id"]
    turn = uuid.uuid4().hex
    store.start_turn(sid, turn, "build it", [])
    for ev in events:
        store.append_event(sid, turn, ev)
    store.finish_turn(turn, status, 0, 44)
    return sid


def test_it_says_each_tickets_state_and_how_its_last_turn_ended(tmp_path):
    done = _turn(tmp_path, "done", {"type": "tool", "name": "Bash"}, {"type": "tool", "name": "mcp__goals__StepDone"},
                 {"type": "text", "text": "All done,\n  committed."})
    stuck = _turn(tmp_path, "done", {"type": "tool", "name": "ToolSearch", "summary": "select:mcp__goals__StepDone"},
                  {"type": "text", "text": "I'll report once the suite finishes."}, {"type": "tool", "name": "Bash"})
    folder = tmp_path / "demo"
    folder.mkdir()
    (folder / "set.json").write_text(json.dumps({"status": "building", "feature_branch": "feat/demo", "tickets": {
        "01": {"status": "done", "blocked_by": [], "session_id": done},
        "02": {"status": "fix", "why": "StepDone, but no commit", "blocked_by": [], "session_id": stuck},
        "03": {"status": "queued", "blocked_by": ["02"], "session_id": ""}}}))
    reg = os.path.join(os.path.dirname(config.BRIDGE_DB), "ticketsets.json")
    before = open(reg, encoding="utf-8").read() if os.path.exists(reg) else None
    try:       # the registry is shared with the other tests of this process: put it back
        with open(reg, "w", encoding="utf-8") as f:
            json.dump([{"folder": str(folder), "project": "proj", "slug": "demo"}, {"folder": str(tmp_path / "gone"), "slug": "gone"}], f)
        out = subprocess.run([sys.executable, TOOL], env={**os.environ, "BRIDGE_DB": config.BRIDGE_DB},
                             capture_output=True, text=True)
    finally:
        if before is None:
            os.remove(reg)
        else:
            with open(reg, "w", encoding="utf-8") as f:
                f.write(before)
    assert out.returncode == 0, out.stderr
    head, one, two, three, gone = out.stdout.splitlines()
    assert head == "demo: building (1 done, 1 fix, 1 queued) -> feat/demo"
    assert one.startswith(f"  #01 done: {done[:8]} turn done ") and one.endswith("+44s, StepDone, last tool mcp__goals__StepDone | All done, committed.")
    assert two.startswith(f"  #02 fix (StepDone, but no commit): {stuck[:8]} turn done ")
    assert two.endswith("no StepDone, last tool Bash | I'll report once the suite finishes.")   # looking StepDone up is not calling it
    assert three == "  #03 queued waits for #02: no session yet"
    assert gone.startswith("gone: no set.json in ")
