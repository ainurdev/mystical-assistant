# Team · threads: updates, sending back, and what travels with a session

The ask (2026-10-22): build ideas 1–7 from the TEAM e2e review, leaving out #8 (live follow,
presence with context, the Mini App). Approved 2026-10-22 from mockups drawn on the real dashboard (THE SHIRE settings) with canned
TEAM data; the draft and its probe kit are in `.mystical/design-drafts/team-collab/`.

## The one idea underneath: a thread

Every session you send carries a **thread** id in its `meta`. A session that CONTINUE HERE makes
inherits its share's thread. The same piece of work is then recognisable on both machines, however
many times it is sent and in whichever direction.

- **Rivendell doesn't change.** `meta` is opaque to it and stays well under its 4 KB cap.
- **Data.** Everything lives in `team.json` beside the DB (0600), with no new DB column:
  - the sender maps thread → its own session;
  - each received share records its thread, the session you continued it into, and the newer share
    that replaced it (`folded_into`).
- **What carries over.** A share's transcript payload also carries one hop back, as `earlier`: the
  turns of the share it was continued from, run through the same whitelist and redaction.

## 1 · An update replaces the older card (01-team-tab.html)

- **A new version folds in the old one.** A share in a thread you already got from the same person
  replaces the older card. Its kind gets an **UPDATE · V2** pill (`--acc`).
- **The card says what changed.** A line reads "+3 turns since v1, which you continued at 03:06".
  When you only opened v1, it reads "+3 turns since v1, which you opened".
- **Actions when you continued v1:** **CONTINUE IN YOURS** (primary) and a quiet "or start a new
  session with it". CONTINUE IN YOURS opens the session you made from v1, with:
  - `update.md` attached (only the turns newer than v1, matched by each turn's start time);
  - the new pictures attached;
  - their newer code, if it came, on a branch of its own (`…-2`, as today), named in the draft;
  - the prompt left unsent.
- **Older copies.** The folded version's read-only copy goes from your machine; its record stays,
  for the link to your session.
- **SEEN** shows one row per thread, with a **V3** pill when versions were folded in.

## 2 · Sent back (01-team-tab.html, 03-thread.html)

- **When it applies:** a share in a thread you sent yourself, like Erfan returning your session.
- **The card:** a **SENT BACK** pill (`--purple`) and "3 turns on top of yours · you sent it to
  Erfan 5h ago".
- **CONTINUE IN YOURS opens your original session.** Their turns are attached as `update.md`, plus
  their pictures. Their code goes on `from-erfan/…`, and a "back from Erfan · 3 turns" chip sits by
  the composer (07). The prompt is left unsent, and the draft keeps the "treat it as notes" guard.
- **The read-only bar** reads SENT BACK BY ERFAN BESHARAT, with DISMISS, NEW SESSION and CONTINUE
  IN YOURS.
- **If your session is gone**, it falls back to today's CONTINUE HERE.

## 3 · The send sheet knows what they have (02-send-sheet.html)

- **When this thread already went to the person you picked**, a box under TO says so: "Mahdi has
  this session: sent 3h ago, OPENED 2h ago. Since then +2 turns, 1 picture. It goes as v2…". It is
  read from YOU SENT's out-box rows (thread + recipient).
- **The button** becomes SEND UPDATE. With nothing new since, the box says they have this exact
  version and the button reads SEND AGAIN.
- **The redaction line** adds "your home folder shows as ~". Paths under your home are rewritten
  to `~` before anything leaves (`/Users/mhzrerfani/…` → `~/…`).

## 4 · Earlier in this thread (03-thread.html)

- **A plate above the first turn** of a session that came with an earlier hop: EARLIER IN THIS
  THREAD, then whose turns, how many, and when. In this example they are your own turns. SHOW
  expands them in place, dimmed.
- **`transcript.md`** (CONTINUE HERE's attachment) puts the earlier hop first. A third person then
  gets the context, rather than "read the attached transcript" with nothing attached.

## 5 · No repository: pick a project (04-no-repo.html)

- **When it applies:** a session share that has no GitHub repository (`meta.repo` null) and no
  project at the same path.
- **What you get:** "Where should Payam's session continue?", with your projects, the open one
  first and picked (OPEN NOW), and a search. The confirm button names the project.
- **The osanwe rule stays.** A repository that is known but not cloned still means CLONE & INSTALL
  or nothing.

## 6 · A turn still running (02-send-sheet.html, 03-thread.html)

- **The sender's choice.** The sheet adds a WHEN row with **When it ends** (default; the button
  reads SEND WHEN IT ENDS) or **Now**. A queued send shows in YOU SENT as AFTER ITS TURN (`--warn`).
- **Restarts.** It is kept in `team.json`, so a restart sends it once the turn has ended.
- **What the receiver sees.** A turn sent unfinished keeps "done" (no spinner forever) and gets an
  **Unfinished** plate in place of its answer: "still running when Erfan sent this, so there's no
  answer yet".

## 7 · Picture titles (01-team-tab.html)

- **A picture sent from a turn** is titled "<session title> · screenshot". The sheet lets you edit
  it.
- **The card** shows the file name and size underneath, in mono.

## Files

- **Python.** `bridge/team.py`: thread ids, the `earlier` hop, update/sent-back detection, the
  `update.md` delta, folding, the queued send, home → `~`, and the picture title. The queued send
  needs a turn-end hook, either in `runner` or by polling the session's turn status.
- **Routes.** `bridge/dashboard/server.py`:
  - send takes `title` and `when`;
  - the state route takes the continued session's id;
  - `/team/continue` answers the "yours" plan.
- **Dashboard.** `TeamPanel.tsx`, `TeamSendSheet.tsx`, `TeamBar.tsx`, `App.tsx` (continueShare's
  "yours" path and the project picker), `lib/team.ts` + `team.check.ts`, and the earlier plate plus
  the unfinished plate in the transcript.
- **Tests.** In `tests/test_team.py`.
- **Not touched:** Rivendell, the Mini App, Telegram (it keeps saying "sent you a session").

## Open

- **Folded copies.** Should a folded version's read-only copy be deleted at once (proposed), or
  kept until it expires?
- **How far back `earlier` goes.** One hop back (proposed) or the whole chain? Each hop adds its
  transcript to the 9 MB cap.
- **Wording.** "CONTINUE IN YOURS". The alternatives were "ADD TO YOURS" and "BACK TO YOUR
  SESSION".

## As built (2026-10-22)

- Folded copies go at once (their records stay); `earlier` is one hop back; the label is CONTINUE IN YOURS.
- A thread's first session (`thread == hash(its id)`) never carries an `earlier` hop, even after
  something came back into it through CONTINUE IN YOURS.
- "Your N turns" on the earlier plate: the hop's `from.id` against your id, read off YOU SENT's rows
  (no out-box yet: their name instead).
- An unfinished turn's last words stay plain text: RunStream doesn't promote them to the answer.
- The "back from Erfan · N turns" chip is a pill in the composer's strip (BackPill), gone once you send.
- The picker lists your projects by their rel (`/ainurhq/acme`), the open one first.
- In the Pebble and Middle-earth families the pills read lowercase ("update · v3"), as every bordered
  label in the right rail does there (index.css natural case).
- Tested end to end on three scratch bridges against a scratch Rivendell
  (`.mystical/team-e2e/up.sh`, `flow.py`), and in the real dashboard build.
