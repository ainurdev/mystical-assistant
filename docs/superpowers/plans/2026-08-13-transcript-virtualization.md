# Transcript Virtualization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make opening and scrolling a 2608-event session cost the same as a median one — gzip the response, ship only the last 10 turns, and mount only the turns near the viewport.

**Architecture:** Three server-light layers. (1) A shared gzip helper both HTTP handlers call from `_json`. (2) A pure `tail_slice()` applied in `transcript_for` — the one choke point both store-backed and native-JSONL transcripts flow through — plus a "load older" prepend path that reuses `mergeDelta` unchanged. (3) `@tanstack/react-virtual` over **turn-granularity** rows in the dashboard `Transcript`, keeping `RunStream` and its internal `content-visibility` cards untouched; then the same pattern ported to the Mini App.

**Tech Stack:** Python stdlib (gzip), pytest, React 19, @tanstack/react-virtual 3.14.5 (already a dep), raw-CDP probe for measurement.

**Spec:** `docs/superpowers/specs/2026-08-12-transcript-virtualization-design.md`

## Global Constraints

- **NEVER restart or kill the live bridge** (python3 pid ~521440 serving 8787/8790). It would SIGKILL this session. Server-side Python changes are verified by pytest + a throwaway server on port 8791; they go live only when the user next restarts the bridge.
- **`npm run build` in `bridge/dashboard/web` deploys instantly** to live 8790 (static dist reads). Every frontend commit must be safe against the OLD Python (which ignores `tail`/`before` and returns no `has_older` field). Absent fields ⇒ frontend behaves exactly as today.
- **The forward cursor is the invariant** (spec): `cursor` means "events with seq ≥ cursor", `next_cursor` advances monotonically, and live 1.5s polling depends on it. `tail` may only be sent when `cursor == 0`; older-page responses must never update `seqRef`.
- `TAIL_TURNS = 10`, gzip threshold `32 * 1024` bytes — spec values.
- Work directly on branch `feat/claude-design-routing` in this checkout (the bridge serves this checkout's dist; worktrees lack node_modules and can be pruned).
- Acceptance instrument: `bridge/dashboard/web/tools/transcript-probe.mjs` (Task 0) against sessions `08fe853314ab4a19b9e8a93eb664b115` (2608 ev) and `28704a0e15174fe9a2f7f4b2cb9cbe45` (128 ev). Targets @4x throttle: open <1s, scroll p50 <50ms, heap <30MB, DOM nodes <8k (record actual if a mega-turn in view exceeds it).
- Python test baseline: 809 passed / 4 failed (the 4 are the known MCP-allowlist defaults). Anything else is new breakage.
- Commit after every task. No Claude co-author lines, no "Generated with" footers.
- **Spec deviation, decided during planning:** rows are **turns, not events**. `mergeDelta` prepends whole turns for free, `RunStream`'s 1458 lines of folding/pending logic stay untouched, and per-turn `content-visibility` keeps within-turn cost flat. Worst single turn is 335 events ≈ one ~420ms@4x mount hitch at the overscan edge — accepted; escalation path (event-level rows via extracting RunStream's card pipeline) only if probe targets miss. Task 5 amends the spec to record this.

---

### Task 0: Probe tool in-repo + baselines

**Files:**
- Create: `bridge/dashboard/web/tools/transcript-probe.mjs` (from `/tmp/cdp.mjs`)
- Test: manual probe run + pytest baseline

**Interfaces:**
- Produces: `node tools/transcript-probe.mjs "<session title fragment>" "<label>"` printing a JSON metrics blob; env `THROTTLE=4` enables CPU throttle, `CDP_PORT` (default 9333).

- [ ] **Step 1: Copy the probe and fold in the throttle flag**

Copy `/tmp/cdp.mjs` to `bridge/dashboard/web/tools/transcript-probe.mjs`. Replace the `Performance.enable` line with:

```js
await send('Performance.enable');
const rate = Number(process.env.THROTTLE || 1);
if (rate > 1) await send('Emulation.setCPUThrottlingRate', { rate });
```

Add a header comment: what it measures, the chrome launch line (Step 2), and that it must only GET — never POST — against the live dashboard.

- [ ] **Step 2: Verify the probe runs from its new home**

```bash
LD_LIBRARY_PATH=$HOME/.cache/ms-playwright:$LD_LIBRARY_PATH \
 $HOME/.cache/ms-playwright/chromium_headless_shell-1232/chrome-headless-shell-linux64/chrome-headless-shell \
 --headless --no-sandbox --disable-gpu --hide-scrollbars --window-size=1512,950 \
 --remote-debugging-port=9333 --user-data-dir=/tmp/probe-prof about:blank & sleep 4
cd bridge/dashboard/web && node tools/transcript-probe.mjs "Staging UAT Test Scenarios" "baseline-med"
```

Expected: JSON blob with `settleMs`, `domNodes`, `heapMB`, `scroll` — matching the magnitudes already recorded in the spec. Kill only this chrome (`pkill -f "remote-debugging-port=9333"`) — other chrome processes belong to other tools.

- [ ] **Step 3: Pytest baseline**

Run: `cd /home/mhzrerfani/projects/mystical-assistant && python3 -m pytest tests/ -q 2>&1 | tail -3`
Expected: `809 passed, 4 failed` shape (only the known MCP-allowlist four). Record the exact counts in the commit message of this task.

- [ ] **Step 4: Commit**

```bash
git add bridge/dashboard/web/tools/transcript-probe.mjs
git commit -m "test(dashboard): commit the CDP probe that measured the transcript"
```

---

### Task 1: gzip JSON responses (Layer 1)

**Files:**
- Create: `bridge/httpgz.py`
- Modify: `bridge/dashboard/server.py:192` (`_json`), `bridge/miniapp/server.py:199` (`_json`)
- Test: `tests/test_httpgz.py`

