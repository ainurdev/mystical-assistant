import { EXT_ICON, ICON_BODY, NAME_ICON } from "./fileicons.gen";

/* The file icon for the editor tree, the tab strip and the FILES panel: a
   lucide outline for that kind of file, in the same 24-grid currentColor stroke
   the rest of the HUD's glyphs use. Bodies are inlined by fileicons.build.mjs —
   add a format there. */

export function FileIcon({ name, size = 16 }: { name: string; size?: number }) {
  const lower = name.toLowerCase();
  // Basenames only, so a full path (the CHANGES list shows those) still matches.
  const base = lower.split("/").pop() ?? lower;
  // Last dot-segment first — for an extensionless name that's the whole name,
  // which is how Dockerfile and Makefile find their icons. Falling back to the
  // first segment catches the suffixed ones: .env.local is still a .env.
  const seg = base.split(".").filter(Boolean);
  const icon = NAME_ICON[base] ?? EXT_ICON[seg.at(-1) ?? ""] ?? EXT_ICON[seg[0] ?? ""] ?? "file";
  return (
    <svg
      viewBox="0 0 24 24" width={size} height={size}
      // The rows set their own text colour; the icon stays a step behind it so
      // a tree of them reads as texture, not as a column of bullets.
      style={{ flex: "none", color: "var(--txd)" }} aria-hidden
      dangerouslySetInnerHTML={{ __html: ICON_BODY[icon] }}
    />
  );
}
