# Git Intelligence (Sub-project B) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add live git status/diff/commit/push to the dashboard — a new `bridge/git.py` backend, dashboard endpoints, sidebar per-repo badges, a Git tab, and a Diff tab.

**Architecture:** New stdlib-only `bridge/git.py` runs `git -C <cwd> …` via `subprocess` (mirrors `bridge/devserver.py`). The dashboard server exposes read endpoints (status/all/diff) and token-gated write endpoints (commit/push), reusing `_abs_project` for `BASE_PATH` confinement. Frontend adds badges + Git/Diff tabs; the right panel becomes controlled so the Git tab can switch to Diff on file-click.

**Tech Stack:** Python 3 stdlib (`subprocess`, `os`), React 19 + Vite + Tailwind v4 + TypeScript, lucide-react.

## Global Constraints

- `bridge/git.py` is **stdlib only** (no new Python deps). All git calls go through one `_run(cwd, *args, timeout=8)` helper with a timeout.
- Every git working directory is an absolute path already validated by the dashboard server's `_abs_project` (inside `config.BASE_PATH`). `git.diff` additionally guards its file argument to stay inside the repo and passes it after `--`.
- Tests are plain scripts run with `python tests/test_git.py` (pytest is NOT installed). Use the existing runner convention: `test_*` functions + a `__main__` block that runs them and `raise SystemExit(1 if failed else 0)`.
- Frontend per-task verification = `npm --prefix bridge/dashboard/web run build` (tsc + vite). Use absolute paths in `npm --prefix`.
- Write endpoints (`/local/git/commit`, `/local/git/push`) are added in `_post_api` (Host+Origin+token gated, like `/local/run`). Reads in `_get_api` (Host-gated).
- Match existing style: stdlib module functions returning plain dicts/tuples; functional React components with Tailwind + the A-era tokens (`bg-card`, `text-success`, `text-warning`, `text-danger`, `border-border`, `font-mono`).
- Issues tab = Sub-project C; command palette = Sub-project D. Not in B.

---

## File Structure

**Backend:**
- Create `bridge/git.py` — git status/badge/diff/commit/push.
- Create `tests/test_git.py` — unit tests against temp repos.
- Modify `bridge/dashboard/server.py` — git read + write endpoints.

**Frontend:**
- Modify `bridge/dashboard/web/src/api.ts` — git types + methods.
- Modify `bridge/dashboard/web/src/components/Sidebar.tsx` — per-repo badge line.
- Modify `bridge/dashboard/web/src/App.tsx` — git-all poll, controlled right-panel tab, diff-file state, Git/Diff/Logs tabs.
- Modify `bridge/dashboard/web/src/components/RightPanel.tsx` — controlled active tab.
- Create `bridge/dashboard/web/src/components/GitTab.tsx`.
- Create `bridge/dashboard/web/src/lib/diff.ts` — `parseDiff`.
- Create `bridge/dashboard/web/src/components/DiffTab.tsx`.

---

## Task 1: `bridge/git.py` + tests (TDD)

**Files:**
- Create: `bridge/git.py`
- Create: `tests/test_git.py`

**Interfaces:**
- Produces: `is_repo(cwd)->bool`, `badge(cwd)->dict|None`, `status(cwd)->dict`, `diff(cwd,path)->str`, `commit(cwd,message)->(bool,str)`, `push(cwd,timeout=30)->(bool,str)`, `_safe_path(cwd,path)->str|None`. `status` dict: `{is_repo, branch, ahead, behind, dirty, files:[{path,status,add,del}]}`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_git.py`:
```python
"""Unit tests for bridge/git.py against throwaway repos. Run: python tests/test_git.py"""

import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ.setdefault("BASE_PATH", "/tmp")
os.environ.setdefault("BRIDGE_DB", os.path.join(tempfile.mkdtemp(), "t.db"))

from bridge import git as g  # noqa: E402


