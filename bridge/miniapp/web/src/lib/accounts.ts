import { useQuery } from "@tanstack/react-query";
import { api, type AccountInfo, type UsageInfo } from "./api";

// Which Claude login a session spends, and what each login has left. The usage
// strip reads the login that is actually running the turns (a profile pick or
// a fallback handover changes it), and the PROFILE pills show how much quota a
// switch would give you. Mirrors bridge/dashboard/web/src/models.ts (loginSlot,
// spendingSlot, loginLeft) by hand: the two web apps share no source.

/** bridge accounts.DEFAULT_SLOT: the ambient ~/.claude login. */
export const DEFAULT_SLOT = 1;

/** The Claude login an agent and account run on: the account's slot, or the
 *  default login when it names none. null for another agent. */
export function loginSlot(agent = "claude", account = ""): number | null {
  if (agent !== "claude") return null;
  return /^\d+$/.test(account) ? Number(account) : DEFAULT_SLOT;
}

/** The login the open session spends: the bridge's `slot`, else (an older
 *  bridge) its profile's login. No session open: the default login. */
export function spendingSlot(s?: { slot?: number | null; agent?: string; account?: string } | null): number | null {
  if (!s) return DEFAULT_SLOT;
  return s.slot !== undefined ? s.slot : loginSlot(s.agent, s.account);
}

/** What a login has left: the tighter window's unspent share and that
 *  window's severity. null when the meter doesn't read or the login is off. */
export function loginLeft(a?: AccountInfo | null): { left: number; severity?: string } | null {
  if (!a || a.disabled || a.left === null) return null;
  const tight = [a.five_hour, a.seven_day].reduce<AccountInfo["five_hour"]>(
    (t, b) => (b && (t === null || b.percent > t.percent) ? b : t), null);
  return { left: a.left, severity: tight?.severity };
}

/** Every login with its meter, polled every 60s. */
export function useAccounts() {
  return useQuery({ queryKey: ["accounts"], queryFn: () => api.getAccounts(), refetchInterval: 60000 });
}

/** The usage of the login `slot` names, read off its /api/accounts row, with
 *  its tag ("A2", once there is more than one login to tell apart) and email.
 *  A bridge older than that route falls back to /api/usage, which only stands
 *  for the default login. */
export function useSpentUsage(slot: number | null): { usage: UsageInfo | null; tag: string | null; who: string | null } {
  const accounts = useAccounts();
  const ambient = useQuery({ queryKey: ["usage"], queryFn: () => api.getUsage(), refetchInterval: 60000,
                             enabled: accounts.isError && slot === DEFAULT_SLOT });
  const rows = accounts.data?.accounts;
  if (slot === null) return { usage: null, tag: null, who: null };      // another agent: no Claude quota
  if (!rows) return { usage: slot === DEFAULT_SLOT ? ambient.data ?? null : null, tag: null, who: null };
  const a = rows.find((r) => r.slot === slot);
  return {
    usage: a ? { available: !!(a.five_hour || a.seven_day), five_hour: a.five_hour, seven_day: a.seven_day } : null,
    tag: rows.filter((r) => !r.disabled).length > 1 ? `A${slot}` : null,
    who: a?.email ?? null,
  };
}
