# Teacher Mode + Review Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a code-editing turn, auto-suggest 1–2 concepts to review (Keep/Skip cards on every surface), and give an on-demand Teacher view (Explain / Explain-back / Quiz / Exercise) over the kept items.

**Architecture:** One new `learning_items` table in the existing SQLite store, one new `bridge/learning.py` module (thin wrappers over `runner.run_blocking` for capture-extraction and teaching), capture rendered through the existing typed-event/card mechanism (`review_candidate` / `review_resolved` events), plus a Teacher view added in parallel to the Mini App (a `/teacher` route) and the dashboard (a TEACHER tab in `AnalyzeModal`). No new services, no scheduler.

**Tech Stack:** Python 3 stdlib (sqlite3, http.server, threading), `claude` CLI via `runner.run_blocking`; React 19 + Vite + TanStack Router (Mini App) and React 19 + Vite (dashboard), both Tailwind + the "Mystic" tokens.

## Global Constraints

- **Capture is best-effort and MUST NEVER block, delay, or error a user's turn.** All capture work runs in a `daemon=True` background thread and swallows every exception (logs to stderr).
- **Capture extraction uses Haiku** (`model="haiku"`), one-shot, sessionless.
- **`callback_data` ≤ 64 bytes** (Telegram limit). Use `rvw:k:<id>` / `rvw:s:<id>` (item id is a 32-char uuid hex → 38 bytes).
- **Owner scoping:** every learning endpoint checks `item["owner_id"] == chat_id` (Mini App) / `== chat` (dashboard) and returns 404 otherwise, mirroring the existing session-scoped endpoints.
- **Idempotent schema:** the new table is appended to `_SCHEMA` as `CREATE TABLE IF NOT EXISTS` (no migration needed on fresh or existing DBs).
- **Frontends are parallel, not shared:** components are duplicated across `bridge/miniapp/web` and `bridge/dashboard/web` (as `PermissionCard` already is). No shared package.
- **Frontend verification gate** (no unit harness): `pnpm -C <web> exec tsc -b` + `pnpm -C <web> build` must pass. Do NOT restart the bridge mid-session (dashboard/miniapp serve a prebuilt `web/dist`; rebuild via local bins — `pnpm build` can trip on esbuild, fall back to `npx vite build`).
- **Backend tests** run via `python tests/<file>.py` (also pytest-compatible). New test files reuse the header from `tests/test_bridge.py` (sys.path insert + `os.environ.setdefault(...)` before importing `bridge`, then `store.init()`).

---

## File Structure

**Create:**
- `bridge/learning.py` — capture-extraction (`propose_review_items`), teaching (`teach`), the post-turn hook (`capture_after_turn`), and the bot capture-card sender.
- `tests/test_learning_store.py` — store CRUD + status/mastery tests.
- `tests/test_learning.py` — extraction parsing/gating + capture-hook tests.
- `bridge/miniapp/web/src/components/ReviewCandidateCard.tsx`
- `bridge/miniapp/web/src/routes/teacher.tsx`
- `bridge/miniapp/web/src/components/TeacherView.tsx`
- `bridge/dashboard/web/src/components/ReviewCandidateCard.tsx`
- `bridge/dashboard/web/src/components/hud/TeacherTab.tsx`

**Modify:**
- `bridge/store.py` — table in `_SCHEMA` + 6 helper functions.
- `bridge/config.py` — `LEARNING_ENABLE` flag.
- `bridge/runner.py` — `run_blocking` gains `model=`; capture hook in `_run_streaming` finally + `handle_task`.
- `bridge/dispatch.py` — `rvw:` callback branch (+ ensure `store` imported).
- `bridge/miniapp/server.py` — 3 routes + handlers (+ import `learning`).
- `bridge/dashboard/server.py` — 3 routes in `_get_api`/`_post_api` (+ import `learning`).
- `bridge/miniapp/web/src/lib/api.ts` — `RunEvent` variants + 3 api methods.
- `bridge/miniapp/web/src/components/RunStream.tsx` — `review_candidate`/`review_resolved` handling + `onReviewResolve` prop.
- `bridge/miniapp/web/src/lib/chat.tsx` — settle-refetch after a turn completes + wire `onReviewResolve`.
- `bridge/miniapp/web/src/router.tsx` + `src/routes/root.tsx` — register the Teacher route + tab.
- `bridge/dashboard/web/src/api.ts` — `RunEvent` variants + 3 api methods.
- `bridge/dashboard/web/src/components/RunStream.tsx` — same event handling + prop.
- `bridge/dashboard/web/src/components/Transcript.tsx` + `src/App.tsx` — thread `onReviewResolve`.
- `bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx` — TEACHER tab.
- `README.md` — one Features bullet.

---

## Task 1: `learning_items` table + store helpers

**Files:**
- Modify: `bridge/store.py` (append to `_SCHEMA` near line 51; add helpers after the sessions/turns helpers)
- Test: `tests/test_learning_store.py`

**Interfaces:**
- Produces:
  - `add_learning_item(owner_id:int, project_path:str, title:str, *, session_id:str|None=None, source_turn_id:str|None=None, code_snippet:str="", why_it_matters:str="", status:str="candidate") -> dict`
  - `get_learning_item(item_id:str) -> dict|None`
  - `list_learning_items(owner_id:int, project_path:str|None=None, status:str="kept") -> list[dict]`
  - `set_learning_status(item_id:str, status:str) -> None`
  - `bump_mastery(item_id:str) -> None`
  - `append_learning_note(item_id:str, text:str) -> None`

- [ ] **Step 1: Write the failing test**

Create `tests/test_learning_store.py`:

```python
"""Unit tests for the learning_items store layer."""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ.setdefault("BASE_PATH", "/tmp")
os.environ.setdefault("BRIDGE_DB", os.path.join(tempfile.mkdtemp(), "t.db"))

from bridge import store  # noqa: E402

store.init()


def test_add_and_get_learning_item():
    it = store.add_learning_item(555, "/proj", "useMemo dependency array",
                                 session_id="s1", source_turn_id="t1",
                                 code_snippet="useMemo(() => x, [x])",
                                 why_it_matters="stale closures")
    assert it["id"]
    assert it["status"] == "candidate"
    assert it["mastery"] == 0
    got = store.get_learning_item(it["id"])
    assert got["title"] == "useMemo dependency array"
    assert got["owner_id"] == 555
    assert got["project_path"] == "/proj"


def test_list_filters_by_owner_project_status():
    a = store.add_learning_item(700, "/p1", "A", status="kept")
    store.add_learning_item(700, "/p1", "B", status="candidate")   # wrong status
    store.add_learning_item(700, "/p2", "C", status="kept")        # wrong project
    store.add_learning_item(701, "/p1", "D", status="kept")        # wrong owner
    kept_p1 = store.list_learning_items(700, "/p1", status="kept")
    assert [i["title"] for i in kept_p1] == ["A"]
    assert a["id"] == kept_p1[0]["id"]
    # project_path=None → all projects for that owner+status
    all_kept = store.list_learning_items(700, None, status="kept")
    assert {i["title"] for i in all_kept} == {"A", "C"}


def test_status_transition_and_mastery():
    it = store.add_learning_item(555, "/proj", "closures")
    store.set_learning_status(it["id"], "kept")
    assert store.get_learning_item(it["id"])["status"] == "kept"
    store.bump_mastery(it["id"])
    store.bump_mastery(it["id"])
    row = store.get_learning_item(it["id"])
    assert row["mastery"] == 2
    assert row["times_reviewed"] == 2
    assert row["last_reviewed_at"] is not None


def test_append_note():
    it = store.add_learning_item(555, "/proj", "generics")
    store.append_learning_note(it["id"], "you confused T with any")
    assert "you confused T with any" in store.get_learning_item(it["id"])["notes"]


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok {name}")
    print("all passed")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python tests/test_learning_store.py`
Expected: FAIL with `AttributeError: module 'bridge.store' has no attribute 'add_learning_item'`

- [ ] **Step 3: Add the table to `_SCHEMA`**

In `bridge/store.py`, inside the `_SCHEMA = """ ... """` string, after the `events` table block (right before the closing `"""` at line ~59), add:

