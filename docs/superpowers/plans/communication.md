# Communication: plan

Spec: `docs/superpowers/specs/communication.md`. Mockups: `.mystical/design-drafts/comms/`.

Each slice ships on its own. Slice 1 has no repo code. The others follow the bridge-feature-slice and
bridge-worktree skills, and go live through ⟳.

## S1 · The home (no repo code)

1. Create `~/Projects/communication`:
   - `git init`;
   - `.gitignore` (`people/`, `clients/`, `you.md`);
   - `CLAUDE.md`;
   - `.claude/settings.json` (the deny/ask policy in the spec);
   - `.claude/output-styles/comms.md`;
   - `templates/{person,client,you}.md`;
   - one first commit.
2. Add the read-the-recipient step to `~/.claude/skills/writing-messages/SKILL.md`.
3. **Checks:** plain `claude -p --no-session-persistence --strict-mcp-config` runs in the folder.
   - The tool list has no Bash, WebFetch, WebSearch or Agent.
   - A write to `people/x.md` is not approved.
   - A write outside the folder is refused.
   - The output style applies.
4. **Check under the bridge:** one Communication session.
   - Its tool list has no `mcp__verify__*`, `mcp__goals__*` or `mcp__mystical-ux__*`.
   - An edit to `people/x.md` shows an Allow card.
5. **The user, before real client text:**
   - turn FileVault on;
   - check each login's plan and training setting;
   - then seed 2 or 3 people with 3 to 5 of your own messages each.

## S2 · Bot refuses forwards (small, security)

- `bridge/dispatch.py` `on_message`: a message with `forward_origin` gets a one-line reply ("forwarded messages
  aren't run; paste the text into a Communication session") and never reaches `_run_prompt`.
- Test in the dispatch tests. It goes live after ⟳.

## S3 · Capture: A · IN THE BOX, plus the two add-ons

1. **Mac.**
   - `macos/build.sh` writes `NSServices` with "Draft in Mystical", `NSSendTypes` text and `NSRequiredContext {}`.
   - `AppDelegate` sets `NSApp.servicesProvider`. Its handler reads the pasteboard string and the
     `frontmostApplication` name, then calls a page hook (new, beside `__mysticalOpenSession`).
   - `DeepLink` gets `mystical://compose`, for the Quick Action and the other shells. Tests go in `CoreTests`.
2. **Page.**
   - `lib/capture.ts` builds the envelope and strips closing tags. Its `.check.ts` covers injection and size caps.
   - The hook opens a fresh session on the Communication project and prefills the composer: the captured block,
     plus person and project tokens following the skill-router ghost rule. It never sends.
3. **Add-ons.**
   - Copy on a draft in a Communication session posts `activateSource` to Mystical.app, which brings that app forward.
   - The rewrite chips under the last draft send "shorter", "warmer", "more formal", or "in <language>".
4. **Check.** A screenshot of the landing and the draft states against `shots/01-1.png` and `01-2.png`. Then the
   three 30-second "Ask Claude" Service checks in Slack, done by the user.

## S4 · People tab (B, round 2)

1. **`bridge/comms.py`.** It merges:
   - Rivendell clients and contacts;
   - next meetings (calendar and briefs);
   - Circleback meetings and action items, open, in both directions by assignee;
   - local files.
   The list comes back in order: anyone you owe a follow-up or meet in the next 7 days first (soonest meeting,
   then the oldest follow-up you owe), each once; then by client, Personal, You. The endpoint tests cover it.
   Endpoints: `GET /local/comms/people`, plus `/local/comms/person/<id>`. First prove that the bridge's
   Rivendell token can read those routes; if it can't, add a read scope in Rivendell.
2. **The dashboard.** A PEOPLE right-rail tab:
   - rows with one badge each;
   - an open-person card;
   - Draft follow-up, which prefills a Communication session with the open items as a Rivendell-sourced block;
   - Study as a quiet link.
3. **Check.** Screenshots against `shots/07-1.png` and `07-2.png`. The endpoints get tests with a fake Rivendell.

## S5 · Study sheet and learning lines

1. **The proposal.** A study turn in the home returns its findings as a structured proposal (groups, lines, target file)
   and writes nothing.
2. **Save.** `POST /local/comms/save` appends the chosen lines to the named files. It is validated: only
   `people/`, `clients/` and `you.md`, never outside.
3. **The study sheet.** Teaches, a drop zone or paste, and Keep ticks. Then the review with switches, matching
   `shots/04-1.png` and `04-2.png`.
4. **Pending learn lines.** A lasting correction becomes a pending line in the person (People tab) with
   Person · Client · You and Keep/Drop.
5. **Check.** Tests for save validation. Screenshots.

## Later, not planned

The Slack internal app (Socket Mode, the thread, post as the user after an approve). Windows and Linux capture.
