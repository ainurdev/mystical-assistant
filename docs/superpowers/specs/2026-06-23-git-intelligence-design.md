# Git Intelligence (Sub-project B)

**Date:** 2026-06-23
**Status:** Approved — ready for implementation plan
**Depends on:** Sub-project A (dashboard shell re-skin) — shipped.
**Source design:** Claude Design project "Mystical Assistant Dashboard" (`Mystical Assistant Dashboard.dc.html`)

## Context

Sub-project A shipped the dashboard re-skin with three deliberate placeholders.
B fills the git-shaped ones: per-repo status badges in the sidebar, the **Git**
tab, and the **Diff** tab. Unlike A, B adds a real Python backend — a new
`bridge/git.py` module plus dashboard endpoints — and includes git **write**
actions (stage-all + commit, push), matching the mockup's Git tab.

The bridge backend is stdlib-only and uses `subprocess` for external processes
(see `bridge/devserver.py`). Projects are addressed by a `BASE_PATH`-relative
path (`rel`) and resolved to an absolute path via the dashboard server's
`_abs_project`, which rejects anything outside `BASE_PATH`. B reuses that guard
for every git command's working directory.

## Goals

1. `bridge/git.py`: read git status/diff and perform commit/push for a repo,
   safely (path-guarded, timed out), stdlib-only, unit-tested.
2. Dashboard endpoints exposing status (full + lightweight batch), diff, commit,
   push.
3. Sidebar per-repo git badges (branch / dirty / ahead-behind).
4. **Git** tab (branch card, changed files, commit box, Commit all + Push).
5. **Diff** tab (unified diff for a selected changed file, mockup-styled).

## Non-goals (other sub-projects)

- Issues tab (Sub-project C).
- Command palette (Sub-project D).
- Multi-remote / branch-switching / stash / per-hunk staging. B stages all
  (`git add -A`) and pushes the current branch's default upstream, matching the
  mockup. No caching layer (repo count is small; YAGNI).

## Backend: `bridge/git.py`

Stdlib only. One private runner:

```
_run(cwd, *args, timeout=8) -> (rc:int, out:str, err:str)
    subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True,
                   timeout=timeout); rc 124-style sentinel on TimeoutExpired.
```

Public functions:

- `is_repo(cwd) -> bool` — `rev-parse --is-inside-work-tree` rc == 0.
- `badge(cwd) -> dict | None` — `{branch, ahead, behind, dirty}` from a single
  `git status --porcelain=v2 --branch`. `dirty` = count of changed entries
  (lines starting `1`/`2`/`u`/`?`). `None` if not a repo.
- `status(cwd) -> dict` — `{is_repo, branch, ahead, behind, dirty, files}` where
  `files: [{path, status, add, del}]`. Parses `--porcelain=v2 --branch` for
  branch header (`# branch.head <name>`, `# branch.ab +A -B`) and changed
  entries (XY status → single letter M/A/D/R/?; for renames `2` records the new
  path). Merges per-file line counts from `git diff --numstat` (unstaged) and
  `git diff --cached --numstat` (staged): `add`/`del` ints (`-` for binary → 0).
- `diff(cwd, path) -> str` — unified diff text for one file. `git diff HEAD --
  <path>`; if the file is untracked (appears in status as `?`), diff against the
  empty tree so new files render as all-additions. Returns "" if no change.
- `commit(cwd, message) -> (ok:bool, output:str)` — `git add -A`, then
  `git commit -m <message>`. `ok` false (with output) if nothing staged or
  commit fails.
- `push(cwd, timeout=30) -> (ok:bool, output:str)` — `git push`. Combined
  stdout+stderr returned for display.

**Safety:**

- Every `cwd` is the caller's already-`_abs_project`-validated absolute path.
- `diff` `path`: reject if `os.path.realpath(join(cwd, path))` is not inside
  `cwd`; always pass after `--`.
- `commit` message: stripped, non-empty enforced by caller, length-capped
  (e.g. 2000 chars) before use.
- Timeouts on all calls; a timeout returns an error result, never hangs.

## Backend: dashboard endpoints (`bridge/dashboard/server.py`)

Reads (added to `_get_api`, Host-gated):

- `GET /local/git?project=<rel>` → `git.status(abs)`; `{is_repo:false}` if the
  resolved dir isn't a repo, `{error:"invalid project"}` (400) if `_abs_project`
  rejects it.
- `GET /local/git/all` → `{repos: {"<rel>": {branch,ahead,behind,dirty}}}` for
  every distinct `project` among `store.list_sessions_all(chat)` that resolves
  and is a repo (uses `git.badge`).
