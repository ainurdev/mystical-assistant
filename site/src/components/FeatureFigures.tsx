/**
 * Drawn figures for the two features a screenshot can't carry.
 *
 * A capture of the session rail is a picture of *a* moment — it can't show five
 * states at once, and next to the other rail shot it just reads as "another dark
 * panel". A capture of the Accounts tab shows settings, not what happens when a
 * limit lands. So these two are drawn: same facts, arranged so the claim is the
 * picture.
 *
 * Kept to the page's two hues — amber is the state that wants you, everything
 * else is mint or ink — and to its furniture (mono labels, hairline rows). They
 * sit inside the same `.frame` the screenshots do.
 */

/** The five states a session row can be in, plus the ping that finds you when
 *  one of them turns amber. Matches SessionsPanel.tsx's STATUS_VIEW. */
export function StateLedger() {
  const rows: { state: string; title: string; note: string; tone: "work" | "wait" | "done" | "idle" }[] = [
    { state: "WORK", title: "Add rate limiting to the public API", note: "editing src/limiter.ts", tone: "work" },
    { state: "WAIT", title: "Fix the flaky checkout test", note: "awaiting your approval", tone: "wait" },
    { state: "LIVE", title: "Port the settings modal to the new tokens", note: "open in VS Code", tone: "work" },
    { state: "DONE", title: "Write the migration for soft deletes", note: "finished, not read yet", tone: "done" },
    { state: "IDLE", title: "Upgrade to Vite 6", note: "4h", tone: "idle" },
  ];
  const ink = {
    work: "var(--accent)",
    wait: "var(--warn)",
    done: "var(--ink)",
    idle: "var(--ink-faint)",
  } as const;

  return (
    <div className="p-4 font-mono text-[0.72rem] sm:p-6">
      <div className="flex items-baseline justify-between border-b border-[var(--line)] pb-3">
        <span className="label">Sessions</span>
        <span className="label">One list, every state</span>
      </div>

      <ul className="mt-1">
        {rows.map((r) => {
          const c = ink[r.tone];
          const on = r.tone === "wait";
          return (
            <li
              key={r.state}
              className="flex items-center gap-3 border-b border-[var(--line)] py-3 last:border-b-0"
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${on ? "pulse" : ""}`}
                style={{ background: c, opacity: r.tone === "idle" ? 0.6 : 1 }}
              />
              <span
                className="w-[3.2rem] shrink-0 text-[0.62rem] tracking-[0.18em]"
                style={{ color: c }}
              >
                {r.state}
              </span>
              <span
                className="min-w-0 flex-1 truncate"
                style={{ color: on ? "var(--ink)" : "var(--ink-2)" }}
              >
                {r.title}
              </span>
              <span
                className="hidden shrink-0 text-[0.66rem] sm:block"
                style={{ color: on ? "var(--warn)" : "var(--ink-faint)" }}
              >
                {r.note}
              </span>
            </li>
          );
        })}
      </ul>

      {/* The half that isn't on screen: the same amber row, pushed to your phone. */}
      <div className="mt-4 flex items-start gap-3 border-t border-[var(--line)] pt-4">
        <span className="label shrink-0 pt-0.5">Telegram</span>
        <span className="text-[0.72rem] leading-relaxed text-[var(--ink-2)]">
          <span className="text-[var(--warn)]">Claude needs your approval</span> — Fix the flaky
          checkout test
        </span>
      </div>
    </div>
  );
}

/** What a usage limit actually triggers: park first, then the rungs in
 *  bridge/ladder.py, with bridge/limits.py's backoff underneath. */
export function LimitLadder() {
  const rungs: { n: string; what: string; detail: string; when: string }[] = [
    { n: "01", what: "Another account of yours", detail: "signed in beside the first, quota left", when: "resumes this session" },
    { n: "02", what: "A free agent", detail: "a different provider entirely", when: "carries on in a fresh one" },
    { n: "03", what: "The reset itself", detail: "the real time, off the usage endpoint", when: "resumes at 16:20" },
  ];

  return (
    <div className="p-4 font-mono text-[0.72rem] sm:p-6">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-[var(--line)] pb-3">
        <span className="text-[0.66rem] tracking-[0.18em] text-[var(--warn)]">USAGE LIMIT</span>
        <span className="text-[var(--ink-2)]">turn parked, context kept</span>
      </div>

      <ol className="mt-1">
        {rungs.map((r) => (
          <li key={r.n} className="border-b border-[var(--line)] py-3">
            <div className="flex items-baseline gap-3">
              <span className="shrink-0 text-[0.62rem] text-[var(--ink-faint)]">{r.n}</span>
              <span className="min-w-0 flex-1 text-[var(--ink)]">{r.what}</span>
              <span className="shrink-0 text-[0.66rem] text-[var(--accent)]">{r.when}</span>
            </div>
            <p className="mt-1 pl-[1.9rem] text-[0.66rem] text-[var(--ink-faint)]">{r.detail}</p>
          </li>
        ))}
      </ol>

      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
        <span className="label shrink-0">Server error</span>
        <span className="text-[0.66rem] text-[var(--ink-muted)]">
          now · 1m · 5m · 10m · 15m · 30m, then it gives up
        </span>
      </div>
      <p className="mt-3 text-[0.66rem] text-[var(--ink-faint)]">
        Per session or as the default: ask first, switch on its own, or only ever wait.
      </p>
    </div>
  );
}