**Interfaces:**
- Produces: `httpgz.maybe_gzip(raw: bytes, accept_encoding: str) -> tuple[bytes, bool]` — returns `(body, gzipped)`; gzipped is True only when the body cleared the threshold AND the client accepts gzip.

- [ ] **Step 1: Write the failing tests**

`tests/test_httpgz.py`:

```python
"""maybe_gzip: compress JSON bodies over the threshold for clients that accept it."""
import gzip

from bridge.httpgz import THRESHOLD, maybe_gzip

BIG = b'{"x": "' + b"a" * (64 * 1024) + b'"}'


def test_small_body_passes_through():
    body, zipped = maybe_gzip(b'{"ok": true}', "gzip")
    assert (body, zipped) == (b'{"ok": true}', False)


def test_big_body_gzips_when_accepted():
    body, zipped = maybe_gzip(BIG, "gzip, deflate, br")
    assert zipped and len(body) < len(BIG)
    assert gzip.decompress(body) == BIG


def test_big_body_plain_without_accept():
    body, zipped = maybe_gzip(BIG, "")
    assert (body, zipped) == (BIG, False)


def test_accept_header_is_case_insensitive():
    _, zipped = maybe_gzip(BIG, "GZip")
    assert zipped


def test_threshold_is_exclusive():
    at = b"a" * THRESHOLD
    _, zipped = maybe_gzip(at, "gzip")
    assert not zipped
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest tests/test_httpgz.py -q`
Expected: FAIL — `ModuleNotFoundError: bridge.httpgz`

- [ ] **Step 3: Implement `bridge/httpgz.py`**

```python
"""Gzip large JSON bodies. The 2608-event transcript is 1.7 MB of JSON that
compresses 4.5x; below ~32 KB the CPU spent compressing outweighs the transfer
saved, so small responses pass through untouched. Stdlib only."""

import gzip

THRESHOLD = 32 * 1024


def maybe_gzip(raw: bytes, accept_encoding: str) -> tuple[bytes, bool]:
    """(body, gzipped). Gzips only when the client accepts it and it pays."""
    if len(raw) <= THRESHOLD or "gzip" not in (accept_encoding or "").lower():
        return raw, False
    return gzip.compress(raw, compresslevel=5), True
```

- [ ] **Step 4: Run tests to verify pass**

Run: `python3 -m pytest tests/test_httpgz.py -q` — Expected: 5 passed.

- [ ] **Step 5: Wire both `_json` implementations**

`bridge/dashboard/server.py` — add `from bridge import httpgz` to the existing `from bridge import (...)` block, then replace `_json`:

```python
    def _json(self, obj, code: int = 200):
        raw, zipped = httpgz.maybe_gzip(
            json.dumps(obj).encode(), self.headers.get("Accept-Encoding", ""))
        if zipped:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            try:
                self.wfile.write(raw)
            except (BrokenPipeError, ConnectionResetError):
                pass
        else:
            self._send(raw, code, "application/json")
```

`bridge/miniapp/server.py` — same change to its `_json`, using its `_send_bytes` for the plain path. SSE streams (`_sse` / `_stream`) do not route through `_json` and stay uncompressed — verify with `grep -n "_json\|_sse" bridge/dashboard/server.py | head -30` that no streaming path calls `_json`.

Note: both `_send` helpers set identical headers; the gzip branch inlines them because `_send` has no header hook — do NOT refactor `_send`'s signature (surgical-changes rule).

- [ ] **Step 6: Full pytest**

Run: `python3 -m pytest tests/ -q 2>&1 | tail -3` — Expected: baseline + 5 new passes, no new failures.

- [ ] **Step 7: Verify end-to-end on a throwaway server (port 8791)**

The live bridge on 8790 runs old code — do not touch it. Start a second instance from this checkout (`start()` at `bridge/dashboard/server.py:1574` — check whether it spawns its own thread or returns the httpd; run accordingly):

```bash
cd /home/mhzrerfani/projects/mystical-assistant
set -a; source .env 2>/dev/null; set +a
DASH_PORT=8791 python3 -c "from bridge.dashboard import server; h = server.start(); \
import threading; threading.Event().wait()" &
sleep 2
curl -s -H 'Accept-Encoding: gzip' -D - -o /tmp/gz.bin \
  "http://127.0.0.1:8791/local/sessions/08fe853314ab4a19b9e8a93eb664b115" | grep -iE "encoding|length"
curl -s -o /tmp/plain.json "http://127.0.0.1:8791/local/sessions/08fe853314ab4a19b9e8a93eb664b115"
```

Expected: gzip request shows `Content-Encoding: gzip` and ~380 KB; plain request ~1.7 MB and byte-identical JSON after `gzip -d`. **Only hit `/local/sessions/<id>`** — `/local/sessions` (the list) calls `native.refresh` which writes to the real DB. Kill the throwaway server when done.

- [ ] **Step 8: Commit**

```bash
git add bridge/httpgz.py tests/test_httpgz.py bridge/dashboard/server.py bridge/miniapp/server.py
git commit -m "feat(server): gzip large JSON responses

The 2608-event transcript ships 1.7MB uncompressed; it gzips to 377KB.
Threshold 32KB, JSON responses only — SSE streams are untouched."
```

---

### Task 2: `tail_slice()` (Layer 2, pure part)

**Files:**
- Create: `bridge/transcript_page.py`
- Test: `tests/test_transcript_page.py`

**Interfaces:**
- Consumes: the assembled transcript dict `{session, turns, events, next_cursor}` (events seq-ascending, each with `seq` and `turn_id`).
- Produces: `tail_slice(data: dict, tail: int, before: int | None = None) -> dict` — same dict plus `has_older: bool`, `oldest_seq: int | None`, `tail_from: str | None`. `turns` and `next_cursor` pass through untouched.

- [ ] **Step 1: Write the failing tests**

`tests/test_transcript_page.py`:

