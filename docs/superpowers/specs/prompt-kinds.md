# One prompt box that knows the kind of work

Approved 2026-11-08 through /design-first (three rounds: kinds · new box · final). Mockups and the round
notes: `.mystical/design-drafts/prompt-kinds/` in the main checkout (`21-rail-final.html` is the source of
truth, `SPEC.md` the round log). UX record: `prompt-box-kinds-of-work`.

## Why

A census of the last 3 weeks (972 prompts typed in the dashboard): /design-first 17%, build 16%,
ship (merge/push/PR/cleanup) 15%, questions 13%, fixes 10%, answers to cards 7%. Today's box treats
every prompt the same. Its kinds of work are scattered (a DESIGN button, GRILL behind +, a router caption), and four boxed
chips of equal weight compete with SEND. The user asked for one prompt box that supports each kind of work,
and for the three PROMPT BOX shells to go.

## Behaviour (decided on cards)

- **Kinds:** DESIGN, BUILD, FIX, SHIP, ASK. An answer to a docked question keeps today's Answer key.
- **Guessed per prompt** from free local rules as you type: no model call, no network. The guess shows as
  AUTO. A tap on a kind picks it (filled), and tapping the lit kind again drops it (plain send). Tab cycles
  design → build → fix → ship → ask → plain; Shift+Tab goes back. Esc drops the kind. Emptying the box or switching
  session goes back to guessing.
- **A typed `/command` is never guessed over:** it sends as typed, plain.
- **What the kind changes:**
  - the **key's word** and what is sent: DESIGN `/design-first <text>`; FIX
    `/mattpocock-skills:diagnosing-bugs <text>` while Matt's pack is listed, else the text; BUILD, SHIP and ASK the text as typed.
  - the **live facts** on the rail (below). They never repeat what is already on screen (branch, mode).
  - the **starter**: a picked kind on an empty box shows its outline as a ghost; Tab writes it in.
  - the **run preset** (model · mode · effort · trim), sent with the prompt, queued prompts included.
- **Presets:** defaults below. The PRESET popover edits them: a change applies for this session (in memory),
  and "Save as <Kind>'s preset" keeps it in this browser's settings. Plain (no kind) shows and edits the session's own
  picks, as the run sheet does today.

| Kind | Key | Starter | Default preset (model · mode · effort · trim) |
|---|---|---|---|
| DESIGN | Design | screens · states · what must not change | claude-opus-5-5 · the session's mode · high · default |
| BUILD | Build | what · why · done when | claude-opus-5-5 · bypassPermissions · max · default |
| FIX | Fix | expected · got · where — paste a screenshot | claude-opus-5-5 · bypassPermissions · max · default |
| SHIP | Ship | merge this branch, then clean up | claude-opus-5-5 · bypassPermissions · high · default |
| ASK | Ask | ask about the code, a branch, a decision… | claude-sonnet-5-5 · the session's mode · medium · default |

## Live facts (rail, one line, ellipsised)

| Kind | Source | Reads |
|---|---|---|
| DESIGN | the project's `design_project` (ProjectSettings) | `drafts → Claude Design` when linked, else `no Claude Design project linked` |
| BUILD | the session's GitStatus; Matt's pack listed | `grill, then build here · ` + (`working tree clean` / `N uncommitted` warn); without the pack, `builds here · …` |
| FIX | the newest `checks` event in the open session | `last check <checksLine> · HH:MM` (err when not ok), else `no checks run in this session yet` |
| SHIP | the session's GitStatus | `N uncommitted` (warn) when dirty, then `N to push · N to pull` with an upstream, `N unpublished` without one, `in sync` when both 0 |
| ASK | the project map's `built_at` | `read-only, changes nothing` when its mode is plan, + ` · map built <ago>` when a map exists |

With an empty box and a NEXT step ghost from the router, the facts segment shows that step's caption instead.

## The box (R3 · RAIL)

COMPACT layout only; DEFAULT keeps its markup. The session tabs stay as they are (title, branch, PR, running
app, CTX). Inside the card:

1. **Line one:** `+` (attach, MAP, REVIEW, AUDIT; GRILL goes), the editor at 12px, then the keys. Idle: one
   key, which is the kind's word or Send, min-width 84px so it never moves. Running: Stop · Pause | Steer · Queue, as today.
   Answering: Answer, in the ask colour, as today.
2. **The rail** (30px, panel2, hairline above), four segments:
   - **kinds**, a fixed 188px: the lit kind as glyph + word (outlined with AUTO when guessed, filled when picked),
     the other four as glyphs with their names as tooltips. Dim while answering or on an agent session.
   - **facts**, flexible: the only segment that ellipsises.
   - **preset**, min 196px: the kind's glyph (sliders for plain), model, mode, effort, and trim when not
     default. A tap opens PRESET: model and mode selects, effort and trim segmented, the footer
     "A change here wins in this session." and the link "Save as <Kind>'s preset".
   - **usage**: a 12px ring with the login's 5-hour % left and refill clock. A tap opens today's PROFILE menu.
     Spent: the ring turns err and shows the refill time.
   - Under 700px wide, the preset folds to glyph + model and usage drops its clock, so the facts keep their room.
- Queued prompts become `· N queued ▾` in the working tab; paused reads `paused · N held` there.
- Ledger pills (agents ran, goal, waits) and attachments stay above the text, inside the card.
- Gone: the DESIGN button, GRILL, the router's caption row and its typed-text suggestion and auto-pick
  (the kinds replace them in COMPACT). The router's empty-box NEXT ghost stays.
- Gone from settings: SETTINGS ▸ TRANSCRIPT ▸ LAYOUT ▸ PROMPT BOX and `?composer=`. A stored `composer`
  value is ignored.

## Colour

Kind marks use the accent only (osgiliath: "indigo is you, yellow waits on you"). State colours go only on facts
that carry state: err for a red check, warn for uncommitted files, ok for nothing. The box keeps its hairline
in every state: no focus colour, no kind colour on the edge.

## Out of scope

The Mini App's box. DEFAULT layout's composer. A bridge-side kind router. "Ahead of master" (the git API reads
against the upstream). Trim for queued prompts: the queue carries model, mode and effort, but not ponytail.
