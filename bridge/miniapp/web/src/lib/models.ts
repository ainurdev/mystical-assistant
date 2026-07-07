export interface ModelOption {
  id: string; // full model id (e.g. "claude-opus-4-8"), or a short CLI alias
  label: string;
}

// Shown only until /api/state delivers the live list (Anthropic Models API, via
// bridge/models.py) — or if that API/token is unavailable and the backend serves
// its own fallback. This is a pre-load safety net, not the source of truth.
const FALLBACK: ModelOption[] = [
  { id: "opus", label: "Opus 4.8" },
  { id: "sonnet", label: "Sonnet 4.6" },
  { id: "haiku", label: "Haiku 4.5" },
  { id: "fable", label: "Fable 5" },
];

export function modelOptions(models?: ModelOption[]): ModelOption[] {
  return models && models.length ? models : FALLBACK;
}
