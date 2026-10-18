// Run: node bridge/dashboard/web/src/lib/indicator.check.ts
import { toIndicator } from "./indicator.ts";

console.assert(toIndicator("status") === "status", "status is kept");
console.assert(toIndicator("nyan") === "nyan", "the cat is kept");
console.assert(toIndicator("orbit") === "orbit", "orbit is kept");
console.assert(toIndicator("bar") === "orbit", "the retired equalizer lands on orbit");
console.assert(toIndicator("piano") === "orbit", "a retired form lands on orbit");
console.assert(toIndicator("tiles") === "orbit", "a retired form lands on orbit");
console.assert(toIndicator(undefined) === "orbit", "nothing stored is orbit");
