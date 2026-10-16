import { lazy, Suspense, useState } from "react";
import { projectLogoUrl } from "../../api";
import { useLogoInfo } from "../../lib/logoinfo";
import { projectInitials, projectMark, projectTint } from "../../lib/surfaces";

// The icon set loads on first use, one chunk per icon, so a sidebar of three
// icon tiles costs three tiny files, not all of lucide.
const DynamicIcon = lazy(() => import("lucide-react/dynamic").then((m) => ({ default: m.DynamicIcon })));

/** A project's tile: its mark (bridge/projectmarks.py) on a square of its own
 *  tint. That is its logo, its icon, or its initials (the default). The tint
 *  rides in as --pc and the stylesheet owns everything else: the AURORA
 *  silhouette, paper. An icon shows the initials until it has loaded. */
export function ProjectTile({ project }: { project: string | null | undefined }) {
  const mark = projectMark(project);
  const pc = projectTint(project).color;
  const letters = projectInitials(project);
  if (mark?.kind === "logo" && mark.logo) return <LogoTile key={mark.logo} name={mark.logo} pc={pc} letters={letters} />;
  return (
    <b className="ptile" aria-hidden data-kind={mark?.kind === "icon" ? "icon" : undefined}
      style={{ ["--pc" as string]: pc }}>
      {mark?.kind === "icon" && mark.icon ? (
        <Suspense fallback={letters}>
          <DynamicIcon name={mark.icon as never} fallback={() => <>{letters}</>} />
        </Suspense>
      ) : letters}
    </b>
  );
}

/** A logo as it is, with nothing behind it. In AURORA it turns to phosphor,
 *  and a square one (lib/logoinfo's `fill`) keeps its lettering by its own
 *  lightness. A logo the bridge can't serve (lost in a move, say) falls back
 *  to the initials. */
function LogoTile({ name, pc, letters }: { name: string; pc: string; letters: string }) {
  const src = projectLogoUrl(name);
  const info = useLogoInfo(name, src);
  const [broken, setBroken] = useState(false);
  if (broken) return <b className="ptile" aria-hidden style={{ ["--pc" as string]: pc }}>{letters}</b>;
  return (
    <b className="ptile" aria-hidden data-kind="logo" data-logo={info?.fill ? "fill" : undefined}
      style={{ ["--pc" as string]: pc, ["--logo" as string]: `url("${src}")` }}>
      <img src={src} alt="" draggable={false} onError={() => setBroken(true)} />
    </b>
  );
}
