import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { codeTokens, type Tok } from "../lib/codetok";
import {
  commentSpans, diffLines, DIFF_MODES, lines, pieces, splitRows, tokLines, unifiedRows,
  type DiffComment, type DiffFile, type DiffMode, type Line, type Piece,
} from "../lib/codediff";
import type { DiffEv } from "../lib/dataview";
import { useViewPrefs } from "../lib/viewprefs";
import { NoteList } from "./ViewNotes";

// Code an agent is explaining, as a diff or as plain code, with its comments on the lines and
// characters they're about (show_diff, bridge/data_views.py _diff). The same file is in both apps.
//
// Three ways to read a diff, and which one is the user's setting for every diff everywhere
// (lib/viewprefs), not the agent's: unified (one column, - and +), side by side (old facing new,
// line for line), and the two versions side by side as plain code. Code without a change is one
// column whatever the setting.
//
// A comment is a dotted underline on just what it's about, with a dot in the gutter of its line;
// hovering, tapping or tabbing to either shows it. Exported with comments, each gets a number
// where it ends and the list goes under the code, since a picture has no hover.
//
// Long lines wrap rather than scroll: side by side halves the width, and on a phone a sideways
// scroll inside a vertical one is a trap.

const MODE_LABEL: Record<DiffMode, string> = { unified: "UNIFIED", split: "SIDE BY SIDE", code: "OLD · NEW" };
const MODE_TIP: Record<DiffMode, string> = {
  unified: "One column: removed lines, then what replaced them",
  split: "Old on the left, new on the right, line for line",
  code: "The two versions side by side, as plain code",
};

type Tip = { left: number; top: number; notes: { title: string; text: string }[] };
type Said = { file: number; i: number };                 // a comment: its file, its index there
type Numbered = Map<string, number>;                     // `${file}:${i}` -> its number when exported

/** One file's tokens per line, old and new, once the grammar has loaded (none on the Mini App). */
function useToks(f: DiffFile) {
  const [toks, setToks] = useState<{ old: Tok[][] | null; new: Tok[][] | null }>({ old: null, new: null });
  useEffect(() => {
    let live = true;
    void Promise.all([f.old === null ? null : codeTokens(f.old, f.language, f.path), codeTokens(f.new, f.language, f.path)])
      .then(([o, n]) => { if (live) setToks({ old: tokLines(o), new: tokLines(n) }); }, () => {});
    return () => { live = false; };
  }, [f]);
  return toks;
}

/** The comments on one line, from every side it's on (an unchanged line in a unified diff is
 *  both old and new): which characters, which comment, and whether it ends here. */
function notesOn(f: DiffFile, fi: number, at: [("old" | "new"), number | null][], len: number) {
  return at.flatMap(([side, no]) => commentSpans(f.comments, side, no, len)
    .map((n) => ({ span: n.span, key: `${fi}:${n.i}`, end: no === f.comments[n.i].to[0] })));
}

function Code({ text, toks, words, notes, numbered }: {
  text: string; toks: Tok[] | null; words: [number, number][]; notes: ReturnType<typeof notesOn>; numbered: Numbered | null;
}) {
  const ps: Piece[] = pieces(text, toks, words, notes.map((n, i) => ({ span: n.span, i })));
  // Where each comment ends on this line, for its number in an export.
  const ends = new Map<string, number>();
  if (numbered) for (const n of notes) if (n.end) ends.set(n.key, n.span[1]);
  let at = 0;
  const out: ReactNode[] = [];
  const flush = (upto: number) => {
    for (const [key, end] of ends) if (end <= upto) { out.push(<span key={`m${key}`} className="dv-note-n dv-note-inline">{numbered!.get(key)}</span>); ends.delete(key); }
  };
  ps.forEach((p, k) => {
    const said = [...new Set(p.notes.map((i) => notes[i].key))];
    const cls = [p.cls, p.changed ? "dv-word" : "", said.length ? "dv-said-at" : ""].filter(Boolean).join(" ");
    out.push(cls ? <span key={k} className={cls} data-notes={said.length ? said.join(" ") : undefined}>{p.text}</span> : <Fragment key={k}>{p.text}</Fragment>);
    at += p.text.length;
    flush(at);
  });
  flush(Infinity);
  return <span className="dv-code-text">{out.length ? out : "\u200b"}</span>;
}

/** A line's tokens, by its number on a side. */
const tokAt = (toks: Tok[][] | null, no: number | null, start: number) => (no === null || !toks ? null : toks[no - start] ?? null);

/** The gutter: the line's number, and a dot when a comment is on it. */
function Gutter({ no, side, f, fi }: { no: number | null; side: "old" | "new"; f: DiffFile; fi: number }) {
  const on = no === null ? [] : f.comments.flatMap((c, i) => (c.side === side && no >= c.from[0] && no <= c.to[0] && no === c.from[0] ? [i] : []));
  return (
    <span className="dv-code-no">
      {no ?? ""}
      {on.length ? <button type="button" className="dv-code-dot" aria-label={`${on.length === 1 ? "A comment" : `${on.length} comments`} on line ${no}`}
        data-notes={on.map((i) => `${fi}:${i}`).join(" ")} /> : null}
    </span>
  );
}

