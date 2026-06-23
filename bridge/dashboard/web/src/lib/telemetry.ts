import { useEffect, useRef, useState } from "react";

const p2 = (n: number) => String(n).padStart(2, "0");

export function poly(arr: number[], w: number, h: number, pad: number): string {
  if (!arr.length) return "";
  const min = Math.min(...arr), max = Math.max(...arr), rng = max - min || 1, n = arr.length;
  return arr
    .map(
      (v, i) =>
        `${((i / (n - 1)) * w).toFixed(1)},${(pad + (1 - (v - min) / rng) * (h - 2 * pad)).toFixed(1)}`,
    )
    .join(" ");
}

export function wavePoly(arr: number[], w: number, h: number): string {
  if (!arr.length) return "";
  const n = arr.length, mid = h / 2;
  return arr
    .map((v, i) => `${((i / (n - 1)) * w).toFixed(1)},${(mid - v * (h / 2 - 3)).toFixed(1)}`)
    .join(" ");
}

export function avg(arr: number[]): number {
  return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
}

const seed = (n: number, base: number, amp: number) =>
  Array.from({ length: n }, (_, i) => base + Math.sin(i / 3) * amp);

export interface Telemetry {
  clock: string;
  date: string;
  uptime: string;
  sparkA: number[];
  sparkB: number[];
  wave: number[];
}

/** 1s-tick telemetry buffers driven by real signals (running state, tool/event
 *  deltas). Jitter is cosmetic smoothing; the trend is the real signal. */
export function useTelemetry({
  running,
  toolCount,
  eventCount,
}: {
  running: boolean;
  toolCount: number;
  eventCount: number;
}): Telemetry {
  const [t, setT] = useState<Telemetry>(() => ({
    clock: "--:--:--",
    date: "",
    uptime: "00:00",
    sparkA: seed(40, 30, 8),
    sparkB: seed(40, 20, 6),
    wave: seed(52, 0, 0),
  }));
  const mount = useRef(Date.now());
  const last = useRef({ toolCount, eventCount });

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      const clock = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
      const date = d
        .toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
        .toUpperCase();
      const upSec = Math.floor((Date.now() - mount.current) / 1000);
      const uptime = `${p2(Math.floor(upSec / 60))}:${p2(upSec % 60)}`;
      const dTool = Math.max(0, toolCount - last.current.toolCount);
      const dEvent = Math.max(0, eventCount - last.current.eventCount);
      last.current = { toolCount, eventCount };
      setT((s) => {
        const aTarget = running ? 78 + Math.random() * 22 : 12 + Math.random() * 8;
        const a = s.sparkA[s.sparkA.length - 1] * 0.6 + aTarget * 0.4;
        const b = Math.min(100, dTool * 40 + (running ? 25 : 5) + Math.random() * 8);
        const wv = dEvent > 0 ? (Math.random() - 0.5) * 2 : (Math.random() - 0.5) * 0.35;
        return {
          clock,
          date,
          uptime,
          sparkA: [...s.sparkA.slice(1), a],
          sparkB: [...s.sparkB.slice(1), b],
          wave: [...s.wave.slice(1), wv],
        };
      });
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [running, toolCount, eventCount]);

  return t;
}
