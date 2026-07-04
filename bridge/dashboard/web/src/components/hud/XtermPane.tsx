import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../../api";

// Phosphor-matched theme so the terminal reads as part of the HUD.
const THEME = {
  background: "var(--panel2)",
  foreground: "var(--txh)",
  cursor: "var(--acc)",
  cursorAccent: "var(--panel2)",
  selectionBackground: "color-mix(in srgb, var(--acc) 25%, transparent)",
  black: "#0b1414", red: "var(--err)", green: "var(--ok)", yellow: "var(--warn)",
  blue: "#7fb0e9", magenta: "var(--purple)", cyan: "var(--acc)", white: "var(--txh)",
  brightBlack: "var(--txl)", brightRed: "var(--err)", brightGreen: "var(--ok)",
  brightYellow: "var(--warn)", brightBlue: "#7fb0e9", brightMagenta: "var(--purple)",
  brightCyan: "#9fe9dd", brightWhite: "var(--txb)",
};

/** One interactive terminal: an xterm.js instance wired to the backend PTY over a
 *  websocket. Client→server frames are binary with a 1-byte channel prefix
 *  (0x00 = stdin, 0x01 = resize-JSON); server→client frames are raw PTY output.
 *  Reconnects a few times if the socket drops while the PTY is still alive. */
export function XtermPane({ id, active, onEnded }: {
  id: string;
  active: boolean;
  onEnded?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const sendResizeRef = useRef<() => void>(() => {});
  const deadRef = useRef(false);
  const endedRef = useRef(onEnded);
  endedRef.current = onEnded;

  useEffect(() => {
    deadRef.current = false;
    const enc = new TextEncoder();
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 12, lineHeight: 1.15, cursorBlink: true, scrollback: 5000,
      theme: THEME, allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    if (hostRef.current) term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fit;
    try { fit.fit(); } catch { /* zero-size until visible */ }

    const sendCtl = (channel: number, bytes: Uint8Array) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const buf = new Uint8Array(bytes.length + 1);
      buf[0] = channel;
      buf.set(bytes, 1);
      ws.send(buf);
    };
    const sendResize = () =>
      sendCtl(0x01, enc.encode(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })));
    sendResizeRef.current = sendResize;

    term.onData((d) => sendCtl(0x00, enc.encode(d)));

    let attempts = 0;
    const connect = () => {
      if (deadRef.current) return;
      const ws = new WebSocket(api.termWsUrl(id));
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      ws.onopen = () => { attempts = 0; try { fit.fit(); } catch { /* */ } sendResize(); };
      ws.onmessage = (e) => {
        if (typeof e.data === "string") term.write(e.data);
        else term.write(new Uint8Array(e.data as ArrayBuffer));
      };
      ws.onclose = () => {
        if (deadRef.current) return;
        attempts += 1;
        if (attempts > 4) { endedRef.current?.(); return; }   // PTY likely gone
        setTimeout(connect, Math.min(2000, 250 * attempts));
      };
      ws.onerror = () => { try { ws.close(); } catch { /* */ } };
    };
    connect();

    const ro = new ResizeObserver(() => {
      try { fit.fit(); sendResize(); } catch { /* */ }
    });
    if (hostRef.current) ro.observe(hostRef.current);

    return () => {
      deadRef.current = true;
      ro.disconnect();
      try { wsRef.current?.close(); } catch { /* */ }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
  }, [id]);

  // Hidden panes have zero size — refit + focus when this one becomes visible.
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => {
      try { fitRef.current?.fit(); } catch { /* */ }
      sendResizeRef.current();
      termRef.current?.focus();
    }, 30);
    return () => clearTimeout(t);
  }, [active]);

  return <div ref={hostRef} style={{ width: "100%", height: "100%" }} />;
}
