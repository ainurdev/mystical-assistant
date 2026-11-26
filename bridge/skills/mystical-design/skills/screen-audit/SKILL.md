---
name: screen-audit
description: Use when the user sends /mystical-design:screen-audit <screen> — review one existing screen in any repo, outside any flow. Lists its problems ranked P0 to P3, each on a screenshot that outlines its element, then asks one card: fix all, pick some, or park. Changes nothing before the pick.
user-invocable: true
---

# Screen audit

The argument is one screen: a URL, a route (`/settings`) or a name ("the login page").
Review it as it is. This is not a design run: no Directions, no drafts, no flow.

**Read-only until the pick.** Before the card in step 6, change nothing in the repo:
no fix, no DESIGN.md, no formatting, no commit. Screenshots and notes go in
`.mystical/`, which git never sees.

## 1. Find the screen

- **A URL:** use it.
- **A route or a name:** find the route in the repo's router or pages, then the address
  of the server that serves it. Check the usual ports with `curl -s -o /dev/null -w
  '%{http_code}'` first. Start the repo's dev server with the Run tool only when nothing
  answers, and say that you did.
- Several screens match the name: ask which, in one card.
- The screen needs a sign-in or data you don't have: say so and stop.

## 2. Put it on a Design board

`show_design` with `pages: [{name, url}]` and a title like "Audit: Settings". The
critic reviews this board, and the user can point at the screen while you work. Keep
the board id it returns.

## 3. Checks

Run each once, in this order:

1. **inspect_ui** (through find_tools) with the board and page, at phone and desktop
   width (its default). Keep its axe violations and measured facts.
2. **The judgement pass:** read `../../references/judgement-pass.md` from this skill's
   base directory and go through its three parts on the screen.
3. **/mystical-design:web-design-guidelines** over the screen's UI files, when its code is
   in this repo. Its output is a report: apply none of it.
4. **critique_design** (through find_tools) with the board and page, once. It takes a
   minute or two: when it says it's running, call it again.

Check each problem before you keep it: open the screen and confirm it. Drop what you
can't confirm. Merge the same problem found by two checks into one.

## 4. Rank

Rank every problem by the critic's definitions:

- **P0:** the job can't be done, or the screen breaks.
- **P1:** most people will struggle.
- **P2:** friction or inconsistency.
- **P3:** polish.

Number them 1, 2, 3… from the most severe.

## 5. The report, one screenshot per problem

For each problem, a screenshot that outlines its element, at the width where it shows:
in a headless browser (the Playwright MCP, or bridge-eyes in Mystical's own repo; load a
missing MCP with the mcp-on skill), set `outline: 3px solid #ff2d55; outline-offset: 2px`
on the element and save the shot as
`.mystical/screenshots/<YYYY-MM-DD>/screen-audit-<slug>/<n>-p<severity>.png`.
A problem with no one element (the whole page's contrast, a missing state) gets the
full-screen shot.

Then show_image for each shot, captioned "<n> · P<severity> · <what's wrong>", and the
report: one line per problem, most severe first, saying the element, what is wrong, the
fix and which check found it.

## 6. The card

One AskUserQuestion card:

- **Fix all:** fix every problem, most severe first.
- **Pick some:** the user says which numbers (a multiSelect card when there are four or
  fewer). Fix only those.
- **Park:** fix nothing.

Fix in the repo's normal way and show the before and after per problem with
compare_images. A fix that needs a design decision goes to the user first.

**Park** adds one item with `work_list` (`action: add`): title "Screen audit: <screen>",
and in `detail` every problem as "<n>. P<severity> <element>: <what's wrong>. Fix: <fix>.
Shot: <absolute path>". These problems are a **Task**, never a Finding: the watcher's
list stays the watcher's.