```python
"""tail_slice: last-N-turns windowing over an assembled transcript."""
from bridge.transcript_page import tail_slice


def _data(events, turns=None):
    tids = turns or sorted({e["turn_id"] for e in events})
    return {
        "session": {"id": "s"},
        "turns": [{"id": t, "seq": i} for i, t in enumerate(tids)],
        "events": events,
        "next_cursor": (events[-1]["seq"] + 1) if events else 0,
    }


def _ev(seq, turn):
    return {"seq": seq, "turn_id": turn, "type": "text"}


THREE_TURNS = [_ev(1, "t1"), _ev(2, "t1"), _ev(3, "t2"), _ev(4, "t3"), _ev(5, "t3")]


def test_tail_keeps_last_n_turns_events():
    out = tail_slice(_data(THREE_TURNS), tail=2)
    assert [e["seq"] for e in out["events"]] == [3, 4, 5]
    assert out["has_older"] is True
    assert out["oldest_seq"] == 3
    assert out["tail_from"] == "t2"


def test_turns_and_cursor_pass_through():
    d = _data(THREE_TURNS)
    out = tail_slice(d, tail=2)
    assert out["turns"] == d["turns"]
    assert out["next_cursor"] == 6            # still the live head


def test_tail_covering_everything_flags_nothing():
    out = tail_slice(_data(THREE_TURNS), tail=3)
    assert len(out["events"]) == 5
    assert out["has_older"] is False
    assert out["tail_from"] is None           # no slice -> render from the top


def test_before_pages_backwards():
    out = tail_slice(_data(THREE_TURNS), tail=1, before=3)
    assert [e["seq"] for e in out["events"]] == [1, 2]
    assert out["has_older"] is False          # t1 was the oldest turn
    assert out["oldest_seq"] == 1


def test_before_with_more_behind():
    out = tail_slice(_data(THREE_TURNS), tail=1, before=4)
    assert [e["seq"] for e in out["events"]] == [3]
    assert out["has_older"] is True


def test_empty_events():
    out = tail_slice(_data([]), tail=5)
    assert out["events"] == []
    assert out["has_older"] is False
    assert out["oldest_seq"] is None


def test_prompt_only_turns_do_not_count_toward_n():
    # t2 exists in turns but has no events; tail counts event-bearing turns.
    evs = [_ev(1, "t1"), _ev(2, "t3")]
    out = tail_slice(_data(evs, turns=["t1", "t2", "t3"]), tail=1)
    assert [e["seq"] for e in out["events"]] == [2]
    assert out["has_older"] is True
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest tests/test_transcript_page.py -q` — Expected: FAIL, module missing.

- [ ] **Step 3: Implement `bridge/transcript_page.py`**

```python
"""Tail-slice an assembled transcript ({session, turns, events, next_cursor})
down to the last N event-bearing turns, so a 2608-event session doesn't ship
whole on first open. Applied AFTER assembly (store or native JSONL — 37ms for
the worst session, so re-querying isn't worth plumbing SQL for), which keeps
one implementation for both sources.

The turns list and next_cursor pass through untouched: turns are cheap (max
observed 34 rows) and the frontends' checkpoint list needs them all, while
next_cursor must keep meaning "the live head" so forward polling is unaffected.
Stdlib only."""


def tail_slice(data: dict, tail: int, before: int | None = None) -> dict:
    """Adds has_older / oldest_seq / tail_from; slices only `events`.

    tail:   keep the last N turns that have events (a prompt-only turn costs
            nothing to ship, so it doesn't spend the budget).
    before: consider only events with seq < before — the "load older" page.
    """
    events = data.get("events") or []
    considered = [e for e in events if before is None or e["seq"] < before]
    order = {t["id"]: i for i, t in enumerate(data.get("turns") or [])}
    bearing: list = []                     # turn ids with events, transcript order
    seen: set = set()
    for e in considered:
        tid = e.get("turn_id")
        if tid not in seen:
            seen.add(tid)
            bearing.append(tid)
    bearing.sort(key=lambda tid: order.get(tid, -1))
    keep = set(bearing[-tail:]) if tail > 0 else set()
    kept = [e for e in considered if e.get("turn_id") in keep]
    has_older = len(kept) < len(considered)
    out = dict(data)
    out["events"] = kept
    out["has_older"] = has_older
    out["oldest_seq"] = kept[0]["seq"] if kept else None
    out["tail_from"] = kept[0]["turn_id"] if (kept and has_older) else None
    return out
```

- [ ] **Step 4: Run tests to verify pass**

Run: `python3 -m pytest tests/test_transcript_page.py -q` — Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add bridge/transcript_page.py tests/test_transcript_page.py
git commit -m "feat(transcript): tail_slice windows a transcript to its last N turns"
```

---

### Task 3: wire `tail`/`before` through `transcript_for` and both routes

**Files:**
- Modify: `bridge/miniapp/server.py:138` (`transcript_for`), miniapp GET route (~line 478), `bridge/dashboard/server.py` GET route (~line 312)
- Test: `tests/test_transcript_page.py` (extend)

**Interfaces:**
- Consumes: `transcript_page.tail_slice` (Task 2).
- Produces: `transcript_for(session: dict, cursor: int = 0, tail: int | None = None, before: int | None = None) -> dict`; HTTP: `GET /local/sessions/<id>?cursor=0&tail=10[&before=<seq>]` — response gains `has_older`, `oldest_seq`, `tail_from` **only when `tail` was passed**.

- [ ] **Step 1: Write the failing integration tests** (append to `tests/test_transcript_page.py`)

```python
def test_transcript_for_applies_tail(monkeypatch):
    from bridge.miniapp import server as mini
    canned = _data(THREE_TURNS)
    monkeypatch.setattr(mini.store, "transcript", lambda sid, cursor=0: dict(canned))
    out = mini.transcript_for({"id": "s", "origin": "miniapp"}, tail=2)
    assert out["has_older"] is True and [e["seq"] for e in out["events"]] == [3, 4, 5]


