import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api, type UpdateInfo } from "../../api";
import { notify } from "./Notifications";
import { watchRestart } from "../../lib/restart";

// Header sync button for the platform's own checkout, both directions: pull the
// commits waiting upstream (then rebuild + restart the bridge), or ship the work
// sitting here — commit it with a message Claude writes from the diff, then push.
// Always present: with nothing to do it sits there quietly as an in-sync badge.
// ponytail: self-contained (polls + owns its modal) like NotificationCenter, so
// the Strip stays a dumb header.
const POLL_MS = 300_000; // 5 min — new commits are not a live-tail concern

export function UpdateButton({ onFeed }: { onFeed: (texts: string[]) => void }) {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<"" | "updating" | "restarting" | "shipping" | "checking">("");
  const [err, setErr] = useState("");
  const [failed, setFailed] = useState<"pull" | "ship">("pull");
  const [hov, setHov] = useState("");
  const busy = phase !== "";

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try { const u = await api.update(); if (live) setInfo(u); } catch { /* ignore */ }
    };
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => { live = false; clearInterval(id); };
  }, []);

  async function load() {
    try { setInfo(await api.update()); } catch { /* ignore */ }
  }

  // Pull + rebuild happen inside this one request (tens of seconds); the bridge
  // only restarts once it answers ok.
  async function apply() {
    setPhase("updating");
    setErr("");
    try {
      const r = await api.applyUpdate();
      if (!r.ok) {
        setPhase("");
        setFailed("pull");
        setErr(r.output || "git pull failed");
        return;
      }
    } catch (e) {
      setPhase("");
      setFailed("pull");
      setErr((e as Error).message);
      return;
    }
    setPhase("restarting");
    void waitForRestart();
  }

  // Commit (message generated server-side from the diff) + push, in one request.
  // Slow — a headless model call — so the button says COMMITTING while it runs.
  async function ship() {
    setPhase("shipping");
    setErr("");
    try {
      const r = await api.publishUpdate();
      if (!r.ok) {
        setPhase("");
        setFailed("ship");
        setErr(r.output || "commit/push failed");
        return;
      }
      notify("info", r.message ? `pushed — ${r.message.split("\n")[0]}` : "pushed");
    } catch (e) {
      setPhase("");
      setFailed("ship");
      setErr((e as Error).message);
      return;
    }
    setPhase("");
    setOpen(false);
    await load();
  }

  // Escape hatch when git refuses (diverged history, rejected push…): hand the
  // failure to Claude in the composer rather than making the user go find a terminal.
  function fixWithClaude() {
    const where = info?.path || "the mystical-assistant repo";
    const pending = info?.behind ?? 0;
    onFeed([
      failed === "ship"
        ? `Committing and pushing the platform's own work in \`${where}\` failed. Work out ` +
          `what blocks it and fix it, then commit the changes with a good message and push.` +
          `\n\ngit said:\n${err}`
        : `Updating the platform failed: \`git pull --ff-only\` in the bridge's own checkout ` +
          `(${where}) refused. Work out what blocks it and fix it, then pull the ${pending} ` +
          `pending commit${pending === 1 ? "" : "s"}. Don't discard my source changes — ` +
          `generated bundles under dist/ are safe to reset.\n\ngit said:\n${err}`,
    ]);
    setOpen(false);
    setErr("");
  }

  // The bridge is re-execing: the boot intro comes back up and waits it out,
  // then reloads into the new build. Only returns if it never came back.
  async function waitForRestart() {
    await watchRestart("PULLED");
    setPhase("");
    setOpen(false);
  }

  async function recheck() {
    setPhase("checking");
    await load();
    setPhase("");
  }

  if (!info || !info.repo) return null;
  // A bridge process older than this bundle answers without the fields it
  // predates; `dirty + undefined` is NaN, which is falsy and reads as IN SYNC —
  // the one wrong answer this button must never give. Default every field.
  const incoming = info.behind ?? 0;
  const local = (info.dirty ?? 0) + (info.ahead ?? 0);
  const tone = incoming ? "var(--ok)" : local ? "var(--warn)" : "var(--txf)";
  const label = phase === "checking" ? "CHECKING…"
    : incoming && local ? `SYNC ${incoming}↓ ${local}↑`
    : incoming ? `UPDATE ${incoming}`
    : local ? `SHIP ${local}`
    : hov === "btn" ? "RECHECK" : "IN SYNC";
  const title = incoming && local
    ? `${incoming} commit${incoming === 1 ? "" : "s"} upstream, ${local} of yours to ship`
    : incoming ? `${incoming} new commit${incoming === 1 ? "" : "s"} on ${info.branch}'s upstream`
    : local ? `${info.dirty} uncommitted change${info.dirty === 1 ? "" : "s"}, ` +
              `${info.ahead} unpushed commit${info.ahead === 1 ? "" : "s"}`
    : `${info.branch} is in sync with its upstream — click to check again`;
  const hp = (k: string) => ({ onMouseEnter: () => setHov(k), onMouseLeave: () => setHov("") });

  return (
    <>
      <button
        onClick={() => (incoming || local ? setOpen(true) : void recheck())}
        title={title}
        {...hp("btn")}
        style={{
          appearance: "none", cursor: "pointer", flex: "none",
          height: 22, padding: "0 9px", boxSizing: "border-box",
          border: `1px solid color-mix(in srgb, ${tone} 34%, transparent)`,
          background: `color-mix(in srgb, ${tone} ${hov === "btn" ? 14 : 7}%, transparent)`,
          color: tone, fontFamily: "var(--mono)", fontSize: "var(--t95)", letterSpacing: 1.4,
          display: "flex", alignItems: "center", gap: 6,
          opacity: incoming || local ? 1 : 0.75,
        }}
      >
        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}>
          {incoming ? <path d="M12 3v12M7 10l5 5 5-5M4 20h16" />
            : local ? <path d="M12 21V9M7 14l5-5 5 5M4 4h16" />
            : <path d="M20 6L9 17l-5-5" />}
        </svg>
        {/* The count reads as the ledger's value, not part of the verb. */}
        {phase !== "checking" && incoming && !local ? <>UPDATE <span style={{ color: "var(--txm)", letterSpacing: ".4px" }}>{incoming}</span></>
          : phase !== "checking" && local && !incoming ? <>SHIP <span style={{ color: "var(--txm)", letterSpacing: ".4px" }}>{local}</span></>
          : label}
      </button>

      {/* Portalled into the themed container: the Strip's own animation makes it a
          containing block for position:fixed, which pinned the modal to the header. */}
      {open && createPortal(
        <div onClick={() => !busy && setOpen(false)}
          style={{ position: "fixed", inset: 0, background: "color-mix(in srgb, var(--panel3) 78%, transparent)", zIndex: 96, display: "flex", alignItems: "center", justifyContent: "center", animation: "backdropIn .2s ease both" }}>
          <div onClick={(e) => e.stopPropagation()} className="panel"
            style={{ width: 470, maxWidth: "92vw", border: "1px solid color-mix(in srgb, var(--acc) 45%, transparent)", background: "rgba(9,13,13,.99)", boxShadow: "0 0 60px var(--shadow-modal)", animation: "mslide .2s ease both" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "15px 18px", borderBottom: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)" }}>
              <span style={{ fontSize: "var(--t13)", color: "var(--txb)", letterSpacing: ".5px" }}>
                {incoming && local ? "Sync platform" : incoming ? "Update platform" : "Ship your changes"}
              </span>
              <span style={{ flex: 1 }} />
              <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t95)", color: "var(--txf)" }}>⎇ {info.branch}</span>
            </div>
            <div style={{ padding: "16px 18px" }}>
              {local > 0 && (
                <>
                  <div style={{ fontSize: "var(--t9)", letterSpacing: 1.5, color: "var(--warn)", marginBottom: 7 }}>YOURS ↑</div>
                  <div style={{ fontSize: "var(--t125)", color: "var(--txh)", lineHeight: 1.6 }}>
                    {info.dirty > 0
                      ? `Commits ${info.dirty} change${info.dirty === 1 ? "" : "s"} with a message written from the diff, then pushes`
                      : "Pushes"}
                    {info.ahead > 0 && ` ${info.ahead} unpushed commit${info.ahead === 1 ? "" : "s"}`}
                    {info.dirty > 0 && info.ahead === 0 && " it"}.
                  </div>
                  <div style={{ marginTop: 10, maxHeight: 150, overflowY: "auto", borderLeft: "2px solid color-mix(in srgb, var(--warn) 30%, transparent)", padding: "2px 0 2px 10px" }}>
                    {(info.files ?? []).map((f) => (
                      <div key={f.path} style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t10)", color: "var(--txm)", padding: "2px 0", display: "flex", gap: 7, whiteSpace: "nowrap" }}>
                        <span style={{ color: "var(--warn)", flex: "none" }}>{f.status}</span>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{f.path}</span>
                        <span style={{ flex: 1 }} />
                        <span style={{ color: "var(--ok)", flex: "none" }}>+{f.add}</span>
                        <span style={{ color: "var(--err)", flex: "none" }}>−{f.del}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {incoming > 0 && (
                <>
                  <div style={{ fontSize: "var(--t9)", letterSpacing: 1.5, color: "var(--ok)", marginTop: local > 0 ? 18 : 0, marginBottom: 7 }}>THEIRS ↓</div>
                  <div style={{ fontSize: "var(--t125)", color: "var(--txh)", lineHeight: 1.6 }}>
                    Pulls {incoming} new commit{incoming === 1 ? "" : "s"}, rebuilds the dashboard and restarts the
                    bridge. Running turns are resumed automatically; dev servers and the tunnel come
                    back with it.
                  </div>
                  <div style={{ marginTop: 10, maxHeight: 150, overflowY: "auto", borderLeft: "2px solid color-mix(in srgb, var(--acc) 30%, transparent)", padding: "2px 0 2px 10px" }}>
                    {(info.commits ?? []).map((c) => (
                      <div key={c.sha} style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t10)", color: "var(--txm)", padding: "2px 0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        <span style={{ color: "var(--acc)" }}>{c.sha}</span> {c.subject}
                      </div>
                    ))}
                  </div>
                </>
              )}
              {incoming > 0 && info.dirty > 0 && (
                <div style={{ marginTop: 12, border: "1px solid color-mix(in srgb, var(--warn) 35%, transparent)", background: "color-mix(in srgb, var(--warn) 6%, transparent)", color: "var(--warn)", fontSize: "var(--t105)", letterSpacing: ".3px", padding: "8px 11px", display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ flex: "none" }}>⚠</span>
                  <span>A fast-forward pull refuses on a dirty tree — commit &amp; push first.</span>
                </div>
              )}
              {err && (
                <div style={{ marginTop: 12, border: "1px solid color-mix(in srgb, var(--err) 40%, transparent)", background: "color-mix(in srgb, var(--err) 7%, transparent)", padding: "9px 11px" }}>
                  <div style={{ fontSize: "var(--t9)", letterSpacing: 1.5, color: "var(--err)", marginBottom: 6 }}>{failed === "ship" ? "PUSH FAILED" : "UPDATE FAILED"}</div>
                  <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t95)", color: "var(--txm)", whiteSpace: "pre-wrap", maxHeight: 150, overflowY: "auto" }}>{err}</div>
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 9, padding: "0 18px 16px" }}>
              <button onClick={() => setOpen(false)} disabled={busy} {...hp("cancel")}
                style={{ flex: 1, appearance: "none", cursor: busy ? "not-allowed" : "pointer", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: hov === "cancel" ? "color-mix(in srgb, var(--acc) 6%, transparent)" : "transparent", color: "var(--tx)", fontFamily: "inherit", fontSize: "var(--t105)", letterSpacing: 1.5, padding: 10, opacity: busy ? 0.5 : 1 }}>CANCEL</button>
              {err ? (
                <button onClick={fixWithClaude} {...hp("fix")}
                  style={{ flex: 1.4, appearance: "none", cursor: "pointer", border: "1px solid var(--acc)", background: hov === "fix" ? "color-mix(in srgb, var(--acc) 28%, transparent)" : "color-mix(in srgb, var(--acc) 16%, transparent)", color: "var(--acc)", fontFamily: "inherit", fontSize: "var(--t105)", letterSpacing: 1.5, padding: 10 }}>
                  ▸ FIX WITH CLAUDE</button>
              ) : (
                <>
                  {local > 0 && (
                    <button onClick={() => void ship()} disabled={busy} {...hp("ship")}
                      style={{ flex: 1.3, appearance: "none", cursor: busy ? "wait" : "pointer", border: "1px solid var(--warn)", background: hov === "ship" ? "color-mix(in srgb, var(--warn) 28%, transparent)" : "color-mix(in srgb, var(--warn) 16%, transparent)", color: "var(--warn)", fontFamily: "inherit", fontSize: "var(--t105)", letterSpacing: 1.5, padding: 10, opacity: busy ? 0.7 : 1 }}>
                      {phase === "shipping" ? "COMMITTING…" : info.dirty > 0 ? "COMMIT & PUSH" : "PUSH"}</button>
                  )}
                  {incoming > 0 && (
                    <button onClick={() => void apply()} disabled={busy} {...hp("go")}
                      style={{ flex: 1.3, appearance: "none", cursor: busy ? "wait" : "pointer", border: "1px solid var(--ok)", background: hov === "go" ? "color-mix(in srgb, var(--ok) 28%, transparent)" : "color-mix(in srgb, var(--ok) 16%, transparent)", color: "var(--ok)", fontFamily: "inherit", fontSize: "var(--t105)", letterSpacing: 1.5, padding: 10, opacity: busy ? 0.7 : 1 }}>
                      {phase === "updating" ? "UPDATING…" : phase === "restarting" ? "RESTARTING…" : "PULL & RESTART"}</button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>,
        document.querySelector("[data-theme]") ?? document.body,
      )}
    </>
  );
}
