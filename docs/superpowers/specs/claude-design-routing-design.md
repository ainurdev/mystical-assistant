# Claude Design routing

Make a design-related prompt reach the repo's **Claude Design** design system
without anyone typing "use the design system", and let the work flow back up so
the design project stops drifting from the code.

Claude Design is a design-system store on claude.ai, reached through the
`DesignSync` tool: `list_projects` / `list_files` / `get_file` to read,
`finalize_plan` → `write_files` / `delete_files` to write. This repo already has
a project there — **Mystical Assistant Design System**
(`24409d88-c74d-4d26-becb-69672612173f`, `type: PROJECT_TYPE_DESIGN_SYSTEM`,
`canEdit: true`) — holding tokens, four component groups, guidelines, and
UI-kit recreations of both surfaces. Nothing in the repo points at it and it has
not been touched since 2026-07-02.

The feature hangs off seams the bridge already owns: per-project settings in
`project_config.py`, project-scoped skills in `skills.py`, the feature register
in `aifeatures.py`, and the dashboard route table.

## Decisions locked (during brainstorming)

- **No bridge-side classifier.** The routing decision is made by Claude Code's
  own skill mechanism, not by a model call the bridge pays for. See
  "Why no classifier" below — this is the decision the rest of the design hangs
  on.
- **Two-way sync.** Design work reads the system as source of truth *and* pushes
  changed components back up. Read-only was rejected: at 6 weeks and 136 UI
  commits of drift, a read-only link teaches Claude components that no longer
  match the HUD.
- **Push before pull, once.** The initial reconciliation runs upward first —
  bring the design project level with the real dashboard — and only then
  materialise it as a skill. Materialising first would bake the drift in.
- **Any repo, linked per project.** The link is a per-project setting, not a
  hardcode. Auto-matched by name where it is obvious, overridable from the
  dashboard. A repo with no link costs nothing.
- **No auto-creation.** A design prompt in an unlinked repo does not create a
  claude.ai project. Linking is a deliberate press.
- **Every write is confirmed.** `finalize_plan` shows the user the exact path
  list and source directory independent of Claude's narration. Nothing syncs up
  silently, and sync is per-component, never a wholesale replace.

## Why no classifier

The obvious reading of "route design prompts to Claude Design" is a bridge-side
check on each incoming prompt, in the shape of `relevance.py`'s new-session
guard. Two constraints rule it out.

**The prompt cache.** `runner.py:113-121` records the measurement: packs are
appended once per session because re-writing `--append-system-prompt`
invalidates the cached prefix — one added pack line moved ~11k tokens from
`cache_read` to `cache_create`, a ~12x price step on that segment, and on a
resumed session the invalidated span is the whole transcript. A classifier that
decides "design" on turn 5 and injects the system then is precisely that worst
case, on the sessions most likely to hit it.

**`DesignSync` is a model tool, not a Python API.** The bridge cannot call it.
Every read and write happens inside a Claude Code run regardless, so a
bridge-side decision would only be deciding what to tell a run that has the tool
already.

A skill answers both. A skill's `name` and `description` sit in context; the
body loads only when the model judges the prompt a match. That is per-prompt
routing, model-decided, at no extra call and no cache churn — the same shape as
`ponytail`'s "no extra call, a system prompt per run" line in the AI tab. The
design project already ships a `SKILL.md` written for it
(`name: mystical-assistant-design`, `user-invocable: true`) describing the
phosphor-CRT brand in enough detail to match on.

So the routing is not built. It is enabled, by getting the design system onto
disk as a project skill.

## The link: `bridge/project_config.py`

One new field, `design_project`, holding the DesignSync `projectId`. It joins
`run_cmd` and `prod_url` in the same per-path JSON next to the bridge DB, and
inherits their per-branch key and directory-only fallback unchanged.

- `design_project(project, branch=None) -> str | None`
- `set_design_project(project, project_id, branch=None) -> str | None`

Following the existing `_get_field` / `_set_field` pair; the empty string clears
the link. Storing the id rather than the name means a renamed design project
keeps working.

**Auto-match** is a suggestion, never a write. When the dashboard opens the
picker for an unlinked repo it offers the `list_projects` entry whose name
slug-matches the repo directory (`mystical-assistant` →
`Mystical Assistant Design System`). The user still presses. Nothing is linked
by inference alone.

## The pull: a third skill source in `bridge/skills.py`

`skills.py` already owns the target shape: project skills at
`<project>/.claude/skills/<id>/SKILL.md`, a `.installed-from-catalog` marker so
only bridge-installed directories may be removed or overwritten, `_front_matter`
parsing, drift detection via `_digest`, and a SKILLS panel that lists them.
A design project becomes a third source alongside the catalog's `steps` and
`url`.