```sql
CREATE TABLE IF NOT EXISTS learning_items (
  id               TEXT PRIMARY KEY,
  owner_id         INTEGER NOT NULL,
  project_path     TEXT NOT NULL,
  session_id       TEXT,
  source_turn_id   TEXT,
  title            TEXT NOT NULL,
  code_snippet     TEXT NOT NULL DEFAULT '',
  why_it_matters   TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'candidate',
  mastery          INTEGER NOT NULL DEFAULT 0,
  times_reviewed   INTEGER NOT NULL DEFAULT 0,
  created_at       REAL NOT NULL,
  last_reviewed_at REAL,
  notes            TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_learning_owner
  ON learning_items(owner_id, project_path, status, created_at);
```

- [ ] **Step 4: Add the helper functions**

In `bridge/store.py`, after the session helpers (e.g. after `set_title`, before the events helpers), add. `uuid`, `time`, `json`, and `closing` are already imported at the top of the file:

```python
# --- learning items ---------------------------------------------------------

def add_learning_item(owner_id: int, project_path: str, title: str, *,
                      session_id: str | None = None, source_turn_id: str | None = None,
                      code_snippet: str = "", why_it_matters: str = "",
                      status: str = "candidate") -> dict:
    iid = uuid.uuid4().hex
    now = time.time()
    with closing(_connect()) as c:
        c.execute(
            "INSERT INTO learning_items(id,owner_id,project_path,session_id,"
            "source_turn_id,title,code_snippet,why_it_matters,status,mastery,"
            "times_reviewed,created_at,last_reviewed_at,notes) "
            "VALUES(?,?,?,?,?,?,?,?,?,0,0,?,NULL,'')",
            (iid, owner_id, project_path, session_id, source_turn_id, title,
             code_snippet, why_it_matters, status, now))
    return get_learning_item(iid)


def get_learning_item(item_id: str) -> dict | None:
    with closing(_connect()) as c:
        return _row(c.execute("SELECT * FROM learning_items WHERE id=?",
                              (item_id,)).fetchone())


def list_learning_items(owner_id: int, project_path: str | None = None,
                        status: str = "kept") -> list[dict]:
    q = "SELECT * FROM learning_items WHERE owner_id=? AND status=?"
    params: list = [owner_id, status]
    if project_path is not None:
        q += " AND project_path=?"
        params.append(project_path)
    q += " ORDER BY created_at DESC"
    with closing(_connect()) as c:
        return [dict(r) for r in c.execute(q, params).fetchall()]


def set_learning_status(item_id: str, status: str) -> None:
    with closing(_connect()) as c:
        c.execute("UPDATE learning_items SET status=? WHERE id=?", (status, item_id))


def bump_mastery(item_id: str) -> None:
    with closing(_connect()) as c:
        c.execute("UPDATE learning_items SET mastery=mastery+1,"
                  "times_reviewed=times_reviewed+1,last_reviewed_at=? WHERE id=?",
                  (time.time(), item_id))


def append_learning_note(item_id: str, text: str) -> None:
    if not text:
        return
    with closing(_connect()) as c:
        c.execute("UPDATE learning_items SET notes=notes||? WHERE id=?",
                  ("\n" + text, item_id))
```

- [ ] **Step 5: Run test to verify it passes**

Run: `python tests/test_learning_store.py`
Expected: `all passed`

- [ ] **Step 6: Commit**

```bash
git add bridge/store.py tests/test_learning_store.py
git commit -m "feat(store): learning_items table + CRUD helpers"
```

---

## Task 2: `run_blocking` model param + `bridge/learning.py` (extraction + teaching)

**Files:**
- Modify: `bridge/runner.py:116-118` (add `model=` param)
- Create: `bridge/learning.py`
- Test: `tests/test_learning.py`

**Interfaces:**
- Consumes: `runner.run_blocking`, `store.*` (Task 1), `config.LEARNING_ENABLE` (Task 6 — default via `getattr` until then).
- Produces:
  - `learning.propose_review_items(owner_id:int, project_path:str, assistant_text:str, edits_summary:str, *, edited:bool|None) -> list[dict]` (each `{title, snippet, why_it_matters}`, ≤2, never raises)
  - `learning.teach(item:dict, mode:str, *, user_answer:str|None=None) -> str` (mode ∈ `explain|quiz|exercise|grade`)
  - `learning._parse_candidates(raw:str) -> list[dict]`
  - `learning.EDIT_TOOLS = {"Edit", "Write", "MultiEdit"}`

- [ ] **Step 1: Write the failing test**

Create `tests/test_learning.py`:

