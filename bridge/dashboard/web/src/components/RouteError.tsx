import type { ErrorComponentProps } from "@tanstack/react-router";
import { Button } from "./ui";

/** What an error inside the app shows instead of a blank window: the root
 *  route's errorComponent (router.tsx). A lazy piece still missing after the
 *  router's one reload lands here too, so this never reloads by itself. */
export function RouteError({ error }: ErrorComponentProps) {
  return (
    <div role="alert" className="flex h-screen flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm">Something went wrong on this page.</p>
      <p className="max-w-xl break-words text-xs opacity-70">{error instanceof Error ? error.message : String(error)}</p>
      <Button onClick={() => location.reload()}>Reload</Button>
    </div>
  );
}
