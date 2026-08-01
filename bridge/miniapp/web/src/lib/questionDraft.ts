// Answers you pick but don't send survive leaving the session (or closing the
// webview): the card writes its draft under the question's request_id, and drops
// it once the question is answered. Keyed by request_id, not by session, so two
// open questions never clobber each other.
// Mirrors bridge/dashboard/web/src/lib/questionDraft.ts.
export type QuestionDraft = {
  sel: Record<string, string[]>;
  notes: Record<string, string>;
};

const keyOf = (requestId: string) => `qdraft:${requestId}`;

export function readDraft(requestId: string): QuestionDraft {
  try {
    const raw = localStorage.getItem(keyOf(requestId));
    if (raw === null) return { sel: {}, notes: {} };
    const d = JSON.parse(raw) as Partial<QuestionDraft>;
    return { sel: d.sel ?? {}, notes: d.notes ?? {} };
  } catch {
    // Corrupt JSON, or no localStorage in a rare webview — start clean.
    return { sel: {}, notes: {} };
  }
}

export function saveDraft(requestId: string, draft: QuestionDraft): void {
  try {
    localStorage.setItem(keyOf(requestId), JSON.stringify(draft));
  } catch {
    // QuotaExceededError or no localStorage — degrade to in-memory.
  }
}

export function clearDraft(requestId: string): void {
  try {
    localStorage.removeItem(keyOf(requestId));
  } catch {
    // ignore
  }
}
