// Copy of the dashboard's src/lib/stick.ts — same two-app duplication as the
// RunStream/Composer pair. Checked there: dashboard/web/src/lib/stick.check.ts.
export function stickToBottom(
  el: { scrollTop: number; scrollHeight: number; clientHeight: number },
  prev: number,
): boolean {
  const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
  if (dist <= 1) return true;
  if (el.scrollTop < prev - 1) return false;
  return dist < 80;
}
