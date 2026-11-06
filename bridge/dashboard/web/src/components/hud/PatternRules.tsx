import { useCallback, useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { LEVEL_LABEL, ownPatterns, patternProblem, type Scope } from "../../lib/agenttools";
import { at } from "../../lib/agenttoolsapi";

/* Deny patterns like Bash(git push*). The route answers with what's in force here, every
   level merged, so "what this level holds" comes from asking the next level out as well
   (lib/agenttools ownPatterns). Saving writes this level's list and no other's. */

const WIDER: Record<Scope["level"], Scope["level"] | null> = { chat: "project", project: "machine", machine: null };

export function PatternRules({ scope, inForce, onChanged }: { scope: Scope; inForce: string[]; onChanged: () => void }) {
  const [wider, setWider] = useState<string[] | null>(scope.level === "machine" ? [] : null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const readWider = useCallback(() => {
    const up = WIDER[scope.level];
    if (!up) { setWider([]); return; }
    setWider(null);
    setError(null);
    // The page keeps a chat's scope on that chat's project. With none, the machine's is next.
    at.grid({ ...scope, level: up === "project" && !scope.project ? "machine" : up })
      .then((g) => setWider(g.patterns), (e: Error) => setError(e.message));
  }, [scope]);
  useEffect(() => { readWider(); }, [readWider]);

  const own = wider ? ownPatterns(inForce, wider) : [];
  const save = async (next: string[]) => {
    setBusy(true);
    setError(null);
    try {
      await at.patterns(scope, next);
      onChanged();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally { setBusy(false); }
  };
  const add = async () => {
    const problem = patternProblem(text, inForce);
    if (problem) { setError(problem); return; }
    if (await save([...own, text.trim()])) setText("");
  };

  return (
    <section className="at-patterns" data-sec="PATTERN RULES">
      <div className="at-subhead">
        <b>Deny patterns</b>
        <span className="ma-tag">CLAUDE ONLY</span>
        <span className="at-subnote">Other agents take no tool list over ACP, so these don&apos;t reach them.</span>
      </div>
      {wider === null && !error && <div className="ma-set-note" role="status">Reading the patterns…</div>}
      {wider !== null && own.length === 0 && wider.length === 0 && (
        <div className="at-empty-line">No patterns yet. Add one to deny part of a tool, like <code>Bash(git push*)</code>.</div>
      )}
      {wider !== null && (own.length > 0 || wider.length > 0) && (
        <ul className="at-plist">
          {own.map((p) => (
            <li key={p}>
              <code>{p}</code>
              <span className="at-lv">{LEVEL_LABEL[scope.level].toUpperCase()}</span>
              <button type="button" className="ma-link" data-danger disabled={busy} aria-label={`Remove ${p}`} title="Remove" onClick={() => void save(own.filter((x) => x !== p))}><X size={12} aria-hidden /></button>
            </li>
          ))}
          {wider.map((p) => (
            <li key={p} data-wide>
              <code>{p}</code>
              <span className="at-lv" title="Set further out: change it at that level">FROM A WIDER LEVEL</span>
            </li>
          ))}
        </ul>
      )}
      <div className="at-padd">
        <input className="ma-input" value={text} aria-label="New deny pattern" placeholder="Bash(git push*)" spellCheck={false} disabled={wider === null}
          onChange={(e) => { setText(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void add(); } }} />
        <button type="button" className="at-btn" disabled={busy || wider === null} onClick={() => void add()}><Plus size={12} aria-hidden />Add at {LEVEL_LABEL[scope.level].toLowerCase()}</button>
      </div>
      {error && (
        <div className="ma-set-err" role="alert">
          {error} {wider === null && <button type="button" className="ma-link" onClick={readWider}>try again</button>}
        </div>
      )}
    </section>
  );
}
