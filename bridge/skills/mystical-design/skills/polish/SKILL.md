---
name: polish
description: Use after a designed build, or when the user sends /mystical-design:polish — put the approved mockup beside the built screen for each state, run axe, the judgement pass, the web interface rules and a worst-case data check, and fix the drift in at most two rounds.
user-invocable: true
---

# The Polish pass

A designed build is done. This pass makes what was built match what the user approved, and
makes it hold up with real data. Run it in the build's checkout, on the feature branch.

## 1. Read the approved design

The drafts folder is the one your prompt names, or the newest under
`.mystical/design-drafts/`. Read its `SPEC.md` and the approved Direction's mockups: they
are the source of truth. List the states the spec names (empty, loading, error, with data,
each width). Every state gets the steps below.

Start the app's dev server with the Run tool, never a background shell. An **Expo app** runs
through its web target (`npx expo start --web`); the reply then says native-only behaviour
wasn't checked.

## 2. Look at each state

For each state:

1. Capture the built screen at the mockup's width, at 2x (device scale factor 2), in a
   headless browser: the repo's own screenshot kit if it has one, else a short Playwright
   script in `.mystical/scratch/`. Save it to `.mystical/screenshots/<date>/polish/`.
   Capture the mockup the same way. Keep these first shots: the reply's `before` is them.
2. Call `compare_images` with the mockup as `before` and the build as `after`.
3. List the drift: layout, spacing, type, colour, copy, missing or extra elements, motion.

## 3. Run the four checks

Each on the built screen, for every state:

1. **axe and the measured facts:** `inspect_ui` on the page, at the mockup's widths.
2. **The judgement pass:** read `../../references/judgement-pass.md` from this skill's base
   directory (the pack's shared reference) and go through its three parts.
3. **The web interface rules:** load `/mystical-design:web-design-guidelines` over the UI
   files the build changed (`git diff --name-only` against the base branch).
4. **Worst-case data:** load `/mystical-design:break-ui` and feed the screen long names, zero
   items and non-Latin text, at the least.

## 4. Fix, in at most two rounds

A round: fix the drift and every problem the checks found, then capture each state again and
rerun the checks that failed. Stop after the second round, even with problems left.

Commit the fixes on the feature branch. Never commit the drafts or the screenshots: they stay
under `.mystical/`, which git never sees.

## 5. Reply

- Per state, `compare_images` with the first build as `before` and the polished one as
  `after`.
- What was fixed, one line each.
- What's left, with why: a choice for the user, out of scope, or not fixed in two rounds.
- For an Expo app: "Native-only behaviour wasn't checked: this pass saw the web build."
