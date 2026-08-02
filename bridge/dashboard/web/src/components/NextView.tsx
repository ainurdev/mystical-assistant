import { useEffect, useRef, useState } from "react";
import { api, type NextBoard, type NextItem } from "../api";

const EFFORT: Record<NextItem["effort"], string> = {
  small: "·",
  medium: "··",
  large: "···",
};

function when(ts: number | null): string {
  if (!ts) return "never";
  const mins = Math.round((Date.now() / 1000 - ts) / 60);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
}

/** The ranked next steps across recently touched repos. Serves the cached board
 *  instantly; REFRESH is the only thing that spends anything, and only on repos
 *  whose git state has moved since last time. */
export function NextView({ onStart }: { onStart: (item: NextItem) => void }) {
  const [board, setBoard] = useState<NextBoard | null>(null);
  const [busy, setBusy] = useState(false);
  const poll = useRef<number | null>(null);

  const load = async () => {
    try {
      const b = await api.nextBoard();
      setBoard(b);
      return b;
    } catch {
      return null;
    }
  };

  useEffect(() => {
    void load();
    return () => {
      if (poll.current) window.clearInterval(poll.current);
    };
  }, []);

  async function refresh() {
    setBusy(true);
    await api.refreshNext().catch(() => null);
    // Scouts run in the background; watch until the server says it's done.
    if (poll.current) window.clearInterval(poll.current);
    poll.current = window.setInterval(async () => {
      const b = await load();
      if (b && !b.refreshing) {
        if (poll.current) window.clearInterval(poll.current);
        poll.current = null;
        setBusy(false);
      }
    }, 3000);
  }

  const items = board?.items ?? [];

  return (
    <div style={{ padding: "18px 18px 40px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 14 }}>
        <span style={{ fontSize: 9.5, letterSpacing: 2.5, color: "var(--txl)" }}>NEXT UP</span>
        <span style={{ fontSize: 9, color: "var(--txd)" }}>
          {board ? `${board.repos.length} repo(s) · ${when(board.generated)}` : "…"}
        </span>
        <span style={{ flex: 1 }} />
        <button
          onClick={() => void refresh()}
          disabled={busy}
          style={{
            appearance: "none",
            cursor: busy ? "default" : "pointer",
            border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)",
            background: "transparent",
            color: busy ? "var(--txd)" : "var(--txm)",
            fontFamily: "inherit",
            fontSize: 9,
            letterSpacing: 1.5,
            padding: "4px 10px",
          }}
        >
          {busy ? "SCOUTING…" : "↻ REFRESH"}
        </button>
      </div>

      {board && !board.enabled && (
        <div style={{ fontSize: 9.5, color: "var(--txl)", lineHeight: 1.7, marginBottom: 14 }}>
          Ranking is off, so this is the plain heuristic order and costs nothing. Switch
          NEXT-UP BOARD on in Settings → AI to have a scout read each repo.
        </div>
      )}

      {!items.length && (
        <div style={{ fontSize: 10, color: "var(--txd)", lineHeight: 1.8 }}>
          {board === null
            ? "Reading…"
            : "Nothing yet — REFRESH looks over the repos you have worked in recently."}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {items.map((it, n) => (
          <div
            key={it.id}
            style={{
              border: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)",
              padding: "11px 13px",
              display: "flex",
              gap: 12,
              alignItems: "flex-start",
            }}
          >
            <span style={{ fontSize: 10, color: "var(--txd)", flex: "none", marginTop: 2 }}>
              {String(n + 1).padStart(2, "0")}
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12, color: "var(--txb)", overflowWrap: "anywhere" }}>
                {it.title}
              </div>
              <div style={{ fontSize: 9.5, color: "var(--txl)", marginTop: 4, lineHeight: 1.7 }}>
                {it.why}
              </div>
              <div style={{ fontSize: 9, color: "var(--txd)", marginTop: 5, letterSpacing: 0.5 }}>
                {it.repo}
                {it.branch ? ` ⎇ ${it.branch}` : ""} · {EFFORT[it.effort] ?? "··"}
                {it.evidence ? ` · ${it.evidence}` : ""}
              </div>
            </div>
            <button
              onClick={() => onStart(it)}
              style={{
                appearance: "none",
                cursor: "pointer",
                flex: "none",
                border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)",
                background: "transparent",
                color: "var(--txm)",
                fontFamily: "inherit",
                fontSize: 9,
                letterSpacing: 1.5,
                padding: "4px 10px",
              }}
            >
              ▸ START
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
