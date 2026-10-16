/* PLUGINS ▸ DEVICE RUNS — Share this device, and the Claude token for device runs
   (bridge/device_share.py, bridge/device_setup.py; the routes are
   /local/rivendell/devices and /local/rivendell/devices/setup in
   bridge/dashboard/server.py).

   On a Mac, a teammate allowed in Rivendell can test an iOS app here: the run
   executes as the hidden user mysticalruns. SET UP makes that user behind one Mac
   password prompt and REMOVE undoes it. Off macOS only the asking side shows: how
   many shared devices are on, and the token. One block per enabled Rivendell
   instance, headed by its link the way the RIVENDELL panel above shows it.
   Drafts H, I and J: rivendell/.mystical/design-drafts/device-runs/
   05-mystical-share-this-device.html. */

import { useEffect, useState, type CSSProperties } from "react";
import { Key, LaptopMinimal } from "lucide-react";
import { api, type RivendellDevice } from "../../api";
import { setupAction, stateText } from "../../lib/deviceruns";
import { CARD, Row, Section, Switch, riStatusView, useVoice } from "./SettingsModal";

const MONO = "'JetBrains Mono',monospace";
const CODE: CSSProperties = { fontFamily: MONO, color: "var(--acc)" };
const NOW: CSSProperties = { fontFamily: MONO, fontSize: "var(--t95)", color: "var(--txd)" };
const BOX: CSSProperties = {
  fontFamily: MONO, fontSize: "var(--t95)", padding: "5px 9px", background: "var(--panel3)",
  border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)",
};
const STATE_CHIP: Record<string, [string, string]> = {
  READY: ["READY", "var(--ok)"],
  NEEDS_SETUP: ["NEEDS SETUP", "var(--warn)"],
  XCODE_MISSING: ["XCODE MISSING", "var(--warn)"],
  OFF: ["OFF", "var(--txf)"],
};
const SETUP_DESC = "Creates a hidden macOS user for runs, keeps it out of your home folder and installs Claude Code for it. Asks for your Mac password once.";
const REMOVE_DESC = "Deletes the hidden user and everything runs left behind. Asks for your Mac password.";

/** A label in the dialog's voice. FLINT's sentence case can't spell these three. */
function useSay(): (s: string) => string {
  const voice = useVoice();
  return (s) => String(voice(s)).replace(/\bMacos\b/g, "macOS").replace(/\bIos\b/g, "iOS").replace(/\bCocoapods\b/g, "CocoaPods");
}

function Chip({ label, color }: { label: string; color: string }) {
  const say = useSay();
  return (
    <span style={{ fontSize: "var(--t9)", letterSpacing: 1.8, padding: "1px 8px", whiteSpace: "nowrap", color,
      border: `1px solid color-mix(in srgb, ${color} 42%, transparent)` }}>
      {say(label)}
    </span>
  );
}

function Btn({ children, onClick, disabled, tone }: {
  children: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: "pri" | "bad";   // the row's one action, filled in the accent; or a destructive one
}) {
  const [hov, setHov] = useState(false);
  const say = useSay();
  const c = tone === "bad" ? "var(--err)" : "var(--acc)";
  return (
    <button onClick={onClick} disabled={disabled} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        appearance: "none", cursor: disabled ? "default" : "pointer", fontFamily: "inherit", fontSize: "var(--t9)",
        letterSpacing: 1.5, padding: "6px 12px", flex: "none", opacity: disabled ? 0.6 : 1,
        border: `1px solid ${tone === "pri" ? c : `color-mix(in srgb, ${c} 38%, transparent)`}`,
        background: tone === "pri" ? c : hov && !disabled ? `color-mix(in srgb, ${c} 10%, transparent)` : "transparent",
        color: tone === "pri" ? "var(--acc-on)" : c,
      }}>
      {say(children)}
    </button>
  );
}

/** {NAME} · {api host} · {CONNECTED|…}, with RivendellPanel's status pip. */
function Head({ d }: { d: RivendellDevice }) {
  const say = useSay();
  const sv = riStatusView(d.status);
  let host = d.api_url;
  try { host = new URL(d.api_url).host; } catch { /* shown as stored */ }
  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 9, marginBottom: 22,
      fontSize: "var(--t10)", letterSpacing: 1.5, color: "var(--txm)" }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: sv.color, flex: "none",
        boxShadow: sv.glow ? `0 0 6px ${sv.color}` : undefined }} />
      <span className="glow" style={{ color: "var(--txb)", letterSpacing: 2 }}>{say(d.name.toUpperCase())}</span>
      <span>·</span>
      <span style={{ fontFamily: MONO, letterSpacing: 0 }}>{host}</span>
      <span>·</span>
      <span style={{ color: sv.color }} title={d.status?.detail || sv.label}>{say(sv.label)}</span>
    </div>
  );
}

function TokenRow({ d, first, busy, onSave }: {
  d: RivendellDevice;
  first?: boolean;
  busy: boolean;
  onSave: (token: string) => Promise<boolean>;
}) {
  const [replacing, setReplacing] = useState(false);
  const [tok, setTok] = useState("");
  const say = useSay();
  async function save() {
    if (await onSave(tok.trim())) {
      setTok("");
      setReplacing(false);
    }
  }
  return (
    <Row first={first} label="CLAUDE TOKEN FOR DEVICE RUNS"
      desc={<>
        {!d.token_saved && <span style={{ color: "var(--warn)" }}>Needed before you can send a run. </span>}
        Your runs use your own Claude account, so the usage is yours. Make a token with <code style={CODE}>claude setup-token</code>.
      </>}>
      <span style={{ display: "flex", alignItems: "center", gap: 8, flex: "none" }}>
        {d.token_saved && !replacing ? (
          <>
            <span style={{ ...BOX, padding: "4px 9px", color: "var(--txm)", letterSpacing: 0.5 }}>
              {say("SAVED")} ····{d.token_last4}
            </span>
            <Btn onClick={() => setReplacing(true)}>REPLACE</Btn>
          </>
        ) : (
          <>
            <input type="password" value={tok} onChange={(e) => setTok(e.target.value)} placeholder="paste token"
              aria-label="Claude token for device runs"
              style={{ ...BOX, width: 210, outline: "none", color: "var(--txb)" }} />
            {replacing && <Btn onClick={() => { setTok(""); setReplacing(false); }}>CANCEL</Btn>}
            <Btn disabled={busy || !tok.trim()} onClick={() => void save()}>SAVE</Btn>
          </>
        )}
      </span>
    </Row>
  );
}

