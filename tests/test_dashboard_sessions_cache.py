"""GET /local/sessions is built once per (chat, project) and shared for
_SESSIONS_TTL seconds (bridge/dashboard/server.py): concurrent pollers wait for
that one build instead of each running it, and clearing the cache (what a
dashboard POST does) forces a fresh build.
Run: python -m pytest tests/test_dashboard_sessions_cache.py -v
"""

import threading
import time

from bridge.dashboard import server


def test_concurrent_pollers_share_one_build_and_clear_rebuilds(monkeypatch):
    builds = []

    def slow_build(chat, project):
        builds.append((chat, project))
        time.sleep(0.2)
        return {"sessions": [len(builds)]}

    monkeypatch.setattr(server, "_sessions_payload", slow_build)
    server._sessions_cache.clear()
    out = []
    threads = [threading.Thread(target=lambda: out.append(server._sessions_cached(1, None)))
               for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert builds == [(1, None)]
    assert out == [{"sessions": [1]}] * 8

    server._sessions_cached(2, None)              # another chat never gets chat 1's list
    assert builds[-1] == (2, None)

    server._sessions_cache.clear()
    assert server._sessions_cached(1, None) == {"sessions": [3]}


def test_a_stale_entry_is_rebuilt(monkeypatch):
    n = []
    monkeypatch.setattr(server, "_sessions_payload", lambda c, p: n.append(1) or {"n": len(n)})
    server._sessions_cache.clear()
    server._sessions_cached(1, "proj")
    server._sessions_cache[(1, "proj")] = (time.time() - server._SESSIONS_TTL - 1, {"n": 1})
    assert server._sessions_cached(1, "proj") == {"n": 2}
