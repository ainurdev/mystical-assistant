"""Who sent a turn's prompt when you didn't type it: the queue item carries the
sender's tag and why to start_streaming_job, which puts them on the turn row
the dashboard draws Mystical's notes from (PromptBubble's SIGIL)."""

from bridge import config, queue_manager, runner, state, store

store.init()

CHAT = 556


def test_a_queued_bridge_prompt_lands_on_its_turn_as_mystical(monkeypatch):
    from bridge import titler
    monkeypatch.setattr(runner, "_jobs", {})
    monkeypatch.setattr(titler, "kick", lambda *a, **k: None)
    monkeypatch.setattr(runner, "_run_streaming", lambda *a, **k: None)
    s = store.create_session(CHAT, config.BASE_PATH, cwd=config.BASE_PATH)
    jobs = []

    def run(item):
        jobs.append(queue_manager._default_run_fn(item))
        return jobs[-1]

    q = queue_manager.PreviewQueue(run_fn=run, interrupt_fn=lambda j: None, steer_fn=lambda *a: True)
    q.enqueue(s["id"], text="carry on", prompt="carry on", images=[], model=None, effort=None,
              permission_mode=None, width=None, sel=[], surface="carry-on", chat_id=CHAT,
              project=config.BASE_PATH, sent_by="mystical:mcp", sent_why="you turned playwright on")
    state.release_run(s["id"])
    turn = store.transcript(s["id"])["turns"][-1]
    assert (turn["sent_by"], turn["sent_why"]) == ("mystical:mcp", "you turned playwright on")


def test_a_prompt_you_typed_has_no_sender_and_a_copy_keeps_it():
    s = store.create_session(CHAT, "/sent-by-copy")
    store.start_turn(s["id"], "typed", "hi", [])
    store.start_turn(s["id"], "bridge", "carry on", [], sent_by="mystical:nudge", sent_why="no StepDone")
    copy = store.duplicate(s["id"])
    got = [(t["sent_by"], t["sent_why"]) for t in store.transcript(copy["id"])["turns"]]
    assert got == [(None, None), ("mystical:nudge", "no StepDone")]
