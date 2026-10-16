# Project marks: logos, icons, and colours from Rivendell

**Status:** built on `feat/project-marks` (2026-10-16). The design was approved from the `/design-first` draft in
`.mystical/design-drafts/project-logos/` (git-ignored). The approved option was "marks only": a project's colour
stays on its own marks, and the open project never takes over the theme's accent.

## What it is
A project's **mark** is what its tile shows, plus the colour the project wears.

| kind | shows | colour |
|---|---|---|
| letters (the default; nothing is stored) | two initials | hashed from the name, or picked |
| icon | any of lucide's 1,986 icons (`lucide-react/dynamic`, lazy, one chunk per icon) | picked |
| logo | an image, either dropped in, pasted, or chosen from a file, or the client's logo from Rivendell | read from the logo, or Rivendell's `brandColor` |

The mark shows wherever `ProjectTile` already did: session rows, PROJECTS heads, the chat nameplate, the
composer tab, and SETTINGS ▸ Projects rows. In the ANALYZE header it replaces the colour dot. One editor
(`MarkEditor`) opens from a Settings row's tile and from the ANALYZE tile.

## Rules
- **Plate.** A logo with see-through edges sits on a plate picked from its own pixels (`lib/logoinfo`). A
  dark logo gets a light plate on a dark ground. A light logo keeps the tinted plate, and paper reverses both.
  An opaque square logo fills the tile. The editor can force LIGHT or DARK. AURORA has no plates: there a
  logo becomes a phosphor silhouette in the project's colour (a CSS mask, luminance for a square logo).
- **Readable colour.** The tile keeps the brand colour. Names and branches print in the same hue, with OKLCH
  lightness clamped to `--ink-lo..--ink-hi`: 0.65–1 on dark grounds, 0–0.55 on paper. CSS does this with
  relative colour, `lib/ink.inkCss`, so a theme switch re-inks every name without a re-render.
- **Sources.** A mark either follows Rivendell (`source: "rivendell"`) or is yours (no source, and it never
  changes on its own). Any edit makes a mark yours. IMPORT never overwrites a mark you set. The editor's
  USE IT takes one project back to Rivendell's mark.
- **Matching.** Any of a local repo's remotes (`github.remote_slugs`) is compared against a Rivendell
  project's repositories, which include mirrors in both directions. The match only counts if the project's
  client has a logo or a colour. Internal projects have no client, so they get the icon case.
- **The offer** is a notice, shown once per browser for a given set of matches. It only appears while a
  Rivendell is connected, not already followed, and has matches still showing plain letters. It offers
  IMPORT & SYNC or NOT NOW. NOT NOW is stored on the bridge and holds until a repo it hasn't shown turns up.
  After an import, a second notice confirms it and offers UNDO, which restores what the import replaced and
  stops following. While following, `projectmarks.refresh()` runs at boot +90s and then every 6h. It is
  silent: it pulls changed logos and colours and takes new matches.
- **Settings ▸ Projects** has a strip at the top. Before importing it offers IMPORT & SYNC. Once following
  it shows SYNC NOW and a switch that stops following without touching any mark. Each row has a
  RIVENDELL or YOURS chip. A Rivendell without the route gets one dim line, never an error.

## Storage
- `project_config.json[rel].mark` holds `{kind, icon?, logo?, color?, plate?, source?, rv?}`, validated by
  `projectmarks.clean`. A colour is `#rrggbb` or `var(--token)`. An icon is `[a-z0-9-]`. A logo must be stored.
- `project_marks.json` holds `{logos: {"<sha256>.<ext>": base64}, rivendell: {sync, synced_at, dismissed, undo}}`.
  Logos are capped at 512 KB, and the dashboard shrinks rasters over 256px first. A logo that neither a mark
  nor UNDO references is garbage-collected on the next save. MOVE carries the file (`move._STATE_FILES`).
  Logos live in one JSON file rather than a folder because MOVE merges JSON state files by key.
- The old per-browser colours (`hud-project-tints`) move onto the bridge once, on the first listing that
  carries marks.

## Routes (dashboard)
- `GET /local/projects` gains a `marks` field.
- `POST /local/project/settings` takes `mark` and an optional `logo_data` (base64), saved in one request.
- `GET /local/project-mark/logo/<sha>.<ext>` serves a logo as immutable, with
  `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox` and `nosniff`.
- `GET /local/rivendell/marks[?force=1]` returns the offer, the follow state and per-repo matches.
- `POST /local/rivendell/marks` takes `{action: import | follow | dismiss | undo | sync, project?, on?}`.

These routes don't exist on the Mini App or the bot. The Mini App draws no project tiles.

## Rivendell side
The bridge's token couldn't read logos: MCP `list_projects` drops `logoUrl`, and REST `/projects` needs the
cookie. Rivendell gains `GET /plugin/projects`, read-only, behind the same guard as `/plugin/tasks`. It
returns `[{id, name, slug, internal, repositories[], client: {id, name, logoId, logoUrl, brandColor} | null}]`,
with repositories filtered by the token owner's read access. It is built uncommitted in
`~/Projects/.worktrees/rivendell/feat-plugin-projects`, for the team to review. Until it deploys, the bridge
side shows only the dim line in Settings.

## Not built (on purpose)
- The open project taking over the chat's accent (option B in the draft). The user picked marks only.
- Rivendell's project names. Names stay yours.
- Logo candidates found in a repo (`public/logo.svg`, favicons). This wasn't asked for.
