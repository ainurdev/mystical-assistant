import { useState, useEffect } from "react";

const INTEL: { tag: string; text: string }[] = [
  { tag: "FACT", text: "The first version-control system, SCCS, shipped in 1972 — over 50 years of diffs." },
  { tag: "HISTORY", text: "Git was written by Linus Torvalds in about ten days in 2005, after BitKeeper revoked its free license." },
  { tag: "LORE", text: "The first computer \"bug\" was a literal moth, found taped into the Harvard Mark II logbook in 1947." },
  { tag: "FACT", text: "Claude Shannon's 1948 paper founded information theory and popularized the word \"bit\"." },
  { tag: "LORE", text: "\"git\" is British slang for an unpleasant person — Torvalds joked he names projects after himself." },
  { tag: "TRIVIA", text: "The QWERTY layout dates to the 1870s, arranged partly to stop mechanical typebars from jamming." },
];

const intelColor: Record<string, string> = {
  FACT: "#8fd9a8",
  HISTORY: "#b9a6ff",
  LORE: "#e3c279",
  TRIVIA: "#6fb5ff",
};

export function IntelPanel() {
  const [index, setIndex] = useState(0);
  const [nextHover, setNextHover] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setIndex((i) => (i + 1) % INTEL.length), 7000);
    return () => clearInterval(id);
  }, []);

  const current = INTEL[index];
  const total = INTEL.length;

  return (
    <div
      className="panel"
      style={{
        border: "1px solid rgba(127,233,216,.16)",
        background: "rgba(9,16,16,.5)",
        animation: "enterSkew .55s cubic-bezier(.2,.8,.2,1) both .24s",
        flex: "none",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
        }}
      >
        <span style={{ fontSize: "10.5px", letterSpacing: "2.5px", color: "#3c544f" }}>INTEL</span>
        <span style={{ fontSize: "10.5px", letterSpacing: "2.5px", color: "#7fe9d8" }}>FIELD NOTES</span>
      </div>
      <div
        style={{
          height: "1px",
          background: "linear-gradient(90deg,#7fe9d8,rgba(127,233,216,.05))",
          transformOrigin: "left",
          animation: "drawline .7s ease both .28s",
        }}
      />
      <div style={{ padding: "10px 12px 11px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span
            style={{
              fontSize: "8.5px",
              letterSpacing: "1.5px",
              color: "#0b1414",
              background: intelColor[current.tag],
              padding: "2px 7px",
            }}
          >
            {current.tag}
          </span>
          <span style={{ fontSize: "8.5px", letterSpacing: "1px", color: "#3c544f" }}>
            {index + 1} / {total}
          </span>
          <div style={{ display: "flex", gap: "3px", marginLeft: "auto" }}>
            {INTEL.map((_, i) => (
              <span
                key={i}
                style={{
                  width: "10px",
                  height: "3px",
                  background: i === index ? "#7fe9d8" : "rgba(127,233,216,.18)",
                }}
              />
            ))}
          </div>
          <button
            onClick={() => setIndex((i) => (i + 1) % INTEL.length)}
            onMouseEnter={() => setNextHover(true)}
            onMouseLeave={() => setNextHover(false)}
            style={{
              appearance: "none",
              cursor: "pointer",
              border: "1px solid rgba(127,233,216,.25)",
              background: nextHover ? "rgba(127,233,216,.08)" : "transparent",
              color: "#9fc7c0",
              fontFamily: "inherit",
              fontSize: "9px",
              letterSpacing: "1.5px",
              padding: "3px 9px",
            }}
          >
            NEXT ▸
          </button>
        </div>
        <div
          key={index}
          style={{
            minHeight: "54px",
            marginTop: "9px",
            fontSize: "11.5px",
            lineHeight: 1.5,
            color: "#bfe6de",
            animation: `${index % 2 === 0 ? "mfadeup" : "mfadeup2"} .45s ease both`,
          }}
        >
          {current.text}
        </div>
      </div>
    </div>
  );
}
