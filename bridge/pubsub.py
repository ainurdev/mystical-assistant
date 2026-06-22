"""In-process bounded pub/sub broker for live fan-out of run events and dev-server
log lines to SSE subscribers.

Each subscriber gets a bounded Queue. A slow/dead subscriber that fills its queue
is collapsed to a single RESYNC sentinel (so it re-fetches from the store at its
cursor) instead of growing without bound or back-pressuring the publisher. Topics:
`session:<id>` (run events) and `logs` (dev-server lines).
"""

import queue
import threading

RESYNC = object()      # "you fell behind — re-fetch from the store at your cursor"
SHUTDOWN = object()    # "the server is stopping — close the stream"

_MAX = 512
_topics: dict[str, set[queue.Queue]] = {}
_lock = threading.Lock()


def subscribe(topic: str) -> queue.Queue:
    q: queue.Queue = queue.Queue(maxsize=_MAX)
    with _lock:
        _topics.setdefault(topic, set()).add(q)
    return q


def unsubscribe(topic: str, q: queue.Queue) -> None:
    with _lock:
        subs = _topics.get(topic)
        if subs is not None:
            subs.discard(q)
            if not subs:
                _topics.pop(topic, None)


def publish(topic: str, item) -> None:
    with _lock:
        subs = list(_topics.get(topic, ()))
    for q in subs:
        try:
            q.put_nowait(item)
        except queue.Full:
            # Slow consumer: drop its backlog and tell it to resync from the store.
            try:
                while True:
                    q.get_nowait()
            except queue.Empty:
                pass
            try:
                q.put_nowait(RESYNC)
            except queue.Full:
                pass


def shutdown() -> None:
    """Wake every blocked subscriber so SSE handlers can return (important: the
    threading HTTP server joins handler threads on shutdown)."""
    with _lock:
        subs = [q for s in _topics.values() for q in s]
        _topics.clear()
    for q in subs:
        try:
            q.put_nowait(SHUTDOWN)
        except queue.Full:
            pass
