# Local run API

Another program on this machine hands Mystical a prompt and gets back the response, or where the
run stands. The first user is the Atlas reading app: its server runs
`mystical prompt --client atlas --cwd <atlas repo> --wait ...` with a prompt telling a session to
work through the Atlas job queue. Nothing in it is specific to Atlas.

Code: `bridge/run_api.py` (the runs), `bridge/run_cli.py` (the CLI), two route blocks in
`bridge/dashboard/server.py`, four subcommands in `bin/mystical`.

## Why not the existing pieces

- **The program starts `claude -p` itself.** It then needs its own login, has no answer to a usage
  limit, and the work is invisible. Atlas's decision 0008 rejected this for that reason.
- **The dashboard's own routes** (`POST /local/sessions`, `POST /local/run`) with the dashboard
  token. That token does everything the dashboard does: answer permission cards, read every
  session, change settings. A reading app should not hold it. It is also random per start unless
  pinned in `.env`.
- **An automation with a trigger.** Automations are the owner's, on purpose (no agent or program
  may give itself a timer), and they don't return an answer to a caller.

## What a run is

A run is a normal session: a row made the way `POST /local/sessions` makes one and a first turn
started through `runner.start_streaming_job`, the call the dashboard composer makes. So it shows
in the dashboard, titled `<client>: <title>` with origin `api:<client>`, and you can watch it,
answer its cards, steer it, stop it or carry on in it afterwards. A usage limit parks it, the
fallback ladder can move it to another login, a crash is resumed and a bridge restart picks it up,
all by the code that does this for your own sessions.

The run is that session from the prompt until it goes quiet, not one turn. A resumed turn, a limit
park, a wait on another session and a prompt you queue behind it are still the run. It ends when
the session holds no run slot and nothing has it coming back for 3 seconds. The response is the
last turn's result text.

One line is appended to the prompt: who sent it, that nobody may be watching, and that the final
reply is what the program gets.

## States

| State | Meaning |
|---|---|
| `queued` | waiting for a slot; `queue_position` says where in line |
| `running` | a turn is live, or the session is coming back by itself (`detail` says: paused on a usage limit until about 14:05, retrying after an API error, waiting on another session) |
| `waiting_for_input` | a question or a permission card is up, or the ladder offered another login and waits for your pick; `detail` says which, `session_url` is where to answer |
| `done` | ended normally; `response` holds the answer (it may be empty) |
| `failed` | the last turn died and nothing resumes it; `error` says why |
| `cancelled` | `run-cancel`, or you pressed Stop in the dashboard (`detail`: stopped in the dashboard) |

The last three are final. What you send in the session afterwards is yours and doesn't reopen the
run. A session that ends its turn by asking something in prose is `done`: the question is the
response.

## HTTP

