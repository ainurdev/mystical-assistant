# GitHub Issues Tab (Sub-project C)

**Date:** 2026-06-23
**Status:** Approved — ready for implementation plan
**Depends on:** Sub-projects A (shell) + B (right-panel tabs, controlled RightPanel) — shipped.
**Source design:** Claude Design project "Mystical Assistant Dashboard".

## Context

The dashboard's right panel hosts Git / Diff / Logs tabs (A+B). C adds the
**Issues** tab from the mockup: open/closed counts, issue cards with labels, and
an in-app "New issue" create form. Data comes from the user's already-authed
`gh` CLI (confirmed installed, logged in as `mhzrerfani`); the bridge backend
shells out to it, deriving the GitHub slug from the repo's `origin` remote. A new
`bridge/github.py` module mirrors `bridge/git.py`'s subprocess pattern.

Per the approved scope, "New issue" is a real in-app create form backed by a
write endpoint (`gh issue create`), matching B's commit/push parity.

## Goals

1. `bridge/github.py`: derive a GitHub slug from a repo and list/create issues via
   `gh`, with a unit-tested pure slug parser.
2. Dashboard endpoints: read issues; create an issue (token-gated).
3. **Issues** tab: counts, issue cards (labels with real colors, click-to-open on
   github.com), and an inline create form.

## Non-goals

- Command palette (Sub-project D).
- Editing/closing/commenting on issues; PRs; non-`origin` remotes; issue search/
  filter UI. C lists open issues and creates new ones. (Closed issues are a count
  only.)
- Token management: auth is delegated entirely to `gh`.

## Backend: `bridge/github.py`

Stdlib + `gh`/`git` subprocess. One `_run(*args, cwd=None, timeout=15)` helper.

- `_parse_slug(url: str) -> str | None` — **pure**, the unit-tested core.
  Accepts `https://github.com/<owner>/<repo>`, `https://github.com/<owner>/<repo>.git`,
  `git@github.com:<owner>/<repo>.git`, with/without trailing slash; returns
  `"<owner>/<repo>"`. Any non-github.com host or unparseable input → `None`.
- `remote_slug(cwd: str) -> str | None` — `git -C cwd remote get-url origin`
  piped through `_parse_slug`.
- `issues(cwd: str) -> dict` — returns:
  ```
  {has_remote: bool, slug: str|None, gh_ok: bool, error: str,
   open_count: int, closed_count: int,
   issues: [{number:int, title:str, url:str, updated:str,
             labels:[{name:str, color:str}]}]}
  ```
  Steps: `slug = remote_slug(cwd)`; if `None` → `{has_remote:False, gh_ok:False, …}`.
  Else `gh issue list -R <slug> --state open --limit 30 --json
  number,title,url,updatedAt,labels`. `open_count` = `len(list)` when `< 30`,
  else a `gh api "search/issues?q=repo:<slug>+type:issue+state:open&per_page=1"
  --jq .total_count` call. `closed_count` = the same search with `state:closed`.
  If a `gh` call fails (missing binary, not authed, rate limit) →
  `{has_remote:True, slug, gh_ok:False, error:<stderr>, issues:[], …}`.
  Map each issue's `labels` to `{name, color}` (gh gives 6-hex `color` without
  `#`) and `updatedAt` → `updated`.
- `create_issue(cwd: str, title: str, body: str) -> tuple[bool, str]` —
  `gh issue create -R <slug> --title <title> --body <body>`; returns
  `(rc==0, stdout+stderr)` (stdout is the new issue URL on success). Caller
  enforces non-empty title; slug `None` → `(False, "no GitHub remote")`.

Safety/robustness: `cwd` is `_abs_project`-validated; title/body length-capped by
the endpoint; all subprocess calls timed out.

## Backend: endpoints (`bridge/dashboard/server.py`)

- `GET /local/github/issues?project=<rel>` (in `_get_api`, Host-gated) →
  `github.issues(abs)`; `{error:"invalid project"}` (400) if `_abs_project` rejects.
- `POST /local/github/issue` (in `_post_api`, Host+Origin+token-gated)
  `{project, title, body}` → `{ok, output}`; 400 on invalid project / empty title
  (title capped 256, body capped 65536).

## Frontend

### api.ts
```
GitHubLabel { name:string; color:string }
Issue       { number:number; title:string; url:string; updated:string;
              labels:GitHubLabel[] }
IssuesInfo  { has_remote:boolean; slug:string|null; gh_ok:boolean; error:string;
              open_count:number; closed_count:number; issues:Issue[] }
api.issues(project)               -> IssuesInfo
api.createIssue(project, t, body) -> { ok:boolean; output:string }
```

### IssuesTab — `components/IssuesTab.tsx`
Props `{ project: string | null }`. Mounts only when the Issues tab is active
(RightPanel renders the active tab only), so it fetches `gh` on mount + a slow
60s refresh while open. Renders:
- header: `● <open_count> open` / `✓ <closed_count> closed`, and a **New issue**
  toggle.
- create form (collapsed by default): title input + body textarea + **Create** /
  **Cancel**; on success clears, collapses, refetches; failure shows inline.
- issue cards: open-state circle, title, `#<number>`, label pills using each
  label's real `#<color>`, and "ago"; clicking opens `url` in a new tab
  (`<a target="_blank" rel="noreferrer">`).
- empty/error states: "No GitHub remote." (`!has_remote`); "GitHub CLI
  unavailable" + `error` (`!gh_ok`); "No open issues." (empty list).

### App wiring
Register the Issues tab; tab order **Git · Issues · Diff · Logs**. Issues-tab
`badge` = `open_count` (when > 0) for the active project — but to avoid a
background fetch just for the badge, the badge derives from the IssuesTab's own
fetched state is NOT possible across unmounts, so the **badge is omitted** (the
tab fetches lazily; no always-on issues poll). Active project = `state.project.rel`.

## Error handling

- Invalid project → 400 `{error}` → inline message.
- No `origin` / non-GitHub remote → `has_remote:false` → "No GitHub remote".
- `gh` missing/unauthed/rate-limited → `gh_ok:false` + `error` surfaced.
- Create failure → inline `output`.
- Fetch errors swallowed; the tab keeps its last state.

## Testing

- **`tests/test_github.py`** (plain script, existing runner convention):
  exhaustive `_parse_slug` cases — https, https+`.git`, ssh `git@`, trailing
  slash, uppercase host, non-github (gitlab/bitbucket) → None, empty → None; plus
  `remote_slug` against a temp repo with a fake `origin` set via
  `git remote add`. The `gh`-calling functions are NOT mocked.
- **End-to-end HTTP smoke** (manual, like B): run the dashboard server against
  this repo; `GET /local/github/issues?project=/mystical-assistant` →
  `has_remote:true`, `slug:"mhzrerfani/mystical-assistant"`, `gh_ok:true`,
  `issues:[]` (repo currently has none), counts present.
- **Build:** `tsc -b && vite build`.
- **Screenshot** if the libasound screenshot dependency is restored.

## Rollout

C layers onto A+B via the existing tab registry. D (command palette) remains.
