// Run: node bridge/dashboard/web/src/lib/computer.check.ts
// The DRIVING pill reads the running turn's computer_state events (bridge/computer.py).
import { driving } from "./computer.ts";
import type { Turn } from "../chat.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const turn = (status: Turn["status"], events: unknown[]): Turn => ({ id: "t", prompt: "", events: events as Turn["events"], status, pending: [] });
const tool = (name: string) => ({ type: "tool", name, summary: "" });

ok(driving([]) === null, "no turn, not driving");
ok(driving([turn("running", [tool("Bash")])]) === null, "a turn that never drove");
const d = driving([turn("running", [
  tool("mcp__computer__request_access"),
  { type: "computer_state", state: "driving", apps: ["Safari", "Numbers"] },
  tool("mcp__computer__screenshot"), tool("mcp__computer__left_click"), tool("Read"),
  tool("mcp__computer__list_granted_applications"),
])]);
ok(d !== null && d.apps.join() === "Safari,Numbers", "driving names the apps");
ok(d?.actions === 2, "counts its actions, not the asks or other tools");
ok(driving([turn("running", [{ type: "computer_state", state: "driving", apps: [] }, { type: "computer_state", state: "stopped" }])]) === null,
  "stopped is not driving");
ok(driving([turn("done", [{ type: "computer_state", state: "driving", apps: ["Safari"] }])]) === null, "an ended turn doesn't drive");
