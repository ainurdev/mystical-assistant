import type { ReactNode } from "react";

// The one-line head every right-rail panel opens with: its name in small caps,
// a chip after it, tools at the far end.
export function TabKick({ name, chip, tools }: { name: string; chip?: ReactNode; tools?: ReactNode }) {
  return (
    <div className="tabkick" style={{ display: "flex", alignItems: "center", gap: 8, height: 36, flex: "none", padding: "0 12px" }}>
      <span className="tk-name">{name}</span>
      {chip}
      {tools && <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>{tools}</span>}
    </div>
  );
}
