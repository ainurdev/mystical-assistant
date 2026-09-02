# Linked repos — design

2026-09-02 · approved in chat, spec for review

## Problem

Some repos are one product: an endpoint changes in `mystical-assistant` and
the client in `apex` has to follow. Today a session is one repo — its claude
process runs with a single `cwd` and can only touch files under it — so the
second half of every such change means a second session, and a hand-carried
summary between the two.

`feat/shared-tasks` (13 commits, parked) answers this with *two* sessions
linked by a task: a `Delegate` tool, a shared scratchpad, and a turn-end poke
so each side wakes the other. It works, and it is the expensive shape: every
linked session is its own claude process — its own system prompt, graph pack,
CLAUDE.md and MCP startup per turn, its own context that has to be *told* what
the other side did — and the poke loop spends up to six extra full turns per
task. The brake in that spec's §4 exists because the loop is a spend risk.

Claude Code already has the cheap shape. `claude --add-dir <directories...>`
grants a session full tool access to more directories, and loads their
CLAUDE.md alongside the primary's (`claude --help`). One process, one context
that saw both changes, nothing to coordinate. The bridge passes nothing for it
today (`grep add-dir bridge/*.py` → no hits).

## Decisions taken before this spec

- **One session, many repos — not many sessions, one task.** The case that
  matters is *coupled* work, where the second change depends on the first.
  That wants one context, not two contexts and a courier. Parallel work in two
  repos at once is a different ask; `feat/shared-tasks` stays on its branch,
  recoverable, for the day it is made.
- **The link is per project, set once.** `apex ↔ mystical-assistant` is a fact
  about the repos, not about a session. A per-session pick (or a project
  default with per-session override) was offered and declined: every session
  in either repo gets the other, no per-session ceremony.
- **The link is symmetric.** Linking from either side means the same thing and
  shows in both modals. Written to both entries rather than computed as a
  union on read, so unlinking from one side is not silently undone by the
  other's entry.
- **Links live in `project_config`, not the DB and not `.mystical/`.**
  `bridge/project_config.py` is already the per-project settings store
  (`run_cmd`, `prod_url`, `design_project`, `hidden`, `learn_off`), keyed by
  the same rel the store uses. No migration, no new file format. A file in
  `.mystical/` was the first idea and loses to this on one point: it would
  be a second place per-project settings live.

## 1. Data (`bridge/project_config.py`)

One more project-wide field, `links`: a JSON list of project rels.

```python
def links(project: str) -> list[str]
def link(a: str, b: str) -> None      # adds b to a's list and a to b's
def unlink(a: str, b: str) -> None    # removes both directions
```

Project-wide like `hidden` and `learn_off` — never branch-scoped — so
`_get_field`/`_set_field` (string-valued, branch-aware) are not reused; the
three functions read and write the list directly under `_lock`, dropping an
empty list from the entry the way `_set_field` drops a blank value. A link to
self is ignored. Rels are stored as given; `_abs_project` validates them at
the HTTP edge, and the runner checks the directory exists at run time (a repo
deleted after linking must not break every run in its partner).

## 2. Runner (`bridge/runner.py`)

In `_base_cmd`, on a run with a `cwd` that is not an internal one-shot
(`skip_pack` is the marker the titler/commit-msg calls already carry):

```python
for r in project_config.links(rel(cwd)):
    d = os.path.join(config.BASE_PATH, r.lstrip("/"))
    if os.path.isdir(d):
        cmd += ["--add-dir", d]
```

On **every** run — `--resume` does not remember the flag. Claude Code applies
the session's permission mode to the added directories the same as to `cwd`,
so `acceptEdits` covers edits in the partner repo without a new prompt.

One sentence joins the appended system prompt when there are links:

```
Linked repos with full tool access: /home/me/projects/apex. A change here
often needs one there — make both in this session.
```

That sentence is the whole "notice" mechanism. `feat/shared-tasks` needed a
tool description to make the model pull a trigger; here the model has the
other repo in hand and only needs to be told to look. It sits with
`_LOG_NOTE` in `_compose_system_prompt`, not in the once-per-session graph
pack: links can change between turns.

## 3. Surfaces

Dashboard only. The Mini App and the bot get the runtime effect and nothing
else — the link is a repo setting, and repo settings are edited where the
other ones are.

- `GET /local/project/settings` gains `"links": [...]`.
- `POST /local/project/settings` accepts `"link": "<rel>"` and
  `"unlink": "<rel>"`, each resolved through `_abs_project` (400 on an unknown
  or out-of-base rel), and answers with the updated `links`.
- ANALYZE modal header (`AnalyzeModal.tsx`), after the ↑↓ counts: a `⇄ apex`
  chip per link — click to unlink — and a `⇄ LINK` button that opens the same
  popover the colour dot uses (`AnalyzeModal.tsx:189`), listing
  `api.projects()` minus self and minus the already linked, tick to link. The
  `ProjectSettings` type in `api.ts` gains `links: string[]`.

## 4. Testing

`tests/test_project_config.py`, against the `_PATH` monkeypatch the file
already uses:

- `link(a, b)` shows up in both `links(a)` and `links(b)`; `unlink` from
  either side clears both; a self-link is a no-op; an unknown project → `[]`.

`tests/test_bridge.py`, next to `test_interactive_base_cmd`:

- a linked project's run carries `--add-dir <abs>`; a link whose directory is
  gone is skipped; a `skip_pack` run carries none.
- the system prompt names the linked path when there is a link and is
  unchanged when there is none.

The endpoint is covered the way the other `/local/project/settings` fields
are, if at all — it is a two-line pass-through.

## What this does not build

A per-session override or opt-out; the FILES, EDITOR and GIT tabs for the
linked repo (they stay on the primary — open its own modal); graph pack for
the linked repo; a link that follows a matching worktree instead of the
partner's main checkout; a session chip (every session in a linked repo would
carry it — that is the modal header's job, once). Each is a separate ask.
`feat/shared-tasks` is parked, not deleted: it is the answer to *parallel*
work in two repos, which nobody has asked for yet.
