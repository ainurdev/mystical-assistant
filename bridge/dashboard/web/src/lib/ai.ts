import { useQuery } from "@tanstack/react-query";
import { api, type AiFeature, type GraphInstall } from "../api";
import { queryClient, settings } from "./queries";

/** Which model-spending extras are on, for everything that has to hide itself while its switch
 *  is off (the next-up board). One query (lib/queries settings.aiFeatures), many readers: a switch
 *  POST invalidates it, so every reader follows at once. Unknown reads as off, so a feature's UI
 *  never flashes in before the bridge has answered; a failed read keeps the last answer. */
const NONE: Record<string, boolean> = {};
const flags = (r: { features: AiFeature[] }) => Object.fromEntries(r.features.map((f) => [f.key, f.enabled]));

export function useAiFeatures(): Record<string, boolean> {
  return useQuery({ ...settings.aiFeatures(), select: flags }).data ?? NONE;
}

/** graphify, the tool PROJECT MAP runs on: is it on the bridge machine, and the
 *  install offered wherever a map switch would otherwise switch on nothing (the
 *  Extras card, a repo's Project map row, the MAP tab). The caller flips its own
 *  switch as Install is pressed, so a page closed mid-install still ends up on;
 *  this only follows the install, polling while one runs, even one another page
 *  started. `installed` is null until the bridge answers, and stays null on a
 *  bridge too old for the route, so callers keep drawing their switch. */
export function useGraphify() {
  const key = settings.graphInstall();
  // An older bridge has no route: the read fails and the switch stays as it was.
  const st = useQuery({ ...key, refetchInterval: (q) => (q.state.data?.state === "running" ? settings.graphInstall.poll!.ms : false) }).data ?? null;
  const put = (s: GraphInstall) => queryClient.setQueryData(key.queryKey, s);
  return {
    installed: st ? st.installed : null,
    installing: st?.state === "running",
    error: st?.state === "error" ? st.error ?? "" : "",
    // The POST invalidates the read, which then polls while the install runs.
    install: () => {
      put({ installed: false, state: "running" });
      void api.installGraphify().catch((e: Error) => put({ installed: false, state: "error", error: e.message }));
    },
  };
}
