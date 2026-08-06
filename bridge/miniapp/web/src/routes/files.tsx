import { Suspense, lazy, useMemo, useState } from "react";
import { createRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, Search, FileCode } from "lucide-react";
import { rootRoute } from "./root";
import { api, ApiError } from "../lib/api";
import { Banner, Button, Skeleton } from "../components/ui";

const CodeEditor = lazy(() => import("../components/CodeEditor"));

// A tree is fiddly to tap through on a phone, so this is a flat path list with
// a filter box — the same thing Ctrl-P does on the dashboard.
const SHOWN = 200;

function FileList({ onPick }: { onPick: (path: string) => void }) {
  const [q, setQ] = useState("");
  const { data, isLoading, isError } = useQuery({
    queryKey: ["files"],
    queryFn: () => api.getFiles(),
  });

  const matches = useMemo(() => {
    const files = data?.files ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return files;
    return files.filter((p) => p.toLowerCase().includes(needle));
  }, [data, q]);

  if (isError) return <Banner tone="error">Could not list files.</Banner>;

  return (
    <div className="space-y-3 pb-24">
      <div className="flex items-center gap-2 rounded-xl bg-[var(--tg-secondary-bg)] px-3 py-2">
        <Search size={15} className="shrink-0 text-[var(--tg-hint)]" aria-hidden />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter files…"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          aria-label="Filter files"
        />
        {!isLoading && (
          <span className="shrink-0 text-xs text-[var(--tg-hint)]">{matches.length}</span>
        )}
      </div>

      {isLoading &&
        [0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-9 w-full rounded-lg" />)}

      {!isLoading && matches.length === 0 && (
        <div className="pt-10 text-center text-sm text-[var(--tg-hint)]">
          {data?.files.length ? "No file matches that." : "No files here."}
        </div>
      )}

      {matches.slice(0, SHOWN).map((p) => {
        const name = p.split("/").pop() ?? p;
        const dir = p.slice(0, p.length - name.length).replace(/\/$/, "");
        return (
          <button
            key={p}
            onClick={() => onPick(p)}
            className="flex w-full items-center gap-2 rounded-lg bg-[var(--tg-secondary-bg)] px-3 py-2 text-left active:opacity-70"
          >
            <FileCode size={15} className="shrink-0 text-[var(--brand-soft)]" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-sm">{name}</span>
              {dir && (
                <span className="block truncate text-[11px] text-[var(--tg-hint)]">{dir}</span>
              )}
            </span>
          </button>
        );
      })}

      {matches.length > SHOWN && (
        <div className="pt-1 text-center text-xs text-[var(--tg-hint)]">
          {matches.length - SHOWN} more — keep typing to narrow it down.
        </div>
      )}
    </div>
  );
}

function FileView({ path, onBack }: { path: string; onBack: () => void }) {
  const [text, setText] = useState<string | null>(null);   // null until edited
  const [saved, setSaved] = useState<string | null>(null); // last write, if any
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");

  const { data, isLoading, isError } = useQuery({
    queryKey: ["file", path],
    queryFn: () => api.readFile(path),
    // The buffer is seeded from this, so re-fetching under the user would
    // silently discard their edits.
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });

  // What the editor was seeded with stays fixed for the life of the buffer —
  // changing it would remount CodeMirror and throw away the cursor. The dirty
  // check compares against the last write instead.
  const initial = data?.content ?? "";
  const dirty = text !== null && text !== (saved ?? initial);
  const editable = !!data?.ok && !data.binary && !data.too_large;

  async function save() {
    if (text === null || saving) return;
    setSaving(true);
    setNote("");
    try {
      await api.writeFile(path, text);
      setSaved(text);
      setNote(`Saved ${path.split("/").pop()}`);
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex items-center gap-2">
        <button onClick={onBack} aria-label="Back to files" className="-ml-1 shrink-0 p-1 active:opacity-70">
          <ChevronLeft size={18} className="text-[var(--tg-hint)]" aria-hidden />
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs" dir="rtl">{path}</span>
        {editable && (
          <Button
            onClick={() => void save()}
            disabled={!dirty || saving}
            className="shrink-0 px-3 py-1.5 text-xs disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        )}
      </div>

      {note && <div className="mb-2 text-xs text-[var(--tg-hint)]">{note}</div>}
      {isLoading && <Skeleton className="h-64 w-full rounded-xl" />}
      {isError && <Banner tone="error">Could not open that file.</Banner>}
      {data && !data.ok && <Banner tone="error">{data.error || "Could not open that file."}</Banner>}

      {data?.image && (
        <img src={data.image} alt={path} className="max-h-[70vh] w-full rounded-xl object-contain" />
      )}
      {data?.ok && !data.image && !editable && (
        <div className="pt-10 text-center text-sm text-[var(--tg-hint)]">
          {data.too_large ? "Over 1 MB — too large to edit here." : "Binary file."}
        </div>
      )}

      {editable && (
        <div className="h-[70vh] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--tg-secondary-bg)]">
          <Suspense fallback={<Skeleton className="h-full w-full" />}>
            <CodeEditor path={path} initial={initial} onChange={setText} />
          </Suspense>
        </div>
      )}
    </div>
  );
}

function FilesPage() {
  const [path, setPath] = useState<string | null>(null);
  const { data } = useQuery({ queryKey: ["state"], queryFn: () => api.getState() });
  if (path) return <FileView path={path} onBack={() => setPath(null)} />;
  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-2.5">
        <span className="text-[13px] tracking-[3px] text-foreground-bright">REPO</span>
        <span className="truncate text-[10px] tracking-wider text-[var(--tg-hint)]">
          {(data?.project?.rel ?? "NO PROJECT").toUpperCase()}
        </span>
      </div>
      <FileList onPick={setPath} />
    </div>
  );
}

export const filesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/repo",
  component: FilesPage,
});
