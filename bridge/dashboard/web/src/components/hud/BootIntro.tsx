import { useState, useEffect, useRef } from "react";
import { themeCanvas, themeFilter, type ThemeKey } from "../../lib/theme";

const bootLines: { label: string; status: string; statusColor: string }[] = [
  { label: "ESTABLISHING BRIDGE", status: "OK", statusColor: "var(--ok)" },
  { label: "CLAUDE CODE RUNTIME", status: "OK", statusColor: "var(--ok)" },
  { label: "SURFACES · TG / MA / VSCODE", status: "OK", statusColor: "var(--ok)" },
  { label: "CONVERSATION STORE", status: "SYNCED", statusColor: "var(--acc)" },
  { label: "AUTH · REUSE CLAUDE LOGIN", status: "OK", statusColor: "var(--ok)" },
];

export function BootIntro(props: { onReveal: () => void; onDone: () => void; theme: ThemeKey; scanlines: boolean }) {
  const { onReveal, onDone, theme, scanlines } = props;
  const [fade, setFade] = useState(false);

  // Keep the latest callbacks in a ref so the auto-exit timers below can run
  // once on mount. App re-renders every second (the telemetry clock), handing
  // BootIntro fresh callback identities each time — depending on them here would
  // clear+reset the timers before they ever fire, so the intro never auto-exits.
  const cb = useRef({ onReveal, onDone });
  cb.current = { onReveal, onDone };

  useEffect(() => {
    const t1 = window.setTimeout(() => {
      setFade(true);
      cb.current.onReveal();
    }, 3600);
    const t2 = window.setTimeout(() => {
      cb.current.onDone();
    }, 4250);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, []);

  const dismissBoot = () => {
    setFade(true);
    onReveal();
    window.setTimeout(() => onDone(), 650);
  };

  return (
    <div
      onClick={dismissBoot}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 95,
        background: themeCanvas(theme),
        filter: themeFilter(theme),
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "26px",
        cursor: "pointer",
        overflow: "hidden",
        transformOrigin: "center",
        animation: fade ? "crtoff .62s cubic-bezier(.7,0,.3,1) forwards" : "none",
      }}
    >
      {scanlines && <div className="crt" style={{ zIndex: 4 }}></div>}

      {/* animated field */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 0,
          pointerEvents: "none",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: "-25%",
            right: "-25%",
            bottom: "-12%",
            height: "72%",
            backgroundImage:
              "linear-gradient(color-mix(in srgb, var(--acc) 15%, transparent) 1px,transparent 1px),linear-gradient(90deg,color-mix(in srgb, var(--acc) 15%, transparent) 1px,transparent 1px)",
            backgroundSize: "46px 46px",
            transform: "perspective(440px) rotateX(64deg)",
            transformOrigin: "bottom center",
            animation: "introgrid 2.6s linear infinite",
            WebkitMaskImage: "linear-gradient(to top,#000 8%,transparent 80%)",
            maskImage: "linear-gradient(to top,#000 8%,transparent 80%)",
          }}
        ></div>
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: "780px",
            height: "780px",
            margin: "-390px 0 0 -390px",
            background:
              "conic-gradient(from 0deg,color-mix(in srgb, var(--acc) 12%, transparent),transparent 28%,color-mix(in srgb, var(--purple) 12%, transparent) 54%,transparent 78%,color-mix(in srgb, var(--acc) 12%, transparent))",
            borderRadius: "50%",
            animation: "auraspin 20s linear infinite",
            filter: "blur(3px)",
          }}
        ></div>
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: "220px",
            height: "220px",
            margin: "-110px 0 0 -110px",
            border: "1px solid color-mix(in srgb, var(--acc) 35%, transparent)",
            borderRadius: "50%",
            animation: "radar 3.4s ease-out infinite",
          }}
        ></div>
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: "220px",
            height: "220px",
            margin: "-110px 0 0 -110px",
            border: "1px solid color-mix(in srgb, var(--purple) 30%, transparent)",
            borderRadius: "50%",
            animation: "radar 3.4s ease-out infinite 1.7s",
          }}
        ></div>
        <div
          style={{
            position: "absolute",
            left: "18%",
            top: "26%",
            width: "3px",
            height: "3px",
            borderRadius: "50%",
            background: "var(--acc)",
            boxShadow: "0 0 6px var(--acc)",
            animation: "drift 5s ease-in-out infinite,twinkle 3s ease-in-out infinite",
          }}
        ></div>
        <div
          style={{
            position: "absolute",
            left: "82%",
            top: "32%",
            width: "2px",
            height: "2px",
            borderRadius: "50%",
            background: "var(--purple)",
            boxShadow: "0 0 6px var(--purple)",
            animation: "drift 6.5s ease-in-out infinite .6s,twinkle 4s ease-in-out infinite",
          }}
        ></div>
        <div
          style={{
            position: "absolute",
            left: "74%",
            top: "68%",
            width: "3px",
            height: "3px",
            borderRadius: "50%",
            background: "var(--acc)",
            boxShadow: "0 0 6px var(--acc)",
            animation: "drift 5.6s ease-in-out infinite 1.1s,twinkle 3.4s ease-in-out infinite",
          }}
        ></div>
        <div
          style={{
            position: "absolute",
            left: "24%",
            top: "72%",
            width: "2px",
            height: "2px",
            borderRadius: "50%",
            background: "var(--ok)",
            boxShadow: "0 0 6px var(--ok)",
            animation: "drift 7s ease-in-out infinite .3s,twinkle 4.6s ease-in-out infinite",
          }}
        ></div>
        <div
          style={{
            position: "absolute",
            left: "12%",
            top: "52%",
            width: "2px",
            height: "2px",
            borderRadius: "50%",
            background: "var(--acc)",
            boxShadow: "0 0 5px var(--acc)",
            animation: "drift 6s ease-in-out infinite .9s,twinkle 3.8s ease-in-out infinite",
          }}
        ></div>
        <div
          style={{
            position: "absolute",
            left: "88%",
            top: "54%",
            width: "2px",
            height: "2px",
            borderRadius: "50%",
            background: "var(--purple)",
            boxShadow: "0 0 5px var(--purple)",
            animation: "drift 5.4s ease-in-out infinite 1.4s,twinkle 4.2s ease-in-out infinite",
          }}
        ></div>
      </div>

      {/* emblem */}
      <svg
        viewBox="0 0 100 100"
        style={{
          width: "150px",
          height: "150px",
          overflow: "visible",
          position: "relative",
          zIndex: 2,
          animation: "intropop .9s cubic-bezier(.2,.8,.2,1) both",
        }}
      >
        <circle
          cx="50"
          cy="50"
          r="44"
          fill="none"
          stroke="var(--acc)"
          strokeWidth="1.4"
          strokeDasharray="8 12"
          style={{ transformOrigin: "50px 50px", animation: "introspin 9s linear infinite" }}
        />
        <circle
          cx="50"
          cy="50"
          r="40"
          fill="none"
          stroke="color-mix(in srgb, var(--acc) 45%, transparent)"
          strokeWidth="1"
          strokeDasharray="280"
          strokeDashoffset="280"
          style={{ animation: "introdraw 1.1s ease both .3s" }}
        />
        <circle
          cx="50"
          cy="50"
          r="33"
          fill="none"
          stroke="color-mix(in srgb, var(--acc) 18%, transparent)"
          strokeWidth="1"
          style={{ transformOrigin: "50px 50px", animation: "introspinr 14s linear infinite" }}
        />
        <rect
          x="30"
          y="30"
          width="40"
          height="40"
          fill="none"
          stroke="var(--acc)"
          strokeWidth="1.6"
          style={{
            transformOrigin: "50px 50px",
            animation: "introdiamond .7s cubic-bezier(.2,.8,.2,1) both .5s",
          }}
        />
        <rect
          x="41"
          y="41"
          width="18"
          height="18"
          fill="var(--purple)"
          style={{
            transformOrigin: "50px 50px",
            animation: "introdiamond .6s ease both .8s",
            filter: "drop-shadow(0 0 6px color-mix(in srgb, var(--purple) 70%, transparent))",
          }}
        />
        <line
          x1="50"
          y1="2"
          x2="50"
          y2="11"
          stroke="var(--acc)"
          strokeWidth="1.4"
          style={{ animation: "tickfade .4s ease both 1s" }}
        />
        <line
          x1="50"
          y1="89"
          x2="50"
          y2="98"
          stroke="var(--acc)"
          strokeWidth="1.4"
          style={{ animation: "tickfade .4s ease both 1.1s" }}
        />
        <line
          x1="2"
          y1="50"
          x2="11"
          y2="50"
          stroke="var(--acc)"
          strokeWidth="1.4"
          style={{ animation: "tickfade .4s ease both 1.05s" }}
        />
        <line
          x1="89"
          y1="50"
          x2="98"
          y2="50"
          stroke="var(--acc)"
          strokeWidth="1.4"
          style={{ animation: "tickfade .4s ease both 1.15s" }}
        />
      </svg>

      {/* wordmark */}
      <div
        style={{
          textAlign: "center",
          animation: "tickfade .5s ease both .9s",
          position: "relative",
          zIndex: 2,
        }}
      >
        <div
          className="glow"
          style={{
            fontSize: "var(--t34)",
            letterSpacing: "10px",
            color: "var(--txb)",
            animation: "wordflick 1.4s steps(1) both .9s",
          }}
        >
          MYSTICAL//ASSISTANT
        </div>
        <div style={{ fontSize: "var(--t11)", letterSpacing: "6px", color: "var(--txl)", marginTop: "8px" }}>
          REMOTE DEV BRIDGE · CLAUDE CODE
        </div>
      </div>

      {/* boot log */}
      <div
        style={{
          width: "520px",
          maxWidth: "88vw",
          zIndex: 2,
          position: "relative",
          marginTop: "6px",
          fontFamily: "'JetBrains Mono',monospace",
          fontSize: "var(--t115)",
          lineHeight: 1.9,
          color: "var(--txd)",
        }}
      >
        {bootLines.map((b, i) => (
          <div
            key={b.label}
            style={{
              display: "flex",
              justifyContent: "space-between",
              animation: "bootline .4s ease both",
              animationDelay: `${700 + i * 360}ms`,
            }}
          >
            <span>
              <span style={{ color: "var(--acc)" }}>›</span> {b.label}
            </span>
            <span style={{ color: b.statusColor, letterSpacing: "1px" }}>{b.status}</span>
          </div>
        ))}
        <div
          style={{
            height: "3px",
            background: "color-mix(in srgb, var(--acc) 12%, transparent)",
            marginTop: "14px",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              background: "linear-gradient(90deg,var(--acc),var(--purple))",
              width: 0,
              animation: "barfill 2.4s cubic-bezier(.4,0,.2,1) both .6s",
            }}
          ></div>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: "9px",
            fontSize: "var(--t10)",
            letterSpacing: "2px",
            color: "var(--txl)",
            animation: "tickfade .5s ease both 1.4s",
          }}
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
