import type { Weather } from "../api";

// The cap's date window: "THURSDAY 5 NOV" over "rain showers · 11° · Yerevan".
// Pure so a check can pin it; the Strip only prints the two lines.
export function capDate(now: Date, w: Weather): { date: string; line2: string } {
  const wd = now.toLocaleDateString("en-US", { weekday: "long" });
  const mo = now.toLocaleDateString("en-US", { month: "short" });
  const date = `${wd} ${now.getDate()} ${mo}`.toUpperCase();
  if (!w.available) return { date, line2: "" };
  const city = (w.loc.split(",")[0] ?? "").trim().toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
  const line2 = [w.cond.toLowerCase(), w.temp === null ? "" : `${w.temp}°`, city].filter(Boolean).join(" · ");
  return { date, line2 };
}
