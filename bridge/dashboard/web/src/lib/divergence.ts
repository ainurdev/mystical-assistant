/** The Branches bars: how far a branch drifted from its base, as two widths from a centre rule
 *  (behind left, ahead right). Square-rooted so 4 and 12 commits both read, capped so 200 doesn't
 *  swallow the row. A landed branch has nothing to show: it says "merged". */
const label = (n: number) => (n <= 0 ? "" : n > 99 ? "99+" : String(n));
/** A half is 59px (the bar's 118 box), and its count sits at the half's end, so the half gives up the
 *  label's width (7px a character, 2 spare): "99+" leaves 36px, "7" leaves 50. Short counts keep 14·√n. */
const px = (n: number) => (n > 0 ? Math.min(56, 14 * Math.sqrt(n), 59 - 7 * label(n).length - 2) : 0);

export function divergence(r: { ahead: number; behind: number; landed: boolean }) {
  if (r.landed) return { left: 0, right: 0, behind: "", ahead: "", merged: true };
  return { left: px(r.behind), right: px(r.ahead), behind: label(r.behind), ahead: label(r.ahead), merged: false };
}