```python
"""Unit tests for capture extraction parsing, gating, and teaching prompts."""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ.setdefault("BASE_PATH", "/tmp")
os.environ.setdefault("BRIDGE_DB", os.path.join(tempfile.mkdtemp(), "t.db"))

from bridge import config, learning, runner, store  # noqa: E402

store.init()


def _fake_run(result):
    """Return a run_blocking stand-in yielding `result` as the text field."""
    def _f(chat_id, prompt, resume_id=None, cwd=None, timeout=None, model=None):
        _f.last_prompt = prompt
        _f.last_model = model
        return (result, None, None, False)
    return _f


def test_parse_candidates_valid_and_capped():
    raw = ('[{"title":"A","snippet":"a()","why_it_matters":"x"},'
           '{"title":"B","snippet":"","why_it_matters":"y"},'
           '{"title":"C","snippet":"","why_it_matters":"z"}]')
    out = learning._parse_candidates(raw)
    assert [c["title"] for c in out] == ["A", "B"]   # capped at 2


def test_parse_candidates_strips_fences():
    raw = "```json\n[{\"title\":\"A\",\"why_it_matters\":\"x\"}]\n```"
    out = learning._parse_candidates(raw)
    assert out and out[0]["title"] == "A"
    assert out[0]["snippet"] == ""            # missing key → default ""


def test_parse_candidates_malformed_returns_empty():
    assert learning._parse_candidates("not json at all") == []
    assert learning._parse_candidates('{"title":"x"}') == []   # object, not list
    assert learning._parse_candidates('[{"snippet":"a"}]') == []  # no title


def test_propose_gated_off_by_flag():
    orig = config.LEARNING_ENABLE
    config.LEARNING_ENABLE = False
    try:
        assert learning.propose_review_items(555, "/p", "wrote code", "", edited=True) == []
    finally:
        config.LEARNING_ENABLE = orig


def test_propose_returns_parsed(monkeypatch=None):
    orig = runner.run_blocking
    runner.run_blocking = _fake_run('[{"title":"T","snippet":"s","why_it_matters":"w"}]')
    try:
        out = learning.propose_review_items(555, "/p", "assistant text", "Edit file.py",
                                            edited=True)
        assert out == [{"title": "T", "snippet": "s", "why_it_matters": "w"}]
        assert runner.run_blocking.last_model == "haiku"
    finally:
        runner.run_blocking = orig


def test_teach_builds_mode_prompt_and_returns_text():
    orig = runner.run_blocking
    runner.run_blocking = _fake_run("Here is the explanation.")
    try:
        item = {"owner_id": 555, "project_path": "/p", "title": "closures",
                "code_snippet": "() => x", "why_it_matters": "captures x"}
        out = learning.teach(item, "explain")
        assert out == "Here is the explanation."
        assert "closures" in runner.run_blocking.last_prompt
        # grade mode threads the user answer into the prompt
        learning.teach(item, "grade", user_answer="it remembers variables")
        assert "it remembers variables" in runner.run_blocking.last_prompt
        assert learning.teach(item, "bogus") == ""    # unknown mode
    finally:
        runner.run_blocking = orig


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok {name}")
    print("all passed")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python tests/test_learning.py`
Expected: FAIL with `ModuleNotFoundError: No module named 'bridge.learning'`

- [ ] **Step 3: Add `model=` to `run_blocking`**

In `bridge/runner.py`, change the signature (line 116) and the `_base_cmd` call (line 117):

```python
def run_blocking(chat_id: int, prompt: str, resume_id: str | None = None,
                 cwd: str | None = None, timeout: int | None = None,
                 model: str | None = None):
    cmd = _base_cmd(prompt, chat_id, stream=False, claude_session_id=resume_id,
                    model=model)
```

(`_base_cmd` already accepts `model=` and maps it to `--model`.)

- [ ] **Step 4: Create `bridge/learning.py` (extraction + teaching only)**

```python
"""Teacher mode: propose review candidates after code turns, and generate
on-demand teaching content. Every Claude call goes through runner.run_blocking.
Capture is best-effort — nothing here may raise into the turn lifecycle."""
import json
import sys

from bridge import config, runner, store

EDIT_TOOLS = {"Edit", "Write", "MultiEdit"}

_EXTRACT_SYS = (
    "You are a learning coach reviewing a coding assistant's work. From the "
    "assistant output below, identify AT MOST 2 concepts or code patterns the "
    "developer likely accepted WITHOUT fully understanding and should review "
    "later. If the work did not involve writing or changing code, or nothing is "
    "worth reviewing, return an empty array. Respond with ONLY a JSON array of "
    'objects, each exactly {"title": short concept name, "snippet": smallest '
    'relevant code excerpt (may be ""), "why_it_matters": one sentence}. '
    "No prose, no markdown fences."
)


def _parse_candidates(raw: str) -> list[dict]:
    s = (raw or "").strip()
    if s.startswith("```"):
        s = s.strip("`")
        nl = s.find("\n")
        if nl != -1:
            s = s[nl + 1:]
        s = s.strip()
    try:
        data = json.loads(s)
    except (ValueError, json.JSONDecodeError):
        return []
    if not isinstance(data, list):
        return []
    out: list[dict] = []
    for d in data:
        if isinstance(d, dict) and isinstance(d.get("title"), str) and d["title"].strip():
            out.append({"title": d["title"].strip(),
                        "snippet": str(d.get("snippet") or ""),
                        "why_it_matters": str(d.get("why_it_matters") or "")})
        if len(out) >= 2:
            break
    return out


def propose_review_items(owner_id: int, project_path: str, assistant_text: str,
                         edits_summary: str, *, edited: bool | None) -> list[dict]:
    if not getattr(config, "LEARNING_ENABLE", True):
        return []
    if not (assistant_text or edits_summary):
        return []
    gate = "" if edited else ("\nNOTE: it is UNKNOWN whether code changed; return "
                              "[] unless code was clearly written or edited.")
    prompt = (f"{_EXTRACT_SYS}{gate}\n\n=== ASSISTANT OUTPUT ===\n{assistant_text}\n\n"
              f"=== EDITS ===\n{edits_summary}")
    try:
        text, _sid, _cost, is_error = runner.run_blocking(
            owner_id, prompt, cwd=project_path or None, timeout=60, model="haiku")
    except Exception as e:  # noqa: BLE001
        print(f"[learning] extract call failed: {e}", file=sys.stderr)
        return []
    return [] if is_error else _parse_candidates(text)


def teach(item: dict, mode: str, *, user_answer: str | None = None) -> str:
    ctx = (f"Concept: {item.get('title', '')}\n"
           f"Why it matters: {item.get('why_it_matters', '')}\n"
           f"Code:\n{item.get('code_snippet', '')}")
    if mode == "explain":
        prompt = ("Explain this concept clearly to a developer who accepted it "
                  "without fully understanding it. Cover what it does, why it is "
                  "written this way, and one common alternative with its tradeoff. "
                  f"Be concise.\n\n{ctx}")
    elif mode == "quiz":
        prompt = ("Ask ONE focused question that tests whether the developer "
                  f"understands this concept. Output only the question.\n\n{ctx}")
    elif mode == "exercise":
        prompt = ("Give ONE small by-hand exercise (~15 minutes max) that builds "
                  f"intuition for this concept. Output the task only.\n\n{ctx}")
    elif mode == "grade":
        prompt = ("The developer was asked to explain the concept below in their "
                  "own words. Grade their understanding: name what is correct, what "
                  "is missing or wrong, and the one thing to remember. Be direct and "
                  f"brief.\n\n{ctx}\n\n=== THEIR ANSWER ===\n{user_answer or ''}")
    else:
        return ""
    try:
        text, _sid, _cost, is_error = runner.run_blocking(
            item["owner_id"], prompt, cwd=item.get("project_path") or None, timeout=120)
    except Exception as e:  # noqa: BLE001
        print(f"[learning] teach call failed: {e}", file=sys.stderr)
        return ""
    return "" if is_error else (text or "")
```

- [ ] **Step 5: Run test to verify it passes**

Run: `python tests/test_learning.py`
Expected: `all passed`

- [ ] **Step 6: Commit**

```bash
git add bridge/runner.py bridge/learning.py tests/test_learning.py
git commit -m "feat(learning): capture extraction + teaching prompt builders"
```

---

## Task 3: `capture_after_turn` hook + wire into runner

**Files:**
- Modify: `bridge/learning.py` (add `capture_after_turn` + `_send_bot_candidate_card`)
- Modify: `bridge/runner.py` (`_run_streaming` finally ~line 679; `handle_task` ~line 161)
- Test: `tests/test_learning.py` (add cases)

**Interfaces:**
- Consumes: `store.transcript`, `store.get_session`, `store.add_learning_item`, `store.append_event`, `propose_review_items`, `telegram.send`.
- Produces: `learning.capture_after_turn(chat_id:int, session:dict, turn_id:str, *, tool_visibility:bool) -> None` (never raises).

- [ ] **Step 1: Write the failing test**

Append to `tests/test_learning.py` (before the `__main__` block):

```python
def test_capture_streaming_creates_item_and_event():
    orig = learning.propose_review_items
    learning.propose_review_items = lambda *a, **k: [
        {"title": "closures", "snippet": "() => x", "why_it_matters": "captures x"}]
    try:
        sess = store.create_session(4242, "/capproj")
        store.start_turn(sess["id"], "turn1", "do the thing", [])
        store.append_event(sess["id"], "turn1", {"type": "text", "text": "I edited it."})
        store.append_event(sess["id"], "turn1", {"type": "tool", "name": "Edit",
                                                 "summary": "file.py"})
        learning.capture_after_turn(4242, sess, "turn1", tool_visibility=True)
        items = store.list_learning_items(4242, "/capproj", status="candidate")
        assert len(items) == 1 and items[0]["title"] == "closures"
        evs = [e for e in store.transcript(sess["id"])["events"]
               if e.get("type") == "review_candidate"]
        assert len(evs) == 1 and evs[0]["title"] == "closures"
    finally:
        learning.propose_review_items = orig


def test_capture_streaming_skips_when_no_edit_tool():
    called = {"n": 0}
    orig = learning.propose_review_items
    def _spy(*a, **k):
        called["n"] += 1
        return []
    learning.propose_review_items = _spy
    try:
        sess = store.create_session(4243, "/capproj2")
        store.start_turn(sess["id"], "turn1", "just a question", [])
        store.append_event(sess["id"], "turn1", {"type": "text", "text": "no edits"})
        learning.capture_after_turn(4243, sess, "turn1", tool_visibility=True)
        assert called["n"] == 0        # no Edit/Write tool → extractor never called
    finally:
        learning.propose_review_items = orig
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python tests/test_learning.py`
Expected: FAIL with `AttributeError: module 'bridge.learning' has no attribute 'capture_after_turn'`

- [ ] **Step 3: Add `capture_after_turn` + bot card sender to `bridge/learning.py`**

Append to `bridge/learning.py`:

```python
def capture_after_turn(chat_id: int, session: dict, turn_id: str, *,
                       tool_visibility: bool) -> None:
    """Best-effort: propose review candidates for a finished turn. Streaming
    surfaces set tool_visibility=True (we can trust the absence of Edit/Write to
    mean 'no code change'); the bot sets False (unknown — the extractor decides)."""
    try:
        if not getattr(config, "LEARNING_ENABLE", True):
            return
        evs = [e for e in store.transcript(session["id"])["events"]
               if e.get("turn_id") == turn_id]
        edited_tools = [e for e in evs
                        if e.get("type") == "tool" and e.get("name") in EDIT_TOOLS]
        edited = bool(edited_tools)
        if tool_visibility and not edited:
            return
        texts = [e["text"] for e in evs if e.get("type") == "text" and e.get("text")]
        if not texts:
            texts = [e.get("result", "") for e in evs if e.get("type") == "result"]
        assistant_text = "\n\n".join(t for t in texts if t)[:6000]
        edits_summary = "\n".join(e.get("summary", "") for e in edited_tools)[:2000]
        cands = propose_review_items(chat_id, session["project"], assistant_text,
                                     edits_summary,
                                     edited=(edited if tool_visibility else None))
        for c in cands:
            item = store.add_learning_item(
                chat_id, session["project"], c["title"], session_id=session["id"],
                source_turn_id=turn_id, code_snippet=c["snippet"],
                why_it_matters=c["why_it_matters"], status="candidate")
            if tool_visibility:
                store.append_event(session["id"], turn_id, {
                    "type": "review_candidate", "item_id": item["id"],
                    "title": item["title"], "why_it_matters": item["why_it_matters"],
                    "snippet": item["code_snippet"]})
            else:
                _send_bot_candidate_card(chat_id, item)
    except Exception as e:  # noqa: BLE001
        print(f"[learning] capture failed: {e}", file=sys.stderr)


def _send_bot_candidate_card(chat_id: int, item: dict) -> None:
    from bridge import telegram  # local import: avoid import cycles at module load
    text = "📚 Review later?\n" + item["title"]
    if item["why_it_matters"]:
        text += "\n" + item["why_it_matters"]
    kb = {"inline_keyboard": [[
        {"text": "✅ Keep", "callback_data": f"rvw:k:{item['id']}"},
        {"text": "✖ Skip", "callback_data": f"rvw:s:{item['id']}"}]]}
    telegram.send(chat_id, text, reply_markup=kb)
```

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `python tests/test_learning.py`
Expected: `all passed`

- [ ] **Step 5: Wire capture into the streaming path**

In `bridge/runner.py`, in the `_run_streaming` `finally` block, replace the final two lines (line ~678-679):

```python
        if not job.interrupted:
            notify_turn_done(job.chat_id, job.store_session_id, job.status == "error")
```

with:

```python
        if not job.interrupted:
            notify_turn_done(job.chat_id, job.store_session_id, job.status == "error")
        # Teacher-mode capture (best-effort, background thread). Streaming has
        # tool visibility, so we trust Edit/Write detection.
        if job.store_session_id and job.status == "done":
            _sess = store.get_session(job.store_session_id)
            if _sess:
                from bridge import learning  # local import: runner<->learning cycle
                threading.Thread(target=learning.capture_after_turn,
                                 args=(job.chat_id, _sess, job.id),
                                 kwargs={"tool_visibility": True},
                                 daemon=True).start()
```

- [ ] **Step 6: Wire capture into the bot path**

In `bridge/runner.py`, in `handle_task`, after the final `send(chat_id, ...)` (line ~161) and before the `finally:`, add:

```python
        if not is_error:
            from bridge import learning  # local import: runner<->learning cycle
            threading.Thread(target=learning.capture_after_turn,
                             args=(chat_id, session, job_id),
                             kwargs={"tool_visibility": False},
                             daemon=True).start()
```

- [ ] **Step 7: Run the full backend suite**

Run: `python tests/test_learning.py && python tests/test_learning_store.py && python tests/test_bridge.py`
Expected: each prints `all passed` / existing suite passes (no import errors from the runner edits).

- [ ] **Step 8: Commit**

```bash
git add bridge/learning.py bridge/runner.py tests/test_learning.py
git commit -m "feat(learning): capture_after_turn hook wired into streaming + bot paths"
```

---

## Task 4: `LEARNING_ENABLE` config flag

**Files:**
- Modify: `bridge/config.py` (near `MINIAPP_ENABLE`, line ~89)

- [ ] **Step 1: Add the flag**

In `bridge/config.py`, after the `MINIAPP_ENABLE = ...` line, add:

```python
# Teacher mode: auto-suggest review candidates after code turns. Default on.
LEARNING_ENABLE = os.environ.get("LEARNING_ENABLE", "1").lower() \
    not in ("0", "false", "no", "")
```

- [ ] **Step 2: Verify import + default**

Run: `python -c "from bridge import config; print(config.LEARNING_ENABLE)"`
Expected: `True`

- [ ] **Step 3: Commit**

```bash
git add bridge/config.py
git commit -m "feat(config): LEARNING_ENABLE flag (default on)"
```

---

## Task 5: Bot Keep/Skip callback

**Files:**
- Modify: `bridge/dispatch.py` (`handle_callback`, before the final `else:` ~line 150)

**Interfaces:**
- Consumes: `store.set_learning_status`, `store.get_learning_item`, `answer_cb`, `edit` (already in scope in `dispatch.py`).

- [ ] **Step 1: Ensure `store` is imported**

Check the imports at the top of `bridge/dispatch.py`. If `store` is not imported, add `from bridge import store` alongside the existing `from bridge import ...` line.

Run: `grep -n "import store\|from bridge import" bridge/dispatch.py | head`
Expected: confirm `store` is importable (add it if absent).

- [ ] **Step 2: Add the `rvw:` branch**

In `bridge/dispatch.py`, inside `handle_callback`, immediately before the final `else:` clause (the one that does a bare `answer_cb(cb["id"])`), add:

```python
    elif data.startswith("rvw:"):
        parts = data.split(":", 2)
        if len(parts) == 3:
            _, action, item_id = parts
            store.set_learning_status(item_id, "kept" if action == "k" else "skipped")
            item = store.get_learning_item(item_id)
            answer_cb(cb["id"], "Kept ✅" if action == "k" else "Skipped")
            label = "✅ Kept for review" if action == "k" else "✖ Skipped"
            edit(chat_id, msg_id, f"{label}: {item['title'] if item else ''}")
        else:
            answer_cb(cb["id"])
```

- [ ] **Step 3: Verify it imports and parses**

Run:
```bash
python -c "import ast; ast.parse(open('bridge/dispatch.py').read()); print('ok')"
```
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add bridge/dispatch.py
git commit -m "feat(bot): Keep/Skip callback for review candidates"
```

---

## Task 6: Mini App backend routes

**Files:**
- Modify: `bridge/miniapp/server.py` (imports; `do_GET` ~line 196; `do_POST` ~line 249; add 3 handler methods)

**Interfaces:**
- Produces (HTTP): `GET /api/learning/items?project=<p>` → `{items:[...]}`; `POST /api/learning/item {item_id, action}` → `{ok:true}`; `POST /api/learning/teach {item_id, mode, user_answer?}` → `{text}`.

- [ ] **Step 1: Import `learning`**

In `bridge/miniapp/server.py`, add `learning` to the existing `from bridge import ...` import line (which already lists `store, runner, ...`).

- [ ] **Step 2: Add GET route**

In `do_GET`, after the `if path == "/api/sessions":` block (before the `if path.startswith("/api/sessions/"):` line), add:

```python
            if path == "/api/learning/items":
                return self._api_learning_items(chat_id, qs)
```

- [ ] **Step 3: Add POST routes**

In `do_POST`, after the `if path == "/api/sessions":` block, add:

```python
        if path == "/api/learning/item":
            return self._api_learning_item(chat_id, body)
        if path == "/api/learning/teach":
            return self._api_learning_teach(chat_id, body)
```

- [ ] **Step 4: Add the handler methods**

Add these methods to the request-handler class (near `_api_history`):

```python
    def _api_learning_items(self, chat_id: int, qs):
        project = qs.get("project", [""])[0]
        self._json({"items": store.list_learning_items(
            chat_id, project or None, status="kept")})

    def _api_learning_item(self, chat_id: int, body: dict):
        item = store.get_learning_item((body.get("item_id") or "").strip())
        if not item or item["owner_id"] != chat_id:
            return self._json({"error": "not found"}, 404)
        action = body.get("action")
        if action in ("keep", "skip"):
            status = "kept" if action == "keep" else "skipped"
            store.set_learning_status(item["id"], status)
            if item["session_id"] and item["source_turn_id"]:
                store.append_event(item["session_id"], item["source_turn_id"],
                                   {"type": "review_resolved",
                                    "item_id": item["id"], "action": status})
        elif action == "archive":
            store.set_learning_status(item["id"], "archived")
        elif action == "reviewed":
            store.bump_mastery(item["id"])
        else:
            return self._json({"error": "bad action"}, 400)
        self._json({"ok": True})

    def _api_learning_teach(self, chat_id: int, body: dict):
        item = store.get_learning_item((body.get("item_id") or "").strip())
        if not item or item["owner_id"] != chat_id:
            return self._json({"error": "not found"}, 404)
        mode = body.get("mode")
        if mode not in ("explain", "quiz", "exercise", "grade"):
            return self._json({"error": "bad mode"}, 400)
        text = learning.teach(item, mode, user_answer=body.get("user_answer"))
        if mode == "grade":
            store.append_learning_note(item["id"], text)
        self._json({"text": text})
```

- [ ] **Step 5: Verify it imports and the routes exist**

Run:
```bash
python -c "import ast; ast.parse(open('bridge/miniapp/server.py').read()); print('ok')"
python tests/test_bridge.py
```
Expected: `ok`; existing Mini App server tests still pass.

- [ ] **Step 6: Commit**

```bash
git add bridge/miniapp/server.py
git commit -m "feat(miniapp): learning items/item/teach API routes"
```

---

## Task 7: Dashboard backend routes

**Files:**
- Modify: `bridge/dashboard/server.py` (imports; `_get_api`; `_post_api`)

**Interfaces:**
- Produces (HTTP): `GET /local/learning/items?project=<p>`; `POST /local/learning/item`; `POST /local/learning/teach` — same shapes as Task 6. `chat` is the owner id already in scope in `_get_api`/`_post_api`.

- [ ] **Step 1: Import `learning`**

In `bridge/dashboard/server.py`, add `learning` to the existing `from bridge import ...` line.

- [ ] **Step 2: Add GET route in `_get_api`**

In `_get_api`, alongside the other `if path == "/local/...":` branches, add:

```python
        if path == "/local/learning/items":
            project = qs.get("project", [""])[0]
            return self._json({"items": store.list_learning_items(
                chat, project or None, status="kept")})
```

- [ ] **Step 3: Add POST routes in `_post_api`**

In `_post_api`, alongside the other branches, add:

```python
        if path == "/local/learning/item":
            item = store.get_learning_item((body.get("item_id") or "").strip())
            if not item or item["owner_id"] != chat:
                return self._json({"error": "not found"}, 404)
            action = body.get("action")
            if action in ("keep", "skip"):
                status = "kept" if action == "keep" else "skipped"
                store.set_learning_status(item["id"], status)
                if item["session_id"] and item["source_turn_id"]:
                    store.append_event(item["session_id"], item["source_turn_id"],
                                       {"type": "review_resolved",
                                        "item_id": item["id"], "action": status})
            elif action == "archive":
                store.set_learning_status(item["id"], "archived")
            elif action == "reviewed":
                store.bump_mastery(item["id"])
            else:
                return self._json({"error": "bad action"}, 400)
            return self._json({"ok": True})
        if path == "/local/learning/teach":
            item = store.get_learning_item((body.get("item_id") or "").strip())
            if not item or item["owner_id"] != chat:
                return self._json({"error": "not found"}, 404)
            mode = body.get("mode")
            if mode not in ("explain", "quiz", "exercise", "grade"):
                return self._json({"error": "bad mode"}, 400)
            text = learning.teach(item, mode, user_answer=body.get("user_answer"))
            if mode == "grade":
                store.append_learning_note(item["id"], text)
            return self._json({"text": text})
```

- [ ] **Step 4: Verify it imports**

Run:
```bash
python -c "import ast; ast.parse(open('bridge/dashboard/server.py').read()); print('ok')"
python tests/test_bridge.py
```
Expected: `ok`; existing dashboard server tests pass.

- [ ] **Step 5: Commit**

```bash
git add bridge/dashboard/server.py
git commit -m "feat(dashboard): learning items/item/teach API routes"
```

---

## Task 8: Mini App — ReviewCandidateCard + transcript wiring + api

**Files:**
- Create: `bridge/miniapp/web/src/components/ReviewCandidateCard.tsx`
- Modify: `bridge/miniapp/web/src/lib/api.ts` (RunEvent variants + 3 methods)
- Modify: `bridge/miniapp/web/src/components/RunStream.tsx`
- Modify: `bridge/miniapp/web/src/lib/chat.tsx` (settle-refetch + onReviewResolve)

**Interfaces:**
- Produces: `api.learningItems(project?)`, `api.learningItem(itemId, action)`, `api.learningTeach(body)`; `<ReviewCandidateCard>`.

- [ ] **Step 1: Create the card**

`bridge/miniapp/web/src/components/ReviewCandidateCard.tsx`:

```tsx
import { GraduationCap, Check, X } from "lucide-react";
import { Button, Card } from "./ui";

export function ReviewCandidateCard({
  title,
  whyItMatters,
  snippet,
  active,
  resolved,
  onKeep,
  onSkip,
}: {
  title: string;
  whyItMatters?: string;
  snippet?: string;
  active: boolean;
  resolved?: "kept" | "skipped";
  onKeep: () => void;
  onSkip: () => void;
}) {
  return (
    <Card className="space-y-2 border border-[var(--tg-button)]/30">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <GraduationCap size={15} className="shrink-0 text-[var(--brand-soft)]" aria-hidden />
        <span>
          Review later: <span className="font-semibold">{title}</span>?
        </span>
      </div>
      {whyItMatters && (
        <div className="text-xs text-[var(--tg-hint)]">{whyItMatters}</div>
      )}
      {snippet && (
        <pre className="overflow-x-auto rounded bg-black/20 p-2 font-mono text-xs text-[var(--tg-hint)]">
          {snippet}
        </pre>
      )}
      {active ? (
        <div className="flex gap-2">
          <Button className="flex-1" onClick={onKeep}>
            Keep
          </Button>
          <Button variant="secondary" className="flex-1" onClick={onSkip}>
            Skip
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-1 text-xs text-[var(--tg-hint)]">
          {resolved === "kept" ? (
            <>
              <Check size={13} className="text-green-400" aria-hidden /> Kept
            </>
          ) : resolved === "skipped" ? (
            <>
              <X size={13} className="text-red-400" aria-hidden /> Skipped
            </>
          ) : (
            "—"
          )}
        </div>
      )}
    </Card>
  );
}
```

- [ ] **Step 2: Add RunEvent variants + api methods**

In `bridge/miniapp/web/src/lib/api.ts`, find the `RunEvent` discriminated union (grep `type: "question"`). Add two variants next to the `permission`/`question` ones:

```ts
  | { type: "review_candidate"; item_id: string; title: string; why_it_matters: string; snippet: string }
  | { type: "review_resolved"; item_id: string; action: "kept" | "skipped" }
```

Then add to the `export const api = { ... }` object:

```ts
  learningItems: (project?: string) =>
    request<{ items: LearningItem[] }>(
      `/api/learning/items${project ? `?project=${encodeURIComponent(project)}` : ""}`,
    ),

  learningItem: (itemId: string, action: "keep" | "skip" | "archive" | "reviewed") =>
    request<{ ok: true }>("/api/learning/item", {
      method: "POST",
      body: { item_id: itemId, action },
    }),

  learningTeach: (body: {
    item_id: string;
    mode: "explain" | "quiz" | "exercise" | "grade";
    user_answer?: string;
  }) => request<{ text: string }>("/api/learning/teach", { method: "POST", body }),
```

And add the `LearningItem` type (near the other exported types):

```ts
export type LearningItem = {
  id: string;
  project_path: string;
  title: string;
  code_snippet: string;
  why_it_matters: string;
  status: string;
  mastery: number;
  times_reviewed: number;
  notes: string;
};
```

- [ ] **Step 3: Handle the events in RunStream**

In `bridge/miniapp/web/src/components/RunStream.tsx`:

Add the import at the top:
```ts
import { ReviewCandidateCard } from "./ReviewCandidateCard";
```

Extend the component props (add `onReviewResolve`):
```ts
export function RunStream({
  events,
  pending = [],
  onRespond,
  onReviewResolve,
}: {
  events: RunEvent[];
  pending?: PendingRequest[];
  onRespond?: RespondFn;
  onReviewResolve?: (itemId: string, action: "keep" | "skip") => void;
}) {
```

After the `qAnswered` map is built, add a resolved map:
```ts
  const reviewResolved = new Map<string, "kept" | "skipped">();
  for (const e of events) {
    if (e.type === "review_resolved") reviewResolved.set(e.item_id, e.action);
  }
```

Add two cases to the `switch (event.type)` (next to `case "permission":`):
```tsx
          case "review_candidate":
            return (
              <ReviewCandidateCard
                key={i}
                title={event.title}
                whyItMatters={event.why_it_matters}
                snippet={event.snippet}
                active={!!onReviewResolve && !reviewResolved.has(event.item_id)}
                resolved={reviewResolved.get(event.item_id)}
                onKeep={() => onReviewResolve?.(event.item_id, "keep")}
                onSkip={() => onReviewResolve?.(event.item_id, "skip")}
              />
            );
          case "review_resolved":
            return null; // reflected inside the candidate card
```

- [ ] **Step 4: Wire onReviewResolve + settle-refetch in chat.tsx**

In `bridge/miniapp/web/src/lib/chat.tsx`:

Ensure `useQueryClient` is imported from `@tanstack/react-query` and a `queryClient` is available (grep `useQueryClient` — add `const queryClient = useQueryClient();` in the provider if absent).

Add a handler (near where `onRespond`/`respond` is defined) and expose it through the same context/props the run page already consumes for `onRespond`:
```ts
  const handleReviewResolve = useCallback(
    (itemId: string, action: "keep" | "skip") => {
      void api.learningItem(itemId, action).then(() =>
        queryClient.invalidateQueries({ queryKey: ["transcript", sessionId] }),
      );
    },
    [queryClient, sessionId],
  );
```

Add a settle-refetch effect so trailing `review_candidate` events (appended a couple seconds after the turn ends) appear even though idle polling is paused:
```ts
  useEffect(() => {
    if (isRunning || sessionId === null) return;
    const t1 = setTimeout(
      () => queryClient.invalidateQueries({ queryKey: ["transcript", sessionId] }),
      2500,
    );
    const t2 = setTimeout(
      () => queryClient.invalidateQueries({ queryKey: ["transcript", sessionId] }),
      6000,
    );
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [isRunning, sessionId, queryClient]);
```

At the `<RunStream ... />` render site (grep `<RunStream` under `miniapp/web`), pass the new prop alongside `onRespond`:
```tsx
        onReviewResolve={handleReviewResolve}
```
(If `handleReviewResolve` is defined in `chat.tsx` but RunStream is rendered in `routes/run.tsx`, expose it via the same context value that already provides `onRespond`, then read it there.)

- [ ] **Step 5: Verify types + build**

Run:
```bash
pnpm -C bridge/miniapp/web exec tsc -b && pnpm -C bridge/miniapp/web build
```
Expected: typecheck + build succeed (if `pnpm build` fails on esbuild, run `pnpm -C bridge/miniapp/web exec vite build`).

- [ ] **Step 6: Commit**

```bash
git add bridge/miniapp/web/src
git commit -m "feat(miniapp): review candidate cards in transcript + learning api"
```

---

## Task 9: Mini App — Teacher route

**Files:**
- Create: `bridge/miniapp/web/src/components/TeacherView.tsx`
- Create: `bridge/miniapp/web/src/routes/teacher.tsx`
- Modify: `bridge/miniapp/web/src/router.tsx` (register route)
- Modify: `bridge/miniapp/web/src/routes/root.tsx` (nav tab)

- [ ] **Step 1: Create TeacherView**

`bridge/miniapp/web/src/components/TeacherView.tsx`:

```tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { GraduationCap } from "lucide-react";
import { api, type LearningItem } from "../lib/api";
import { Button, Card } from "./ui";
import { Markdown } from "./Markdown";

type Mode = "explain" | "quiz" | "exercise" | "grade";

export function TeacherView() {
  const { data } = useQuery({
    queryKey: ["learning-items"],
    queryFn: () => api.learningItems(),
    refetchInterval: 5000,
  });
  const items = data?.items ?? [];
  const [openId, setOpenId] = useState<string | null>(null);
  const open = items.find((i) => i.id === openId) ?? null;

  // group by project
  const groups = new Map<string, LearningItem[]>();
  for (const it of items) {
    const g = groups.get(it.project_path) ?? [];
    g.push(it);
    groups.set(it.project_path, g);
  }

  if (open) return <TeacherDetail item={open} onBack={() => setOpenId(null)} />;

  return (
    <div className="space-y-3 p-2">
      {items.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-[var(--tg-hint)]">
          <GraduationCap size={28} aria-hidden />
          Nothing to review yet. Keep a card after a code turn and it lands here.
        </div>
      )}
      {[...groups.entries()].map(([project, its]) => (
        <div key={project} className="space-y-1.5">
          <div className="font-mono text-xs text-[var(--tg-hint)]">
            {project.split("/").pop()}
          </div>
          {its.map((it) => (
            <button
              key={it.id}
              onClick={() => setOpenId(it.id)}
              className="flex w-full items-center gap-2 rounded-lg bg-[var(--tg-secondary-bg)] px-3 py-2 text-left"
            >
              <span className="flex-1 text-sm">{it.title}</span>
              <span className="text-xs text-[var(--brand-soft)]">
                {"●".repeat(Math.min(it.mastery, 3)) || "○"}
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function TeacherDetail({ item, onBack }: { item: LearningItem; onBack: () => void }) {
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState("");
  const [answer, setAnswer] = useState("");

  const run = async (mode: Mode, user_answer?: string) => {
    setBusy(true);
    setOutput("");
    try {
      const r = await api.learningTeach({ item_id: item.id, mode, user_answer });
      setOutput(r.text);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 p-2">
      <button onClick={onBack} className="text-xs text-[var(--tg-hint)]">
        ← back
      </button>
      <Card className="space-y-2">
        <div className="text-sm font-semibold">{item.title}</div>
        {item.why_it_matters && (
          <div className="text-xs text-[var(--tg-hint)]">{item.why_it_matters}</div>
        )}
        {item.code_snippet && (
          <pre className="overflow-x-auto rounded bg-black/20 p-2 font-mono text-xs text-[var(--tg-hint)]">
            {item.code_snippet}
          </pre>
        )}
      </Card>

      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => run("explain")}>
          Explain
        </Button>
        <Button disabled={busy} variant="secondary" onClick={() => run("quiz")}>
          Quiz me
        </Button>
        <Button disabled={busy} variant="secondary" onClick={() => run("exercise")}>
          Exercise
        </Button>
      </div>

      <div className="space-y-1.5">
        <textarea
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="Explain it back in your own words…"
          className="w-full rounded-lg bg-[var(--tg-secondary-bg)] p-2 text-sm outline-none"
          rows={3}
        />
        <Button
          disabled={busy || !answer.trim()}
          onClick={() => run("grade", answer)}
        >
          Grade my understanding
        </Button>
      </div>

      {busy && <div className="text-xs text-[var(--tg-hint)]">Thinking…</div>}
      {output && (
        <Card>
          <Markdown className="text-sm leading-relaxed">{output}</Markdown>
        </Card>
      )}

      <div className="flex gap-2">
        <Button variant="secondary" onClick={() => api.learningItem(item.id, "reviewed")}>
          Mark reviewed
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            void api.learningItem(item.id, "archive");
            onBack();
          }}
        >
          Archive
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create the route**

`bridge/miniapp/web/src/routes/teacher.tsx`:

```tsx
import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import { TeacherView } from "../components/TeacherView";

export const teacherRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/teacher",
  component: TeacherView,
});
```

- [ ] **Step 3: Register in router.tsx**

In `bridge/miniapp/web/src/router.tsx`, add the import and the child:

```ts
import { teacherRoute } from "./routes/teacher";
```
```ts
const routeTree = rootRoute.addChildren([
  runRoute,
  issuesRoute,
  serverRoute,
  shellRoute,
  previewRoute,
  designRoute,
  historyRoute,
  teacherRoute,
]);
```

- [ ] **Step 4: Add the nav tab in root.tsx**

In `bridge/miniapp/web/src/routes/root.tsx`, add `GraduationCap` to the `lucide-react` import, then add to the `tabs` array:

```ts
  { to: "/teacher", label: "Teacher", icon: GraduationCap },
