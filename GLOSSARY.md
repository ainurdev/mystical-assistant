# Mystical Assistant

A bridge that runs Claude Code on this machine, driven from a Telegram bot, a Telegram Mini App and a localhost dashboard.

## Dashboard header

**Clock**:
The time readout at the top of the dashboard, over the right panel (or at the end of the chat header while the right panel is folded). A click on it opens the Almanac.
_Avoid_: header time, wall clock, clock menu

**Almanac**:
The drop-down under the Clock: a month calendar with today's weather in full, every login's limit resets and the world clocks.
_Avoid_: clock overlay, clock popover, calendar panel

**World clock**:
The time in one other time zone, picked from the time-zone list; there are at most two. Each can also be pinned to the header beside the Clock.
_Avoid_: second time zone, extra clock, city clock

**Limit reset**:
The moment a login's usage window (the 5-hour one or the weekly one) rolls over and its allowance refills.
_Avoid_: refill, renewal
