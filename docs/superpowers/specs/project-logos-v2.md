# Project logos v2: per-project logos in Rivendell, a background, and Rivendell's gallery

**Status:** design, 2026-10-18. It builds on `project-marks.md` (marks, the Rivendell follow, LINK).

## Why
The user's words (2026-10-18) were: "for ib groups logo is not clear in dark mode, can add option to choose from
rivendell gallery if token is there and rivendell is installed as plugin, also be available to add background,
mystical assistant and rivendell and other can have their logos as well, add rivendell project to ainur projects,
add its logos in there and use it". Three gaps follow from it:
- IB Groups' logo is a black wordmark with brand colour `#000000`, so it vanishes on dark themes. Its client
  documents in Rivendell hold no light version.
- A client's documents in Rivendell often hold better marks than the one starred as its logo: NR has an
  orange lion, a black lion, the full logo and an app icon, and Elvou has a white wordmark. Mystical can't
  offer them yet.
- Internal projects ("Ainur HQ": Mystical Assistant, Rivendell, Gandalf) have no client. Rivendell stores logos
  only per client, so these projects never get one. The user chose to store their own logos **in Rivendell**
  (not in Mystical), so every Mystical on that Rivendell gets them.

## Goals
1. **Rivendell**: any project, internal ones included, can carry its own logo. It is uploaded on the project's
   page and served to bridges by `GET /plugin/projects`.
2. **Mystical follows a project's own logo.** It wins over the client's, so internal projects now match too.
3. **Background**: a logo mark can have a background, NONE (the default), LIGHT or DARK. Picking one on a repo
   that follows Rivendell keeps it following.
4. **From Rivendell (the gallery)**: the editor's LOGO tab lists the images in the client's documents and
   picks one like a dropped file. This needs the Rivendell plugin installed with a connected instance.
5. **Data**: upload Mystical Assistant's and Rivendell's logos to their Rivendell projects. Both repos are
   already linked to those projects, so both tiles then wear them in Mystical.

## Non-goals
- Rivendell's other screens (directory, inbox, repo list, board, triage) keep drawing the Ainur HQ "A" for
  internal projects. Only the project page shows the new logo. Their DTOs don't carry it, and the user didn't ask.
- No logo history and no several logos per project.
- No brand colour per project. A project logo with no client colour leaves the tile on its hashed tint.
- SVG uploads for project logos: Rivendell's image policy (`IMAGE_MIME_TYPES`) refuses SVG because it can
  carry script. Project logos follow that policy, so we upload the PNG app icons.

## Anti-goals
- A teammate's Mystical must never need anything installed beyond the Rivendell plugin it already has.
- Nothing that's only a display choice (the background) may stop a repo following Rivendell.

## Rivendell (ainurhq/rivendell)
Builder's map: the client logo pipeline is `clients/client-brand.ts` (`logoUrl` signs with a 2 h expiry from
the hour's start), `core/storage/storage.service.ts` (`put`, `remove`, `signedUrl`), and
`task-management/task-images.service.ts` (the upload pattern: sniff the type, put, write the row, remove
the object on failure).

- **Schema**: `Project.logoKey String?`, holding `projects/<projectId>/logo/<uuid>`. A fresh uuid per upload
  doubles as the change token. The migration is one `ADD COLUMN`
  (`backend/prisma/migrations/<YYYYMMDDHHMMSS>_project_logo/`). We rejected making `Document.clientId`
  nullable: documents, categories and their ACLs are client-owned throughout.
- **Routes**: `POST /projects/:id/logo` (multipart `file`) and `DELETE /projects/:id/logo`. Both carry the gate
  `PATCH /projects/:id` uses:
  `@Access({section:'details', action:'write', owner:{type:'project', from:'param:id'}})`.
  - Accept only PNG, JPEG and WEBP, sniffed from the bytes, up to 10 MB (`IMAGE_MIME_TYPES`, `MAX_IMAGE_BYTES`).
  - Put the new object, update the row, then remove the old object on a best-effort basis.
  - Storage must be configured, or the route answers 503.
  - Add the upload route's regex to `UPLOAD_ROUTES` (`api-tokens/upload-tickets.service.ts`), so MCP's
    `upload_file` can mint a ticket for it. Update the texts that list those routes (the same file,
    `mcp/mcp.service.ts`, `docs/mcp.md`).
- **Read side**:
  - `ProjectSummaryDto` and `ProjectDetailDto` gain `logoUrl: string | null`, signed with the existing
    `logoUrl(storage, {storageKey: logoKey, name: slug})`.
  - `PluginProjectDto` gains top-level `logoId` (the uuid in the key, or null) and `logoUrl`, while `client`
    stays as it is.
  - `listForPlugin` selects `logoKey` with the query it already makes.
- **Web**:
  - The project page header (`routes/_app/projects/$projectId/index.tsx`) shows the logo before the name. It
    uses `ClientMark`'s look, falling back to today's tone dot.
  - The details form behind "Edit details" (`features/projects/components/project-details-form.tsx`) gets
    Upload, Replace and Remove for the logo, shown to whoever may edit details.
  - Types are hand-written (`features/projects/types.ts`).
- **Tests**:
  - jest specs for the service (an upload replaces and removes the old object, a non-image or SVG is refused,
    delete clears it).
  - `listForPlugin` returns the new fields. Update `plugin-projects.controller.spec.ts`'s exact `toEqual`s.
  - Route coverage stays green.
  - A vitest case for the form's upload. CI's commands must pass: backend `pnpm typecheck && pnpm lint:ci && pnpm test`,
    frontend `pnpm build && pnpm typecheck && pnpm lint && pnpm test`.
