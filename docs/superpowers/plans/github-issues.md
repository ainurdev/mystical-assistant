# GitHub Issues Tab (Sub-project C) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the right-panel **Issues** tab — open/closed counts, issue cards with labels, and an in-app "New issue" create form — backed by a new `bridge/github.py` module that shells out to the authed `gh` CLI.

**Architecture:** `bridge/github.py` derives the GitHub slug from a repo's `origin` remote (pure, tested parser) and calls `gh issue list` / `gh api search/issues` / `gh issue create`. Dashboard endpoints expose read (issues) + token-gated write (create). The Issues tab mounts lazily (RightPanel renders only the active tab) so `gh` is called only when the tab is open.

**Tech Stack:** Python 3 stdlib + `gh` CLI; React 19 + Vite + Tailwind v4 + TypeScript.

## Global Constraints

- `bridge/github.py` is stdlib + subprocess only. All `gh`/`git` calls go through one `_run(*args, cwd=None, timeout=15)` helper with a timeout.
- `gh issue create` MUST always pass `--body` (even `""`) so `gh` never opens an interactive prompt and hangs.
- Slug is derived from the `origin` remote only. Non-GitHub origin → `has_remote:false`.
- `cwd` for every call is an `_abs_project`-validated absolute path (inside `BASE_PATH`). The create endpoint caps title (256) and body (65536) and requires a non-empty title.
- Write endpoint (`/local/github/issue`) goes in `_post_api` (Host+Origin+token gated). Read (`/local/github/issues`) in `_get_api` (Host-gated).
- Tests are plain scripts: `python tests/test_github.py` (no pytest). Use the existing `test_*` + `__main__` runner convention.
- Frontend per-task verification = `npm --prefix /home/mhzrerfani/projects/mystical-assistant/bridge/dashboard/web run build`.
- Tab order after this work: **Git · Issues · Diff · Logs**. The Issues tab has no count badge (it fetches lazily; no always-on issues poll).
- Match existing style (stdlib module fns returning dicts/tuples; functional React components with the A/B tokens).

---

## File Structure

**Backend:**
- Create `bridge/github.py` — slug parse, list issues, create issue.
- Create `tests/test_github.py` — `_parse_slug` / `remote_slug` tests.
- Modify `bridge/dashboard/server.py` — issues read + create write endpoints.

**Frontend:**
- Modify `bridge/dashboard/web/src/api.ts` — issue types + methods.
- Create `bridge/dashboard/web/src/components/IssuesTab.tsx`.
- Modify `bridge/dashboard/web/src/App.tsx` — register the Issues tab.

---

## Task 1: `bridge/github.py` + tests (TDD)

**Files:**
- Create: `bridge/github.py`
- Create: `tests/test_github.py`

**Interfaces:**
- Produces: `_parse_slug(url)->str|None`, `remote_slug(cwd)->str|None`, `issues(cwd)->dict`, `create_issue(cwd,title,body)->(bool,str)`. `issues` dict: `{has_remote, slug, gh_ok, error, open_count, closed_count, issues:[{number,title,url,updated,labels:[{name,color}]}]}`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_github.py`:
```python
"""Unit tests for bridge/github.py slug parsing. Run: python tests/test_github.py"""

import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ.setdefault("BASE_PATH", "/tmp")
os.environ.setdefault("BRIDGE_DB", os.path.join(tempfile.mkdtemp(), "t.db"))

from bridge import github as gh  # noqa: E402


def test_parse_https_git():
    assert gh._parse_slug("https://github.com/owner/repo.git") == "owner/repo"


def test_parse_https_plain():
    assert gh._parse_slug("https://github.com/owner/repo") == "owner/repo"


def test_parse_ssh():
    assert gh._parse_slug("git@github.com:owner/repo.git") == "owner/repo"


def test_parse_trailing_slash():
    assert gh._parse_slug("https://github.com/owner/repo/") == "owner/repo"


def test_parse_uppercase_host():
    assert gh._parse_slug("https://GitHub.com/owner/repo.git") == "owner/repo"


def test_parse_dotted_repo():
    assert gh._parse_slug("https://github.com/owner/repo.io") == "owner/repo.io"