- `GET /local/git/diff?project=<rel>&path=<file>` → `{path, diff}`.

Writes (added to `_post_api`, Host+Origin+token gated):

- `POST /local/git/commit` `{project, message}` → `{ok, output}`; 400 on empty
  message / invalid project.
- `POST /local/git/push` `{project}` → `{ok, output}`; 400 on invalid project.

## Frontend

### api.ts

```
GitFile   { path:string; status:string; add:number; del:number }
GitStatus { is_repo:boolean; branch:string; ahead:number; behind:number;
            dirty:number; files:GitFile[] }
GitBadge  { branch:string; ahead:number; behind:number; dirty:number }
api.git(project)              -> GitStatus
api.gitAll()                  -> { repos: Record<string, GitBadge> }
api.gitDiff(project, path)    -> { path:string; diff:string }
api.gitCommit(project, msg)   -> { ok:boolean; output:string }
api.gitPush(project)          -> { ok:boolean; output:string }
```

### Sidebar badges

App polls `/local/git/all` (~10s) into `gitBadges: Map<string, GitBadge>`, passed
to `Sidebar`. Each *Recent chats* per-repo header renders, when a badge exists, a
mono line: `⎇ <branch>` + `●<dirty>` (amber when >0) + `↑<ahead> ↓<behind>` — the
slot A left open. No separate "Projects" section is reintroduced.

### Git tab — `components/GitTab.tsx`

Props: `{ project: string | null; onOpenDiff: (path:string)=>void }`. Polls
`api.git(project)` (~4s) while mounted. Renders: branch card (`⎇ branch`,
`↑ahead ↓behind`, `origin/<branch>` line), `Changes · N files` list (status
letter colored A=green/M=amber/D=red, RTL-truncated path, `+add −del`), and a
commit card (textarea + **Commit all** / **Push**). Commit disabled while message
empty; after commit success, clears the box and refetches. Push shows its
`output`/error inline. Clicking a changed file calls `onOpenDiff(path)`.
Non-repo → "Not a git repository".

### Diff tab — `components/DiffTab.tsx` + `lib/diff.ts`

Props: `{ project: string | null; path: string | null }`. When `path` set,
fetches `api.gitDiff` and parses via `parseDiff(text)` →
`{ln:string, mark:string, text:string, kind:'add'|'del'|'ctx'|'hunk'}[]`,
tracking old/new line numbers from `@@` headers. Renders the mockup's diff rows
(line-number gutter, colored sign column, monospace). Empty state: "Select a
changed file in the Git tab."

`lib/diff.ts` `parseDiff` is pure and unit-test-friendly (though tested
informally; the spec's required tests are backend pytest).

### RightPanel → controlled

`RightPanel` gains optional `activeId` + `onActiveChange` props (controlled). App
lifts the active tab into state so `GitTab.onOpenDiff` can switch to the Diff tab.
Uncontrolled fallback retained for safety. App registers tabs **Git** (badge =
dirty count of active repo), **Diff**, **Logs**.

### App wiring

New state: `gitBadges`, `activeTab` ("git" default), `diffFile {project,path}|null`.
Active project for Git/Diff = `state.project.rel`. `onOpenDiff(path)` sets
`diffFile={project, path}` and `activeTab="diff"`.

## Error handling

- `_abs_project` rejection → 400 `{error}`; client shows inline message.
- Non-repo → `{is_repo:false}` → Git tab "Not a git repository", no badge.
- Subprocess timeout/failure → endpoint returns `{error}` or `{ok:false,output}`;
  Git tab surfaces it near the buttons.
- Polls swallow errors and reconcile next tick (existing pattern).

## Testing

- **pytest** `tests/test_git.py`: build a temp repo with `git init` +
  `user.email/name` config, create/modify/delete files, and assert:
  `is_repo` true/false; `status` branch + dirty count + file statuses + add/del;
  `diff` contains expected `+`/`-` lines; `commit` returns ok and clears dirty;
  `badge` ahead/behind after a commit against a tracking branch (or 0/0 with no
  upstream). Push is covered by a bare-repo remote: `commit` then `push`, assert
  `ok` and the remote received the ref. Path-escape guard: `diff(cwd, "../x")`
  rejected.
- **Build**: `tsc -b && vite build` for the dashboard after each frontend task.
- **Smoke**: headless dashboard screenshot (Git/Diff tabs visible) against a
  repo with changes.

## Rollout

B is shippable on top of A. The dashboard gains live git status, diff, and
commit/push for the active repo; the sidebar shows per-repo badges. C (Issues)
and D (palette) remain separate.
