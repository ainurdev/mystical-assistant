import { RefreshCw } from "lucide-react";

/** This page is newer than the running bridge (CLAUDE.md, "the one thing that bites
 *  everyone"): the routes aren't there until it restarts. The dashboard's ⟳ makes it live. */
export function StaleBridge({ what }: { what: string }) {
  return (
    <div className="at-emptybox" role="status">
      <RefreshCw size={18} strokeWidth={1.4} aria-hidden />
      <span>The running bridge is older than this page, so it can&apos;t answer for {what}. The ⟳ above the changelog makes it live.</span>
    </div>
  );
}
