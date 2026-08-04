import { EXT_ICON, ICON_BODY, ICON_VIEWBOX, NAME_ICON } from "./fileicons.gen";

/* The file icon for the editor tree, the tab strip and the FILES panel: the
   VS Code icon for that format, so a .tsx reads as React and a .py as Python
   at a glance. Bodies are inlined by fileicons.build.mjs — add a format there.

   ponytail: a body with a gradient carries its `id`, so forty .py rows put the
   same id in the DOM forty times. Invalid, but every copy defines the identical
   gradient, so `url(#…)` resolves the same either way. A <symbol> sprite mounted
   once at the root is the fix if that ever actually bites. */

export function FileIcon({ name, size = 14 }: { name: string; size?: number }) {
  const lower = name.toLowerCase();
  // Basenames only, so a full path (the CHANGES list shows those) still matches.
  const base = lower.split("/").pop() ?? lower;
  // For an extensionless name the last dot-segment is the whole name, which is
  // how Dockerfile and Makefile find their icons.
  const icon = NAME_ICON[base] ?? EXT_ICON[base.split(".").pop() ?? ""] ?? "default-file";
  return (
    <svg
      viewBox={ICON_VIEWBOX[icon] ?? "0 0 32 32"} width={size} height={size}
      style={{ flex: "none" }} aria-hidden
      dangerouslySetInnerHTML={{ __html: ICON_BODY[icon] }}
    />
  );
}
