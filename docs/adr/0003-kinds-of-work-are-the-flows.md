# The kinds of work are the flows

The prompt box's kinds (DESIGN, BUILD, REFACTOR, FIX, SHIP, ASK) used to shape only the prompt they were sent with (a command in front, a model, a mode, an effort), while a separate path, picked afterwards by a /command or by Claude, ran the steps (grill → build → retro). They are now one thing, a flow: the kind you tap or the box guesses starts that flow's steps, one gear edits every flow's steps and defaults, and Claude picks a flow only for a prompt sent with no kind. Why: the user thinks of the kinds as "our flows", expected the steps to belong to them, and found two separate things in one prompt box confusing (2026-11-12).

## Considered Options

- **Two things** (drawn as B · TWO THINGS, not picked): kinds keep shaping one prompt, and paths keep their own steps and switches in SETTINGS. The smaller change, but the box would keep showing two concepts side by side.

## Consequences

- Mid-flow, a guessed kind only sets that prompt's model, mode and effort; only a tap replaces the running flow, so a follow-up never restarts one.
- Every flow setting lives on the bridge (the presets once saved per browser move there), and SETTINGS ▸ AI MANAGEMENT opens the same sheet as the gear, so the DEFAULT layout, which has no kinds row, still reaches it.
