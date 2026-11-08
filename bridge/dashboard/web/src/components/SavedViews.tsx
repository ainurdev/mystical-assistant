import { useCallback, useEffect, useState } from "react";
import type { DataEv } from "../lib/dataview";
import { listViews, removeView, useRefSession } from "../lib/readapi";
import { DataView } from "./DataView";

// A project's kept views (bridge/saved_views.py): what you pressed SAVE on in any of its chats.
// The same file is in both apps.
export function SavedViews() {
  const session = useRefSession();
  const [views, setViews] = useState<{ id: string; view: DataEv }[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    if (!session) { setViews([]); return; }
    listViews(session).then((r) => { setViews(r.views); setError(""); },
      (e) => setError(e instanceof Error ? e.message : "Couldn't read them."));
  }, [session]);
  useEffect(() => {
    load();
    window.addEventListener("mystical:saved-views", load);
    return () => window.removeEventListener("mystical:saved-views", load);
  }, [load]);
  const remove = (id: string) => {
    if (!session) return;
    removeView(session, id).then(load, (e) => setError(e instanceof Error ? e.message : "Couldn't remove it."));
  };
  return (
    <div className="dv-saved">
      {error ? <div className="dv-failed">{error}</div> : null}
      {views?.length === 0 && !error ? (
        <div className="dv-saved-none">Nothing kept for this project yet. Press SAVE on a chart, sheet, board or diagram in a chat.</div>
      ) : null}
      {views?.map((v) => <DataView key={v.id} ev={v.view} savedId={v.id} onRemove={remove} />)}
    </div>
  );
}
