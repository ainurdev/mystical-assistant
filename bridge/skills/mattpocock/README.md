# Matt Pocock's skills (vendored)

Source: github.com/mattpocock/skills, v1.3.1, installed via claude-plugins-official.
Licence: MIT, see `LICENSE`.

This folder is a Claude Code plugin root, loaded with `claude --plugin-dir`. It holds the
27 skills listed in `.claude-plugin/plugin.json`, copied whole.

Four edits differ from upstream. In each `SKILL.md` frontmatter the line
`disable-model-invocation: true` is deleted, so the model can call these four itself:

- `skills/engineering/grill-with-docs/SKILL.md`
- `skills/productivity/grill-me/SKILL.md`
- `skills/engineering/improve-codebase-architecture/SKILL.md`
- `skills/productivity/teach/SKILL.md`

Refresh: copy the 27 manifest-listed skill folders and `LICENSE` again from the new
upstream version, then redo the four edits above.
