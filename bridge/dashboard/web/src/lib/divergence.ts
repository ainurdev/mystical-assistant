/** The Branches bars: how far a branch drifted from its base, as two widths from a centre rule
 *  (behind left, ahead right). One rising log curve for both halves, so more drift is never a shorter
 *  bar; 36px is the most a half gives, which leaves room for a "99+" label inside the 59px half-box.
 *  A landed branch has nothing to show: it says "merged". */
const label = (n: number) => (n <= 0 ? "" : n > 99 ? "99+" : String(n));
const px = (n: number) => (n > 0 ? Math.min(36, 18 * Math.log10(1 + n)) : 0);

export function divergence(r: { ahead: number; behind: number; landed: boolean }) {
  if (r.landed) return { left: 0, right: 0, behind: "", ahead: "", merged: true };
  return { left: px(r.behind), right: px(r.ahead), behind: label(r.behind), ahead: label(r.ahead), merged: false };
}
