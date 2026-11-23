import { useQuery } from "@tanstack/react-query";
import { api, type FlowChange, type FlowSettings } from "../api";
import { queryClient, reread, settings } from "./queries";

/** The FLOWS sheet's settings (bridge/flowsettings.py), one query (lib/queries settings.flows)
 *  shared by the box, its sheet and SETTINGS. Kept on the bridge, so a change made in another
 *  browser or app shows the next time the sheet opens (it re-reads then). null until the bridge
 *  has answered; a failed read keeps the last answer. */

export const refreshFlowSettings = () => reread(settings.flows().queryKey);

/** One change. Its answer is every setting, shown at once; the POST also invalidates the AI
 *  switches, since FLOWS, AUTO PICKS and SMART ZONE are AI switches too. */
export async function changeFlows(body: FlowChange): Promise<void> {
  queryClient.setQueryData(settings.flows().queryKey, await api.setFlows(body));
}

export function useFlowSettings(): FlowSettings | null {
  return useQuery(settings.flows()).data ?? null;
}
