import type { FlowShape, FlowStageShape } from "../api";

// What kind of work this session is doing NOW. AUTO TYPE re-reads every
// prompt, so this moves with the work — and can be wrong; a native select is
// the whole escape hatch: keyboard, phone and screen reader for free.
export function TypePicker({
  flows,
  current,
  onRetype,
}: {
  flows: FlowShape[];
  current: string | null;
  onRetype: (stype: string | null) => void;
}) {
  return (
    <select
      value={current ?? ""}
      title="what kind of work this session is"
      onChange={(e) => {
        const to = e.target.value || null;
        // Retyping restarts the new flow at stage one — worth one click's pause.
        if (window.confirm(`Re-type this session as ${to ? to.toUpperCase() : "CHAT"}?`))
          onRetype(to);
      }}
      style={{
        appearance: "none", cursor: "pointer", flex: "none",
        background: "color-mix(in srgb, var(--panel2) 55%, transparent)",
        border: "1px solid color-mix(in srgb, var(--acc) 22%, transparent)",
        color: current ? "var(--txb)" : "var(--txm)",
        fontFamily: "inherit", fontSize: "var(--t8)", letterSpacing: 1,
        padding: "1px 4px",
      }}
    >
      <option value="">CHAT</option>
      {flows.map((f) => (
        <option key={f.stype} value={f.stype}>{f.label}</option>
      ))}
    </select>
  );
}

// Where a typed session stands, and the only place to move it by hand. Past
// stages dim, the current one is lit, gates carry a ◆ — so a stage that will
// stop and wait for you says so before you get there.
export function StageRail({
  stages,
  current,
  onSet,
}: {
  stages: FlowStageShape[];
  current: string | null;
  onSet: (stage: string) => void;
}) {
  const at = stages.findIndex((s) => s.id === current);
  const done = current === "done";

  return (
    <div className="flex items-center gap-1 overflow-x-auto text-[10px] tracking-[0.12em]">
      {stages.map((s, i) => {
        const isCurrent = s.id === current;
        const isPast = done || (at >= 0 && i < at);
        return (
          <button
            key={s.id}
            type="button"
            title={
              isCurrent
                ? "current stage"
                : `jump ${i < at ? "back to" : "ahead to"} ${s.label}`
            }
            onClick={() => {
              // Jumping back re-runs work that already happened; ahead skips a
              // stage's gate. Both are legal, neither should be a stray click.
              if (isCurrent) return;
              if (window.confirm(`Move this session to ${s.label}?`)) onSet(s.id);
            }}
            className={
              "shrink-0 " + (isCurrent
                ? "rounded px-1.5 py-0.5 bg-primary text-primary-foreground"
                : isPast
                  ? "rounded px-1.5 py-0.5 text-muted-foreground"
                  : "rounded px-1.5 py-0.5 text-muted-foreground opacity-50")
            }
          >
            {s.label}
            {s.gate ? " ◆" : ""}
          </button>
        );
      })}
      {done && <span className="px-1 text-muted-foreground">· COMPLETE</span>}
    </div>
  );
}
