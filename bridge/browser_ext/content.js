// The Mystical browser's comment tool, on every page (bridge/site_browser.py).
// Closed, it's a thin tab halfway up the right edge (never a corner: apps keep their own buttons
// there). Open, it's a card in the top right that holding its head moves (kept for every site, ⋯
// puts it back), and it steps aside while you pick or write, so nothing on the page is out of its reach.
// C or + Comment starts picking: hover outlines an element and names it, a drag draws an
// area, a click or a finished drag opens the box to write in. The site keeps one list: this page's
// comments on top, other pages' below under their names, each a line that opens in place (its
// picture, its words to edit, Show it or Go to it, Point again, Delete). Markers show only on
// their own page. Send starts a new chat with every comment as one turn, page by page, each with a
// crop of what it points at, so nothing waits in a busy chat's queue; the From line above it names
// the chat whose project and worktree the new chat gets, and opens the chats to pick from in place.
// ⋯ holds the tray's tools: markers on or off (M), fold to a bar that still sends (F), back to its
// corner, clear this page or all. A single-page app's pages count too: the script follows the
// address when the app changes it in place.
// It wears the theme the dashboard last saved (GET /theme): its tokens go on the host over the
// AURORA look :host spells out, which also keeps the page's own CSS variables from reaching in.
// Everything lives in a shadow root so the page's CSS can't reach it, and the page's own keys
// and clicks are left alone unless you're picking (M and F only while the tray is open).
(() => {
  if (window.top !== window || document.getElementById("mystical-comments")) return;
  // A page is its address without the hash, unless the hash is an app's route (#/…, #!/…): an anchor (#notes) is the same page.
  const pageOf = () => `${location.origin}${location.pathname}${location.search}${/^#!?\//.test(location.hash) ? location.hash : ""}`;
  let page = pageOf();
  const SITE = `site:${location.origin}`, SPOT = "tray-spot", MARKERS = "tray-markers", GO = `tray-go:${location.origin}`;
  const ask = (m) => new Promise((ok) => chrome.runtime.sendMessage(m, (r) => ok(r || { error: chrome.runtime.lastError?.message || "No answer." })));

  const host = document.createElement("div");
  host.id = "mystical-comments";
  host.style.cssText = "all:initial;position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
    :host{--acc:#7fe9d8;--acc-on:#060a0a;--canvas:#060a0a;--panel:rgba(7,13,13,.97);--panel2:#070d0d;--panel3:#040707;--tx:#bfe6de;--txb:#dff8f2;--txm:#9fc7c0;--txd:#6f938d;--txl:#5f817b;--border:rgba(127,233,216,.16);--border-bright:rgba(127,233,216,.4);--ask:#e3c279;--err:#e0897a;--ui-font:ui-monospace,"JetBrains Mono",Menlo,monospace;--prad:0px}
    *{box-sizing:border-box;font:12.5px/1.45 var(--ui-font);color:var(--tx)}
    button{all:unset;cursor:pointer;box-sizing:border-box}
    button:focus-visible{outline:2px solid var(--acc);outline-offset:-2px}
    button[disabled]{opacity:.4;cursor:default}
    svg{width:14px;height:14px;flex:none}
    kbd{font-size:10px;font-weight:600;color:var(--txd);border:1px solid var(--border-bright);border-radius:4px;padding:0 4px;line-height:15px}
    .sp{flex:1}
    .tab{position:fixed;right:0;top:50%;transform:translateY(-50%);background:var(--canvas);border:1px solid var(--border-bright);border-right:0;border-radius:var(--prad) 0 0 var(--prad);padding:10px 5px;writing-mode:vertical-rl;letter-spacing:3px;font-size:10px;color:var(--acc);text-transform:uppercase;width:22px;transition:width .12s}
    .tab:hover,.tab:focus-visible{width:28px;outline:none;box-shadow:0 0 10px color-mix(in srgb,var(--acc) 35%,transparent)}
    .tab.on{background:var(--acc);color:var(--acc-on)}
    .tray{position:fixed;top:60px;right:12px;width:300px;max-height:calc(100vh - 72px);background:var(--panel);border:1px solid var(--border-bright);border-radius:var(--prad);display:flex;flex-direction:column;box-shadow:0 10px 32px rgba(0,0,0,.45)}
    .hd{display:flex;align-items:center;gap:4px;padding:8px 8px 8px 12px;border-bottom:1px solid var(--border-bright);cursor:grab;user-select:none;touch-action:none}
    .fold .hd{border-bottom:0}
    .t{flex:1;min-width:0;font-size:13px;font-weight:600;color:var(--txb);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .t em{font-size:13px;font-style:normal;color:var(--txd)}.t.bad{color:var(--err)}
    .mk{color:var(--acc);margin-right:6px}
    .ib{width:26px;height:26px;border-radius:min(var(--prad),7px);display:inline-flex;align-items:center;justify-content:center;color:var(--txd);flex:none}
    .ib:hover,.ib.on{background:color-mix(in srgb,var(--txl) 22%,transparent);color:var(--txb)}
    .add{margin:10px 12px 4px;border:1px dashed var(--border-bright);border-radius:min(var(--prad),8px);padding:7px 10px;display:flex;align-items:center;justify-content:center;gap:6px;color:var(--acc);font-size:11px;letter-spacing:1.5px;text-transform:uppercase}
    .add:hover{background:color-mix(in srgb,var(--acc) 8%,transparent)}
    .list{flex:1 1 auto;min-height:0;overflow:auto;padding-bottom:6px}
    .grp{display:flex;align-items:center;gap:7px;padding:11px 12px 4px;font-size:11.5px;font-weight:600;color:var(--txm)}
    .here{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;color:var(--acc)}
    .here:before{content:"";width:6px;height:6px;border-radius:50%;background:var(--acc)}
    .cnt{font-size:11.5px;color:var(--txd)}
    .go{display:inline-flex;align-items:center;gap:2px;font-size:11.5px;color:var(--txd)}.go:hover{color:var(--txb)}
    .it{display:flex;align-items:center;gap:9px;width:100%;padding:6px 12px}
    .it:hover,.ch:hover{background:color-mix(in srgb,var(--acc) 8%,transparent)}
    .n{flex:none;width:20px;height:20px;border-radius:min(var(--prad),6px);display:flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:700;background:var(--acc);color:var(--acc-on)}
    .n.away{background:none;border:1px solid var(--border-bright);color:var(--txd)}
    .w1{flex:1;min-width:0;font-size:13px;color:var(--txb);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .open{padding:8px 12px 10px;background:color-mix(in srgb,var(--acc) 13%,transparent)}
    .pic{position:relative;margin-bottom:8px;border:1px solid var(--border-bright);border-radius:min(var(--prad),8px);background:var(--panel3);overflow:hidden;cursor:pointer}
    .pic img{display:block;max-width:100%;max-height:118px;margin:0 auto}
    .pic i{display:block;padding:20px 0;text-align:center;color:var(--txd)}
    .pic .n{position:absolute;left:6px;top:6px}
    .edit{all:unset;display:block;box-sizing:border-box;width:100%;field-sizing:content;min-height:34px;max-height:140px;overflow:auto;padding:6px 8px;border:1px solid var(--border-bright);border-radius:min(var(--prad),7px);background:var(--panel3);color:var(--txb);font-size:13px;line-height:1.35;white-space:pre-wrap}
    .edit:focus{border-color:var(--acc);box-shadow:0 0 0 3px color-mix(in srgb,var(--acc) 20%,transparent)}
    .w2{margin-top:6px;font-size:11.5px;color:var(--txd);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .row{display:flex;align-items:center;gap:6px;margin-top:8px}
    .open .row{flex-wrap:wrap}.open .bad{margin-left:auto}
    .btn{display:inline-flex;align-items:center;gap:5px;padding:4px 7px;border:1px solid var(--border-bright);border-radius:min(var(--prad),7px);font-size:12px;font-weight:600;color:var(--tx);white-space:nowrap;letter-spacing:1px;text-transform:uppercase}
    .btn:hover{border-color:var(--acc)}.btn.bad{color:var(--err)}
    .btn.solid{background:var(--acc);border-color:var(--acc);color:var(--acc-on)}
    .btn.danger{background:var(--err);border-color:var(--err);color:var(--canvas)}
    .empty{padding:14px 12px;color:var(--txd);font-style:italic}
    .ft{display:flex;flex-direction:column;gap:8px;padding:10px 12px 12px;border-top:1px solid var(--border-bright)}
    .to{display:flex;align-items:center;gap:7px;min-width:0;padding:6px 9px;border:1px solid var(--border-bright);border-radius:min(var(--prad),8px)}
    .to:hover{border-color:var(--acc)}
    .to .k,.to .pj{color:var(--txd);white-space:nowrap}
    .to .c{min-width:0;font-weight:600;color:var(--txb);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .to svg{color:var(--txd)}.to svg:last-child{margin-left:auto}
    .send{padding:8px;border-radius:min(var(--prad),8px);background:var(--acc);color:var(--acc-on);text-align:center;font-size:13px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase}
    .note{font-size:11.5px;color:var(--txd)}.note.bad{color:var(--err)}
    .dot{flex:none;width:8px;height:8px;border-radius:50%}
    .dot.working{background:var(--acc);box-shadow:0 0 0 3px color-mix(in srgb,var(--acc) 28%,transparent)}
    .dot.needs{background:var(--ask);box-shadow:0 0 0 3px color-mix(in srgb,var(--ask) 22%,transparent)}
    .dot.idle{border:1.5px solid var(--txl)}
    .search{display:flex;align-items:center;gap:7px;margin:9px 10px 4px;padding:6px 9px;border:1px solid var(--border-bright);border-radius:min(var(--prad),8px);background:var(--panel3);color:var(--txd)}
    .search:focus-within{border-color:var(--acc)}
    .search input{all:unset;flex:1;min-width:0;color:var(--txb)}
    .search input::placeholder{color:var(--txd)}
    .sec{padding:9px 12px 3px;font-size:11px;font-weight:600;color:var(--txd)}
    .ch{display:flex;align-items:center;gap:9px;width:100%;padding:6px 12px}
    .ch.sel{background:color-mix(in srgb,var(--acc) 13%,transparent)}
    .ct{flex:1;min-width:0}
    .ct b{display:block;font-size:13px;font-weight:600;color:var(--txb);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .ct span{display:block;font-size:11.5px;color:var(--txd);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .ch .ck{color:var(--acc)}
    .menu{position:absolute;top:40px;right:8px;z-index:1;width:232px;padding:4px;background:var(--panel2);border:1px solid var(--border-bright);border-radius:min(var(--prad),10px);box-shadow:0 12px 32px rgba(0,0,0,.6)}
    .mi{display:flex;align-items:center;gap:9px;width:100%;padding:6px 8px;border-radius:min(var(--prad),6px);white-space:nowrap}
    .mi:hover{background:color-mix(in srgb,var(--acc) 12%,transparent)}
    .mi svg{color:var(--txd)}.mi.bad,.mi.bad svg{color:var(--err)}
    .mi kbd,.mi .s,.mi .sw{margin-left:auto}.mi .s{font-size:11.5px;color:var(--txd)}
    .sep{height:1px;margin:4px 2px;background:var(--border-bright)}
    .sw{position:relative;flex:none;width:26px;height:15px;border-radius:9px;background:var(--acc)}
    .sw:after{content:"";position:absolute;top:2px;right:2px;width:11px;height:11px;border-radius:50%;background:var(--txb)}
    .sw.off{background:var(--border-bright)}.sw.off:after{right:auto;left:2px;background:var(--txd)}
    .confirm{position:absolute;inset:4px;display:flex;flex-direction:column;justify-content:center;padding:6px 8px}
    .confirm b{display:block;font-weight:600;color:var(--txb)}.confirm .s{display:block;font-size:11.5px;color:var(--txd)}.confirm .row{justify-content:flex-end}
    .mini{padding:5px 10px;border-radius:min(var(--prad),7px);background:var(--acc);color:var(--acc-on);font-size:12px;font-weight:600;letter-spacing:1px;text-transform:uppercase}
    .hover{position:fixed;border:2px solid var(--acc);pointer-events:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--acc) 18%,transparent)}
    .tag{position:fixed;background:var(--canvas);color:var(--acc);border:1px solid var(--border-bright);border-radius:var(--prad);padding:2px 7px;font-size:10.5px;pointer-events:none;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis}
    .area{position:fixed;border:1.5px dashed var(--acc);background:color-mix(in srgb,var(--acc) 8%,transparent);pointer-events:none}
    .pin{position:absolute;width:22px;height:22px;background:var(--canvas);color:var(--acc);border:1.5px solid var(--acc);border-radius:min(var(--prad),7px);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;box-shadow:0 0 8px color-mix(in srgb,var(--acc) 50%,transparent)}
    .pin.hot{background:var(--acc);color:var(--acc-on);box-shadow:0 0 0 5px color-mix(in srgb,var(--acc) 32%,transparent),0 0 16px var(--acc)}
    .box{position:fixed;width:280px;background:var(--panel);border:1px solid var(--border-bright);border-radius:var(--prad);padding:10px;box-shadow:0 8px 30px rgba(0,0,0,.5)}
    .box textarea{all:unset;display:block;width:100%;min-height:64px;border:1px solid var(--border);border-radius:var(--prad);padding:6px 8px;color:var(--txb);white-space:pre-wrap;box-sizing:border-box}
    .box .w{color:var(--txd);font-size:10.5px;margin-bottom:6px;word-break:break-word}
    .box .row{justify-content:flex-end}
    .plain :is(.tab,.add,.send,.btn,.mini){text-transform:none;letter-spacing:.02em;font-weight:600}
  </style><div class="look"><div class="marks"></div><div class="live"></div><div class="ui"></div></div>`;
  const look = root.querySelector(".look");
  const marks = root.querySelector(".marks");
  const live = root.querySelector(".live");
  const ui = root.querySelector(".ui");

  let pins = [];               // the site's comments, page by page: {id, text, where, what, at, crop, page, title}
  let open = false;
  let picking = false;
  let repoint = null;          // Point again: the id of the comment the next pick moves
  let opened = null;           // the id of the comment open in place
  let flash = null, flashT = 0;  // Show it: the id whose marker is lit for a moment
  let menu = "";               // the ⋯ menu: "tools", or "sure" while it asks before Clear all
  let folded = false;
  let markers = true;
  let choosing = false;        // the chats a new chat can start from, in place of the list
  let choosingH = 0;           // ...at the height the tray had, so the box doesn't jump
  let query = "";              // ...their search
  let allOthers = false;       // ...every other project's chat, not only the latest
  let chats = null;            // {opener, project, chats} from the bridge
  let from = null;             // {id, title}: the chat picked for Send's new chat to start from; null = the one that opened the site
  let going = null;            // Go to it or Point again on its way to another page (after a load, GO in storage says it)
  let note = null;             // {text, bad}
  let busy = false;
  let spot = null;             // where you moved the tray (its top-left), kept for every site; null = its corner

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const ICON = {
    x: '<path d="M4 4l8 8M12 4l-8 8"/>',
    more: '<circle cx="3.5" cy="8" r="1.2" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r="1.2" fill="currentColor" stroke="none"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    eye: '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
    fold: '<path d="M3 5.5h10M5.5 9.5L8 12l2.5-2.5"/>',
    unfold: '<path d="M3 10.5h10M5.5 6.5L8 4l2.5 2.5"/>',
    trash: '<path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8.5h6.6l.7-8.5"/>',
    aim: '<circle cx="8" cy="8" r="5"/><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3"/>',
    go: '<path d="M6 3.5L10.5 8 6 12.5"/>',
    back: '<path d="M10 3.5L5.5 8l4.5 4.5"/>',
    down: '<path d="M4 6l4 4 4-4"/>',
    search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5l3 3"/>',
    check: '<path d="M3 8.5l3.2 3L13 4.5"/>',
    corner: '<path d="M6 3h7v7M13 3L5 11"/>',
    show: '<path d="M2 8h8M7 4.5L10.5 8 7 11.5"/><path d="M13.5 3v10"/>',
  };
  const ic = (k, cls = "") => `<svg class="${cls}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;
  const many = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const short = (project) => (project || "").split("/").filter(Boolean).pop() || "";
  const ago = (t) => { const s = Date.now() / 1000 - t; return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`; };
  const chatOf = (id) => chats?.chats?.find((c) => c.id === id);
  const fromChat = () => (from ? chatOf(from.id) || from : chats?.opener);
  const idx = (id) => pins.findIndex((p) => p.id === id);
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // ------- naming what you point at ---------------------------------------------------
  function describe(el) {      // for the agent: tag#id.class · "text"
    let name = el.tagName.toLowerCase();
    if (el.id) name += `#${el.id}`;
    else if (typeof el.className === "string" && el.className.trim()) name += "." + el.className.trim().split(/\s+/).slice(0, 2).join(".");
    const text = (el.getAttribute("aria-label") || el.innerText || el.value || el.alt || "").trim().replace(/\s+/g, " ");
    return text ? `${name} · "${text.slice(0, 40)}${text.length > 40 ? "…" : ""}"` : name;
  }
  function whatIs(el) {        // for you, in plain words: "Card number field", "“Choose Pro” button"
    const tag = el.tagName.toLowerCase(), type = el.type || "";
    const say = (s) => { s = String(s || "").trim().replace(/\s+/g, " "); return s.length > 40 ? `${s.slice(0, 40)}…` : s; };
    const name = say(el.getAttribute("aria-label") || el.labels?.[0]?.innerText || el.placeholder || el.alt);
    if (/^(textarea|select)$/.test(tag) || (tag === "input" && !/^(button|submit|reset|checkbox|radio|image)$/.test(type))) return name ? `${name} field` : "A field";
    if (tag === "img") return name ? `${name} image` : "An image";
    const role = el.getAttribute("role") || { a: "link", button: "button", input: /^(checkbox|radio)$/.test(type) ? type : "button" }[tag] || (/^h[1-6]$/.test(tag) ? "heading" : "");
    const text = name || say(el.innerText || el.value);
    return text ? `“${text}”${role ? ` ${role}` : ""}` : role ? `A ${role}` : "A part of the page";
  }
  const own = (e) => e.composedPath().includes(host);

  // ------- keeping pins ---------------------------------------------------------------
  // One list per site; crops add up across its pages, so the manifest asks for unlimitedStorage.
  function add(p) {            // after the others on its page, so a page's comments sit together, numbered in a row
    pins.splice(pins.findLastIndex((q) => q.page === p.page) + 1 || pins.length, 0, { id: newId(), ...p });
  }
  const save = () => {
    chrome.storage.local.set({ [SITE]: pins });
    ask({ kind: "api", path: "/pins", body: { url: location.href, count: pins.length } });
  };
  (async () => {
    const got = await chrome.storage.local.get([SITE, SPOT, MARKERS, GO]);
    pins = got[SITE] || [];
    spot = got[SPOT] || null;
    markers = got[MARKERS] !== false;
    // Before one list per site, every page kept its own (pins:<page>): fold those in.
    // shortcut: this looks for old keys on every load; drop it once no profile has any left.
    const old = (await chrome.storage.local.getKeys()).filter((k) => k.startsWith(`pins:${location.origin}/`));
    if (old.length) {
      const was = await chrome.storage.local.get(old);
      for (const k of old) for (const p of was[k] || []) add({ ...p, page: k.slice(5), title: "" });
      await chrome.storage.local.remove(old);
      save();
    }
    if (got[GO]) { chrome.storage.local.remove(GO); arrive(got[GO]); }
    draw();
  })();
  // Another tab on this site changed the list: take it, so this tab's next save builds on it.
  // shortcut: two tabs saving in the same moment, the later wins; merge by id if that ever bites.
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local" || !ch[SITE]) return;
    pins = ch[SITE].newValue || [];
    if (idx(opened) < 0) opened = null;
    draw();
  });
  // A single-page app changes pages without a load, and this script runs once a load: follow its address.
  navigation.addEventListener("currententrychange", () => {
    if (pageOf() === page) return;
    page = pageOf();
    if (pins[idx(opened)]?.page !== page) opened = null;
    setPicking(false);       // a comment being written goes too: it points at the page that's gone
    if (going) { chrome.storage.local.remove(GO); arrive(going); going = null; }      // it landed without a load
  });
  ask({ kind: "api", path: "/theme" }).then((t) => {
    for (const [k, v] of Object.entries(t.tokens || {})) host.style.setProperty(k, v);
    look.classList.toggle("plain", !!t.fam && t.fam !== "aurora");      // AURORA's capitals, the others' sentence case
  });

  // ------- the crop ---------------------------------------------------------------------
  async function crop(rect) {
    host.style.visibility = "hidden";
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const got = await ask({ kind: "capture" });
    host.style.visibility = "";
    if (!got.shot) return "";
    const img = new Image();
    await new Promise((r) => { img.onload = r; img.onerror = r; img.src = got.shot; });
    const k = img.naturalWidth / innerWidth;
    const pad = 12;
    const x = Math.max(0, rect.left - pad), y = Math.max(0, rect.top - pad);
    const w = Math.min(innerWidth, rect.right + pad) - x, h = Math.min(innerHeight, rect.bottom + pad) - y;
    if (w < 2 || h < 2) return "";
    const scale = Math.min(1, 1200 / (w * k));
    const c = document.createElement("canvas");
    c.width = Math.round(w * k * scale);
    c.height = Math.round(h * k * scale);
    c.getContext("2d").drawImage(img, x * k, y * k, w * k, h * k, 0, 0, c.width, c.height);
    return c.toDataURL("image/png");
  }

  // ------- picking --------------------------------------------------------------------------
  let start = null;      // {x, y} of a press while picking
  let hovered = null;

  function setPicking(on) {
    picking = on;
    if (!on) repoint = null;
    live.innerHTML = "";
    hovered = null;
    start = null;
    document.documentElement.style.cursor = on ? "crosshair" : "";
    draw();
  }

  function showHover(el) {
    const r = el.getBoundingClientRect();
    const side = r.left > innerWidth / 2 ? `right:${Math.max(4, innerWidth - r.right)}px` : `left:${Math.max(4, r.left)}px`;   // stays on screen at either edge
    live.innerHTML = `<div class="hover" style="left:${r.left - 3}px;top:${r.top - 3}px;width:${r.width + 6}px;height:${r.height + 6}px"></div>`
      + `<div class="tag" style="${side};top:${Math.max(4, r.top - 28)}px">${esc(describe(el))} · click to comment</div>`;
  }

  const areaOf = (a, b) => ({ left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) });

  document.addEventListener("mousemove", (e) => {
    if (!picking || own(e)) return;
    if (start && e.buttons === 1 && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6) {
      const a = areaOf(start, { x: e.clientX, y: e.clientY });
      live.innerHTML = `<div class="area" style="left:${a.left}px;top:${a.top}px;width:${a.right - a.left}px;height:${a.bottom - a.top}px"></div>`;
      start.dragged = true;
      return;
    }
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el !== hovered && el !== host) { hovered = el; showHover(el); }
  }, true);

  document.addEventListener("mousedown", (e) => {
    if (!picking || own(e) || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    start = { x: e.clientX, y: e.clientY };
  }, true);

  document.addEventListener("mouseup", (e) => {
    if (!picking || own(e) || !start) return;
    e.preventDefault();
    e.stopPropagation();
    const s = start;
    start = null;
    const use = repoint === null ? compose : moveTo;
    if (s.dragged) {
      const a = areaOf(s, { x: e.clientX, y: e.clientY });
      const mid = document.elementFromPoint((a.left + a.right) / 2, (a.top + a.bottom) / 2);
      const near = mid && mid !== host;
      use({ rect: a, where: `area ${Math.round(a.right - a.left)}×${Math.round(a.bottom - a.top)}` + (near ? ` around ${describe(mid)}` : ""),
            what: near ? `Area around ${whatIs(mid)}` : "An area", anchor: { x: a.left + scrollX, y: a.top + scrollY } });
    } else if (hovered) {
      const r = hovered.getBoundingClientRect();
      use({ el: hovered, rect: r, where: describe(hovered), what: whatIs(hovered), anchor: { x: r.left + scrollX, y: r.top + scrollY } });
    }
  }, true);

  // A pick's click must not reach the page (it would follow the link or press the button).
  document.addEventListener("click", (e) => {
    if (own(e)) return;
    if (picking) { e.preventDefault(); e.stopPropagation(); }
    else if (menu) { menu = ""; draw(); }      // a click anywhere else closes the ⋯ menu
  }, true);

  document.addEventListener("keydown", (e) => {
    const typing = e.composedPath()[0].closest?.("input,textarea,select,[contenteditable=''],[contenteditable=true]");
    if (own(e) && typing) return;                       // the tray's own fields keep their keys
    const k = e.key.toLowerCase(), bare = !typing && !e.metaKey && !e.ctrlKey && !e.altKey;
    if (k === "escape" && picking) setPicking(false);
    else if (k === "escape" && open && (own(e) || menu || choosing)) { if (!shut()) return; }   // from the page, Esc only closes what floats
    else if (k === "c" && bare && !picking) { open = true; setPicking(true); if (!chats) loadChats(); }
    else if ((k === "m" || k === "f") && bare && open && !aside()) act(k === "m" ? "markers" : "fold");
    else return;
    e.preventDefault();
    e.stopPropagation();     // a key the tray takes is the tray's alone (CODING_STANDARDS: overlay keys stay in the overlay)
  }, true);

  // ------- writing one ----------------------------------------------------------------------
  function compose(p) {
    picking = false;
    document.documentElement.style.cursor = "";
    const r = p.rect;
    const left = Math.min(Math.max(8, r.left), innerWidth - 300 - 8);
    const top = r.bottom + 170 < innerHeight ? r.bottom + 8 : Math.max(8, r.top - 170);
    const keep = live.innerHTML;
    live.innerHTML = keep + `<div class="box" role="dialog" aria-label="Comment" style="left:${left}px;top:${top}px">
      <div class="w">${esc(p.what)}</div><textarea placeholder="What should change here?"></textarea>
      <div class="row"><button class="btn" data-a="cancel">Cancel</button><button class="btn solid" data-a="pin">Pin</button></div></div>`;
    const box = live.querySelector(".box");
    const ta = box.querySelector("textarea");
    ta.focus();
    const done = async (pin) => {
      const text = ta.value.trim();
      if (pin && !text) { ta.focus(); return; }
      live.innerHTML = "";
      if (pin) {
        const rect = p.el ? p.el.getBoundingClientRect() : r;
        add({ text, where: p.where, what: p.what, at: p.anchor, page, title: document.title, crop: await crop(rect) });
        note = null;
        save();
      }
      setPicking(false);
    };
    box.querySelector("[data-a=cancel]").onclick = () => done(false);
    box.querySelector("[data-a=pin]").onclick = () => done(true);
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); done(true); }
      if (e.key === "Escape") { e.preventDefault(); done(false); }
    });
  }

  // Point again: the same words and number, now at what you just picked.
  async function moveTo(t) {
    const id = repoint;
    picking = false;
    live.innerHTML = "";
    document.documentElement.style.cursor = "";
    const shot = await crop(t.el ? t.el.getBoundingClientRect() : t.rect);
    const i = idx(id);
    if (i >= 0) { pins[i] = { ...pins[i], where: t.where, what: t.what, at: t.anchor, page, title: document.title, crop: shot }; opened = id; save(); }
    setPicking(false);
  }

  // ------- one comment ----------------------------------------------------------------------
  function show(id) {          // its marker, scrolled to and lit up
    const p = pins[idx(id)];
    if (!p?.at) return;
    scrollTo({ left: p.at.x - innerWidth / 2, top: p.at.y - innerHeight / 3, behavior: "smooth" });
    flash = id;
    drawMarks();
    clearTimeout(flashT);
    flashT = setTimeout(() => { flash = null; drawMarks(); }, 1600);
  }

  function goTo(p, point) {    // its page, where the tray opens again: on the comment (p.id), pointing again if asked
    going = { page: p.page, id: p.id, point };
    chrome.storage.local.set({ [GO]: going }, () => location.assign(p.page));
  }

  function arrive(g) {         // Go to page/it, or Point again from another page, landed here
    if (g?.page !== page) return;
    open = true;
    if (!chats) loadChats();
    const p = pins[idx(g.id)];
    if (!p) return draw();
    opened = p.id;
    if (g.point) { repoint = p.id; return setPicking(true); }
    draw();
    // shortcut: waits 300ms for the page to lay out after a load; wait on what it points at if an app needs longer.
    setTimeout(() => show(p.id), 300);
  }

  // ------- sending --------------------------------------------------------------------------
  async function loadChats() {
    const got = await ask({ kind: "api", path: `/chats?url=${encodeURIComponent(location.href)}` });
    if (got.error) { note = { text: got.error, bad: true }; chats = null; }
    else {
      chats = got;
      if (!from && !got.opener && got.chats[0]) from = { id: got.chats[0].id, title: got.chats[0].title };
    }
    draw();
  }

  async function sendAll() {
    if (busy || !pins.length) return;
    busy = true;
    note = { text: "Sending…" };
    draw();
    const nm = names();
    const body = {
      url: location.href, viewport: `${innerWidth}×${innerHeight}`,
      chat: from?.id || "",    // the new chat gets this chat's project and worktree; "" = the one that opened the site's
      comments: pins.map((p) => ({ text: p.text, where: p.where, crop: p.crop, url: p.page, page: nm.get(p.page) })),
    };
    const got = await ask({ kind: "api", path: "/send", body });
    busy = false;
    if (got.error) { note = { text: got.error, bad: true }; draw(); return; }
    pins = [];
    opened = null;
    save();
    from = null;               // the bridge keeps a picked chat as the site's own now
    note = { text: `Started “${got.chat.title}”. i will see to it.` };
    loadChats();
  }

  // ------- moving it -------------------------------------------------------------------------
  // While you pick or write, the tray steps aside to its tab, so what it covers can be pointed at.
  const aside = () => picking || !!live.querySelector(".box");

  function place(tray) {       // where you left it, kept on screen however big it is now
    if (!spot) return;
    spot = { x: Math.max(0, Math.min(spot.x, innerWidth - tray.offsetWidth)), y: Math.max(0, Math.min(spot.y, innerHeight - tray.offsetHeight)) };
    Object.assign(tray.style, { left: `${spot.x}px`, top: `${spot.y}px`, right: "auto" });
  }

  function drag(e, tray) {     // holding the head moves it
    if (e.button !== 0 || e.target.closest("button")) return;
    const hd = e.currentTarget, r = tray.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    hd.setPointerCapture(e.pointerId);
    hd.onpointermove = (m) => { spot = { x: m.clientX - dx, y: m.clientY - dy }; place(tray); };
    hd.onpointerup = hd.onpointercancel = () => { hd.onpointermove = null; if (spot) chrome.storage.local.set({ [SPOT]: spot }); draw(); };
  }

  addEventListener("resize", () => { const t = ui.querySelector(".tray"); if (t) place(t); });

  // ------- drawing --------------------------------------------------------------------------
  // A page's name: its title less the end the site's "Page · Site" titles share ("Pricing · Lumen" → "Pricing"), else its path.
  function names() {
    const titles = new Map(pins.map((p) => [p.page, p.title || ""]));
    const split = [...new Set(titles.values())].filter((t) => /\s[|·•–—-]\s/.test(t));
    const common = split.length > 1 ? split.reduce((a, b) => { let i = 0; while (i < a.length && i < b.length && a.at(-1 - i) === b.at(-1 - i)) i++; return a.slice(a.length - i); }) : "";
    const tail = common.match(/\s+[|·•–—-]\s.*$/)?.[0] || "";
    const count = {};
    for (const t of titles.values()) count[t] = (count[t] || 0) + 1;
    return new Map([...titles].map(([pg, t]) => [pg, (count[t] === 1 && (tail && t.endsWith(tail) ? t.slice(0, -tail.length) : t).trim()) || pg.slice(location.origin.length) || "/"]));
  }

  function drawMarks() {       // only this page's; Show it lights one up even with markers off
    marks.innerHTML = pins.map((p, i) => p.at && p.page === page && (markers || p.id === flash)
      ? `<div class="pin${p.id === flash ? " hot" : ""}" style="left:${p.at.x - 11}px;top:${p.at.y - 11}px">${i + 1}</div>` : "").join("");
  }

  function headHtml() {
    const n = pins.length, pages = new Set(pins.map((p) => p.page)).size;
    return `<div class="hd" title="Hold to move"><span class="t"><span class="mk">◈</span>${n ? many(n, "comment") : "Comments"}${pages > 1 ? `<em> · ${pages} pages</em>` : ""}</span>
      <button class="ib${menu ? " on" : ""}" data-a="tools" aria-label="Tray tools" aria-haspopup="menu" aria-expanded="${!!menu}">${ic("more")}</button>
      <button class="ib" data-a="fold" aria-label="Fold to a bar" title="Fold to a bar (F)">${ic("fold")}</button>
      <button class="ib" data-a="close" aria-label="Close" title="Close">${ic("x")}</button></div>`;
  }

  function toolsHtml() {       // the ⋯ menu; Clear all asks in the same box, at the same size
    const n = pins.length, here = pins.filter((p) => p.page === page).length, sure = menu === "sure";
    return `<div class="menu" role="${sure ? "alertdialog" : "menu"}" aria-label="${sure ? "Clear all" : "Tray tools"}"><div${sure ? ' style="visibility:hidden"' : ""}>
      <button class="mi" role="menuitemcheckbox" aria-checked="${markers}" data-a="markers" title="Markers on the page (M)">${ic("eye")}Markers on the page<span class="sw${markers ? "" : " off"}"></span></button>
      <button class="mi" role="menuitem" data-a="fold">${ic("fold")}Fold to a bar<kbd>F</kbd></button>
      ${spot ? `<button class="mi" role="menuitem" data-a="home">${ic("corner")}Back to its corner</button>` : ""}
      <div class="sep"></div>
      <button class="mi" role="menuitem" data-a="clear" ${here ? "" : "disabled"}>${ic("trash")}Clear this page<span class="s">${here}</span></button>
      <button class="mi bad" role="menuitem" data-a="ask-wipe" ${n ? "" : "disabled"}>${ic("trash")}Clear all ${n}…</button></div>
      ${sure ? `<div class="confirm"><b>Clear all ${many(n, "comment")}?</b> <span class="s">They haven't been sent.</span>
        <div class="row"><button class="btn" data-a="keep">Keep</button><button class="btn danger" data-a="wipe">Clear all</button></div></div>` : ""}</div>`;
  }

  function listHtml() {        // this page's comments first, then each other page's under its name
    if (!pins.length) return `<div class="empty">point at what should change — press C, or + Comment.</div>`;
    const nm = names();
    return [...new Set([page, ...pins.map((p) => p.page)])].map((pg) => {
      const mine = pins.flatMap((p, i) => (p.page === pg ? [i] : []));
      if (!mine.length) return "";
      const here = pg === page;
      return `<div class="grp">${esc(nm.get(pg))}${here ? `<span class="here">This page</span><span class="sp"></span><span class="cnt">${mine.length}</span>`
        : `<span class="sp"></span><button class="go" data-a="page" data-i="${mine[0]}">Go to page${ic("go")}</button>`}</div>`
        + mine.map((i) => (pins[i].id === opened ? openHtml(i, here, nm)
          : `<button class="it" data-a="open" data-i="${i}" aria-expanded="false"><span class="n${here ? "" : " away"}">${i + 1}</span><span class="w1">${esc(pins[i].text)}</span></button>`)).join("");
    }).join("");
  }

  function openHtml(i, here, nm) {
    const p = pins[i];
    return `<div class="open" role="group" aria-label="Comment ${i + 1}">
      <div class="pic" data-a="shut" title="Close">${p.crop ? `<img src="${esc(p.crop)}" alt="">` : "<i>No picture</i>"}<span class="n">${i + 1}</span></div>
      <textarea class="edit" aria-label="Words of comment ${i + 1}">${esc(p.text)}</textarea>
      <div class="w2">${esc(p.what || p.where)} · ${esc(nm.get(p.page))}</div>
      <div class="row">${here ? `<button class="btn" data-a="show">${ic("show")}Show it</button>` : `<button class="btn" data-a="go" data-i="${i}">${ic("go")}Go to it</button>`}
        <button class="btn" data-a="repoint">${ic("aim")}Point again</button>
        <button class="btn bad" data-a="delete">${ic("trash")}Delete</button></div></div>`;
  }

  function footHtml() {        // which chat the new chat starts from, always in sight, above Send
    const c = fromChat(), n = pins.length;
    const what = c ? `<span class="dot ${c.status || "idle"}"></span> <span class="c">${esc(c.title)}</span> <span class="pj">${esc(short(c.project))}</span>`
      : `<span class="c">${chats ? "Pick a chat" : "…"}</span>`;
    return `<div class="ft"><button class="to" data-a="choose" title="The new chat gets this chat's project and worktree"><span class="k">From</span> ${what} ${ic("down")}</button>
      <button class="send" data-a="send" ${n && !busy ? "" : "disabled"}>${n > 1 ? `Send ${n} to a new chat` : "Send to a new chat"}</button>
      ${note ? `<div class="note${note.bad ? " bad" : ""}" role="status">${esc(note.text)}</div>` : ""}</div>`;
  }

  const WORD = { working: "working", needs: "needs you", idle: "idle" };
  const info = (c, withProject) => [withProject && short(c.project), WORD[c.status], c.status === "working" ? "" : ago(c.at)].filter(Boolean).join(" · ");

  function chatRows() {        // the opener, its project's chats, then the other projects' (the latest, and "N more")
    if (!chats) return `<div class="empty">${note?.bad ? esc(note.text) : "Finding chats…"}</div>`;
    const o = chats.opener, proj = chats.project || "", on = fromChat()?.id;
    const row = (c, withProject) => `<button class="ch${c.id === on ? " sel" : ""}" data-a="from" data-id="${esc(c.id)}" aria-current="${c.id === on}"><span class="dot ${c.status}"></span><span class="ct"><b>${esc(c.title)}</b><span>${esc(info(c, withProject))}</span></span>${c.id === on ? ic("check", "ck") : ""}</button>`;
    const q = query.trim().toLowerCase();
    if (q) return [o, ...chats.chats].filter((c) => c && `${c.title} ${c.project}`.toLowerCase().includes(q)).map((c) => row(c, true)).join("") || `<div class="empty">No chat is called that.</div>`;
    const mine = chats.chats.filter((c) => (c.project || "") === proj), rest = chats.chats.filter((c) => (c.project || "") !== proj);
    const shown = allOthers ? rest : rest.slice(0, 1), hidden = rest.slice(shown.length);
    return (o ? `<div class="sec">Opened this site</div>${row(o, true)}` : "")
      + (mine.length ? `<div class="sec">${esc(short(proj) || "No project")}</div>${mine.map((c) => row(c)).join("")}` : "")
      + (rest.length ? `<div class="sec">Other projects</div>${shown.map((c) => row(c, true)).join("")}` : "")
      + (hidden.length ? `<button class="ch" data-a="more"><span class="ct"><span>${hidden.length} more in ${many(new Set(hidden.map((c) => c.project)).size, "project")}</span></span>${ic("go")}</button>` : "");
  }

  function chooseHtml() {
    return `<div class="hd" title="Hold to move"><button class="ib" data-a="back" aria-label="Back to the comments">${ic("back")}</button><span class="t">Start the new chat from</span></div>
      <label class="search">${ic("search")}<input placeholder="Find a chat" aria-label="Find a chat" value="${esc(query)}"></label>
      <div class="list chats">${chatRows()}</div>`;
  }

  function draw() {
    drawMarks();
    if (!open || aside()) {
      ui.innerHTML = picking ? `<button class="tab on" data-a="tab" aria-label="Stop picking">◈ Picking · Esc</button>`
        : `<button class="tab" data-a="tab" aria-label="Mystical comments, ${pins.length} pinned">◈ Mystical${pins.length ? ` · ${pins.length}` : ""}</button>`;
      return;
    }
    // What you were typing in the tray survives a redraw (chats or another tab's change can land mid-word).
    const was = root.activeElement, held = was?.matches(".edit,.search input") ? { sel: was.matches(".edit") ? ".edit" : ".search input", v: was.value, a: was.selectionStart, b: was.selectionEnd } : null;
    const n = pins.length;
    const say = busy ? "Sending…" : note?.bad ? note.text : n ? many(n, "comment") : note?.text || "No comments";
    ui.innerHTML = folded
      ? `<div class="tray fold" role="complementary" aria-label="Mystical comments"><div class="hd" title="Hold to move"><span class="t${note?.bad && !busy ? " bad" : ""}" role="status"><span class="mk">◈</span>${esc(say)}</span>
        <button class="mini" data-a="send" ${n && !busy ? "" : "disabled"}>Send</button><button class="ib" data-a="fold" aria-label="Unfold" title="Unfold (F)">${ic("unfold")}</button></div></div>`
      : `<div class="tray" role="complementary" aria-label="Mystical comments">${choosing ? chooseHtml() : `${headHtml()}${menu ? toolsHtml() : ""}
        <button class="add" data-a="pick">${ic("plus")}Comment <kbd>C</kbd></button>
        <div class="list">${listHtml()}</div>${footHtml()}`}</div>`;
    const tray = ui.querySelector(".tray");
    if (choosing && !folded) tray.style.height = `${choosingH}px`;      // the chats take the list's box, at its size
    place(tray);
    tray.querySelector(".hd").onpointerdown = (e) => drag(e, tray);
    const ta = ui.querySelector(".edit");
    if (ta) {                  // the open comment's words: Enter keeps them, Esc leaves them as they were
      const keep = () => { const p = pins[idx(opened)], t = ta.value.trim(); if (p && t && t !== p.text) { p.text = t; save(); } };
      ta.onchange = keep;
      ta.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); keep(); opened = null; draw(); }
        else if (e.key === "Escape") { e.preventDefault(); ta.onchange = null; opened = null; draw(); }
      };
    }
    const q = ui.querySelector(".search input");
    if (q) {
      const rows = () => { ui.querySelector(".chats").innerHTML = chatRows(); };
      q.oninput = () => { query = q.value; rows(); };
      q.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); ui.querySelector(".chats [data-a]")?.click(); }
        else if (e.key === "Escape") { e.preventDefault(); if (query) { query = q.value = ""; rows(); } else { choosing = false; draw(); } }
      };
    }
    const back = held && ui.querySelector(held.sel);
    if (back) { back.value = held.v; back.focus(); back.setSelectionRange(held.a, held.b); }
  }

  function shut() {            // Esc: the innermost thing open in the tray closes; false when nothing was
    if (menu === "sure") menu = "tools";
    else if (menu) menu = "";
    else if (choosing) choosing = false;
    else if (opened) opened = null;
    else return false;
    draw();
    return true;
  }

  function act(a, b) {
    const p = pins[+b?.dataset.i];
    if (a === "tab") { if (picking) return setPicking(false); open = true; loadChats(); }
    else if (a === "close") { open = folded = choosing = false; menu = ""; opened = null; return setPicking(false); }
    else if (a === "pick") return setPicking(true);
    else if (a === "repoint") {          // on its own page, pick now; from another page, go there and pick
      const q = pins[idx(opened)];
      if (q.page !== page) return goTo(q, true);
      repoint = q.id;
      return setPicking(true);
    }
    else if (a === "send") return sendAll();
    else if (a === "show") return show(opened);
    else if (a === "go") return goTo(p);
    else if (a === "page") return goTo({ page: p.page });
    else if (a === "tools") menu = menu ? "" : "tools";
    else if (a === "fold") { folded = !folded; menu = ""; }
    else if (a === "home") { spot = null; chrome.storage.local.remove(SPOT); menu = ""; }
    else if (a === "markers") { markers = !markers; chrome.storage.local.set({ [MARKERS]: markers }); }
    else if (a === "clear") { pins = pins.filter((q) => q.page !== page); if (idx(opened) < 0) opened = null; menu = ""; save(); }
    else if (a === "ask-wipe") menu = "sure";
    else if (a === "keep") menu = "tools";
    else if (a === "wipe") { pins = []; opened = null; menu = ""; save(); }
    else if (a === "open") opened = p.id;
    else if (a === "shut") opened = null;
    else if (a === "delete") { pins.splice(idx(opened), 1); opened = null; save(); }
    else if (a === "choose") { choosing = true; query = ""; allOthers = false; choosingH = ui.querySelector(".tray").getBoundingClientRect().height; if (!chats) loadChats(); }
    else if (a === "back") choosing = false;
    else if (a === "more") allOthers = true;
    else if (a === "from") { const c = chatOf(b.dataset.id); from = c ? { id: c.id, title: c.title } : null; choosing = false; }
    draw();
    const ta = a === "open" && ui.querySelector(".edit");
    if (ta) { ui.querySelector(".open").scrollIntoView({ block: "nearest" }); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    if (a === "choose") ui.querySelector(".search input")?.focus();
  }

  ui.addEventListener("click", (e) => {
    const b = e.target.closest("[data-a]");
    if (menu && !e.target.closest(".menu,[data-a=tools]")) { menu = ""; if (!b) return draw(); }
    if (b && !b.disabled) act(b.dataset.a, b);
  });

  document.documentElement.appendChild(host);
  draw();
})();