def test_parse_non_github():
    assert gh._parse_slug("https://gitlab.com/owner/repo.git") is None
    assert gh._parse_slug("git@bitbucket.org:owner/repo.git") is None


def test_parse_garbage():
    assert gh._parse_slug("") is None
    assert gh._parse_slug("not a url") is None
    assert gh._parse_slug("https://github.com/owner") is None


def test_remote_slug_from_repo():
    d = tempfile.mkdtemp()
    subprocess.run(["git", "init", "-q", d], check=True)
    subprocess.run(["git", "-C", d, "remote", "add", "origin",
                    "https://github.com/acme/widget.git"], check=True)
    assert gh.remote_slug(d) == "acme/widget"


def test_remote_slug_none():
    d = tempfile.mkdtemp()
    subprocess.run(["git", "init", "-q", d], check=True)
    assert gh.remote_slug(d) is None


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

Run: `python tests/test_github.py`
Expected: FAIL — `ImportError: cannot import name 'github'`.

- [ ] **Step 3: Implement `bridge/github.py`**

```python
"""List and create GitHub issues for a repo via the user's authed `gh` CLI.
Stdlib + subprocess; the slug is derived from the repo's `origin` remote."""

import json
import re
import subprocess

_SLUG_RE = re.compile(
    r"^(?:https?://github\.com/|git@github\.com:)([^/]+)/(.+?)(?:\.git)?/?$",
    re.IGNORECASE,
)


def _parse_slug(url: str) -> str | None:
    m = _SLUG_RE.match((url or "").strip())
    if not m:
        return None
    owner, repo = m.group(1), m.group(2)
    if not owner or not repo:
        return None
    return f"{owner}/{repo}"


def _run(*args: str, cwd: str | None = None, timeout: int = 15) -> tuple[int, str, str]:
    try:
        p = subprocess.run(list(args), capture_output=True, text=True,
                           timeout=timeout, cwd=cwd)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "timed out"
    except OSError as e:
        return 127, "", str(e)


def remote_slug(cwd: str) -> str | None:
    rc, out, _ = _run("git", "-C", cwd, "remote", "get-url", "origin")
    return _parse_slug(out) if rc == 0 else None


def _count(slug: str, state: str) -> int:
    rc, out, _ = _run(
        "gh", "api",
        f"search/issues?q=repo:{slug}+type:issue+state:{state}&per_page=1",
        "--jq", ".total_count")
    try:
        return int(out.strip())
    except ValueError:
        return 0


def issues(cwd: str) -> dict:
    slug = remote_slug(cwd)
    if slug is None:
        return {"has_remote": False, "slug": None, "gh_ok": False, "error": "",
                "open_count": 0, "closed_count": 0, "issues": []}
    rc, out, err = _run("gh", "issue", "list", "-R", slug, "--state", "open",
                        "--limit", "30", "--json",
                        "number,title,url,updatedAt,labels")
    if rc != 0:
        return {"has_remote": True, "slug": slug, "gh_ok": False,
                "error": err.strip() or "gh failed", "open_count": 0,
                "closed_count": 0, "issues": []}
    try:
        raw = json.loads(out or "[]")
    except ValueError:
        raw = []
    items = [{
        "number": i.get("number"),
        "title": i.get("title", ""),
        "url": i.get("url", ""),
        "updated": i.get("updatedAt", ""),
        "labels": [{"name": l.get("name", ""), "color": l.get("color", "")}
                   for l in (i.get("labels") or [])],
    } for i in raw]
    open_count = len(items) if len(items) < 30 else _count(slug, "open")
    return {"has_remote": True, "slug": slug, "gh_ok": True, "error": "",
            "open_count": open_count, "closed_count": _count(slug, "closed"),
            "issues": items}


def create_issue(cwd: str, title: str, body: str) -> tuple[bool, str]:
    slug = remote_slug(cwd)
    if slug is None:
        return False, "no GitHub remote"
    rc, out, err = _run("gh", "issue", "create", "-R", slug,
                        "--title", title, "--body", body or "", timeout=30)
    return rc == 0, (out + err).strip()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python tests/test_github.py`
