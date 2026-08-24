import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Lesson } from "../../api";
import { Markdown } from "../Markdown";
import { ago } from "../../lib/surfaces";
import { checkYourself, deal, dueCount, grade, lessonKey, nextUnread, shelves,
  UNSORTED, type Sched } from "../../lib/learn";
import { useStickyFlag, useStickyObj, useStickySet, useStickyStr } from "../../lib/prefs";

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

   What the redesign fixed. The deck grows past ninety and the file-browser
   framing stops working: every shelf expanded meant one concept's twenty-eight
   rows buried the other nine, there was no way to search them, and "90 LESSONS
   90 NEW" is a number you bounce off rather than a progress you chip at. So the
   header is now an instrument — a read meter over the scope you are reading —
   shelves start shut with their own progress bars so the concept map is what
   you see first, and STUDY deals the unread ones one at a time instead of
   asking you to pick from a list nobody finishes.

   Same component serves the right sidebar (LearnPanel), where the sidebar is
   too narrow for two columns and the list stacks above the lesson instead. */

const mono: React.CSSProperties = {
  fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t11)",
};

/** Instrument chrome: uppercase, tracked, dim. Share Tech Mono (the body font). */
const label: React.CSSProperties = {
  fontSize: "var(--t9)", letterSpacing: 1.5, color: "var(--txl)", textTransform: "uppercase",
};

const btn: React.CSSProperties = {
  appearance: "none", cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t95)",
  letterSpacing: 1.5, padding: "4px 10px", background: "transparent",
  color: "var(--txm)", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)",
};

/** The one filled control on the tab — STUDY, and the reveal that starts a card. */
const btnHero: React.CSSProperties = {
  ...btn, color: "var(--txb)", padding: "7px 14px",
  background: "color-mix(in srgb, var(--acc) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--acc) 45%, transparent)",
};

const line = "1px solid color-mix(in srgb, var(--acc) 12%, transparent)";

export const READ_KEY = "hud-learn-read";

/** `ago` reads "now" for anything under a minute, and "now ago" is not a time. */
const when = (at: number) => { const a = ago(at); return a === "now" ? "just now" : `${a} ago`; };

/** The HUD utilization bar, at the two sizes this tab uses it: 3px under the
 *  header for the whole deck, 2px under a shelf for one concept. */