```

- [ ] **Step 5: Verify types + build**

Run:
```bash
pnpm -C bridge/miniapp/web exec tsc -b && pnpm -C bridge/miniapp/web build
```
Expected: succeed.

- [ ] **Step 6: Commit**

```bash
git add bridge/miniapp/web/src
git commit -m "feat(miniapp): Teacher route (explain/quiz/exercise/grade)"
```

---

## Task 10: Dashboard — ReviewCandidateCard + transcript wiring + api

**Files:**
- Create: `bridge/dashboard/web/src/components/ReviewCandidateCard.tsx`
- Modify: `bridge/dashboard/web/src/api.ts`
- Modify: `bridge/dashboard/web/src/components/RunStream.tsx`
- Modify: `bridge/dashboard/web/src/components/Transcript.tsx`
- Modify: `bridge/dashboard/web/src/App.tsx`

- [ ] **Step 1: Create the card**

`bridge/dashboard/web/src/components/ReviewCandidateCard.tsx` — identical body to the Mini App card (Task 8 Step 1), copied here so the dashboard tree is self-contained:

```tsx
import { GraduationCap, Check, X } from "lucide-react";
import { Button, Card } from "./ui";

export function ReviewCandidateCard({
  title,
  whyItMatters,
  snippet,
  active,
  resolved,
  onKeep,
  onSkip,
}: {
  title: string;
  whyItMatters?: string;
  snippet?: string;
  active: boolean;
  resolved?: "kept" | "skipped";
  onKeep: () => void;
  onSkip: () => void;
}) {
  return (
    <Card className="space-y-2 border border-[var(--tg-button)]/30">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <GraduationCap size={15} className="shrink-0 text-[var(--brand-soft)]" aria-hidden />
        <span>
          Review later: <span className="font-semibold">{title}</span>?
        </span>
      </div>
      {whyItMatters && (
        <div className="text-xs text-[var(--tg-hint)]">{whyItMatters}</div>
      )}
      {snippet && (
        <pre className="overflow-x-auto rounded bg-black/20 p-2 font-mono text-xs text-[var(--tg-hint)]">
          {snippet}
        </pre>
      )}
      {active ? (
        <div className="flex gap-2">
          <Button className="flex-1" onClick={onKeep}>
            Keep
          </Button>
          <Button variant="secondary" className="flex-1" onClick={onSkip}>
            Skip
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-1 text-xs text-[var(--tg-hint)]">
          {resolved === "kept" ? (
            <>
              <Check size={13} className="text-green-400" aria-hidden /> Kept
            </>
          ) : resolved === "skipped" ? (
            <>
              <X size={13} className="text-red-400" aria-hidden /> Skipped
            </>
          ) : (
            "—"
          )}
        </div>
      )}
    </Card>
  );
}
```

- [ ] **Step 2: Add RunEvent variants + api methods**

In `bridge/dashboard/web/src/api.ts`, add to the `RunEvent` union (grep `type: "question"`):

```ts
  | { type: "review_candidate"; item_id: string; title: string; why_it_matters: string; snippet: string }
  | { type: "review_resolved"; item_id: string; action: "kept" | "skipped" }