const SIGN = { same: " ", del: "−", add: "+" };

function LineRow({ l, f, fi, toks, numbered }: { l: Line; f: DiffFile; fi: number; toks: { old: Tok[][] | null; new: Tok[][] | null }; numbered: Numbered | null }) {
  const side = l.kind === "del" ? "old" : "new";
  const no = side === "old" ? l.o : l.n;
  const sides: ["old" | "new", number | null][] = l.kind === "same" ? [["old", l.o], ["new", l.n]] : [[side, no]];
  return (
    <div className="dv-code-row" data-kind={l.kind}>
      <Gutter no={l.o} side="old" f={f} fi={fi} />
      <Gutter no={l.n} side="new" f={f} fi={fi} />
      <span className="dv-code-sign" aria-hidden>{SIGN[l.kind]}</span>
      <Code text={l.text} toks={tokAt(toks[side], no, side === "old" ? f.old_start : f.new_start)} words={l.words}
        notes={notesOn(f, fi, sides, l.text.length)} numbered={numbered} />
    </div>
  );
}

function GapRow({ n, open, cols }: { n: number; open: () => void; cols?: boolean }) {
  return (
    <div className="dv-code-row dv-code-gap" data-cols={cols || undefined}>
      <button type="button" onClick={open}>⋯ {n} unchanged line{n === 1 ? "" : "s"}</button>
    </div>
  );
}

function FileBody({ f, fi, mode, numbered }: { f: DiffFile; fi: number; mode: DiffMode; numbered: Numbered | null }) {
  const toks = useToks(f);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const open = (id: string) => setOpened((s) => new Set(s).add(id));
  const ls = useMemo(() => (f.old === null ? null : lines(f, diffLines(f.old.split("\n"), f.new.split("\n")))), [f]);
  if (ls === null || mode === "code") {
    const pane = (text: string, side: "old" | "new", start: number, changed: Set<number>) => (
      <div className="dv-code-pane">
        {f.old !== null ? <div className="dv-code-side">{side === "old" ? "OLD" : "NEW"}</div> : null}
        {text.split("\n").map((t, i) => (
          <div key={i} className="dv-code-row" data-kind={changed.has(start + i) ? (side === "old" ? "del" : "add") : "same"}>
            <Gutter no={start + i} side={side} f={f} fi={fi} />
            <Code text={t} toks={tokAt(toks[side], start + i, start)} words={[]} notes={notesOn(f, fi, [[side, start + i]], t.length)} numbered={numbered} />
          </div>
        ))}
      </div>
    );
    const gone = new Set(ls?.filter((l) => l.kind === "del").map((l) => l.o!) ?? []);
    const came = new Set(ls?.filter((l) => l.kind === "add").map((l) => l.n!) ?? []);
    return f.old === null ? pane(f.new, "new", f.new_start, came)
      : <div className="dv-code-panes">{pane(f.old, "old", f.old_start, gone)}{pane(f.new, "new", f.new_start, came)}</div>;
  }
  if (mode === "split") {
    return (
      <div className="dv-code-split">
        {splitRows(f, ls).flatMap((r, k) => {
          if ("gap" in r) {
            if (!opened.has(r.id)) return [<GapRow key={k} n={r.gap} open={() => open(r.id)} cols />];
            return r.lines.map((l, j) => <SplitLine key={`${k}.${j}`} left={l} right={l} f={f} fi={fi} toks={toks} numbered={numbered} />);
          }
          return [<SplitLine key={k} left={r.left} right={r.right} f={f} fi={fi} toks={toks} numbered={numbered} />];
        })}
      </div>
    );
  }
  return (
    <div className="dv-code-unified">
      {unifiedRows(f, ls).flatMap((r, k) => {
        if ("gap" in r) {
          if (!opened.has(r.id)) return [<GapRow key={k} n={r.gap} open={() => open(r.id)} />];
          return r.lines.map((l, j) => <LineRow key={`${k}.${j}`} l={l} f={f} fi={fi} toks={toks} numbered={numbered} />);
        }
        return [<LineRow key={k} l={r} f={f} fi={fi} toks={toks} numbered={numbered} />];
      })}
    </div>
  );
}

function SplitLine({ left, right, f, fi, toks, numbered }: { left: Line | null; right: Line | null; f: DiffFile; fi: number; toks: { old: Tok[][] | null; new: Tok[][] | null }; numbered: Numbered | null }) {
  const half = (l: Line | null, side: "old" | "new") => (l ? (
    <>
      <Gutter no={side === "old" ? l.o : l.n} side={side} f={f} fi={fi} />
      <span className="dv-code-cell" data-kind={l.kind}>
        <Code text={l.text} toks={tokAt(toks[side], side === "old" ? l.o : l.n, side === "old" ? f.old_start : f.new_start)} words={l.words}
          notes={notesOn(f, fi, [[side, side === "old" ? l.o : l.n]], l.text.length)} numbered={numbered} />
      </span>
    </>
  ) : <><span className="dv-code-no" /><span className="dv-code-cell" data-kind="none" /></>);
  return <div className="dv-code-row">{half(left, "old")}{half(right, "new")}</div>;
}

