"""Regression tests for the review-batch pipeline fixes:
- _register never evicts a running job (evicted awaiting jobs were immortal:
  respond/interrupt 404'd and the pending card could never be answered).
- models.get_models never blocks the caller on the network (it sits on the
  /state poll and the run-submit path).

Run: python3 -m pytest tests/test_job_registry.py -q
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "t")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")

from bridge import models, runner  # noqa: E402


def test_register_never_evicts_running_jobs():
    saved = dict(runner._jobs)
    runner._jobs.clear()
    try:
        jobs = []
        for i in range(runner._JOBS_MAX + 5):
            j = runner.Job(f"job{i}", chat_id=555)
            j.started = float(i)
            # Oldest five are still running; the rest finished.
            j.status = "running" if i < 5 else "done"
            jobs.append(j)
            runner._register(j)
        assert len(runner._jobs) <= runner._JOBS_MAX
        for i in range(5):
            assert runner.get_job(f"job{i}") is not None, "running job was evicted"
    finally:
        runner._jobs.clear()
        runner._jobs.update(saved)


def test_get_models_serves_fallback_without_blocking(monkeypatch):
    monkeypatch.setattr(models, "_cache", None)
    monkeypatch.setattr(models, "_refreshing", False)

    def slow_fetch():
        time.sleep(5)
        return [{"id": "claude-x", "label": "X"}]

    monkeypatch.setattr(models, "_fetch", slow_fetch)
    t0 = time.monotonic()
    out = models.get_models()
    assert time.monotonic() - t0 < 1.0, "get_models blocked on the fetch"
    assert out, "expected the fallback list immediately"
