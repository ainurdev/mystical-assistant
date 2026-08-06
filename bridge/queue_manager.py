"""Per-session sequential prompt queue for the dashboard Preview Console.

A session may hold only one in-flight Claude turn (see bridge/state.py), so the
queue runs queued prompts ONE AT A TIME per session and auto-advances when each
finishes. Runs go through the same path the dashboard's /local/run uses
(runner.start_streaming_job), injected here as `run_fn` so the state machine is
testable without Claude. Completion is signalled by notify_job_done(), which the
runner calls in its finally block after releasing the session's run slot.

State is keyed by the store session id (the same key the run slot uses), so a
queued item, the run it spawns, and the completion callback all line up. The
whole per-session snapshot is published to the pubsub topic `queue:<session_id>`
and persisted to JSON next to the bridge DB so it survives a server restart.
"""

import json
import os
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field

_TERMINAL = ("done", "failed")


def _newid() -> str:
    return "q" + uuid.uuid4().hex[:10]


@dataclass
class QueueItem:
    """One queued prompt. `text` is the human instruction shown in the UI; `prompt`
    is the full composed prompt actually sent to Claude (selectors, viewport…)."""

    id: str
    session_id: str
    chat_id: int
    project: "str | None"
    text: str
    prompt: str
    images: list
    model: "str | None"
    effort: "str | None"
    permission_mode: "str | None"
    width: int
    sel: list
    surface: str
    status: str = "queued"          # queued | running | done | failed
    job_id: "str | None" = None
    run_job_id: "str | None" = None  # pre-assigned run id (so its image uploads clean up)
    result: "str | None" = None
    error: "str | None" = None
    cost: "float | None" = None
    elapsed: "int | None" = None
    created: float = 0.0
    started: "float | None" = None
    agent: "str | None" = None      # who runs it (ladder.resolve_agent vocabulary)

    def public(self) -> dict:
        """The shape the frontend renders — omits the run payload (prompt/images/
        chat_id/project), keeps everything the QUEUE tab + progress sidebar show."""
        return {
            "id": self.id, "status": self.status, "text": self.text,
            "sel": self.sel, "width": self.width, "surface": self.surface,
            "model": self.model, "effort": self.effort,
            "permission_mode": self.permission_mode, "job_id": self.job_id,
            "result": self.result, "error": self.error, "cost": self.cost,
            "elapsed": self.elapsed, "created": self.created, "started": self.started,
        }