def test_transcript_for_without_tail_is_unchanged(monkeypatch):
    from bridge.miniapp import server as mini
    canned = _data(THREE_TURNS)
    monkeypatch.setattr(mini.store, "transcript", lambda sid, cursor=0: dict(canned))
    out = mini.transcript_for({"id": "s", "origin": "miniapp"})
    assert "has_older" not in out and len(out["events"]) == 5


def test_transcript_for_tails_native_jsonl(monkeypatch):
    from bridge.miniapp import server as mini
    canned = _data(THREE_TURNS)
    monkeypatch.setattr(mini.transcript_jsonl, "find_transcript", lambda sid: "/tmp/x.jsonl")
    monkeypatch.setattr(mini.transcript_jsonl, "parse_jsonl",
                        lambda path, cursor=0: {k: canned[k] for k in ("turns", "events", "next_cursor")})
    out = mini.transcript_for({"id": "s", "origin": "vscode", "claude_session_id": "u"}, tail=2)
    assert out["has_older"] is True
```

(The store fallback path inside `transcript_for` fires only when `data["turns"]` is empty — canned data is non-empty, so `store.transcript` is the only store call. Check the imports the test assumes — `mini.store`, `mini.transcript_jsonl` — exist as module attributes; they do, both are imported at the top of `bridge/miniapp/server.py`.)

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest tests/test_transcript_page.py -q` — Expected: new tests FAIL (`transcript_for() got an unexpected keyword argument 'tail'`).

- [ ] **Step 3: Extend `transcript_for`**

In `bridge/miniapp/server.py`, add `from bridge import transcript_page` to the existing bridge import block, change the signature to `def transcript_for(session: dict, cursor: int = 0, tail: int | None = None, before: int | None = None) -> dict:` and wrap each of the three `return` points — cleanest as a small inner closure:

```python
def transcript_for(session: dict, cursor: int = 0,
                   tail: int | None = None, before: int | None = None) -> dict:
    """... existing docstring; add: `tail`/`before` window the events to the
    last N event-bearing turns (transcript_page.tail_slice) — turns and
    next_cursor always ship whole, so forward polling is unaffected."""
    def page(d: dict) -> dict:
        return transcript_page.tail_slice(d, tail, before) if tail is not None else d
    # ... existing body, with each `return {...}` / `return data` wrapped in page(...)
```

- [ ] **Step 4: Parse the params in both GET routes**

Miniapp route (~478) and dashboard route (~312) currently do `cursor = int(qs.get("cursor", ["0"])[0])` in a try/except. Extend each, matching local style:

```python
        def _qint(name):
            try:
                v = qs.get(name, [None])[0]
                return int(v) if v is not None else None
            except ValueError:
                return None
        return self._json(transcript_for(s, cursor, tail=_qint("tail"), before=_qint("before")))
```

