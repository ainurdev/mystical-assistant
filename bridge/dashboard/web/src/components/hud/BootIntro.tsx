import { useEffect, useState } from "react";

const LINES: { label: string; status: string; color: string }[] = [
  { label: "ESTABLISHING BRIDGE", status: "OK", color: "var(--success)" },
  { label: "CLAUDE CODE RUNTIME", status: "OK", color: "var(--success)" },
  { label: "SURFACES · TG / MA / VSCODE", status: "OK", color: "var(--success)" },
  { label: "CONVERSATION STORE", status: "SYNCED", color: "var(--primary)" },
  { label: "AUTH · REUSE CLAUDE LOGIN", status: "OK", color: "var(--success)" },
];

export function BootIntro({ onDone }: { onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const fade = setTimeout(() => setLeaving(true), 3050);
    const done = setTimeout(onDone, 3550);
    const skip = () => onDone();
    window.addEventListener("keydown", skip);
    return () => {
      clearTimeout(fade);
      clearTimeout(done);
      window.removeEventListener("keydown", skip);
    };
  }, [onDone]);

  return (
    <div
      onClick={onDone}
      className="fixed inset-0 z-[95] flex cursor-pointer flex-col items-center justify-center gap-[26px] bg-[#060a0a] transition-opacity duration-500"
      style={{ opacity: leaving ? 0 : 1 }}
    >
      <div className="crt" style={{ zIndex: 1 }} />

      {/* emblem */}
      <svg
        viewBox="0 0 100 100"
        className="h-[150px] w-[150px] overflow-visible"
        style={{ animation: "intropop .9s cubic-bezier(.2,.8,.2,1) both" }}
      >
        <circle
          cx="50" cy="50" r="44" fill="none" strokeWidth="1.4" strokeDasharray="8 12"
          className="stroke-primary"
          style={{ transformOrigin: "50px 50px", animation: "introspin 9s linear infinite" }}
        />
        <circle
          cx="50" cy="50" r="40" fill="none" strokeWidth="1" strokeDasharray="280" strokeDashoffset="280"
          className="[stroke:var(--border-bright)]"
          style={{ animation: "introdraw 1.1s ease both .3s" }}
        />
        <circle
          cx="50" cy="50" r="33" fill="none" strokeWidth="1"
          className="[stroke:var(--border)]"
          style={{ transformOrigin: "50px 50px", animation: "introspinr 14s linear infinite" }}
        />
        <rect
          x="30" y="30" width="40" height="40" fill="none" strokeWidth="1.6"
          className="stroke-primary"
          style={{ transformOrigin: "50px 50px", animation: "introdiamond .7s cubic-bezier(.2,.8,.2,1) both .5s" }}
        />
        <rect
          x="41" y="41" width="18" height="18"
          className="fill-violet"
          style={{
            transformOrigin: "50px 50px",
            animation: "introdiamond .6s ease both .8s",
            filter: "drop-shadow(0 0 6px rgba(185,166,255,.7))",
          }}
        />
        {[
          { x1: 50, y1: 2, x2: 50, y2: 11, d: "1s" },
          { x1: 50, y1: 89, x2: 50, y2: 98, d: "1.1s" },
          { x1: 2, y1: 50, x2: 11, y2: 50, d: "1.05s" },
          { x1: 89, y1: 50, x2: 98, y2: 50, d: "1.15s" },
        ].map((t, i) => (
          <line
            key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} strokeWidth="1.4"
            className="stroke-primary"
            style={{ animation: `tickfade .4s ease both ${t.d}` }}
          />
        ))}
      </svg>

      {/* wordmark */}
      <div className="z-[2] text-center" style={{ animation: "tickfade .5s ease both .9s" }}>
        <div
          className="glow text-[34px] tracking-[10px] text-foreground-bright"
          style={{ animation: "wordflick 1.4s steps(1) both .9s" }}
        >
          MYSTICAL//ASSISTANT
        </div>
        <div className="mt-2 text-[11px] tracking-[6px] text-muted-2">REMOTE DEV BRIDGE · CLAUDE CODE</div>
      </div>

      {/* boot log */}
      <div className="z-[2] mt-1.5 w-[520px] max-w-[88vw] font-mono text-[11.5px] leading-[1.9] text-muted-foreground">
        {LINES.map((b, i) => (
          <div
            key={i}
            className="flex justify-between"
            style={{ animation: `bootline .4s ease both ${700 + i * 360}ms` }}
          >
            <span>
              <span className="text-primary">›</span> {b.label}
            </span>
            <span className="tracking-[1px]" style={{ color: b.color }}>
              {b.status}
            </span>
          </div>
        ))}
        <div className="mt-3.5 h-[3px] overflow-hidden bg-[var(--ac-12)]">
          <div
            className="h-full w-0"
            style={{
              background: "linear-gradient(90deg,var(--primary),var(--violet))",
              animation: "barfill 2.4s cubic-bezier(.4,0,.2,1) both .6s",
            }}
          />
        </div>
        <div
          className="mt-2.5 flex justify-between text-[10px] tracking-[2px] text-muted-2"
          style={{ animation: "tickfade .5s ease both 1.4s" }}
        >
          <span>
            INITIALIZING WORKSPACE
            <span style={{ animation: "caret 1s steps(1) infinite" }}>_</span>
          </span>
          <span>CLICK TO SKIP</span>
        </div>
      </div>
    </div>
  );
}
