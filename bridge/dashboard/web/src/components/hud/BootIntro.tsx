import { useEffect, useState } from "react";

const LINES = [
  "▸ INIT BRIDGE LINK ............. OK",
  "▸ MOUNT WORKSPACE .............. OK",
  "▸ SYNC SESSIONS ................ OK",
  "▸ READY",
];

export function BootIntro({ onDone }: { onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const fade = setTimeout(() => setLeaving(true), 1900);
    const done = setTimeout(onDone, 2250);
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
      className="fixed inset-0 z-[100] flex cursor-pointer flex-col items-center justify-center bg-[#060a0a] transition-opacity duration-300"
      style={{ opacity: leaving ? 0 : 1, animation: "flicker .8s ease both" }}
    >
      <div className="crt" />
      <div className="glow text-[34px] tracking-[6px] text-primary">MYSTICAL//ASSISTANT</div>
      <div className="mt-2 text-[11px] tracking-[4px] text-muted-foreground">REMOTE DEV BRIDGE</div>
      <div
        className="mt-4 h-px w-[280px] origin-left"
        style={{
          background: "linear-gradient(90deg,var(--primary),transparent)",
          animation: "drawline .7s ease both .15s",
        }}
      />
      <div className="mt-5 flex flex-col gap-1 font-mono text-[12px]">
        {LINES.map((l, i) => (
          <div key={i} className="text-success" style={{ animation: `mfadeup .4s ease both ${0.4 + i * 0.35}s` }}>
            {l}
          </div>
        ))}
      </div>
      <div className="mt-5 flex items-center gap-2 text-[11px] text-primary">
        <span>~ ❯</span>
        <span className="inline-block h-3.5 w-[8px] bg-primary" style={{ animation: "caret 1.05s steps(1) infinite" }} />
      </div>
      <div className="absolute bottom-8 text-[10px] tracking-[2px] text-muted-2">PRESS ANY KEY TO SKIP</div>
    </div>
  );
}
