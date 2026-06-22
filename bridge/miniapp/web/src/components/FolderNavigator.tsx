import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { Button, Card, Banner } from "./ui";

/** Compute the parent rel path. "/a/b" -> "/a", "/a" -> "" (base). */
function parentOf(rel: string): string {
  if (!rel || rel === "/") return "";
  const trimmed = rel.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "" : trimmed.slice(0, idx);
}

/** Join a current rel dir with a child folder name. */
function joinRel(rel: string, child: string): string {
  if (!rel || rel === "/") return `/${child}`;
  return `${rel.replace(/\/+$/, "")}/${child}`;
}

export function FolderNavigator() {
  const queryClient = useQueryClient();
  const [dir, setDir] = useState<string>("");

  const listing = useQuery({
    queryKey: ["projects", dir],
    queryFn: () => api.getProjects(dir),
  });

  const selectMutation = useMutation({
    mutationFn: (rel: string) => api.select(rel),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });

  if (listing.isError) {
    const err = listing.error;
    const unauthorized = err instanceof ApiError && err.unauthorized;
    return (
      <Banner tone="error">
        {unauthorized ? "Unauthorized" : "Failed to load folders"}
      </Banner>
    );
  }

  const data = listing.data;
  const currentRel = data?.rel ?? "/";

  return (
    <Card className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-[var(--tg-hint)]">Current folder</div>
          <div className="truncate font-mono text-sm">{currentRel}</div>
        </div>
        {data?.can_up && (
          <Button
            variant="secondary"
            className="shrink-0 px-3 py-1.5"
            onClick={() => setDir(parentOf(currentRel))}
          >
            ↑ Up
          </Button>
        )}
      </div>

      <div className="max-h-44 space-y-1 overflow-y-auto">
        {listing.isLoading && (
          <div className="text-sm text-[var(--tg-hint)]">Loading…</div>
        )}
        {data && data.dirs.length === 0 && (
          <div className="text-sm text-[var(--tg-hint)]">No subfolders</div>
        )}
        {data?.dirs.map((name) => (
          <button
            key={name}
            onClick={() => setDir(joinRel(currentRel, name))}
            className="flex w-full items-center gap-2 rounded-lg bg-[var(--tg-bg)] px-3 py-2 text-left text-sm active:opacity-70"
          >
            <span aria-hidden>📁</span>
            <span className="truncate">{name}</span>
          </button>
        ))}
      </div>

      <Button
        className="w-full"
        disabled={!data || selectMutation.isPending}
        onClick={() => data && selectMutation.mutate(currentRel)}
      >
        {selectMutation.isPending ? "Selecting…" : "Use this folder"}
      </Button>

      {selectMutation.isError && (
        <Banner tone="error">
          {selectMutation.error instanceof ApiError &&
          selectMutation.error.unauthorized
            ? "Unauthorized"
            : "Could not select folder"}
        </Banner>
      )}
    </Card>
  );
}
