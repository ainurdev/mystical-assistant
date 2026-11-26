// What a view's comments look like in an exported picture, where nothing can be hovered: a
// number on what each comment is about, and the comments listed under it by those numbers.
// Used by the flow diagram (components/DataView). The same file is in both apps.

/** A numbered marker in an SVG drawing. */
export function Mark({ x, y, n }: { x: number; y: number; n: number }) {
  const r = n > 9 ? 8 : 7;
  return (
    <g>
      <circle cx={x} cy={y} r={r} className="dv-mark" />
      <text x={x} y={y + 3.5} textAnchor="middle" className="dv-mark-n">{n}</text>
    </g>
  );
}

/** The comments under the picture, by the numbers on it. */
export function NoteList({ notes }: { notes: { n: number; title: string; text: string }[] }) {
  return (
    <div className="dv-notes">
      {notes.map((m) => (
        <div key={m.n} className="dv-note-row">
          <span className="dv-note-n">{m.n}</span>
          <div><div className="dv-note-title">{m.title}</div><div className="dv-note-text">{m.text}</div></div>
        </div>
      ))}
    </div>
  );
}

