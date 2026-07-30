import { Zap } from "lucide-react";

/**
 * A composed illustration of the dashboard's main view: projects down the side,
 * every live session across the machine in the middle, the active chat below.
 * Hand-built rather than a screenshot so it stays sharp at any width — the
 * tradeoff is that it can't notice when the real UI changes shape.
 */
export function HeroMock() {
  return (
    <div className="relative mx-auto w-full max-w-[52rem]">
      <div
        className="panel panel-lit scanlines overflow-hidden shadow-[0_30px_90px_-20px_rgb(0_0_0/0.9)]"
        role="img"
        aria-label="The dashboard: a project sidebar, a Running Now list showing a VS Code session, a terminal session, and a third parked on a usage limit that will resume at 16:20, with the active session's chat below."
      >
        <TitleBar />
        <div className="grid grid-cols-[1fr] sm:grid-cols-[10.5rem_1fr]">
          <Sidebar />
          <Main />
        </div>
      </div>
    </div>
  );
}

function TitleBar() {
  return (
    <div className="flex items-center gap-2 border-b border-[var(--border-soft)] bg-[var(--panel2)]/70 px-3 py-2">
      <div className="flex gap-1.5">
        {["var(--err)", "var(--warn)", "var(--ok)"].map((c) => (
          <span key={c} className="h-2 w-2 rounded-full opacity-70" style={{ background: c }} />
        ))}
      </div>
      <div className="ml-2 font-[var(--mono)] text-[0.68rem] tracking-[0.18em] text-[var(--txd)] uppercase">
        mystical//assistant
      </div>
      <div className="ml-auto flex items-center gap-1.5 font-mono text-[0.62rem] text-[var(--txd)]">
        <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-[var(--ok)]" />
        127.0.0.1:8790
      </div>
    </div>
  );
}

function Sidebar() {
  return (
    <aside className="hidden border-r border-[var(--border-soft)] bg-[var(--panel3)]/50 p-3 sm:block">
      <Label>Projects</Label>
      <Project name="mystical-assistant" sessions={9} live active />
      <Project name="portfolio" sessions={6} live />
      <Project name="api-gateway" sessions={5} live />
      <Project name="scratch" sessions={4} />

      <div className="rule my-3.5" />

      <Label>Usage</Label>
      <Meter label="5h" pct={41} color="var(--acc)" />
      <Meter label="7d" pct={68} color="var(--purple)" />
    </aside>
  );
}

function Main() {
  return (
    <div className="p-3 sm:p-4">
      {/* the "what's running where" panel — the whole pitch, up top */}
      <div className="mb-3 flex items-baseline gap-2">
        <Label>Running now</Label>
        <span className="rounded-full border border-[color-mix(in_srgb,var(--ok)_30%,transparent)] bg-[color-mix(in_srgb,var(--ok)_10%,transparent)] px-1.5 font-mono text-[0.55rem] text-[var(--ok)]">
          2
        </span>
        <span className="ml-auto font-mono text-[0.55rem] tracking-wider text-[var(--warn)]">
          1 parked
        </span>
      </div>

      <div className="space-y-1.5">
        <Run repo="mystical-assistant" branch="master" where="VS CODE" whereColor="var(--acc)" age="4m" what="editing auth/callback.ts" />
        <Run repo="portfolio" branch="feat/hero" where="TERMINAL" whereColor="var(--ok)" age="12m" what="running the test suite" />
        {/* the parked row demonstrates the headline promise rather than asserting it */}
        <Run repo="api-gateway" branch="main" where="PARKED" whereColor="var(--warn)" age="5h limit" what="resumes 16:20, keeps its context" waiting />
      </div>

      {/* the active session's chat, below */}
      <div className="mt-4 rounded-lg border border-[var(--border-soft)] bg-[var(--panel3)]/40 p-2.5 font-mono text-[0.68rem] leading-relaxed sm:p-3">
        <div className="mb-2 flex justify-end">
          <span className="max-w-[85%] rounded-lg rounded-br-sm border border-[color-mix(in_srgb,var(--purple)_22%,transparent)] bg-[color-mix(in_srgb,var(--purple)_9%,transparent)] px-2.5 py-1.5 text-[var(--txh)]">
            the login redirect drops the ?next param — can you find it?
          </span>
        </div>
        <p className="text-[var(--tx)]">
          Found it. <span className="text-[var(--acc)]">callback.ts:44</span> rebuilds the URL from
          scratch, so <span className="text-[var(--acc)]">?next</span> never survives the round
          trip. Two lines to fix
          <span className="caret" />
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[color-mix(in_srgb,var(--warn)_28%,transparent)] bg-[color-mix(in_srgb,var(--warn)_8%,transparent)] px-2.5 py-1 text-[0.62rem] text-[var(--warn)]">
            <Zap size={10} aria-hidden />2 agents working
          </span>
          <span className="text-[0.6rem] text-[var(--txd)]">opus · 34s · $0.11</span>
        </div>
      </div>
    </div>
  );
}