```

Add the `LearningItem` type near the other exported types:
```ts
export type LearningItem = {
  id: string;
  project_path: string;
  title: string;
  code_snippet: string;
  why_it_matters: string;
  status: string;
  mastery: number;
  times_reviewed: number;
  notes: string;
};
```

Add to the `export const api = { ... }` object:
```ts
  learningItems: (project?: string) =>
    req<{ items: LearningItem[] }>(
      `/local/learning/items${project ? `?project=${encodeURIComponent(project)}` : ""}`,
    ),
  learningItem: (itemId: string, action: "keep" | "skip" | "archive" | "reviewed") =>
    req<{ ok: true }>("/local/learning/item", {
      method: "POST",
      body: { item_id: itemId, action },
    }),
  learningTeach: (body: {
    item_id: string;
    mode: "explain" | "quiz" | "exercise" | "grade";
    user_answer?: string;
  }) => req<{ text: string }>("/local/learning/teach", { method: "POST", body }),
```

- [ ] **Step 3: Handle events in RunStream (dashboard)**

In `bridge/dashboard/web/src/components/RunStream.tsx`:

Import:
```ts
import { ReviewCandidateCard } from "./ReviewCandidateCard";
```

Add `onReviewResolve` to props:
```ts
  onReviewResolve,
```
```ts
  onReviewResolve?: (itemId: string, action: "keep" | "skip") => void;
