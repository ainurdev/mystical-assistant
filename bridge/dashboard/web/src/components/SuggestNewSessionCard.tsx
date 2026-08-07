// Mirrors bridge/miniapp/web/src/components/SuggestNewSessionCard.tsx (shared design).
// The relevance guardrail held a prompt that looks like different work from the
// session it would resume. The prompt is still client-side — nothing ran, nothing
// was stored — until one of these buttons is pressed.
export function SuggestNewSessionCard({
  currentTitle, reason, suggestedTitle, busy, onStartNew, onContinue, onDismiss,
}: {
  currentTitle: string;
  reason: string;
  suggestedTitle: string | null;
  busy?: boolean;
  onStartNew: () => void;
  onContinue: () => void;
  onDismiss: () => void;
}) {
  const btn = {
    appearance: "none" as const, cursor: busy ? "wait" : "pointer", fontFamily: "inherit",
    fontSize: "var(--t10)", letterSpacing: 1, padding: "5px 11px", opacity: busy ? 0.5 : 1,
  };
  return (
    <div style={{ margin: "0 16px 9px", border: "1px solid color-mix(in srgb, var(--purple) 35%, transparent)", background: "color-mix(in srgb, var(--purple) 8%, transparent)", padding: "9px 12px" }}>
      <div style={{ fontSize: "var(--t10)", letterSpacing: 1, color: "var(--purple)", marginBottom: 5 }}>
        DIFFERENT WORK?
      </div>
      <div style={{ fontSize: "var(--t12)", lineHeight: 1.5, color: "var(--txb)" }}>
        This looks unrelated to <span style={{ color: "var(--purple-b)" }}>{currentTitle || "this session"}</span>
        {reason ? ` — ${reason}` : "."}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 9 }}>
        <button
          onClick={onStartNew}
          disabled={busy}
          title={suggestedTitle ? `New session: ${suggestedTitle}` : "Start a new session"}
          style={{ ...btn, border: "1px solid var(--purple)", background: "color-mix(in srgb, var(--purple) 14%, transparent)", color: "var(--purple-b)" }}
        >
          START NEW SESSION{suggestedTitle ? ` · ${suggestedTitle.toUpperCase()}` : ""}
        </button>
        <button
          onClick={onContinue}
          disabled={busy}
          style={{ ...btn, border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)", background: "transparent", color: "var(--txd)" }}
        >
          CONTINUE HERE ANYWAY
        </button>
        <button
          onClick={onDismiss}
          disabled={busy}
          style={{ ...btn, border: 0, background: "transparent", color: "var(--txl)" }}
        >
          DISMISS
        </button>
      </div>
    </div>
  );
}
