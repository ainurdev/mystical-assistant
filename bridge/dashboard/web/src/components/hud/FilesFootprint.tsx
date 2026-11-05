import { FileIcon } from "../../lib/fileicon";
import { footprint } from "../../lib/footprint";
import { RailHero } from "./RailHero";

/* The Files tab's hero: where this session's writes landed, one bar of folders
   (each its own theme colour; the 5th is "other") and the last three files
   written, a green dot on the one a running turn is writing now. */
const COLORS = ["var(--acc)", "var(--info, var(--acc2, var(--acc)))", "var(--purple)", "var(--txl)", "color-mix(in srgb, var(--txl) 50%, transparent)"];

export function FilesFootprint({ edited, now }: { edited: Set<string>; now: string | null }) {
  const f = footprint(edited, now, "");
  const label = f.total
    ? `This session touched ${f.total} ${f.total === 1 ? "file" : "files"} in ${f.folders.map((x) => `${x.name} ${x.count}`).join(", ")}${now ? `. Writing ${now.split("/").pop()} now` : ""}`
    : "Nothing touched yet";
  return (
    <RailHero label={label} top={<>
      <span className="ff-k">This session touched</span>
      <span className="ff-n"><b>{f.total}</b> {f.total === 1 ? "file" : "files"}</span>
    </>}>
      <div className="ff-bar" aria-hidden>
        {f.folders.map((x, i) => <i key={x.name} style={{ flex: x.count, background: COLORS[i] }} />)}
      </div>
      <div className="ff-leg" aria-hidden>
        {f.total ? f.folders.map((x, i) => (
          <span key={x.name}><i style={{ background: COLORS[i] }} />{x.name} <b>{x.count}</b></span>
        )) : <span>nothing touched yet</span>}
      </div>
      <div className="ff-cap" aria-hidden>
        {f.recent.map((r) => (
          <span key={r.name} className="ff-chip"><FileIcon name={r.name} size={10} />{r.name}{r.now && <em className="ff-live">●</em>}</span>
        ))}
      </div>
    </RailHero>
  );
}
