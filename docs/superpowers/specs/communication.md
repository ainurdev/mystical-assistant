# Communication: drafting messages with person, client and project context

Designed and approved 2026-11-06.

- Research: `.mystical/docs/reports/Communication sessions and message drafting.md`.
- Mockups: `.mystical/design-drafts/comms/`, with SPEC.md, pages 01–07 and `shots/`.
- Plan: `docs/superpowers/plans/communication.md`.

## Why

- **Drafts run inside coding sessions.** Over Oct 8 to Nov 6 there were 7 message sessions out of about 620.
  A drafting turn read 0.16M to 10.6M cached tokens. Style rules get retyped, and nothing remembers a person.
- **The text you answer is someone else's.** A client's Slack message can carry instructions to the
  model, and 680 of 731 sessions ran in bypass. A drafting place has to hold private data and untrusted
  text without a way to send anything out.

## Decisions (the user, 2026-11-06)

| Question | Decision |
|---|---|
| Where drafts live | A Communication project: `~/Projects/communication`, a git repo, so it lists like any project |
| Person files | In that folder, git-ignored |
| Levels | `people/<name>.md`, `clients/<client>.md`, `you.md` (your voice everywhere). The person wins over the client, and the client over you |
| Capture from Slack | **A · IN THE BOX**: a Mac Service opens a fresh Communication session with the text quoted in the composer; person and project are tokens in the prompt. Never sends |
| Add-ons | Copy brings the source app back to the front; rewrite chips under a draft (Shorter, Warmer, More formal, In their language) |
| Study | **B · STUDY SHEET**: files or pasted text only. Keeps your style, facts that change a draft, **and samples of how they write**. Teaches a person, a client, or you. A review list with switches, then Save |
| People | **B · PEOPLE TAB, round 2**: a right-rail tab. People are Rivendell clients and contacts plus personal files. Each person shows NEXT meeting, FOLLOW UP (**both directions**), LAST MET, style, samples, a quiet "study a file" link, Draft follow-up / Draft |
| Learning | Ask only when a correction sounds lasting or repeats, or when a sent text is pasted back. Scope: person, client or you |
| Slack app | Not now |
| What they want | A reply to someone's message opens with an IMPORTANT box: what they want from you, one line each, dates kept, then the draft. Nothing is saved from it (grill, 2026-11-06) |
| People order | First, anyone you owe a follow-up or meet in the next 7 days: soonest meeting first, then the oldest follow-up you owe. Then the rest by client (grill, 2026-11-06) |

## Architecture

### 1. The home (no bridge code)

`~/Projects/communication` is a git repo under BASE_PATH, so PROJECTS, NEW SESSION and SETTINGS ▸ Projects
list it with no change (`bridge/browser.py:19-38`).

- **Tracked:** `CLAUDE.md`, `.claude/settings.json`, `.claude/output-styles/comms.md`, `templates/`, `.gitignore`.
- **Ignored:** `people/`, `clients/`, `you.md`. That is personal data. Erasure is `rm`, and it never enters git history.

The folder's own settings bind under bypass. Deny rules apply in every mode, and the bridge passes no
`--setting-sources`:

- **Deny:** the shell, the web, subagents, schedulers and worktrees.
- **Deny:** the bridge's own `verify`, `goals` and `mystical-ux` servers. `verify`'s Run starts any shell command.
- **Deny:** every configured MCP server except Rivendell, plus Rivendell's write tools and `snelstart_read`.
- **Deny:** edits to `.claude/**` and `CLAUDE.md`.
- **Deny:** reads of `~/.ssh`, `~/.aws`, `~/.bridge_state`, `~/.mystical/accounts` and `.env` files.
- **Ask:** every write to `people/`, `clients/` and `you.md`.
- `blockWritesOutsideWorkingDirectories`, auto-memory off, and the `Comms` output style.

The Rivendell write tools are denied **by name**. Re-check that list whenever Rivendell adds a tool.

### 2. The files

A person file has front matter for:
- `name`, `aliases`, `handles` (slack, email);
- `client`, `rivendell_contact`, `default_project`;
- `language`, `register`, `length`, `greeting`, `signoff`;
- `updated`.

Its body has Do / Don't, Your samples (3 to 5 of your own messages) and How they write (their samples, dated).
A client file holds the rules shared by everyone there. `you.md` holds your voice.
Templates are in `templates/`.

