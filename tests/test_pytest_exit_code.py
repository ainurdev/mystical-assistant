"""An empty -k selection must not look like a failure.

Guards the exit-code hooks in conftest.py. pytest exits 5 whether a filter
matched nothing or nothing was collectable at all, and only the second is a real
problem. Both cases run in a subprocess, because the thing under test IS the
exit code of a pytest process.

Run: python -m pytest tests/test_pytest_exit_code.py -v"""

import os
import subprocess
import sys

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(TESTS_DIR)


def _exit_code(*args):
    return subprocess.run(
        [sys.executable, "-m", "pytest", "-q", *args],
        cwd=REPO_ROOT, capture_output=True,
    ).returncode


def test_filter_matching_nothing_exits_zero():
    assert _exit_code(TESTS_DIR, "-k", "nothing_matches_this") == 0


def test_nothing_collectable_still_exits_five():
    # conftest.py lives in tests/ (so the hooks load) and holds no tests: nothing
    # collected, nothing deselected — the case exit 5 exists for.
    assert _exit_code(os.path.join(TESTS_DIR, "conftest.py")) == 5


if __name__ == "__main__":
    raise SystemExit(subprocess.call(["pytest", "-q", os.path.abspath(__file__)]))
