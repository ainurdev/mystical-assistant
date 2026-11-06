import { useEffect, useMemo, useState } from "react";
import { FileIcon } from "../../lib/fileicon";
import { writing } from "../../lib/writing";

/* FILES' head card: the newest edit the opened session's turn landed, its last
   changed lines and a way to the file. An edit's text arrives with the edit
   (lib/writing), so it follows edit by edit. WRITING while the turn runs, WROTE
   for the minute after; nothing otherwise. It ticks on its own so the panel's
   tree never re-renders for a clock. */
const ago = (s: number) => (s < 90 ? `${Math.max(0, Math.round(s))}s` : `${Math.round(s / 60)}m`);

export function WritingCard({ turns, root, onOpen }: {
  turns: Parameters<typeof writing>[0]; root: string | null | undefined; onOpen: (path: string) => void;
}) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => { const i = setInterval(() => setNow(Date.now() / 1000), 5000); return () => clearInterval(i); }, []);
  useEffect(() => { setNow(Date.now() / 1000); }, [turns]);
  const w = useMemo(() => writing(turns, root, now), [turns, root, now]);
  if (!w) return null;
  return (
    <div className="wr-card" role="group" aria-label={`${w.live ? "Writing" : "Wrote"} ${w.path}`}>
      <div className="wr-h">
        <span className="wr-badge"><FileIcon name={w.name} size={13} /></span>
        <b className="wr-name" title={w.path}>{w.name}</b>
        <small className="wr-dir">{w.dir}</small>
        <span className={`wr-k${w.live ? " live" : ""}`}>{w.live && <i className="wr-dot" />}{w.live ? "WRITING" : "WROTE"}</span>
      </div>
      <pre className="wr-pre">
        {w.lines.map((l, i) => (
          <span key={i} className={l.sign === "+" ? "ad" : "dl"}>
            <em className="wr-ln">{l.n ?? ""}</em><em className="wr-sg">{l.sign === "-" ? "−" : l.sign}</em>{l.text}
          </span>
        ))}
      </pre>
      <button className="wr-f" onClick={() => onOpen(w.path)}>
        <span>{w.line != null ? `Open at line ${w.line} ›` : "Open ›"}</span>
        <span className="wr-when">turn {w.turn} · {w.live ? "now" : `${ago(now - w.at)} ago`}</span>
      </button>
    </div>
  );
}
