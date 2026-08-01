/**
 * "Not yet" marker for capabilities the copy describes but the build doesn't
 * ship. Amber rather than accent so it reads as a caveat, not a highlight —
 * amber is the page's only second hue and it means caution both here and in the
 * security section. Delete the badge (and the entry's `soon` flag) once the
 * feature lands.
 */
export function Soon({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center border border-[color-mix(in_srgb,var(--warn)_32%,transparent)] px-1.5 py-0.5 font-mono text-[0.55rem] tracking-[0.16em] whitespace-nowrap text-[var(--warn)] uppercase ${className}`}
    >
      Not yet
    </span>
  );
}
