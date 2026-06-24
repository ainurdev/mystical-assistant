import { useEffect, useRef, useState } from "react";
import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import { api, type ShellSnapshot } from "../lib/api";

/** Ad-hoc remote shell: run a command in the active project and watch output
 *  stream in. Same trust boundary as the rest of the panel. */
function ShellPage() {
  const [snap, setSnap] = useState<ShellSnapshot | null>(null);
  const [cmd, setCmd] = useState("");
  const cursor = useRef(0);
  const lines = useRef<{ seq: number; line: string }[]>([]);
  const scrollRef = useRef<HTMLPreElement>(null);
  const running = snap?.running ?? false;

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const s = await api.getShell(cursor.current);
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
    const id = setInterval(tick, running ? 1000 : 3000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [running]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [snap]);

  async function run() {
    const c = cmd.trim();
    if (!c || running) return;
    setCmd("");
    try {
      await api.runShell(c);
    } catch {
      /* surfaced via snapshot */
    }
  }

  return (
    <div className="space-y-3 pb-40">
      <div className="flex items-center gap-2 px-1 text-xs">
        <span
          className="h-2 w-2 rounded-full"
          style={{ background: running ? "#34d399" : "var(--tg-hint)" }}
        />
        <span className="font-mono text-[var(--tg-hint)]">
          {snap?.dir ?? "—"}
          {snap && snap.status !== "idle" && !running ? ` · ${snap.status}` : ""}
          {snap?.code != null && !running ? ` (${snap.code})` : ""}
        </span>
      </div>

      <pre
        ref={scrollRef}
        className="h-80 overflow-auto whitespace-pre-wrap rounded-xl bg-black/40 p-3 font-mono text-xs leading-relaxed"
      >
        {lines.current.length === 0
          ? "run a command to see its output"
          : lines.current.map((l) => l.line).join("\n")}
      </pre>

      <div className="flex items-center gap-2">
        <span className="font-mono text-sm text-[var(--brand-soft)]">$</span>
        <input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void run();
            }
          }}
          placeholder="npm test · git status · ls -la"
          className="flex-1 rounded-lg bg-[var(--tg-secondary-bg)] px-3 py-2 font-mono text-sm outline-none"
        />
        {running ? (
          <button
            onClick={() => void api.killShell()}
            className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300 active:opacity-70"
          >
            Kill
          </button>
        ) : (
          <button
            onClick={() => void run()}
            disabled={!cmd.trim()}
            className="rounded-lg bg-[var(--tg-button)] px-4 py-2 text-sm text-[var(--tg-button-text)] active:opacity-70 disabled:opacity-40"
          >
            Run
          </button>
        )}
      </div>
    </div>
  );
}

export const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/shell",
  component: ShellPage,
});
