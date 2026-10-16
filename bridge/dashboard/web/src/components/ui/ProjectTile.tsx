import { lazy, Suspense } from "react";
import { projectLogoUrl } from "../../api";
import { useLogoInfo } from "../../lib/logoinfo";
import { projectInitials, projectMark, projectTint } from "../../lib/surfaces";

// The icon set loads on first use, one chunk per icon, so a sidebar of three
// icon tiles costs three tiny files, not all of lucide.
const DynamicIcon = lazy(() => import("lucide-react/dynamic").then((m) => ({ default: m.DynamicIcon })));

/** A project's tile: its mark (bridge/projectmarks.py) on a square of its own
 *  tint. That is its logo, its icon, or its initials (the default). The tint
 *  rides in as --pc and the stylesheet owns everything else: plates, the
 *  AURORA silhouette, paper. An icon shows the initials until it has loaded. */
export function ProjectTile({ project }: { project: string | null | undefined }) {
  const mark = projectMark(project);
  const pc = projectTint(project).color;
  const letters = projectInitials(project);
  if (mark?.kind === "logo" && mark.logo) return <LogoTile name={mark.logo} plate={mark.plate} pc={pc} />;
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

/** A logo on the plate its own pixels ask for (lib/logoinfo): a square one
 *  fills the tile, a dark see-through one gets a light plate on a dark ground
 *  and the reverse on paper. A plate the editor fixed wins. */
function LogoTile({ name, plate, pc }: { name: string; plate?: "light" | "dark"; pc: string }) {
  const src = projectLogoUrl(name);
  const info = useLogoInfo(name, src);
  return (
    <b className="ptile" aria-hidden data-kind="logo" data-plate={plate}
      data-logo={info ? (info.fill ? "fill" : info.dark ? "dark" : "light") : undefined}
      style={{ ["--pc" as string]: pc, ["--logo" as string]: `url("${src}")` }}>
      <img src={src} alt="" draggable={false} />
    </b>
  );
}
