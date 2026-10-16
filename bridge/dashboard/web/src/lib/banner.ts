import type { AnswerSelection, PendingCard } from "../api";

/** The buttons a macOS banner carries for a card, and what a tap answers — so a
 *  permission or a one-question ask is settled from the banner, window closed
 *  (Mystical.app only; lib/mac wires it, the shim delivers the tap as onaction).
 *  Permission → Allow / Deny. One single-select question with ≤4 options → its
 *  labels. Anything else gets no buttons: the banner still opens the session. */
export interface BannerButton { action: string; title: string }
export interface BannerAnswer { request_id: string; behavior?: "allow" | "deny"; answers?: AnswerSelection[] }

const OPT = "opt:";
const clip = (s: string) => (s.length > 40 ? s.slice(0, 39) + "…" : s);

export function bannerActions(card: PendingCard | undefined): BannerButton[] {
  if (!card) return [];
  if (card.kind === "permission") return [{ action: "allow", title: "Allow" }, { action: "deny", title: "Deny" }];
  const q = card.questions?.length === 1 ? card.questions[0] : undefined;
  if (!q || q.multiSelect || !q.options?.length || q.options.length > 4) return [];
  return q.options.map((o, i) => ({ action: `${OPT}${i}`, title: clip(o.label) }));
}

export function bannerAnswer(card: PendingCard | undefined, action: string): BannerAnswer | null {
  if (!card) return null;
  if (card.kind === "permission")
    return action === "allow" || action === "deny" ? { request_id: card.request_id, behavior: action } : null;
  const q = card.questions?.[0];
  const i = action.startsWith(OPT) ? Number(action.slice(OPT.length)) : NaN;
  const label = q?.options?.[i]?.label;
  return q && label !== undefined ? { request_id: card.request_id, answers: [{ header: q.header, labels: [label] }] } : null;
}