export function DiffView({ ev, full, print, notes }: { ev: DiffEv; full: boolean; print?: boolean; notes?: boolean }) {
  const [prefs, setPrefs] = useViewPrefs();
  const host = useRef<HTMLDivElement | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const changes = ev.files.some((f) => f.old !== null);
  const mode: DiffMode = DIFF_MODES.includes(prefs.diff_mode) ? prefs.diff_mode : "unified";
  // Exported with comments: numbered in reading order, file by file.
  const numbered = useMemo<Numbered | null>(() => {
    if (!notes) return null;
    const order: Said[] = ev.files.flatMap((f, fi) => f.comments.map((_, i) => ({ file: fi, i }))
      .sort((a, b) => {
        const ca = f.comments[a.i], cb = f.comments[b.i];
        return (ca.side === cb.side ? 0 : ca.side === "old" ? -1 : 1) || ca.from[0] - cb.from[0] || ca.from[1] - cb.from[1];
      }));
    return new Map(order.map((s, k) => [`${s.file}:${s.i}`, k + 1]));
  }, [notes, ev]);
  const find = (key: string): DiffComment & { file: DiffFile } => {
    const [fi, i] = key.split(":").map(Number);
    return { ...ev.files[fi].comments[i], file: ev.files[fi] };
  };
  const show = (el: HTMLElement) => {
    const keys = (el.dataset.notes ?? "").split(" ").filter(Boolean);
    const box = host.current?.getBoundingClientRect(), r = el.getBoundingClientRect();
    if (!keys.length || !box) return;
    setTip({ left: Math.max(0, Math.min(r.left - box.left, box.width - 300)), top: r.bottom - box.top + 4,
      notes: keys.map((k) => { const c = find(k); return { title: `${c.file.path} · ${c.side === "old" ? "old " : ""}${at(c)}`, text: c.text }; }) });
  };
  const target = (e: React.SyntheticEvent) => (e.target as HTMLElement).closest?.("[data-notes]") as HTMLElement | null;
  return (
    <div className="dv-chart dv-diff" ref={host} data-mode={mode} data-full={full || undefined}
      onMouseOver={print ? undefined : (e) => { const t = target(e); if (t) show(t); else if (tip) setTip(null); }}
      onMouseLeave={() => setTip(null)}
      onFocus={print ? undefined : (e) => { const t = target(e); if (t) show(t); }}
      onBlur={() => setTip(null)}
      onClick={print ? undefined : (e) => { const t = target(e); if (t) { e.stopPropagation(); show(t); } }}>
      {!print && changes ? (
        <div className="dv-diff-bar">
          <div className="dv-seg" role="radiogroup" aria-label="How diffs read, in every chat">
            {DIFF_MODES.map((m) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} title={MODE_TIP[m]} className="dv-btn" onClick={() => setPrefs({ diff_mode: m })}>{MODE_LABEL[m]}</button>
            ))}
          </div>
          <span className="dv-diff-count"><b className="dv-add">+{ev.added}</b> <b className="dv-del">−{ev.removed}</b></span>
        </div>
      ) : null}
      <div className="dv-diff-files">
        {ev.files.map((f, fi) => (
          <section key={fi} className="dv-diff-file">
            <header className="dv-diff-path">
              <span>{f.path}</span>
              {f.comments.length ? <span className="dv-diff-said">{f.comments.length} comment{f.comments.length === 1 ? "" : "s"}</span> : null}
            </header>
            <FileBody f={f} fi={fi} mode={mode} numbered={numbered} />
          </section>
        ))}
      </div>
      {numbered?.size ? (
        <NoteList notes={[...numbered.entries()].sort((a, b) => a[1] - b[1]).map(([k, n]) => {
          const c = find(k);
          return { n, title: `${c.file.path} · ${c.side === "old" ? "old " : ""}${at(c)}`, text: c.text };
        })} />
      ) : null}
      {tip && !print ? (
        <div className="dv-tip dv-flow-tip" role="tooltip" style={{ left: tip.left, top: tip.top }}>
          {tip.notes.map((n, i) => (
            <div key={i} className={i ? "dv-diff-tip-more" : undefined}>
              <div className="dv-flow-tip-note">{n.title}</div>
              <div className="dv-diff-tip-text">{n.text}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Where a comment is, as the agent said it: "line 12", "lines 12-14", "2:20-3:4". */
function at(c: DiffComment): string {
  const said = c.at ?? `${c.from[0]}:${c.from[1]}-${c.to[0]}:${c.to[1]}`;
  return /^\d+$/.test(said) ? `line ${said}` : /^\d+-\d+$/.test(said) ? `lines ${said}` : said;
}
