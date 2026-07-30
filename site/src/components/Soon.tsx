/**
 * "Coming soon" marker for capabilities the copy describes but the build doesn't
 * ship yet. Amber rather than accent so it reads as a caveat, not a highlight.
 * Delete the badge (and the `soon` flag on the entry) once the feature lands.
 */
export function Soon({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded border border-[color-mix(in_srgb,var(--warn)_30%,transparent)] bg-[color-mix(in_srgb,var(--warn)_8%,transparent)] px-1.5 py-0.5 font-mono text-[0.55rem] tracking-[0.14em] whitespace-nowrap text-[var(--warn)] uppercase ${className}`}
    >
      Coming soon
    </span>
  );
}
