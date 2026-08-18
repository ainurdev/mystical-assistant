// Copy of the dashboard's src/lib/stick.ts — same two-app duplication as the
// RunStream/Composer pair. Checked there: dashboard/web/src/lib/stick.check.ts.
// Only stickToBottom is copied: this app follows new content from a turn/event
// effect, not a ResizeObserver, so there's no stickOnResize path to mirror.
//
// Direction decides, with hysteresis: any upward move unsticks, a downward move
// inside the 80px band re-arms, no movement keeps the last answer. The old form
// (`scrollTop < prev - 1`, else `dist < 80`) flickered on a slow scroll: touch
// momentum moves under 1px per event, so "up" was never detected and the band
// re-stuck between events — which on this app also overwrote the session's
// remembered place with "bottom".
export function stickToBottom(
  el: { scrollTop: number; scrollHeight: number; clientHeight: number },
  prev: number,
  stuck: boolean,
): boolean {
  const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
  if (dist <= 1) return true;
  if (el.scrollTop < prev) return false;
  if (el.scrollTop > prev && dist < 80) return true;
  return stuck;
}
