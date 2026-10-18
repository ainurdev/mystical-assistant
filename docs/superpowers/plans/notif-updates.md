# UPDATES tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The bell gets an Updates tab: one row per update of Mystical (a headline and bullets each
install writes at boot from the commits that landed) and one row per note a maintainer wrote in
`docs/notes.md`, plus a form in the bell that writes, commits and pushes such a note.

**Architecture:** A new `bridge/whatsnew.py` owns everything about "what changed": the notes-file
parser, the boot-time range (`last_head..HEAD`), the haiku one-shot with its commit-subject
fallback, the Telegram send, and `add_note` (append → commit that one file → push → rollback on
refusal). `bridge/notices.py` gains two kinds in one group; the dashboard gains a filter, two row
renderings, a compose form and a NOTIFY row. Nothing changes in the Mini App, the Mac app or
Windows.

**Tech Stack:** Python 3 stdlib + SQLite (bridge), React/TS + vite (dashboard), pytest, the
`*.check.ts` lib scripts.

**Spec:** `docs/superpowers/specs/notif-updates.md` (mockups `.mystical/design-drafts/notif-updates/`,
states A–G; the first draft's SPEC.md there is superseded by the repo spec).

## Global Constraints

- Python is stdlib only. `boot()` and everything it starts are best-effort: nothing raises into
  the bridge's start-up; failures print to stderr.
- Work on branch `feat/notif-updates` in a worktree under `~/Projects/.worktrees/mystical-assistant/`
  (bridge-worktree skill). Any scratch bridge runs on its own `BRIDGE_DB`: on the live DB it would
  overwrite `last_head` with the worktree's HEAD.
- Tests never touch the real platform checkout: every test that runs git points `selfupdate.REPO`
  at a throwaway clone (the `tests/test_selfupdate.py` pattern) and restores it.
- Copy fixed by the spec, verbatim: chip `Updates`; verbs `UPDATED` and `NOTE`; bar link
  `✎ Write a note for every install ›`; form label `A NOTE FOR EVERY INSTALL`; button `SEND NOTE`
  / `SENDING…`; hint `commits docs/notes.md · pushes ⎇ <branch>` + ` · with N commits already
  waiting`; success bar `Sent · every install sees it after its next update`; empty state
  `no updates yet — i am as you first summoned me.` / `the next PULL & RESTART lists what changed
  here`; NOTIFY row `Mystical updated · a note for every install` — `what changed after a pull, and
  notes the maintainers wrote`; fallback headline `<n> commits pulled`; rest line `and <n> smaller
  fixes`.
- Limits: title 1–80 characters, one line; body ≤ 600; headline ≤ 40; ≤ 5 bullets of ≤ 100;
  `notes_seen` keeps the last 200 headings; the one-shot reads the newest 80 subjects.
- No `Co-Authored-By` trailers on commits (the user's CLAUDE.md). Never push from a task.

## Review Focus

1. A note with an empty body, or a hand-written heading that is not `date · title — author`:
   the row shows the title, nothing crashes → Task 1 (`test_notes_in_hand_written_and_empty`).
2. The one-shot answers with prose around the JSON, a 60-character headline, seven bullets, or
   nothing parseable: cut to the limits, or the fallback — never an exception → Task 3
   (`test_summarise_tolerates_wrapped_json_and_overlong`, `test_boot_falls_back_when_one_shot_fails`).
3. The push is refused on a checkout whose `docs/notes.md` already had a hand edit: HEAD, the
   index and the file come back exactly as they were, the hand edit included → Task 4
   (`test_add_note_rolls_back_a_refused_push`).
4. Your own note must not toast or reach Telegram; the same note pulled on another install must
   land as news → Task 4 (`test_add_note_emits_read_and_quiet`) and Task 3
   (`test_boot_sends_telegram_when_routed`).
5. A dev checkout that switched branches (old HEAD not an ancestor) or did not move: no row, no
   one-shot → Task 3 (`test_boot_is_silent_on_same_head_and_branch_switch`).

---

### Task 1: `git.file_at` and the notes parser

**Files:**
- Create: `bridge/whatsnew.py` (module docstring: why each install writes its own row, why the
  heading is a note's identity, why nothing here blocks boot), `tests/test_whatsnew.py`
- Modify: `bridge/git.py` (after `show_file`, ~line 918)

**Interfaces:**
- Produces: `git.file_at(cwd: str, sha: str, path: str) -> str` — `git show <sha>:<path>`,
  `""` when the file is absent at that commit or the sha is unknown.
- Produces: `whatsnew.notes_in(text: str) -> list[dict]` — one dict per `## ` entry, in file
  order: `{"heading": str, "date": str, "title": str, "author": str, "body": str}`; `heading` is
  the line without `## `; `body` is the lines up to the next entry, stripped; a heading that is
  not `YYYY-MM-DD · title — author` gives `title = heading`, `date = author = ""` (` — author`
  optional). Constants `NOTES_PATH = "docs/notes.md"` and `NOTES_HEADER` (the spec's header text).

- [ ] **Step 1: Write the failing tests** in `tests/test_whatsnew.py` — the clone helpers
  `_run`, `_clone_with_upstream`, `_commit` copied from `tests/test_selfupdate.py` (not imported:
  test modules are not a package), a `_write(repo, rel, text)` that writes a file under a repo
  (creating directories), and fixtures `origin` / `repo` (a fresh origin + clone per test) that
  set `selfupdate.REPO` to the clone and restore it, with the feed table cleared and
  `last_head` / `notes_seen` unset as `tests/test_notices.py` clears its state.

```python
def test_notes_in_parses_headings_bodies_and_authors():
    text = (whatsnew.NOTES_HEADER + "\n## 2026-10-18 · Re-enter the token — Mahziyar Erfani\n\n"
            "Line one.\nLine two.\n\n## 2026-10-19 · Second\n\nShort.\n")
    a, b = whatsnew.notes_in(text)
    assert a == {"heading": "2026-10-18 · Re-enter the token — Mahziyar Erfani", "date": "2026-10-18",
                 "title": "Re-enter the token", "author": "Mahziyar Erfani", "body": "Line one.\nLine two."}
    assert b["title"] == "Second" and b["author"] == "" and b["body"] == "Short."

def test_notes_in_hand_written_and_empty():
    text = "# Notes\n\n## Just a heading\n\n## 2026-10-18 · Empty one\n### not an entry\n"
    a, b = whatsnew.notes_in(text)
    assert a == {"heading": "Just a heading", "date": "", "title": "Just a heading", "author": "", "body": ""}
    assert b["title"] == "Empty one" and b["body"] == "### not an entry"
    assert whatsnew.notes_in("") == []

def test_file_at_reads_a_committed_version_and_empty_when_missing(repo):
    _commit(repo, "x\n", "feat: more")           # a.txt now "one\nx\n"
    first = g._run(repo, "rev-list", "--max-parents=0", "HEAD")[1].strip()
    assert g.file_at(repo, first, "a.txt") == "one\n"
    assert g.file_at(repo, "HEAD", "a.txt") == "one\nx\n"
    assert g.file_at(repo, "HEAD", "docs/notes.md") == "" and g.file_at(repo, "nope", "a.txt") == ""
```

- [ ] **Step 2: Run** `python3 -m pytest tests/test_whatsnew.py -q` → FAIL (`whatsnew` has no
  `notes_in`; `git` has no `file_at`).
- [ ] **Step 3: Implement** `file_at` with `_run(cwd, "show", f"{sha}:{path}")`, and `notes_in`
  with one regex `^(\d{4}-\d{2}-\d{2}) · (.+?)(?: — (.+))?$` over lines that start with `## `.
- [ ] **Step 4: Run** the three tests → PASS.
- [ ] **Step 5: Commit** `whatsnew: the notes-file parser and git.file_at`.

### Task 2: the catalog, the routing group and the AI switch

**Files:**
- Modify: `bridge/notices.py` (`CATALOG`, `VERBS`, `DEFAULTS`), `bridge/aifeatures.py`
  (`FEATURES`), `bridge/config.py` (next to `COMMIT_MSG_AI`, ~line 237)
- Test: `tests/test_notices.py`, `tests/test_aifeatures.py`

**Interfaces:**
- Produces: `CATALOG["updated"] == CATALOG["note"] == ("updates", "news", "bridge")`;
  `VERBS["updated"] == "UPDATED"`, `VERBS["note"] == "NOTE"`;
  `DEFAULTS["updates"] == {"pop": True, "sound": "none", "tg": "off"}`;
  `aifeatures.enabled("changelog")`, env `CHANGELOG_ENABLE`, shipped `"1"`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_notices.py
def test_updates_group_kinds_and_defaults():
    assert notices.CATALOG["updated"] == ("updates", "news", "bridge") == notices.CATALOG["note"]
    assert notices.verb("updated") == "UPDATED" and notices.verb("note") == "NOTE"
    assert notices.prefs()["events"]["updates"] == {"pop": True, "sound": "none", "tg": "off"}
    assert notices.telegram_ok("updated") is False
    notices.set_prefs({"events": {"updates": {"tg": "always"}}})
    assert notices.telegram_ok("note") is True
```

In `tests/test_aifeatures.py`: add `"changelog"` to the set in
`test_the_registry_covers_every_model_call_the_bridge_makes` and `"CHANGELOG_ENABLE": "1"` to
`shipped` in `test_shipped_defaults_are_off_for_anything_automatic`.

- [ ] **Step 2: Run** `python3 -m pytest tests/test_notices.py tests/test_aifeatures.py -q` → the
  three touched tests FAIL.
- [ ] **Step 3: Implement.** The `FEATURES` entry, after `commitmsg`: key `changelog`, env
  `CHANGELOG_ENABLE`, label `UPDATE NOTES`, hint `sums up what an update changed, in the bell`,
  cost `1 haiku call per restart with new commits`, tokens `~32k tokens (measured on commit
  messages; re-measure)`, about = the spec's sentence ("fires at a restart that found new commits —
  pulled, or on a dev checkout committed here — one haiku call each; off, the row lists the commit
  subjects instead"). `config.CHANGELOG_ENABLE` in the exact `os.environ.get("CHANGELOG_ENABLE",
  "1")` shape the shipped-defaults test greps for.
- [ ] **Step 4: Run** the two files → PASS.
- [ ] **Step 5: Commit** `notices: an updates group for Mystical's own changelog and notes`.

### Task 3: `whatsnew.boot()` — the range, the changelog, the notes, Telegram

**Files:**
- Modify: `bridge/whatsnew.py`
- Test: `tests/test_whatsnew.py`

**Interfaces:**
- Consumes: `git.file_at`, `notes_in` (Task 1); `notices.emit/telegram_ok` (Task 2);
  `runner.run_blocking(chat_id, prompt, cwd=, timeout=, model=, skip_pack=) -> (result, sid, cost,
  is_error)`; `store.get_setting/set_setting`; `config.DASH_CHAT_ID`, `config.ALLOWED_CHAT_IDS`;
  `bridge.telegram.send(chat_id, text)`.
- Produces: `boot() -> threading.Thread | None` — records `last_head`; returns the started
  daemon thread when there is a range to announce, else `None` (tests `join()` it).
  `_fallback(subjects: list[str], n: int) -> dict`, `_summarise(subjects, n) -> dict | None`,
  `_changelog(old: str, head: str) -> dict | None` (`{"headline", "bullets", "rest", "commits",
  "branch", "url"}`), `_compare_url(old, head) -> str | None`, `_announce(old, head)` (the thread
  body), `_telegram(kind: str, text: str) -> None`. Setting keys `"last_head"`, `"notes_seen"`.
  Rows: `updated` → subject `update:<head>`, title headline, body bullets joined by `\n`, meta
  `{from, to, commits, branch, rest, url}`; `note` → subject `note:<heading>`, meta `{author,
  date}`.

- [ ] **Step 1: Write the failing tests** (the feed is cleaned per test as `tests/test_notices.py`
  does; `aifeatures.enabled` is monkeypatched to `lambda k: False` unless a test says otherwise;
  `config.NOTIFY_ENABLE` True).

```python
def test_first_boot_records_head_and_says_nothing(repo):
    assert whatsnew.boot() is None
    assert store.get_setting("last_head") == g.head_sha(repo) and notices.feed() == []

def test_boot_announces_pulled_commits_and_new_notes(repo, origin, monkeypatch):
    whatsnew.boot()
    _commit(origin, "two\n", "notifications: the bell counts unread only — the chip tallied every row")
    _commit(origin, "three\n", "git: HANDLE IN A NEW SESSION opens on the tree whose push failed")
    _write(origin, "docs/notes.md", whatsnew.NOTES_HEADER + "\n## 2026-10-18 · Re-enter the token — Mahziyar\n\nPaste it once.\n")
    _run(origin, "add", "-A"); _run(origin, "commit", "-qm", "note: Re-enter the token")
    assert g.pull(repo)[0]
    t = whatsnew.boot(); t.join(10)
    note, upd = sorted(notices.feed(), key=lambda r: r["kind"])
    assert note["kind"] == "note" and note["subject"] == "note:2026-10-18 · Re-enter the token — Mahziyar"
    assert note["title"] == "Re-enter the token" and note["body"] == "Paste it once." and note["meta"]["author"] == "Mahziyar"
    assert upd["title"] == "3 commits pulled" and upd["subject"] == f"update:{g.head_sha(repo)}"
    assert upd["body"].splitlines() == ["note: Re-enter the token", "git: HANDLE IN A NEW SESSION opens on the tree whose push failed",
                                        "notifications: the bell counts unread only"]
    assert upd["meta"]["commits"] == 3 and upd["meta"]["rest"] == 0 and upd["meta"]["branch"] == "main"
    assert upd["meta"]["url"] is None                      # a /tmp origin is not github
    assert json.loads(store.get_setting("notes_seen")) == ["2026-10-18 · Re-enter the token — Mahziyar"]

def test_boot_is_silent_on_same_head_and_branch_switch(repo, origin):
    whatsnew.boot()
    assert whatsnew.boot() is None                         # nothing moved
    _run(repo, "checkout", "-q", "-b", "side"); _commit(repo, "s\n", "side work")
    _run(repo, "checkout", "-q", "main"); _run(repo, "checkout", "-q", "side")
    store.set_setting("last_head", "0" * 40)               # an unknown old head
    assert whatsnew.boot() is None and notices.feed() == []

def test_fallback_and_rest_count():
    subs = [f"area: thing {i} — because" for i in range(7)]
    d = whatsnew._fallback(subs, 9)
    assert d["headline"] == "9 commits pulled" and d["bullets"] == [f"area: thing {i}" for i in range(5)] and d["rest"] == 4
    assert whatsnew._fallback(["x"], 1)["headline"] == "1 commit pulled"

def test_summarise_tolerates_wrapped_json_and_overlong(monkeypatch):
    reply = 'Here you go:\n{"headline": "' + "H" * 60 + '", "bullets": ' + json.dumps([f"L{i} — d" for i in range(7)]) + ', "rest": "x"}'
    monkeypatch.setattr(whatsnew.runner, "run_blocking", lambda *a, **k: (reply, None, 0, False))
    d = whatsnew._summarise(["s"] * 9, 9)
    assert len(d["headline"]) == 40 and len(d["bullets"]) == 5 and d["rest"] == 4
    monkeypatch.setattr(whatsnew.runner, "run_blocking", lambda *a, **k: ("not json", None, 0, False))
    assert whatsnew._summarise(["s"], 1) is None
    monkeypatch.setattr(whatsnew.runner, "run_blocking", lambda *a, **k: ("", None, 0, True))
    assert whatsnew._summarise(["s"], 1) is None

def test_boot_falls_back_when_one_shot_fails(repo, origin, monkeypatch):
    whatsnew.boot(); _commit(origin, "two\n", "feat: two — why"); g.pull(repo)
    monkeypatch.setattr(whatsnew.aifeatures, "enabled", lambda k: k == "changelog")
    calls = []
    monkeypatch.setattr(whatsnew.runner, "run_blocking", lambda *a, **k: calls.append(k) or ("garbage", None, 0, False))
    whatsnew.boot().join(10)
    assert calls and calls[0]["model"] == "haiku" and calls[0]["cwd"] == repo
    assert notices.feed()[0]["title"] == "1 commit pulled" and notices.feed()[0]["body"] == "feat: two"

def test_boot_sends_telegram_when_routed(repo, origin, monkeypatch):
    whatsnew.boot(); _commit(origin, "two\n", "feat: two"); g.pull(repo)
    notices.set_prefs({"events": {"updates": {"tg": "always"}}})
    monkeypatch.setattr(config, "ALLOWED_CHAT_IDS", [555])
    sent = []
    monkeypatch.setattr("bridge.telegram.send", lambda chat, text, *a, **k: sent.append((chat, text)))
    whatsnew.boot().join(10)
    assert sent == [(555, "UPDATED · 1 commit pulled\n• feat: two")]

def test_compare_url_only_for_github(repo):
    _run(repo, "remote", "set-url", "origin", "git@github.com:ainurdev/mystical-assistant.git")
    assert whatsnew._compare_url("a" * 40, "b" * 40) == "https://github.com/ainurdev/mystical-assistant/compare/aaaaaaa...bbbbbbb"
    _run(repo, "remote", "set-url", "origin", "/tmp/elsewhere")
    assert whatsnew._compare_url("a" * 40, "b" * 40) is None
```

- [ ] **Step 2: Run** `python3 -m pytest tests/test_whatsnew.py -q` → the new tests FAIL.
- [ ] **Step 3: Implement** in `bridge/whatsnew.py`:
  - `boot()`: `head = git.head_sha(selfupdate.REPO)`; `old = store.get_setting("last_head")`;
    set `last_head` at once; `None` when `not head`, `not old`, `old == head`, or
    `git._run(repo, "merge-base", "--is-ancestor", old, head)[0] != 0`; else start
    `threading.Thread(target=_announce, args=(old, head), daemon=True)` and return it.
  - `_announce`: whole body in `try/except Exception` printing `[whatsnew] …` to stderr. Notes
    first (headings in `notes_in(file_at(old))` or in `notes_seen` are skipped; each emitted heading
    is appended to `notes_seen`, kept to the last 200), then `_changelog`, then one `emit` each and
    `_telegram` with the spec's text (`UPDATED · headline` + `\n• bullet` lines; `NOTE · title` +
    `\n` + body).
  - `_changelog`: `n = int(rev-list --count old..head)`; `0` → `None`; `subjects = log -80
    --format=%s old..head`; `_summarise` when `aifeatures.enabled("changelog")`, else/or
    `_fallback`; add `commits`, `branch = git.current_branch(repo)`, `url`.
  - `_fallback`: headline `f"{n} commit{'' if n == 1 else 's'} pulled"`, bullets
    `s.split(" — ", 1)[0][:100]` for the first five, `rest = n - len(bullets)`.
  - `_summarise`: the prompt `_PROMPT = native.INTERNAL_ONESHOT_TAG + "\n" + …` as the spec
    words it; `runner.run_blocking(config.DASH_CHAT_ID, _PROMPT + "\n".join(subjects),
    cwd=repo, timeout=180, model="haiku", skip_pack=True)`; parse the text between the first `{`
    and the last `}`; validate as the test pins; `None` on error, no JSON, no headline or no
    bullets.
  - `_compare_url`: `git remote get-url origin` matched by
    `github\.com[:/]([^/\s]+/[^/\s]+?)(?:\.git)?/?$`.
  - `_telegram(kind, text)`: `if notices.telegram_ok(kind)`: lazy `from bridge.telegram import
    send`; one `send(chat, text)` per `config.ALLOWED_CHAT_IDS`, in `try/except`.
- [ ] **Step 4: Run** `python3 -m pytest tests/test_whatsnew.py -q` → PASS.
- [ ] **Step 5: Commit** `whatsnew: at boot, say what the last update changed and relay new notes`.

### Task 4: `whatsnew.add_note()` — append, commit, push, roll back

**Files:**
- Modify: `bridge/whatsnew.py`
- Test: `tests/test_whatsnew.py`

**Interfaces:**
- Consumes: `git.commit_paths(cwd, message, paths) -> (ok, out)`, `git.push(cwd) -> (ok, out)`,
  `notices.emit`, `notices.mark_read(ids)`.
- Produces: `add_note(title: str, body: str) -> tuple[bool, str]` — `(True, push output)` or
  `(False, git's words)`; on success a read `note` row with `meta.quiet == True` and the heading
  in `notes_seen`. The caller validates lengths (Task 5); `add_note` only normalises `\r\n` and
  strips.

- [ ] **Step 1: Write the failing tests** (an origin with `receive.denyCurrentBranch ignore`
  accepts pushes; one without refuses them — the `test_selfupdate.py` trick).

```python
def test_add_note_appends_commits_pushes_and_emits_read_and_quiet(repo, origin, monkeypatch):
    _run(origin, "config", "receive.denyCurrentBranch", "ignore")
    _run(repo, "config", "user.name", "Tester")
    monkeypatch.setattr(whatsnew.time, "strftime", lambda *a: "2026-10-18")
    ok, out = whatsnew.add_note("Re-enter the token", "Paste it once.\r\nThen restart.")
    assert ok, out
    text = open(os.path.join(repo, "docs/notes.md")).read()
    assert text == whatsnew.NOTES_HEADER + "\n## 2026-10-18 · Re-enter the token — Tester\n\nPaste it once.\nThen restart.\n"
    assert g.status(repo)["dirty"] == 0 and g.status(repo)["ahead"] == 0
    assert g._run(repo, "log", "-1", "--format=%s")[1].strip() == "note: Re-enter the token"
    row = notices.feed()[0]
    assert row["kind"] == "note" and row["read"] is True and row["meta"] == {"author": "Tester", "date": "2026-10-18", "quiet": True}
    assert json.loads(store.get_setting("notes_seen")) == ["2026-10-18 · Re-enter the token — Tester"]

def test_add_note_commits_only_the_notes_file(repo, origin):
    _run(origin, "config", "receive.denyCurrentBranch", "ignore")
    _write(repo, "a.txt", "dirty\n")
    assert whatsnew.add_note("T", "")[0]
    assert [f["path"] for f in g.status(repo)["files"]] == ["a.txt"]      # still dirty, uncommitted

def test_add_note_rolls_back_a_refused_push(repo, origin):
    # origin refuses a push to its checked-out branch; the file had a hand edit already
    _write(repo, "docs/notes.md", whatsnew.NOTES_HEADER + "\nhand edit\n")
    head = g.head_sha(repo)
    ok, out = whatsnew.add_note("T", "b")
    assert ok is False and out
    assert g.head_sha(repo) == head
    assert open(os.path.join(repo, "docs/notes.md")).read() == whatsnew.NOTES_HEADER + "\nhand edit\n"
    assert [f["path"] for f in g.status(repo)["files"]] == ["docs/notes.md"]   # the hand edit, unstaged
    assert notices.feed() == [] and store.get_setting("notes_seen") in (None, "[]")

def test_add_note_rollback_removes_a_file_it_created(repo, origin):
    ok, _ = whatsnew.add_note("T", "b")
    assert ok is False and not os.path.exists(os.path.join(repo, "docs/notes.md")) and g.status(repo)["dirty"] == 0

def test_boot_does_not_repeat_your_own_note(repo, origin):
    _run(origin, "config", "receive.denyCurrentBranch", "ignore")
    whatsnew.boot()
    assert whatsnew.add_note("Mine", "x")[0]
    t = whatsnew.boot(); t.join(10)                      # last_head..HEAD now holds the note commit
    assert [r["kind"] for r in notices.feed()] == ["updated", "note"]   # one changelog row, the note once
```

- [ ] **Step 2: Run** → FAIL (`add_note` undefined).
- [ ] **Step 3: Implement** `add_note`: `before` = the file's text or `None`; write
  `(before or NOTES_HEADER) + f"\n## {heading}\n\n{body}\n"` (no blank line and no body when
  `body == ""`: `f"\n## {heading}\n"`); `commit_paths` then `push`; on either failing, roll back —
  `git reset --soft HEAD~1` only if the commit was made, `git reset -q HEAD -- docs/notes.md`,
  then write `before` back or `os.remove` — and return `(False, out)`. On success `emit` with
  `meta={"author": author, "date": date, "quiet": True}`, `mark_read([id])`, append the heading
  to `notes_seen`, return `(True, out)`. `author = git._run(repo, "config", "user.name")[1].strip()`.
- [ ] **Step 4: Run** `python3 -m pytest tests/test_whatsnew.py -q` → PASS.
- [ ] **Step 5: Commit** `whatsnew: add_note writes docs/notes.md, commits that file and pushes, or
  rolls back`.

### Task 5: `POST /local/update/note`

**Files:**
- Modify: `bridge/dashboard/server.py` (`_post_api`, next to `/local/update/publish` ~line 1340),
  `bridge/dashboard/web/src/api.ts` (next to `publishUpdate`, ~line 1461)
- Test: `tests/test_notices_endpoint.py`

**Interfaces:**
- Produces: `POST /local/update/note {title, body}` → `200 {ok, output}` or
  `400 {error: "a one-line title up to 80 characters, and up to 600 characters of text"}`.
  `api.noteUpdate(title: string, body: string): Promise<{ ok: boolean; output: string }>`.

- [ ] **Step 1: Write the failing tests** (the file's `_call` helper):

```python
def test_update_note_validates(monkeypatch):
    from bridge import whatsnew
    monkeypatch.setattr(whatsnew, "add_note", lambda t, b: (_ for _ in ()).throw(AssertionError("not reached")))
    for bad in ({}, {"title": "  "}, {"title": "x" * 81}, {"title": "a\nb"}, {"title": "ok", "body": "y" * 601}, {"title": 5}):
        assert _call("POST", "/local/update/note", bad)[0] == 400

def test_update_note_calls_add_note(monkeypatch):
    from bridge import whatsnew
    got = []
    monkeypatch.setattr(whatsnew, "add_note", lambda t, b: got.append((t, b)) or (True, "pushed"))
    code, obj = _call("POST", "/local/update/note", {"title": " Hello ", "body": "a\r\nb "})
    assert code == 200 and obj == {"ok": True, "output": "pushed"} and got == [("Hello", "a\nb")]
```

- [ ] **Step 2: Run** `python3 -m pytest tests/test_notices_endpoint.py -q` → FAIL (404 "not found").
- [ ] **Step 3: Implement** the route (strip the title; normalise the body's `\r\n` and strip;
  reject as the test lists; `from bridge import whatsnew` lazily like the move routes), and
  `noteUpdate` in `api.ts`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `dashboard: POST /local/update/note`.

### Task 6: the Updates filter

**Files:**
- Modify: `bridge/dashboard/web/src/lib/notices.ts` (`Filter`, `SOURCE`, `matches`),
  `bridge/dashboard/web/src/index.css` (`.ntf-pop` width, line 3721)
- Test: `bridge/dashboard/web/src/lib/notices.check.ts`

**Interfaces:**
- Produces: `Filter` gains `"updates"`; `matches("updates", r)` is `r.group === "updates"`;
  `needMatches("updates", n)` is always false; `chipCount("updates", …)` counts unread rows of
  that group. `.ntf-pop { width: 464px }`.

- [ ] **Step 1: Write the failing asserts** in `notices.check.ts`, after the `matches` block:

```ts
const upd = n(7, "update:abc", { kind: "updated", verb: "UPDATED", group: "updates", source: "bridge" });
const note = n(8, "note:x", { kind: "note", verb: "NOTE", group: "updates", source: "bridge" });
ok(matches("updates", upd) && matches("updates", note) && !matches("sessions", note) && matches("all", note), "updates rows are Updates and All");
ok(!matches("updates", n(9, "move:1", { kind: "move_done", group: "bridge", source: "bridge" })), "a MOVE row is not an update");
ok(!needMatches("updates", card) && !needMatches("updates", offer), "nothing waits on you under Updates");
ok(chipCount("updates", [card], [upd, { ...note, read: true }]) === 1, "the Updates chip counts unread updates only");
```

- [ ] **Step 2: Run** `node --experimental-strip-types bridge/dashboard/web/src/lib/notices.check.ts`
  → FAIL (type error / `matches` false).
- [ ] **Step 3: Implement** — `SOURCE` gets `updates: null`; `matches` checks the group for that
  filter before the source table; the CSS width.
- [ ] **Step 4: Run** the check → every line `ok`.
- [ ] **Step 5: Commit** `notifications: an Updates filter, by group`.

### Task 7: the two rows in the bell

**Files:**
- Modify: `bridge/dashboard/web/src/components/hud/Notifications.tsx` (`TONE` ~116, `Source`
  ~131, `metaLine` ~246, `RowActions` ~227, `NoticeRow` ~256, the chips ~473, `go`/`section`
  ~415–430, the empty state ~500), `bridge/dashboard/web/src/index.css` (after `.ntf-body.mono`)

**Interfaces:**
- Consumes: Task 6's filter. Row shapes from Task 3.
- Produces: `TONE.updated = "ok"`, `TONE.note = "acc"`; the emblem glyph (the mockup's diamond:
  `M12 3 21 12 12 21 3 12Z` + a filled inner `M12 9 15 12 12 15 9 12Z`, 13px) in `Source` for
  those two kinds; `.ntf-ul` / `.ntf-rest` / `.ntf-body.note` / `.ntf-empty .s` CSS; the chip
  `Updates` after `prs`; clicking a row of group `updates` toggles it open instead of opening
  anything (`opened: Set<number>` in `NotificationCenter`, `compact = r.read &&
  !opened.has(r.id)`).

- [ ] **Step 1: Implement** — `metaLine`: `updated` → `[`${commits} commit(s)`, `${from.slice(0,
  7)} → ${to.slice(0, 7)}`, `⎇ ${branch}`]`, `note` → `[`by ${author}`]` when set;
  `RowActions`: `Commits ↗` via `openUrl(m.url)` when `safeUrl(m.url)`; `NoticeRow`: for
  `updated` a `<ul className="ntf-ul">` with one `<li>` per body line, `<b>lead</b> — rest` split
  at the first ` — `, then `<div className="ntf-rest">and {rest} smaller fixes</div>` when
  `meta.rest > 0`; for `note` `<div className="ntf-body note">` (no clamp, `white-space:
  pre-wrap`); the chips array and its label map; the Updates empty state (the spec's two lines).
- [ ] **Step 2: Verify types and the build**: `cd bridge/dashboard/web && npm run build` → exits 0.
- [ ] **Step 3: Verify by eye** with the Mac kit: `.mystical/probe-mac/notif/scratch-click.py`
  (a scratch server on 8898, `WEB_DIR=` this worktree's dist, a /tmp `BRIDGE_DB`) seeded through
  `notices.emit` with one `updated` row (five bullets, `rest: 4`, a github `url`) and one `note`
  row; drive with `.mystical/probe-mac/fold/cdpfold.mjs`-style steps: open the bell, click
  `Updates`, screenshot; click the unread update, mark read, click it again → bullets toggle;
  `All` shows both rows in time order. One 2x crop per state into `.mystical/probe-mac/notif/upd-*.png`.
  Delete the scratch DB afterwards (it indexes native sessions).
- [ ] **Step 4: Commit** `notifications: UPDATED and NOTE rows in the bell`.

### Task 8: the compose form and the NOTIFY row

**Files:**
- Create: `bridge/dashboard/web/src/components/hud/NoteComposer.tsx`
- Modify: `bridge/dashboard/web/src/components/hud/Notifications.tsx` (the bar slot where the
  Rivendell link bar renders, ~line 480; the list ~line 489), `SettingsModal.tsx` (`NOTIFY_ROWS`
  THE BRIDGE, ~line 1145), `index.css`

**Interfaces:**
- Consumes: `api.noteUpdate` (Task 5), `api.update()` (`UpdateInfo.ahead`, `.branch`).
- Produces: `NoteComposer({ onSent, onCancel, onError }: { onSent: () => void; onCancel: () =>
  void; onError: (msg: string) => void })` — title input (maxLength 80), textarea (maxLength 600,
  rows 4), `SEND NOTE` disabled until the title has text and reading `SENDING…` while awaiting,
  `Cancel`, the hint `commits docs/notes.md · pushes ⎇ {branch}` + ` · with {ahead} commit(s)
  already waiting` when `ahead > 0` (`api.update()` on mount; errors ignored, branch defaults to
  `master`); Escape → `onCancel`. In `NotificationCenter`: `composing` and `noteBar: { kind: "ok"
  | "err"; text: string } | null`, cleared when `filter` changes; the bar
  `<button className="ntf-write">✎ Write a note for every install ›</button>` while
  `filter === "updates" && !composing && !noteBar`; the `.ntf-write.ok` / `.err` line otherwise;
  the form replaces the list while composing. Success → `composing = false`, `noteBar` ok text,
  `load.current()`. NOTIFY row under THE BRIDGE: `["updates", "Mystical updated · a note for
  every install", "what changed after a pull, and notes the maintainers wrote"]`.

- [ ] **Step 1: Implement** the component, the wiring, the NOTIFY row and the CSS (`.ntf-write`,
  `.ntf-compose`, its `.lbl`, `input`, `textarea`, `.foot`, `.hint` — tokens as the mockup:
  `--panel2` fields, `--line2` borders, `--f-rad-s` radius, `--t9` label with `.16em` tracking).
- [ ] **Step 2: Verify the build**: `npm run build` → 0.
- [ ] **Step 3: Verify the round trip** against the scratch server from Task 7 with
  `selfupdate.REPO` pointed at a throwaway clone whose origin accepts pushes
  (`receive.denyCurrentBranch ignore`): open Updates → the bar → fill the form → SEND NOTE; expect
  the ok bar text and a read NOTE row; then point the origin at one that refuses and expect the
  err bar with git's words and a clean clone (`git status --porcelain` empty, HEAD unchanged). 2x
  crops of the bar, the form and the ok state.
- [ ] **Step 4: Commit** `notifications: write a note for every install from the bell`.

### Task 9: the boot hook, `docs/notes.md`, the whole suite

**Files:**
- Modify: `claude_telegram_bridge.py` (the import list ~line 44; after `dream.boot()` ~line 186)
- Create: `docs/notes.md` (`whatsnew.NOTES_HEADER` verbatim, nothing else)

- [ ] **Step 1: Add** `whatsnew` to the import tuple and `whatsnew.boot()  # what the last update
  changed, and new notes, into the bell` right after `dream.boot()` (the `else:` branch only).
- [ ] **Step 2: Write** `docs/notes.md` with the header. Check it parses to no entries:
  `python3 -c "from bridge import whatsnew; assert whatsnew.notes_in(open('docs/notes.md').read()) == []"`.
- [ ] **Step 3: Run everything**: `python3 -m pytest tests/ -q` (green apart from the 7 known
  macOS-only failures on this Mac — see the mac-test-env memory; none in the files touched),
  `node --experimental-strip-types bridge/dashboard/web/src/lib/notices.check.ts`, `cd
  bridge/dashboard/web && npm run build`, and `cd bridge/miniapp/web && npm run build` (untouched,
  but the integration gate builds both).
- [ ] **Step 4: Commit** `bridge: announce what the last update changed at boot; docs/notes.md`.
- [ ] **Step 5: Hand over.** Nothing ships from this plan: shipping is a dashboard rebuild plus a
  bridge restart (bridge-ship skill), and the first boot after it only records HEAD — the first
  row appears on the second update. Say that in the report.
