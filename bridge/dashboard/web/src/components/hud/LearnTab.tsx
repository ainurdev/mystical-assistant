import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Lesson } from "../../api";
import { Markdown } from "../Markdown";
import { ago } from "../../lib/surfaces";
import { checkYourself, lessonKey, nextUnread, shelves } from "../../lib/learn";
import { useStickyFlag, useStickySet, useStickyStr } from "../../lib/prefs";

/* LEARN tab — the lessons written after turns (bridge/learn.py), shelved by the
   concept each one teaches, read as a list on the left and the selected lesson
   on the right. Also where a single repo opts out, without touching the global
   switch.

   Two things the flat per-repo list got wrong. Lessons are read across repos,
   not inside one — so the default scope is ALL, every repo's lessons in one
   place, and the selected lesson carries the project it came from; switching
   sessions no longer swaps the shelf out from under you or leaves a lesson from
   the wrong repo on screen. And a lesson that is only a wall of markdown is
   never opened twice — so an unread one is gated behind its own **Check
   yourself** question, which every lesson already ends with.

   Same component serves the right sidebar (LearnPanel), where the sidebar is
   too narrow for two columns and the list stacks above the lesson instead. */

const mono: React.CSSProperties = {
  fontFamily: "'JetBrains Mono',monospace", fontSize: 11,
};

const btn: React.CSSProperties = {
  appearance: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 9.5,
  letterSpacing: 1.5, padding: "4px 10px", background: "transparent",
  color: "var(--txm)", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)",
};

const line = "1px solid color-mix(in srgb, var(--acc) 12%, transparent)";

export const READ_KEY = "hud-learn-read";

