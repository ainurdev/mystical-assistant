import { describe, it, expect } from "vitest";
import { AGENT_SOURCE, HOST_SOURCE, isAgentMessage, isHostMessage } from "../src/protocol";

describe("protocol guards", () => {
  it("accepts a well-formed agent message", () => {
    expect(isAgentMessage({ source: AGENT_SOURCE, type: "ready", version: 1 })).toBe(true);
  });
  it("rejects a foreign source", () => {
    expect(isAgentMessage({ source: "evil", type: "ready" })).toBe(false);
  });
  it("requires a matching nonce for host messages", () => {
    const msg = { source: HOST_SOURCE, nonce: "abc", type: "clear" };
    expect(isHostMessage(msg, "abc")).toBe(true);
    expect(isHostMessage(msg, "xyz")).toBe(false);
  });
});