(Dashboard's route returns `self._json(transcript_for(s, cursor))` at ~line 320; miniapp's at ~481. Keep each handler's existing cursor parsing; only add the two optional ints.)

- [ ] **Step 5: Run full pytest**

Run: `python3 -m pytest tests/ -q 2>&1 | tail -3` — Expected: baseline + new passes, nothing newly broken.

- [ ] **Step 6: End-to-end against the throwaway server**

Re-start the 8791 instance (Task 1 Step 7 recipe) with the new code, then:

```bash
curl -s "http://127.0.0.1:8791/local/sessions/08fe853314ab4a19b9e8a93eb664b115?tail=10" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['events']), d['has_older'], d['oldest_seq'], d['tail_from'], d['next_cursor'])"
curl -s "http://127.0.0.1:8791/local/sessions/08fe853314ab4a19b9e8a93eb664b115?tail=10&before=<oldest_seq printed above>" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['events']), d['has_older'], d['oldest_seq'])"
```

Expected: first call returns far fewer than 2608 events with `has_older true` and `next_cursor` equal to the full head (compare against the no-param call); second returns the previous window with a smaller `oldest_seq`. Also confirm the no-param call is byte-identical to before (no `has_older` key). Kill the throwaway server.

- [ ] **Step 7: Commit**

```bash
git add bridge/miniapp/server.py bridge/dashboard/server.py tests/test_transcript_page.py
git commit -m "feat(transcript): serve the last N turns first, older pages on demand

?tail=10 windows the first load to the last 10 event-bearing turns;
?before=<seq> pages backwards. next_cursor still means the live head, so
the 1.5s forward poll is untouched. Responses without ?tail are byte-identical."
```

---

### Task 4: dashboard frontend — tail on open, "load older" control

**Files:**
- Modify: `bridge/dashboard/web/src/api.ts` (Transcript type ~115, `transcript` fetcher ~755)
- Modify: `bridge/dashboard/web/src/App.tsx` (state ~276-284, session-switch reset ~436, fetch effect ~518-544, Terminal props ~1630)
- Modify: `bridge/dashboard/web/src/components/hud/Terminal.tsx` (prop plumb ~295)
- Modify: `bridge/dashboard/web/src/components/Transcript.tsx` (load-older button, `renderFrom` slice)

**Interfaces:**
- Consumes: HTTP contract from Task 3 (fields absent when server is old — every use must tolerate `undefined`).
- Produces (used by Tasks 5–6): `App` state `older: { has: boolean; seq: number | null; from: string | null; loading: boolean }`; `loadOlder(): Promise<void>`; Transcript props `hasOlder?: boolean; olderLoading?: boolean; onLoadOlder?: () => void; renderFrom?: string | null`.

- [ ] **Step 1: api.ts**

```ts
export interface Transcript {
  session: SessionBrief | null;
  turns: StoreTurn[];
  events: StoreEvent[];
  next_cursor: number;
  // Present only when the request carried ?tail= (new servers).
  has_older?: boolean;
  oldest_seq?: number | null;
  tail_from?: string | null;
}
```

```ts
  transcript: (id: string, cursor: number, opts?: { tail?: number; before?: number }) =>
    req<Transcript>(`/local/sessions/${encodeURIComponent(id)}?cursor=${cursor}` +
      (opts?.tail ? `&tail=${opts.tail}` : "") +
      (opts?.before ? `&before=${opts.before}` : "")),
```

- [ ] **Step 2: App.tsx state + reset + fetch**

Near `seqRef` (~276):

```ts
  const TAIL_TURNS = 10;
  // Older turns exist server-side but aren't loaded. `from` = first turn whose
  // events are loaded (render cut), `seq` = oldest loaded event seq (next page key).
  const [older, setOlder] = useState<{ has: boolean; seq: number | null; from: string | null; loading: boolean }>(
    { has: false, seq: null, from: null, loading: false });
  const olderRef = useRef(older);
  olderRef.current = older;
```

At the session-switch reset (`seqRef.current = 0;` ~436): add `setOlder({ has: false, seq: null, from: null, loading: false });`

In `fetchOnce` (~522): the initial load requests a tail, polls don't:

```ts
        const first = seqRef.current === 0;
        const t = await api.transcript(sessionId, seqRef.current, first ? { tail: TAIL_TURNS } : undefined);
        if (!live) return;
        const held = staleTurns.current;
        staleTurns.current = false;
        setTurns((prev) => mergeDelta(held ? [] : prev, t));
        seqRef.current = t.next_cursor;
        if (first && t.has_older !== undefined)
          setOlder({ has: !!t.has_older, seq: t.oldest_seq ?? null, from: t.tail_from ?? null, loading: false });
```

Add `loadOlder` after the fetch effect:

```ts
  const loadOlder = useCallback(async () => {
    const o = olderRef.current;
    if (!sessionId || !o.has || o.loading || o.seq == null) return;
    setOlder({ ...o, loading: true });
    try {
      const t = await api.transcript(sessionId, 0, { tail: TAIL_TURNS, before: o.seq });
      setTurns((prev) => mergeDelta(prev, t));   // whole older turns fill their empty slots
      // seqRef untouched on purpose: next_cursor here is not a forward delta marker.
      setOlder({ has: !!t.has_older, seq: t.oldest_seq ?? o.seq,
                 from: t.tail_from ?? null, loading: false });
    } catch { setOlder({ ...olderRef.current, loading: false }); }
  }, [sessionId]);
```

- [ ] **Step 3: Plumb through Terminal into Transcript**

Terminal gains passthrough props `hasOlder?: boolean; olderLoading?: boolean; onLoadOlder?: () => void; renderFrom?: string | null` and forwards them to `<Transcript ...>` (line ~295). App passes `hasOlder={older.has} olderLoading={older.loading} onLoadOlder={loadOlder} renderFrom={older.from}` at the `<Terminal ...>` call (~1630).

- [ ] **Step 4: Transcript renders the cut + the button**

In `Transcript`, before mapping: `const visible = renderFrom ? turns.slice(Math.max(0, turns.findIndex((t) => t.id === renderFrom))) : turns;` and map over `visible` (keep `isLast` computed against `visible`). Above the list:

```tsx
      {hasOlder && (
        <div className="flex justify-center pb-1">
          <button type="button" onClick={onLoadOlder} disabled={olderLoading}
            className="border border-border px-3 py-1 text-[length:var(--t11)] tracking-[1px] text-muted-2 hover:text-foreground-bright disabled:opacity-50">
            {olderLoading ? "LOADING OLDER…" : "▲ LOAD OLDER TURNS"}
          </button>
        </div>
      )}
```

Why the cut: turns always ship whole (Task 3), so without it the unloaded turns would render as prompt bubbles with missing bodies — worse than absent. Known interim gap, fixed in Task 6: a checkpoint jump to a hidden turn is a silent no-op until jumps learn to auto-load.

Scroll position on prepend needs no new code in this task: the existing hand-rolled anchor correction in App's ResizeObserver puts the top-edge element back after content grows above (it exists for exactly this class of shift). It is replaced wholesale in Task 5.

- [ ] **Step 5: Build (= deploy) and verify against the OLD live server**

Run: `cd bridge/dashboard/web && npm run build`
Expected: tsc + vite clean. Live 8790 now runs the new frontend against old Python: open the median and big sessions with the probe (no throttle, just `settleMs`/`domNodes`) — behavior and numbers must match Task 0 baseline (old server sends no `has_older`, so no button, full render; `tail` param is ignored server-side).

- [ ] **Step 6: Verify the new path against 8791**

Full e2e of load-older needs the new Python serving the new dist. Start the 8791 throwaway (it serves this checkout's fresh `dist/`), then drive it with the probe's chrome — but **read-only**: navigate to `http://127.0.0.1:8791/?token=devtest&skipboot=1`, open the big session **by URL-driving the same flow as the probe script** (search + click); assert via `Runtime.evaluate`:
- initial turn count rendered < total turns and "LOAD OLDER TURNS" button present;
- clicking it grows the rendered turn count and eventually removes the button;
- `document.querySelectorAll('[id^="ck-"]').length` grows per click.
Caveat: the standalone server's other endpoints write to the real DB via `native.refresh` on `/local/sessions` (the app's session-list poll will hit it). That is the same idempotent upsert the live bridge does every 5s — acceptable; do not respond to permissions/prompts from this instance. Kill it when done.

- [ ] **Step 7: Commit**

```bash
git add bridge/dashboard/web/src/api.ts bridge/dashboard/web/src/App.tsx \
  bridge/dashboard/web/src/components/hud/Terminal.tsx bridge/dashboard/web/src/components/Transcript.tsx
git commit -m "feat(dashboard): open sessions at their tail, load older turns on demand"
```

---

### Task 5: virtualize the dashboard transcript (Layer 3)

**Files:**
- Modify: `bridge/dashboard/web/src/components/Transcript.tsx` (the rewrite)
- Modify: `bridge/dashboard/web/src/components/hud/Terminal.tsx` (pass `scrollRef`, `sessionKey`)
- Modify: `bridge/dashboard/web/src/App.tsx` (delete anchor-correction ~546-608, keep stick)
- Modify: `bridge/dashboard/web/src/components/ImageLightbox.tsx` (portal)
- Modify: `docs/superpowers/specs/2026-08-12-transcript-virtualization-design.md` (record turn-granularity deviation)

**Interfaces:**
- Consumes: Task 4's Transcript props; `scrollRef: RefObject<HTMLDivElement | null>` (Terminal's scroller div, the `mscroll` at Terminal ~288).
- Produces: rows model `type Row = { kind: "turn"; turn: Turn } | { kind: "working" }`; `getItemKey` = `turn.id` / `"__working"`; Transcript prop `sessionKey?: string | null`. Task 6 relies on the virtualizer instance and row indexing living in Transcript.