export function DeviceRunsPanel() {
  const [rows, setRows] = useState<RivendellDevice[] | null>(null);
  // "setup" | "remove" while the password prompt and its script run (up to 15
  // minutes); an instance id while one of its saves is in flight.
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState({ at: "", text: "" });
  const say = useSay();

  // Read now, then every 4 s while open, as RivendellPanel does. Not while a
  // change is in flight: a read that lands after it would put the old state back.
  useEffect(() => {
    if (busy) return;
    let live = true;
    const read = () => void api.rivendellDevices().then((r) => { if (live) setRows(r.instances); }).catch(() => {});
    read();
    const t = setInterval(read, 4000);
    return () => { live = false; clearInterval(t); };
  }, [busy]);

  /** One change: its answer is the panel's new state, and a refusal shows at `at`. */
  async function act(what: string, at: string,
    call: () => Promise<{ instances: RivendellDevice[]; error?: string | null }>): Promise<boolean> {
    if (busy) return false;
    setBusy(what);
    setErr({ at: "", text: "" });
    try {
      const r = await call();
      setRows(r.instances);
      if (r.error) setErr({ at, text: r.error });
      return !r.error;
    } catch (e) {
      setErr({ at, text: e instanceof Error ? e.message : "could not save" });
      return false;
    } finally {
      setBusy("");
    }
  }

  const shown = (rows ?? []).filter((d) => d.enable);
  if (!shown.length) return null;
  const errLine = (at: string) => err.at === at && (
    <div style={{ fontSize: "var(--t95)", color: "var(--err)", marginTop: 8 }}>{err.text}</div>
  );

  return (
    <>
      {shown.map((d) => {
        const token = (first: boolean) => (
          <TokenRow d={d} first={first} busy={!!busy}
            onSave={(device_token) => act(d.id, `${d.id}:token`, () => api.updateRivendellDevice({ id: d.id, device_token }))} />
        );
        if (d.share.state === "NOT_MAC") {
          return (
            <div key={d.id} style={{ marginTop: 34 }}>
              <Head d={d} />
              <Section title="DEVICE RUNS" icon={LaptopMinimal} desc="send iOS Simulator tests to the team's shared devices.">
                <div style={CARD}>
                  <Row first label="SHARE THIS DEVICE"><Chip label="MACOS ONLY" color="var(--txf)" /></Row>
                  {d.shared_on && (
                    <Row label="SHARED DEVICES ON NOW">
                      <span style={NOW}>{d.shared_on.on} on · {d.shared_on.free} free</span>
                    </Row>
                  )}
                  {token(false)}
                </div>
                {errLine(`${d.id}:token`)}
              </Section>
            </div>
          );
        }
        const action = setupAction(d);
        const [chip, color] = STATE_CHIP[d.share.state];
        return (
          <div key={d.id} style={{ marginTop: 34 }}>
            <Head d={d} />
            <Section title="DEVICE RUNS · THIS DEVICE" icon={LaptopMinimal}
              desc="teammates allowed in Rivendell can test iOS apps on this device.">
              <div style={CARD}>
                <Row first label="SHARE THIS DEVICE"
                  desc={<>Runs execute as the hidden user <code style={CODE}>mysticalruns</code>, with the asker's own code and Claude account. They can't see your files, keychain or logins.</>}>
                  <Switch on={d.share_device}
                    onClick={() => void act(d.id, `${d.id}:device`, () => api.updateRivendellDevice({ id: d.id, share_device: !d.share_device }))} />
                </Row>
                <Row
                  label={<span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>{say("STATE")}<Chip label={chip} color={color} /></span>}
                  desc={
                    <span style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px", marginTop: 4, fontSize: "var(--t9)", letterSpacing: 1.4 }}>
                      {d.share.checks.map((c) => (
                        <span key={c.key} style={{ color: c.ok ? "var(--ok)" : "var(--warn)" }}>{c.ok ? "✓" : "✗"} {say(c.label)}</span>
                      ))}
                    </span>
                  }>
                  <span style={NOW}>{stateText(d)}</span>
                </Row>
                {action && (
                  <Row label="SETUP" desc={action === "remove" ? REMOVE_DESC : SETUP_DESC}>
                    <Btn tone={action === "remove" ? "bad" : "pri"} disabled={!!busy}
                      onClick={() => void act(action, `${d.id}:device`, () => api.rivendellDeviceSetup(action))}>
                      {busy === "setup" || busy === "remove" ? "WAITING FOR YOUR PASSWORD…" : action === "remove" ? "REMOVE" : "SET UP"}
                    </Btn>
                  </Row>
                )}
              </div>
              {errLine(`${d.id}:device`)}
            </Section>
            <Section top title="DEVICE RUNS · YOUR ACCOUNT" icon={Key} desc="for the runs you send to a shared device.">
              <div style={CARD}>{token(true)}</div>
              {errLine(`${d.id}:token`)}
            </Section>
          </div>
        );
      })}
    </>
  );
}
