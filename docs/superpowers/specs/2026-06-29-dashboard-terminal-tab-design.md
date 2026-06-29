# Dashboard terminal tab (multi-instance xterm.js)

Replace the Analyze modal's **LOGS** tab with a **TERMINAL** tab: real,
interactive PTY-backed shells (xterm.js) running in the analyzed project's
directory, with multiple concurrent instances. The dev-server log view the LOGS
tab provided is no longer needed — `tail -f .mystical/dev.log` in a terminal
covers it.

## What already exists (verified)

- **Server** is stdlib `ThreadingHTTPServer` (one thread per request), so a
  long-lived hijacked socket won't block others. `do_GET` already validates the
  **Host** allow-list (`_host_ok`) for every GET; the SSE path (`_stream`/`_sse`)
  already hijacks `self.connection`, sets `close_connection = True`, and loops —
  the websocket upgrade reuses exactly this move.
- **Gating** to mirror: Host allow-list (`_HOSTS`), Origin allow-list
  (`_ORIGINS`), per-process token (`_tok_ok`). Streams pass the token as
  `?token=` (EventSource can't set headers). POSTs check Origin + token.
- **`bridge/shell.py`** is a *single* global one-shot command runner (one command
  at a time, line-buffered subprocess, cursor-polled). It is **not** a PTY and
  does **not** support concurrency. Its only consumer (`ShellTab.tsx`) is
  unmounted/dead. We leave it untouched and add a new module.
- **The LOGS tab** is `LogsTab` inside `AnalyzeModal.tsx` (tabs: OVERVIEW /
  CHANGES / ISSUES / LOGS), polling `api.logs(200)`. It is the only mounted logs
  surface. `Logs.tsx`, `ShellTab.tsx`, `RunTab.tsx` are dead/unmounted.
- **`AnalyzeModal`** already loads `worktrees` (`api.worktrees(project)` →
  `{path, rel, branch, head, is_main, …}`) and tracks `selectedBranch`. Worktrees
  live under `.worktrees/` which `browser.within_base` accepts (realpath under
  `BASE_PATH`). `_abs_project(rel)` resolves+validates a rel path.
- **Frontend**: React 19 + Vite 6 + pnpm. No xterm dependency yet. No frontend
  unit-test harness — verification is `tsc -b` + `vite build` + visual check.
  Backend has `tests/test_bridge.py`.
- **Build/deploy caveat** (memory): the dashboard serves a prebuilt `web/dist`;
  rebuild via local bins (`pnpm build` can trip on esbuild); do not restart the
  bridge mid-session.

## 1. Backend — `bridge/terminals.py` (new)

A registry of PTY-backed shells keyed by a random id. Stdlib only (`os`, `pty`,
`fcntl`, `termios`, `struct`, `subprocess`, `signal`, `threading`).

Per instance (`Term`):
- `os.openpty()` → (master, slave). `subprocess.Popen([$SHELL or /bin/bash, "-i"],
  cwd=<abs dir>, stdin/stdout/stderr=slave, start_new_session=True)`; close slave
  in the parent. Set initial winsize via `ioctl(master, TIOCSWINSZ, …)`.
- A **reader thread** loops `os.read(master, 4096)` and fans bytes out to all
  attached sockets (a per-term set of writer callbacks, under a lock). On EOF the
  child has exited → mark dead, notify sockets to close.
- `write(data: bytes)` → `os.write(master, data)` (keystrokes).
- `resize(cols, rows)` → `ioctl(master, TIOCSWINSZ, struct.pack("HHHH", rows, cols,
  0, 0))`.
- `close()` → `os.killpg(os.getpgid(pid), SIGHUP)` then SIGKILL fallback; close
  master; drop from registry.

Module-level API:
- `create(cwd: str) -> dict` — enforce a hard cap (`MAX_TERMS = 12`); return
  `{id, cwd_rel}`.
- `info(project_rel: str | None) -> list[dict]` — live instances, optionally
  filtered to those whose cwd is at/under the given project rel; each
  `{id, cwd_rel, cols, rows, created, alive}`.
- `attach(id, send) -> Term | None` / `detach(id, send)` — register/unregister a
  socket writer; track `last_detached` time.
- `close(id) -> bool`.
- **Reaper** (daemon thread): every 60 s, `close()` any term that is dead, or has
  zero attached sockets and `last_detached` older than `IDLE_REAP = 1800` s
  (30 min) — so a long build survives a closed modal but orphans don't pile up.

## 2. Backend — `bridge/wsutil.py` (new): minimal RFC 6455

~150 lines, server-side only, localhost single-user (no need to be adversarial-
hardened):
- `handshake(handler) -> bool` — verify `Upgrade: websocket`; compute
  `Sec-WebSocket-Accept` (sha1 of key + GUID, base64); write `101 Switching
  Protocols` via `handler.send_response(101)` + Upgrade/Connection/Accept headers.
- `recv_frame(rfile) -> (opcode, bytes) | None` — exact reads; handle payload
  lens 7 / 7+16 / 7+64; **unmask** client payloads (clients always mask); handle
  `close`/`ping` (reply `pong`).
- `send_frame(wfile, data, opcode)` — server frames are **unmasked**; binary
  (0x2) for PTY output.
- Locking: a single send lock per connection so the PTY-reader thread and the
  ping/pong path don't interleave writes.

## 3. Backend — endpoints (in `server.py`)

REST (POST gated by Host+Origin+token like the rest; GET by Host):
- `POST /local/terminals {project|cwd_rel, cols, rows}` → resolve abs via
  `_abs_project`, 400 if invalid/not-a-dir; `terminals.create(abs)`; `{id, cwd_rel}`.
- `GET  /local/terminals?project=` → `{terminals: terminals.info(project)}`.
- `POST /local/terminals/{id}/close` → `{ok}`.

WebSocket:
- `GET /local/ws/terminal?id=&token=` with `Upgrade: websocket`. Routed in
  `do_GET` *before* `_get_api`. Gate: `_host_ok()` (already done up-top) +
  **Origin in `_ORIGINS`** (explicit — WS bypasses same-origin) + `_tok_ok(token)`;
  reject → 403/401. Then `wsutil.handshake`, `terminals.attach(id, send_frame)`,
  set `self.close_connection = True`, and loop `recv_frame`. **Every client→server
  frame is binary with a 1-byte channel prefix** (unambiguous — no type-sniffing):
  - prefix `0x00` → remaining bytes are stdin → `term.write(rest)` (keystrokes).
  - prefix `0x01` → remaining bytes are UTF-8 JSON control,
    `{type:"resize", cols, rows}` → `term.resize(cols, rows)`.
  - `close`/EOF → `terminals.detach`, break.

## 4. Frontend — `api.ts`

Add types + calls:
```ts
export interface TermInfo { id: string; cwd_rel: string; cols: number; rows: number; created: number; alive: boolean }
terminals: (project: string) => req<{terminals: TermInfo[]}>(`/local/terminals?project=${enc(project)}`)
createTerminal: (cwd_rel: string, cols: number, rows: number) => req<{id:string; cwd_rel:string}>("/local/terminals", {method:"POST", body:{project:cwd_rel, cols, rows}})
closeTerminal: (id: string) => req<{ok:boolean}>(`/local/terminals/${enc(id)}/close`, {method:"POST", body:{}})
termWsUrl: (id: string) => `${location.protocol==="https:"?"wss":"ws"}://${location.host}/local/ws/terminal?id=${enc(id)}&token=${enc(TOKEN)}`
```

## 5. Frontend — `XtermPane.tsx` (new component)

Props: `{ id }`. Mounts `@xterm/xterm` + `@xterm/addon-fit` into a div; opens a
WebSocket to `termWsUrl(id)`:
- `term.onData(d => ws.send(0x00-prefixed bytes))` (keystrokes).
- `ws.onmessage` (binary) → `term.write(payload)`.
- `FitAddon` + a `ResizeObserver`: on fit, `ws.send` control `{type:"resize",cols,rows}`
  (0x01 prefix) and `fit()`.
- Reconnect with small backoff if the socket drops while the instance is still
  alive (persist lifecycle). Dispose term + close ws on unmount.

Styled to match the HUD (dark bg, JetBrains Mono, phosphor accents via xterm
theme options).

## 6. Frontend — TERMINAL tab in `AnalyzeModal.tsx`

- Tab list: `{ k: "terminal", l: "TERMINAL" }` replaces `{ k: "logs", l: "LOGS" }`;
  `type Tab` swaps `"logs"` → `"terminal"`; `{tab === "logs" && <LogsTab/>}` →
  `{tab === "terminal" && <TerminalTab project={project} worktrees={worktrees} selectedBranch={selectedBranch} />}`.
- **`TerminalTab`** owns the instance strip:
  - **cwd resolution**: `const wt = worktrees.find(w => w.branch === selectedBranch && w.rel); const cwdRel = wt?.rel ?? project;` — selected worktree if it has one (and a rel within base), else the project dir.
  - On mount: `api.terminals(project)` to list live instances (reconnect to
    persisted ones); render a tab per instance + a `+` button.
  - `+` → `api.createTerminal(cwdRel, cols, rows)`, add to the strip, focus it.
  - `×` per tab → `api.closeTerminal(id)`, drop it; if it was active, select a
    neighbor.
  - Active instance renders one `<XtermPane id=… />`. Inactive panes are
    unmounted (single visible pane) **or** kept mounted+hidden to preserve scroll;
    start simple: keep mounted, `display:none` when inactive (so output keeps
    flowing and scrollback survives tab switches); `fit()` when a pane becomes
    visible (hidden panes have zero size).
  - `LogsTab` is removed; if `api.logs`/`logStream` become unused after this, note
    them as dead (don't delete the backend endpoint).

## 7. Security

- WS upgrade: Host allow-list (inherited) + **Origin in `_ORIGINS`** (explicit) +
  token in `?token=`. Same trust boundary as the rest of the dashboard (a caller
  who can drive Claude here can already run commands), so this exposes no new
  capability — it just makes it interactive.
- cwd is always resolved through `_abs_project` + `within_base`; reject anything
  outside `BASE_PATH`.

## 8. Lifecycle & edge cases

- **Persist**: shells survive closing the modal; reopening lists+reconnects. Reaper
  reaps dead children immediately and idle-disconnected ones after 30 min.
- Shell exits on its own (`exit`/Ctrl-D) → child EOF → marked dead → socket told to
  close → frontend shows "session ended", drops the tab on next list.
- Cap reached (12) → `create` returns an error; `+` button shows it inline.
- Selected branch has no worktree → cwd falls back to project dir.
- WS drops mid-build (network blip) → frontend reconnects to the same id; backend
  PTY keeps running; xterm scrollback is client-side so a full reconnect replays
  nothing — acceptable (output continues live). (No server-side scrollback buffer
  in v1.)
- Reduced-motion / theme: xterm theme uses the HUD palette; no extra animation.

## 9. Out of scope (v1)

- Server-side scrollback replay on reconnect (xterm keeps client scrollback only).
- A top-level terminal view next to CHAT/HIST/DSGN (this lives in Analyze).
- Deleting dead `shell.py` / `ShellTab.tsx` / `RunTab.tsx` / `Logs.tsx` — mention
  as a follow-up cleanup.
- Windows support (PTY path is Unix-only).

## Verification

- Backend: `tests/test_bridge.py` gains tests for `terminals.create/info/close`,
  the cap, cwd validation (reject outside base), and WS-upgrade gating (bad
  host/origin/token → rejected). `wsutil` frame encode/decode round-trip + mask
  handling unit-tested.
- Frontend: `npx tsc -b` + `pnpm build` succeed (rebuild dist via local bins).
- Manual against the running dashboard: open Analyze → TERMINAL; run `ls`, `vim`,
  `top` (curses works); resize the modal (xterm reflows); open a 2nd instance;
  close the modal and reopen (instances reconnect, a `sleep 60 && echo done`
  survives); `×` kills an instance.
