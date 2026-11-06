// The .mystical panel, the pure half: bridge/mystical_dir.py sorts the folder by kind and
// owns what can go. This file only arranges the answer and says the sentence that asks.
// No React and no fetch: mysticaldir.check.ts runs it on its own.

export interface DirEntry {
  name: string; path: string; dir: boolean; bytes: number; at: number; files: number; kind: string; keep: boolean;
  preview: "image" | "text" | "none"; deletable: boolean;
}
export interface DirListing {
  root: string | null; total: number; entries: DirEntry[]; groups: Record<string, { bytes: number; count: number }>;
  sub?: string; stale?: string[];
}
export interface DirScope { project?: string | null; session?: string | null }

export const KINDS: { kind: string; label: string; about: string }[] = [
  { kind: "images", label: "Images", about: "Pictures in your messages. Old chats show them." },
  { kind: "docs", label: "Docs", about: "Reports and other Markdown written to be read." },
  { kind: "drafts", label: "Drafts", about: "Design drafts and mockups." },
  { kind: "scratch", label: "Scratch", about: "Throwaway scripts, probes and downloads." },
  { kind: "learn", label: "Learn", about: "Saved lessons." },
  { kind: "bridge", label: "Bridge", about: "Mystical's own files. They can't be deleted here." },
  { kind: "other", label: "Other", about: "Anything that fits no kind." },
];

export interface DirGroup { kind: string; label: string; about: string; bytes: number; count: number; files: number; entries: DirEntry[] }

export function groupEntries(list: Pick<DirListing, "entries">): DirGroup[] {
  const known = new Set(KINDS.map((k) => k.kind));
  const extra = [...new Set(list.entries.map((e) => e.kind))].filter((k) => !known.has(k))
    .map((kind) => ({ kind, label: kind.charAt(0).toUpperCase() + kind.slice(1), about: "" }));
  return [...KINDS, ...extra].map((k) => {
    const entries = list.entries.filter((e) => e.kind === k.kind);
    return { ...k, entries, count: entries.length, bytes: entries.reduce((s, e) => s + e.bytes, 0), files: entries.reduce((s, e) => s + e.files, 0) };
  }).filter((g) => g.count > 0);
}

/** A group that's one folder ("images/") opens straight on what's inside. */
export const soleFolder = (g: Pick<DirGroup, "entries">): DirEntry | null =>
  (g.entries.length === 1 && g.entries[0].dir ? g.entries[0] : null);

/** Keep only protects from the bulk clear, and that takes a direct child of scratch or a
 *  top-level other. Anywhere else the mark would be a switch that does nothing. */
export function keepWorks(e: Pick<DirEntry, "kind" | "path">): boolean {
  const depth = e.path.split("/").length;
  return (e.kind === "scratch" && depth === 2) || (e.kind === "other" && depth === 1);
}

export function deleteAsk(e: Pick<DirEntry, "name" | "kind" | "dir" | "files">): { text: string; ok: string; confirm: boolean } {
  const what = e.dir ? `${e.name}/ and the ${e.files === 1 ? "file" : `${e.files} files`} in it` : e.name;
  if (e.kind === "images") {
    return { text: `Delete ${what}? Old chats show ${e.dir ? "these images" : "this image"}, and they'll show a gap where it was. It doesn't go to the Trash.`, ok: "Delete", confirm: true };
  }
  return { text: `Delete ${what}? It doesn't go to the Trash.`, ok: "Delete", confirm: false };
}

/** Images go through the chat's route, which only serves picture types from inside the
 *  project, so a preview needs no route of its own. */
export function imageUrl(path: string, scope: DirScope): string {
  const q = new URLSearchParams({ path: `.mystical/${path}` });
  if (scope.project) q.set("project", scope.project);
  else if (scope.session) q.set("session", scope.session);
  return `/local/chat-images/file?${q}`;
}

export function dirQuery(scope: DirScope, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams(extra);
  if (scope.project) q.set("project", scope.project);
  else if (scope.session) q.set("session", scope.session);
  return `?${q}`;
}
export function dirBody(scope: DirScope): { project?: string; session_id?: string } {
  if (scope.project) return { project: scope.project };
  return scope.session ? { session_id: scope.session } : {};
}

export const isMarkdown = (name: string) => /\.(md|markdown)$/i.test(name);
export const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Another surface, one window: the right rail and SETTINGS ▸ SYSTEM ▸ STORAGE both ask for
 *  it, and App holds the one host. */
export const OPEN_MYSTICAL = "hud:mystical";
export function openMysticalPanel(scope: DirScope): void {
  window.dispatchEvent(new CustomEvent<DirScope>(OPEN_MYSTICAL, { detail: scope }));
}
