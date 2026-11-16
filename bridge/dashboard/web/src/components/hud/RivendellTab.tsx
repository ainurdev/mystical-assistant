import type { ReactNode } from "react";

export type RvLens = "tasks" | "team";

const mix = (c: string, pct: number) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;

/** RIVENDELL — one right-rail tab for the two things the Rivendell link brings:
 *  its TASKS (RivendellTasks) and the TEAM (TeamPanel), behind a two-way switch.
 *  Each side is the tab it used to be; App owns which side shows, so the bell
 *  and a share's SEND can open the TEAM side. `teamNew` badges that side.
 *  Design: .mystical/design-drafts/rivendell-team-merge (B · LENSES); flat since
 *  rivendell-tab-v3 (an underline marks the side, no fills, no frame). */
export function RivendellTab({ lens, onLens, teamNew, tasks, team }: {
  lens: RvLens;
  onLens: (l: RvLens) => void;
  teamNew: number;
  tasks: ReactNode;
  team: ReactNode;
}) {
  const side = (l: RvLens, label: string, badge?: number) => {
    const on = lens === l;
    return (
      <button key={l} type="button" role="tab" aria-selected={on} onClick={() => onLens(l)} style={{
        appearance: "none", cursor: "pointer", flex: 1, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
        height: 28, border: 0, borderRadius: 0, padding: 0, fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 2.5,
        background: "transparent", color: on ? "var(--txh)" : "var(--txl)",
        boxShadow: on ? "inset 0 -2px 0 var(--acc)" : "none",
      }}>
        {label}
        {!!badge && <b style={{
          fontFamily: "var(--mono)", fontSize: "var(--t7)", fontWeight: 600, letterSpacing: 0, padding: "0 4px", borderRadius: 6,
          color: "var(--ask)",
        }}>{badge > 9 ? "9+" : badge}</b>}
      </button>
    );
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div role="tablist" aria-label="Rivendell" style={{ flex: "none", display: "flex", margin: "10px 12px 2px" }}>
        {side("tasks", "TASKS")}
        {side("team", "TEAM", teamNew)}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>{lens === "tasks" ? tasks : team}</div>
    </div>
  );
}
