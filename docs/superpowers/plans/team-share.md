# TEAM (presence + shares) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** You can see which Rivendell teammates have Mystical on, and send them a session, a
picture or a file. It arrives read-only, and you continue it on your own accounts.

**Architecture:** Rivendell gets two new kinds of `/plugin` route on the bridge token: a teammates
list (presence comes from `AgentGateway.isOnline` plus a `users.bridgeSeenAt` stamp) and shares
(rows, files in `StorageService`, a `team-share` frame, catch-up). The bridge gets `bridge/team.py`,
which packs, sends, receives and continues. A received session is a read-only session with origin
`team:<instance>`. The dashboard gets a TEAM rail tab, a send sheet, a received bar and
CONTINUE HERE.

**Tech Stack:** Rivendell is NestJS, Prisma 5 and Jest. The bridge is Python stdlib and pytest.
The dashboard is React, TypeScript and Vite.

**Spec:** `docs/superpowers/specs/team-share.md`. The mockups are in
`.mystical/design-drafts/team-share/`.

## Global Constraints

- No commit carries Claude attribution: no `Co-Authored-By`, no "Generated with" (user rule).
  Nothing is pushed in either repository.
- Rivendell: migrations are hand-written and additive, in a folder named
  `YYYYMMDDHHMMSS_name/migration.sql` that sorts after `20261019121000_project_summary_requests`.
  Every route carries exactly one access decorator (`@OwnAccount('<why>')`). The DTO file opens
  with `// SHARED CONTRACT with mystical-assistant`. Nothing goes in Rivendell's web app.
- The bridge is stdlib only. A schema change is a line in `_SCHEMA` plus a guarded ALTER in
  `store.init()`. Routes sit under `/local/rivendell/team`, so the plugin gate covers them. A
  route a newer dashboard calls on an older bridge must show "restart the bridge".
