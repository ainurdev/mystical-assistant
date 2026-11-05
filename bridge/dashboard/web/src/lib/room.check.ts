// Run: node --experimental-strip-types src/lib/room.check.ts  (from web/)
import type { Teammate } from "../api";
import { room } from "./room.ts";

const now = Date.parse("2026-11-05T12:00:00Z") / 1000;
const t = (id: string, online: boolean, ago?: number): Teammate => ({
  id, name: `${id} Last`, avatarUrl: null, online, device: null,
  lastSeenAt: ago == null ? null : new Date((now - ago) * 1000).toISOString(),
});
let r = room([t("b", false, 120), t("a", true, 30), t("c", false)], now);
console.assert(r.shown.map((x) => x.id).join() === "a,b,c" && r.on === 1, "on now first");
console.assert(r.caption.startsWith("a is on now") && r.caption.endsWith("b left 2m ago"), "caption: " + r.caption);
r = room(Array.from({ length: 8 }, (_, i) => t("p" + i, i < 2)), now);
console.assert(r.shown.length === 5 && r.more === 3 && r.shown[0].online && r.shown[1].online, "5 shown, +3");
r = room([t("x", false, 7200)], now);
console.assert(r.caption === "nobody is on right now" && r.on === 0 && !r.lead, "nobody on, left long ago: " + r.caption);
console.assert(room([], now).shown.length === 0 && room([], now).caption === "", "empty");
console.log("room ok");