/* ── small parts ───────────────────────────────────────────────────────── */

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-[var(--mono)] text-[0.55rem] tracking-[0.2em] text-[var(--txd)] uppercase">
      {children}
    </div>
  );
}

function Project({
  name,
  sessions,
  live,
  active,
}: {
  name: string;
  sessions: number;
  live?: boolean;
  active?: boolean;
}) {
  return (
    <div
      className={`mt-1 flex items-center gap-1.5 rounded px-1.5 py-1 text-[0.62rem] ${
        active ? "bg-[color-mix(in_srgb,var(--acc)_10%,transparent)] text-[var(--txb)]" : "text-[var(--txm)]"
      }`}
    >
      <span
        className={`h-1 w-1 shrink-0 rounded-full ${live ? "pulse-dot bg-[var(--acc)]" : "bg-[var(--txl)]"}`}
      />
      <span className="truncate">{name}</span>
      <span className="ml-auto font-mono text-[0.55rem] text-[var(--txd)]">{sessions}</span>
    </div>
  );
}

function Run({
  repo,
  branch,
  where,
  whereColor,
  age,
  what,
  waiting,
}: {
  repo: string;
  branch: string;
  where: string;
  whereColor: string;
  age: string;
  what: string;
  waiting?: boolean;
}) {
  return (
    <div className="rounded-md border border-[var(--border-soft)] bg-[var(--panel3)]/50 px-2.5 py-1.5">
      <div className="flex items-center gap-2">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${waiting ? "pulse-dot" : ""}`}
          style={{ background: waiting ? "var(--warn)" : "var(--ok)" }}
        />
        <span className="truncate text-[0.7rem] text-[var(--txb)]">{repo}</span>
        <span className="truncate font-mono text-[0.6rem] text-[var(--txd)]">{branch}</span>
        <span
          className="ml-auto shrink-0 rounded border px-1.5 font-mono text-[0.52rem] tracking-wider"
          style={{
            color: whereColor,
            borderColor: `color-mix(in srgb, ${whereColor} 30%, transparent)`,
            background: `color-mix(in srgb, ${whereColor} 8%, transparent)`,
          }}
        >
          {where}
        </span>
      </div>
      <div className="mt-0.5 flex items-baseline gap-2 pl-3.5 font-mono text-[0.58rem] text-[var(--txd)]">
        <span>{age}</span>
        <span className={waiting ? "text-[var(--warn)]" : ""}>{what}</span>
      </div>
    </div>
  );
}

function Meter({ label, pct, color }: { label: string; pct: number; color: string }) {
  return (
    <div className="mt-1.5 flex items-center gap-1.5">
      <span className="w-4 shrink-0 font-mono text-[0.55rem] text-[var(--txd)]">{label}</span>
      <span className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--panel)]">
        <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </span>
    </div>
  );
}