```

After the `qAnswered` map:
```ts
  const reviewResolved = new Map<string, "kept" | "skipped">();
  for (const e of events) {
    if (e.type === "review_resolved") reviewResolved.set(e.item_id, e.action);
  }
```

Add cases next to `case "permission":`:
```tsx
          case "review_candidate":
            return (
              <ReviewCandidateCard
                key={i}
                title={event.title}
                whyItMatters={event.why_it_matters}
                snippet={event.snippet}
                active={!!onReviewResolve && !reviewResolved.has(event.item_id)}
                resolved={reviewResolved.get(event.item_id)}
                onKeep={() => onReviewResolve?.(event.item_id, "keep")}
                onSkip={() => onReviewResolve?.(event.item_id, "skip")}
              />
            );
          case "review_resolved":
            return null;
```

- [ ] **Step 4: Thread the prop through Transcript**

In `bridge/dashboard/web/src/components/Transcript.tsx`, add `onReviewResolve` to the `Transcript` props (mirroring `onRespond`), and pass it into `<RunStream ... />`:

```ts
  onReviewResolve,
```
```ts
  onReviewResolve?: (itemId: string, action: "keep" | "skip") => void;
```
```tsx
              <RunStream
                events={turn.events}
                pending={turn.pending as PendingRequest[]}
                onRespond={isActive ? onRespond : undefined}
                onReviewResolve={onReviewResolve}
                animate={liveTurns?.has(turn.id) ?? false}
                turnId={turn.id}
              />
