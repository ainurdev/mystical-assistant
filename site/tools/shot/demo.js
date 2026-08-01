// Swap this machine's real repos and session titles for a demo set, so a
// dashboard screenshot can be published without leaking a client's repo names.
// Run via shot.py: `--eval "$(cat demo.js)"`. It edits the rendered DOM only —
// nothing is written back to the bridge, and a refresh undoes all of it.
//
// The product's own repo (mystical-assistant) is left alone on purpose: it's the
// one name a visitor should recognise.
(() => {
  // Distinctive enough to replace anywhere they appear — breadcrumbs, group
  // headers, the status bar's repo path, session badges.
  const NAMES = {
    "ainurhq.cloud": "acme-web",
    "ibgroups_operations": "billing-service",
    "ibgroup_designrun": "design-system",
    "report-generator": "reporting",
    "mystical-jobs": "worker-queue",
    "mystical-tech": "docs-site",
    "unideck-api": "storefront-api",
    "unideck-mono": "storefront",
    "yggdrasil": "infra",
    "invoicer": "invoices",
    "unideck": "storefront",
    "ainurhq": "acme",
    "aligned": "analytics",
    "efas": "checkout",
    // Branch names are half the identifying detail in the session list.
    "refactor/permissions-as-source-of-truth": "feat/rate-limit",
    "feat/A6-rie-flow": "fix/checkout-flake",
  };
  // Ambiguous as substrings ("app" is inside "application"), so these only
  // match a text node that is nothing but the name.
  const EXACT = { app: "web", website: "marketing" };

  const TITLES = [
    "Add rate limiting to the public API",
    "Fix the flaky checkout test",
    "Port the settings modal to the new tokens",
    "Why is the worker OOMing on deploy?",
    "Write the migration for soft deletes",
    "Refactor auth into a single guard",
    "Investigate slow first paint on the dashboard",
    "Add pagination to the issues list",
    "Upgrade to Vite 6",
    "Document the webhook retry policy",
    "Split the checkout reducer",
    "Cache the pricing lookup",
  ];

  // The centre pane is the biggest thing a visitor reads, so the shot shows a
  // session on this project rather than whichever one happens to be newest —
  // its own repo is the only conversation that's safe to publish verbatim.
  const OWN = "MYST";
  const own = [...document.querySelectorAll('[data-ctx-type="session"]')]
    .find((row) => row.textContent.includes(OWN));
  if (own) own.click();

  const walk = (root, fn) => {
    const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (it.nextNode()) nodes.push(it.currentNode);
    nodes.forEach(fn);
  };

  const scrub = () => {
    // Session titles are free text, so they go by position rather than by match.
    // The open one keeps its real title: it has to match the transcript on screen.
    document.querySelectorAll('[data-ctx-type="session"]').forEach((row, i) => {
      if (row === own) return;
      const label = TITLES[i % TITLES.length];
      // The title is the first line of the row's text column — addressed by
      // position, so it gets overwritten whatever it currently says. Matching on
      // the old text instead left new rows through and sometimes hit the branch chip.
      const title = row.querySelector("div")?.firstElementChild;
      if (title && title.textContent !== label) title.textContent = label;
      row.setAttribute("data-ctx-label", label);
    });

    walk(document.body, (n) => {
      let v = n.nodeValue;
      if (!v.trim()) return;
      for (const [from, to] of Object.entries(NAMES)) {
        if (v.includes(from)) v = v.split(from).join(to);
        const upper = from.toUpperCase();
        if (v.includes(upper)) v = v.split(upper).join(to.toUpperCase());
      }
      const exact = EXACT[v.trim()] ?? EXACT[v.trim().toLowerCase()];
      if (exact) v = v.replace(v.trim(), v.trim() === v.trim().toUpperCase() ? exact.toUpperCase() : exact);
      // Absolute paths carry the account name; the tilde form reads better anyway.
      // The Accounts tab prints the signed-in Claude login, so addresses go too.
      v = v.split("/home/mhzrerfani").join("~").split("Mahziyar Erfani").join("Alex Rivers")
        .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "you@example.com")
        // The account chip prints the bare login name, which the paths above miss.
        .split("mhzrerfani").join("alex");
      if (v !== n.nodeValue) n.nodeValue = v;
    });
  };

  // The dashboard polls every few seconds and React re-renders over these edits,
  // so re-apply after every mutation — detached while writing, or it feeds itself.
  const observer = new MutationObserver(() => {
    observer.disconnect();
    scrub();
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  scrub();
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
})();
