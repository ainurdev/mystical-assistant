// The usage limit as the chat tells it (design: .mystical/design-drafts/limit-chat,
// B · CARD): which window ran out, read off the CLI's own sentence; the turns the
// bridge sent to carry the work on, which aren't your words; and the login to
// offer instead of the dry one.
import type { AccountInfo } from "../api.ts";

/** The window a limit sentence names: "5-hour", "weekly", "monthly" (an org's
 *  cap), a model's own ("Opus", "Fable 5"), or "" when it doesn't say — old CLIs
 *  print "usage limit reached|<epoch>". Same family bridge/limits.py matches. */
export function limitWindow(text: string): string {
  const m = /you've (?:hit|reached) your (.+?) limit/i.exec(text);
  if (!m) return "";
  const w = m[1].trim();
  if (/^session$/i.test(w)) return "5-hour";
  if (/^weekly$/i.test(w)) return "weekly";
  if (/monthly/i.test(w)) return "monthly";
  return /^usage$/i.test(w) ? "" : w;
}

/** When the sentence says the window refills ("resets 12:30am", "resets Oct 28,
 *  4pm"), as a 24-hour clock plus the date it names. The CLI prints it in the
 *  bridge machine's zone, which is the dashboard's on Mystical.app.
 *  shortcut: a dashboard viewed from another zone reads it off by the difference;
 *  carry the reset epoch on the turn if that ever matters. */
export function limitResets(text: string): { h: number; m: number; day?: string } | null {
  const r = /resets\s+(?:([A-Z][a-z]{2,8}\.? \d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text);
  if (!r) return null;
  const h = (Number(r[2]) % 12) + (r[4].toLowerCase() === "pm" ? 12 : 0);
  return { h, m: Number(r[3] ?? 0), ...(r[1] ? { day: r[1] } : {}) };
}

/** A turn the bridge sent to carry on after a limit (bridge/ladder.py
 *  ACCOUNT_NUDGE, bridge/limits.py NUDGE): "account" when another login took the
 *  work, "reset" when the window refilled. null for anything you wrote. */
export function limitNudge(prompt: string | null | undefined): "account" | "reset" | null {
  if (!prompt?.startsWith("⏮ ") || !prompt.includes("usage limit was reached")) return null;
  return prompt.includes("resumed on another account") ? "account" : "reset";
}

/** The login to offer instead of a dry one, picked the way the ladder picks
 *  (bridge/accounts.pick): most left first, and one whose meter won't read only
 *  as a last resort — "can't tell" isn't "empty". null when none is usable. */
export function otherLogin(accounts: AccountInfo[], dry: number | null): AccountInfo | null {
  const live = accounts.filter((a) => a.slot !== dry && !a.disabled && a.logged_in !== false);
  const known = live.filter((a) => a.left !== null && a.left > 0).sort((a, b) => b.left! - a.left!);
  return known[0] ?? live.find((a) => a.left === null) ?? null;
}

/** How a login is named in the chat: its alias, its email, or its slot. */
export const loginName = (a: AccountInfo | undefined, slot: number | null): string =>
  a?.alias || a?.email || (slot === null ? "this login" : `account ${slot}`);

/** A stretch of time the way the card says it: `43m`, `1h 43m`, `2d 3h`. */
export function span(secs: number): string {
  const m = Math.max(0, Math.round(secs / 60));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}
