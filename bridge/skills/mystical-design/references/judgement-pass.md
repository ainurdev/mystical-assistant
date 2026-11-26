# The judgement pass

Read this after axe has run. axe checks what a machine can see: alt text, contrast, ARIA
validity. This pass checks the rest. design-first runs it on every Direction, the
Polish pass on the built screen, and the Screen audit on a screen as it is.

Go through each of the three parts below for every state you show. For each failure,
name the element, what is wrong and the fix. Don't report a part that passes.

## 1. Keyboard, focus, labels and announced state

From accessibility-audit:

- Tab through the whole flow. Every control can be reached, focus is always visible, and
  the focus order follows the reading order.
- Use the native element first. A div with a click handler is not a button.
- Every input and every icon-only control has a label. Placeholder text is not a label.
- Colour alone never carries meaning.
- Dynamic changes are announced with a live region. Motion respects reduced-motion.
- The page works at 200% zoom and at 320px wide.

## 2. Empty, loading and error states

From empty-states. Design these three states, not only the state with data:

- **Empty:** say what goes here and give the one action that fills it. First-run empty
  and filtered-empty are different states with different copy.
- **Loading:** a skeleton holds the layout, so nothing jumps when the data arrives. On a
  long wait, show the time elapsed, not a guess at the time left.
- **Error:** say what failed, whether the user or the system caused it, and offer a
  retry. When a refresh fails, keep the content that already loaded on screen.

## 3. Long content

Put the longest real value in each slot and look again:

- a long name, title or label, and one word with no break points (an email or a URL);
- a very short value (one letter) and a missing value;
- a large count (10,000 or more) and a long list;
- text in another script (Arabic, Chinese) and emoji.

Text wraps or truncates with a way to read it all. Nothing overlaps or pushes a control
off screen. Rows keep the same height. For a full worst-case run, load
/mystical-design:break-ui.
