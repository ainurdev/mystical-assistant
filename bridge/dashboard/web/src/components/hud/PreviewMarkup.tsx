import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";

/* PREVIEW MARKUP — annotate-a-still feedback.
   On open it captures a server screenshot of the live preview and freezes it as
   a still; you draw pen / arrow / box on top, then SEND composites the drawing
   onto the screenshot (at full resolution) and enqueues it to the active session
   — the same images→queue path the composer uses to feed Claude.

   Annotations are stored in normalized [0..1] coords relative to the still, so
   the same strokes render on the on-screen canvas and composite cleanly onto the
   full-resolution screenshot regardless of display scale. */

type Tool = "pen" | "arrow" | "box";
type Pt = { x: number; y: number };
type Stroke =
  | { type: "pen"; color: string; points: Pt[] }
  | { type: "arrow"; color: string; from: Pt; to: Pt }
  | { type: "box"; color: string; from: Pt; to: Pt };

const COLORS = ["#ff5a5a", "#ffb020", "#7fe9d8", "#5a9bff", "#f0f0f0"];

const TOOLS: { key: Tool; label: string; glyph: string }[] = [
  { key: "pen", label: "PEN", glyph: "✎" },
  { key: "arrow", label: "ARROW", glyph: "↗" },
  { key: "box", label: "BOX", glyph: "▭" },
];

function drawArrow(g: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, lw: number) {
  const head = Math.max(lw * 3.2, 9);
  const a = Math.atan2(y2 - y1, x2 - x1);
  g.beginPath();
  g.moveTo(x1, y1);
  g.lineTo(x2, y2);
  g.stroke();
  g.beginPath();
  g.moveTo(x2, y2);
  g.lineTo(x2 - head * Math.cos(a - Math.PI / 7), y2 - head * Math.sin(a - Math.PI / 7));
  g.moveTo(x2, y2);
  g.lineTo(x2 - head * Math.cos(a + Math.PI / 7), y2 - head * Math.sin(a + Math.PI / 7));
  g.stroke();
}

function paint(g: CanvasRenderingContext2D, W: number, H: number, strokes: Stroke[], lw: number) {
  g.lineCap = "round";
  g.lineJoin = "round";
  for (const s of strokes) {
    g.strokeStyle = s.color;
    g.lineWidth = lw;
    if (s.type === "pen") {
      g.beginPath();
      s.points.forEach((p, i) => (i ? g.lineTo(p.x * W, p.y * H) : g.moveTo(p.x * W, p.y * H)));
      g.stroke();
    } else if (s.type === "box") {
      g.strokeRect(s.from.x * W, s.from.y * H, (s.to.x - s.from.x) * W, (s.to.y - s.from.y) * H);
    } else {
      drawArrow(g, s.from.x * W, s.from.y * H, s.to.x * W, s.to.y * H, lw);
    }
  }
}

