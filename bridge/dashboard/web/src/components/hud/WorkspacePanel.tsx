import { useEffect, useState } from "react";
import { api, type ProjectsListing, type SessionBrief } from "../../api";
import type { Telemetry } from "../../lib/telemetry";
import { Panel } from "./Panel";

const CHIPS: { tag: string; color: string; bg: string }[] = [
  { tag: "TG", color: "var(--surface-tg)", bg: "var(--surface-tg-bg)" },
  { tag: "MA", color: "var(--surface-ma)", bg: "var(--surface-ma-bg)" },
  { tag: "VS", color: "var(--surface-vs)", bg: "var(--surface-vs-bg)" },
];

export function WorkspacePanel({
  tele,
  model,
  vscodeLive,
  projectRel,
  sessions,
  open,
  onOpenChange,
  onSelectProject,
  onNewSession,
}: {
  tele: Telemetry;
  model: string;
  vscodeLive: boolean;
  projectRel: string | null;
  sessions: SessionBrief[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSelectProject: () => void;
  onNewSession: () => void;
}) {
  const [listing, setListing] = useState<ProjectsListing | null>(null);

  async function load(dir: string) {
    try {
      setListing(await api.projects(dir === "/" ? undefined : dir));
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    if (open && !listing) void load("/");
  }, [open, listing]);

  async function pick(rel: string) {
    try {
      await api.select(rel);
      onOpenChange(false);
      onSelectProject();
    } catch {
      /* ignore */
    }
  }

  const repos = [...new Set(sessions.map((s) => s.project))];
  const turns = sessions.length; // placeholder count; real turn count shown in center

  const stat = (k: string, v: string, color = "text-foreground") => (
    <div>
      <div className="text-[9.5px] tracking-[1.5px] text-muted-2">{k}</div>
      <div className={`mt-[3px] text-[13px] ${color}`}>{v}</div>
    </div>
  );

  return (
    <Panel label="PANEL" title="WORKSPACE" delay="0s">
      <div className="px-3.5 pb-3 pt-3.5">
        <div className="glow text-[46px] leading-none tracking-[2px] text-foreground-bright">{tele.clock}</div>
        <div className="mt-2 flex gap-2.5 text-[11px] tracking-[1.5px] text-muted-foreground">
          <span>{tele.date || "—"}</span>
          <span className="text-muted-2">//</span>
          <span>{turns} SESSIONS</span>
        </div>

        <div className="mt-4 grid grid-cols-4 gap-2">
          {stat("BRIDGE", "ONLINE", "text-success")}
          {stat("SURFACES", String(2 + (vscodeLive ? 1 : 0)))}
          {stat("MODEL", model.toUpperCase(), "text-violet")}
          {stat("UPTIME", tele.uptime)}
        </div>

        <div className="mt-4 flex gap-[7px]">
          {CHIPS.map((c) => {
            const live = c.tag !== "VS" || vscodeLive;
            return (
              <div
                key={c.tag}
                className="flex flex-1 items-center justify-between border px-[9px] py-1.5"
                style={{ borderColor: c.color, background: c.bg, opacity: live ? 1 : 0.45 }}
              >
                <span className="text-[11px] tracking-[1px]" style={{ color: c.color }}>{c.tag}</span>
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: live ? "#8fd9a8" : "#3c544f" }} />
              </div>
            );
          })}
        </div>

        <div className="mt-3.5 border-t border-dashed border-border pt-3">
          <div className="flex items-center justify-between">
            <button onClick={() => onOpenChange(!open)} className="flex items-center gap-2">
              <span className="text-[9.5px] tracking-[1.5px] text-muted-2">REPO</span>
              <span className="text-[13px] text-primary">/{projectRel ?? "no project"}</span>
              <span className="text-[10px] text-muted-2">[+]</span>
            </button>
            <button
              onClick={onNewSession}
              className="text-[10px] tracking-[1.5px] text-muted-foreground hover:text-foreground"
            >
              + NEW
            </button>
          </div>
          {open && (
            <div
              className="mt-[9px] border border-border-bright bg-[rgba(6,12,12,.9)]"
              style={{ animation: "mpop .14s ease" }}
            >
              {repos.map((name) => (
                <button
                  key={name}
                  onClick={() => void pick(name)}
                  className="flex w-full items-center gap-[9px] border-b border-border px-2.5 py-2 text-left hover:bg-accent"
                >
                  <span
                    className="h-1.5 w-1.5 flex-none rounded-full"
                    style={{ background: name === projectRel ? "#8fd9a8" : "#3c544f" }}
                  />
                  <span className="flex-1 truncate text-[12px] text-foreground">/{name}</span>
                  {name === projectRel && <span className="text-[11px] text-primary">●</span>}
                </button>
              ))}
              {listing && (
                <div className="px-2.5 py-2">
                  <div className="mb-1 truncate text-[10px] tracking-[1px] text-muted-2">{listing.rel}</div>
                  <div className="max-h-32 space-y-0.5 overflow-y-auto">
                    {listing.can_up && (
                      <button
                        className="block w-full text-left text-[11px] text-muted-foreground hover:text-foreground"
                        onClick={() => void load(listing.rel.replace(/\/[^/]+$/, "") || "/")}
                      >
                        ⬆ ..
                      </button>
                    )}
                    {listing.dirs.map((d) => (
                      <button
                        key={d}
                        className="block w-full truncate text-left text-[11px] text-foreground/80 hover:text-foreground"
                        onClick={() => void load(listing.rel === "/" ? `/${d}` : `${listing.rel}/${d}`)}
                      >
                        ▸ {d}
                      </button>
                    ))}
                  </div>
                  <button
                    className="mt-2 w-full border border-primary bg-[var(--ac-12)] py-1 text-[10px] tracking-[1.5px] text-foreground-bright hover:bg-[var(--ac-22)]"
                    onClick={() => void pick(listing.rel)}
                  >
                    USE {listing.rel}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}
