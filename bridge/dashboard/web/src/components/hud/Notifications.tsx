import { useEffect, useRef, useState, useSyncExternalStore } from "react";

export type NoticeKind = "error" | "info";
export interface Notice {
  id: number;
  kind: NoticeKind;
  text: string;
  time: number;
  read: boolean;
}

// ponytail: module-level store (one array + subscribers) — a single global feed
// written from async handlers doesn't need context/providers.
let notices: Notice[] = [];
let nextId = 1;
const subs = new Set<() => void>();
function emit() { for (const fn of subs) fn(); }
function subscribe(fn: () => void) { subs.add(fn); return () => { subs.delete(fn); }; }
function getNotices() { return notices; }

// The feed is written from async handlers all over the app, so it can't read
// settings through a hook. App installs one callback here instead of every
// notify() site learning what a sound is.
let onNotice: ((kind: NoticeKind) => void) | null = null;
export function setNoticeSound(fn: ((kind: NoticeKind) => void) | null) { onNotice = fn; }

/** Push a notification: shows a toast popup and lands in the bell dropdown. */
export function notify(kind: NoticeKind, text: string) {
  notices = [{ id: nextId++, kind, text: text || "unknown error", time: Date.now(), read: false }, ...notices].slice(0, 50);
  emit();
  onNotice?.(kind);
}

function dismiss(id: number) { notices = notices.filter((n) => n.id !== id); emit(); }
function clearAll() { notices = []; emit(); }
function markAllRead() {
  if (!notices.some((n) => !n.read)) return;
  notices = notices.map((n) => (n.read ? n : { ...n, read: true }));
  emit();
}

const KIND: Record<NoticeKind, { color: string; label: string }> = {
  error: { color: "var(--err)", label: "ERR" },
  info: { color: "var(--acc)", label: "INFO" },
};
const fmtTime = (t: number) => new Date(t).toTimeString().slice(0, 8);
const TOAST_MS = 8000;

function Row({ n, onDismiss }: { n: Notice; onDismiss: () => void }) {
  const k = KIND[n.kind];
  return (
    <div style={{ padding: "9px 11px", borderTop: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span style={{ fontSize: "var(--t75)", letterSpacing: 1.5, color: k.color, border: `1px solid color-mix(in srgb, ${k.color} 35%, transparent)`, padding: "1px 5px", flex: "none" }}>
          {k.label}
        </span>
        <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t85)", color: "var(--txl)" }}>{fmtTime(n.time)}</span>
        <span style={{ flex: 1 }}></span>
        <button
          onClick={onDismiss}
          title="dismiss"
          style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: "var(--txd)", fontFamily: "inherit", fontSize: "var(--t12)", lineHeight: 1, padding: "0 2px" }}
        >
          ×
        </button>
      </div>
      <div style={{ marginTop: 5, fontSize: "var(--t115)", lineHeight: 1.5, color: "var(--tx)", overflowWrap: "anywhere", fontFamily: "'JetBrains Mono',monospace" }}>
        {n.text}
      </div>
    </div>
  );
}

