import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, File, FileText, Folder, MoreVertical, X } from "lucide-react";
import { createPortal } from "react-dom";
import { api } from "../../lib/api";
import {
  ago, canKeep, deleteWords, dirAddress, filesIn, fmtBytes, groupOpensFolder, KINDS, needsImageConfirm, staleRows,
  type DirEntry, type ToolScope,
} from "../../lib/agenttools";
import { useChatImage } from "../../lib/chatimg";
import { ImageLightbox } from "../ImageLightbox";
import { Markdown } from "../Markdown";
import { Btn, Confirm, Empty, Fail, Loading, RowError, Sheet, Sw, useAct, useBackLayer, messageOf } from "./parts";

/* .mystical: the current chat's project folder, by kind (bridge/mystical_dir.py).

   Thumbnails are the full image, through the authed blob loader (lib/chatimg), which holds
   what's on screen. So a folder draws a page at a time and the newest come first.
   ponytail: PAGE entries a page and no server-side thumbnails, so a page of phone photos
   is a page of full-size downloads. A thumbnail route is the fix if that shows up. */

const PAGE = 30;
const CLEAR_DAYS = 30;

const metaOf = (e: DirEntry) =>
  [fmtBytes(e.bytes), e.dir ? `${e.files} file${e.files === 1 ? "" : "s"}` : null, ago(e.at)].filter(Boolean).join(" · ");

function Thumb({ entry, scope, onOpen }: { entry: DirEntry; scope: ToolScope; onOpen: (url: string) => void }) {
  const look = useChatImage({ session: scope.session, project: scope.project }, dirAddress(entry.path));
  if (look.status === "found") {
    return (
      <button type="button" className="atv-thumb" aria-label={`Open ${entry.name}`} onClick={() => onOpen(look.url)}>
        <img src={look.url} alt="" />
      </button>
    );
  }
  return (
    <span className="atv-thumb" data-state={look.status} role="img" aria-label={look.status === "checking" ? "Loading image" : "Image not found"}>
      {look.status === "missing" ? <File size={16} aria-hidden /> : null}
    </span>
  );
}

function Reader({ entry, scope, onClose }: { entry: DirEntry; scope: ToolScope; onClose: () => void }) {
  useBackLayer(onClose);
  const q = useQuery({ queryKey: ["at-dir-read", scope.session, scope.project, entry.path], queryFn: () => api.mysticalRead(scope, entry.path) });
  const md = /\.(md|markdown)$/i.test(entry.name);
  return createPortal(
    <div className="atv-view" role="dialog" aria-label={entry.name} style={{ zIndex: 56 }}>
      <div className="atv-head">
        <span className="min-w-0 flex-1 truncate pl-3 text-[12px] text-[var(--txb)]">{entry.name}</span>
        <button type="button" onClick={onClose} aria-label="Close" className="flex h-11 w-11 flex-none items-center justify-center"><X size={17} aria-hidden /></button>
      </div>
      <div className="atv-body">
        {q.isLoading ? <Loading what={entry.name} />
          : !q.data ? <Fail error={q.error} onRetry={() => void q.refetch()} />
          : !q.data.text ? <Empty>this file is empty.</Empty>
          : (
            <>
              {q.data.text.length >= 200_000 && <div className="atv-note">Showing the first 200 KB of {fmtBytes(entry.bytes)}.</div>}
              {md ? <Markdown>{q.data.text}</Markdown> : <pre className="atv-cmd atv-cmd-full"><code>{q.data.text}</code></pre>}
            </>
          )}
      </div>
    </div>,
    document.body,
  );
}

