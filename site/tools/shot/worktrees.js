// The WORKTREES shot: six branches, each checked out in its own directory with
// its own session running in it — the state the tab is built for, which no one
// machine happens to be in when the shutter opens.
//
// Run via shot.py: `--eval "$(cat worktrees.js)"`. It shims window.fetch so the
// bridge's answers *for one project* describe that fleet, then opens the tab.
// Everything on screen is the real component rendering them — nothing is drawn
// by hand, nothing is written back to the bridge, and a refresh undoes all of it.
// Self-contained: paths are already in the published tilde form, so this one
// does not need demo.js.
(async () => {
  const PROJ = "/mystical-assistant";
  const ROOT = "~/projects/.worktrees/mystical-assistant";
  const BASE = "master";

  // A branch per thing in flight, its own checkout, its own session(s) in it.
  const FLEET = [
    { br: "feat/preview-queue", ahead: 6, behind: 0, dirty: 3,
      sess: ["Queue prompts while a turn is running", "Tab the preview console"] },
    { br: "fix/limit-resume", ahead: 2, behind: 1, dirty: 0,
      sess: ["Park the turn until the usage window resets"] },
    { br: "feat/commit-graph", ahead: 4, behind: 0, dirty: 2,
      sess: ["Draw the branch lanes in the GIT tab"] },
    { br: "refactor/hud-tokens", ahead: 3, behind: 2, dirty: 1,
      sess: ["Port the settings modal to the new tokens", "Kill the last hard-coded hex"] },
    { br: "chore/vite-6", ahead: 1, behind: 0, dirty: 0,
      sess: ["Upgrade the dashboard build to Vite 6"] },
    { br: "docs/readme-rewrite", ahead: 2, behind: 0, dirty: 4,
      sess: ["Rewrite the README above the fold"] },
  ];
  // Branches with no checkout of their own — the tab folds these under the live ones.
  const PLAIN = ["wip/opencode-runtime", "feat/miniapp-voice", "fix/telegram-poll"];

  const json = (body) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  const gitStatus = (branch) => {
    const w = FLEET.find((f) => f.br === branch);
    return { is_repo: true, branch, ahead: w?.ahead ?? 0, behind: w?.behind ?? 0, dirty: w?.dirty ?? 2, files: [] };
  };

  const now = Math.floor(Date.now() / 1000);
  const SESSIONS = FLEET.flatMap((f, i) =>
    f.sess.map((title, j) => ({
      id: `wt-demo-${i}-${j}`, title, project: PROJ, updated: now - (i * 240 + j * 90),
      archived: 0, origin: "dashboard", cwd: `${ROOT}/${f.br}`, branch: f.br,
    })),
  );

  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.origin);
    const p = url.pathname;
    // Sessions are appended rather than replaced: the rail behind the modal
    // keeps whatever is really running on this machine.
    if (p === "/local/sessions") {
      const d = await (await real(input, init)).json();
      return json({ sessions: [...SESSIONS, ...(d.sessions ?? [])] });
    }
    if (url.searchParams.get("project") === PROJ) {
      if (p === "/local/git/worktrees") {
        return json({
          worktrees: [
            { path: `~/projects/mystical-assistant`, rel: PROJ, branch: BASE, head: "6e24d7dd43", detached: false, is_main: true },
            ...FLEET.map((f, i) => ({
              path: `${ROOT}/${f.br}`, rel: `/.worktrees/mystical-assistant/${f.br}`,
              branch: f.br, head: `c36e2925${i}${i}`, detached: false, is_main: false,
            })),
          ],
        });
      }
      if (p === "/local/git/branches")
        return json({ branches: [BASE, ...FLEET.map((f) => f.br), ...PLAIN], current: BASE, default: BASE });
      if (p === "/local/git") return json(gitStatus(url.searchParams.get("branch") || BASE));
    }
    return real(input, init);
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const analyzeBtn = () =>
    document.querySelector(`[data-ctx-type="project"][data-ctx-id="${PROJ}"] [title="open project details"]`);

  localStorage.setItem("hud-modal-full", "1"); // the modal opens filling the window
  await sleep(5600);                           // the session poll (5s) picks the fleet up
  if (!analyzeBtn()) {                         // the Projects panel may be collapsed
    document.querySelector('[aria-label="Projects"]')?.click();
    await sleep(900);
  }
  analyzeBtn()?.click();
  await sleep(1400);
  [...document.querySelectorAll("button")].find((b) => /WORKTREES/.test(b.textContent))?.click();
  await sleep(700);
  // One row open, so the shot also carries what a worktree row *is*: its own
  // directory, the session already attached to it, and where it merges back.
  const row = document.querySelector('[data-ctx-type="branch"][data-ctx-id="feat/preview-queue"]');
  row?.firstElementChild?.click();
  // The modal is centred at 96vw × 94vh, which would leave a rim of dashboard
  // (and its real repo names) around the shot. Filling the window means the
  // capture needs no crop: the frame is the panel.
  const panel = row?.closest(".panel");
  if (panel) {
    // The backdrop is a padded flex centre, so the padding has to go too — it is
    // what shrinks the box back down however wide the panel itself is told to be.
    Object.assign(panel.parentElement.style, { padding: "0" });
    Object.assign(panel.style,
      { width: "100%", height: "100%", maxWidth: "none", maxHeight: "none", border: "0" });
  }
  await sleep(500);
})();
