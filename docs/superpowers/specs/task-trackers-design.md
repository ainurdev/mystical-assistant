# Task trackers (Teamwork · Jira) — design

2026-09-11 · approved in chat (three sections), spec for the record

## Problem

A repo's work is planned somewhere the bridge cannot see. GitHub issues are
already an ISSUES tab; for the projects that matter here the list lives in
Teamwork.com or in a client's Jira Cloud site. So a session starts blind to
what is due, and the update a task deserves after a session is hand-carried.

## Decisions taken before this spec

- **The bridge reads over REST, the session writes over MCP.** Reading is
  stdlib `urllib` with an API token — no Claude turn is spent to show a list
  or a deadline, and it works with every MCP server off (the bridge's
  default). Writing goes through the session's own claude turn with the
  tracker's MCP switched on for that turn only, so the comment is written by
  the context that did the work, and the Allow card is the review step.
- **One tracker link per repo**, project-wide, in `project_config` next to
  `run_cmd` / `design_project`. Not per session, not per branch.
- **All of the project's open tasks**, yours marked. MINE is a filter, not the
  list.
- **Into the prompt two ways:** FEED/SHIP on a task (like ISSUES), and a
  once-per-session digest that rides the same pack path as the project map.
- **Write-back is comment + status.** You pick the status before the turn
  starts; Claude carries it out. Teamwork's MCP cannot reopen a task, so
  reopen is not offered.
- **Jira Cloud, several sites.** Every connection carries its own site and
  token. Self-hosted Jira is out.

## 1. Connections and the link

`bridge/trackers.py` keeps named connections in `trackers.json` beside the
DB (mode 0600): `{id, kind: teamwork|jira, name, site, email, token, me,
cloud_id, base}`. The token never leaves the bridge; the API returns it
masked. Adding one tests it (`/me.json`, `/rest/api/3/myself`) and records
the caller's identity, which is what marks a task as yours. A Jira scoped
token gets 401 from the site URL; the test falls back to
`api.atlassian.com/ex/jira/<cloudId>` and remembers which base worked.
`cloud_id` (from `<site>/_edge/tenant_info`) is also what every Atlassian
MCP call needs.

The link is one string in `project_config`: `tracker = "<conn id>:<project
id or key>"`, plus `tracker_label` for display. Set from the ANALYZE header
(LINK TASKS → connection → project picker), cleared from the same chip.

## 2. Reading

`trackers.tasks(rel)` returns one shape for both kinds:

```
{linked, kind, name, label, url, me, read, stale, error,
 open, done, overdue, due_week, next: [{kind, name, date}],
 tasks: [{key, title, status, due, priority, assignee, mine, url,
          updated, description}]}
```

- Teamwork: `GET /projects/api/v3/projects/{id}/tasks.json` (incomplete,
  `include=users`), a `completedOnly` count, and the project's milestones.
  Task key is `tw-<id>`, URL `<site>/app/tasks/<id>`.
- Jira: `GET /rest/api/2/search/jql` (v2 for plain-text descriptions; the
  old `/search` is gone), `statusCategory != Done`, up to 300 issues;
  `approximate-count` for the done count; the active sprint (agile API) and
  the nearest unreleased version as `next`. Key is the issue key, URL
  `<site>/browse/<key>`.

A 2-minute cache per link; a failure returns the last list marked stale.
The digest (≤ 12 lines: counts, next deadline, overdue, due soon — keys,
titles, dates, assignees only, never descriptions) joins the appended
system prompt on a session's first turn through the same `_packed_sessions`
gate the graph pack uses, so it is sent once and the prompt cache holds. A
cold cache waits at most 2 s, then the turn starts without it. Switch: AI
tab › TASK DIGEST.

## 3. Surfaces

- Dashboard ANALYZE: LINK TASKS chip in the header; TASKS tab (linked repos
  only) — counts line, tasks by due date with overdue red, MINE filter,
  detail pane with FEED / SHIP / UPDATE. SHIP names the branch after the
  key (`ACME-123-fix-login`, `tw-4512-fix-login`), so a session's task is
  read from its branch and nothing new is stored. Chat header gets a TASKS
  button that opens the tab.
- Dashboard SYSTEM: TRACKERS block — add (kind, name, site, email, token),
  test result inline, remove. Jira rows also show the `claude mcp add`
  command for the site's MCP entry, and say when it is missing.
- Mini App WORK: TASKS tab (feed / queue / update). Linking stays on the
  dashboard.
- Bot: nothing new; bot sessions get the digest.
- Next Up: `facts()` gains overdue and due-soon tasks, so a deadline can
  outrank a dirty tree.

## 4. Posting an update

UPDATE opens a sheet: status (live from the tracker — Jira transitions,
Teamwork stages + COMPLETE — or no change), an optional note, START. The
bridge composes the prompt (task, site/cloudId, MCP server name, exact tool
calls, the PR URL if `gh` finds one for the branch, the comment format:
plain text for Teamwork, Markdown for Jira) and runs a turn in the chosen
session with three extras on that turn only:

- the tracker's MCP server re-declared on (`job.mcp_on`), whatever the
  session's Tools toggles say;
- `--permission-mode manual`;
- `--settings '{"permissions":{"ask":["mcp__<server>"]}}'` — an ask rule on
  the whole server. Ask beats allow and prompts in every mode including
  bypass and auto; only `dontAsk` denies instead, and manual mode rules that
  out. Every tool on that server prompts, so a mistyped tool name cannot
  slip a write through.

The Allow card shows the full tool input (`detail`), so the comment is read
before it is posted. Deny → nothing posts; run UPDATE again with a note.

Setup: the `teamwork` MCP entry is already logged in. Each Jira site needs
`claude mcp add --transport http atlassian-<name> https://mcp.atlassian.com/v2/mcp`
and one browser login (a private window for a different Atlassian account).

## 5. Errors

401/403 → "token rejected — re-enter it". 429 / timeout → the last list,
marked stale. Digest never delays a turn past 2 s. Session busy → 409.
New UI on an old bridge → "restart the bridge".

## 6. Testing

`tests/test_trackers.py`: both adapters against canned responses (no
network), counts and deadlines, key ↔ branch, statuses, update-turn
composition, digest byte-stable across turns. `tests/test_tracker_endpoints.py`:
dashboard and Mini App routes socket-free, the update turn's argv
(`--settings` ask rule, manual mode, server re-declared), the link in
project settings.

## Not built

Creating tasks, reopening, time logging, deadline reminders in Telegram,
two trackers on one repo, self-hosted Jira, a Mini App chat-header button
(UPDATE lives in WORK › TASKS there).
