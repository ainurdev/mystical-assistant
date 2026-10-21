import { useState } from "react";
import { DynamicIcon } from "lucide-react/dynamic";
import { projectLogoUrl, type ProjectMark } from "../../api";
import { inkCss } from "../../lib/ink";
import { useLogoInfo } from "../../lib/logoinfo";
import { hashTint, isSelfProject, projectInitials, projectMark, projectTint } from "../../lib/surfaces";

// Each icon's drawing loads on first use, one tiny file per icon. A file a
// rebuild has since replaced fails inside DynamicIcon, which keeps the
// initials. The component itself is not lazy: a lazy chunk that went stale
// under an open page threw, and with no boundary that blanked the whole
// dashboard (2026-10-16).

/** A project's tile: its mark (bridge/projectmarks.py) on a square of its own
 *  tint. That is its logo, its icon, or its initials (the default). The tint
 *  rides in as --pc and the stylesheet owns everything else: the AURORA
 *  silhouette, paper. An icon shows the initials until it has loaded.
 *  `mark` draws another mark for the project: what it wore before, or one it
 *  could wear (STYLE WITH AI's list of changes). */
export function ProjectTile({ project, mark: other }: { project: string | null | undefined; mark?: ProjectMark | null }) {
  const mark = other === undefined ? projectMark(project) : other;
  const pc = other === undefined ? projectTint(project).color : inkCss(other?.color || hashTint(project));
  const letters = projectInitials(project);
  if (mark?.kind === "logo" && mark.logo) return <LogoTile key={mark.logo} name={mark.logo} pc={pc} letters={letters} plate={mark.plate} self={isSelfProject(project)} />;
  return (
    <b className="ptile" aria-hidden data-kind={mark?.kind === "icon" ? "icon" : undefined}
      style={{ ["--pc" as string]: pc }}>
      {mark?.kind === "icon" && mark.icon ? (
        <DynamicIcon name={mark.icon as never} fallback={() => <>{letters}</>} />
      ) : letters}
    </b>
  );
}

/** A logo as it is, or on a pinned background. With none stored (AUTO) it
 *  carries lib/logoinfo's night/day readings and index.css plates it only on
 *  the ground it would vanish into. In AURORA it turns to phosphor,
 *  and a square one (lib/logoinfo's `fill`) keeps its lettering by its own
 *  lightness. A logo the bridge can't serve (lost in a move, say) falls back
 *  to the initials. */
function LogoTile({ name, pc, letters, plate, self }: { name: string; pc: string; letters: string; plate?: string; self?: boolean }) {
  const src = projectLogoUrl(name);
  const info = useLogoInfo(name, src);
  const [broken, setBroken] = useState(false);
  if (broken) return <b className="ptile" aria-hidden style={{ ["--pc" as string]: pc }}>{letters}</b>;
  return (
    <b className="ptile" aria-hidden data-kind="logo" data-logo={info?.fill ? "fill" : undefined} data-self={self || undefined}
      data-plate={plate === "light" || plate === "dark" ? plate : undefined}
      data-auto-n={(!plate && info?.night) || undefined} data-auto-d={(!plate && info?.day) || undefined}
      style={{ ["--pc" as string]: pc, ["--logo" as string]: `url("${src}")` }}>
      <img src={src} alt="" draggable={false} onError={() => setBroken(true)} />
      {self && <SelfMark />}
    </b>
  );
}

/** Our own logo, the bridge's emblem, drawn in the theme's ink: the frame in
 *  your colour, the heart in the family's crest. Hidden unless a family shows
 *  it in place of the logo file (MIDDLE-EARTH, index.css). */
function SelfMark() {
  return (
    <svg className="ptile-em" viewBox="0 0 100 100" aria-hidden>
      <rect x="27" y="27" width="46" height="46" rx="4" fill="none" stroke="var(--acc)" strokeWidth="9" transform="rotate(45 50 50)" />
      <rect x="40" y="40" width="20" height="20" rx="2" fill="var(--crest, var(--purple))" transform="rotate(45 50 50)" />
    </svg>
  );
}
