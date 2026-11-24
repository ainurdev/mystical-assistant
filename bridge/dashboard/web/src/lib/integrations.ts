import { useQuery } from "@tanstack/react-query";
import type { Integration } from "../api";
import { settings } from "./queries";

/** Which bundled integrations are installed (Rivendell, Claude Design), for everything that has
 *  to hide itself while its plugin isn't and stop calling routes that would 404 — the RIVENDELL
 *  poll above all. One query (lib/queries settings.integrations), many readers, the shape of
 *  lib/ai.ts. Unknown reads as off, so a plugin's UI never flashes in before the bridge has
 *  answered; a failed read keeps the last answer. */
const NONE: Record<string, boolean> = {};
// A bridge older than this dashboard 404s "not found": it has no install step and runs them all.
const ALL: Record<string, boolean> = { rivendell: true, design: true };
const flags = (r: { plugins: Integration[] }) => Object.fromEntries(r.plugins.map((p) => [p.id, p.installed]));

export function useIntegrations(): Record<string, boolean> {
  const q = useQuery({ ...settings.integrations(), select: flags });
  return q.data ?? (q.error?.message === "not found" ? ALL : NONE);
}
