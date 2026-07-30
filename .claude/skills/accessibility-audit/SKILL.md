---
name: accessibility-audit
description: "Use when checking a UI against WCAG basics — keyboard, contrast, semantics, and announced state."
---

# Accessibility audit

Use when checking a UI against WCAG basics — keyboard, contrast, semantics, and announced state.

## Checklist

- Tab through the whole flow: everything reachable, focus always visible, order sane.
- Check contrast — 4.5:1 for body text, 3:1 for large text and UI boundaries.
- Use the native element first; a div with a click handler is not a button.
- Label every input and icon-only control; placeholder text is not a label.
- Announce dynamic changes with a live region, and keep motion respectful of reduced-motion.
- Confirm the page works at 200% zoom and at 320px wide.