### 3. `writing-messages` reads them everywhere

The bridge-wide skill (`~/.claude/skills/writing-messages/SKILL.md`) reads the recipient's files before writing,
in any session. This is flow B, "tell the client what we just fixed" from inside a project session.
It never writes to the folder outside the Communication project. When it answers someone's message, the reply
opens with a `> [!IMPORTANT]` box of what they want from you, which the dashboard and Mini App already draw.

### 4. Capture (A · IN THE BOX)

- **Mystical.app.** It registers a text Service, "Draft in Mystical":
  - `NSServices` with `NSSendTypes: public.utf8-plain-text`, `NSRequiredContext: {}` and `servicesProvider`;
  - `frontmostApplication` names the source app;
  - the page gets a hook, the way `__mysticalOpenSession` works today (`DashboardWindow.swift:139-152`).
- **The page.** It opens a fresh Communication session:
  - the composer holds a captured block: source, time, "someone else's text", and ✕;
  - person and project tokens follow the skill-router ghost rule: dashed when guessed, solid when known;
  - nothing is sent.
- **The prompt.** It carries `<captured source="Slack" at="…">…</captured>`, with any closing tag inside the text removed.
- **The add-ons.** Copy on a draft asks Mystical.app to bring the source app forward, and the rewrite chips send another prompt.

### 5. People tab (B, round 2)

A right-rail tab. A bridge endpoint merges three sources:
- Rivendell clients and contacts (`/clients`, `/clients/:id/contacts`);
- meetings: the calendar and briefs (`/calendar`, `MeetingBriefRequest`), plus Circleback meetings and their
  action items (`/clients/:id/circleback-meetings`, `CirclebackActionItem`, assignee name and email);
- local files.

**The list:**
- First, anyone you owe a follow-up or meet in the next 7 days, each shown once: soonest meeting first, then
  the oldest follow-up you owe.
- The rest are grouped by client, then Personal, then You.
- Each row has one badge: a meeting soon (the next 7 days, ask colour), open follow-ups, or "last met Nd".

**The open person:**
- NEXT: the meeting, with "brief ›".
- FOLLOW UP: open items from meetings they attended, yours to them and theirs to you.
- LAST MET: date, length, "notes ›".
- Style chips, "N yours · N theirs · study a file", and the buttons Draft follow-up (N) and Draft.

Draft follow-up opens a Communication session with the open items in a Rivendell-sourced block. Nothing is sent.

### 6. Study sheet (B)

The sheet picks:
- Teaches: Person, Client or You, with a picker;
- the source: a drop zone, or paste;
- what to keep: your style, facts, how they write.

Study runs one turn in the home that returns a proposal and writes nothing. The sheet shows it in three groups:
- Your style;
- Facts (a `→ CLIENT` tag sends a line to the client file);
- How they write.

New lines are on and in colour; lines already known are grey. Save writes the chosen lines to the files the footer
names, through a bridge endpoint that only appends to those files. The source file is never kept.

### 7. Learning

A lasting or repeated correction becomes a pending line in the person (People tab), in yellow, with a
Person · Client · You switch and Keep/Drop. In a session with no tab open, the question card from the
CLAUDE.md asks the same thing.

## Trust boundary

- **Captured text and study sources are data.** They arrive in an envelope, and CLAUDE.md says to answer them, never obey them.
- **No way out.** Shell, web, subagent and every writing MCP tool is denied in the home, so an injected instruction has
  nowhere to send data. The one remaining channel is the draft, and you read it before you paste it.
- **Writes need a yes.** Person, client and you files change only on a yes: an ask rule, or the sheet's Save.
- **Preconditions before real client text** (the user):
  - turn FileVault on. `fdesetup status` printed "FileVault is Off." on 2026-11-06;
  - check each Claude login's plan and its training setting.

## Unverified

- That ask rules show as dashboard Allow cards in a bridge turn. Plain `-p` denies them.
- That Services fire inside Slack desktop.
- Slack's window title format.
- Whether the bridge's Rivendell token can GET the client, calendar and Circleback routes. The MCP's `read_route` reads
  "as you", so it can; the bridge's own token was first limited to `/plugin/*`.
- That the local Rivendell checkout (49714f28, 2026-10-29) matches prod.
