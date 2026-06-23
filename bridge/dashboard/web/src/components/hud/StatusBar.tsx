import { useEffect, useState } from "react";
import { api } from "../../api";

export function StatusBar({
  mount,
  repo,
  changes,
  onPalette,
}: {
  mount: string;
  repo: string;
  changes: number;
  onPalette: () => void;
}) {
  const [ctx, setCtx] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const u = await api.usage();
        if (live) setCtx(u.available && u.five_hour ? u.five_hour.percent : null);
      } catch {
        /* ignore */
      }
    };
    void tick();
    const id = setInterval(tick, 60000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  return (
    <div
      className="flex flex-none items-center gap-4 border-t border-border px-4 py-2 text-[10px] tracking-[1.5px] text-muted-2"
      style={{ animation: "flicker .9s ease both" }}
    >
      <span className="text-muted-foreground">
        MOUNT <span className="text-primary">{mount}</span>
      </span>
      {ctx !== null && (
        <span className="flex items-center gap-[7px]">
          CTX {ctx}%
          <span className="relative inline-block h-[4px] w-[120px] overflow-hidden bg-[var(--ac-12)]">
            <span className="absolute inset-y-0 left-0 bg-primary" style={{ width: `${ctx}%` }} />
          </span>
        </span>
      )}
      <span className="flex-1" />
      <span>
        REPO <span className="text-foreground">/{repo}</span>
      </span>
      <span className="text-warning">{changes} CHANGES</span>
      <button
        onClick={onPalette}
        className="border border-input px-2.5 py-1 text-[10px] tracking-[1.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        ⌘K COMMAND
      </button>
    </div>
  );
}
