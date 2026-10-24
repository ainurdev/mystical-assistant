# The bot chat: live answers, asks in the chat, a topic per session, quieter pings

The ask (2026-10-24): "how about mystical assistant bot? how we can enhance that as well", then
"all good, build all" for seven ideas drawn from Bot API 9.3–10.3. Six are built. The seventh
(Mystical stops pinging Rivendell job results because Lindir carries them) waits for Rivendell's
notifications v2 phase 4: Lindir doesn't carry job results yet.

## 1 · Live answers with Stop (bridge/tglive.py)

A prompt sent to the bot used to run as one blocking `claude -p`: "🤖 On it…", typing, then the
whole answer, with no Stop. A tool its mode asked about was simply denied. Now it is an ordinary
streaming turn (`runner.start_streaming_job`), the one the dashboard and the Mini App run.

- **Receipts.** 👀 on your message as the turn starts, then 👌 when it ends well or 😢 when it
  fails. Only Telegram's reaction emoji are allowed, so there is no ✅ or ❌.
- **The draft.** While the turn runs, a draft (`sendMessageDraft`, rich since 10.1) shows what
  Claude has said so far and the step it is on, with Telegram's own Stop button (`can_stop`, 10.3).
  - The draft is sent again within its 30 s while the turn runs.
  - Stop comes back as a `stopped_message_generation` update with its `draft_id`, and interrupts
    that turn only (`Job.interrupt`).
- **The answer.** One rich message (`sendRichMessage`, 32k, GFM). Code fences over 15 lines fold
  into `<details>`. A message Telegram refuses goes the old HTML way.
- **Errors and resumes.**
  - A turn picked up again after an error (`_maybe_auto_resume`) is followed to its end.
  - A usage-limit park, an API retry or a login stop already says so in its own notice. That
    notice comes to the chat whatever the routes say (`Job.told`), so the turn only gets 😢. Any
    other failure gets "⚠️ …".
  - A restart that kills the turn says nothing: boot recovery resumes it.
  - The DONE ping is not sent for these turns: the answer is the message (`Job.tg_live`).
  - A turn's questions and approvals reach the chat whatever the routes say (`_notify(always=)`):
    no other surface would show them.
- **Posture kept.** A session with no permission mode of its own runs on the one
  `EXTRA_CLAUDE_ARGS` gives (`--dangerously-skip-permissions` is Bypass). The rest of those flags
  still ride along (`tglive.bot_args`).
- **Agent sessions** (ACP profiles) still say "continue it in the Mini App or the dashboard": the
  chat can't answer an agent's cards.
- shortcut: a turn the runner resumes on its own (a crash, a limit reset, the ladder) runs on the
  session's mode or `MINIAPP_PERMISSION_MODE`, not `EXTRA_CLAUDE_ARGS`.

## 2 · Answer and approve in the chat (bridge/tgask.py)

A turn that blocks on you pings with the ask itself, in place of "Claude needs …" and a button to
the panel.

- **A question.** Its options become buttons, two to a row (`ta:<token>:<index>`). A text reply to
  the ping answers it in your own words.
- **An approval.** ✓ Allow (green) and ✕ Deny (red), using 9.4 button styles. A text reply is a
  no, with what to do instead.
  - The card shows everything Allow approves: the whole Bash command, or the MCP call as the panel
    shows it (the summary is cut to 120 characters).
  - Past 3000 characters it offers only Deny and the panel.
  - A Bash command up to 256 characters gets ⎘ Copy command.
- **Once answered.** The ping is rewritten to record the answer, and its buttons become one grey
  label (10.3 `disabled`).
- **Stale taps.** A tap on a ping that was answered elsewhere, or whose turn ended, says so and
  loses the buttons. So does a late reply. Only ALLOWED_CHAT_IDS can answer.
- **What a chat can't answer whole** (several questions, or several picks) still pings with OPEN
  SESSION. Rivendell runs keep their own ping (`rivendell.ping_question`).

## 3 · A topic per session (bridge/tgtopics.py)

This is on only when the bot has topics in private chats (`getMe.has_topics_enabled`), which is
switched on in @BotFather. With it off, nothing changes.

- **One topic per session.** A session gets its own topic the first time something is sent about
  it, named after the session (renamed when the titler names it, or after the project).
- **Its colour** is one of the six Telegram allows, picked from the project, so a project's
  sessions share one.
- **What goes there:** its draft, answers, asks and notices.
- **What runs there:** whatever you write in it runs in that session.
- **A topic you make** is a new session in the active project, titled after the topic, unless
  Telegram named it for you (`is_name_implicit`): then the titler names it. A topic the bridge made
  is never adopted twice.
- **A deleted or closed topic.** A send Telegram refuses for it goes to the main chat, and the
  session gets a new topic next time (`telegram.gone_threads`).
- **Boot.** A topic message coming in turns topics on, even if boot's getMe failed.
- **The main thread** still takes commands, which are answered there. A prompt written there goes
  to the active project's latest session, and its answer comes in that session's topic.
- **Storage:** `sessions.tg_thread`.

## 4 · Quieter

- **Only what needs you rings** (`notices.tier(kind) == "needs"`: approvals, questions, sign-in,
  the limit card, a Rivendell offer). Everything else arrives silent: DONE, FAILED, PARKED,
  resumes, PR pings, the weekly report, updates, device runs.
- **Quiet hours end in one message.** What they kept off Telegram (the kinds whose route would
  have sent them) comes as one "🌙 While it was quiet" message when they end (`notices.watch_quiet`,
  checked each minute). It rings only if it holds a NEEDS YOU.
  - shortcut: a bridge that is down as quiet hours end sends none.
- **Messages change instead of piling up:**
  - Rivendell's "link broken" message is edited to "✓ Rivendell link back — … Down 14:02 → back
    14:09." when the link proves itself.
  - A PR's "checks failing" ping is edited to "✓ checks passing" once checks have run and passed.
    A fresh push with no checks yet doesn't count.
- **Device runs.** "Started on <device>" goes through the STARTED route (off by default).
- **Copy branch.** PR pings carry ⎘ Copy branch.

## 5 · Small ones

- **Command menu:** the "/" menu, from /help's lines (`setMyCommands` at boot).
- **Reset times in your own clock:** usage-limit times in Telegram are `<tg-time>` entities, so
  the phone shows them in its own time zone (`limits.when_tg`). The dashboard keeps `when_str`.
- **Folded logs:** `/logs` arrives folded in an expandable quote, as typed.
- **Mini App:**
  - full screen on phones (`requestFullscreen`, 8.0), with `#root` padded by Telegram's
    safe-area insets;
  - the home-screen shortcut is offered once (`addToHomeScreen`).
- **TG_RICH** (Settings ▸ RUNS ▸ RICH ANSWERS) turns rich answers off.

## Rollout

- The bridge needs a restart; the Mini App needs a build (`npm --prefix bridge/miniapp/web run build`).
- Topics: switch them on for the bot in @BotFather (Bot Settings ▸ Topics). The next boot reads it.

## Not built

- Streaming word by word: the draft grows a text block at a time, because stream-json hands out
  complete blocks.
- Ephemeral replies, the team group, and pinned live status.
- Custom-emoji logos, which need Premium on the bot owner's account.
- Held files are kept per chat, not per topic.
- Renaming a session from the dashboard doesn't rename its topic, and the reverse doesn't
  either.
