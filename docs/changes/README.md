# Change notes

A change that only shows in a state (a login at its limit, a question waiting) has nothing
the changelog's Open › can show. A note here brings the change's own words and a picture, and
the changelog tells it first (`bridge/whatsnew.py`, `docs/superpowers/specs/changelog-v4.md`).

One note per change, committed with it: `<slug>.md`, the slug in lowercase letters, digits and dashes.

```
---
area: Usage limits                   the change's name, a few words
when: a login hits its 5-hour limit  the state it shows in (optional)
place: rail:usage                    where Open › goes, one of whatsnew.PLACES (optional)
for: c6b6d84a                        only for a change an earlier update already told: one of its commits
---
One sentence: what it does for the person using it.
```

Beside it, the same slug:

- `<slug>.webp` (or `.png`, `.jpg`): a still, 16:10 at 2x (1040 × 650), under 120 KB.
- `<slug>.mp4`: a clip, H.264, muted, up to 6 s, under 400 KB. The still beside it is its poster.

**The repo is public: staged data only.** No real emails, client projects, session titles or
tokens in frame. Shoot it on a scratch bridge, or take the design draft and replace its names.

A change you can open (a tab, a setting) needs no picture: give it a `place` instead.