Because `DesignSync` is only reachable from inside a run, the bridge does not
fetch. It **queues a prompt** into a session — the dashboard's existing path for
starting work — asking Claude to materialise the linked project into
`<repo>/.claude/skills/<slug>/`: `list_files`, then `get_file` for `SKILL.md`,
`readme.md`, `styles.css`, `tokens/*`, `guidelines/*`, and each component's
`.d.ts` + `.prompt.md`.

Excluded from the pull, deliberately: `_ds_bundle.js` (a compiled artifact the
repo does not consume), `ui_kits/` and `templates/` (recreations of surfaces the
repo has for real — the code is the truth here), and `uploads/`. The skill is
guidance and tokens, not a second copy of the app.

A distinct marker file, carrying the `projectId` and the pulled paths, keeps
provenance: the SKILLS panel can then show the skill as design-sourced and offer
re-pull rather than the catalog's update check.

## The push: SYNC

After a turn touches UI files in a linked repo, the dashboard surfaces a SYNC
action. It queues a prompt asking Claude to diff the repo's components against
the design project and push what changed: `list_files` and `get_file` to
compare, `finalize_plan` with the exact write paths, then `write_files` reading
from disk by `localPath` so component contents never enter the model's context.

Per-component and additive. Deletions are proposed, never bundled — a component
missing locally is more often a rename than a removal.

The first run of this is the reconciliation described above: the design project
is 136 UI commits behind, so the initial push is substantial and is best done
once, deliberately, before any pull.

## The switch: `bridge/aifeatures.py`

A `design` entry in `FEATURES`, so the feature is visible and stoppable from the
one place every model-spending feature is listed:

- `key`: `design`
- `env`: `DESIGN_SYNC_ENABLE`
- `label`: `DESIGN SYSTEM`
- `hint`: links a repo to its Claude Design system
- `cost`: `no extra call, a skill per linked repo`
- `about`: the paragraph — a linked repo's design system is pulled down as a
  project skill, so a design prompt reaches the real tokens and components
  instead of improvised CSS, and finished work syncs back up. Off, the link
  picker and the SYNC action leave the dashboard and nothing is materialised;
  an already-pulled skill stays on disk.

Ships **ON** (`DESIGN_SYNC_ENABLE` defaults to `"1"`, joining `PONYTAIL_ENABLE`,
`GRAPH_ENABLE` and `COMMIT_MSG_AI` at `config.py:189-204`). By `aifeatures.py`'s
own rule, only features that run when nobody pressed anything ship off —
`nextup` and `learn`, both `"0"`. Nothing here fires on its own: linking,
pulling and syncing are all presses, and an unlinked repo is untouched. On, the
switch's job is visibility — it is where you go to see that the bridge can reach
an external design store at all, and to stop it.

Precedence is `ladder.default_policy`'s, unchanged: persisted setting, then
`config.DESIGN_SYNC_ENABLE`, then off.

## Dashboard

Both controls live behind the switch, following the established pattern that a
feature's own UI is hidden while its switch is off.

- **Link picker** — in the project settings surface that already holds the run
  command and prod URL. Lists writable design projects from `list_projects`,
  pre-highlights the slug match, writes `design_project` on press. Shows the
  current link and a re-pull action once set.
- **SYNC** — appears after a turn touching UI files in a linked repo. Queues the
  push prompt. Not automatic: it is an offer, in the same spirit as the GIT
  tab's generate button.

## Failure posture

Best-effort throughout, matching `graphmap.py` and `relevance.py`: a design
project that 404s, an expired design scope, a `list_projects` that times out —
each leaves the repo exactly as it was and the run proceeds without the skill.
Nothing here may block a turn. An unlinked repo, or a repo whose pull never ran,
behaves as it does today.

`get_file` returns content other org members can write. It is data, not
instructions; the pull writes it to disk as skill files and does not act on it.
A pulled file that reads like instructions is reported to the user as an odd
path rather than followed.

## Out of scope

- Creating design projects from the bridge (`create_project` goes unused).
- `register_assets` / `unregister_assets` — the pane builds its card index from
  each preview's `@dsCard` marker; explicit registration is legacy.
- Syncing `ui_kits/` or `templates/` in either direction.
- Any Telegram-side surface. Linking and syncing are dashboard actions.
- Native (non-bridge) sessions, which reach the design system through the
  materialised skill like any other Claude Code session, with no bridge
  involvement.

## Build order

1. `project_config.design_project` + setter, with tests.
2. `aifeatures` entry and its plumbing, shipped off.
3. Reconciliation push: bring the design project level with the current HUD.
4. Pull into `.claude/skills/`, with the design-source marker in `skills.py`.
5. Dashboard link picker.
6. SYNC action.

Steps 1-2 are inert on their own. Step 3 is the one-off that makes everything
after it worth having.
