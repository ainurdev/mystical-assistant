import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, type ChannelView, type HelpersConfig } from "../lib/api";

/* HELPERS in the run settings: may this chat start agents, and how many. Each pick
   is saved as it's made and applies to the next helper or message. Lowering a limit
   stops nothing. The bounds are bridge experimental.LIMITS. */

const STEPS: { k: "max_agents" | "per_account" | "max_hops"; label: string; min: number; max: number; by: number; title: string }[] = [
  { k: "max_agents", label: "AGENTS", min: 1, max: 20, by: 1, title: "Agents this chat may run at once" },
  { k: "per_account", label: "PER LOGIN", min: 1, max: 20, by: 1, title: "Helpers one login may run at once" },
  { k: "max_hops", label: "HOPS", min: 1, max: 200, by: 5, title: "Messages between agents before the channel holds and asks you" },
];

export function HelpersRow({ sessionId, config }: { sessionId: string; config: HelpersConfig }) {
  const qc = useQueryClient();
  const [local, setLocal] = useState<Partial<HelpersConfig>>({});
  const [err, setErr] = useState<string | null>(null);
  const v = { ...config, ...local };
  function save(patch: Partial<HelpersConfig>) {
    setLocal((l) => ({ ...l, ...patch }));
    setErr(null);
    api.setChatConfig(sessionId, patch).then(({ config: next }) => {
      qc.setQueryData<ChannelView>(["channel", sessionId], (d) => d && { ...d, config: next });
      setLocal((l) => {
        const left = { ...l };
        for (const k of Object.keys(patch) as (keyof HelpersConfig)[]) if (left[k] === patch[k]) delete left[k];
        return left;
      });
    }).catch((e: unknown) => {
      setLocal({});
      setErr(e instanceof Error ? e.message : "That didn't save.");
    });
  }
  return (
    <div className="px-1 pb-1.5">
      <div className="px-1 py-1 text-[10px] tracking-[1.5px] text-muted-foreground">HELPERS</div>
      <div role="group" aria-label="Helpers" className="sb-seg">
        {(["off", "ask", "auto"] as const).map((h) => (
          <button key={h} type="button" aria-pressed={v.helpers === h}
            className="min-h-[36px]" onClick={() => save({ helpers: h })}>
            {h === "off" ? "Off" : h === "ask" ? "Ask" : "Auto"}
          </button>
        ))}
      </div>
      <div className="mt-1.5 flex gap-1.5">
        {STEPS.map((s) => (
          <div key={s.k} className="sw-step" title={s.title}>
            <span>{s.label}</span>
            <div>
              <button type="button" aria-label={`Fewer: ${s.label.toLowerCase()}`} disabled={v[s.k] <= s.min}
                onClick={() => save({ [s.k]: Math.max(s.min, v[s.k] - s.by) })}>{"−"}</button>
              <b>{v[s.k]}</b>
              <button type="button" aria-label={`More: ${s.label.toLowerCase()}`} disabled={v[s.k] >= s.max}
                onClick={() => save({ [s.k]: Math.min(s.max, v[s.k] + s.by) })}>+</button>
            </div>
          </div>
        ))}
      </div>
      {err && <div className="mt-1 px-1 text-[11px]" style={{ color: "var(--err)" }}>{err}</div>}
    </div>
  );
}
