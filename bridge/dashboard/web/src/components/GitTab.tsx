import { CommitGraph } from "./CommitGraph";

/* Source Control panel — graph only. The changed-file list and the commit box
   live in the CHANGES tab (FilesPanel). */

export function GitTab({ project }: { project: string | null }) {
  if (!project) return <div className="p-4 text-xs text-muted-foreground">No project selected.</div>;
  return (
    <div className="p-4 swapin">
      <CommitGraph project={project} />
    </div>
  );
}
