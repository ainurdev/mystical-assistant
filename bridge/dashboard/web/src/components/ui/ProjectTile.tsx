import { projectInitials, projectTint } from "../../lib/surfaces";

/** A project's monogram tile: its initials on a square of its own tint. Every
 *  surface that names a project renders one, but only themes that draw it show
 *  it (`.ptile` is display:none until a theme says otherwise — FLINT, in
 *  index.css), so the HUD themes keep the bare coloured name they were built on.
 *  The tint rides in as --pc, so the stylesheet owns every other property. */
export function ProjectTile({ project }: { project: string | null | undefined }) {
  return (
    <b className="ptile" aria-hidden style={{ ["--pc" as string]: projectTint(project).color }}>
      {projectInitials(project)}
    </b>
  );
}
