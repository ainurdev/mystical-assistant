# RIVENDELL tab: a project's tasks, one click to implement (design)

2026-09-30 · behaviour and layout approved in chat (cards, variant C) · mockups
in `.mystical/design-drafts/rivendell-tasks/` and in Claude Design at
`drafts/rivendell-tasks/`

## Problem

Starting an AI implementation of a task means going to Rivendell, finding the
task and pressing "Implement using AI". The run then happens here, on this
bridge. The dashboard can't see the task list, so every start begins
somewhere else.

## Decisions taken before this spec

- **The button is Rivendell's own button.** IMPLEMENT creates a Rivendell
  implementation request, exactly like "Implement using AI". The prompt is
  Rivendell's (project override → global → built-in, rendered at claim). The
  run is the existing plugin path: autonomous, `bypassPermissions`, result
  posted back to the task. It is not an interactive session.
- **Same gate as Rivendell's button.** The request comes back to this bridge
  over the websocket and passes through `_apply_policy` unchanged. It
  auto-starts when the queue is idle. Otherwise it is held in PLUGINS (with a
  Telegram ping) and drains when the bridge is free. A dashboard click does not
  skip the queue.
- **Layout C, cards.** Titles wrap to two lines. Each card ends in a state line
  and one labelled action. Yours come first, then the team's.
- **Dashboard only.** No Mini App or bot surface.

## Data flow

```
dashboard tab ──GET /local/rivendell/tasks?project=<rel>──▶ bridge
   bridge: origin slug of the checkout (github.remote_slug)
        ──GET /plugin/tasks?repository=<owner/repo>──▶ each enabled Rivendell
dashboard IMPLEMENT ──POST /local/rivendell/implement──▶ bridge
        ──POST /plugin/implementation-requests {taskId}──▶ Rivendell
   Rivendell: ImplementationRequestsService.create(owner, taskId)
        ──websocket event──▶ this bridge's worker ─▶ _apply_policy ─▶ run
```

## 1. Rivendell (ainurhq/rivendell, backend only)

Two token routes in `agent-gateway/`, both with the plugin guards
(`ApiTokenAuthGuard` + `PermissionsGuard`, LLM capability,
`taskmanagement.read`). That is the same permission the board route and the
dashboard's `POST /implementation-requests` check.

**`GET /plugin/tasks?repository=<owner/repo>`** is a new `PluginTasksController`.
The match is case-insensitive. The rest of the chain:

1. Repositories (not deleted) whose `fullName` is the repo, or whose mirror's
   `fullName` is. Devs work on the mirror, so a checkout's origin can be either
   one.
2. Rivendell projects that link one of them (`REPOSITORY` link).
3. Teamwork projects those projects link (`TEAMWORK_PROJECT` link).
4. Those Teamwork projects' tasks that are open by `taskDoneReason(…) ===
   null`. That is the done rule the board uses: completed status, or a column
   or tag marked "counts as done".

```ts
{
  projects: [{ id, name, url }],   // url = frontendUrl + /projects/:id
  tasks: [{
    id, name, htmlUrl, projectName,
    column: string | null,         // TeamworkStage.name of stageExternalId
    dueDate: string | null, priority: string | null,
    assignees: [{ id, name }],     // decoded as toTeamworkTaskDto does
    mine: boolean,                 // an assignee's TeamworkUser.userId is the token owner
    implementation: null | {       // the task's newest request
      id, status,                  // PENDING | IN_PROGRESS | COMPLETED | FAILED | CANCELLED
      createdAt, completedAt,
    },
  }],
}
```

Order: `mine` first, then due date (none last), then name. An empty `projects`
means no project links this repo. The bridge shows that as its own state. There
is no cap, as on the board route.

**`POST /plugin/implementation-requests`** goes on the existing
`PluginImplementationController`. The body is `CreateImplementationRequestDto`
(`taskId`, optional `customPrompt`). The route returns
`implementationRequests.create(user, taskId, customPrompt)`, which is the
dashboard route's own call, made as the token's owner. `create` already 400s
when the project→repo chain is missing, and it dispatches to the owner's
bridge.

**Tests:** a spec for the list, covering an origin match, a mirror match, a
done task left out, `mine` first, and the newest request attached. A spec for
the create route that dispatches to the token owner. Then typecheck and lint.
**Docs:** a short section on the two routes beside the plugin docs.

## 2. Bridge (`bridge/rivendell.py`, `bridge/dashboard/server.py`)

- `rivendell.tasks(slug)` asks every running worker (`_workers`) through
  `Worker._api` and merges the answers. Each task carries `instance_id`, and
  `session_id` when this bridge is running its request (below). Errors are per
  instance and one line each: 401/403 is `token rejected`, 404 is `Rivendell
  is older than this tab` (the route isn't deployed), anything else is
  `unreachable`.
- `rivendell.implement(instance_id, task_id)` makes the POST above and returns
  the request (`id`, `status`).
- The worker keeps `request id → session id` for implementation runs.
  `_run_implementation` sets it right after `_start_run`, and the run's end
  clears it. `# ponytail:` it lives in memory, and a restart ends the run
  anyway (catch-up re-queues it). It only feeds OPEN SESSION.