function Meter({ pct, h = 3, dim }: { pct: number; h?: number; dim?: boolean }) {
  return (
    <div style={{ height: h, flex: 1, minWidth: 0, background: "color-mix(in srgb, var(--acc) 8%, transparent)" }}>
      <div style={{ height: "100%", width: `${pct}%`, transition: "width .35s var(--ease-hud)",
        background: dim ? "color-mix(in srgb, var(--acc) 45%, transparent)" : "var(--acc)" }} />
    </div>
  );
}

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

  // The review ladder — which read lessons are due back, and when. Lives beside
  // the read set in localStorage; a lesson in neither is new, in the read set
  // alone retired, in both scheduled.
  const [sched, setSched] = useStickyObj<Sched>("hud-learn-sched", {});

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
  const [q, setQ] = useState("");
  // Every shelf starts shut, so the column opens on the concept map rather than
  // inside one concept — the old all-expanded default meant the thirty lessons
  // of whichever shelf you were in buried the other nine entirely.
  const [open, setOpen] = useState<Set<string>>(new Set());
  // Topic groups fold like shelves; keyed concept::topic so two shelves can
  // hold the same topic word without sharing a hinge.
  const [openTopics, setOpenTopics] = useState<Set<string>>(new Set());
  const toggleTopic = (gk: string) => setOpenTopics((o) => {
    const n = new Set(o);
    if (!n.delete(gk)) n.add(gk);
    return n;
  });
  // A study run deals the unread ones in turn: no list, one card, next.
  const [study, setStudy] = useState(false);
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

  // Search narrows what the shelves are built from, so a hit's concept still
  // frames it — a flat result list would drop the one thing that sorts them.
  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!list || !needle) return list;
    return list.filter((l) =>
      l.title.toLowerCase().includes(needle) || (l.concept || "").toLowerCase().includes(needle));
  }, [list, q]);

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

  const openLesson = (l: Lesson) => { setSelKey(lessonKey(l)); };
  // Opening the auto-picked lesson is what makes it *your* place — pin it, or
  // the next list refresh silently picks the following unread one instead.
  const reveal = () => { if (selK) { markRead(selK); setSelKey(selK); } setRevealed(true); };

  const unread = list ? list.filter((l) => !readSet.has(lessonKey(l))) : [];
  const total = list?.length ?? 0;
  const readCount = total - unread.length;
  const dueN = list ? dueCount(list, sched, Date.now()) : 0;
  const question = body ? checkYourself(body) : "";
  // An unread lesson is asked before it is answered — but only when the model
  // wrote a question to ask. Older lessons open straight into the markdown.
  // A due review is re-asked its question in STUDY even though it is read —
  // that is the point of the ladder. Browse mode never re-gates a read lesson.
  const isDueHere = study && !!sched[selK] && sched[selK].due <= Date.now();
  const gated = !!sel && !revealed && !!question && (!readSet.has(selK) || isDueHere);

  // A lesson whose body is on screen has been read, whether you answered a
  // question to get there or it never had one to ask. Without this the older
  // question-less lessons stayed unread forever — and a study run dealt the
  // same one every time.
  useEffect(() => {
    if (selK && body !== null && !gated) markRead(selK);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selK, body, gated]);

  const dealNext = (lastConcept?: string) => {
    const n = deal(list ?? [], readSet, sched, Date.now(), lastConcept);
    if (n) setSelKey(lessonKey(n));
    else setSelKey("");   // deck clear — the run says so rather than looping
  };
  const startStudy = () => { setStudy(true); dealNext(); };
  // One handler for all three verdicts: SKIP arrives from the quiz card (either
  // mode), GOT IT / REVIEW only from a study run's footer. The next deal reads
  // the post-grade state computed here — dealing from the render's sched/read
  // would re-deal the card just graded.
  const gradeCard = (v: "got" | "review" | "skip") => {
    const last = sel ? (sel.concept || UNSORTED) : undefined;
    if (selK) {
      const nextSched = grade(sched, selK, v, Date.now());
      setSched(nextSched);
      markRead(selK);
      if (study) {
        const n = deal(list ?? [], new Set(readSet).add(selK), nextSched, Date.now(), last);
        setSelKey(n ? lessonKey(n) : "");
        return;
      }
    } else if (study) { dealNext(last); return; }
    setRevealed(true);   // browse SKIP: retired, but stays on screen
  };

  if (err) {
    return (
      <div style={{ ...mono, color: "var(--txm)", display: "flex", alignItems: "center", gap: 10 }}>
        <span>failed to load lessons.</span>
        <button onClick={load} style={btn}>RETRY</button>
      </div>
    );
  }
  if (!list) return <div style={{ ...mono, color: "var(--txd)" }}>loading…</div>;

  // Done when the deal came up empty (selKey ""), not when the current card is
  // read — every dealt review card is read by definition.
  const studyDone = study && !selKey && !unread.length && !dueN;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, height: "100%" }}>
      {/* ── instrument header: what the deck is, how far in you are ── */}
      <div style={{ flex: "none", display: "flex", flexDirection: "column", gap: 7 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span style={{ ...mono, fontSize: "var(--t13)", color: "var(--txb)", letterSpacing: 0.5 }}>
            {total || "NO"}
          </span>
          <span style={label}>{total === 1 ? "LESSON" : "LESSONS"}</span>
          {scope !== "*" && (
            <span style={{ ...mono, fontSize: "var(--t95)", color: "var(--acc)", minWidth: 0,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {project.split("/").pop()}
            </span>
          )}
          {!repoOn && scope !== "*" && <span style={{ ...label, color: "var(--warn)" }}>WRITING OFF</span>}
          <span style={{ flex: 1 }} />
          {canNarrow && (
            // A segmented pair states where you are, rather than one button
            // labelled with where it would take you.
            <div style={{ display: "flex", border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)" }}>
              {([["ALL", false], ["REPO", true]] as const).map(([l, v]) => (
                <button key={l} onClick={() => setRepoOnly(v)}
                  style={{ ...btn, border: 0, padding: "3px 9px",
                    background: repoOnly === v ? "color-mix(in srgb, var(--acc) 14%, transparent)" : "transparent",
                    color: repoOnly === v ? "var(--txb)" : "var(--txl)" }}>{l}</button>
              ))}
            </div>
          )}
          {scope !== "*" && (
            <button onClick={toggleRepo} style={{ ...btn, padding: "3px 9px" }}
              title={repoOn ? "stop writing lessons for this repo" : "write lessons for this repo again"}>
              {repoOn ? "DISABLE HERE" : "ENABLE HERE"}
            </button>
          )}
          <button onClick={load} style={{ ...btn, padding: "3px 9px" }} title="refresh">↻</button>
        </div>

        {total > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <span style={{ ...label, flex: "none" }}>READ</span>
            <Meter pct={(readCount / total) * 100} />
            <span style={{ ...mono, fontSize: "var(--t95)", color: "var(--txm)", flex: "none" }}>
              {readCount}/{total}
            </span>
          </div>
        )}
      </div>

      {total === 0 ? (
        // Oracle voice, framed — an empty deck is still an instrument reading.
        <div className="panel" style={{ border: line, padding: "18px 16px", maxWidth: 520 }}>
          <div style={{ ...label, color: "var(--acc)", marginBottom: 9 }}>
            {repoOn ? "AWAITING FIRST LESSON" : "LESSONS PAUSED HERE"}
          </div>
          <div style={{ ...mono, fontSize: "var(--t12)", lineHeight: 1.6, color: "var(--txm)", fontStyle: "italic" }}>
            {repoOn
              ? "the work teaches as it goes — a lesson is written after each turn that builds something, and lands here when the next one finishes."
              : "nothing is being written for this repo. enable here, and the next turn leaves a lesson behind."}
          </div>
        </div>
      ) : study ? (
        <StudyRun
          left={unread.length} due={dueN} done={studyDone} sel={sel} body={body}
          gated={gated} question={question} scope={scope}
          onReveal={reveal} onGrade={(v) => gradeCard(v)}
          onSkip={() => gradeCard("skip")} onExit={() => setStudy(false)} />
      ) : (
        <>
          <div style={{ flex: "none", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              type="search" value={q} onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setQ(""); }}
              placeholder="search lessons…"
              style={{ flex: 1, minWidth: 120, boxSizing: "border-box", ...mono, color: "var(--txb)",
                background: "color-mix(in srgb, var(--panel2) 45%, transparent)",
                border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)",
                outline: "none", padding: "6px 9px" }} />
            {(unread.length > 0 || dueN > 0) && (
              <button onClick={startStudy} style={{ ...btnHero, padding: "6px 12px", flex: "none" }}
                title="deal the unread lessons one at a time">
                ▸ STUDY {unread.length + dueN}
              </button>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: compact ? "column" : "row", gap: 12, flex: 1, minHeight: 0 }}>
            <div className="mscroll" style={compact
              ? { maxHeight: "42%", flex: "none", overflowY: "auto", borderBottom: line, paddingBottom: 6 }
              : { width: 252, flex: "none", overflowY: "auto", borderRight: line, paddingRight: 8 }}>
              {hits!.length === 0 ? (
                <div style={{ ...mono, fontSize: "var(--t105)", color: "var(--txd)", padding: "10px 4px", fontStyle: "italic" }}>
                  nothing by that name.
                </div>
              ) : shelves(hits!, readSet).map((sh) => {
                // Searching opens every shelf it hit: a result you have to
                // unfold before you can see it is not a result.
                const shut = !q && !open.has(sh.concept);
                const done = sh.lessons.length - sh.unread;
                // Where the open lesson lives, so a shut column still says
                // which shelf you are reading out of.
                const here = sh.lessons.some((l) => lessonKey(l) === selK);
                return (
                  <div key={sh.concept} style={{ marginBottom: 6 }}>
                    <button
                      onClick={() => setOpen((o) => {
                        const n = new Set(o);
                        if (!n.delete(sh.concept)) n.add(sh.concept);
                        return n;
                      })}
                      style={{ display: "flex", flexDirection: "column", gap: 4, width: "100%",
                        appearance: "none", border: 0, background: "transparent", cursor: "pointer",
                        padding: "6px 4px", textAlign: "left" }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", ...label,
                        color: here ? "var(--acc)" : shut ? "var(--txm)" : "var(--txb)" }}>
                        <span style={{ color: "var(--txl)", width: 8, flex: "none" }}>{shut ? "▸" : "▾"}</span>
                        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {sh.concept}
                        </span>
                        <span style={{ flex: 1 }} />
                        <span style={{ ...mono, fontSize: "var(--t9)", flex: "none",
                          color: sh.unread ? "var(--acc)" : "var(--txl)" }}>
                          {done}/{sh.lessons.length}
                        </span>
                      </span>
                      <span style={{ display: "flex", paddingLeft: 14 }}>
                        <Meter pct={(done / sh.lessons.length) * 100} h={2} dim />
                      </span>
                    </button>
                    {!shut && sh.groups.map((g) => {
                      const gk = `${sh.concept}::${g.topic}`;
                      const gShut = !!g.topic && !q && !openTopics.has(gk);
                      const gDone = g.lessons.length - g.unread;
                      return (
                        <div key={gk || "misc"} style={{ paddingLeft: g.topic ? 6 : 0 }}>
                          {g.topic && (
                            <button onClick={() => toggleTopic(gk)}
                              style={{ display: "flex", alignItems: "center", gap: 6, width: "100%",
                                appearance: "none", border: 0, background: "transparent",
                                cursor: "pointer", padding: "4px 4px", textAlign: "left" }}>
                              <span style={{ ...label, fontSize: "var(--t9)",
                                color: gShut ? "var(--txm)" : "var(--txb)" }}>
                                {gShut ? "▸" : "▾"} {g.topic}
                              </span>
                              <span style={{ flex: 1 }} />
                              <span style={{ ...mono, fontSize: "var(--t9)",
                                color: g.unread ? "var(--acc)" : "var(--txl)" }}>
                                {gDone}/{g.lessons.length}
                              </span>
                            </button>
                          )}
                          {!gShut && g.lessons.map((l) => {
                            const k = lessonKey(l);
                            const on = k === selK;
                            const seen = readSet.has(k);
                            return (
                              <button key={k} onClick={() => openLesson(l)}
                                style={{ display: "flex", gap: 7, width: "100%", textAlign: "left", appearance: "none",
                                  border: 0, borderLeft: `2px solid ${on ? "var(--acc)" : "transparent"}`,
                                  cursor: "pointer", fontFamily: "inherit", padding: "7px 9px", marginBottom: 2,
                                  background: on ? "color-mix(in srgb, var(--acc) 7%, transparent)" : "transparent",
                                  color: on ? "var(--txb)" : seen ? "var(--txd)" : "var(--tx)",
                                  fontSize: "var(--t11)", lineHeight: 1.35 }}>
                                <span style={{ flex: "none", marginTop: 2, width: 8, textAlign: "center",
                                  fontSize: "var(--t9)", color: seen ? "var(--txl)" : "var(--acc)" }}>
                                  {seen ? "✓" : "●"}
                                </span>
                                <span style={{ minWidth: 0 }}>
                                  {l.title}
                                  <span style={{ display: "block", ...mono, fontSize: "var(--t9)", color: "var(--txl)", marginTop: 3,
                                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                    {scope === "*" && l.project ? `${l.project.split("/").pop()} · ` : `${l.file.slice(0, 4)} · `}
                                    {when(l.at)}
                                  </span>
                                </span>
                              </button>
                            );
                          })}
                        </div>
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
                  ? <Quiz title={sel!.title} concept={sel!.concept} question={question} onReveal={reveal} onSkip={() => gradeCard("skip")} />
                  : (
                    <>
                      <LessonHead sel={sel!} scope={scope} />
                      <Markdown>{body}</Markdown>
                    </>
                  )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** The over-line above a lesson's markdown: which concept it belongs to, which
 *  repo it came from, how old it is. The body's own H1 carries the title. */
function LessonHead({ sel, scope }: { sel: Lesson; scope: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
      <span style={{ ...label, color: "var(--acc)" }}>{sel.concept || "unsorted"}</span>
      <span style={{ ...mono, fontSize: "var(--t9)", color: "var(--txl)" }}>
        {scope === "*" && sel.project ? `${sel.project.split("/").pop()} · ` : ""}{when(sel.at)}
      </span>
    </div>
  );
}

/** An unread lesson, asked before it is answered. The question is the lesson's
 *  own closing line — it was always there, at the bottom, after the answer.
 *  Framed as a panel because it is the one thing on the tab worth stopping at. */
function Quiz({ title, concept, question, onReveal, onSkip, cta = "SHOW THE LESSON" }: {
  title: string; concept: string; question: string; onReveal: () => void;
  onSkip: () => void; cta?: string;
}) {
  return (
    <div className="panel" style={{ border: line, background: "color-mix(in srgb, var(--panel2) 40%, transparent)",
      padding: "20px 20px 22px", maxWidth: 620, display: "flex", flexDirection: "column", gap: 14 }}>
      <span style={{ ...label, color: "var(--acc)" }}>{concept || "new lesson"}</span>
      <span style={{ fontSize: "var(--t15)", lineHeight: 1.35, color: "var(--txb)" }}>{title}</span>
      <div style={{ height: 1, background: "linear-gradient(90deg,var(--acc),color-mix(in srgb, var(--acc) 5%, transparent))",
        transformOrigin: "left", animation: "drawline .7s ease both" }} />
      <div>
        <span style={{ ...label, color: "var(--txd)", display: "block", marginBottom: 8 }}>CAN YOU ANSWER THIS?</span>
        <span style={{ ...mono, fontSize: "var(--t13)", lineHeight: 1.6, color: "var(--tx)" }}>{question}</span>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={onReveal} style={btnHero}>{cta}</button>
        <button onClick={onSkip} style={btn} title="I already know this — retire it">SKIP</button>
      </div>
    </div>
  );
}

/** STUDY — the unread ones dealt one at a time. The list is what you use when
 *  you know which lesson you want; this is for the ninety you don't. */
function StudyRun({ left, due, done, sel, body, gated, question, scope, onReveal, onGrade, onSkip, onExit }: {
  left: number; due: number; done: boolean; sel?: Lesson; body: string | null;
  gated: boolean; question: string; scope: string;
  onReveal: () => void; onGrade: (v: "got" | "review") => void;
  onSkip: () => void; onExit: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, flex: 1, minHeight: 0 }}>
      <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 9 }}>
        <span style={{ ...label, color: "var(--acc)" }}>STUDY RUN</span>
        <span style={{ ...mono, fontSize: "var(--t95)", color: "var(--txm)" }}>{due} DUE · {left} NEW</span>
        <span style={{ flex: 1 }} />
        <button onClick={onExit} style={{ ...btn, padding: "3px 9px" }}>✕ DONE</button>
      </div>
      <div className="mscroll" style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {done || !sel ? (
          <div className="panel" style={{ border: line, padding: "20px 18px", maxWidth: 520 }}>
            <div style={{ ...label, color: "var(--acc)", marginBottom: 9 }}>DECK CLEAR</div>
            <div style={{ ...mono, fontSize: "var(--t12)", lineHeight: 1.6, color: "var(--txm)", fontStyle: "italic", marginBottom: 14 }}>
              every lesson read. the next turn writes the next one.
            </div>
            <button onClick={onExit} style={btnHero}>BACK TO THE SHELVES</button>
          </div>
        ) : body === null ? (
          <div style={{ ...mono, color: "var(--txd)" }}>dealing…</div>
        ) : gated ? (
          <Quiz title={sel.title} concept={sel.concept} question={question} onReveal={onReveal} onSkip={onSkip} cta="REVEAL" />
        ) : (
          <div style={{ maxWidth: 720 }}>
            <LessonHead sel={sel} scope={scope} />
            <Markdown>{body}</Markdown>
            <div style={{ marginTop: 18, paddingTop: 14, borderTop: line, display: "flex", gap: 8 }}>
              <button onClick={() => onGrade("got")} style={btnHero}>GOT IT ▸</button>
              <button onClick={() => onGrade("review")} style={btn}>REVIEW AGAIN · 1D</button>
            </div>
          </div>
        )}
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
        <span style={{ fontSize: "var(--t105)", letterSpacing: 2.5, color: "var(--txl)" }}>LEARN</span>
      </div>
      <div style={{ height: 1, background: "linear-gradient(90deg,var(--acc),color-mix(in srgb, var(--acc) 5%, transparent))",
        transformOrigin: "left", animation: "drawline .7s ease both .16s", flex: "none" }} />
      <div style={{ flex: 1, minHeight: 0, padding: 11 }}>
        {/* No `key={project}`: remounting on every session switch is what threw
            away the reading position in the first place. */}
        <LearnTab project={project ?? ""} compact allowAll read={read} onRead={onRead} />
      </div>
    </div>
  );
}