function Actions({ entry, canRead, scope, refresh, onRead, onClose }: {
  entry: DirEntry; canRead: boolean; scope: ToolScope; refresh: () => Promise<unknown>; onRead: () => void; onClose: () => void;
}) {
  const [del, setDel] = useState(false);
  const { pending, errors, run } = useAct(refresh);
  const going = pending.keep;
  const keep = going === undefined || going === null ? entry.keep : going;
  if (del) {
    return (
      <Confirm title={`Delete ${entry.name}`} danger ok="DELETE" onCancel={() => setDel(false)} body={deleteWords(entry)}
        onOk={async () => {
          await api.mysticalDelete(scope, entry.path, needsImageConfirm(entry));
          await refresh();
          onClose();
        }} />
    );
  }
  return (
    <Sheet title={entry.name} onClose={onClose}>
      <div className="space-y-2 pb-1">
        <div className="atv-sub break-all">{entry.path}</div>
        <div className="atv-sub">{metaOf(entry)}</div>
        {canRead && <Btn full primary onClick={onRead}>READ</Btn>}
        {canKeep(entry) && (
          <div className="sset">
            <div className="atv-row">
              <div className="min-w-0 flex-1">
                <div className="atv-agent">Keep</div>
                <div className="atv-sub">Clearing old files leaves this alone.</div>
              </div>
              <Sw on={keep} busy={going !== undefined} label={`Keep ${entry.name}`}
                onFlip={() => void run("keep", !keep, () => api.mysticalKeep(scope, entry.path, !keep))} />
            </div>
          </div>
        )}
        <RowError text={errors.keep} />
        {entry.deletable
          ? <Btn full danger onClick={() => setDel(true)}>DELETE</Btn>
          : <div className="atv-sub">Mystical uses this, so it can't be deleted here.</div>}
      </div>
    </Sheet>
  );
}

function EntryRow({ entry, scope, refresh, onFolder }: {
  entry: DirEntry; scope: ToolScope; refresh: () => Promise<unknown>; onFolder: (e: DirEntry) => void;
}) {
  const [zoom, setZoom] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [read, setRead] = useState(false);
  useBackLayer(() => setZoom(null), zoom !== null);
  const canRead = !entry.dir && entry.preview === "text";
  const tap = entry.dir ? () => onFolder(entry) : canRead ? () => setRead(true) : null;
  const hasMenu = entry.deletable || canKeep(entry);
  const body = (
    <span className="min-w-0 flex-1">
      <span className="atv-name">{entry.name}</span>
      <span className="atv-sub">
        {metaOf(entry)}
        {entry.keep ? <span className="atv-kept"> · KEPT</span> : null}
        {!entry.deletable ? " · Mystical's" : ""}
      </span>
    </span>
  );
  return (
    <div className="atv-entry">
      {entry.preview === "image" && !entry.dir
        ? <Thumb entry={entry} scope={scope} onOpen={setZoom} />
        : (
          <span className="atv-thumb" aria-hidden>
            {entry.dir ? <Folder size={16} /> : entry.preview === "text" ? <FileText size={16} /> : <File size={16} />}
          </span>
        )}
      {tap
        ? <button type="button" onClick={tap} className="atv-entry-open">{body}{entry.dir && <ChevronRight size={14} aria-hidden className="flex-none text-[var(--tg-hint)]" />}</button>
        : <span className="atv-entry-open">{body}</span>}
      {hasMenu && (
        <button type="button" aria-label={`Actions for ${entry.name}`} onClick={() => setMenu(true)} className="flex h-11 w-11 flex-none items-center justify-center text-[var(--tg-hint)]">
          <MoreVertical size={16} aria-hidden />
        </button>
      )}
      {menu && (
        <Actions entry={entry} canRead={canRead} scope={scope} refresh={refresh} onClose={() => setMenu(false)}
          onRead={() => { setMenu(false); setRead(true); }} />
      )}
      {read && <Reader entry={entry} scope={scope} onClose={() => setRead(false)} />}
      {zoom && <ImageLightbox src={zoom} alt={entry.name} onClose={() => setZoom(null)} />}
    </div>
  );
}

function Entries({ entries, scope, refresh, onFolder }: {
  entries: DirEntry[]; scope: ToolScope; refresh: () => Promise<unknown>; onFolder: (e: DirEntry) => void;
}) {
  const [shown, setShown] = useState(PAGE);
  if (!entries.length) return <Empty>this folder is empty.</Empty>;
  return (
    <div className="space-y-2">
      <div className="sset">
        {entries.slice(0, shown).map((e) => <EntryRow key={e.path} entry={e} scope={scope} refresh={refresh} onFolder={onFolder} />)}
      </div>
      {entries.length > shown && <Btn full onClick={() => setShown((n) => n + PAGE)}>SHOW {Math.min(PAGE, entries.length - shown)} MORE OF {entries.length - shown}</Btn>}
    </div>
  );
}

function SubFolder({ sub, scope, refresh, onFolder }: {
  sub: string; scope: ToolScope; refresh: () => Promise<unknown>; onFolder: (e: DirEntry) => void;
}) {
  const q = useQuery({ queryKey: ["at-dir", scope.session, scope.project, sub], queryFn: () => api.mysticalDir(scope, sub) });
  if (q.isLoading) return <Loading what={sub} />;
  if (!q.data) return <Fail error={q.error} onRetry={() => void q.refetch()} />;
  return <Entries key={sub} entries={q.data.entries} scope={scope} refresh={refresh} onFolder={onFolder} />;
}

/** What clearing takes, from the list the bridge would act on, before anything goes. */
function ClearSheet({ stale, top, scope, refresh, onDone, onClose }: {
  stale: string[]; top: DirEntry[]; scope: ToolScope; refresh: () => Promise<unknown>;
  onDone: (words: string) => void; onClose: () => void;
}) {
  const inScratch = stale.some((p) => p.startsWith("scratch/"));
  const sizes = useQuery({
    queryKey: ["at-dir", scope.session, scope.project, "scratch"],
    queryFn: () => api.mysticalDir(scope, "scratch"),
    enabled: inScratch,
  });
  const { rows, total, complete } = staleRows(stale, [...top, ...(sizes.data?.entries ?? [])]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { pending, errors, run } = useAct(refresh);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.mysticalClear(scope, CLEAR_DAYS);
      await refresh();
      onDone(`Removed ${r.removed} item${r.removed === 1 ? "" : "s"}, freed ${fmtBytes(r.freed)}.`);
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  };
  return (
    <Sheet title={`Clear older than ${CLEAR_DAYS} days`} onClose={onClose} footer={
      rows.length > 0
        ? (
          <>
            <Btn full danger disabled={busy} onClick={() => void go()}>
              {busy ? "CLEARING…" : `DELETE ${rows.length} ITEM${rows.length === 1 ? "" : "S"}${total ? ` · ${complete ? "" : "AT LEAST "}${fmtBytes(total)}` : ""}`}
            </Btn>
            <Btn full disabled={busy} onClick={onClose}>CANCEL</Btn>
          </>
        )
        : <Btn full onClick={onClose}>CLOSE</Btn>
    }>
      <div className="space-y-2">
        <div className="atv-sub">Only scratch and other, and never what you marked keep. This can't be undone.</div>
        {rows.length === 0 ? <Empty>nothing left to clear.</Empty> : (
          <div className="sset">
            {rows.map((r) => (
              <div key={r.path} className="atv-row-wrap">
                <div className="atv-row">
                  <div className="min-w-0 flex-1">
                    <div className="break-all text-[12px] text-[var(--tg-text)]">{r.path}</div>
                    <div className="atv-sub">{r.bytes === null ? "size unknown" : fmtBytes(r.bytes)}{r.at ? ` · ${ago(r.at)}` : ""}</div>
                  </div>
                  <Btn disabled={busy || pending[r.path] !== undefined} ariaLabel={`Keep ${r.path}`}
                    onClick={() => void run(r.path, true, () => api.mysticalKeep(scope, r.path, true))}>KEEP</Btn>
                </div>
                <RowError text={errors[r.path]} />
              </div>
            ))}
          </div>
        )}
        <RowError text={error ?? undefined} />
      </div>
    </Sheet>
  );
}

type Place = { kind: string; sub: string | null };

export function DirPane({ scope }: { scope: ToolScope }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["at-dir", scope.session, scope.project, ""], queryFn: () => api.mysticalDir(scope) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["at-dir"] });
  const [path, setPath] = useState<Place[]>([]);
  const [clearing, setClearing] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const place = path[path.length - 1];
  const back = () => setPath((p) => p.slice(0, -1));
  useBackLayer(back, path.length > 0);

  if (q.isLoading) return <Loading what=".mystical" />;
  if (!q.data) return <Fail error={q.error} onRetry={() => void q.refetch()} />;
  const { entries, groups, total, stale, root } = q.data;

  if (place) {
    const label = KINDS.find((k) => k.kind === place.kind)?.label ?? place.kind;
    const here = entries.filter((e) => e.kind === place.kind);
    const into = (e: DirEntry) => setPath((p) => [...p, { kind: place.kind, sub: e.path }]);
    return (
      <div className="space-y-2">
        <button type="button" onClick={back} className="atv-crumb">
          <ChevronLeft size={15} aria-hidden className="flex-none" />
          <span className="min-w-0 break-all">{place.sub ?? label}</span>
        </button>
        {place.sub
          ? <SubFolder sub={place.sub} scope={scope} refresh={refresh} onFolder={into} />
          : <Entries entries={here} scope={scope} refresh={refresh} onFolder={into} />}
      </div>
    );
  }

  const present = KINDS.filter((k) => groups[k.kind]);
  const open = (kind: string) => {
    const only = groupOpensFolder(entries.filter((e) => e.kind === kind));
    setPath([{ kind, sub: only ? only.path : null }]);
  };
  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-2">
        <span className="sset-head min-w-0 flex-1 truncate">{root ? root.split("/").pop() : "This project"}</span>
        <span className="flex-none text-[11px] tabular-nums text-[var(--tg-text)]">{fmtBytes(total)}</span>
      </div>
      {done && <div className="atv-note" role="status">{done}</div>}
      {present.length === 0 ? <Empty>nothing here yet. this project's .mystical folder is empty.</Empty> : (
        <div className="sset">
          {present.map((k) => (
            <button key={k.kind} type="button" onClick={() => open(k.kind)} className="atv-item-head">
              <span className="min-w-0 flex-1">
                <span className="atv-name">{k.label}</span>
                <span className="atv-sub">{k.about}</span>
              </span>
              <span className="flex-none text-right">
                <span className="block text-[12px] tabular-nums text-[var(--tg-text)]">{fmtBytes(groups[k.kind].bytes)}</span>
                <span className="block text-[10px] tabular-nums text-[var(--tg-hint)]">{filesIn(entries, k.kind)}</span>
              </span>
              <ChevronRight size={14} aria-hidden className="flex-none text-[var(--tg-hint)]" />
            </button>
          ))}
        </div>
      )}
      {stale.length > 0
        ? <Btn full onClick={() => { setDone(null); setClearing(true); }}>CLEAR OLDER THAN {CLEAR_DAYS} DAYS · {stale.length}</Btn>
        : present.length > 0 && <div className="atv-sub">Nothing in scratch or other is older than {CLEAR_DAYS} days.</div>}
      {clearing && (
        <ClearSheet stale={stale} top={entries} scope={scope} refresh={refresh} onClose={() => setClearing(false)}
          onDone={(words) => { setDone(words); setClearing(false); }} />
      )}
    </div>
  );
}