- [ ] **Step 1: ImageLightbox becomes a portal**

In `ImageLightbox.tsx`: `import { createPortal } from "react-dom";` and wrap the returned backdrop div: `return createPortal(<div ...>...</div>, document.body);`. This detaches it from any transformed ancestor (react-virtual rows are `translateY`d, which would otherwise make `position: fixed` resolve against the row). Covers both call sites (Attachments in Transcript, image results in RunStream) since it's inside the component.

- [ ] **Step 2: Rewrite Transcript around useVirtualizer**

Keep `PromptBubble`, `Attachments`, `RuntimeBadge`, `AgentRail` exactly as they are. Extract the current per-turn JSX (the body of `turns.map`) into `TurnBlock({ turn, isActive, isLast, ... })` — unchanged markup, including `id={ckId(turn.id)}` and the `AgentRail` (a turn's rows stay together, so the rail needs no change). Then:

```tsx
type Row = { kind: "turn"; turn: Turn } | { kind: "working" };

export function Transcript({ turns, scrollRef, sessionKey, trailingWorking, renderFrom, ... }) {
  const visible = renderFrom ? turns.slice(...) : turns;          // from Task 4
  const rows = useMemo<Row[]>(() => {
    const r: Row[] = visible.map((turn) => ({ kind: "turn", turn }));
    if (trailingWorking) r.push({ kind: "working" });
    return r;
  }, [visible, trailingWorking]);

  // Heights survive unmount so a revisited turn is estimated exactly right —
  // the same "wrong only once" property content-visibility gave us, one level up.
  const sizesRef = useRef(new Map<string, number>());
  const keyOf = (r: Row) => (r.kind === "turn" ? r.turn.id : "__working");

  const [fullMount, setFullMount] = useState(false);              // ctrl-F escape hatch
  const fullRef = useRef(fullMount); fullRef.current = fullMount;
  useEffect(() => { setFullMount(false); }, [sessionKey]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f") {
        if (!fullRef.current) flushSync(() => setFullMount(true)); // DOM complete before find opens
      } else if (e.key === "Escape" && fullRef.current) setFullMount(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef?.current ?? null,
    getItemKey: (i) => keyOf(rows[i]),
    estimateSize: (i) => sizesRef.current.get(keyOf(rows[i]))
      ?? Math.min(20000, 80 + (rows[i].kind === "turn" ? rows[i].turn.events.length * 60 : 0)),
    overscan: 2,
    measureElement: (el) => {
      const h = el.getBoundingClientRect().height;
      const k = el.getAttribute("data-key");
      if (k) sizesRef.current.set(k, h);
      return h;
    },
    // A row above the viewport re-measuring (streamed content, image load) must
    // not slide what you're reading — mirror of the hand-rolled anchoring this replaces.
    shouldAdjustScrollPositionOnItemSizeChange: (item, _d, v) =>
      item.start < (v.scrollOffset ?? 0),
  });
```

Render: full-mount mode renders today's plain `flex flex-col gap-3` list (identical to current code); virtual mode renders the absolute rows. Row wrapper carries `data-key={keyOf(row)}` for the measurer, `pb-3` replacing the list gap:

```tsx
  if (!rows.length) return <RuneSpirit variant="block" />;
  if (fullMount) return <div className="flex flex-col gap-3">{/* today's map, verbatim */}</div>;
  return (
    <>
      {hasOlder && /* button from Task 4, above the virtual container */}
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const row = rows[vi.index];
          return (
            <div key={vi.key} data-index={vi.index} data-key={keyOf(row)}
                 ref={virtualizer.measureElement} className="pb-3"
                 style={{ position: "absolute", top: 0, left: 0, width: "100%",
                          transform: `translateY(${vi.start}px)` }}>
              {row.kind === "turn"
                ? <TurnBlock turn={row.turn} ... />
                : <WorkingIndicator hud={hud} />}
            </div>
          );
        })}
      </div>
    </>
  );
```

Replace the old header comment (the "not virtualized on purpose" block at ~150) with one recording the new deal: turns are virtualized, cards inside a turn still carry content-visibility, ctrl-F full-mounts, heights cached per turn id.

Notes for the implementer:
- `working` (the `isActive && running && !pending` indicator inside a turn) stays inside `TurnBlock` — only the *trailing* working row is a separate row.
- `lastPromptRef` attaches inside `TurnBlock` when `isLast` as today. Terminal's sticky-LAST peek watches that node (Terminal ~186); when the last turn is unmounted (scrolled far up) the peek must show — verify, and if its effect breaks on a null ref, gate it on `atBottom` as fallback.
- `flushSync` import from `react-dom`.
- Keep `.vskip-card` in RunStream untouched.

- [ ] **Step 3: Terminal passes scrollRef + sessionKey**

At Terminal ~295: `<Transcript ... scrollRef={scrollRef} sessionKey={sessionId} ...>` (both already in Terminal's props).

- [ ] **Step 4: App.tsx — delete the hand-rolled anchor correction**

In the effect at ~546-608: remove `anchor`/`anchorTop`/`markAnchor` and the `if (anchor?.isConnected) {...}` correction block inside the ResizeObserver; keep the scroll listener (`sync` minus `markAnchor()`), the `stickOnResize` re-check, and the stuck-branch `scrollTop = scrollHeight` (the virtualizer's total-size div keeps `scrollHeight` meaningful, so stick-to-bottom keeps working with zero changes — including during measurement settling after a session opens). Update the comment: anchoring now lives in `shouldAdjustScrollPositionOnItemSizeChange`.

- [ ] **Step 5: Build + probe**

`npm run build`, then probe live 8790 (old Python = full transcripts = worst case for the virtualizer, which is exactly what we want to measure):

```bash
node tools/transcript-probe.mjs "A1 AMS Dossier Data Analysis" "virt-1x"
THROTTLE=4 node tools/transcript-probe.mjs "A1 AMS Dossier Data Analysis" "virt-4x"
THROTTLE=4 node tools/transcript-probe.mjs "Staging UAT Test Scenarios" "virt-med-4x"
```

Targets (@4x, big session): `settleMs` < 1000, scroll `p50` < 50ms, `heapMB` < 30, `domNodes` < 8k (record actual if a mega-turn in view exceeds — expected acceptable). Median session must not regress. If scroll shows chunky hitches at turn boundaries (`worst` spikes), try `overscan: 1` vs `3` before considering event-level rows.

- [ ] **Step 6: Visual + behavioral spot-checks (CDP screenshots)**

- rail + diamond + spacing look as before (compare a screenshot against current production look);
- ctrl-F: dispatch a ctrl-F keydown via CDP, assert `document.querySelectorAll('[id^="ck-"]').length` jumps to all turns (full mount), Escape returns it;
- lightbox: click a thumbnail, assert the backdrop is a direct child of `document.body` and covers the viewport;
- stick: with a live/median session, load, assert parked at bottom; scroll up 2000px, assert position stable for 3s (no drift).

- [ ] **Step 7: Amend the spec + commit**

Append to the spec's Layer 3 section: "Implemented at turn granularity (rows = turns; RunStream and its content-visibility cards unchanged inside a row). Event-level rows remain the escalation if a single giant turn ever janks; measured result: [numbers from Step 5]."

```bash
git add bridge/dashboard/web/src bridge/dashboard/web/tools docs/superpowers/specs/2026-08-12-transcript-virtualization-design.md
git commit -m "feat(dashboard): virtualize the transcript at turn granularity

Rows are turns: RunStream and its content-visibility cards ride along
unchanged, heights are cached per turn id so estimates are wrong at most
once, and a row above the viewport re-measuring adjusts scroll instead of
sliding the view (replaces the hand-rolled anchor correction). Ctrl-F
full-mounts the list before the find bar opens; Escape returns it. The
lightbox portals to body so translateY'd rows can't capture its fixed
positioning. Probe: [fill measured numbers]"
```

---

### Task 6: checkpoint jumps + activeIndex through the virtualizer

**Files:**
- Modify: `bridge/dashboard/web/src/lib/checkpoints.ts` (Mark gains `turnId`, `subKey`)
- Modify: `bridge/dashboard/web/src/components/Transcript.tsx` (expose nav handle)
- Modify: `bridge/dashboard/web/src/components/hud/Checkpoints.tsx` (use it)
- Modify: `bridge/dashboard/web/src/components/hud/Terminal.tsx`, `App.tsx` (plumb navRef + onJump)

**Interfaces:**
- Produces:
```ts
export interface TranscriptNav {
  /** Scroll a turn's row into view; false = turn not in the rendered list (unloaded or unknown). */
  jumpToTurn: (turnId: string, subAnchorId?: string) => boolean;
  /** Row start offset in scroll coordinates, null when the turn isn't rendered. */
  turnTop: (turnId: string) => number | null;
}
```
- `Mark` gains `turnId: string; subKey?: string` (`marksOf` sets them where it builds each mark; `id` stays for the DOM path).
- App's `jumpToMark(m: Mark)` auto-loads older pages until the target turn is renderable.

- [ ] **Step 1: Extend `marksOf`**

In `lib/checkpoints.ts`, add `turnId: string; subKey?: string` to `Mark`; in `marksOf` set `turnId: t.id` on all three mark kinds and `subKey: e.request_id` / `subKey: steerKey(i)` on question/steer marks. (Additive — nothing reading `Mark` breaks.)

- [ ] **Step 2: Transcript exposes the nav handle**

Prop `navRef?: MutableRefObject<TranscriptNav | null>`. Inside, after the virtualizer:

```tsx
  useEffect(() => {
    if (!navRef) return;
    navRef.current = {
      jumpToTurn: (turnId, subAnchorId) => {
        if (fullRef.current) {                       // full-mount: plain DOM path
          const el = document.getElementById(subAnchorId ?? ckId(turnId));
          el?.scrollIntoView({ behavior: "smooth", block: "start" });
          return !!el;
        }
        const i = rows.findIndex((r) => r.kind === "turn" && r.turn.id === turnId);
        if (i < 0) return false;
        virtualizer.scrollToIndex(i, { align: "start" });
        if (subAnchorId) requestAnimationFrame(() => requestAnimationFrame(() => {
          document.getElementById(subAnchorId)?.scrollIntoView({ block: "start" });
        }));
        return true;
      },
      turnTop: (turnId) => {
        const i = rows.findIndex((r) => r.kind === "turn" && r.turn.id === turnId);
        if (i < 0) return null;
        const m = virtualizer.getMeasurements()[i];
        return m ? m.start : null;
      },
    };
    return () => { navRef.current = null; };
  }, [navRef, rows, virtualizer]);
```

- [ ] **Step 3: App orchestrates jump + auto-load**

```ts
  const transcriptNav = useRef<TranscriptNav | null>(null);
  const jumpToMark = useCallback(async (m: Mark) => {
    const sub = m.subKey ? ckId(m.turnId, m.subKey) : undefined;
    for (let i = 0; i < 200; i++) {                       // 200 pages ≫ max 34 turns
      if (transcriptNav.current?.jumpToTurn(m.turnId, sub)) return;
      if (!olderRef.current.has || olderRef.current.loading) return;
      await loadOlder();
    }
  }, [loadOlder]);
```

Pass `navRef={transcriptNav}` through Terminal to Transcript, and `onJump={jumpToMark}` + `nav={transcriptNav}` through Terminal to Checkpoints.

- [ ] **Step 4: Checkpoints uses nav with DOM fallback**

`jump` becomes a prop call: `props.onJump?.(m)` (fallback to the old `getElementById` path when the prop is absent). `activeIndex` per mark: prefer `nav.current?.turnTop(m.turnId)` compared against `scrollRef.current.scrollTop + 8` (both are scroll-coordinate offsets); fall back to the existing rect test when `turnTop` is null (full-mount, or not rendered).

- [ ] **Step 5: Build + CDP verify**

`npm run build`, then drive 8791 (new Python so tail is active): open the big session, open Checkpoints, click the OLDEST prompt mark; assert older pages auto-load (rendered turn count grows) and the scroller lands with that prompt at the top (elementFromPoint at the top edge is inside that turn's block). Click a question/steer mark; assert the sub-anchor lands at the top edge.

- [ ] **Step 6: Commit**

```bash
git add bridge/dashboard/web/src
git commit -m "feat(dashboard): checkpoint jumps ride the virtualizer and auto-load older turns"
```

---

### Task 7: Mini App port

**Files:**
- Modify: `bridge/miniapp/web/src/lib/chat.tsx` (tail + older state in the transcript query, ~229-360)
- Modify: `bridge/miniapp/web/src/lib/api.ts` (transcript fetcher + type — mirror Task 4 Step 1)
- Modify: `bridge/miniapp/web/src/routes/run.tsx` (virtualize; delete hand-rolled anchoring at ~47-90)
- Modify: `bridge/miniapp/web/src/components/ImageLightbox.tsx` (portal)
- Modify: `bridge/miniapp/web/src/components/CheckpointsSheet.tsx` (jump via nav + auto-load, ~100)

**Interfaces:**
- Consumes: the same HTTP contract (Task 3) and the same patterns proven in Tasks 4–6.
- Produces: `useChat()` additionally returns `{ hasOlder, olderLoading, loadOlder, renderFrom }`.

- [ ] **Step 1: lib/api.ts + lib/chat.tsx**

Mirror Task 4: type fields, `transcript(id, cursor, opts)`. In `useChat`'s transcript query (`queryKey: ["transcript", sessionId]`, seqRef cursor at ~229): pass `{ tail: 10 }` when `seqRef.current === 0`; capture `has_older`/`oldest_seq`/`tail_from` into state the same shape as App's `older`; expose `loadOlder` that fetches `{ tail: 10, before: seq }`, merges via the file's existing merge function, and never touches `seqRef`. Reset `older` where `seqRef.current = 0` happens (~268).

- [ ] **Step 2: routes/run.tsx — virtualize `turns.map` (~121)**

Same shape as Task 5: `Row` union, `TurnBlock` extraction of the current per-turn JSX, `useVirtualizer` with `getScrollElement: () => bottomRef.current?.closest("main") ?? null`, sizes cache, `shouldAdjustScrollPositionOnItemSizeChange` predicate, `pb` replacing list gap, trailing working row, load-older button above the container, `renderFrom` cut. **No ctrl-F / fullMount** (touch surface). Delete the `markAnchor`/anchor-correction part of the effect at ~47-90, keep `stickToBottom` + the parked-pull-down path (same reasoning as Task 5 Step 4).

- [ ] **Step 3: CheckpointsSheet + lightbox**

`CheckpointsSheet.tsx:100`: replace `document.getElementById(`turn-${m.turnId}`)?.scrollIntoView(...)` with an `onJump(m)` prop from run.tsx implementing jump + auto-load (same loop as Task 6 Step 3, against the run.tsx virtualizer's nav object — can be a local object, no need for the ref plumbing App needed if the sheet is rendered by run.tsx; check the render site and pass directly). Port the `createPortal` change to the miniapp `ImageLightbox.tsx`.

- [ ] **Step 4: Build + layout screenshot**

Run: `cd bridge/miniapp/web && npm run build` — tsc must be clean. Then the screenshot recipe (memory: `npm run preview -- --port <p>`, chrome-headless-shell at 390px wide) for a layout sanity check. Honest limit: outside Telegram the app renders empty states (auth-gated API), so data-driven behavior can't be verified headlessly — the pattern is the one proven on the dashboard, and the user checks on their phone after the next bridge restart.

- [ ] **Step 5: Commit**

```bash
git add bridge/miniapp/web/src
git commit -m "feat(miniapp): virtualized transcript with tail loading, ported from the dashboard"
```

---

### Task 8: final measurement, docs, memory

**Files:**
- Modify: `docs/superpowers/specs/2026-08-12-transcript-virtualization-design.md` (results table)
- Create: memory `transcript-virtualization-shipped.md` + MEMORY.md line

- [ ] **Step 1: Full suite + builds**

`python3 -m pytest tests/ -q` (baseline + new, nothing else red), both `npm run build`s clean.

- [ ] **Step 2: Final probe table**

Big + median sessions, 1x and 4x, against live 8790 (virtualizer vs full payload) and 8791 (full stack incl. tail+gzip). Append a "Measured result" table to the spec next to the baseline table.

- [ ] **Step 3: Memory**

Write `transcript-virtualization-shipped.md` (type: project): what shipped, the numbers, and the operational fact that **gzip + tail are dormant on the live bridge until the user restarts it** — the dashboard/miniapp frontends are live already and degrade gracefully meanwhile. Link [[dashboard-web-build-deploy]], [[bridge-child-session-sigkill]]. Add the MEMORY.md pointer line.

- [ ] **Step 4: Commit**

```bash
git add docs "$HOME/.claude/projects/-home-mhzrerfani-projects-mystical-assistant/memory" 2>/dev/null || git add docs
git commit -m "docs(spec): measured results for the virtualized transcript"
```

(Memory files live outside the repo — the git add above only picks up the spec; write the memory files with the Write tool regardless.)
