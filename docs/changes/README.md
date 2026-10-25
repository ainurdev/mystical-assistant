# Change notes

A change that only shows in a state (a login at its limit, a question waiting) has nothing
the changelog's Open › can show. A note here brings the change's own words and a picture, and
the changelog tells it first (`bridge/whatsnew.py`, `docs/superpowers/specs/changelog-v4.md`).

Notes are rare by choice: the three here are the pictures for the 2026-10-25 overnight changes,
and nothing asks a change for one (each picture is weight in a public repo). To add one anyway,
commit `<slug>.md` with the change, the slug in lowercase letters, digits and dashes.

```
---
area: Usage limits
when: a login hits its 5-hour limit
place: rail:usage
---
A card holds the chat while it's parked and counts down to the reset.
```

- `area`: the change's name, a few words. Needed.
- `when`: the state it shows in. Optional; the changelog says SHOWS WHEN.
- `place`: where Open › goes, one of `whatsnew.PLACES`. Optional; none means no Open ›.
- `for`: only for a change an earlier update already told: one of its commits. The note then
  joins that update's entry instead of being told again.
- Then one sentence: what it does for the person using it. Needed.

Beside it, the same slug:

- `<slug>.webp` (or `.png`, `.jpg`): a still, 16:10 at 2x (1040 × 650), under 120 KB.
- `<slug>.mp4`: a clip, H.264, muted, up to 6 s, under 400 KB. The still beside it is its poster.

**The repo is public: nothing private in frame.** No real emails, accounts or tokens, and nothing
from another project (client repos, their sessions and branches). Shoot it on a scratch bridge, or
take the design draft and replace its names.

A change you can open (a tab, a setting) needs no picture: give it a `place` instead.