export function PreviewMarkup({ project, sessionId, url, width, onExit }: {
  project: string;
  sessionId: string | null;
  url: string;
  width: number;
  onExit: () => void;
}) {
  const [shot, setShot] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(COLORS[0]);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const draftRef = useRef<Stroke | null>(null);

  const capture = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.screenshot(width, url, { project });
      if (r.data_url) setShot(r.data_url);
      else setError("screenshot returned no image");
    } catch {
      setError("couldn't capture the preview — is the server reachable?");
    } finally {
      setLoading(false);
    }
  }, [project, url, width]);

  useEffect(() => { void capture(); }, [capture]);

  // Redraw the on-screen canvas whenever strokes change (draft is drawn live in
  // the pointer handlers via redraw()).
  const redraw = useCallback((draft?: Stroke | null) => {
    const cv = canvasRef.current;
    if (!cv) return;
    const g = cv.getContext("2d");
    if (!g) return;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    g.clearRect(0, 0, cv.width, cv.height);
    const all = draft !== undefined && draft ? [...strokes, draft] : strokes;
    paint(g, cv.width, cv.height, all, Math.max(cv.width * 0.0035, 2.5));
  }, [strokes]);

  useEffect(() => { redraw(); }, [redraw, shot]);
  useEffect(() => {
    const on = () => redraw();
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, [redraw]);

  const norm = (e: React.PointerEvent): Pt => {
    const cv = canvasRef.current!;
    const r = cv.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };

  const onDown = (e: React.PointerEvent) => {
    if (!shot) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = norm(e);
    draftRef.current = tool === "pen"
      ? { type: "pen", color, points: [p] }
      : { type: tool, color, from: p, to: p };
    redraw(draftRef.current);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = draftRef.current;
    if (!d) return;
    const p = norm(e);
    if (d.type === "pen") d.points.push(p);
    else d.to = p;
    redraw(d);
  };
  const onUp = () => {
    const d = draftRef.current;
    draftRef.current = null;
    if (!d) return;
    // Discard degenerate shapes (a click with no drag).
    if (d.type !== "pen") {
      const dx = Math.abs(d.to.x - d.from.x), dy = Math.abs(d.to.y - d.from.y);
      if (dx < 0.005 && dy < 0.005) { redraw(); return; }
    } else if (d.points.length < 2) { redraw(); return; }
    setStrokes((s) => [...s, d]);
  };

  const undo = () => setStrokes((s) => s.slice(0, -1));
  const clear = () => setStrokes([]);

  const composite = async (): Promise<string> => {
    const img = new Image();
    img.src = shot!;
    await img.decode();
    const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0, W, H);
    paint(g, W, H, strokes, Math.max(W * 0.0035, 3));
    return c.toDataURL("image/png");
  };

  const canSend = !!sessionId && !!shot && !sending && (text.trim().length > 0 || strokes.length > 0);
  const send = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      const image = await composite();
      const instruction = text.trim() || "Please address the annotations marked on the attached screenshot.";
      await api.queueEnqueue({
        session_id: sessionId!, surface: "dashboard",
        text: text.trim(), prompt: instruction, images: [image], width, project,
      });
      setSent(true);
      setTimeout(onExit, 750);
    } catch {
      setError("failed to send — the session queue rejected it");
      setSending(false);
    }
  };

  const toolBtn = (active: boolean): React.CSSProperties => ({
    appearance: "none", cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6,
    padding: "5px 10px", fontSize: 9, letterSpacing: 1.5,
    border: `1px solid ${active ? "color-mix(in srgb, var(--acc) 60%, transparent)" : "color-mix(in srgb, var(--acc) 16%, transparent)"}`,
    background: active ? "color-mix(in srgb, var(--acc) 14%, transparent)" : "transparent",
    color: active ? "var(--txb)" : "var(--txm)",
  });
  const utilBtn: React.CSSProperties = {
    appearance: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 9, letterSpacing: 1.5, padding: "5px 10px",
    border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", background: "transparent", color: "var(--txm)",
  };

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 12, background: "#0a1113", display: "flex", flexDirection: "column",
      animation: "mfadeup .18s ease both" }}>
      {/* toolbar */}
      <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", flexWrap: "wrap",
        borderBottom: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", background: "color-mix(in srgb, var(--panel2) 90%, transparent)" }}>
        <span style={{ fontSize: 9, letterSpacing: 2, color: "var(--acc)", flex: "none" }}>✎ MARKUP</span>
        <span style={{ width: 1, height: 16, background: "color-mix(in srgb, var(--acc) 18%, transparent)" }} />
        {TOOLS.map((t) => (
          <button key={t.key} onClick={() => setTool(t.key)} style={toolBtn(tool === t.key)} title={t.label}>
            <span style={{ fontSize: 12 }}>{t.glyph}</span>{t.label}
          </button>
        ))}
        <span style={{ width: 1, height: 16, background: "color-mix(in srgb, var(--acc) 18%, transparent)" }} />
        <div style={{ display: "flex", gap: 6 }}>
          {COLORS.map((c) => (
            <button key={c} onClick={() => setColor(c)} title={c}
              style={{ appearance: "none", cursor: "pointer", width: 18, height: 18, borderRadius: "50%", background: c,
                border: color === c ? "2px solid var(--txb)" : "2px solid transparent", outline: color === c ? "1px solid var(--acc)" : "none" }} />
          ))}
        </div>
        <span style={{ width: 1, height: 16, background: "color-mix(in srgb, var(--acc) 18%, transparent)" }} />
        <button onClick={undo} disabled={!strokes.length} style={{ ...utilBtn, opacity: strokes.length ? 1 : 0.4 }} title="undo last">⟲ UNDO</button>
        <button onClick={clear} disabled={!strokes.length} style={{ ...utilBtn, opacity: strokes.length ? 1 : 0.4 }} title="clear all">CLEAR</button>
        <span style={{ flex: 1 }} />
        <button onClick={onExit} style={{ ...utilBtn, letterSpacing: 1.5 }} title="exit markup">✕ EXIT</button>
      </div>

      {/* still + drawing surface */}
      <div style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", alignItems: "center", justifyContent: "center",
        overflow: "auto", padding: 14, background: "var(--panel3)" }}>
        {loading ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, color: "var(--txm)" }}>
            <svg viewBox="0 0 100 100" style={{ width: 24, height: 24, overflow: "visible" }}>
              <circle cx="50" cy="50" r="40" fill="none" stroke="var(--acc)" strokeWidth="4" strokeDasharray="7 11"
                style={{ transformOrigin: "50px 50px", animation: "introspin 1.6s linear infinite" }} />
            </svg>
            <span style={{ fontSize: 10, letterSpacing: 1.5 }}>capturing preview…</span>
          </div>
        ) : error ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center", maxWidth: 360 }}>
            <span style={{ fontSize: 12, color: "var(--err)" }}>{error}</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => void capture()} style={{ ...utilBtn, color: "var(--acc)", borderColor: "color-mix(in srgb, var(--acc) 40%, transparent)" }}>RETRY</button>
              <button onClick={onExit} style={utilBtn}>EXIT</button>
            </div>
          </div>
        ) : shot ? (
          <div style={{ position: "relative", display: "inline-block", maxWidth: "100%", maxHeight: "100%" }}>
            <img src={shot} alt="preview still" draggable={false} onLoad={() => redraw()}
              style={{ display: "block", maxWidth: "100%", maxHeight: "100%", userSelect: "none" }} />
            <canvas ref={canvasRef}
              onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", cursor: "crosshair", touchAction: "none" }} />
          </div>
        ) : null}
      </div>

      {/* composer */}
      <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
        borderTop: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", background: "color-mix(in srgb, var(--panel2) 90%, transparent)" }}>
        <input value={text} onChange={(e) => setText(e.target.value)} disabled={!shot || sending}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(); }}
          placeholder={sessionId ? "describe the change — ⌘↵ to send…" : "open a session to send feedback"}
          spellCheck style={{ appearance: "none", flex: 1, minWidth: 0, background: "color-mix(in srgb, var(--panel3) 70%, transparent)",
            border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", color: "var(--txh)", fontFamily: "inherit", fontSize: 12,
            padding: "9px 11px", outline: "none" }} />
        <button onClick={() => void send()} disabled={!canSend}
          title={!sessionId ? "no active session to send to" : "send annotated screenshot to Claude"}
          style={{ appearance: "none", cursor: canSend ? "pointer" : "default", fontFamily: "inherit", flex: "none",
            fontSize: 10, letterSpacing: 2, padding: "9px 20px",
            border: `1px solid ${sent ? "color-mix(in srgb, var(--ok) 55%, transparent)" : "color-mix(in srgb, var(--acc) 45%, transparent)"}`,
            background: sent ? "color-mix(in srgb, var(--ok) 12%, transparent)" : "color-mix(in srgb, var(--acc) 10%, transparent)",
            color: sent ? "var(--ok)" : "var(--acc)", opacity: canSend || sent ? 1 : 0.45 }}>
          {sent ? "SENT ✓" : sending ? "SENDING…" : "SEND ▸"}
        </button>
      </div>
    </div>
  );
}