/** Bell icon button (Strip, top right) + dropdown list + transient toast popups. */
export function NotificationCenter() {
  const list = useSyncExternalStore(subscribe, getNotices);
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [toastIds, setToastIds] = useState<number[]>([]);
  const lastSeen = useRef(0);
  const timers = useRef<number[]>([]);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const unread = list.reduce((a, n) => a + (n.read ? 0 : 1), 0);

  // New notices become toasts that expire on their own.
  useEffect(() => {
    const fresh = list.filter((n) => n.id > lastSeen.current);
    if (!fresh.length) return;
    lastSeen.current = list[0].id;
    setToastIds((p) => [...fresh.map((n) => n.id), ...p]);
    for (const n of fresh) {
      timers.current.push(window.setTimeout(() => setToastIds((p) => p.filter((id) => id !== n.id)), TOAST_MS));
    }
  }, [list]);
  useEffect(() => () => { for (const t of timers.current) window.clearTimeout(t); }, []);

  // Opening the dropdown marks everything read; click-outside closes it.
  useEffect(() => {
    if (!open) return;
    markAllRead();
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const toasts = open ? [] : list.filter((n) => toastIds.includes(n.id));

  return (
    <span ref={wrapRef} style={{ position: "relative", flex: "none", display: "flex" }}>
      <button
        onClick={() => setOpen(!open)}
        title="notifications"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          appearance: "none",
          cursor: "pointer",
          position: "relative",
          border: 0,
          background: "transparent",
          color: hover ? "var(--txb)" : "var(--txm)",
          fontFamily: "inherit",
          padding: 0,
          width: 22,
          height: 22,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {unread > 0 && (
          <span style={{ position: "absolute", top: -5, right: -5, minWidth: 13, height: 13, borderRadius: 7, background: "var(--err)", color: "var(--panel3)", fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t8)", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 3px", boxSizing: "border-box" }}>
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            zIndex: 60,
            width: "330px",
            border: "1px solid color-mix(in srgb, var(--acc) 40%, transparent)",
            background: "color-mix(in srgb, var(--panel2) 99%, transparent)",
            boxShadow: "0 16px 44px var(--shadow-pop)",
            animation: "mslide .16s ease both",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "11px 11px 9px" }}>
            <span style={{ fontSize: "var(--t9)", letterSpacing: 2, color: "var(--acc)" }}>NOTIFICATIONS</span>
            <span style={{ flex: 1 }}></span>
            {list.length > 0 && (
              <button
                onClick={clearAll}
                style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 22%, transparent)", background: "transparent", color: "var(--txm)", fontFamily: "inherit", fontSize: "var(--t75)", letterSpacing: 1.5, padding: "3px 7px" }}
              >
                CLEAR ALL
              </button>
            )}
          </div>
          <div className="mscroll" style={{ maxHeight: 320, overflowY: "auto" }}>
            {list.length === 0 ? (
              <div style={{ padding: "18px 11px", textAlign: "center", fontSize: "var(--t10)", letterSpacing: 1.5, color: "var(--txl)" }}>
                NO NOTIFICATIONS
              </div>
            ) : (
              list.map((n) => <Row key={n.id} n={n} onDismiss={() => dismiss(n.id)} />)
            )}
          </div>
        </div>
      )}

      {toasts.length > 0 && (
        <div style={{ position: "fixed", top: 46, right: 14, zIndex: 70, display: "flex", flexDirection: "column", gap: 8, width: 330 }}>
          {toasts.map((n) => {
            const k = KIND[n.kind];
            return (
              <div
                key={n.id}
                style={{
                  border: `1px solid color-mix(in srgb, ${k.color} 45%, transparent)`,
                  background: "color-mix(in srgb, var(--panel2) 97%, transparent)",
                  boxShadow: "0 12px 34px var(--shadow-pop)",
                  padding: "9px 11px",
                  animation: "mslide .16s ease both",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <span style={{ fontSize: "var(--t75)", letterSpacing: 1.5, color: k.color, border: `1px solid color-mix(in srgb, ${k.color} 35%, transparent)`, padding: "1px 5px", flex: "none" }}>
                    {k.label}
                  </span>
                  <span style={{ flex: 1 }}></span>
                  <button
                    onClick={() => setToastIds((p) => p.filter((id) => id !== n.id))}
                    title="dismiss"
                    style={{ appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: "var(--txd)", fontFamily: "inherit", fontSize: "var(--t12)", lineHeight: 1, padding: "0 2px" }}
                  >
                    ×
                  </button>
                </div>
                <div style={{ marginTop: 5, fontSize: "var(--t115)", lineHeight: 1.5, color: "var(--txb)", overflowWrap: "anywhere", fontFamily: "'JetBrains Mono',monospace", display: "-webkit-box", WebkitLineClamp: 4, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                  {n.text}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </span>
  );
}
