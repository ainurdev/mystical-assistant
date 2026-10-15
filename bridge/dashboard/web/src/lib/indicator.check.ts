// Run: node bridge/dashboard/web/src/lib/indicator.check.ts
import { toIndicator } from "./indicator.ts";

console.assert(toIndicator("status") === "status", "status is kept");
console.assert(toIndicator("bar") === "bar", "bar is kept");
console.assert(toIndicator("nyan") === "bar", "a retired form lands on the spinner");
console.assert(toIndicator("piano") === "bar", "a retired form lands on the spinner");
console.assert(toIndicator("tiles") === "bar", "a retired form lands on the spinner");
console.assert(toIndicator(undefined) === "bar", "nothing stored is the spinner");