Expected: `10/10 passed`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add bridge/github.py tests/test_github.py
git commit -m "feat(github): bridge/github.py — slug parse + list/create issues via gh"
```

---

## Task 2: Dashboard issues endpoints

**Files:**
- Modify: `bridge/dashboard/server.py`

**Interfaces:**
- Consumes: `bridge.github` (Task 1), `_abs_project`.
- Produces: `GET /local/github/issues`; `POST /local/github/issue`.

- [ ] **Step 1: Import github in server.py**

In `bridge/dashboard/server.py`, add `github` to the bridge import (alphabetical, after `git`):
```python
from bridge import (browser, config, devserver, git, github, machine, native,
                    pubsub, runner, state, store, tunnel, usage)
```

- [ ] **Step 2: Add the read endpoint in `_get_api`**

In `_get_api`, just before the final `return self._json({"error": "not found"}, 404)`, add:
```python
        if path == "/local/github/issues":
            abs_p = _abs_project(qs.get("project", [None])[0])
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            return self._json(github.issues(abs_p))
```

- [ ] **Step 3: Add the write endpoint in `_post_api`**

In `_post_api`, just before the final `return self._json({"error": "not found"}, 404)`, add:
```python
        if path == "/local/github/issue":
            abs_p = _abs_project(body.get("project"))
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            title = (body.get("title") or "").strip()[:256]
            if not title:
                return self._json({"error": "empty title"}, 400)
            body_text = (body.get("body") or "")[:65536]
            ok, output = github.create_issue(abs_p, title, body_text)
            return self._json({"ok": ok, "output": output})
```

- [ ] **Step 4: Verify import / syntax**

Run:
```bash
python -c "import ast; ast.parse(open('bridge/dashboard/server.py').read()); print('server.py OK')"
TELEGRAM_BOT_TOKEN=x ALLOWED_CHAT_IDS=1 BASE_PATH=/tmp BRIDGE_DB=/tmp/c.db python -c "from bridge.dashboard import server; print('import OK')"
python tests/test_github.py | tail -1
```
Expected: `server.py OK`, `import OK`, `10/10 passed`.

- [ ] **Step 5: Commit**

```bash
git add bridge/dashboard/server.py
git commit -m "feat(dashboard): GitHub issues read + create endpoints"
```

---

## Task 3: Frontend issues API

**Files:**
- Modify: `bridge/dashboard/web/src/api.ts`

**Interfaces:**
- Produces: `GitHubLabel`, `Issue`, `IssuesInfo` types; `api.issues`, `api.createIssue`.

- [ ] **Step 1: Add types**

In `bridge/dashboard/web/src/api.ts`, after the `GitBadge` interface, add:
```ts
export interface GitHubLabel {
  name: string;
  color: string;
}
export interface Issue {
  number: number;
  title: string;
  url: string;
  updated: string;
  labels: GitHubLabel[];
}
export interface IssuesInfo {
  has_remote: boolean;
  slug: string | null;
  gh_ok: boolean;
  error: string;
  open_count: number;
  closed_count: number;
  issues: Issue[];
}
```

- [ ] **Step 2: Add api methods**

In the `export const api = { … }` object, after the `gitPush` entry, add:
```ts
  issues: (project: string) =>
    req<IssuesInfo>(`/local/github/issues?project=${encodeURIComponent(project)}`),
  createIssue: (project: string, title: string, body: string) =>
    req<{ ok: boolean; output: string }>("/local/github/issue", {
      method: "POST",
      body: { project, title, body },
    }),
```

- [ ] **Step 3: Build**

Run: `npm --prefix /home/mhzrerfani/projects/mystical-assistant/bridge/dashboard/web run build`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add bridge/dashboard/web/src/api.ts
git commit -m "feat(dashboard): GitHub issues API types + methods"
```

---

## Task 4: IssuesTab + App registration

**Files:**
- Create: `bridge/dashboard/web/src/components/IssuesTab.tsx`
- Modify: `bridge/dashboard/web/src/App.tsx`

**Interfaces:**
- Consumes: `api.issues`, `api.createIssue`, `IssuesInfo`, `ago` from `lib/surfaces`.
- Produces: `IssuesTab` props `{ project: string | null }`; registered as the `issues` tab.

- [ ] **Step 1: Create `components/IssuesTab.tsx`**