export function LearnTab({ project, compact, allowAll, read, onRead }: {
  project: string;
  compact?: boolean;
  /** Offer the ALL scope. The sidebar does; the per-repo modal stays on its own
   *  repo, where "lessons from everywhere" is the confusion, not the fix. */
  allowAll?: boolean;
  read?: Set<string>;
  onRead?: (key: string) => void;
}) {
  // App owns the read set where it also draws the unread badge, and hands it
  // down — two copies of it would drift. The modal has no badge to keep honest,
  // so it falls back to its own.
  // ponytail: marking a lesson read inside the modal leaves the sidebar badge
  // one high until the panel remounts. A store with subscribers if that shows.
  const [ownRead, setOwnRead] = useStickySet(READ_KEY);
  const readSet = read ?? ownRead;
  const markRead = onRead ?? ((k: string) => setOwnRead((r) => new Set(r).add(k)));

  // Inverted on purpose: the unset default is ALL, and the flag records the
  // narrowing rather than the norm.
  const [repoOnly, setRepoOnly] = useStickyFlag("hud-learn-repo-only");
  // With no session there is no repo to narrow to, and ALL is the whole point:
  // the panel still has everything you were reading.
  const canNarrow = !!allowAll && !!project;
  const scope = allowAll ? (canNarrow && repoOnly ? project : "*") : project;

  const [list, setList] = useState<Lesson[] | null>(null);
  const [repoOn, setRepoOn] = useState(true);
  const [selKey, setSelKey] = useStickyStr("hud-learn-sel");
  const [body, setBody] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [err, setErr] = useState(false);

  const load = useCallback(() => {
    api.lessons(scope).then((r) => {
      setErr(false);
      // A single repo's lessons come back unstamped. Stamp them, or the same
      // lesson keys differently in each scope and reads stop carrying over.
      const stamped = r.lessons.map((l) => ({ ...l, project: l.project ?? project }));
      setList(stamped);
      setRepoOn(r.repo_enabled);
      // The selection is deliberately not cleared when it falls out of scope:
      // narrowing to one repo shows a fallback lesson, and widening again puts
      // you back where you were rather than on whatever is newest.
    }).catch(() => { setErr(true); setList(null); });
  }, [scope, project]);

  useEffect(() => { load(); }, [load]);

  // Nothing selected (first open, or the selection isn't in this scope) opens
  // the next thing worth reading rather than whatever is newest.
  const sel = useMemo(() => {
    if (!list?.length) return undefined;
    return list.find((l) => lessonKey(l) === selKey)
      ?? nextUnread(list, readSet) ?? list[0];
    // readSet is deliberately not a dep: revealing the open lesson marks it
    // read, and that must not slide the selection on under the reader.
  }, [list, selKey]);

  // The key already encodes which repo the lesson is in, so the fetch depends on
  // it alone — a list refresh re-renders without re-reading the open lesson.
  const selK = sel ? lessonKey(sel) : "";
  useEffect(() => {
    setRevealed(false);
    setBody(null);
    if (!selK) return;
    const cut = selK.indexOf("::");
    let live = true;
    api.lesson(selK.slice(0, cut) || project, selK.slice(cut + 2))
      .then((r) => { if (live) setBody(r.body); })
      .catch(() => { if (live) setBody("_could not read this lesson._"); });
    return () => { live = false; };
  }, [selK, project]);

  const toggleRepo = () => {
    const next = !repoOn;
    setRepoOn(next);   // optimistic: the switch should not lag the click
    api.setLessonsForRepo(project, next)
      .then((r) => setRepoOn(r.repo_enabled))
      .catch(() => setRepoOn(!next));
  };

  const open = (l: Lesson) => { setSelKey(lessonKey(l)); };
  // Opening the auto-picked lesson is what makes it *your* place — pin it, or
  // the next list refresh silently picks the following unread one instead.
  const reveal = () => { if (selK) { markRead(selK); setSelKey(selK); } setRevealed(true); };

  if (err) {
    return (
      <div style={{ ...mono, color: "var(--txm)", display: "flex", alignItems: "center", gap: 10 }}>
        <span>failed to load lessons.</span>
        <button onClick={load} style={btn}>RETRY</button>
      </div>
    );
  }
  if (!list) return <div style={{ ...mono, color: "var(--txd)" }}>loading…</div>;

  const unread = list.filter((l) => !readSet.has(lessonKey(l))).length;
  const question = body ? checkYourself(body) : "";
  // An unread lesson is asked before it is answered — but only when the model
  // wrote a question to ask. Older lessons open straight into the markdown.
  const gated = !!sel && !revealed && !readSet.has(selK) && !!question;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "none", flexWrap: "wrap" }}>
        <span style={{ ...mono, color: "var(--txm)" }}>
          {list.length ? `${list.length} LESSON${list.length === 1 ? "" : "S"}` : "NO LESSONS YET"}
        </span>
        {unread > 0 && (
          <span style={{ ...mono, fontSize: 9.5, letterSpacing: 1, color: "var(--acc)" }}>
            {unread} NEW
          </span>
        )}
        {/* Which repo, only when that is the answer — in the ALL scope every row
            names its own, and one repo in the header would contradict them. */}
        {scope !== "*" && (
          <span style={{ ...mono, fontSize: 9.5, letterSpacing: 1, color: "var(--acc)" }}>
            {project.split("/").pop()}
          </span>
        )}
        {!repoOn && scope !== "*" && <span style={{ ...mono, color: "var(--warn, orange)" }}>OFF FOR THIS REPO</span>}
        <span style={{ flex: 1 }} />
        {canNarrow && (
          // Labelled with where it takes you, not where you are — the header
          // above already says which.
          <button onClick={() => setRepoOnly((v) => !v)} style={btn}
            title={repoOnly ? "show every repo's lessons" : "show only this repo's lessons"}>
            {repoOnly ? "ALL REPOS" : "THIS REPO"}
          </button>
        )}
        {scope !== "*" && (
          <button onClick={toggleRepo} style={btn}
            title={repoOn ? "stop writing lessons for this repo" : "write lessons for this repo again"}>
            {repoOn ? "DISABLE HERE" : "ENABLE HERE"}
          </button>
        )}
        <button onClick={load} style={btn}>REFRESH</button>
      </div>

      {list.length === 0 ? (
        <div style={{ ...mono, color: "var(--txd)", whiteSpace: "pre-wrap" }}>
          {repoOn
            ? "A lesson is written here after each turn that builds something —\nwhat changed, the idea behind it, and where to look.\nKeep working; the first one lands when the next turn finishes."
            : "Lessons are off for this repo. Enable here to start writing them again."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: compact ? "column" : "row", gap: 12, flex: 1, minHeight: 0 }}>
          <div className="mscroll" style={compact
            ? { maxHeight: "45%", flex: "none", overflowY: "auto", borderBottom: line, paddingBottom: 6 }
            : { width: 240, flex: "none", overflowY: "auto", borderRight: line, paddingRight: 8 }}>
            {shelves(list, readSet).map((sh) => {
              const shut = collapsed.has(sh.concept);
              return (
                <div key={sh.concept} style={{ marginBottom: 4 }}>
                  <button
                    onClick={() => setCollapsed((c) => {
                      const n = new Set(c);
                      if (!n.delete(sh.concept)) n.add(sh.concept);
                      return n;
                    })}
                    style={{ ...mono, display: "flex", alignItems: "center", gap: 6, width: "100%",
                      appearance: "none", border: 0, background: "transparent", cursor: "pointer",
                      padding: "6px 4px", fontSize: 9.5, letterSpacing: 1.5, color: "var(--txm)",
                      textTransform: "uppercase" }}>
                    <span style={{ color: "var(--txd)", width: 8 }}>{shut ? "▸" : "▾"}</span>
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {sh.concept}
                    </span>
                    <span style={{ flex: 1 }} />
                    <span style={{ color: sh.unread ? "var(--acc)" : "var(--txd)", fontSize: 9 }}>
                      {sh.unread ? `${sh.unread}/${sh.lessons.length}` : sh.lessons.length}
                    </span>
                  </button>
                  {!shut && sh.lessons.map((l) => {
                    const k = lessonKey(l);
                    const on = k === selK;
                    return (
                      <button key={k} onClick={() => open(l)}
                        style={{ display: "flex", gap: 6, width: "100%", textAlign: "left", appearance: "none",
                          border: 0, borderLeft: `2px solid ${on ? "var(--acc)" : "transparent"}`,
                          cursor: "pointer", fontFamily: "inherit", padding: "7px 9px", marginBottom: 2,
                          background: on ? "color-mix(in srgb, var(--acc) 7%, transparent)" : "transparent",
                          color: on ? "var(--txb)" : "var(--txl)", fontSize: 11, lineHeight: 1.35 }}>
                        <span style={{ flex: "none", marginTop: 4, width: 5, height: 5, borderRadius: 5,
                          background: readSet.has(k) ? "transparent" : "var(--acc)" }} />
                        <span style={{ minWidth: 0 }}>
                          {l.title}
                          <span style={{ display: "block", ...mono, fontSize: 9, color: "var(--txd)", marginTop: 3,
                            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {scope === "*" && l.project ? `${l.project.split("/").pop()} · ` : `${l.file.slice(0, 4)} · `}
                            {ago(l.at)} ago
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
          <div className="mscroll" style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
            {body === null
              ? <div style={{ ...mono, color: "var(--txd)" }}>loading…</div>
              : gated
                ? <Quiz title={sel!.title} concept={sel!.concept} question={question} onReveal={reveal} />
                : <Markdown>{body}</Markdown>}
          </div>
        </div>
      )}
    </div>
  );
}

/** An unread lesson, asked before it is answered. The question is the lesson's
 *  own closing line — it was always there, at the bottom, after the answer. */
function Quiz({ title, concept, question, onReveal }: {
  title: string; concept: string; question: string; onReveal: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "18px 4px", maxWidth: 560 }}>
      <span style={{ ...mono, fontSize: 9.5, letterSpacing: 1.5, color: "var(--txd)", textTransform: "uppercase" }}>
        {concept || "new lesson"}
      </span>
      <span style={{ fontSize: 15, lineHeight: 1.4, color: "var(--txb)" }}>{title}</span>
      <div style={{ borderLeft: "2px solid var(--acc)", paddingLeft: 12 }}>
        <span style={{ ...mono, fontSize: 9.5, letterSpacing: 1.5, color: "var(--acc)", display: "block", marginBottom: 6 }}>
          CAN YOU ANSWER THIS?
        </span>
        <span style={{ fontSize: 13, lineHeight: 1.55, color: "var(--txl)" }}>{question}</span>
      </div>
      <div>
        <button onClick={onReveal} style={{ ...btn, padding: "7px 14px" }}>SHOW THE LESSON</button>
      </div>
    </div>
  );
}

/** Right-sidebar panel. Scoped to every repo by default, so it keeps its place
 *  when you switch sessions — the active repo is a filter here, not the subject. */
export function LearnPanel({ project, read, onRead }: {
  project: string | null;
  read: Set<string>;
  onRead: (key: string) => void;
}) {
  return (
    <div className="panel" style={{ border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)",
      background: "color-mix(in srgb, var(--panel) 86%, transparent)",
      display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* No repo chip here: the panel spans repos by default, and naming the
          active session's one made the header disagree with the list. */}
      <div style={{ display: "flex", alignItems: "center", padding: "8px 12px" }}>
        <span style={{ fontSize: 10.5, letterSpacing: 2.5, color: "var(--txl)" }}>LEARN</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, padding: 11 }}>
        {/* No `key={project}`: remounting on every session switch is what threw
            away the reading position in the first place. */}
        <LearnTab project={project ?? ""} compact allowAll read={read} onRead={onRead} />
      </div>
    </div>
  );
}
