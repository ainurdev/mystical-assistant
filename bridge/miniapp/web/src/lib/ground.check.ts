// Run: node bridge/miniapp/web/src/lib/ground.check.ts
//
// The phone's ground (the texture under the transcript) is a browser-side pick
// with no other home: when the /output page went with the retired output
// styles (settings remap, 2026-10-15), its CHAT_BGS tiles went too and a phone
// that had picked a ground could never clear it. SYSTEM must offer the pick.
import { readFileSync } from "node:fs";

const system = readFileSync(new URL("../routes/system.tsx", import.meta.url), "utf8");
console.assert(/\bCHAT_BGS\b/.test(system), "SYSTEM lists the grounds (CHAT_BGS)");
console.assert(/\buseChatBg\(\)/.test(system), "SYSTEM reads and writes the ground (useChatBg)");
