---
name: empty-states
description: "Use when a view can be empty, slow, or broken — design the other three states, not just the happy one."
---

# Empty, loading & error states

Use when a view can be empty, slow, or broken — design the other three states, not just the happy one.

## Checklist

- Empty: say what goes here and give the one action that fills it.
- First-run empty differs from filtered-empty; do not reuse one copy for both.
- Loading: hold the layout with a skeleton so nothing jumps when data lands.
- Skip the spinner under ~300ms; it reads as slower than nothing.
- Error: say what failed, whether it was them or us, and offer a retry.
- Keep already-loaded content on screen when a refresh fails.
