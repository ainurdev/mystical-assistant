"""The free tier of bridge/tailstate.py: does an ending need the user or not?

Cases are Anthropic's own, from the background-agent state classifier the module
is ported from — including the contrastive pairs, where the same surface shape
decides differently. The expensive tier isn't exercised here: it needs a model.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge.tailstate import _marker  # noqa: E402


class TestBlockedMarkers(unittest.TestCase):
    def test_auth_and_limit_failures_are_blocked(self):
        for tail, want in (
            ("API Error: 401 Invalid API key · Please run /login", "run /login"),
            ("The turn stopped: usage limit reached.", "usage limit reached"),
            ("Push failed — run `gh auth login` first.", "re-run the CLI login"),
            ("MCP server rejected us: the oauth token expired.", "refresh the token"),
        ):
            self.assertEqual(_marker(tail), want, tail)

    def test_user_gate_is_blocked(self):
        # Copied verbatim from the tail, casing included — the user acts on this
        # text without opening the transcript.
        self.assertEqual(_marker("CI green on PR #31030. Reply `go` to merge."),
                         "Reply `go` to merge")
        self.assertTrue(_marker("Rebased and pushed. Awaiting your approval."))
        self.assertEqual(_marker("blocked: missing config/openapi.yaml"),
                         "missing config/openapi.yaml")

    def test_agent_repoll_outranks_a_user_gate(self):
        # "Awaiting your `go`. Next check in 20m" is working, not blocked: the
        # agent owns the next step, so `go` only speeds it up.
        self.assertIsNone(_marker("Awaiting your `go`. Next check in 20m."))
        self.assertIsNone(_marker(
            "PR #40689 green, threads resolved. Awaiting human approval. "
            "Next check via cron in ~5 min."))

    def test_declarative_endings_are_not_blocked(self):
        for tail in (
            "Fixed the regex; tests pass.",
            "Wrote the chart to plots/venn.png; script is at scripts/venn.R.",
            "No response requested.",
            "B is the right call — it avoids the migration.",
            "Both subagents are still running — I'll report PR URLs when each completes.",
        ):
            self.assertIsNone(_marker(tail), tail)

    def test_trailing_offers_are_not_blocked_for_free(self):
        # The free tier can't tell a passing offer from a real gate, and a false
        # alarm is the expensive mistake — so both fall through to None, which is
        # exactly today's behaviour. The model tier is what separates them.
        for tail in (
            "Fixed the regex; tests pass. If you want, I can also open a follow-up PR.",
            "Found the fix. Want me to add it to this PR or open a new one?",
        ):
            self.assertIsNone(_marker(tail), tail)

    def test_empty_tail_is_never_blocked(self):
        self.assertIsNone(_marker(""))


class TestWiring(unittest.TestCase):
    """A blocked closing must reach both surfaces: the ping and the session row."""

    def _job(self, result):
        from bridge import runner
        j = runner.Job("job-tail", 7, store_session_id="sess-tail")
        j.status, j.result = "done", result
        return j

    def _run(self, job):
        """tailstate._run inline (no thread), with the pings captured."""
        from bridge import runner, tailstate
        sent = []
        orig = runner.notify_needs_you, runner.notify_turn_done
        runner.notify_needs_you = lambda c, s, n: sent.append(("needs", n))
        runner.notify_turn_done = lambda c, s, e: sent.append(("done", None))
        try:
            tailstate._run(job, None)
        finally:
            runner.notify_needs_you, runner.notify_turn_done = orig
        return sent

    def test_a_blocked_closing_pings_the_ask_and_flags_the_session(self):
        from bridge import runner
        job = self._job("CI is green. Reply `go` to merge.")
        self.assertEqual(self._run(job), [("needs", "Reply `go` to merge")])
        self.assertEqual(job.tail_needs, "Reply `go` to merge")
        # Same state the UI already sorts, counts and badges as WAIT — but with no
        # `kind`, because there is no pending card to answer.
        with runner._jobs_lock:
            runner._jobs[job.id] = job
        try:
            self.assertEqual(runner.blocked_sessions(),
                             {"sess-tail": "Reply `go` to merge"})
            st = runner._build_status([], [], [], [], {})
            self.assertEqual(st["sess-tail"]["state"], "awaiting")
            self.assertIsNone(st["sess-tail"]["kind"])
            self.assertEqual(st["sess-tail"]["label"], "Reply `go` to merge")
            # A newer turn on that session is working NOW and must win.
            st = runner._build_status(["sess-tail"], [], [], [], {})
            self.assertEqual(st["sess-tail"]["state"], "working")
        finally:
            with runner._jobs_lock:
                runner._jobs.pop(job.id, None)

    def test_no_to_a_closing_question_drops_the_ask_without_a_turn(self):
        from bridge import runner
        job = self._job("Committed on master. Want me to push it now?")
        with runner._jobs_lock:
            runner._jobs[job.id] = job
        try:
            self.assertEqual(runner.asked_sessions(),
                             {"sess-tail": "Want me to push it now?"})
            self.assertEqual(runner._build_status([], [], [], [], {})
                             ["sess-tail"]["state"], "asking")
            self.assertTrue(runner.dismiss_ask("sess-tail"))
            self.assertEqual(runner.asked_sessions(), {})
            self.assertNotIn("sess-tail", runner._build_status([], [], [], [], {}))
        finally:
            with runner._jobs_lock:
                runner._jobs.pop(job.id, None)

    def test_no_also_drops_a_blocked_closing(self):
        # tailstate read the closing as blocked (WAIT), not a passing offer — the
        # transcript still shows the same Yes/No chips, so "No" must clear it too.
        from bridge import runner
        job = self._job("CI is green. Reply `go` to merge.")
        self._run(job)
        with runner._jobs_lock:
            runner._jobs[job.id] = job
        try:
            self.assertEqual(runner._build_status([], [], [], [], {})
                             ["sess-tail"]["state"], "awaiting")
            self.assertTrue(runner.dismiss_ask("sess-tail"))
            self.assertEqual(runner.blocked_sessions(), {})
            self.assertNotIn("sess-tail", runner._build_status([], [], [], [], {}))
        finally:
            with runner._jobs_lock:
                runner._jobs.pop(job.id, None)

    def test_a_late_classifier_cannot_undo_a_dismissal(self):
        # The haiku call outlives the tap: the row must stay dropped.
        from bridge import runner
        job = self._job("CI is green. Reply `go` to merge.")
        job.ask_dismissed = True
        self.assertEqual(self._run(job), [("done", None)])
        self.assertIsNone(job.tail_needs)

    def test_an_ordinary_ending_still_pings_finished(self):
        from bridge import runner
        job = self._job("Fixed the regex; tests pass.")
        self.assertEqual(self._run(job), [("done", None)])
        self.assertIsNone(job.tail_needs)
        with runner._jobs_lock:
            runner._jobs[job.id] = job
        try:
            self.assertEqual(runner.blocked_sessions(), {})
        finally:
            with runner._jobs_lock:
                runner._jobs.pop(job.id, None)


if __name__ == "__main__":
    unittest.main()
