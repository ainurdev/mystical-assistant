// Ambient widgets for the WORKSPACE panel + strip: host vitals (psutil), weather
// (open-meteo) and a locally-persisted focus timer.
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type HostStats, type Place, type Weather } from "../api";
import { queryClient, rail } from "./queries";

const EMPTY_HOST: HostStats = {
  available: false, host: "host", cpu: 0, mem_used: 0, mem_total: 16, mem_pct: 0,
  net_up: 0, net_down: 0, load: 0, procs: 0, state: "NOMINAL",
};
const EMPTY_WX: Weather = {
  available: false, temp: null, cond: "—", hi: null, lo: null, wind: "—", hum: "—", unit: "C", loc: "—",
};

/** Host vitals (psutil), polled every 5 s while the page shows (lib/queries); a failed read keeps the last. */
export function useHostVitals(): HostStats {
  return useQuery(rail.sysinfo()).data ?? EMPTY_HOST;
}

// A place or unit change answers with the new weather: shown at once.
const setWx = (w: Weather) => queryClient.setQueryData(rail.weather().queryKey, w);

/** Weather (cached server-side), polled every 10 minutes while the page shows (lib/queries);
 *  setPlace moves it to a place the city picker offered, setUnit switches °C/°F. Both persist server-side. */
export function useWeather(): {
  weather: Weather;
  setPlace: (p: Place) => Promise<string | null>;
  setUnit: (unit: string) => Promise<string | null>;
} {
  const wx = useQuery(rail.weather()).data ?? EMPTY_WX;
  const setPlace = useCallback(async (p: Place): Promise<string | null> => {
    try {
      const r = await api.setWeatherPlace(p);
      if (r.error) return r.error;
      setWx(r);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }, []);
  const setUnit = useCallback(async (unit: string): Promise<string | null> => {
    try {
      const r = await api.setWeatherUnit(unit);
      if (r.error) return r.error;
      setWx(r);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }, []);
  return { weather: wx, setPlace, setUnit };
}

export interface Focus {
  h: number; goal: number; pct: number; sessions: number; commits: number; streak: number;
}

interface FocusStore {
  date: string; // YYYY-MM-DD
  seconds: number;
  commits: number;
  history: string[]; // dates with any focus (for the streak)
}

const FOCUS_KEY = "hud-focus";
const FOCUS_GOAL_H = 8;

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadFocus(): FocusStore {
  try {
    const raw = localStorage.getItem(FOCUS_KEY);
    if (raw) {
      const f = JSON.parse(raw) as FocusStore;
      if (f.date === todayStr()) return f;
      // New day: roll over, keeping the history for the streak.
      const hist = Array.from(new Set([...(f.history || []), f.date])).slice(-90);
      return { date: todayStr(), seconds: 0, commits: 0, history: hist };
    }
  } catch {
    /* ignore */
  }
  return { date: todayStr(), seconds: 0, commits: 0, history: [] };
}

function streakFrom(history: string[], hasFocusToday: boolean): number {
  const set = new Set(history);
  let streak = 0;
  const d = new Date();
  if (hasFocusToday) streak = 1;
  // Walk back day by day while each prior day is in history.
  for (let i = 1; i < 90; i++) {
    const day = new Date(d.getTime() - i * 86400000).toISOString().slice(0, 10);
    if (set.has(day)) streak++;
    else break;
  }
  return streak;
}

/**
 * Local focus timer: accumulates active seconds while the dashboard tab is
 * visible, persisted per-day. `sessions` reflects today's session count;
 * `bumpCommit` lets the app record a commit toward the day's tally.
 */
export function useFocus(sessionsToday: number): { focus: Focus; bumpCommit: () => void } {
  const store = useRef<FocusStore>(loadFocus());
  const [, force] = useState(0);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      const s = store.current;
      if (s.date !== todayStr()) {
        const hist = Array.from(new Set([...s.history, s.date])).slice(-90);
        store.current = { date: todayStr(), seconds: 0, commits: 0, history: hist };
      }
      store.current.seconds += 5;
      try { localStorage.setItem(FOCUS_KEY, JSON.stringify(store.current)); } catch { /* ignore */ }
      force((n) => n + 1);
    };
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, []);

  const bumpCommit = useCallback(() => {
    store.current.commits += 1;
    try { localStorage.setItem(FOCUS_KEY, JSON.stringify(store.current)); } catch { /* ignore */ }
    force((n) => n + 1);
  }, []);

  const s = store.current;
  const h = Math.round((s.seconds / 3600) * 10) / 10;
  const pct = Math.min(100, Math.round((h / FOCUS_GOAL_H) * 100));
  const focus: Focus = {
    h, goal: FOCUS_GOAL_H, pct,
    sessions: sessionsToday,
    commits: s.commits,
    streak: streakFrom(s.history, s.seconds > 60),
  };
  return { focus, bumpCommit };
}
