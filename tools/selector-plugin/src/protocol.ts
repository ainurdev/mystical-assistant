export const PROTOCOL_VERSION = 1;
export const HOST_SOURCE = "mystical-selector-host";
export const AGENT_SOURCE = "mystical-selector-agent";

export type Mode = "idle" | "select" | "pin";

export interface ElementCapture {
  kind: "element";
  id: string;
  mloc: string | null; // "src/Hero.tsx:42:7" or null
  selector: string;
  tag: string;
  idAttr: string | null;
  classList: string[];
  text: string;
  outerHTML: string;
  rect: { x: number; y: number; w: number; h: number };
  styles: Record<string, string>;
}

export interface PinCapture {
  kind: "pin";
  id: string;
  mloc: string | null;
  nearestSelector: string | null;
  nearestTag: string | null;
  point: { x: number; y: number };
}

export type Capture = ElementCapture | PinCapture;

export type HostMessage =
  | { source: typeof HOST_SOURCE; nonce: string; type: "init"; parentOrigin: string; mode: Mode }
  | { source: typeof HOST_SOURCE; nonce: string; type: "setMode"; mode: Mode }
  | { source: typeof HOST_SOURCE; nonce: string; type: "highlight"; selector: string | null }
  | { source: typeof HOST_SOURCE; nonce: string; type: "clear" };

export type AgentMessage =
  | { source: typeof AGENT_SOURCE; type: "ready"; version: number }
  | { source: typeof AGENT_SOURCE; type: "hover"; label: string | null }
  | { source: typeof AGENT_SOURCE; type: "captured"; capture: Capture };

export function isAgentMessage(d: unknown): d is AgentMessage {
  return !!d && typeof d === "object" && (d as { source?: unknown }).source === AGENT_SOURCE;
}
export function isHostMessage(d: unknown, nonce: string): d is HostMessage {
  return (
    !!d &&
    typeof d === "object" &&
    (d as { source?: unknown }).source === HOST_SOURCE &&
    (d as { nonce?: unknown }).nonce === nonce
  );
}
