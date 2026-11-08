import { useState } from "react";

// A review loop the agent is asking about, as it thinks the feature warrants one (offer_review,
// bridge/gateway_tools.py). It waits until the turn is over and its answer is all there, and only
// the chat's latest finished turn draws it, as a press starts the next one. Same file in both apps.

export type Offer = { type: "offer"; kind: string; title: string; detail: string; rounds: number; prompt: string };

export function OfferCard({ offer, onStart }: { offer: Offer; onStart: (prompt: string) => void }) {
  const [gone, setGone] = useState(false);
  if (gone) return null;
  const rounds = offer.rounds === 1 ? "one round" : `up to ${offer.rounds} rounds`;
  return (
    <div className="dg-card" role="group" aria-label="Offered review">
      <div className="dg-card-text">
        <b>{offer.title}</b>
        <small>{offer.detail ? `${offer.detail} ` : ""}A separate reviewer checks it and the agent fixes what's confirmed, {rounds}.</small>
      </div>
      <button type="button" className="dg-btn" onClick={() => setGone(true)}>Not now</button>
      <button type="button" className="dg-send" onClick={() => { setGone(true); onStart(offer.prompt); }}>Start review</button>
    </div>
  );
}

/** What a finished turn offers: the last one, if it offered more than once. */
export function offerOf(events: { type: string }[]): Offer | null {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].type === "offer") return events[i] as Offer;
  return null;
}
