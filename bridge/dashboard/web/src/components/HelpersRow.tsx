import { useEffect, useState } from "react";
import { Minus, Plus, Users } from "lucide-react";
import { clampLimit, LIMIT_KEYS, LIMITS, type HelperConfig, type HelperMode, type LimitKey } from "../lib/multi";

/* The run sheet's helper limits: one row, live, per chat (plan decision 6). The
   sheet's own note says nothing nests, so this is one line that opens the three
   steppers under itself. A change goes as you make it, and lowering a limit
   stops nothing already running. */

const MODES: { id: HelperMode; label: string; tip: string }[] = [
  { id: "off", label: "Off", tip: "No helpers in this chat." },
  { id: "ask", label: "Ask", tip: "A card lists what would start, unless your own message asked for a helper." },
  { id: "auto", label: "Auto", tip: "Helpers start within these limits without asking." },
];

function Stepper({ k, value, onChange }: { k: LimitKey; value: number; onChange: (n: number) => void }) {
  const { lo, hi, word, tip } = LIMITS[k];
  return (
    <span className="ma-step" title={tip}>
      <button type="button" aria-label={`Fewer ${word}`} disabled={value <= lo} onClick={() => onChange(clampLimit(k, value - 1))}><Minus size={10} aria-hidden /></button>
      <b>{value}</b>
      <button type="button" aria-label={`More ${word}`} disabled={value >= hi} onClick={() => onChange(clampLimit(k, value + 1))}><Plus size={10} aria-hidden /></button>
      <span>{word}</span>
    </span>
  );
}

export function HelpersRow({ config, onChange }: {
  config: HelperConfig;
  onChange: (patch: Partial<HelperConfig>) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  // Shown as picked at once; a refusal puts the chat's own value back.
  const [mine, setMine] = useState(config);
  useEffect(() => { setMine(config); }, [config]);
  const set = (patch: Partial<HelperConfig>) => {
    setMine((m) => ({ ...m, ...patch }));
    onChange(patch).catch(() => setMine(config));
  };
  return (
    <div className="ma-helpers">
      <div className="ma-helpers-line">
        <span className="ma-helpers-lab"><Users size={12} strokeWidth={1.8} aria-hidden />HELPERS</span>
        <span className="rp-seg" role="group" aria-label="Helpers">
          {MODES.map((m) => (
            <button key={m.id} type="button" className="rp-sg" aria-pressed={mine.helpers === m.id} data-on={mine.helpers === m.id ? "" : undefined}
              title={m.tip} onClick={() => set({ helpers: m.id })}>{m.label}</button>
          ))}
        </span>
        <button type="button" className="ma-helpers-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}
          title="Limits for this chat. Lowering one stops nothing already running.">
          {mine.max_agents} agents · {mine.per_account} per login · {mine.max_hops} hops <span aria-hidden>{open ? "▴" : "▾"}</span>
        </button>
      </div>
      {open && (
        <div className="ma-helpers-steps">
          {LIMIT_KEYS.map((k) => <Stepper key={k} k={k} value={mine[k]} onChange={(n) => set({ [k]: n })} />)}
        </div>
      )}
    </div>
  );
}
