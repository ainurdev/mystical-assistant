import { createRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { rootRoute } from "./root";
import { api } from "../lib/api";
import { DesignView } from "../components/design/DesignView";

function DesignPage() {
  const state = useQuery({ queryKey: ["state"], queryFn: () => api.getState(), refetchInterval: 5000 });
  return <DesignView previewUrl={state.data?.preview?.url ?? null} project={state.data?.project?.rel ?? null} />;
}

export const designRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/design",
  component: DesignPage,
});