```tsx
import { useCallback, useEffect, useState } from "react";
import { api, type IssuesInfo } from "../api";
import { ago } from "../lib/surfaces";

export function IssuesTab({ project }: { project: string | null }) {
  const [info, setInfo] = useState<IssuesInfo | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!project) return;
    try {
      setInfo(await api.issues(project));
    } catch {
      /* ignore */
    }
  }, [project]);

  useEffect(() => {
    let live = true;
    void refresh();
    const id = setInterval(() => {
      if (live) void refresh();
    }, 60000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [refresh]);

  if (!project) return <div className="p-4 text-xs text-muted-foreground">No project selected.</div>;
  if (info && !info.has_remote)
    return <div className="p-4 text-xs text-muted-foreground">No GitHub remote.</div>;
  if (info && !info.gh_ok)
    return (
      <div className="p-4 text-xs text-muted-foreground">
        GitHub CLI unavailable.
        {info.error ? <div className="mt-1 font-mono text-[10.5px] text-muted-2">{info.error}</div> : null}
      </div>
    );

  async function create() {
    if (!project || !title.trim()) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await api.createIssue(project, title.trim(), body);
      if (r.ok) {
        setTitle("");
        setBody("");
        setCreating(false);
        await refresh();
      } else {
        setNote(r.output || "Create failed.");
      }
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex gap-3.5 font-mono text-xs">
          <span className="text-card-foreground">● {info?.open_count ?? 0} open</span>
          <span className="text-muted-2">✓ {info?.closed_count ?? 0} closed</span>
        </div>
        <button
          onClick={() => setCreating((v) => !v)}
          className="text-[11px] text-brand-soft hover:text-foreground"
        >
          {creating ? "Cancel" : "New issue"}
        </button>
      </div>

      {creating && (
        <div className="mb-3 rounded-[10px] border border-border bg-card p-3 animate-[mpop_.14s_ease]">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Issue title"
            className="w-full bg-transparent text-[13px] outline-none placeholder:text-[#5a5470]"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            placeholder="Describe the issue…"
            className="mt-2 w-full resize-none bg-transparent text-[12.5px] outline-none placeholder:text-[#5a5470]"
          />
          <div className="mt-2 flex justify-end gap-2">
            <button
              onClick={() => setCreating(false)}
              className="rounded-lg border border-input bg-secondary px-3 py-1.5 text-[12px] text-foreground hover:bg-accent"
            >
              Cancel
            </button>
            <button
              onClick={() => void create()}
              disabled={busy || !title.trim()}
              className="rounded-lg border border-brand-soft bg-primary px-3.5 py-1.5 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-40"
            >
              Create
            </button>
          </div>
          {note && <div className="mt-2 font-mono text-[10.5px] text-danger">{note}</div>}
        </div>
      )}

      {info?.issues.map((i) => (
        <a
          key={i.number}
          href={i.url}
          target="_blank"
          rel="noreferrer"
          className="mb-2 block rounded-[10px] border border-border bg-card p-3 hover:border-ring"
        >
          <div className="flex gap-2.5">
            <span className="mt-0.5 h-3 w-3 shrink-0 rounded-full border-2 border-success" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] leading-snug text-card-foreground">{i.title}</div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <span className="font-mono text-[10.5px] text-muted-2">#{i.number}</span>
                {i.labels.map((l) => (
                  <span
                    key={l.name}
                    className="rounded-full px-2 text-[10px]"
                    style={{
                      color: `#${l.color}`,
                      background: `#${l.color}22`,
                      border: `1px solid #${l.color}55`,
                    }}
                  >
                    {l.name}
                  </span>
                ))}
                <span className="ml-auto font-mono text-[10.5px] text-muted-2">
                  {ago(new Date(i.updated).getTime() / 1000)}
                </span>
              </div>
            </div>
          </div>
        </a>
      ))}
      {info && info.issues.length === 0 && !creating && (
        <div className="px-1 py-2 text-xs text-muted-foreground">No open issues.</div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Register the Issues tab in App**

In `bridge/dashboard/web/src/App.tsx`:
1. Import:
```tsx
import { IssuesTab } from "./components/IssuesTab";
```
2. In the `panelTabs` array, insert an Issues entry between the `git` and `diff` entries:
```tsx
    { id: "issues", label: "Issues", render: () => <IssuesTab project={activeProject} /> },
```
   The final order must be `git`, `issues`, `diff`, `logs`.

- [ ] **Step 3: Build**

Run: `npm --prefix /home/mhzrerfani/projects/mystical-assistant/bridge/dashboard/web run build`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add bridge/dashboard/web/src/components/IssuesTab.tsx bridge/dashboard/web/src/App.tsx
git commit -m "feat(dashboard): Issues tab — list + in-app create via gh"
```

---

## Task 5: Integration verification

**Files:** none (verification only).

- [ ] **Step 1: Backend tests + syntax**

Run:
```bash
python tests/test_github.py | tail -1
python tests/test_git.py | tail -1
python -c "import ast; ast.parse(open('bridge/dashboard/server.py').read()); print('OK')"
```
Expected: `10/10 passed`, `8/8 passed`, `OK`.

- [ ] **Step 2: End-to-end HTTP smoke**

Run a throwaway dashboard server against this repo and hit the issues endpoint
(read-only — do NOT create a real issue in the smoke):
```bash
cat > /tmp/issues_smoke.py <<'PY'
import os, tempfile, time, urllib.request, json
os.environ.update({"TELEGRAM_BOT_TOKEN":"12345:T","ALLOWED_CHAT_IDS":"555",
    "BASE_PATH":"/home/mhzrerfani/projects","BRIDGE_DB":os.path.join(tempfile.mkdtemp(),"t.db"),
    "DASH_PORT":"8803","DASH_TOKEN":"tok","DASH_CHAT_ID":"555"})
from bridge import store; store.init()
from bridge.dashboard import server; server.start(); time.sleep(0.5)
HOST="127.0.0.1:8803"
r=urllib.request.urlopen(urllib.request.Request(
    f"http://{HOST}/local/github/issues?project=/mystical-assistant",headers={"Host":HOST}),timeout=20)
d=json.loads(r.read())
print("has_remote:",d["has_remote"],"slug:",d["slug"],"gh_ok:",d["gh_ok"],
      "open:",d["open_count"],"closed:",d["closed_count"],"n_issues:",len(d["issues"]))
server.stop()
PY
PYTHONPATH=/home/mhzrerfani/projects/mystical-assistant python /tmp/issues_smoke.py
```
Expected: `has_remote: True slug: mhzrerfani/mystical-assistant gh_ok: True …`.

- [ ] **Step 3: Build**

Run: `npm --prefix /home/mhzrerfani/projects/mystical-assistant/bridge/dashboard/web run build`
Expected: success.

- [ ] **Step 4: Screenshot (if libasound restored)**

If the headless screenshot dependency is available, capture the dashboard with the
Issues tab selected against a repo that has issues; otherwise note it was skipped.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A bridge
git commit -m "fix(dashboard): GitHub issues integration fixes"
```

---

## Self-Review

**Spec coverage:**
- `github.py` slug parse + issues + create → Task 1. ✓
- Endpoints (issues read, issue create write) → Task 2. ✓
- api.ts types + methods → Task 3. ✓
- IssuesTab (counts, cards, labels, click-to-open, create form) + tab registration → Task 4. ✓
- Pure `_parse_slug` exhaustive tests + `remote_slug` → Task 1. ✓
- HTTP smoke + build → Task 5. ✓
- Tab order Git·Issues·Diff·Logs, no Issues badge → Task 4 + constraints. ✓

**Placeholder scan:** No "TBD/handle edge cases"; concrete code throughout. ✓

**Type consistency:** `IssuesInfo`/`Issue`/`GitHubLabel` identical across api.ts, IssuesTab. `issues()` dict shape matches `IssuesInfo` (`has_remote, slug, gh_ok, error, open_count, closed_count, issues[{number,title,url,updated,labels[{name,color}]}]`). Endpoint paths match `api.issues`/`api.createIssue` URLs/bodies. `ago` consumed with epoch seconds (ISO converted via `new Date(...).getTime()/1000`). ✓

**Note:** `gh issue create` always receives `--body` (possibly `""`) to avoid an interactive prompt — encoded in `create_issue` and the global constraints.
