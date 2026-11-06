// Run: node src/lib/capdate.check.ts  (from web/)
//
// The cap's date window: the date over "conditions · temp · city".
import { capDate } from "./capdate.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const now = new Date(2026, 10, 5, 20, 32);
const w = { available: true, cond: "RAIN SHOWERS", temp: 11, hi: 13, lo: 6, wind: "", hum: "", unit: "C" as const, loc: "YEREVAN, YEREVAN, AM" };

const a = capDate(now, w);
ok(a.date === "THURSDAY 5 NOV", "date line");
ok(a.line2 === "rain showers · 11° · Yerevan", "conditions, temp, city");
ok(capDate(now, { ...w, temp: null }).line2 === "rain showers · Yerevan", "no temp drops that part");
ok(capDate(now, { ...w, available: false }).line2 === "", "no weather: empty second line");
ok(capDate(now, { ...w, loc: "rio de janeiro, RJ, BR" }).line2.endsWith("Rio De Janeiro"), "city is the first part, title case");
