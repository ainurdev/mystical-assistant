# Linked Repos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project can be linked to partner repos, and every session in it then runs claude with `--add-dir <partner>` so one session works both sides of a coupled change.

**Architecture:** The link is one more project-wide field in the existing per-project settings store (`bridge/project_config.py`, JSON next to the bridge DB), written to both projects so it is symmetric. The runner reads it when building argv and appends `--add-dir` per existing partner plus one sentence in the appended system prompt. The dashboard's ANALYZE modal header edits it through the existing `/local/project/settings` endpoint.

**Tech Stack:** Python 3 stdlib (bridge), pytest; React + TypeScript (dashboard web, `bridge/dashboard/web`); Claude Code CLI `--add-dir`.

**Spec:** `docs/superpowers/specs/2026-09-02-linked-repos-design.md`

## Global Constraints

- Backend is Python stdlib only — no new dependencies.
- No DB migration: links live in `project_config.json`, never in `bridge/store.py`.
- `--add-dir` is appended on **every** real run (`--resume` does not remember it), never on `skip_pack` internal one-shots.
- The appended system prompt must stay byte-stable between turns when links do not change (prompt-cache contract, `tests/test_pack_cache.py`) — the note is built from the stored list in stored order, nothing volatile.
- Links are project-wide (like `hidden`/`learn_off`), never branch-scoped.
- Dashboard only: no Mini App, bot, or session-row changes.
- Commit messages in the repo's style — `type(scope): what it means for the user` — no co-author lines, and never `git push`.
- Feature work happens in a worktree (project skill **bridge-worktree**); the live bridge runs master's snapshot and nothing here is live until **bridge-ship**.

---

### Task 0: Worktree

**Files:** none in the repo.

- [ ] **Step 1: Create the worktree inside BASE_PATH and give it the ignored files it needs**

```sh
git -C ~/projects/mystical-assistant worktree add -b feat/linked-repos ~/projects/.worktrees/mystical-assistant/feat-linked-repos
cp ~/projects/mystical-assistant/.env ~/projects/.worktrees/mystical-assistant/feat-linked-repos/.env
ln -s ~/projects/mystical-assistant/bridge/dashboard/web/node_modules ~/projects/.worktrees/mystical-assistant/feat-linked-repos/bridge/dashboard/web/node_modules
```

The `node_modules` symlink is only so `tsc` can typecheck inside the worktree (Task 4); the shipped bundle is built from master at ship time (Task 5).

- [ ] **Step 2: Confirm the suite is green before touching anything**

Run: `cd ~/projects/.worktrees/mystical-assistant/feat-linked-repos && python3 -m pytest tests/ -q`
Expected: all passed (no failure floor — anything red later is yours).

Every path below is relative to `~/projects/.worktrees/mystical-assistant/feat-linked-repos`.

---

### Task 1: `project_config` — links, link, unlink

**Files:**
- Modify: `bridge/project_config.py` (append after `hidden_projects`, line ~120)
- Test: `tests/test_project_config.py` (append)

**Interfaces:**
- Produces: `links(project: str) -> list[str]` (rels, stored order), `link(a: str, b: str) -> None`, `unlink(a: str, b: str) -> None`. Both writers touch both entries; a self-link is a no-op. Later tasks call exactly these three.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_project_config.py`:

```python
def test_links_are_symmetric(tmp_path, monkeypatch):
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "pc.json"))
    assert project_config.links("/a") == []
    project_config.link("/a", "/b")
    assert project_config.links("/a") == ["/b"]
    assert project_config.links("/b") == ["/a"]
    project_config.link("/a", "/b")                  # idempotent, no duplicate
    assert project_config.links("/a") == ["/b"]
    project_config.unlink("/b", "/a")                # either side clears both
    assert project_config.links("/a") == []
    assert project_config.links("/b") == []


def test_self_link_is_ignored(tmp_path, monkeypatch):
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "pc.json"))
    project_config.link("/a", "/a")
    assert project_config.links("/a") == []


