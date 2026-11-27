"""bin/suite-slot: one full test suite at a time on this machine. Ticket sessions put it in front of
their full suite, because suites that overlapped ran 2-2.5x slower and failed twice as often
(the ticket study of 2026-11-27). Each test gets a slot of its own: the lock sits beside BRIDGE_DB."""

import os
import subprocess
import sys
import time

TOOL = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin", "suite-slot")


def _env(tmp_path):
    return {**os.environ, "BRIDGE_DB": str(tmp_path / "bridge.db")}


def test_a_second_suite_waits_for_the_first_and_says_what_it_waits_for(tmp_path):
    began, ended = tmp_path / "began", tmp_path / "ended"
    first = subprocess.Popen(
        [TOOL, sys.executable, "-c", f"import pathlib, time; pathlib.Path({str(began)!r}).touch(); time.sleep(1); "
                                     f"pathlib.Path({str(ended)!r}).write_text(repr(time.time()))"],
        env=_env(tmp_path), cwd=tmp_path)
    deadline = time.time() + 10
    while not began.exists():
        assert time.time() < deadline, "the first suite never started"
        time.sleep(0.02)
    second = subprocess.run([TOOL, sys.executable, "-c", "import time; print(repr(time.time()))"],
                            env=_env(tmp_path), capture_output=True, text=True, timeout=30)
    assert first.wait(timeout=30) == 0 and second.returncode == 0
    assert float(second.stdout) >= float(ended.read_text())
    assert second.stderr.startswith("suite-slot: waiting for ") and str(tmp_path) in second.stderr


def test_a_free_slot_runs_the_command_silently_and_keeps_its_exit_code(tmp_path):
    p = subprocess.run([TOOL, "sh", "-c", "echo ran; exit 3"], env=_env(tmp_path), capture_output=True, text=True,
                       timeout=30)
    assert (p.returncode, p.stdout, p.stderr) == (3, "ran\n", "")


def test_a_suite_killed_mid_run_frees_the_slot(tmp_path):
    first = subprocess.Popen([TOOL, "sleep", "30"], env=_env(tmp_path))
    time.sleep(0.3)
    first.kill()
    first.wait(timeout=10)
    p = subprocess.run([TOOL, "true"], env=_env(tmp_path), capture_output=True, text=True, timeout=10)
    assert (p.returncode, p.stderr) == (0, "")
