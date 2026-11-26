# Mystical's design pack (vendored)

This folder is a Claude Code plugin root, loaded with `claude --plugin-dir` while the
DESIGN PACK switch is on (bridge/paths.py, `design_pack`). Its skills load as
/mystical-design:<name>. It holds the skills listed in `.claude-plugin/plugin.json`, and
one shared reference, `references/judgement-pass.md`.

## Sources

Each outside skill is copied whole from its repo at the commit below (fetched 2026-11-27),
with its licence file beside it.

| Skills | Source | Version | Licence | File |
|---|---|---|---|---|
| design-first, design-implement, polish | Mystical (this repo) | in-repo | MIT | `LICENSE` |
| frontend-design | github.com/anthropics/skills, `skills/frontend-design` | e4bb5d9 (2026-11-16) | Apache-2.0 | `skills/frontend-design/LICENSE.txt` |
| web-design-guidelines | github.com/vercel-labs/agent-skills, `skills/web-design-guidelines` | 1.1.0, 5a37a63 (2026-11-20) | MIT, declared in the repo README (the repo has no licence file) | `skills/web-design-guidelines/LICENSE` |
| break-ui | github.com/emilkowalski/skills, `skills/break-ui` | 64eb3de (2026-11-15) | MIT | `skills/break-ui/LICENSE` |
| shadcn | github.com/shadcn-ui/ui, `skills/shadcn` | 0e5b2e6 (2026-11-25) | MIT | `skills/shadcn/LICENSE.md` |
| expo-native-ui | github.com/expo/skills, `plugins/expo/skills/expo-native-ui` | 6d0506a (2026-11-26) | MIT | `skills/expo-native-ui/LICENSE` |
| expo-design-system | github.com/expo/skills, `plugins/expo/skills/expo-design-system` | 6d0506a (2026-11-26) | MIT | `skills/expo-design-system/LICENSE` |
| expo-animation | github.com/expo/skills, `plugins/expo/skills/expo-animation` | 6d0506a (2026-11-26) | MIT (its own file, Emil Kowalski) | `skills/expo-animation/LICENSE` |
| create-design-md | github.com/ibelick/ui-skills, `skills/create-design-md` | 1a2f2bf (2026-11-25) | MIT | `skills/create-design-md/LICENSE` |

- `skills/design-first/SKILL.md`: copied from the personal copy in `~/.claude/skills/design-first`,
  the one that ran before this pack, unedited.
- `skills/design-implement/SKILL.md`: moved from `.claude/skills/design-implement`, unedited.
- web-design-guidelines 1.1.0 bundles its rules in `references/command.md` (pinned to
  vercel-labs/web-interface-guidelines 434b7f9, SHA-256 in its SKILL.md) and tells the
  model not to fetch them.
- The licence files for break-ui, shadcn, expo-native-ui, expo-design-system and
  create-design-md are their repo's root licence, copied into the skill folder. The
  web-design-guidelines `LICENSE` is the MIT text with Vercel's name, written here because
  upstream ships none.

## Credits

- The critic's rubric (critique_design, `bridge/design_audit.py`) is adapted from
  Impeccable's critique rubric, github.com/pbakaus/impeccable,
  `plugin/skills/impeccable/reference/critique-rubric.md`, by Paul Bakaus, Apache-2.0.
  Impeccable itself is not installed.
- The judgement pass (`references/judgement-pass.md`) takes its first two parts from this
  repo's accessibility-audit and empty-states skills (`.claude/skills/`).

## Upstream edits

Cross-references between pack skills are renamed to their /mystical-design: names
(`expo-native-ui` → `/mystical-design:expo-native-ui`, `expo-animation` →
`/mystical-design:expo-animation`):

- `skills/expo-native-ui/SKILL.md`: 4 mentions of expo-animation (description included).
- `skills/expo-design-system/SKILL.md`: 10 mentions of expo-native-ui (description included).
- `skills/expo-design-system/references/native-slop.md`: 1 of expo-native-ui, 2 of expo-animation.
- `skills/expo-design-system/references/audit.md`: 1 of expo-native-ui.

Names of skills outside the pack stay as upstream wrote them: expo-router and
expo-project-structure (Expo), `animate` (expo-animation's web pointer), emil-design-eng
and review-animations (break-ui). Nothing else is edited; shadcn keeps
`user-invocable: false`, so Claude Code loads it for the model but hides it from its own /
menu.

Refresh: copy each skill folder again from the new upstream commit, update the table, then
redo the renames above.
