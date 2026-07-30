import { useEffect, useRef, useState } from "react";
import { api, type ShellSnapshot } from "../api";

/** Ad-hoc remote shell: run a command in the active project and watch its output
 *  stream in. Same trust boundary as the rest of the dashboard. */
export function ShellTab() {
  const [snap, setSnap] = useState<ShellSnapshot | null>(null);
  const [cmd, setCmd] = useState("");
  const cursor = useRef(0);
  const lines = useRef<{ seq: number; line: string }[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const running = snap?.running ?? false;

  // Poll for output — fast while a command runs, slow when idle. Cursor advances
  // so we only fetch new lines.
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const s = await api.shell(cursor.current);
        if (!live) return;
        if (s.lines.length) {
          lines.current = [...lines.current, ...s.lines].slice(-2000);
          cursor.current = s.cursor;
        }
        setSnap(s);
      } catch {
        /* ignore */
      }
    };
    void tick();
    const id = setInterval(tick, running ? 800 : 2500);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [running]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [snap]);

  async function run() {
    const c = cmd.trim();
    if (!c || running) return;
    setCmd("");
    try {
      await api.shellRun(c);
      cursor.current = Math.max(0, cursor.current); // keep streaming from where we are
    } catch {
      /* surfaced via snapshot */
    }
  }

  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-3 flex items-center gap-2 text-[11px]">
        <span
          className="h-[7px] w-[7px] rounded-full"
          style={{ background: running ? "var(--success)" : "var(--muted-2)" }}
        />
        <span className="font-mono text-muted-foreground">
          shell · {snap?.dir ?? "—"}
          {snap && snap.status !== "idle" && !running ? ` · ${snap.status}` : ""}
          {snap?.code != null && !running ? ` (${snap.code})` : ""}
        </span>
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto rounded-[9px] border border-border bg-[var(--code-bg)] p-3 font-mono text-[11px] leading-relaxed text-muted-foreground"
      >
        {lines.current.length === 0 ? (
          <div className="text-muted-2">run a command to see its output</div>
        ) : (
          lines.current.map((l) => (
            <div key={l.seq} className="whitespace-pre-wrap break-words">
              {l.line}
            </div>
          ))
        )}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <span className="flex-none font-mono text-[13px] text-violet">$</span>
        <input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void run();
            }
          }}
          placeholder="npm test · git log --oneline -10 · ls -la"
          className="flex-1 border border-input bg-transparent px-2 py-1.5 font-mono text-[12px] text-foreground outline-none placeholder:text-[#456b65]"
        />
        {running ? (
          <button
            onClick={() => void api.shellKill()}
            className="border border-danger bg-[color-mix(in srgb, var(--err) 12%, transparent)] px-3 py-1.5 text-[11px] tracking-[1px] text-danger hover:bg-[color-mix(in srgb, var(--err) 22%, transparent)]"
          >
            KILL
          </button>
        ) : (
          <button
            onClick={() => void run()}
            disabled={!cmd.trim()}
            className="border border-primary bg-[var(--ac-12)] px-3 py-1.5 text-[11px] tracking-[1px] text-foreground-bright hover:bg-[var(--ac-22)] disabled:opacity-40"
          >
            RUN ▸
          </button>
        )}
      </div>
    </div>
  );
}