- `GET /local/rivendell/tasks?project=<rel>` resolves the checkout with
  `_abs_project` and takes its origin with `github.remote_slug`. A checkout
  with no GitHub origin is its own state. `POST /local/rivendell/implement
  {instance_id, task_id}` calls `rivendell.implement`.

## 3. Dashboard (`RivendellTasks.tsx`, `App.tsx`, `api.ts`)

- A right-rail tab with the lucide `Castle` icon, after QUEUE, `scope:
  "project"`. It shows only when `api.rivendell()` lists at least one instance
  (fetched once, then again whenever settings close). `"rivendell"` joins
  `RIGHT_TABS` in `lib/theme.ts`.
- Header: RIVENDELL, then ↗ (the first matched project's `url`) and ⟳. The
  sub-line has ◆ and the project name(s), then `N OPEN`. Sections are YOURS and
  TEAM.
- The card's action follows the state:

| newest request | state line | action |
|---|---|---|
| none / CANCELLED | none | IMPLEMENT |
| PENDING | ◷ QUEUED | none |
| IN_PROGRESS | ● RUNNING · age | OPEN SESSION › when `session_id` is set |
| COMPLETED | ✓ DONE · age | RUN AGAIN |
| FAILED | ✕ FAILED · age | RETRY |

- IMPLEMENT, RUN AGAIN and RETRY all go through `askConfirm` first. The dialog
  says the run has no permission prompts and will push a branch and open a
  pull request. After a yes, the card turns QUEUED at once and the next poll
  reconciles it. Clicking the card opens `htmlUrl` (Teamwork). Rivendell has no
  deep link for a task.
- The tab polls every 10 s while it is open. The PLUGINS queue polls the same
  way, because requests change state with no dashboard event to announce it.
- States from the mockups: token rejected (with a SETTINGS ▸ PLUGINS button),
  repo not linked, no GitHub origin, Rivendell too old, nothing open, and a
  loading skeleton.

## Testing

- Rivendell: the jest specs above, then `pnpm typecheck && pnpm lint`.
- Bridge: `tests/test_rivendell.py` gets `tasks()` (merge, per-instance
  errors, `session_id` attached) and `implement()` (the POST it makes), with
  `_api` stubbed as the existing tests do. Then the full suite.
- UI: a worktree build is driven headlessly (bridge-eyes) against a stubbed
  `/local/rivendell/*`. The live token is rejected today, so real data can't
  be the check. Screenshots of each state go to the chat.

## Rollout

1. The Rivendell change goes on a branch in a worktree off `origin/main`.
   Rivendell's AGENTS.md leaves git to the human, so committing waits for an
   OK, and push/PR waits for an explicit one.
2. The bridge change goes on its own worktree branch. It can merge before
   Rivendell deploys, because the tab shows "Rivendell is older than this tab"
   until then.
3. Live: rebuild the dashboard and restart the bridge (bridge-ship). A new LLM
   token goes into Settings ▸ PLUGINS, because the current one is revoked (the
   worker has been in `auth_error` since 2026-09-30 07:50 UTC).

## Not in this

A Mini App or bot surface. Editing the prompt before a run (Rivendell's
custom-prompt dialog stays in Rivendell). A MINE/TEAM filter toggle (order
only). A link from DONE to its pull request (the summary is in Rivendell).
Letting a dashboard click skip the operator queue.