On the dashboard server, so `http://127.0.0.1:<DASH_PORT>`. Every route wants the header
`X-Run-Token`. The address and the token are in `<state dir>/run-api.json` (mode 600, beside the
bridge's database, `~/.bridge_state` by default): `{"url": "...", "token": "..."}`. The bridge
writes it at boot and keeps the token across restarts.

| Route | Body or query | Answer |
|---|---|---|
| `POST /local/runs` | `{"cwd", "prompt", "title"?, "client"?, "ref"?}` | `202 {"run": Run}` at once |
| `GET /local/runs/<id>` | `?wait=N` blocks up to N seconds (30 at most per request) for the run to end | `200 {"run": Run}` |
| `GET /local/runs` | `?client=NAME&limit=N` (50 by default) | `200 {"runs": [Run]}`, newest first |
| `POST /local/runs/<id>/cancel` | `{}` | `200 {"run": Run}`; `409` when it is already over |

Errors are `{"error": "<one sentence>"}`: 400 bad request, 401 no or wrong token, 403 a folder runs
may not start in (or a Host/Origin that isn't this machine's), 404 no such run, 409 already over,
413 prompt over 200,000 characters, 429 the queue is full.

`cwd` is an absolute path. `client` is 1 to 32 of `a-z 0-9 . _ -` (`api` when left out). `title` is
cut to 60 characters and defaults to the prompt's first line. `ref` is yours: up to 200 characters,
stored and returned untouched.

### Run

This is also what `--json` prints. Keys are added over time, never renamed or dropped
(`tests/test_run_api.py` pins the set).

```json
{
  "id": "5f0c2a9d81b3",
  "status": "done",
  "detail": "",
  "client": "atlas",
  "ref": "batch-7",
  "title": "Job queue",
  "cwd": "/home/me/projects/atlas",
  "session_id": "9c1e...",
  "session_url": "http://127.0.0.1:8790/?s=9c1e...",
  "created": 1794000000.0,
  "started": 1794000000.2,
  "finished": 1794000321.9,
  "queue_position": null,
  "response": "Finished 3 jobs. None failed.",
  "error": null
}
```

Times are Unix seconds. `session_id`, `session_url` and `started` are null while queued;
`response` is set only when done, `error` only when failed.

## CLI

```
mystical prompt --cwd <dir> [--title T] [--client NAME] [--ref R] [--wait [SECONDS]] [--json] <prompt | - | @file>
mystical run-status <id> [--wait [SECONDS]] [--json]
mystical runs [--client NAME] [--limit N] [--json]
mystical run-cancel <id> [--json]
```

- `prompt` prints the run id and returns. With `--wait` it blocks until the run ends and prints the
  final response on stdout; `--wait 600` gives up after 600 seconds. `-` reads the prompt from
  stdin, `@file` from a file. Changes of state go to stderr, one line each.
- `--json` prints the Run (for `runs`, `{"runs": [...]}`) as one line, whatever the outcome.
- Ending a wait (a timeout, Ctrl-C, the caller killing the command) does not stop the run.
  `run-cancel` does.
- A wait is a loop of 25-second long polls and rides out 2 minutes of the bridge not answering, so
  reloading the bridge from the dashboard doesn't fail a caller.

Exit codes, the same for all four:

| Code | Meaning |
|---|---|
| 0 | fine: accepted, listed, cancelled, or (asked about one run, or waiting on it) it is done |
| 1 | refused, or anything else: a folder runs may not start in, a full queue, no such run |
| 2 | wrong usage |
| 3 | the bridge isn't answering, or `run-api.json` is missing or stale |
| 4 | the run failed |
| 5 | the run was cancelled |
| 6 | the run isn't over: `--wait SECONDS` ran out, or `run-status` found it queued, running or waiting for input |

The CLI reads only `run-api.json` (`MYSTICAL_RUN_API` names another path) and imports nothing from
the bridge, so it needs no `.env`.

For Atlas (`ATLAS_JOB_COMMAND`, or a call from its server):

```sh
mystical prompt --client atlas --cwd ~/projects/atlas --title "Job queue" --wait 3600 @~/Atlas/job-prompt.md
```

## Safety

- **Loopback only.** The dashboard server binds 127.0.0.1 and checks the Host header on every
  request, the Origin on a POST and Sec-Fetch-Site on a GET; the tunnel never fronts it.
- **Its own token, on reads too.** Whoever holds it can start, read and cancel runs. It does not
  open any other dashboard route, and the dashboard token does not open these.
- **Where a run may start.** `cwd` must be inside `BASE_PATH` (where every surface can show the
  session) and inside a git repository there, the repos the project browser knows; a worktree
  counts. With `RUN_API_DIRS` set (comma-separated folders), only those folders and what is under
  them, repository or not. Symlinks are resolved first.
- **A cap.** `RUN_API_CONCURRENCY` runs are live at once (default 2); the rest queue, oldest first,
  50 at most. A run waiting for input or parked on a limit keeps its slot. Your own sessions don't
  count against it.
- **Permission mode.** Exactly what a dashboard-started session in that project gets: its default
  profile's mode, else `NEW_SESSION_PERMISSION_MODE`. The caller cannot name a mode, a model, an
  account or tools, and extra keys in the body are ignored. With `bypassPermissions` there, a
  program holding the token runs commands as you in the allowed folders: narrow `RUN_API_DIRS`, or
  give the project a stricter default profile.

Both settings are on the SYSTEM tab (RUNS) and take effect without a restart.

## Limits and open choices

- Text only: no images, no second prompt into the same run's session.
- Runs are JSON beside the database (`run-api-runs.json`); the last 200 finished ones are kept. A
  queued run's prompt is in that file until it starts.
- A finished run pings you like any session's turn does. Quiet per client if that gets loud.
- No dashboard panel lists runs; the sessions list shows them by title.
- One polling thread per live run (1 s). Fine at this cap.
- A run whose login expired fails; signing in resumes the session, not the run.
- `waiting_for_input` never times out by itself. A caller that can't wait uses `--wait SECONDS`
  and `run-cancel`.