class PreviewQueue:
    """Per-session prompt queues. Thread-safe; all public ops take the session id
    as their first argument."""

    def __init__(self, run_fn, *, interrupt_fn=None, publish_fn=None,
                 persist_path=None):
        # run_fn(item) -> job_id | None  (None means the session was busy).
        self._run_fn = run_fn
        self._interrupt_fn = interrupt_fn      # interrupt_fn(job_id) -> None
        self._publish_fn = publish_fn          # publish_fn(sid, snapshot) -> None
        self._path = persist_path
        self._lock = threading.RLock()
        self._q: dict = {}                     # sid -> {"items": [...], "paused": bool, "rev": int}
        if persist_path:
            self._load()

    # --- bucket helpers ----------------------------------------------------

    def _bucket(self, sid: str) -> dict:
        b = self._q.get(sid)
        if b is None:
            b = {"items": [], "paused": False, "rev": 0}
            self._q[sid] = b
        return b

    def _snap(self, sid: str, b: dict) -> dict:
        return {
            "session_id": sid, "seq": b["rev"], "paused": b["paused"],
            "items": [it.public() for it in b["items"]],
        }

    def _touch(self, sid: str, b: dict) -> None:
        """Bump the revision, persist, and publish the new snapshot."""
        b["rev"] += 1
        if self._path:
            try:
                self._save()
            except OSError:
                pass
        snap = self._snap(sid, b)
        if self._publish_fn:
            self._publish_fn(sid, snap)
        else:
            try:
                from bridge import pubsub
                pubsub.publish(f"queue:{sid}", snap)
            except Exception:  # noqa: BLE001  — never let publishing break a mutation
                pass

    # --- the runner: start the next queued item when idle ------------------

    def _advance(self, sid: str, b: dict) -> None:
        if b["paused"]:
            return
        if any(it.status == "running" for it in b["items"]):
            return
        nxt = next((it for it in b["items"] if it.status == "queued"), None)
        if nxt is None:
            return
        job_id = self._run_fn(nxt)
        if not job_id:
            return  # session busy — retry on the next notify/enqueue/resume
        nxt.status = "running"
        nxt.job_id = job_id
        nxt.started = time.time()

    # --- public API --------------------------------------------------------

    def enqueue(self, sid: str, *, text, prompt, images, model, effort,
                permission_mode, width, sel, surface, chat_id, project,
                run_job_id=None, agent=None) -> str:
        with self._lock:
            b = self._bucket(sid)
            item = QueueItem(
                id=_newid(), session_id=sid, chat_id=chat_id, project=project,
                text=text, prompt=prompt, images=list(images or []), model=model,
                effort=effort, permission_mode=permission_mode, width=width,
                sel=list(sel or []), surface=surface, run_job_id=run_job_id,
                agent=agent, created=time.time())
            b["items"].append(item)
            self._advance(sid, b)
            self._touch(sid, b)
            return item.id

    def notify_job_done(self, sid: str, job_id: str, status: str, result,
                        cost, elapsed, error=None) -> None:
        """Called when ANY run in this session finishes (queue item or not). Marks
        the matching item terminal, then starts the next queued one."""
        with self._lock:
            b = self._bucket(sid)
            it = next((x for x in b["items"]
                       if x.job_id == job_id and x.status == "running"), None)
            if it is not None:
                if status == "done":
                    it.status = "done"
                    it.result = result
                else:
                    it.status = "failed"
                    it.error = error or result or "run failed"
                it.cost = cost
                it.elapsed = elapsed
            self._advance(sid, b)
            self._touch(sid, b)

    def pause(self, sid: str) -> None:
        with self._lock:
            b = self._bucket(sid)
            b["paused"] = True
            self._touch(sid, b)

    def resume(self, sid: str) -> None:
        with self._lock:
            b = self._bucket(sid)
            b["paused"] = False
            self._advance(sid, b)
            self._touch(sid, b)

    def bump(self, sid: str, item_id: str) -> None:
        """Move a queued item so it runs next (just before the first queued one)."""
        with self._lock:
            b = self._bucket(sid)
            items = b["items"]
            i = next((k for k, x in enumerate(items) if x.id == item_id), -1)
            if i < 0 or items[i].status != "queued":
                return
            m = items.pop(i)
            fq = next((k for k, x in enumerate(items) if x.status == "queued"),
                      len(items))
            items.insert(fq, m)
            self._touch(sid, b)

    def reorder(self, sid: str, from_id: str, to_id: str) -> None:
        """Drop one queued item just before another queued item."""
        with self._lock:
            b = self._bucket(sid)
            items = b["items"]
            fi = next((k for k, x in enumerate(items) if x.id == from_id), -1)
            if fi < 0 or items[fi].status != "queued":
                return
            target = next((x for x in items if x.id == to_id), None)
            if target is None or target.status != "queued":
                return
            m = items.pop(fi)
            ti = next((k for k, x in enumerate(items) if x.id == to_id), len(items))
            items.insert(ti, m)
            self._touch(sid, b)

    def remove(self, sid: str, item_id: str) -> None:
        with self._lock:
            b = self._bucket(sid)
            it = next((x for x in b["items"] if x.id == item_id), None)
            if it is None or it.status == "running":
                return
            b["items"].remove(it)
            self._touch(sid, b)

    def move(self, sid: str, item_id: str, dst: str) -> None:
        """Eject a queued item into another session's queue, where it runs instead.
        The destination queue advances immediately (a fresh session is idle), so a
        prompt stuck behind a long turn here starts right away over there."""
        with self._lock:
            if not dst or dst == sid:
                return
            b = self._bucket(sid)
            it = next((x for x in b["items"] if x.id == item_id), None)
            if it is None or it.status != "queued":
                return
            b["items"].remove(it)
            d = self._bucket(dst)
            it.session_id = dst
            d["items"].append(it)
            self._advance(dst, d)
            self._touch(dst, d)
            self._touch(sid, b)

    def edit(self, sid: str, item_id: str, text: str, prompt: str) -> None:
        with self._lock:
            b = self._bucket(sid)
            it = next((x for x in b["items"] if x.id == item_id), None)
            if it is None or it.status != "queued":
                return
            it.text = text
            it.prompt = prompt
            self._touch(sid, b)

    def cancel(self, sid: str, item_id: str) -> None:
        """Stop the running item: mark it failed and interrupt its job. The real
        completion (notify_job_done) arrives later and just advances the queue."""
        jid = None
        with self._lock:
            b = self._bucket(sid)
            it = next((x for x in b["items"] if x.id == item_id), None)
            if it is None or it.status != "running":
                return
            jid = it.job_id
            it.status = "failed"
            it.error = "cancelled by user"
            self._touch(sid, b)
        if jid and self._interrupt_fn:
            self._interrupt_fn(jid)

    def retry(self, sid: str, item_id: str) -> None:
        with self._lock:
            b = self._bucket(sid)
            it = next((x for x in b["items"] if x.id == item_id), None)
            if it is None or it.status not in _TERMINAL:
                return
            it.status = "queued"
            it.job_id = None
            it.result = None
            it.error = None
            it.cost = None
            it.elapsed = None
            it.started = None
            it.images = []          # the original upload files were cleaned after the run
            it.run_job_id = None
            self._advance(sid, b)
            self._touch(sid, b)

    def clear_done(self, sid: str) -> None:
        with self._lock:
            b = self._bucket(sid)
            b["items"] = [x for x in b["items"] if x.status not in _TERMINAL]
            self._touch(sid, b)

    # --- reads -------------------------------------------------------------

    def snapshot(self, sid: str) -> dict:
        with self._lock:
            return self._snap(sid, self._bucket(sid))

    def backfill(self, sid: str, cursor: int) -> list:
        """SSE backfill: the current snapshot if the client is behind, else []."""
        with self._lock:
            snap = self._snap(sid, self._bucket(sid))
            return [snap] if snap["seq"] >= cursor else []

    def sessions(self) -> list:
        """Session ids that still hold items — the Mini App's WORK tab lists
        every queued prompt at once, not one session's."""
        with self._lock:
            return [sid for sid, b in self._q.items() if b["items"]]

    # --- persistence -------------------------------------------------------

    def _save(self) -> None:
        data = {
            sid: {
                "paused": b["paused"], "rev": b["rev"],
                "items": [asdict(it) for it in b["items"]],
            }
            for sid, b in self._q.items()
        }
        os.makedirs(os.path.dirname(self._path), exist_ok=True)
        tmp = self._path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, self._path)

    def _load(self) -> None:
        try:
            with open(self._path, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            return
        if not isinstance(data, dict):
            return
        for sid, bd in data.items():
            items = []
            for d in bd.get("items", []):
                try:
                    it = QueueItem(**d)
                except TypeError:
                    continue  # stale schema — drop the item, keep the rest
                if it.status == "running":
                    # The job died with the server; re-queue so it runs again.
                    it.status = "queued"
                    it.job_id = None
                    it.started = None
                items.append(it)
            self._q[sid] = {
                "paused": bool(bd.get("paused", False)),
                "rev": int(bd.get("rev", 0)), "items": items,
            }


# --------------------------------------------------------------------------
# Module-level singleton wired to the real runner / pubsub / persistence.
# (Glue — exercised through the dashboard, not the unit tests above.)
# --------------------------------------------------------------------------

_instance: "PreviewQueue | None" = None
_instance_lock = threading.Lock()


def _default_run_fn(item: QueueItem):
    from bridge import ladder, runner
    try:
        slot, runtime = ladder.resolve_agent(item.agent or "")
    except ValueError:
        slot, runtime = None, None     # the pick went away while queued
    job = runner.start_streaming_job(
        chat_id=item.chat_id, prompt=item.prompt, image_paths=list(item.images or []),
        project=item.project, job_id=item.run_job_id, model=item.model,
        effort=item.effort, permission_mode=item.permission_mode,
        session_id=item.session_id, origin="preview-queue",
        account_slot=slot, runtime=runtime)
    return job.id if job else None


def _default_interrupt(job_id: str) -> None:
    from bridge import runner
    job = runner.get_job(job_id)
    if job is not None:
        try:
            job.interrupt()
        except Exception:  # noqa: BLE001
            pass


def get() -> PreviewQueue:
    global _instance
    with _instance_lock:
        if _instance is None:
            from bridge import config
            path = os.path.join(os.path.dirname(config.BRIDGE_DB), "preview_queue.json")
            _instance = PreviewQueue(
                run_fn=_default_run_fn, interrupt_fn=_default_interrupt,
                persist_path=path)
        return _instance


# Thin module-level wrappers so callers can use queue_manager.enqueue(...) etc.
def enqueue(sid, **kw):
    return get().enqueue(sid, **kw)


def notify_job_done(sid, job_id, status, result, cost, elapsed, error=None):
    return get().notify_job_done(sid, job_id, status, result, cost, elapsed, error=error)


def snapshot(sid):
    return get().snapshot(sid)


def backfill(sid, cursor):
    return get().backfill(sid, cursor)


def sessions():
    return get().sessions()


def pause(sid):
    return get().pause(sid)


def resume(sid):
    return get().resume(sid)


def bump(sid, item_id):
    return get().bump(sid, item_id)


def reorder(sid, from_id, to_id):
    return get().reorder(sid, from_id, to_id)


def remove(sid, item_id):
    return get().remove(sid, item_id)


def move(sid, item_id, dst):
    return get().move(sid, item_id, dst)


def edit(sid, item_id, text, prompt):
    return get().edit(sid, item_id, text, prompt)


def cancel(sid, item_id):
    return get().cancel(sid, item_id)


def retry(sid, item_id):
    return get().retry(sid, item_id)


def clear_done(sid):
    return get().clear_done(sid)
