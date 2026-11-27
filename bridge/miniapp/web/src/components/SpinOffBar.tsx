import { useState } from "react";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Clock, ListPlus, Play, Split } from "lucide-react";
import { request } from "../lib/api";
import { useChat } from "../lib/chat";

type Row = {
  n: number; title: string; project: string; clone: string; state: string; session: string;
  repeat: { project: string; session: string; title: string } | null;
};
type Cards = { cards: { id: string; rows: Row[]; startable: number }[] };

const read = (session: string) =>
  queryOptions({ queryKey: ["/api/spinoffs", session], queryFn: () => request<Cards>(`/api/spinoffs?session=${encodeURIComponent(session)}`) });
const name = (rel: string) => rel.replace(/\/+$/, "").split("/").pop() || rel;
const GONE = new Set(["started", "waiting", "parked"]);

/** A reply that offered spin-offs (bridge/spinoffs.py). The card is the dashboard's: here it is one bar,
 *  ▶ Start all for the rows that can go as they are, and Open for the rows. Start all leaves repeats and
 *  rows with no checkout to the dashboard: the phone never clones. */
export function SpinOffBar({ session, card }: { session: string; card: string }) {
  const q = useQuery(read(session));
  const qc = useQueryClient();
  const { openSessionInProject } = useChat();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const shown = q.data?.cards.find((c) => c.id === card);
  const rows = shown?.rows ?? [];
  if (!rows.length) return null;
  const can = shown?.startable ?? 0;   // the bridge's one rule for what Start all starts (bridge/spinoffs.py _startable)
  const went = rows.filter((r) => GONE.has(r.state)).length;
  const startAll = async () => {
    setBusy(true);
    setError("");
    try {
      qc.setQueryData(read(session).queryKey, await request<Cards>("/api/spinoffs/start-all", { method: "POST", body: { session_id: session, card } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dg-card so-bar" role="group" aria-label="Spin-offs">
      <div className="so-bar-h">
        <Split size={14} aria-hidden />
        <span>{went ? `Spun off ${went} of ${rows.length}` : "Spin-offs"}</span>
        {!went ? <span className="so-bar-n">{rows.length}</span> : null}
        <span className="so-bar-sp" />
        {can ? <button type="button" className="dg-send" disabled={busy} onClick={() => void startAll()}><Play size={11} aria-hidden /> Start all {can}</button> : null}
        <button type="button" className="dg-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? "Close" : "Open"}</button>
      </div>
      {error ? <p className="so-bar-err" role="alert">{error}</p> : null}
      {open ? (
        <ul className="so-bar-rows">
          {rows.map((r) => {
            const sid = r.session || r.repeat?.session || "";
            const where = r.project || r.repeat?.project || "";
            const state = r.repeat ? "already in a session" : r.state === "open" ? (r.project ? "" : r.clone ? "no checkout: on the dashboard" : "no project: on the dashboard")
              : r.state === "waiting" ? "waits for the one before" : r.state === "parked" ? "parked" : r.state === "started" ? "" : r.state;
            return (
              <li key={r.n}>
                {sid ? (
                  <button type="button" onClick={() => void openSessionInProject(where, sid)}>{r.title}<ArrowUpRight size={12} aria-hidden /></button>
                ) : <span>{r.title}</span>}
                <small>
                  {where ? name(where) : ""}{where && state ? " · " : ""}
                  {r.state === "waiting" ? <Clock size={11} aria-hidden /> : r.state === "parked" ? <ListPlus size={11} aria-hidden /> : null}{state}
                </small>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
