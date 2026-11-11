# Matt Pocock's skills (vendored)

Source: github.com/mattpocock/skills, v1.3.1, installed via claude-plugins-official.
Licence: MIT, see `LICENSE`.

This folder is a Claude Code plugin root, loaded with `claude --plugin-dir`. It holds the
27 skills listed in `.claude-plugin/plugin.json`, copied whole.

Eight edits differ from upstream. In four `SKILL.md` frontmatters the line
`disable-model-invocation: true` is deleted, so the model can call these four itself:

- `skills/engineering/grill-with-docs/SKILL.md`
- `skills/productivity/grill-me/SKILL.md`
- `skills/engineering/improve-codebase-architecture/SKILL.md`
- `skills/productivity/teach/SKILL.md`

And four local-files locations name the folder BUILD reads (bridge/tickets.py):

- `skills/engineering/to-tickets/SKILL.md`: tickets go to
  `.mystical/tickets/<feature-slug>/<NN>-<slug>.md` (upstream: `.scratch/<feature-slug>/issues/`).
- `skills/engineering/to-spec/SKILL.md`: step 3 names the spec's place on a local tracker,
  `.mystical/tickets/<feature-slug>/SPEC.md` (upstream names none).
- `skills/engineering/code-review/SKILL.md`: step 2 looks for the spec under
  `.mystical/tickets/` (upstream: `.scratch/`).
- `skills/engineering/ask-matt/SKILL.md`: the `/implement` per ticket route names
  `.mystical/tickets/<feature-slug>/` (upstream: `.scratch/<feature>/issues/`).

Refresh: copy the 27 manifest-listed skill folders and `LICENSE` again from the new
upstream version, then redo the eight edits above.
