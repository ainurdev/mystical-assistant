// The Team tab's feed: a share waiting for you is a card (it has things to do), every
// other event one line. Today is the same local day as `now`; each list is newest first.
// A line from the inbox carries its `r`, so the panel can reopen / continue / remove it.
import type { Received, TeamOverview } from "../api";
import { foldSent, seen, sentStatus } from "./team.ts";

export type FeedItem =
  | { kind: "share"; r: Received; at: number }
  | { kind: "line"; id: string; icon: "send" | "msg"; who: string; text: string; status: string | null; tone: "ok" | "warn" | "err" | "dim"; at: number; tip?: string; r?: Received };

const t = (iso: string) => { const v = Date.parse(iso) / 1000; return Number.isNaN(v) ? 0 : v; };
const day = (sec: number) => new Date(sec * 1000).toDateString();

export function teamFeed(team: TeamOverview, now: number): { today: FeedItem[]; earlier: FeedItem[] } {
  const items: FeedItem[] = [
    ...team.inbox.map((r): FeedItem => seen(r)
      ? { kind: "line", id: r.id, icon: "msg", who: "You", text: `You ${r.continued ? "continued" : "opened"} ${r.from.name}'s ${r.title}`, status: null, tone: "dim", at: r.at, r }
      : { kind: "share", r, at: r.at }),
    ...foldSent(team.outbox).filter((s) => !s.dismissedAt).map((s): FeedItem => {
      const st = sentStatus(s, now);
      return { kind: "line", id: s.id, icon: "send", who: "You", text: `You sent ${s.title} to ${s.to.name}`,
        status: s.openedAt && !s.continuedAt && !s.queued ? "OPENED ✓✓" : st.text, tone: st.tone === "purple" ? "ok" : st.tone, at: t(s.sentAt),
        tip: s.queued ? (s.error ? `not sent: ${s.error}` : "goes when its running turn ends") : undefined };
    }),
  ].sort((a, b) => b.at - a.at);
  const today = items.filter((i) => day(i.at) === day(now));
  return { today, earlier: items.filter((i) => !today.includes(i)) };
}

/** STREAM (TeamPanel): the feed split by local day, "Today" and then each older day by
 *  its date. Items keep their order, so newest first in, newest first out. */
export function byDay(items: FeedItem[], now: number): { label: string; items: FeedItem[] }[] {
  const out: { label: string; items: FeedItem[] }[] = [];
  for (const it of items) {
    const label = day(it.at) === day(now) ? "Today"
      : new Date(it.at * 1000).toLocaleDateString([], { month: "short", day: "numeric" });
    if (out.at(-1)?.label === label) out.at(-1)!.items.push(it);
    else out.push({ label, items: [it] });
  }
  return out;
}