def test_unlink_leaves_the_other_settings_alone(tmp_path, monkeypatch):
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "pc.json"))
    project_config.set_run_cmd("/a", "npm run dev")
    project_config.link("/a", "/b")
    project_config.unlink("/a", "/b")
    assert project_config.run_cmd("/a") == "npm run dev"
    assert project_config.get("/b") == {}            # an emptied entry is dropped
```

- [ ] **Step 2: Run them to verify they fail**

Run: `python3 -m pytest tests/test_project_config.py -q`
Expected: 3 failed — `AttributeError: module 'bridge.project_config' has no attribute 'links'`.

- [ ] **Step 3: Implement**

Append to `bridge/project_config.py`:

```python
def links(project: str) -> list[str]:
    """Rels of the repos linked to this one. Project-wide and symmetric — see
    link(). Every session in the project runs with each of these as an extra
    working directory (runner._linked_dirs)."""
    v = get(project).get("links")
    return [str(x) for x in v] if isinstance(v, list) else []


def link(a: str, b: str) -> None:
    """Link two repos both ways. Written to both entries rather than computed
    as a union on read, so unlinking from either side is not silently undone
    by the other's entry. A self-link is ignored."""
    _set_link(a, b, on=True)


def unlink(a: str, b: str) -> None:
    """Remove a link from both entries."""
    _set_link(a, b, on=False)


def _set_link(a: str, b: str, *, on: bool) -> None:
    if a == b:
        return
    with _lock:
        data = _load()
        for me, other in ((a, b), (b, a)):
            entry = data.get(me, {})
            cur = [x for x in (entry.get("links") or []) if x != other]
            if on:
                cur.append(other)
            if cur:
                entry["links"] = cur
            else:
                entry.pop("links", None)
            if entry:
                data[me] = entry
            else:
                data.pop(me, None)
        _save(data)
```

Also widen the module docstring's first line so it no longer says "currently the dev/run command": change `"""Per-project settings — currently the dev/run command — persisted as JSON` to `"""Per-project settings — the dev/run command, prod URL, design link, repo links — persisted as JSON`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 -m pytest tests/test_project_config.py -q`
Expected: all passed.

- [ ] **Step 5: Commit**

```sh
git add bridge/project_config.py tests/test_project_config.py
git commit -m "feat(links): two repos can be linked, and the link reads the same from either side"
```

---

### Task 2: Runner — `--add-dir` per partner, and the note that says so

**Files:**
- Modify: `bridge/runner.py` — the `from bridge import (...)` block (line 26), `_compose_system_prompt` (line 103), `_base_cmd` (lines 352–358)
- Create: `tests/test_linked_repos.py`

