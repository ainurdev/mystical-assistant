# Project logos v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A logo per Rivendell project, which Mystical follows ahead of the client's; a LIGHT/DARK background
for logo marks; and a From Rivendell gallery on the mark editor's LOGO tab.

**Architecture:**
- **Rivendell** stores a project logo as one storage key on `Project`. It is uploaded on the project's page and
  served to bridges by `GET /plugin/projects` (`logoId`, `logoUrl`).
- **Mystical's bridge** (`bridge/projectmarks.py`) prefers that logo when it dresses a repo. It adds `plate` to
  a logo mark, and reads a client's image documents through Rivendell's MCP for the gallery.
- **The dashboard** editor gets two rows on its LOGO tab.

**Tech Stack:**
- Rivendell: NestJS, Prisma, jest; React and TanStack Query, vitest.
- Mystical: Python stdlib and pytest; React/TS (`tsc -b`, `vite build`).

**Spec:** `docs/superpowers/specs/project-logos-v2.md`

**Worktrees:**
- Rivendell: `~/Projects/.worktrees/rivendell/feat-project-logos` (branch `feat/project-logos`, from origin/main 8f91c088).
- Mystical: `~/Projects/.worktrees/mystical-assistant/feat-project-logos` (branch `feat/project-logos`).

## Global Constraints
- Rivendell project logos accept PNG, JPEG or WEBP only, up to 10 MB (`MAX_IMAGE_BYTES`); never SVG.
- Every new Rivendell route declares `@Access`. A new body field goes through a class-validator DTO (backend/AGENTS.md).
- The Rivendell migration folder is `backend/prisma/migrations/20261018010000_project_logo/migration.sql`, one `ADD COLUMN`.
- Mystical's bridge is stdlib only. A client or project logo is kept up to `RV_LOGO_MAX` (4 MB), and a dropped one up to 512 KB.
- The editor's `.mk-pane` stays at `min-height: 251px`: the LOGO tab's content must fit, so a tab switch never moves it.
- Commits carry no Co-Authored-By line (the user's rule). Nothing is pushed without the user's explicit OK.
- Rivendell CI must pass:
  - backend: `pnpm typecheck && pnpm lint:ci && pnpm test`
  - frontend: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`
- Mystical must pass: `~/.cache/mystical-test-venv/bin/python -m pytest tests/ -q` (only the 7 known Mac failures), plus
  `node_modules/.bin/tsc -b && node_modules/.bin/vite build` in `bridge/dashboard/web`. A worktree build needs
  node_modules symlinked from the main checkout, and the symlink is removed after.

## Review Focus
1. A project logo the bridge can't keep (over 4 MB, or a download that fails) must fall back to the client's
   logo, never to letters while the client has one. The test is in Task 4.
2. The gallery with no plugin, no running instance, Rivendell down, or a repo with no client project gives an
   empty strip and no error, and the editor is otherwise unchanged. The test is in Task 6.
3. The gallery image proxy must stream only an image document of that repo's own client. Another client's
   id, a made-up id or a PDF gets a 404/400, never bytes; it always sends the sandbox CSP and `nosniff`. The
   test is in Task 6.
4. A plate on a following mark must survive a refresh, a new client logo and UNDO's snapshot. The test is in
   Task 5.
5. Replacing a Rivendell project logo removes the old object only after the row is updated. A failed row update
   removes the new object and keeps the old logo. The test is in Task 1.

---

### Task 1: Rivendell — store and replace a project logo

**Files:**
- Modify: `backend/prisma/schema.prisma` (model Project: `logoKey String?` with a comment)
- Create: `backend/prisma/migrations/20261018010000_project_logo/migration.sql`
- Modify: `backend/src/projects/projects.service.ts` (`setLogo`, `clearLogo`)
- Modify: `backend/src/projects/projects.controller.ts` (two routes)
- Modify: `backend/src/api-tokens/upload-tickets.service.ts` (UPLOAD_ROUTES, plus its route text), `backend/src/mcp/mcp.service.ts` (the upload_file text), `docs/mcp.md`
- Test: `backend/src/projects/projects.service.spec.ts`, plus the access suite case near `test/access/projects.e2e-spec.ts:118`

**Interfaces:**
- Produces:
  - `PROJECT_LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp']` (in projects.service.ts).
  - `ProjectsService.setLogo(id: string, file: Express.Multer.File | undefined): Promise<Omit<ProjectDetailDto,'access'>>`
  - `ProjectsService.clearLogo(id: string): Promise<Omit<ProjectDetailDto,'access'>>`
  - Routes `POST /projects/:id/logo` (multipart `file`) and `DELETE /projects/:id/logo`, both answering
    `ProjectDetailDto` through `this.scoped(user, …)` the way `link()` does.
  - The key format is `projects/<projectId>/logo/<uuid>`.

- [ ] **Step 1: Write the failing tests** in projects.service.spec.ts. Use that file's fakes; add `put`/`remove`/`assertConfigured` jest.fns to its storage fake.
  - `setLogo stores a PNG under projects/<id>/logo/<uuid> and saves the key`: `storage.put` is called with a key
    matching `/^projects\/<id>\/logo\/[0-9a-f-]{36}$/` and `'image/png'`, and `prisma.project.update` gets
    `{ logoKey: thatKey }`.
  - `setLogo removes the previous object after the row is updated`: with an existing `logoKey: 'projects/p/logo/old'`,
    `storage.remove('projects/p/logo/old')` is called after `update`.
  - `setLogo refuses SVG, GIF and a missing file`: `BadRequestException`, and `storage.put` is never called.
    A file whose `mimetype` claims PNG but whose bytes aren't PNG is refused too (sniff the bytes).
  - `setLogo removes the new object when the row update fails`: `update` rejects, `storage.remove(newKey)` is
    called, the error propagates, and the old key isn't removed.
  - `clearLogo sets logoKey null and removes the object`.
- [ ] **Step 2: Run** `cd backend && pnpm test -- projects.service`. Expected: the new cases FAIL.
- [ ] **Step 3: Add the column and its migration**:
  `ALTER TABLE "projects" ADD COLUMN "logoKey" TEXT;` (check `@@map` for the real table name).
  Then run `pnpm prisma generate`.
- [ ] **Step 4: Implement `setLogo` / `clearLogo`.**
  - Order: `storage.assertConfigured()`, `getOrThrow(id)`, then
    `sniffImageType(file.buffer)` ∈ `PROJECT_LOGO_TYPES`, else 400 "Upload a PNG, JPEG or WebP image.".
  - Then put, update, remove the old object on a best-effort basis, and return `getDetail(id)`.
- [ ] **Step 5: Add the routes.**
  - Each carries `@Access({ section: 'details', action: 'write', owner: { type: 'project', from: 'param:id' } })`.
  - The POST adds `FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } })`, `@ApiConsumes('multipart/form-data')`
    and an `@ApiBody` with a binary `file`, following `task-management.controller.ts:227`.
  - Add `new RegExp(\`^/projects/${ID}/logo$\`, 'i')` to UPLOAD_ROUTES, and name the route in the three texts.
- [ ] **Step 6: Run** `pnpm test -- projects` and `pnpm typecheck && pnpm lint:ci`. Expected: PASS, including `route-coverage.spec.ts`.
- [ ] **Step 7: Commit** in the Rivendell worktree: "projects: a logo of their own …".

### Task 2: Rivendell — serve the project logo (detail page and plugin)

**Files:**
- Modify: `backend/src/projects/dto/project.dto.ts` (ProjectDetailDto `logoUrl`)
- Modify: `backend/src/projects/dto/plugin-project.dto.ts` (PluginProjectDto `logoId`, `logoUrl`)
- Modify: `backend/src/projects/projects.service.ts` (`getDetail` return, `listForPlugin` select and map)
- Test: `backend/src/projects/projects.service.spec.ts`, `backend/src/projects/plugin-projects.controller.spec.ts`

**Interfaces:**
- Consumes: `Project.logoKey` (Task 1).
- Produces:
  - `ProjectDetailDto.logoUrl: string | null`.
  - `PluginProjectDto.logoId: string | null` (the key's last segment, the uuid) and `PluginProjectDto.logoUrl: string | null`.
  - Both are signed with `logoUrl(this.storage, logoKey ? { storageKey: logoKey, name: slug } : null)` from `clients/client-brand.ts`.

- [ ] **Step 1: Write the failing tests.**
  - `getDetail signs the project logo`: a project with `logoKey: 'projects/p/logo/u1'` gives a `logoUrl` from the storage fake's `signedUrl`.
  - `listForPlugin gives each project its own logoId and logoUrl, null without one`: the logo project gets
    `logoId: 'u1'`, and the other gets `null`/`null`, while `client` is unchanged.
  - Update plugin-projects.controller.spec.ts's exact `toEqual`s with `logoId`/`logoUrl`.
- [ ] **Step 2: Run** `pnpm test -- projects`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Add the two DTO fields with `@ApiProperty({ nullable: true, type: String, description })`.
  - `getDetail` spreads `logoUrl` into its return.
  - `listForPlugin` adds `logoKey: true` to the select at :131 and maps the fields.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck && pnpm lint:ci`. Expected: PASS.
- [ ] **Step 5: Commit**: "plugin projects: a project's own logo …".

### Task 3: Rivendell web — upload on the project page

**Files:**
- Modify: `frontend/src/features/projects/types.ts` (`ProjectDetail.logoUrl: string | null`)
- Modify: `frontend/src/features/projects/queries.ts` (`useSetProjectLogo(id)`, `useClearProjectLogo(id)`)
- Modify: `frontend/src/features/projects/components/project-details-form.tsx` (a Logo row: Upload/Replace, Remove)
- Modify: `frontend/src/routes/_app/projects/$projectId/index.tsx` (the header shows the logo)
- Test: `frontend/src/features/projects/components/project-details-form.test.tsx`

**Interfaces:**
- Consumes: `POST`/`DELETE /projects/:id/logo` (Task 1), `ProjectDetail.logoUrl` (Task 2).
- Produces:
  - `useSetProjectLogo(id: string)`: a mutation of `File`. It calls `api.upload<ProjectDetail>('/projects/${id}/logo', form)`
    and invalidates `projectDetailQueryOptions(id).queryKey` and `projectsQueryOptions.queryKey`.
  - `useClearProjectLogo(id)`: the same, with `api.delete`.

- [ ] **Step 1: Write the failing test**: picking a file in the form's logo input calls `api.upload` with
  `/projects/<id>/logo` and a FormData whose `file` is that file. Add `upload` to the file's `@/lib/api` mock.
- [ ] **Step 2: Run** `cd frontend && pnpm test -- project-details-form`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The form gets a "Logo" row: the current logo, using `ClientMark` with
    `{ id, name, logoUrl, brandColor: null }` at size `lg`, or "None".
  - A hidden `<input type="file" accept="image/png,image/jpeg,image/webp">` behind an Upload/Replace button.
  - A Remove button while a logo is set. Uploads save at once (spec call 8).
  - The header shows `ClientMark` at `md` before the name when `logoUrl` is set; otherwise today's tone dot stays.
- [ ] **Step 4: Run** `pnpm build && pnpm typecheck && pnpm lint && pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit**: "projects: upload a project's logo on its page …".

### Task 4: Mystical — follow a project's own logo

**Files:**
- Modify: `bridge/projectmarks.py` (`_lent`, `match`, `_fetch_logos`, `_follow`, `state`)
- Test: `tests/test_projectmarks.py`

**Interfaces:**
- Consumes: `/plugin/projects` rows with top-level `logoId`/`logoUrl` (Task 2). They're absent on an older Rivendell, so treat them as None.
- Produces:
  - `_lent(p: dict) -> list[tuple[str | None, str | None]]`: the (logo_id, url) candidates in order, the project's
    own first, then the client's.
  - `rv` on a followed mark gains `own: True` when the project's own logo is worn, with `rv.name` = the project's name.
  - `state()["matches"][rel]` gains `own: bool`.

- [ ] **Step 1: Write the failing tests.**
  - `test_a_projects_own_logo_beats_its_clients`: a client logo plus a project logo, where `logoId: "u1"` and the
    project logo is what's stored. `rv == {"instance","client","name": <project name>,"logo_id":"u1","own": True}`,
    and `color` is the client's brandColor.
  - `test_an_internal_project_with_its_own_logo_matches`: `client: None`, a project `logoUrl`. It matches, wears a
    logo, has no color, and appears in `state()["projects"]` (LINK's list).
  - `test_a_project_logo_that_cant_be_kept_falls_back_to_the_clients`: the project logo's download returns None,
    so the mark wears the client's logo, with `own` absent.
- [ ] **Step 2: Run** `~/.cache/mystical-test-venv/bin/python -m pytest tests/test_projectmarks.py -q`. Expected: the 3 new tests FAIL.
- [ ] **Step 3: Implement.**
  - `match`'s lend check also accepts `p.get("logoUrl")`.
  - `_fetch_logos` downloads candidates in `_lent` order until one is fetched or known.
  - `_follow` wears the first candidate it holds.
  - `state` builds `matches`, `offer.logos` and `projects` from `_lent`.
  - Update the module docstring.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit**: "projectmarks: a Rivendell project's own logo …".

### Task 5: Mystical — a background for a logo

**Files:**
- Modify: `bridge/projectmarks.py` (`clean`, `set_mark`, `_follow`)
- Modify: `bridge/dashboard/web/src/api.ts` (`ProjectMark.plate?: "light" | "dark"`)
- Modify: `bridge/dashboard/web/src/components/hud/MarkEditor.tsx` (BACKGROUND row, `next`, preview `data-plate`, footer note)
- Modify: `bridge/dashboard/web/src/components/ui/ProjectTile.tsx` (`data-plate`)
- Modify: `bridge/dashboard/web/src/index.css` (plate rules)
- Test: `tests/test_projectmarks.py`

**Interfaces:**
- Produces: a logo mark's optional `plate: "light" | "dark"`. Absent means NONE.

- [ ] **Step 1: Write the failing tests.**
  - `test_a_plate_rides_only_on_a_logo`: `clean({"kind":"logo","logo":L,"plate":"light"})` keeps it.
    `plate:"pink"` raises, and so does a plate on an icon mark.
  - `test_a_plate_alone_keeps_a_mark_following`: on a followed mark, `set_mark(rel, {**mark_minus_source_rv, "plate": "dark"})`
    leaves `source == "rivendell"` and `rv` as it was, with `plate == "dark"`. A colour change in the same call
    makes it yours.
  - `test_refresh_keeps_the_plate`: a followed mark with `plate` stays plated after `refresh()` brings a new
    client logo.
- [ ] **Step 2: Run** the test file. Expected: FAIL.
- [ ] **Step 3: Implement the bridge.**
  - `clean` accepts `plate` ∈ ("light","dark") on kind logo.
  - `set_mark`: when the stored mark follows Rivendell, and the cleaned mark minus `plate` equals the stored one
    minus `plate`/`source`/`rv`, it stores the stored mark with the new plate (or none) and keeps following.
  - `_follow` copies `plate` from the current mark.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Build the dashboard side.**
  - The BACKGROUND row is `.mk-lbl` plus `.mk-mini`, with NONE / LIGHT / DARK, inside the LOGO pane under the
    drop zone.
  - `next` carries `plate` on logo marks.
  - The preview and `ProjectTile` set `data-plate`.
  - The footer's "a change here stops it following" hides when the only change is the plate.
  - CSS, after the no-background rule:
    - `.ptile[data-kind="logo"][data-plate="light"]{background:#eef0f6 !important}`
    - `[data-plate="dark"]{background:#1c1c22 !important}`
    - `.ptile[data-kind="logo"][data-plate] img{width:80%;height:80%}`
- [ ] **Step 6: Verify**: `tsc -b && vite build` pass. On the scratch kit (`.mystical/probe-mac/marks/scratch-link.sh`,
  repointed at this worktree), IB Groups set to LIGHT reads on FLINT dark and on AURORA, and LETTERS ⇄ ICON ⇄ LOGO
  still don't move the editor (k6-above.js).
- [ ] **Step 7: Commit**: "project marks: a LIGHT or DARK background behind a logo …".

### Task 6: Mystical — From Rivendell (the gallery)

**Files:**
- Modify: `bridge/rivendell.py` (`client_images`, `client_image_url`)
- Modify: `bridge/projectmarks.py` (`_look` keeps `named_by`, `gallery`, `gallery_image`)
- Modify: `bridge/dashboard/server.py` (`GET /local/rivendell/gallery`, `GET /local/rivendell/gallery/image`)
- Modify: `bridge/dashboard/web/src/api.ts` (`rivendellGallery(project)`, `rivendellGalleryImageUrl(project, id)`)
- Modify: `bridge/dashboard/web/src/components/hud/MarkEditor.tsx`, `bridge/dashboard/web/src/index.css` (`.mk-gal`)
- Test: `tests/test_rivendell.py`, `tests/test_projectmarks.py`, `tests/test_projectmarks_endpoint.py`

**Interfaces:**
- Produces:
  - `rivendell.client_images(instance_id, client_id) -> list[dict]`: `read_route /clients/<id>/documents`,
    keeping documents whose `mimeType` ∈ png/jpeg/webp/svg+xml, as `{id, name, url: previewUrl}`.
  - `rivendell.client_image_url(instance_id, client_id, document_id) -> str`: `read_route .../documents/<doc>/download`, `["url"]`.
  - `projectmarks.gallery(rel) -> {"client": str | None, "images": list}`, which is empty on any failure.
  - `projectmarks.gallery_image(rel, document_id) -> tuple[bytes, str] | None`: only an id from that client's
    `client_images`, downloaded with `_download` and typed with `sniff`/`CTYPES`.

- [ ] **Step 1: Write the failing tests.**
  - test_rivendell: `client_images` filters a PDF out and maps previewUrl. `client_image_url` gives the call
    shape `("read_route", "GET", "/clients/c1/documents/d1/download", None)`.
  - test_projectmarks:
    - `gallery` uses the client of the project that names the repo, even an unmatched one.
    - It returns `{"client": None, "images": []}` with no plugin, Rivendell down (`rivendell.projects` raising
      or answering errors), or no client project.
    - `gallery_image` refuses an id not in the list, returning None without downloading.
  - test_projectmarks_endpoint: `/local/rivendell/gallery` relays. `/gallery/image` sends the bytes with the
    image type, the sandbox CSP and `nosniff`; it 404s for None and 400s for an invalid project.
- [ ] **Step 2: Run** the three files. Expected: FAIL.
- [ ] **Step 3: Implement the bridge.**
  - `_look` stores `named_by: {rel: first project naming it}` beside `matches`.
  - The image route reuses the headers `/local/project-mark/logo/` sends.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Build the editor side.**
  - On mount, `api.rivendellGallery(project)` runs, and errors read as empty.
  - The LOGO pane shows "FROM RIVENDELL" with `<client> · N images` and 44px thumbnails on a checkerboard. It
    hides with none.
  - A click fetches `rivendellGalleryImageUrl` as a blob, makes a `File` of its type, and calls `take(file)`.
- [ ] **Step 6: Verify**: `tsc -b && vite build`. On the scratch kit (fake documents served on 8897), the NR repo
  shows its images, a click puts that image in the drop zone, SAVE stores it, and the pane is still 251px.
- [ ] **Step 7: Commit**: "project marks: From Rivendell …".

### Task 7: Ship (each step waits on the user where marked)
- [ ] Rivendell full CI commands green. **Ask** before pushing; on OK, push `feat/project-logos` as the user
  directs (main or a PR). Then watch Railway, which may hold at NEEDS_APPROVAL.
- [ ] Once deployed, upload the logos with MCP `upload_file`: Mystical's `bridge/dashboard/web/public/icon-512.png`
  to the Mystical Assistant project, and Rivendell's `frontend/public/icon-512.png` to the Rivendell project.
  Run the curl it prints.
- [ ] Mystical: merge master in, run the full suite and both builds, then ff master. **Ask** before the restart;
  on OK, `mystical build` + `mystical restart`, then SYNC NOW.
- [ ] Live checks: mystical-assistant and rivendell wear their logos, IB Groups LIGHT reads on dark, and the
  gallery lists NR's 4 images. Screenshots go to the user via `mcp__verify__Attach`.
