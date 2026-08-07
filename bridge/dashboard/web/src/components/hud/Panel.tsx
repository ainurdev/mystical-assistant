import type { ReactNode } from "react";

export function Panel({
  title,
  label = "PANEL",
  className = "",
  delay = "0s",
  flex,
  children,
}: {
  title: ReactNode;
  label?: string;
  className?: string;
  delay?: string;
  flex?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`panel border border-border bg-panel ${
        flex ? "flex min-h-0 flex-1 flex-col" : "flex-none"
      } ${className}`}
      style={{ animation: `boot .5s ease both ${delay}` }}
    >
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[length:var(--t105)] tracking-[2.5px] text-muted-2">{label}</span>
        <span className="text-[length:var(--t105)] tracking-[2.5px] text-primary">{title}</span>
      </div>
      <div
        className="h-px flex-none origin-left"
        style={{
          background: "linear-gradient(90deg,var(--primary),var(--muted))",
          animation: `drawline .7s ease both ${delay}`,
        }}
      />
      {children}
    </div>
  );
}
