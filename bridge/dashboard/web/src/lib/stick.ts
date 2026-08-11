// Should the transcript keep following new content?
//
// Scrolling up says no — even a small move, and even inside the near-bottom
// band. The old "am I within 80px of the bottom" test alone left stick on for
// the first flick up, so the next content resize snapped straight back down and
// a tall result at the end of a run was impossible to scroll away from.
// Sitting exactly at the bottom always says yes: a content shrink clamps us
// there with no gesture involved, and that shouldn't read as scrolling up.
// Close enough to the end that a prompt you just sent should pull the view down
// to it? Within one screen of the bottom counts as close — further up you're
// reading something, and a jump to the bottom would throw that place away.
export function nearBottom(
  el: { scrollTop: number; scrollHeight: number; clientHeight: number },
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= el.clientHeight;
}

export function stickToBottom(
  el: { scrollTop: number; scrollHeight: number; clientHeight: number },
  prev: number,
): boolean {
  const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
  if (dist <= 1) return true;
  if (el.scrollTop < prev - 1) return false;
  return dist < 80;
}

/** Should follow resume when the *content* resized rather than the user moving?
 *
 * Only landing exactly on the end counts — a shrink can clamp us there with no
 * gesture involved. The near-bottom band must not re-arm follow here, because
 * stickToBottom's "did you scroll up" guard compares against the last scroll
 * position, and a resize tick happens with no scroll in between: the guard is
 * inert and the band alone would answer yes. That's what made a small nudge up
 * mid-turn snap back to the bottom on the next streamed chunk.
 */
export function stickOnResize(
  el: { scrollTop: number; scrollHeight: number; clientHeight: number },
  stuck: boolean,
): boolean {
  return stuck || el.scrollHeight - el.scrollTop - el.clientHeight <= 1;
}
