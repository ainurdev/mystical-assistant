# COUNCIL tab: review, score, fix, repeat before origin

Approved 2026-11-06 through /design-first. The pick was **A · SCOREBOARD** with all three add-ons. The mockups are the visual source of truth: `.mystical/design-drafts/council-tab/` (main checkout), with `SPEC.md` and the `shots/a-*.png` crops for ready, running, passed and stopped, plus `settings-council.png`. Research: `.mystical/docs/reports/Council review before push.md`.

Reviewers per account, 2026-11-17: grilled, then designed. Settings ▸ Council got **B · ON THE BENCH** and the tab's reviewers **B · ROLL CALL**; mockups and `SPEC.md` in `.mystical/design-drafts/council-reviewers/` (main checkout). This spec is updated to match.

## Behaviour (decided by the user)

- **Start:** RUN in the COUNCIL tab. It works only when the session is idle and there is something a push would send.
  - Since 2026-11-11 a flow's REVIEW step starts a run too, by itself, in a ticket set's merge session once MERGE ends (the REVIEW AFTER MERGE switch; `skill-paths.md`, section 4). A pass there starts RETRO. A stop waits on you like any other.
- **A round:**
  - Every reviewer that is on reads the change in a fresh, hidden, read-only run. A reviewer is one **Account** (GLOSSARY): each Claude login (a one-shot `claude -p` on that login) and each Codex, Gemini, Kimi and opencode account (over ACP). Two Claude logins can read the same round.
  - Each rates it 1–10 and lists findings with a severity (`must` / `should` / `nit`), a file, a line and a one-line title.
  - A reviewer whose account is out of usage, signed out or not installed, or an outside agent in a project not on its list, sits the round out with its reason. It never moves to another account. If no reviewer answers, the run stops.
- **Score:** the average of the reviewers that answered.
- **Pass:** score ≥ bar **and** no must-fix that more than half of the reviewers that answered flag: 1 of 1, 2 of 2, 2 of 3, 3 of 4.
- **Fix:** if a round fails, one prompt goes onto the authoring session's own queue, the way goal nudges do. It lists the findings and asks the session to fix them or answer why not. When the turn that ran that prompt ends, the next round starts.
- **Stop:**
  - when it passes;
  - after `max_rounds` (default 5);
  - early, if a round doesn't raise the score (`stop_early`, default on; assumed, shown as a switch);
  - on the user's Stop;
  - when a round errors or there is nothing left to review.
- **Settings:** stored in the bridge DB's `settings` table under the key `council`, edited in Settings ▸ AI management ▸ Council.
  - `bar` 9.0, 1–10, steps of 0.5.
  - `max_rounds` 5, 1–10.
  - `stop_early` true.
  - `reviewers`: the accounts that review, as `"<agent>:<account>"` (`claude:2` is a Claude slot, `codex:` Codex's machine login, `kimi:a_…` an added account). The old `claude` and `codex` switches moved once, saved: Claude's to the login new sessions start on (`profiles.default_profile`), Codex's to its first account. Every other account, and any added later, starts off. Removing an account removes its switch.
  - `projects`: per outside agent, the projects it may read, so client code never goes out by accident. Codex's old `codex_projects` carried over; the rest start empty. Claude logins read every project.
- **Add-ons (picked):**
  1. A notice when a run passes or stops: `council_passed` (done / news) and `council_stopped` (ask / needs). Both go through `runner._notify`, so Telegram follows the user's notify settings.
  2. Council prompts render as a stamp in the chat (`[council n/max]`), like goal nudges.
  3. "Send all advice": one tap queues every non-blocking finding of the last round into the chat, and no new round starts.
- **Stopped actions:**
  - **2 more rounds:** `max_rounds += 2` for this run, then the loop goes on.
  - **Push anyway:** the GIT tab's push.
  - **Side with the session:** dismiss that finding, so it never blocks again in this run and reviewers are told it is settled. Re-check the pass rule.
  - **Fix it anyway:** queue that one finding with "the user wants this fixed". `max_rounds += 1`, then the loop goes on.

## Design choices and why

- **Own rubric prompt, not `/code-review`.** The two seats must rate on one scale for an average to mean anything. `/code-review` gives free text with no rating, and Codex's native `/review` has its own format. One prompt with a JSON answer serves both seats.
- **Hidden one-shots, not visible sessions.** Reviewers need no transcript; the tab shows their findings. A Claude login uses `runner.run_blocking(..., skip_pack=True, permission_mode="plan", account_slot=<its slot>)`, prefixed with `native.INTERNAL_ONESHOT_TAG`. Plan mode keeps Read, Grep and Glob and removes edits and shell, so the diff goes in the prompt.
- **Outside agents** run through `acp.run_turn` with a job-shaped object, a kill timer and every permission request denied, in an asking mode that must take hold before the prompt goes (`opts["must"]`): Codex's read-only mode as its last TEST named it, Gemini's and Kimi's `default`. opencode asks by its preset's `OPENCODE_PERMISSION`. One whose mode won't take hold sits the round out.
- **No "the session's own login" reviewer.** The settings name exactly who reads; each reviewer runs its agent's default model and effort.
- **Majority, not unanimity.** With many reviewers, "every reviewer agrees" lets one holdout wave a must-fix through, and "any reviewer" lets one hunch hold a push hostage. More than half of those that answered is the line.
- **Kimi may review** although Kimi Code's terms call a subscription "for interactive use only". The user chose it on 2026-11-17 knowing that.
- **Merging is in code, no chairman model.** Two findings are the same when they share a file and their lines are within 3. Severity is the higher of the two.
- **How a finding is marked after the fix turn.** The fix prompt asks the session to object to a wrong finding on its own line, `N. NO: <why>`.
  - Answered: the session objected. The answer text is shown, and the next round's reviewers see it.
  - Fixed: the session ran its fix turn without objecting. The next round's review is the check.
  - Open: the fix turn hasn't run yet.

  The stopped box ("they disagree · k rounds") is a blocking finding that matches one in each of the previous k rounds, compared by file and line.
- **State is one JSON column** `sessions.council`, like `sessions.goal`. If a run's process is gone (`pid` differs) while it says `reviewing`, it is shown and saved as stopped: "interrupted by a restart".
- **The client may be newer than the server.** A 404 from the council routes renders "Restart the bridge to use the council", not a broken panel. Settings from a bridge before reviewers per account say "Restart the bridge to pick reviewers per account". A run saved before then keys its seats `claude`/`codex` and still renders, as Claude and Codex.
- **The prompts count, they don't name.** A finding's line says "2 of 3": an account key means nothing to the session.

## Not built

- The Mini App and the bot. The dashboard is 99% of use, and the bot gets the notice.
- A push gate. RUN and a flow's REVIEW step are the only starts.
- A chairman model.
- Live updates over SSE: the tab polls, every 3 s while a run is active and every 15 s otherwise.
- A model or effort per reviewer.
- Real marks for Gemini, Kimi and opencode: the tab and Settings wear the mockup's stand-in glyphs.
