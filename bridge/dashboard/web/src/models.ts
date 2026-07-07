export interface ModelOption {
  id: string; // full model id (e.g. "claude-opus-4-8"), or a short CLI alias
  label: string;
}

// Shown only until /local/state delivers the live list (Anthropic Models API,
// via bridge/models.py) — or if that API/token is unavailable and the backend
// serves its own fallback. This is a pre-load safety net, not the source.
const FALLBACK: ModelOption[] = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
  { id: "fable", label: "Fable" },
];

export function modelOptions(models?: ModelOption[]): ModelOption[] {
  return models && models.length ? models : FALLBACK;
}