```

- [ ] **Step 5: Provide the handler in App.tsx**

In `bridge/dashboard/web/src/App.tsx`, define a handler (the continuous 1.5s poll already picks up the `review_resolved` event, so no manual invalidation is needed) and pass it to `<Transcript ... />`:

```tsx
  const onReviewResolve = (itemId: string, action: "keep" | "skip") => {
    void api.learningItem(itemId, action);
  };
```
Pass `onReviewResolve={onReviewResolve}` wherever `<Transcript ... onRespond={...} />` is rendered.

- [ ] **Step 6: Verify types + build**

Run:
```bash
pnpm -C bridge/dashboard/web exec tsc -b && pnpm -C bridge/dashboard/web build
```
Expected: succeed (fallback `pnpm -C bridge/dashboard/web exec vite build`).

- [ ] **Step 7: Commit**

```bash
git add bridge/dashboard/web/src
git commit -m "feat(dashboard): review candidate cards in transcript + learning api"
```

---

## Task 11: Dashboard — Teacher tab in AnalyzeModal

**Files:**
- Create: `bridge/dashboard/web/src/components/hud/TeacherTab.tsx`
- Modify: `bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx` (add `"teacher"` to the `Tab` type + `tabs` array + body render)

**Interfaces:**
- Consumes: `api.learningItems(project)`, `api.learningItem`, `api.learningTeach`. Project-scoped (AnalyzeModal has `project`).

- [ ] **Step 1: Create the tab component**

`bridge/dashboard/web/src/components/hud/TeacherTab.tsx`:

```tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type LearningItem } from "../../api";
import { Markdown } from "../Markdown";

type Mode = "explain" | "quiz" | "exercise" | "grade";

