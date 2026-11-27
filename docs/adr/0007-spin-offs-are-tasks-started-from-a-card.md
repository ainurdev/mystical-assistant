# Spin-offs are Tasks started from a card

When a session turns up work it isn't doing itself, such as Sentry issues across orgs, a bug in another repo or a plan that spans repos, each item becomes a **Task** on its own project's work list and opens its **Spin-off** there. That happens only when you tap START or PARK on the card the sending session offers; no agent can start a session in another project. Item text comes from Sentry, trackers and other people's repos, which anyone can write into, so text must not be able to set work going. That is the rule the work list already keeps. A Task also gives what a bare session wouldn't: a repeat matches by its source link, a chain across repos is armed with one tap and starts each link when the one before is done, and a parked item can be started later from its project's WORK panel. Decided 2026-11-27 in the spin-offs grill.

## Considered Options

- **The agent opens the sessions itself** (not picked): it would be fastest, but one planted line in an error message could start work in any repo, under that project's permission mode.
- **Plain sessions, no Task** (not picked): nothing would remember which issue already has a session, and chains would need a scheduler of their own.
- **Park on work lists only** (not picked): it needs no new UI, but no task had been started from a WORK panel by 2026-11-20. The card puts Start where the list was made.

## Consequences

- Writes to the work list are no longer limited to the chat's own project: a session files Tasks into other projects' lists, and a Task's blockers can sit in another project.
- Clone & start runs only for repos owned by your own GitHub accounts and orgs, and never from the phone's Start all, because a cloned repo's CLAUDE.md steers the agent that runs in it.
- The full card is the dashboard's. On the phone it is one line: Start all · Open session.
