---
name: design-tokens
description: "Use when setting up or auditing a token system — colour, spacing, radius, and type as named decisions."
---

# Design tokens

Use when setting up or auditing a token system — colour, spacing, radius, and type as named decisions.

## Checklist

- Name tokens by role (surface, border, danger), not by value (grey-200).
- Keep one spacing scale and use only its steps; ad-hoc pixel values erode it.
- Define semantic tokens on top of primitives so theming swaps one layer.
- Ship light and dark from the same semantic names, not two component trees.
- Cap the palette — every extra shade is a decision someone must repeat.
- Put the tokens in code, not a doc; a doc drifts within a sprint.
