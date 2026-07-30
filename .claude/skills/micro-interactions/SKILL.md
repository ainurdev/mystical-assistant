---
name: micro-interactions
description: "Use when adding motion or feedback — fast, purposeful, interruptible, and reduced-motion aware."
---

# Micro-interactions

Use when adding motion or feedback — fast, purposeful, interruptible, and reduced-motion aware.

## Checklist

- Every action needs feedback inside 100ms, even if the result is slower.
- Keep transitions in the 150–250ms range; longer reads as sluggish.
- Ease out for entrances, ease in for exits.
- Animate transform and opacity only — anything else costs a layout pass.
- Motion should explain a change of state, never decorate an idle screen.
- Honour prefers-reduced-motion with a cross-fade instead of movement.