- **Shipping**: Rivendell is shared with Mahdi and Erfan, and a push to `main` deploys through Railway, which can
  hold a direct push at NEEDS_APPROVAL. The branch is committed locally. Pushing (to main, or as a PR) waits for
  the user's explicit OK.

## Mystical (this repo)
- **Following** (`bridge/projectmarks.py`):
  - A project lends a mark when it has its own logo, or its client has a logo or a colour.
  - The logo a match wears is the project's own (`logoId`/`logoUrl`) if there is one, else the client's. The
    colour is still the client's `brandColor`.
  - `rv` gains `own: true` when the logo is the project's, and `rv.name` is then the project's name. The
    editor's follow line says "Follows Rivendell · Rivendell's logo" for those, and "client X" for the rest.
  - Downloads are keyed by logo id exactly as now, and project logo ids never collide with document ids.
  - LINK's project list (`state().projects`) includes projects that lend only their own logo, internal ones too.
- **Background**:
  - A logo mark may carry `plate: "light" | "dark"`. `clean` accepts it only on a logo; NONE means no field.
  - `set_mark` keeps a following mark following when the only change is `plate`, and `_follow` carries `plate`
    over on every refresh.
  - The editor's LOGO tab gets a BACKGROUND row (NONE / LIGHT / DARK, `.mk-mini`). The footer's "a change here
    stops it following" only shows for a change that does.
  - `ProjectTile` sets `data-plate`. CSS: a light plate is `#eef0f6` and a dark one `#1c1c22` (the colours
    removed in e9e5273), the logo sits at 80% on it, and the tile's radius applies. AURORA keeps its phosphor
    silhouette over the plate.
- **From Rivendell (the gallery)**:
  - `GET /local/rivendell/gallery?project=<rel>` returns `{client, images:[{id, name, url}]}`. The bridge finds
    the Rivendell project that names the repo, then that project's client. It reads
    `/clients/<id>/documents` through the MCP's `read_route` and keeps image mime types only. `url` is the
    document's `previewUrl` (signed).
  - The answer is empty without the plugin, without a connected instance, or for a repo with no client project.
  - `GET /local/rivendell/gallery/image?project=<rel>&document=<id>` streams the image through the bridge
    (`/clients/<id>/documents/<doc>/download` gives a 5-minute URL, then `_download`). It sends the logo
    route's sandbox CSP and `nosniff`, so the editor can fetch it same-origin.
  - In the editor, a thumbnail click fetches that and hands the file to the drop path (`take()`). Rasters shrink
    to 256px and the 512 KB cap applies. A pick is therefore your mark, like a drop, and SAVE commits it with
    the background and colour.
  - The strip sits under the drop zone inside `.mk-pane`. Thumbnails are 44px on a checkerboard, so black and
    white logos both show. With no images it hides.
  - The LOGO pane must stay within the pane's 251px, so tab switches still never move the editor.
- **Data**: once Rivendell is deployed, the bridge's token uploads `bridge/dashboard/web/public/icon-512.png`
  to the Mystical Assistant project and Rivendell's `frontend/public/icon-512.png` to the Rivendell project.
  It goes through MCP `upload_file`, which prints a curl with a one-time ticket. Then SYNC NOW runs.
- **Tests**:
  - `tests/test_projectmarks.py`:
    - A project's own logo wins and internal projects match.
    - `plate` passes `clean`, survives `_follow`, and a plate-only edit keeps following.
    - The gallery picks the naming project's client and filters images.
  - `tests/test_rivendell.py`: the documents read and the download URL call shape.
  - `tests/test_projectmarks_endpoint.py`: both gallery routes, a non-image refused, and the CSP header.
- **Not on the Mini App or the bot**: they draw no project tiles.

## Calls I made (check these)
1. **Precedence**: a project's own logo beats its client's on every repo of that project.
2. **No SVG** for project logos, following Rivendell's existing image policy. The app icons go up as PNG.
3. **A gallery pick is your mark** (it stops following), the same as a drop. Only the background keeps a mark
   following.
4. **Gallery source** is the client's documents list, not `/public-sites/project-assets`, which drops SVGs and
   would hide NR's lions.
5. **Rivendell UI scope** is the project page only. The other lists keep the Ainur "A".
6. **Size caps**: Rivendell takes a project logo up to 10 MB, but the bridge keeps one up to 4 MB
   (`RV_LOGO_MAX`). A project logo the bridge can't take falls back to the client's logo.
7. **Gallery types** are PNG, JPEG, WEBP and SVG, which is what the editor's drop path accepts.
8. **A Rivendell upload saves at once**, as the client documents do. It doesn't wait for the details form's Save.

"add rivendell project to ainur projects": the Rivendell and Mystical Assistant projects are already internal
(Ainur HQ) in Rivendell (`/plugin/projects`: `internal: true`), and `ainurhq/rivendell` and
`ainurdev/mystical-assistant` are already linked to them. So no data change is needed there beyond the uploads.

To check during the build: AURORA lifts a logo's silhouette to a readable ink, so on a LIGHT plate a dark logo could
come out pale grey on near-white. If it does, AURORA draws the plate's silhouette in the logo's own colour.
