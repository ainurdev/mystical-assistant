/** The skill router's decisions that don't need the DOM: whether a route from
 *  /local/route (bridge/route.py) goes into the draft by itself, whether it shows
 *  as a ghost, whether the user took it out, whether its reply came too late. The
 *  composer keeps the state (the `applied` command, the `dropped` flag, the fetch
 *  `seq`); these only read it, so the cases that bite are pinned in route.check.ts.
 */

import type { Route } from "../api";

/** Tokens past which a phase boundary offers /compact first. Mirrors SMART_ZONE in bridge/route.py. */
export const SMART_ZONE = 150_000;

/** Does the composer put `r` in front of the text by itself? Only an auto pick, for
 *  something typed, and never over a `/command` or after the user took it out of this draft. */
export function shouldAutoApply(text: string, r: Route | null, dropped: boolean): boolean {
  return !!r?.auto && !dropped && text.trim() !== "" && !text.startsWith("/");
}

/** Was the command we put in front (`applied`, without its `/`) taken out of the text?
 *  Backspace into the name counts. The composer sets `dropped` from this and keeps it
 *  until the draft is emptied, so a command you removed never comes back by itself. */
export function isDropped(text: string, applied: string | null): boolean {
  return applied !== null && !text.startsWith("/" + applied);
}

/** What the editor draws as the dashed ghost segment, if anything. An auto route with
 *  text is applied solid instead, and a `/` the user typed is theirs. The suggested
 *  `arg` only shows in an empty box; once there is text, the text is the arg. */
export function ghostFor(text: string, r: Route | null): { name: string; desc: string; arg: string } | null {
  if (!r || text.startsWith("/") || (r.auto && text !== "")) return null;
  return { name: r.name, desc: r.desc, arg: text === "" ? r.arg : "" };
}

/** Did the box move on while this route request was out? A reply for text since
 *  edited or sent, or one a newer request has replaced, must not apply. */
export function isStale(sentText: string, nowText: string, sentSeq: number, nowSeq: number): boolean {
  return sentSeq !== nowSeq || sentText !== nowText;
}

/** The line under the box for the route on show (`auto`: the pick we put in front is still
 *  there): a tag, the reason, then each [key, words] after a "·", the key drawn as a keycap
 *  ("" for none). /compact names the step it makes room for, from the arg bridge/route.py
 *  ends with "next: /<step>". */
export function caption(r: Route, auto: boolean): { tag: string; tone?: "warn" | "dim"; why: string; tail: [string, string][] } {
  if (auto) return { tag: "AUTO", why: r.why, tail: [["⌫", "drops it"], ["", "click it for other fits"]] };
  if (r.kind === "ask") return { tag: "NO CLEAR FIT", tone: "dim", why: "Tab hands it to /ask-matt, which names the flow", tail: [["", "ignore it to send as typed"]] };
  if (r.kind === "setup") return { tag: "ONCE", why: r.why, tail: [["Tab", "takes it"], ["Esc", "hides it for this repo"]] };
  if (r.name === "compact") {
    const next = /\/\S+$/.exec(r.arg)?.[0];
    return { tag: "NEXT", tone: "warn", why: r.why, tail: [["Tab", "takes it"], ...(next ? [["", `then ${next}`] as [string, string]] : [])] };
  }
  if (r.kind === "next") return { tag: "NEXT", why: r.why, tail: [["Tab", r.fresh ? "opens it in a fresh session" : "takes it"]] };
  return { tag: "ROUTE", why: r.why, tail: [["Tab", "takes it"]] };
}

/** `text`, which leads with `/from`, with that command (and the one space after it) swapped
 *  for `/to `, or taken out when `to` is null: a pick from the other fits, or Send as typed. */
export function swapLead(text: string, from: string, to: string | null): string {
  const rest = text.slice(from.length + 1).replace(/^ /, "");
  return to ? `/${to} ${rest}` : rest;
}
