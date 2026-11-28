// Run: node bridge/dashboard/web/src/lib/indicator.check.ts
import { toIndicator } from "./indicator.ts";

console.assert(toIndicator("status") === "status", "status is kept");
console.assert(toIndicator("nyan") === "nyan", "the cat is kept");
console.assert(toIndicator("orbit") === "status", "the retired orbit lands on status");
console.assert(toIndicator("bar") === "status", "the retired equalizer lands on status");
console.assert(toIndicator("piano") === "status", "a retired form lands on status");
console.assert(toIndicator("tiles") === "status", "a retired form lands on status");
console.assert(toIndicator(undefined) === "status", "nothing stored is status");