**Interfaces:**
- Consumes: `project_config.links(rel)` from Task 1; `rel` (already imported from `bridge.browser`), `config.BASE_PATH`, `state.project_dir(chat_id)`.
- Produces: `_linked_dirs(cwd: str) -> list[str]` (absolute partner dirs that exist, stored order); `_compose_system_prompt(graph: str = "", linked: list[str] | None = None) -> str`. Task 3's tests reuse this file's fixture.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_linked_repos.py`:

```python
"""Linked repos: a project's partners ride every real run as --add-dir, the
appended system prompt names them, and the dashboard settings endpoint edits
the link. Run: python -m pytest tests/test_linked_repos.py -v"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import browser, config, project_config, runner  # noqa: E402


@pytest.fixture
def repos(tmp_path, monkeypatch):
    """Two plain dirs under the pinned BASE_PATH (conftest), a fresh
    project_config file, and no graph pack in the way."""
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "pc.json"))
    monkeypatch.setattr(runner, "_graph_pack_for", lambda *a, **k: "")
    a = os.path.join(config.BASE_PATH, tmp_path.name + "-a")
    b = os.path.join(config.BASE_PATH, tmp_path.name + "-b")
    os.makedirs(a)
    os.makedirs(b)
    return a, b


def _add_dirs(cmd):
    return [cmd[i + 1] for i, x in enumerate(cmd) if x == "--add-dir"]


def _sysprompt(cmd):
    return cmd[cmd.index("--append-system-prompt") + 1]


def _run_cmd(cwd, **kw):
    return runner._base_cmd("hi", 555, stream=True, interactive=True, cwd=cwd, **kw)


def test_linked_partner_rides_as_add_dir(repos):
    a, b = repos
    project_config.link(browser.rel(a), browser.rel(b))
    cmd = _run_cmd(a)
    assert _add_dirs(cmd) == [b]
    assert f"Linked repos with full tool access: {b}." in _sysprompt(cmd)


def test_unlinked_run_carries_nothing(repos):
    a, _ = repos
    cmd = _run_cmd(a)
    assert _add_dirs(cmd) == []
    assert "Linked repos" not in _sysprompt(cmd)


def test_missing_partner_is_skipped(repos):
    a, b = repos
    project_config.link(browser.rel(a), browser.rel(b))
    os.rmdir(b)
    cmd = _run_cmd(a)
    assert _add_dirs(cmd) == []
    assert "Linked repos" not in _sysprompt(cmd)


def test_internal_one_shot_gets_no_partner(repos):
    a, b = repos
    project_config.link(browser.rel(a), browser.rel(b))
    cmd = runner._base_cmd("hi", 555, stream=False, cwd=a, skip_pack=True)
    assert _add_dirs(cmd) == []


def test_note_is_stable_across_turns(repos):
    a, b = repos
    project_config.link(browser.rel(a), browser.rel(b))
    assert _sysprompt(_run_cmd(a)) == _sysprompt(_run_cmd(a))
```

- [ ] **Step 2: Run them to verify they fail**

Run: `python3 -m pytest tests/test_linked_repos.py -q`
Expected: `test_linked_partner_rides_as_add_dir`, `test_note_is_stable_across_turns` fail (no `--add-dir` in argv / no note); the three negative tests pass already — that is fine, they pin the behaviour that must survive Step 3.

- [ ] **Step 3: Implement**

In `bridge/runner.py`, add `project_config` to the import block at line 26 (alphabetical — after `native_activity`):

```python
from bridge import (accounts, agents, aifeatures, config, devserver, git,
                    inspector, ladder, limits, machine, native_activity,
                    project_config, pubsub, relevance, state, store,
                    transcript_jsonl)
```

Replace `_compose_system_prompt` (line 103) with:

```python
def _compose_system_prompt(graph: str = "", linked: "list[str] | None" = None) -> str:
    """ASK prompt + dev-log note + the linked-repos note, then the graph pack.

    Ordering does NOT protect the cache: the whole string lands in
    --append-system-prompt, which sits after the last cache breakpoint, so any
    change re-writes all of it. What protects the cache is only sending the
    volatile packs once per session — see _base_cmd. The linked-repos note is
    built from the stored list in stored order, so it only changes when a link
    does."""
    note = ""
    if linked:
        # The whole "notice" mechanism: the model has the partner repo in hand
        # via --add-dir and only needs to be told to look there.
        note = ("Linked repos with full tool access: " + ", ".join(linked) +
                ". A change here often needs one there — make both in this session.")
    parts = [p for p in (config.ASK_SYSTEM_PROMPT.strip(), _LOG_NOTE, note,
                         graph.strip()) if p]
    return "\n\n".join(parts)


def _linked_dirs(cwd: str) -> list[str]:
    """Partner repos of the project at `cwd` (project_config.links) that still
    exist on disk — each becomes an --add-dir. A partner deleted after linking
    must not break every run in this repo, so it is skipped, not raised."""
    out = []
    for r in project_config.links(rel(cwd)):
        d = os.path.normpath(os.path.join(config.BASE_PATH, r.lstrip("/")))
        if os.path.isdir(d):
            out.append(d)
    return out
```

In `_base_cmd`, replace lines 352–358 (from `if skip_pack or (claude_session_id and ...` through `cmd += ["--append-system-prompt", _compose_system_prompt(graph)]`) with:

```python
    if skip_pack or (claude_session_id and claude_session_id in _packed_sessions):
        graph = ""
    else:
        graph = _graph_pack_for(chat_id, cwd)
        if claude_session_id:
            _packed_sessions.add(claude_session_id)
    # Partner repos ride every real run — --resume does not remember the flag.
    # Internal one-shots (skip_pack) have no tools to use them with.
    linked = [] if skip_pack else _linked_dirs(cwd or state.project_dir(chat_id))
    for d in linked:
        cmd += ["--add-dir", d]
    cmd += ["--append-system-prompt", _compose_system_prompt(graph, linked)]
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 -m pytest tests/test_linked_repos.py tests/test_pack_cache.py tests/test_bridge.py tests/test_graph_inject.py -q`
Expected: all passed (the pack-cache and graph-inject suites guard the prompt contract you just touched).

- [ ] **Step 5: Commit**

```sh
git add bridge/runner.py tests/test_linked_repos.py
git commit -m "feat(links): a session runs with its project's partner repos in reach"
```

---

### Task 3: Dashboard endpoint — read and edit links

**Files:**
- Modify: `bridge/dashboard/server.py` — GET `/local/project/settings` (line ~477, the dict at 483–490) and POST `/local/project/settings` (line ~1130, the `out` block at 1137–1147)
- Test: `tests/test_linked_repos.py` (append)

**Interfaces:**
- Consumes: `project_config.links/link/unlink` (Task 1); `_abs_project(rel) -> str | None` and `browser.rel(abs)` already in `server.py`.
- Produces: GET body gains `"links": list[str]`; POST accepts `"link": "<rel>"` / `"unlink": "<rel>"`, answers `"links": list[str]`, or `{"error": "invalid project"}` (400) for a rel that does not resolve under BASE_PATH. Task 4 calls exactly this.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_linked_repos.py`:

```python
# --- /local/project/settings ------------------------------------------------
# Driven without sockets via the Handler.__new__ trick (mirrors
# tests/test_design_endpoints.py).

from urllib.parse import parse_qs, urlparse  # noqa: E402

from bridge.dashboard import server as dash  # noqa: E402


class _Client:
    def _handler(self):
        h = dash.Handler.__new__(dash.Handler)
        box = {}
        h._json = lambda obj, code=200: box.update(obj=obj, code=code)
        return h, box

    def get(self, path):
        h, box = self._handler()
        u = urlparse(path)
        h._get_api(u.path, parse_qs(u.query))
        return box

    def post(self, path, body):
        h, box = self._handler()
        h._post_api(path, body)
        return box


def test_settings_report_and_edit_links(repos):
    a, b = repos
    ra, rb = browser.rel(a), browser.rel(b)
    c = _Client()
    assert c.get(f"/local/project/settings?cwd={a}")["obj"]["links"] == []

    box = c.post("/local/project/settings", {"cwd": a, "link": rb})
    assert box["obj"]["links"] == [rb]
    assert project_config.links(rb) == [ra]          # written to both sides
    assert c.get(f"/local/project/settings?cwd={b}")["obj"]["links"] == [ra]

    box = c.post("/local/project/settings", {"cwd": a, "unlink": rb})
    assert box["obj"]["links"] == []
    assert project_config.links(rb) == []


def test_link_to_unknown_project_is_refused(repos):
    a, b = repos
    box = _Client().post("/local/project/settings", {"cwd": a, "link": "/does-not-exist"})
    assert box["code"] == 400 and box["obj"] == {"error": "invalid project"}
    assert project_config.links(browser.rel(a)) == []
```

- [ ] **Step 2: Run them to verify they fail**

Run: `python3 -m pytest tests/test_linked_repos.py -q`
Expected: the two new tests fail — `KeyError: 'links'`.

- [ ] **Step 3: Implement**

In the GET handler's returned dict (`server.py` ~line 483), add one key after `"design_project"`:

```python
                "design_project": project_config.design_project(rel, branch),
                "links": project_config.links(rel),
```

In the POST handler, after the `if "hidden" in body:` block and before `return self._json(out)` (~line 1147):

```python
            for field, fn in (("link", project_config.link), ("unlink", project_config.unlink)):
                if body.get(field):
                    other = _abs_project(body.get(field))
                    if other is None:
                        return self._json({"error": "invalid project"}, 400)
                    fn(rel, browser.rel(other))
                    out["links"] = project_config.links(rel)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 -m pytest tests/test_linked_repos.py tests/test_design_endpoints.py -q`
Expected: all passed.

- [ ] **Step 5: Commit**

```sh
git add bridge/dashboard/server.py tests/test_linked_repos.py
git commit -m "feat(links): project settings carry the repo links, and take a link or unlink"
```

---

### Task 4: Dashboard UI — `⇄` chips and a LINK popover in the ANALYZE header

**Files:**
- Modify: `bridge/dashboard/web/src/api.ts` — `ProjectSettings` (line ~300), `setProjectSettings` (line ~1301)
- Modify: `bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx` — state (after line ~102, the colour-edit state), the `[project]` effect (line ~116), helper functions (after `saveColorEdit`, line ~140), header JSX (after the ↑↓ span, line 211)

**Interfaces:**
- Consumes: Task 3's endpoint shape via `api.projectSettings(ctx)` and `api.setProjectSettings(ctx, patch)`; `api.projects()` → `ProjectsListing.projects` (rels); the modal's existing `hov`/`hp`, `name(rel)`, `tintBd`.
- Produces: nothing downstream.

- [ ] **Step 1: Types in `api.ts`**

In `ProjectSettings`, add after `design_project`:

```ts
  links: string[]; // rels linked both ways (project_config.links): extra working dirs for every session here
```

Replace `setProjectSettings` with:

```ts
  setProjectSettings: (
    ctx: RunCtx,
    patch: { run_cmd?: string; prod_url?: string; design_project?: string; hidden?: boolean; link?: string; unlink?: string },
  ) =>
    req<{
      ok: boolean;
      run_cmd?: string | null;
      prod_url?: string | null;
      design_project?: string | null;
      hidden?: boolean;
      links?: string[];
    }>("/local/project/settings", {
      method: "POST",
      body: { ...ctx, ...patch },
    }),
```

- [ ] **Step 2: State and data in `AnalyzeModal.tsx`**

After the colour-edit state (`const tintBd = tint.border;`), add:

```tsx
  // linked repos (project_config.links): every session here runs with them as
  // extra working directories. Edited from the header, so the modal owns the list.
  const [links, setLinks] = useState<string[]>([]);
  const [linkOpen, setLinkOpen] = useState(false);
  const [allProjects, setAllProjects] = useState<string[]>([]);
```

Inside the `useEffect(() => { ... }, [project])` block, after `setColorEditOpen(false);`, add:

```tsx
    setLinkOpen(false);
    void api.projectSettings({ project }).then((s) => setLinks(s.links ?? [])).catch(() => {});
```

After `saveColorEdit()`, add:

```tsx
  function openLinkEdit() {
    setLinkOpen((o) => !o);
    void api.projects().then((p) => setAllProjects(p.projects ?? [])).catch(() => {});
  }
  function setLink(other: string, on: boolean) {
    void api.setProjectSettings({ project }, on ? { link: other } : { unlink: other })
      .then((r) => { if (r.links) setLinks(r.links); })
      .catch(() => {});
  }
  const linkCandidates = allProjects.filter((r) => r !== project && !links.includes(r));
```

- [ ] **Step 3: Header JSX**

Directly after the ↑↓ span (the `</span>` closing `<span style={{ fontSize: "var(--t11)", color: "var(--txd)", ... }}>`, line 211) and before `{live && ...}`, insert:

```tsx
          {links.map((r) => (
            <button key={r} onClick={() => setLink(r, false)} title={`linked to ${r} — click to unlink`} {...hp(`link:${r}`)}
              style={{ appearance: "none", cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1, color: hov === `link:${r}` ? "var(--err)" : "var(--txm)", border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)", background: "transparent", padding: "1px 6px" }}>
              ⇄ {name(r)}
            </button>
          ))}
          <span style={{ position: "relative", flex: "none", display: "flex", alignItems: "center" }}>
            <button onClick={openLinkEdit} title="link another repo — its files get full tool access in every session here" {...hp("link")}
              style={{ appearance: "none", cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1, color: hov === "link" || linkOpen ? "var(--txb)" : "var(--txl)", border: `1px solid ${hov === "link" || linkOpen ? tintBd : "transparent"}`, background: "transparent", padding: "1px 6px" }}>
              ⇄ LINK
            </button>
            {linkOpen && (
              <div style={{ position: "absolute", top: "calc(100% + 7px)", left: 0, zIndex: 40, width: 260, maxHeight: 280, overflowY: "auto", border: "1px solid color-mix(in srgb, var(--acc) 40%, transparent)", background: "color-mix(in srgb, var(--panel2) 99%, transparent)", boxShadow: "0 14px 40px var(--shadow-pop)", padding: 12, animation: "mslide .16s ease both" }}>
                <div style={{ fontSize: "var(--t8)", letterSpacing: 1.5, color: "var(--txl)", marginBottom: 7 }}>LINK A REPO</div>
                {linkCandidates.map((r) => (
                  <button key={r} onClick={() => { setLink(r, true); setLinkOpen(false); }} {...hp(`pick:${r}`)}
                    style={{ display: "block", width: "100%", textAlign: "left", appearance: "none", cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t10)", color: "var(--txm)", border: 0, background: hov === `pick:${r}` ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent", padding: "5px 6px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {r}
                  </button>
                ))}
                {linkCandidates.length === 0 && (
                  <div style={{ fontSize: "var(--t9)", color: "var(--txd)" }}>nothing left to link</div>
                )}
              </div>
            )}
          </span>
```

- [ ] **Step 4: Typecheck (the check that fails if the shapes drifted)**

Run: `cd bridge/dashboard/web && ./node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: no output, exit 0. (`tsc -p .` checks nothing in this repo — use `tsconfig.app.json`.)

- [ ] **Step 5: See it (optional but cheap)**

Follow the project skill **bridge-eyes** to open the ANALYZE modal on a worktree build and screenshot the header with one link set (`POST /local/project/settings {"project": "/mystical-assistant", "link": "/<some-repo>"}` against the scratch server, then unlink). Send the capture to the user with `.mystical/probe/send.py` — never just look at it yourself.

- [ ] **Step 6: Commit**

```sh
git add bridge/dashboard/web/src/api.ts bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx
git commit -m "feat(links): the project modal says which repos ride along, and links another"
```

---

### Task 5: Whole suite, fold back, ship

**Files:** none new.

- [ ] **Step 1: Full backend suite in the worktree**

Run: `python3 -m pytest tests/ -q`
Expected: all passed. Anything red is this branch.

- [ ] **Step 2: Fold back to master (bridge-worktree)**

```sh
git -C ~/projects/mystical-assistant merge feat/linked-repos
git -C ~/projects/mystical-assistant worktree remove ~/projects/.worktrees/mystical-assistant/feat-linked-repos
```

(The `node_modules` symlink inside the worktree goes with it; it never touched master's real one.)

- [ ] **Step 3: Ship (bridge-ship)**

Follow the project skill **bridge-ship**: rebuild the dashboard bundle from master, then restart the bridge the way that skill prescribes — **not** `mystical restart` from inside a bridge session. Nothing in this plan is live until then: the running bridge is a snapshot of the code from when it launched. Ask the user before restarting if a session of theirs is mid-turn.

- [ ] **Step 4: Confirm it is live**

With the bridge restarted, link two repos from the ANALYZE modal, start a turn in one of them, and check the child's argv:

Run: `pgrep -af "claude -p" | grep -o -- "--add-dir [^ ]*"`
Expected: `--add-dir /home/mhzrerfani/projects/<partner>` on the running turn.