export function TeacherTab({ project }: { project: string }) {
  const { data } = useQuery({
    queryKey: ["learning-items", project],
    queryFn: () => api.learningItems(project),
    refetchInterval: 5000,
  });
  const items = data?.items ?? [];
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState("");
  const [answer, setAnswer] = useState("");
  const sel = items.find((i) => i.id === openId) ?? null;

  const run = async (mode: Mode, user_answer?: string) => {
    if (!sel) return;
    setBusy(true);
    setOutput("");
    try {
      const r = await api.learningTeach({ item_id: sel.id, mode, user_answer });
      setOutput(r.text);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "300px 1fr", gap: 0, border: "1px solid rgba(127,233,216,.12)" }}>
      <div className="mscroll" style={{ borderRight: "1px solid rgba(127,233,216,.12)", padding: 9, minHeight: 0 }}>
        {items.length === 0 && (
          <div style={{ fontSize: 11, color: "#3c544f", padding: 6 }}>No review items yet.</div>
        )}
        {items.map((it: LearningItem) => {
          const on = it.id === openId;
          return (
            <div
              key={it.id}
              onClick={() => { setOpenId(it.id); setOutput(""); setAnswer(""); }}
              style={{ border: `1px solid ${on ? "rgba(127,233,216,.4)" : "rgba(127,233,216,.12)"}`, borderLeft: `2px solid ${on ? "#7fe9d8" : "transparent"}`, padding: "9px 10px", marginBottom: 7, cursor: "pointer", background: on ? "rgba(127,233,216,.08)" : "transparent" }}
            >
              <div style={{ fontSize: 12, color: "#cfe9e3", lineHeight: 1.35 }}>{it.title}</div>
              <div style={{ fontSize: 9.5, color: "#3c544f", marginTop: 5 }}>
                mastery {it.mastery}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0, padding: 14 }}>
        {!sel ? (
          <div style={{ margin: "auto", fontSize: 11, letterSpacing: 1.5, color: "#3c544f" }}>SELECT AN ITEM</div>
        ) : (
          <div className="mscroll" style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0, overflowY: "auto" }}>
            <div>
              <div style={{ fontSize: 15, color: "#dff8f2" }}>{sel.title}</div>
              {sel.why_it_matters && (
                <div style={{ fontSize: 12, color: "#8fb3ac", marginTop: 6 }}>{sel.why_it_matters}</div>
              )}
              {sel.code_snippet && (
                <pre style={{ fontSize: 11, color: "#bfe6de", background: "rgba(7,13,13,.6)", padding: 10, marginTop: 8, overflowX: "auto" }}>{sel.code_snippet}</pre>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {(["explain", "quiz", "exercise"] as Mode[]).map((m) => (
                <button key={m} disabled={busy} onClick={() => run(m)}
                  style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(127,233,216,.3)", background: "rgba(127,233,216,.06)", color: "#dff8f2", fontFamily: "inherit", fontSize: 10, letterSpacing: 1, padding: "7px 12px", textTransform: "uppercase" }}>
                  {m}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <textarea value={answer} onChange={(e) => setAnswer(e.target.value)}
                placeholder="Explain it back in your own words…"
                style={{ width: "100%", boxSizing: "border-box", background: "rgba(7,13,13,.6)", border: "1px solid rgba(127,233,216,.18)", outline: "none", color: "#dff8f2", fontFamily: "inherit", fontSize: 12, padding: "7px 9px" }} rows={3} />
              <button disabled={busy || !answer.trim()} onClick={() => run("grade", answer)}
                style={{ appearance: "none", cursor: "pointer", border: "1px solid #8fd9a8", background: "rgba(143,217,168,.12)", color: "#dff8f2", fontFamily: "inherit", fontSize: 10, letterSpacing: 1, padding: "8px 13px", alignSelf: "flex-start" }}>
                GRADE MY UNDERSTANDING
              </button>
            </div>
            {busy && <div style={{ fontSize: 11, color: "#6f938d" }}>Thinking…</div>}
            {output && (
              <div style={{ fontSize: 12, color: "#bfe6de", lineHeight: 1.6 }}>
                <Markdown>{output}</Markdown>
              </div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => api.learningItem(sel.id, "reviewed")}
                style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(127,233,216,.25)", background: "transparent", color: "#9fc7c0", fontFamily: "inherit", fontSize: 10, letterSpacing: 1, padding: "7px 12px" }}>
                MARK REVIEWED
              </button>
              <button onClick={() => { void api.learningItem(sel.id, "archive"); setOpenId(null); }}
                style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(127,233,216,.25)", background: "transparent", color: "#9fc7c0", fontFamily: "inherit", fontSize: 10, letterSpacing: 1, padding: "7px 12px" }}>
                ARCHIVE
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Register the tab in AnalyzeModal**

In `bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx`:

Import:
```ts
import { TeacherTab } from "./TeacherTab";
```

Add `"teacher"` to the `Tab` union type (grep `type Tab =`):
```ts
type Tab = "overview" | "worktrees" | "changes" | "issues" | "terminal" | "teacher";
```

Add to the `tabs` array:
```ts
    { k: "teacher", l: "TEACHER" },
```

Add to the body render (next to `{tab === "issues" && <IssuesTab ... />}`):
```tsx
          {tab === "teacher" && <TeacherTab project={project} />}
```

- [ ] **Step 3: Verify types + build**

Run:
```bash
pnpm -C bridge/dashboard/web exec tsc -b && pnpm -C bridge/dashboard/web build
```
Expected: succeed.

- [ ] **Step 4: Commit**

```bash
git add bridge/dashboard/web/src
git commit -m "feat(dashboard): Teacher tab in AnalyzeModal"
```

---

## Task 12: README + manual smoke

**Files:**
- Modify: `README.md` (Features list)

- [ ] **Step 1: Add a Features bullet**

In `README.md`, in the `## Features` list, add:

```markdown
- **Teacher mode + review log.** After a turn that edits code, the bridge
  proposes 1–2 concepts to review as Keep/Skip cards on any surface. Kept items
  live in a Teacher view (Mini App `/teacher` tab, dashboard **TEACHER** tab in
  the project analyze modal) with on-demand Explain, Explain-back (graded), Quiz,
  and Exercise. Toggle with `LEARNING_ENABLE=0`.
```

- [ ] **Step 2: Full backend suite green**

Run:
```bash
python tests/test_learning.py && python tests/test_learning_store.py && python tests/test_bridge.py
```
Expected: all pass.

- [ ] **Step 3: Manual smoke (with the bridge running)**

1. In the dashboard, run a prompt that edits a file. Within ~2s of completion, a "📚 Review later?" card appears under the turn. Click **Keep**.
2. Open the project's analyze modal → **TEACHER** tab → the kept item is listed. Click it → **Explain** returns text; type an explanation → **Grade** returns feedback; **Mark reviewed** bumps mastery; **Archive** removes it.
3. In the Mini App, open the **Teacher** tab → the same kept item shows (grouped by project).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: teacher mode + review log feature"
```

---

## Self-Review notes (author)

- **Spec coverage:** table (T1) ✓; hybrid capture w/ Haiku + gating + JSON fallback (T2) ✓; capture cards on streaming surfaces + bot (T3, T5, T8, T10) ✓; Teacher view both surfaces (T9, T11) ✓; explain/explain-back/quiz/exercise + mastery/archive (T2, T6, T7, T9, T11) ✓; `LEARNING_ENABLE` (T4) ✓; tests (T1–T3) ✓.
- **Deviation from spec, flagged:** the spec described capture on "whatever surface you're on" uniformly. Reality: streaming surfaces (Mini App + dashboard) render inline transcript cards via `review_candidate` events; the bot has no tool-event visibility, so its card is an inline-keyboard message and its capture runs unconditionally (self-gated by the extractor prompt). Same UX, two mechanisms.
- **Timing:** dashboard polls continuously (catches trailing capture events for free); the Mini App adds a settle-refetch (T8 Step 4).
- **Type consistency:** `review_candidate`/`review_resolved` event shapes, `api.learningItem(itemId, action)`, and `teach` modes (`explain|quiz|exercise|grade`) are identical across backend, both `api.ts` files, and both `RunStream.tsx` files.
- **Open verification risk:** the exact `RunEvent` union location and the `<RunStream>` render site in the Mini App are grep-identified, not line-pinned — the implementer confirms them in Task 8.