def _run(cwd, *args):
    subprocess.run(["git", "-C", cwd, *args], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _mkrepo():
    d = tempfile.mkdtemp()
    subprocess.run(["git", "init", "-q", d], check=True)
    _run(d, "config", "user.email", "t@example.com")
    _run(d, "config", "user.name", "Tester")
    _run(d, "config", "commit.gpgsign", "false")
    return d


def _write(d, name, text):
    with open(os.path.join(d, name), "w") as f:
        f.write(text)


def test_not_a_repo():
    assert g.is_repo(tempfile.mkdtemp()) is False
    st = g.status(tempfile.mkdtemp())
    assert st["is_repo"] is False and st["files"] == []


def test_clean_repo():
    d = _mkrepo()
    _write(d, "a.txt", "one\ntwo\n")
    _run(d, "add", "-A")
    _run(d, "commit", "-qm", "init")
    st = g.status(d)
    assert st["is_repo"] is True
    assert st["dirty"] == 0 and st["files"] == []
    assert st["branch"]  # some branch name


def test_modified_file_counts():
    d = _mkrepo()
    _write(d, "a.txt", "one\ntwo\n")
    _run(d, "add", "-A")
    _run(d, "commit", "-qm", "init")
    _write(d, "a.txt", "one\ntwo\nthree\n")
    st = g.status(d)
    assert st["dirty"] == 1
    f = st["files"][0]
    assert f["path"] == "a.txt" and f["status"] == "M"
    assert f["add"] == 1 and f["del"] == 0


def test_untracked_file_listed():
    d = _mkrepo()
    _write(d, "a.txt", "x\n")
    _run(d, "add", "-A")
    _run(d, "commit", "-qm", "init")
    _write(d, "new.txt", "l1\nl2\nl3\n")
    st = g.status(d)
    paths = {f["path"]: f for f in st["files"]}
    assert "new.txt" in paths
    assert paths["new.txt"]["status"] == "?"
    assert paths["new.txt"]["add"] == 3


def test_diff_has_changes():
    d = _mkrepo()
    _write(d, "a.txt", "one\ntwo\n")
    _run(d, "add", "-A")
    _run(d, "commit", "-qm", "init")
    _write(d, "a.txt", "one\nTWO\n")
    out = g.diff(d, "a.txt")
    assert "-two" in out and "+TWO" in out


def test_commit_clears_dirty():
    d = _mkrepo()
    _write(d, "a.txt", "one\n")
    _run(d, "add", "-A")
    _run(d, "commit", "-qm", "init")
    _write(d, "a.txt", "one\ntwo\n")
    ok, _out = g.commit(d, "second change")
    assert ok is True
    assert g.status(d)["dirty"] == 0


def test_path_escape_rejected():
    d = _mkrepo()
    assert g._safe_path(d, "../outside") is None
    assert g._safe_path(d, "a.txt") == "a.txt"


def test_push_to_bare_remote():
    bare = tempfile.mkdtemp()
    subprocess.run(["git", "init", "--bare", "-q", bare], check=True)
    d = _mkrepo()
    _write(d, "a.txt", "one\n")
    _run(d, "add", "-A")
    _run(d, "commit", "-qm", "init")
    branch = subprocess.run(["git", "-C", d, "branch", "--show-current"],
                            capture_output=True, text=True).stdout.strip()
    _run(d, "remote", "add", "origin", bare)
    _run(d, "push", "-q", "-u", "origin", branch)
    _write(d, "a.txt", "one\ntwo\n")
    g.commit(d, "second")
    ok, _out = g.push(d)
    assert ok is True
    log = subprocess.run(["git", "-C", bare, "log", "--oneline"],
                         capture_output=True, text=True).stdout
    assert log.count("\n") == 2


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items())
           if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL {fn.__name__}: {type(e).__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    raise SystemExit(1 if failed else 0)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python tests/test_git.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'bridge.git'` (or import error).

- [ ] **Step 3: Implement `bridge/git.py`**

```python
"""Read git status/diff and perform commit/push for a working tree. Stdlib only;
every call shells out to `git -C <cwd> …` with a timeout. Callers pass an absolute
cwd already confined to BASE_PATH by the dashboard's _abs_project."""

import os
import subprocess


def _run(cwd: str, *args: str, timeout: int = 8) -> tuple[int, str, str]:
    try:
        p = subprocess.run(["git", "-C", cwd, *args], capture_output=True,
                           text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "git timed out"
    except OSError as e:
        return 127, "", str(e)


def is_repo(cwd: str) -> bool:
    rc, out, _ = _run(cwd, "rev-parse", "--is-inside-work-tree")
    return rc == 0 and out.strip() == "true"


def _safe_path(cwd: str, path: str) -> str | None:
    """Return path relative to cwd iff it stays inside cwd, else None."""
    root = os.path.realpath(cwd)
    full = os.path.realpath(os.path.join(root, path))
    if full == root or full.startswith(root + os.sep):
        return os.path.relpath(full, root)
    return None


def _status_letter(xy: str) -> str:
    s = xy.replace(".", "")
    return s[0] if s else "M"


def _parse(raw: str):
    """(branch, ahead, behind, [(status, path, untracked)]) from porcelain v2."""
    branch, ahead, behind, entries = "", 0, 0, []
    for line in raw.splitlines():
        if line.startswith("# branch.head"):
            branch = line[len("# branch.head"):].strip()
        elif line.startswith("# branch.ab"):
            for tok in line.split():
                if tok.startswith("+"):
                    ahead = int(tok[1:] or 0)
                elif tok.startswith("-"):
                    behind = int(tok[1:] or 0)
        elif line[:1] == "1":
            entries.append((_status_letter(line.split(" ", 2)[1]),
                            line.split(" ", 8)[8] if len(line.split(" ", 8)) > 8 else "", False))
        elif line[:1] == "2":
            parts = line.split(" ", 9)
            rest = parts[9] if len(parts) > 9 else ""
            entries.append((_status_letter(line.split(" ", 2)[1]),
                            rest.split("\t")[0], False))
        elif line.startswith("u "):
            entries.append(("U", line.rsplit(" ", 1)[-1], False))
        elif line.startswith("? "):
            entries.append(("?", line[2:], True))
    return branch, ahead, behind, entries


def _numstat(cwd: str) -> dict:
    res: dict[str, list[int]] = {}
    for args in (("diff", "--numstat"), ("diff", "--cached", "--numstat")):
        rc, out, _ = _run(cwd, *args)
        if rc != 0:
            continue
        for line in out.splitlines():
            parts = line.split("\t")
            if len(parts) != 3:
                continue
            a, d, path = parts
            cur = res.get(path, [0, 0])
            res[path] = [cur[0] + (0 if a == "-" else int(a)),
                         cur[1] + (0 if d == "-" else int(d))]
    return res


def _count_lines(path: str) -> int:
    try:
        if os.path.getsize(path) > 1_000_000:
            return 0
        with open(path, "rb") as f:
            return sum(1 for _ in f)
    except OSError:
        return 0


def _porcelain(cwd: str) -> str | None:
    rc, out, _ = _run(cwd, "status", "--porcelain=v2", "--branch")
    return out if rc == 0 else None


def badge(cwd: str) -> dict | None:
    if not is_repo(cwd):
        return None
    branch, ahead, behind, entries = _parse(_porcelain(cwd) or "")
    return {"branch": branch, "ahead": ahead, "behind": behind, "dirty": len(entries)}


def status(cwd: str) -> dict:
    if not is_repo(cwd):
        return {"is_repo": False, "branch": "", "ahead": 0, "behind": 0,
                "dirty": 0, "files": []}
    branch, ahead, behind, entries = _parse(_porcelain(cwd) or "")
    nums = _numstat(cwd)
    files = []
    for st, path, untracked in entries:
        add, dele = nums.get(path, [0, 0])
        if untracked:
            add = _count_lines(os.path.join(cwd, path))
        files.append({"path": path, "status": st, "add": add, "del": dele})
    return {"is_repo": True, "branch": branch, "ahead": ahead, "behind": behind,
            "dirty": len(files), "files": files}


def diff(cwd: str, path: str) -> str:
    safe = _safe_path(cwd, path)
    if safe is None:
        return ""
    rc, out, _ = _run(cwd, "status", "--porcelain", "--", safe)
    if out.startswith("??"):
        _rc, out, _err = _run(cwd, "diff", "--no-index", "--", os.devnull, safe)
        return out
    rc, _o, _e = _run(cwd, "rev-parse", "--verify", "HEAD")
    args = ["diff"] + (["HEAD"] if rc == 0 else []) + ["--", safe]
    _rc, out, _err = _run(cwd, *args)
    return out


def commit(cwd: str, message: str) -> tuple[bool, str]:
    rc, out, err = _run(cwd, "add", "-A")
    if rc != 0:
        return False, (err or out or "git add failed").strip()
    rc, out, err = _run(cwd, "commit", "-m", message)
    return rc == 0, (out + err).strip()


def push(cwd: str, timeout: int = 30) -> tuple[bool, str]:
    rc, out, err = _run(cwd, "push", timeout=timeout)
    return rc == 0, (out + err).strip()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python tests/test_git.py`
Expected: `8/8 passed`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add bridge/git.py tests/test_git.py
git commit -m "feat(git): bridge/git.py — status, diff, commit, push with tests"
```

---

## Task 2: Dashboard git endpoints

**Files:**
- Modify: `bridge/dashboard/server.py`

**Interfaces:**
- Consumes: `bridge.git` (Task 1), existing `_abs_project`, `store.list_sessions_all`, `browser.rel`.
- Produces: `GET /local/git`, `GET /local/git/all`, `GET /local/git/diff`; `POST /local/git/commit`, `POST /local/git/push`.

- [ ] **Step 1: Import git in server.py**

In `bridge/dashboard/server.py`, add `git` to the bridge import line:
```python
from bridge import (browser, config, devserver, git, machine, native, pubsub,
                    runner, state, store, tunnel, usage)
```

- [ ] **Step 2: Add read endpoints in `_get_api`**

In `bridge/dashboard/server.py`, inside `_get_api`, before the final `return self._json({"error": "not found"}, 404)`, add:
```python
        if path == "/local/git":
            abs_p = _abs_project(qs.get("project", [None])[0])
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            return self._json(git.status(abs_p))
        if path == "/local/git/all":
            repos = {}
            seen = set()
            for s in store.list_sessions_all(chat):
                rel = s["project"]
                if rel in seen:
                    continue
                seen.add(rel)
                abs_p = _abs_project(rel)
                if abs_p is None:
                    continue
                b = git.badge(abs_p)
                if b is not None:
                    repos[rel] = b
            return self._json({"repos": repos})
        if path == "/local/git/diff":
            abs_p = _abs_project(qs.get("project", [None])[0])
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            fpath = qs.get("path", [""])[0]
            return self._json({"path": fpath, "diff": git.diff(abs_p, fpath)})
```

- [ ] **Step 3: Add write endpoints in `_post_api`**

In `bridge/dashboard/server.py`, inside `_post_api`, before the final `return self._json({"error": "not found"}, 404)`, add:
```python
        if path == "/local/git/commit":
            abs_p = _abs_project(body.get("project"))
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            msg = (body.get("message") or "").strip()[:2000]
            if not msg:
                return self._json({"error": "empty commit message"}, 400)
            ok, output = git.commit(abs_p, msg)
            return self._json({"ok": ok, "output": output})
        if path == "/local/git/push":
            abs_p = _abs_project(body.get("project"))
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            ok, output = git.push(abs_p)
            return self._json({"ok": ok, "output": output})
```

- [ ] **Step 4: Verify import / syntax**

Run:
```bash
python -c "import ast; ast.parse(open('bridge/dashboard/server.py').read()); print('server.py OK')"
python tests/test_git.py
```
Expected: `server.py OK`, and `8/8 passed` (regression check that git.py still good).

- [ ] **Step 5: Commit**

```bash
git add bridge/dashboard/server.py
git commit -m "feat(dashboard): git status/all/diff + commit/push endpoints"
```

---

## Task 3: Frontend git API

**Files:**
- Modify: `bridge/dashboard/web/src/api.ts`

**Interfaces:**
- Produces: `GitFile`, `GitStatus`, `GitBadge` types; `api.git`, `api.gitAll`, `api.gitDiff`, `api.gitCommit`, `api.gitPush`.

- [ ] **Step 1: Add types**

In `bridge/dashboard/web/src/api.ts`, after the `PreviewInfo`/`DashState` interfaces, add:
```ts
export interface GitFile {
  path: string;
  status: string;
  add: number;
  del: number;
}
export interface GitStatus {
  is_repo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  dirty: number;
  files: GitFile[];
}
export interface GitBadge {
  branch: string;
  ahead: number;
  behind: number;
  dirty: number;
}
```

- [ ] **Step 2: Add api methods**

In the `export const api = { … }` object in `api.ts`, add these entries (after `usage`):
```ts
  git: (project: string) =>
    req<GitStatus>(`/local/git?project=${encodeURIComponent(project)}`),
  gitAll: () => req<{ repos: Record<string, GitBadge> }>("/local/git/all"),
  gitDiff: (project: string, path: string) =>
    req<{ path: string; diff: string }>(
      `/local/git/diff?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`,
    ),
  gitCommit: (project: string, message: string) =>
    req<{ ok: boolean; output: string }>("/local/git/commit", {
      method: "POST",
      body: { project, message },
    }),
  gitPush: (project: string) =>
    req<{ ok: boolean; output: string }>("/local/git/push", {
      method: "POST",
      body: { project },
    }),
```

- [ ] **Step 3: Build**

Run: `npm --prefix /home/mhzrerfani/projects/mystical-assistant/bridge/dashboard/web run build`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add bridge/dashboard/web/src/api.ts
git commit -m "feat(dashboard): git API types + methods"
```

---

## Task 4: Sidebar per-repo git badges

**Files:**
- Modify: `bridge/dashboard/web/src/App.tsx` (poll `/local/git/all`, pass `gitBadges`)
- Modify: `bridge/dashboard/web/src/components/Sidebar.tsx` (render badge line)

**Interfaces:**
- Consumes: `api.gitAll`, `GitBadge`.
- Produces: `Sidebar` prop `gitBadges: Map<string, GitBadge>`.

- [ ] **Step 1: Poll git-all in App**

In `bridge/dashboard/web/src/App.tsx`:
1. Add `type GitBadge` to the `./api` import list.
2. Add state near the other `useState`s:
```tsx
const [gitBadges, setGitBadges] = useState<Map<string, GitBadge>>(new Map());
```
3. Add a poll effect (next to the running poll):
```tsx
// Per-repo git badges for the sidebar.
useEffect(() => {
  let live = true;
  const tick = async () => {
    try {
      const { repos } = await api.gitAll();
      if (live) setGitBadges(new Map(Object.entries(repos)));
    } catch {
      /* ignore */
    }
  };
  void tick();
  const id = setInterval(tick, 10000);
  return () => { live = false; clearInterval(id); };
}, []);
```
4. Pass to `<Sidebar>`: add prop `gitBadges={gitBadges}`.

- [ ] **Step 2: Render the badge line in Sidebar**

In `bridge/dashboard/web/src/components/Sidebar.tsx`:
1. Import the type: change the api import to include `type GitBadge`:
```tsx
import { api, type GitBadge, type ProjectsListing, type RunningSession, type SessionBrief } from "../api";
```
2. Add `gitBadges` to the props type and destructure:
```tsx
  gitBadges: Map<string, GitBadge>;
```
3. In the *Recent chats* per-repo block, the header is the `<div className="flex items-center justify-between px-1.5 py-1">…</div>`. Immediately AFTER that header div (still inside the `<div key={proj} className="mb-2.5">`), insert a badge line:
```tsx
{(() => {
  const b = gitBadges.get(proj);
  if (!b) return null;
  return (
    <div className="mb-1 flex items-center gap-2.5 px-1.5 font-mono text-[11px]">
      <span className="flex items-center gap-1 text-[#a99fd0]">
        <span className="text-muted-2">⎇</span>
        {b.branch}
      </span>
      <span className="flex items-center gap-2 text-muted-2">
        <span style={{ color: b.dirty > 0 ? "var(--warning)" : "var(--muted-2)" }} title="changed files">
          ●{b.dirty}
        </span>
        <span title="ahead">↑{b.ahead}</span>
        <span title="behind">↓{b.behind}</span>
      </span>
    </div>
  );
})()}
```

- [ ] **Step 3: Build**

Run: `npm --prefix /home/mhzrerfani/projects/mystical-assistant/bridge/dashboard/web run build`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add bridge/dashboard/web/src/App.tsx bridge/dashboard/web/src/components/Sidebar.tsx
git commit -m "feat(dashboard): per-repo git badges in the sidebar"
```

---

## Task 5: Controlled RightPanel + Git tab

**Files:**
- Modify: `bridge/dashboard/web/src/components/RightPanel.tsx` (controlled active tab)
- Create: `bridge/dashboard/web/src/components/GitTab.tsx`
- Modify: `bridge/dashboard/web/src/App.tsx` (active-tab + diff-file state; register Git/Diff/Logs)

**Interfaces:**
- Produces: `RightPanel` props `activeId?: string`, `onActiveChange?: (id:string)=>void` (controlled when both passed; uncontrolled otherwise). `GitTab` props `{ project: string | null; onOpenDiff: (path:string)=>void }`.
- Consumes: `api.git`, `api.gitCommit`, `api.gitPush`, `GitStatus`.

- [ ] **Step 1: Make RightPanel controllable**

Replace the contents of `bridge/dashboard/web/src/components/RightPanel.tsx` with:
```tsx
import { useState, type ReactNode } from "react";

export interface PanelTab {
  id: string;
  label: string;
  badge?: string | null;
  render: () => ReactNode;
}

export function RightPanel({
  tabs,
  activeId,
  onActiveChange,
}: {
  tabs: PanelTab[];
  activeId?: string;
  onActiveChange?: (id: string) => void;
}) {
  const [internal, setInternal] = useState(tabs[0]?.id);
  const active = activeId ?? internal;
  const setActive = (id: string) => {
    setInternal(id);
    onActiveChange?.(id);
  };
  const current = tabs.find((t) => t.id === active) ?? tabs[0];
  return (
    <aside className="flex min-h-0 w-[372px] shrink-0 flex-col border-l border-panel-border bg-panel">
      <div className="flex shrink-0 gap-0.5 border-b border-border px-3 pt-2.5">
        {tabs.map((t) => {
          const on = t.id === current?.id;
          return (
            <button
              key={t.id}
              onClick={() => setActive(t.id)}
              className={`flex items-center gap-1.5 rounded-t-lg border-b-2 px-3 py-2 text-[12.5px] font-medium ${
                on
                  ? "border-brand-soft text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
              {t.badge ? (
                <span className="rounded-md bg-primary/15 px-1.5 font-mono text-[10px] text-brand-soft">
                  {t.badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{current?.render()}</div>
    </aside>
  );
}
```

- [ ] **Step 2: Create `components/GitTab.tsx`**

```tsx
import { useCallback, useEffect, useState } from "react";
import { api, type GitStatus } from "../api";

function statusColor(s: string): string {
  if (s === "A" || s === "?") return "var(--success)";
  if (s === "D") return "var(--danger)";
  return "var(--warning)";
}

export function GitTab({
  project,
  onOpenDiff,
}: {
  project: string | null;
  onOpenDiff: (path: string) => void;
}) {
  const [st, setSt] = useState<GitStatus | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!project) return;
    try {
      setSt(await api.git(project));
    } catch {
      /* ignore */
    }
  }, [project]);

  useEffect(() => {
    let live = true;
    void refresh();
    const id = setInterval(() => {
      if (live) void refresh();
    }, 4000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [refresh]);

  if (!project) return <div className="p-4 text-xs text-muted-foreground">No project selected.</div>;
  if (st && !st.is_repo) return <div className="p-4 text-xs text-muted-foreground">Not a git repository.</div>;

  async function commit() {
    if (!project || !msg.trim()) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await api.gitCommit(project, msg.trim());
      setNote(r.ok ? "Committed." : r.output || "Commit failed.");
      if (r.ok) setMsg("");
      await refresh();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function push() {
    if (!project) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await api.gitPush(project);
      setNote(r.ok ? "Pushed." : r.output || "Push failed.");
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-4">
      <div className="mb-4 rounded-[11px] border border-border bg-card p-3.5">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 font-mono text-[13px] text-card-foreground">
            <span className="text-brand-soft">⎇</span>
            {st?.branch || "—"}
          </span>
          <span className="flex gap-2.5 font-mono text-[11px] text-muted-2">
            <span className="text-success">↑{st?.ahead ?? 0}</span>
            <span>↓{st?.behind ?? 0}</span>
          </span>
        </div>
      </div>

      <div className="px-0.5 pb-2 text-[10.5px] font-semibold uppercase tracking-wider text-muted-2">
        Changes · {st?.files.length ?? 0} files
      </div>
      {st?.files.map((f) => (
        <button
          key={f.path}
          onClick={() => onOpenDiff(f.path)}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-accent"
        >
          <span className="w-4 shrink-0 text-center font-mono text-[11px] font-semibold" style={{ color: statusColor(f.status) }}>
            {f.status}
          </span>
          <span className="flex-1 truncate text-left font-mono text-[11.5px] text-card-foreground" style={{ direction: "rtl" }}>
            {f.path}
          </span>
          <span className="flex shrink-0 gap-1.5 font-mono text-[11px]">
            <span className="text-success">+{f.add}</span>
            <span className="text-danger">−{f.del}</span>
          </span>
        </button>
      ))}
      {st && st.files.length === 0 && (
        <div className="px-2.5 py-2 text-xs text-muted-foreground">Working tree clean.</div>
      )}

      <div className="mt-4 rounded-[11px] border border-border bg-card p-3">
        <textarea
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          rows={2}
          placeholder="Commit message…"
          className="w-full resize-none bg-transparent text-[12.5px] outline-none placeholder:text-[#5a5470]"
        />
        <div className="mt-3 flex gap-2">
          <button
            onClick={() => void commit()}
            disabled={busy || !msg.trim()}
            className="flex-1 rounded-lg border border-brand-soft bg-primary px-2 py-2 text-[12.5px] font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Commit all
          </button>
          <button
            onClick={() => void push()}
            disabled={busy}
            className="rounded-lg border border-input bg-secondary px-3.5 py-2 text-[12.5px] font-medium text-foreground hover:bg-accent disabled:opacity-40"
          >
            Push
          </button>
        </div>
        {note && <div className="mt-2 whitespace-pre-wrap break-words font-mono text-[10.5px] text-muted-foreground">{note}</div>}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Wire App — active tab + diff file + tabs**

In `bridge/dashboard/web/src/App.tsx`:
1. Imports:
```tsx
import { GitTab } from "./components/GitTab";
```
2. State (near `gitBadges`):
```tsx
const [activeTab, setActiveTab] = useState("git");
const [diffFile, setDiffFile] = useState<{ project: string; path: string } | null>(null);
```
3. Active project rel for tabs:
```tsx
const activeProject = state?.project?.rel ?? null;
```
4. Replace the `panelTabs` definition with:
```tsx
const panelTabs: PanelTab[] = [
  {
    id: "git",
    label: "Git",
    badge: activeProject ? (gitBadges.get(activeProject)?.dirty || undefined)?.toString() ?? null : null,
    render: () => (
      <GitTab
        project={activeProject}
        onOpenDiff={(path) => {
          if (activeProject) {
            setDiffFile({ project: activeProject, path });
            setActiveTab("diff");
          }
        }}
      />
    ),
  },
  { id: "diff", label: "Diff", render: () => <div className="p-4 text-xs text-muted-foreground">Select a changed file in the Git tab.</div> },
  { id: "logs", label: "Logs", render: () => <Logs lines={logs} /> },
];
```
5. Make `<RightPanel>` controlled:
```tsx
<RightPanel tabs={panelTabs} activeId={activeTab} onActiveChange={setActiveTab} />
```
(The Diff tab body is a placeholder here; Task 6 replaces it with `DiffTab`. `diffFile`/`setDiffFile` are referenced by `onOpenDiff` so no unused-var error.)

- [ ] **Step 4: Build**

Run: `npm --prefix /home/mhzrerfani/projects/mystical-assistant/bridge/dashboard/web run build`
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add bridge/dashboard/web/src/components/RightPanel.tsx \
        bridge/dashboard/web/src/components/GitTab.tsx \
        bridge/dashboard/web/src/App.tsx
git commit -m "feat(dashboard): Git tab (branch, changes, commit, push) + controlled right panel"
```

---

## Task 6: Diff tab + parser

**Files:**
- Create: `bridge/dashboard/web/src/lib/diff.ts`
- Create: `bridge/dashboard/web/src/components/DiffTab.tsx`
- Modify: `bridge/dashboard/web/src/App.tsx` (render DiffTab in the diff tab)

**Interfaces:**
- Produces: `parseDiff(text:string): DiffRow[]` where `DiffRow = { ln: string; mark: string; text: string; kind: "add"|"del"|"ctx"|"hunk" }`. `DiffTab` props `{ file: { project:string; path:string } | null }`.
- Consumes: `api.gitDiff`.

- [ ] **Step 1: Create `lib/diff.ts`**

```ts
export interface DiffRow {
  ln: string;
  mark: string;
  text: string;
  kind: "add" | "del" | "ctx" | "hunk";
}

/** Parse a unified diff into display rows. Tracks the new-file line number for
 *  context/added lines; hunk headers reset it. Header lines (diff/index/---/+++)
 *  are dropped except the @@ hunk line. */
export function parseDiff(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let newLn = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@")) {
      const m = /\+(\d+)/.exec(line);
      newLn = m ? parseInt(m[1], 10) : 0;
      rows.push({ ln: "", mark: "@@", text: line, kind: "hunk" });
    } else if (line.startsWith("+++") || line.startsWith("---") ||
               line.startsWith("diff ") || line.startsWith("index ") ||
               line.startsWith("new file") || line.startsWith("deleted file") ||
               line.startsWith("similarity ") || line.startsWith("rename ") ||
               line.startsWith("\\ No newline")) {
      continue;
    } else if (line.startsWith("+")) {
      rows.push({ ln: String(newLn++), mark: "+", text: line.slice(1), kind: "add" });
    } else if (line.startsWith("-")) {
      rows.push({ ln: "", mark: "-", text: line.slice(1), kind: "del" });
    } else if (line.length > 0 || rows.length > 0) {
      rows.push({ ln: String(newLn++), mark: "", text: line.startsWith(" ") ? line.slice(1) : line, kind: "ctx" });
    }
  }
  return rows;
}
```

- [ ] **Step 2: Create `components/DiffTab.tsx`**

```tsx
import { useEffect, useState } from "react";
import { api } from "../api";
import { parseDiff, type DiffRow } from "../lib/diff";

const ROW: Record<DiffRow["kind"], { bg: string; sign: string; color: string }> = {
  add: { bg: "rgba(90,209,140,.08)", sign: "var(--success)", color: "#a7e6c3" },
  del: { bg: "rgba(229,115,107,.08)", sign: "var(--danger)", color: "#f0a9a3" },
  ctx: { bg: "transparent", sign: "var(--muted-2)", color: "#8a829e" },
  hunk: { bg: "rgba(139,109,255,.07)", sign: "var(--brand-soft)", color: "var(--brand-soft)" },
};

export function DiffTab({ file }: { file: { project: string; path: string } | null }) {
  const [rows, setRows] = useState<DiffRow[]>([]);
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    if (!file) return;
    let live = true;
    void (async () => {
      try {
        const r = await api.gitDiff(file.project, file.path);
        if (!live) return;
        const parsed = parseDiff(r.diff);
        setRows(parsed);
        setEmpty(parsed.length === 0);
      } catch {
        /* ignore */
      }
    })();
    return () => { live = false; };
  }, [file]);

  if (!file) return <div className="p-4 text-xs text-muted-foreground">Select a changed file in the Git tab.</div>;

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center gap-2 rounded-[9px] border border-border bg-card px-3 py-2 font-mono text-[11.5px] text-card-foreground">
        <span className="flex-1 truncate" style={{ direction: "rtl" }}>{file.path}</span>
      </div>
      <div className="overflow-hidden rounded-[9px] border border-border bg-[#100d18] font-mono text-[11.5px] leading-[1.75]">
        {empty ? (
          <div className="px-3 py-2 text-muted-2">No textual diff.</div>
        ) : (
          rows.map((d, i) => {
            const c = ROW[d.kind];
            return (
              <div key={i} className="flex" style={{ background: c.bg }}>
                <span className="w-[34px] shrink-0 select-none border-r border-[#1c1828] pr-2 text-right text-[#4a4460]">{d.ln}</span>
                <span className="w-3.5 shrink-0 px-1.5 text-center" style={{ color: c.sign }}>{d.mark}</span>
                <span className="flex-1 whitespace-pre" style={{ color: c.color }}>{d.text}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Render DiffTab in App**

In `bridge/dashboard/web/src/App.tsx`:
1. Import:
```tsx
import { DiffTab } from "./components/DiffTab";
```
2. Replace the diff tab entry in `panelTabs`:
```tsx
{ id: "diff", label: "Diff", render: () => <DiffTab file={diffFile} /> },
```

- [ ] **Step 4: Build**

Run: `npm --prefix /home/mhzrerfani/projects/mystical-assistant/bridge/dashboard/web run build`
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add bridge/dashboard/web/src/lib/diff.ts \
        bridge/dashboard/web/src/components/DiffTab.tsx \
        bridge/dashboard/web/src/App.tsx
git commit -m "feat(dashboard): Diff tab with unified-diff parser"
```

---

## Task 7: Integration verification

**Files:** none (verification only; commit any fixes).

- [ ] **Step 1: Backend tests + syntax**

Run:
```bash
python tests/test_git.py
python -c "import ast; ast.parse(open('bridge/dashboard/server.py').read()); print('OK')"
```
Expected: `8/8 passed`, `OK`.

- [ ] **Step 2: Build**

Run: `npm --prefix /home/mhzrerfani/projects/mystical-assistant/bridge/dashboard/web run build`
Expected: success.

- [ ] **Step 3: Headless smoke against a repo with changes**

Build a preview, point the dashboard at this repo (which has uncommitted changes during dev), and screenshot per the project's headless flow:
- Git tab shows branch card, changed files with +/−, commit box + Commit all / Push.
- Click a file → Diff tab shows the parsed unified diff.
- Sidebar shows a git badge line under the repo header.
(Use `?token=x` for the shell; the git endpoints require the bridge to be running for live data — if only previewing static assets, verify the tabs render their empty/disconnected states without errors.)

- [ ] **Step 4: Commit any fixes**

```bash
git add -A bridge
git commit -m "fix(dashboard): git intelligence integration fixes"
```

---

## Self-Review

**Spec coverage:**
- `bridge/git.py` status/badge/diff/commit/push + safety → Task 1. ✓
- Endpoints (git/all/diff read; commit/push write) → Task 2. ✓
- api.ts types + methods → Task 3. ✓
- Sidebar badges → Task 4. ✓
- Git tab (branch card, changes, commit, push) → Task 5. ✓
- Diff tab + parser → Task 6. ✓
- Controlled RightPanel for Git→Diff switch → Task 5. ✓
- pytest-style backend tests (temp repo, push to bare) → Task 1. ✓
- Build + smoke → Tasks 3–7. ✓

**Placeholder scan:** No "TBD/handle edge cases"; concrete code in every step. The Task 5 Diff-tab placeholder is intentional and explicitly replaced in Task 6. ✓

**Type consistency:** `GitStatus`/`GitFile`/`GitBadge` identical across api.ts, GitTab, Sidebar, App. `DiffRow` identical across diff.ts and DiffTab. `parseDiff` signature matches its consumer. `git.status` dict shape matches the `GitStatus` TS interface (`is_repo, branch, ahead, behind, dirty, files[{path,status,add,del}]`). Endpoint paths match `api.*` URLs. ✓

**Note:** `useCallback` is imported from "react" in GitTab — confirm React 19 export (it is). If a stricter lint flags the IIFE in Sidebar Step 2, it is valid TSX and builds; leave as-is.