- UI copy names people by name and never guesses a pronoun ("lands in their TEAM tab").
- Caps:

  | What | Cap |
  |---|---|
  | Raw upload, any one file | 9 MB (Rivendell's raw body limit) |
  | Transcript | 9 MB gzipped, 64 MB unzipped |
  | Pictures | 20 per share, at 5 MB each, PNG, JPEG, GIF or WebP by their bytes |
  | Title | 200 characters |
  | Note | 2000 characters |
  | Meta | 4 KB of JSON |

  Shares expire 14 days after they are created. A draft that is never sent goes after 1 h.

## Shared contract (Rivendell ⇄ Mystical, v1)

Every route is under `/plugin` and authorised by `Bearer <bridge token>` (the LLM capability).
Times are ISO strings.

```
GET  /plugin/teammates → TeammateDto[]
     everyone except the caller, those online first, then by name
     TeammateDto = { id, name, avatarUrl|null, online: bool, lastSeenAt|null,
                     device: { id, name, online: bool } | null }
       online     = AgentGateway.isOnline(id)
       lastSeenAt = users.bridgeSeenAt (written when an agent socket opens and when one
                    closes; null means they never linked Mystical)
       device     = a shared device they own that the caller may use

POST /plugin/shares                        JSON
     body: { toUserId: uuid, kind: 'session'|'picture'|'file', title: 1..200,
             note?: ≤2000, meta?: object ≤4 KB }
     → 201 { id }    400 when sending to yourself, to an unknown user, or with a bad body
     The share stays a draft until /send.

PUT  /plugin/shares/:id/files/:name?role=transcript|picture|code|file
     application/octet-stream, sender only, draft only (409 once sent)
     transcript: gzip bytes, one per share, session only
     code:       gzip bytes, one per share, session only
     picture:    PNG/JPEG/GIF/WebP sniffed, ≤5 MB, ≤20 per share; session or picture
     file:       any bytes, one per share, file only
     The name is cleaned to [A-Za-z0-9._-]{1,120}. The same name again replaces the file.
     → 204    400 wrong role for the kind, or bad bytes    413 over a cap

POST /plugin/shares/:id/send
     sender only. Needs the kind's main file (session: transcript; picture: at least one
     picture; file: the file).
     → 200 ShareDto    409 already sent or main file missing
     sends {type:'team-share', requestId:id, ...ShareDto} to every socket of the recipient

GET  /plugin/shares?box=in|out → ShareDto[]
     in:  shares to the caller that are sent, not expired and not dismissed, newest first, ≤50
     out: shares from the caller that are sent, newest first, ≤20

GET  /plugin/shares/:id/files/:fileId → { url }
     the sender or the recipient, not expired; a signed attachment link that lasts 10 minutes

POST /plugin/shares/:id/delivered | /opened | /continued | /dismissed
     recipient only. Each stamps its time once; a repeat changes nothing. → 204
     every stamp sends {type:'team-share-update', requestId:id, deliveredAt, openedAt,
     continuedAt, dismissedAt} to every socket of the sender

ShareDto = { id, kind, title, note|null, meta, from:{id,name,avatarUrl}, to:{id,name,avatarUrl},
             sentAt, deliveredAt|null, openedAt|null, continuedAt|null, dismissedAt|null,
             expiresAt, files:[{ id, role, name, contentType, bytes }] }
```

**The session `meta` the bridge sends:**

```
{ project, repo|null ("owner/name"), branch|null, turns, pictures, code: bool,
  commitSha|null, redacted }
```

A picture or file share's `meta` is `{ name, bytes }`.

**The transcript file** (`transcript.json.gz`):

```
{ v: 1, title,
  turns: [{ prompt, at, model|null, effort|null, status,
            attachments: [<picture name>], events: [<event>] }] }
```

Events keep only these types and fields:

| Type | Fields |
|---|---|
| text | `{text}` |
| thinking | `{ms, text?}` |
| tool | `{id, name, summary}` |
| tool_done | `{id, ms?, output?, is_error?, images?: [<picture name>]}` |
| result | `{result, cost?, elapsed?, is_error?}` |
| error | `{message}` |
| divider | `{text}` |
| steer | `{text}` |

## Review Focus

1. **A hostile transcript.** A teammate's payload can carry unknown event types, paths in
   `images`, ids like `../x`, a `claude_session_id`, a zip bomb, or HTML. None of it may run, open
   a file or escape. Test: `tests/test_team.py::test_materialize_strips_hostile_payload`.
2. **A sender who is away, or who never linked Mystical.** The share waits. Catch-up on connect
   delivers it once, and a frame plus a catch-up for the same id never make two sessions. Test:
   `test_on_share_twice_makes_one_session`.
3. **CONTINUE HERE when the repository isn't cloned here**, or the snapshot's commit is missing.
   The answer says so; nothing half-made is left behind. Test: `test_continue_without_checkout`.
4. **A code archive from a teammate.** Entries that are absolute, use `..`, or are symlinks must
   never write outside the new worktree. Test: `test_unpack_refuses_escape`.
5. **Secrets in a session:** `rvd_`, `ghp_`, `github_pat_`, `sk-ant-`, `AKIA`, a private-key block,
   `X_TOKEN=…`. They are blanked before upload, and `.env*` files never go into code or files.
   Tests: `test_redact_counts_and_blanks`, `test_snapshot_skips_env`.

---

## Rivendell half (worktree `~/Projects/.worktrees/rivendell/feat-team-share`, branch `feat/team-share`)

### Task R1: Schema, presence stamp, service

**Files:**
- `backend/prisma/schema.prisma`
- `backend/prisma/migrations/20261019230000_team_shares/migration.sql`
- `backend/src/team-shares/team-shares.service.ts`
- `backend/src/team-shares/team-shares.view.ts`
- `backend/src/agent-gateway/agent.gateway.ts`
- specs beside each

**Interfaces:**
- `User.bridgeSeenAt DateTime?`
- `enum TeamShareKind { SESSION PICTURE FILE }`
- `model TeamShare` (`team_shares`) with the contract's fields, plus `createdAt`, `updatedAt` and
  indexes on `[toId, sentAt]` and `[fromId, createdAt]`.
- `model TeamShareFile` (`team_share_files`): `shareId` (cascade), `role`, `name`, `contentType`,
  `bytes`, `storageKey` (unique), and `@@unique([shareId, name])`.
- `AgentGateway.onPresence(fn: (userId: string) => void): void`, called after a socket is
  registered and in `drop()`. The gateway constructor does not change.
- `TeamSharesService` methods: `teammates`, `create`, `putFile`, `send`, `list`, `fileUrl`,
  `stamp` and `sweep`. Storage keys are `team-shares/<id>/<role>/<name>`. `sweep` runs every
  hour on an unref'd interval, as `DeviceRunsService` does.

- [ ] Specs first, with in-memory fake Prisma and storage. Cover:
  - send to self → 400;
  - a recipient PUTting a file → 403/404;
  - PUT after send → 409;
  - a 6 MB picture → 413;
  - code on a file share → 400;
  - send without its main file → 409;
  - the `team-share` frame reaches only the recipient's sockets;
  - stamps are idempotent and only the recipient's;
  - the `in` box hides expired and dismissed shares;
  - sweep removes expired rows and their objects;
  - teammates leave out the caller and sort online first.
- [ ] Implement until they pass. Then run `typecheck`, `lint:ci` and `test`.

### Task R2: Controller, module, docs

**Files:**
- `backend/src/team-shares/plugin-team.controller.ts`
- `backend/src/team-shares/dto/team-shares.dto.ts`
- `backend/src/team-shares/team-shares.module.ts`
- `backend/src/app.module.ts`
- `docs/team-shares.md`
- `docs/README.md`
- `docs/agent-jobs.md` (a pointer)

- [ ] Controller spec: the guard metadata (`ApiTokenAuthGuard`, `PermissionsGuard`, LLM), and
  every route delegating to the service. `route-coverage.spec.ts` must stay green.
- [ ] No route may collide with `PluginJobsController`'s `POST /plugin/:path/:id/ack|refuse`.
  Check that GET `/plugin/teammates` and `/plugin/shares` aren't swallowed by a catch-all.
- [ ] Docs: the contract word for word, the frames, and the caps.
- [ ] Commit (`team: …`), with no attribution lines.

## Bridge half (worktree `~/Projects/.worktrees/mystical-assistant/feat-team-share`, branch `feat/team-share`)

### Task B1: Read-only origin `team:` and the session's `team` facts

**Files:**
- `bridge/store.py`: the `team` column, `set_team()`, `parse_team()`, and `latest_session` plus
  `claim_orphaned_turns` skipping `team:`.
- `bridge/team.py`: start the module with `ORIGIN = "team"`, `REFUSAL`, `is_team()`.
- `bridge/runner.py`: refuse a turn in a team session.
- `bridge/nextup.py` and `bridge/relevance.py`: skip team sessions.
- `bridge/integrations.py`: add `"team"` to the Rivendell origins.
- `bridge/dashboard/server.py`: retitle, share and duplicate answer 409.
- `bridge/miniapp/server.py` `_session_brief`: add `"team": store.parse_team(...)`.
- Tests:
  - `tests/test_team.py::test_team_session_is_read_only` (runner refusal and `latest_session`);
  - orphan claiming in `tests/test_outcomes_store.py`;
  - the 409 routes in `tests/test_team_endpoint.py`.

### Task B2: Pack and send

**Interfaces:**
- `team.redact(text) -> tuple[str, int]`
- `team.pack_session(sid, pictures: bool) -> dict`, which returns `{payload: bytes,
  pictures: [(name, path)], meta: dict, title}`.
- `team.send(kind, to, note, *, session_id=None, pictures=True, code=False, path=None) -> dict`,
  which returns the `ShareDto`. It raises `TeamError(sentence)`.
- `device_ask.snapshot(folder, run=..., env=True)`: `team` passes `env=False`.

Tests:
- `test_redact_counts_and_blanks`
- `test_pack_session_keeps_whitelist`
- `test_send_session_uploads_then_sends` (with a fake `_api` and `_api_put_bytes`, as
  `tests/test_device_ask.py::riv` does)
- `test_send_file_refuses_env`
- `test_snapshot_skips_env`

### Task B3: Receive

**Interfaces:**
- `team.on_share(worker, frame)` never raises.
- `team.catch_up(worker)`
- `team.on_update(worker, frame)`

A session share is materialised at once: download (cap), sanitise, `store.create_session(...
origin=f"team:{iid}")`, `rename`, `set_ref("share:<id>")`, `set_team`, `import_transcript`, and
the pictures into `UPLOAD_DIR`. A picture is saved under `UPLOAD_DIR/team-<id>/`. A file is saved
in `<state>/team/<id>/` (0700). Then the notice `team_in` (a new group `team`, Telegram on by
default, source `team`), then POST `/delivered`. Local state lives in `team.json` beside the DB
(0600).

Tests:
- `test_materialize_strips_hostile_payload`
- `test_on_share_twice_makes_one_session`
- `test_catch_up_delivers_undelivered`
- `test_picture_share_saved_servable`
- `test_file_share_kept_out_of_uploads`

### Task B4: Actions and routes

**Interfaces:**
- `team.overview() -> {roster, inbox, outbox, unread}` (roster and outbox cached 20 s)
- `team.preview(sid) -> {title, project, branch, turns, pictures, redacted}`
- `team.continue_plan(share_id) -> {project|None, branch, base|None, draft, attachments:[{name,url}]}`
- `team.unpack(share_id, cwd) -> int` (the files written)
- `team.mark(share_id, state)`
- `team.transcript_md(share_id) -> str`

Routes:
- GET `/local/rivendell/team` and `/team/preview?session=`
- GET `/team/file?id=&name=`: `Content-Disposition: attachment`, `application/octet-stream`, `nosniff`
- GET `/team/transcript.md?id=`
- POST `/team/send`, `/team/continue`, `/team/unpack` and `/team/state`

Tests:
- `test_continue_without_checkout`
- `test_unpack_refuses_escape`
- route tests in `tests/test_team_endpoint.py`

### Task B5: Worker wiring

**Files:** `bridge/rivendell.py`:
- in `_handle_message`, `team-share` and `team-share-update` start a thread and return None;
- after connect, start `team.catch_up` on a thread.

Test: `tests/test_team.py::test_frame_handled_off_listener`, using a socketpair as
`tests/test_device_ask.py` does.

### Task D1: Dashboard client and the TEAM tab

**Files:**
- `api.ts`: the types and calls.
- `lib/team.ts` with `lib/team.check.ts`: presence text, send status labels, ordering, and
  `isTeam`.
- `components/hud/TeamPanel.tsx`.
- `App.tsx`: the rail tab, badge and poll.
- `lib/theme.ts`: add `"team"` to `RIGHT_TABS`.

### Task D2: Sending

**Files:**
- `components/TeamSendSheet.tsx`: the dialog, at z 97, with its own Esc.
- `App.tsx`: the session menu row **Send to teammate ▸**, top level, under Rename.
- `FilesPanel.tsx`: a file's Send to teammate row.
- `ImageLightbox.tsx`: a send button that dispatches `hud:team-send` with `{path}`.

### Task D3: Receiving and continuing

**Files:**
- `components/TeamBar.tsx`, which stands where the composer is for a team session.
- `App.tsx`, `Terminal.tsx`, `SessionsPanel.tsx` and `HistoryView.tsx`: read-only now means
  device run **or** team.
- CONTINUE HERE: `continue_plan`, then `worktreeAdd` when code came, then `unpack`, then
  `newSession(project, draft, branch)`, then push the attachments through `composerFiles` once
  the Composer is mounted, then `state continued`.
- `Notifications.tsx` and `lib/notices.ts`: the source `team`, with Users as its icon. A click
  opens the session, or the TEAM tab for a picture or file.

### Verify

- `python3 -m pytest tests/ -q` is green.
- In Rivendell, `typecheck`, `lint:ci` and `test` pass.
- `npx tsc -b`, every `node --experimental-strip-types src/lib/*.check.ts`, and a vite build into
  `/tmp` all succeed.
- Headless pictures of the TEAM tab, the sheet and the bar against canned JSON, Attached.
