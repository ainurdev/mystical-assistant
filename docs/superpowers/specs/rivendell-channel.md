# Rivendell channel: see the link, watch the run, answer from anywhere (design)

2026-10-06 · approved in chat · mockups in
`.mystical/design-drafts/rivendell-channel/` (git-ignored: `SPEC.md`,
`a-live-jobs.html`, `b-link-broken.html`, `c-telegram.html`, their sources in
`src/`) and in Claude Design at `drafts/rivendell-channel/` · plan:
`docs/superpowers/plans/rivendell-channel.md`

Picks ★41, ★42 and ★43 from `.mystical/docs/reports/Mystical Assistant feature
opportunities.md`.

**Intent.** When the Rivendell link breaks, you should see it, not find it in a
log weeks later. While a job runs, it should be watchable, on the bridge and in
Rivendell, instead of a black box that ends in one text blob.

## A · Live jobs (right rail ▸ RIVENDELL, the approved cards, variant C)

- **Link chip** beside "Rivendell": `LINKED · <time since last job>`.
- **NEEDS YOU** group, on top. A run waiting on a question shows the question
  and its options as buttons, plus OPEN SESSION. Answering resumes the same
  session.
- **RUNNING** gets a live line: the latest tool action, the run's todo progress
  (from its TodoWrite list) and the step count.
- **DONE** gets a result line: PR link, checks state, wall time and tokens.
- **FAILED** gets the outcome label the transcript already uses
  (`bridge/outcomes.py`) and its short reason.

## B · Link broken

- **Chip states** map 1:1 to the existing `riStatusView` states: LINKED
  (connected), CONNECTING… (connecting), RETRY n · countdown (error), TOKEN
  REJECTED (auth_error), OFF.
- **TOKEN REJECTED.**
  - A banner tops the tab: REPLACE TOKEN ▸ opens Settings ▸ PLUGINS editing that
    instance, and TEST LINK.
  - Cards dim to "last known", and IMPLEMENT is disabled.
- **Rail badge.** A red dot on the castle while the state is auth_error, or
  error lasting over 5 minutes. It shows on every tab.
- **Settings.** A TEST row: SEND TEST JOB plus the last round trip. This needs a
  `ping` job kind on Rivendell that the bridge answers without spawning Claude.
- **Alerts.** Bell and Telegram, once, on the move to auth_error, or after 5
  minutes in error. Recovery clears the badge and the bell, and sends no
  Telegram message.

## C · Telegram

- **NEEDS YOU.** The question's options become inline buttons. A tap answers,
  the same session resumes, and the message edits itself to show the answer. A
  text reply to the message becomes a free answer.
- **Link broken.** One message per break.
- **Job done.** The existing ping gains PR, checks and time.

## Contract changes (bridge ↔ Rivendell)

- **Progress**, throttled to about 10s:
  `{state: running|awaiting_input, activity: {kind: action|thought|question|response|error, text}, todos: {done, total}, step}`
- **awaiting_input.** `{question, options[]}`, plus an answer path back
  (Rivendell can answer too; the bridge resumes the session).
- **Result.** `{status, outcome, text, pr: {number, url, checks}, session_id,
  dashboard_url, wall_s, active_s, tokens: {in, out}, model}`. That's tokens and
  time, not dollars: dollar figures were deliberately dropped.
- **ping.** The job kind behind the TEST row.
- **Rivendell's side.** Its task page needs its own design pass, in the
  Rivendell repo, to show progress, questions and results.

**Today's gap behind NEEDS YOU.** Autonomous Rivendell runs can't ask questions
yet. The run must be allowed AskUserQuestion, and the bridge must hold it as it
already does for dashboard sessions (`QuestionCard`).

**Tokens.** `--warn` NEEDS YOU, `--acc` RUNNING, `--ok` DONE and LINKED, `--err`
FAILED, TOKEN REJECTED and the rail dot. The card chrome is unchanged from
variant C.

## Settled (2026-10-06)

The draft's three open questions, answered by the user:

1. **Who answers NEEDS YOU.** Only the bridge's owner answers NEEDS YOU
   questions, from the RIVENDELL tab, the session itself, or Telegram.
2. **Which jobs ping.** Telegram pings NEEDS YOU for every Rivendell job on this
   bridge.
3. **Grace.** There is a 5-minute grace before a DISCONNECTED alert.

**Order.** Bridge side first. The contract changes also need Rivendell PRs,
which are prepared but never pushed.

## Found while planning (2026-10-06)

Checked against the code and the CLI before writing the plan. The plan argues
from these; the design above is unchanged.

- **Autonomous runs can already ask.** Under the exact argv a Rivendell run
  gets (`-p`, stream-json, `--permission-mode bypassPermissions`,
  `--permission-prompt-tool stdio`), claude 2.1.280 still routes AskUserQuestion
  to the bridge as a `can_use_tool` request and blocks until it is answered, and
  the bridge already holds it like a dashboard session's question. The real gap
  is that nobody sees it, and that the job's own wall-clock limit
  (`review_timeout` / `impl_timeout`) keeps running while it waits.
- **There is no TodoWrite in `-p` mode** on claude 2.1.280. Runs plan with
  TaskCreate / TaskUpdate, so todo progress counts those.
- **Rivendell rejects unknown result fields.** Its global ValidationPipe is
  `whitelist` + `forbidNonWhitelisted`, so a result POST carrying any new field
  is a 400 on the deployed API. Every new field waits for Rivendell to
  advertise it.
- **Rivendell drops unknown socket frames silently.** The gateway has no inbound
  handlers, and `@nestjs/platform-ws` swallows a frame no handler claims.
