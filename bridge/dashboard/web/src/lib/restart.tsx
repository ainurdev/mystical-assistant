/* Restart the bridge — the process this dashboard is served from — without
   pulling anything. The reason it exists: the running bridge is a snapshot of
   the code from when it launched, so an edit already on disk (or a setting that
   says "waits for a restart") only lands on the next boot.

   Same path PULL & RESTART takes: SIGINT, clean shutdown, os.execv. Running
   turns die with it and startup recovery resumes them, so this asks once and
   then just waits for the port to answer again — behind the boot intro, whose
   log doubles as the progress report and whose CRT wipe lands on the reload
   into the real boot. */
import { useEffect, useState } from "react";
import { api } from "../api";
import { askConfirm } from "../components/ui/Ask";
import { notify } from "../components/hud/Notifications";
import { BootIntro } from "../components/hud/BootIntro";
import { BOOT_CONTINUE, type BootStep } from "./bootsteps";
import type { ThemeKey } from "./theme";

// Three real events, same as the startup log: nothing here is on a timer.
// BRIDGE DOWN is the odd one — it stays on dots if the process blinked back
// between two probes, which is a truthful thing for it to say.
const STEPS = [
  { key: "signal", label: "RESTART SIGNAL" },
  { key: "down", label: "BRIDGE DOWN" },
  { key: "await", label: "AWAITING BRIDGE" },
];

let host: ((steps: BootStep[] | null) => void) | null = null;

/** Mounted once by App — the overlay restartBridge() draws into. */
export function RestartIntro(props: { theme: ThemeKey; scanlines: boolean }) {
  const [steps, setSteps] = useState<BootStep[] | null>(null);
  useEffect(() => {
    host = setSteps;
    return () => { host = null; };
  }, []);
  if (!steps) return null;
  // Held: the only exits are the reload and the give-up below. Letting it wipe
  // itself off would uncover a dashboard talking to a port that isn't there —
  // and the reload is about to draw this same intro again anyway.
  return (
    <BootIntro theme={props.theme} scanlines={props.scanlines} steps={steps} hold
      onReveal={() => {}} onDone={() => setSteps(null)} />
  );
}

/** Ride out a re-exec behind the overlay and reload into the new process, for
    whoever asked for one — the restart action here, PULL & RESTART, or UPDATE
    CLAUDE. Returns only if the bridge never came back. */
export async function watchRestart(signal = "SIGINT", tries = 60) {
  let steps: BootStep[] = STEPS.map((s) => ({ ...s, phase: "wait", detail: "" }));
  const mark = (key: string, phase: "ok" | "fail", detail: string) => {
    steps = steps.map((s) => (s.key === key && s.phase === "wait" ? { ...s, phase, detail } : s));
    host?.(steps);
  };
  mark("signal", "ok", signal);

  // Every request fails while it re-execs; the first one that lands is the new
  // process, so reload into it.
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      await api.state();
    } catch {
      mark("down", "ok", "RE-EXEC");
      continue;
    }
    mark("await", "ok", "ONLINE");
    // The next document's intro carries on from this one rather than replaying.
    sessionStorage.setItem(BOOT_CONTINUE, "1");
    location.reload();
    return;
  }
  host?.(null);
  notify("error", "bridge did not come back — check the logs");
}

export async function restartBridge() {
  const ok = await askConfirm(
    "Restart the bridge? The dashboard drops for a few seconds and reloads itself; " +
    "running turns resume where they left off.",
  );
  if (!ok) return;
  try {
    await api.restart();
  } catch (e) {
    notify("error", (e as Error).message);
    return;
  }
  await watchRestart();
}

/** For a turn the API refused because the CLI is older than the model: the same
    re-exec, with `claude update` run while the bridge is down. The install can
    take minutes on a slow link (the server gives it 300s), so wait up to 6. */
export async function updateClaude() {
  const ok = await askConfirm(
    "Update Claude Code and restart the bridge? Running turns stop while it installs " +
    "and resume after; the dashboard reloads itself when it's back.",
  );
  if (!ok) return;
  try {
    await api.updateClaude();
  } catch (e) {
    notify("error", (e as Error).message);
    return;
  }
  await watchRestart("CLAUDE UPDATE", 240);
}
