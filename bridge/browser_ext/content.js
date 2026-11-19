// The Mystical browser's comment tool, on every page (bridge/site_browser.py).
// Closed, it's a thin tab halfway up the right edge (never a corner: apps keep their own buttons
// there). Open, it's a card in the top right that holding its head moves (kept for every site, ↗ puts
// it back), and it steps aside while you pick or write, so nothing on the page is out of its reach.
// C or + Comment starts picking: hover outlines an element and names it, a drag draws an
// area, a click or a finished drag opens the box to write in. Pins are kept per page until Send all
// puts them in a chat as one turn, each with a crop of what it points at. A single-page app's pages
// count too: the script follows the address when the app changes it in place.
// It wears the theme the dashboard last saved (GET /theme): its tokens go on the host over the
// AURORA look :host spells out, which also keeps the page's own CSS variables from reaching in.
// Everything lives in a shadow root so the page's CSS can't reach it, and the page's own keys
// and clicks are left alone unless you're picking.
(() => {
  if (window.top !== window || document.getElementById("mystical-comments")) return;
  // A page is its address without the hash, unless the hash is an app's route (#/…, #!/…): an anchor (#notes) is the same page.
  const pageKey = () => `pins:${location.origin}${location.pathname}${location.search}${/^#!?\//.test(location.hash) ? location.hash : ""}`;
  let KEY = pageKey();
  const ask = (m) => new Promise((ok) => chrome.runtime.sendMessage(m, (r) => ok(r || { error: chrome.runtime.lastError?.message || "No answer." })));

  const host = document.createElement("div");
  host.id = "mystical-comments";
  host.style.cssText = "all:initial;position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
    :host{--acc:#7fe9d8;--acc-on:#060a0a;--canvas:#060a0a;--panel:rgba(7,13,13,.97);--tx:#bfe6de;--txb:#dff8f2;--txd:#6f938d;--border:rgba(127,233,216,.16);--border-bright:rgba(127,233,216,.4);--err:#e0897a;--ui-font:ui-monospace,"JetBrains Mono",Menlo,monospace;--prad:0px}
    *{box-sizing:border-box;font:12px/1.45 var(--ui-font);color:var(--tx)}
    button{all:unset;cursor:pointer}
    .lbl{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--acc)}
    .tab{position:fixed;right:0;top:50%;transform:translateY(-50%);background:var(--canvas);border:1px solid var(--border-bright);border-right:0;border-radius:var(--prad) 0 0 var(--prad);padding:10px 5px;writing-mode:vertical-rl;letter-spacing:3px;font-size:10px;color:var(--acc);text-transform:uppercase;width:22px;transition:width .12s}
    .tab:hover,.tab:focus-visible{width:28px;outline:none;box-shadow:0 0 10px color-mix(in srgb,var(--acc) 35%,transparent)}
    .tab.on{background:var(--acc);color:var(--acc-on)}
    .tray{position:fixed;top:60px;right:12px;width:300px;max-height:calc(100vh - 72px);background:var(--panel);border:1px solid var(--border-bright);border-radius:var(--prad);display:flex;flex-direction:column;box-shadow:0 8px 30px rgba(0,0,0,.5)}
    .hd{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--border);cursor:grab;user-select:none;touch-action:none}
    .sp{flex:1}
    .x{color:var(--txd);padding:0 4px}.x:hover{color:var(--txb)}
    .add{margin:10px 12px;border:1px dashed var(--border-bright);border-radius:var(--prad);padding:7px 10px;text-align:center;color:var(--acc);letter-spacing:1.5px;font-size:11px;text-transform:uppercase}
    .add[aria-pressed=true]{background:color-mix(in srgb,var(--acc) 10%,transparent)}
    .list{flex:1 1 auto;min-height:0;overflow:auto}
    .it{padding:9px 12px;border-top:1px solid var(--border);display:flex;gap:9px}
    .it b{color:var(--acc);font-weight:400}.it .w{color:var(--txd);font-size:10.5px;word-break:break-word}
    .empty{padding:14px 12px;color:var(--txd);font-style:italic}
    .ft{padding:10px 12px;border-top:1px solid var(--border)}
    .split{display:flex}.send{flex:1;background:var(--acc);color:var(--acc-on);border-radius:var(--prad) 0 0 var(--prad);text-align:center;padding:8px 6px;letter-spacing:1.5px;font-size:11px;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .more{background:var(--acc);color:var(--acc-on);border-left:1px solid var(--panel);border-radius:0 var(--prad) var(--prad) 0;padding:8px 10px}
    .send[disabled],.more[disabled]{opacity:.4;cursor:default}
    .menu{margin-bottom:8px;background:var(--canvas);border:1px solid var(--border-bright);border-radius:var(--prad);max-height:min(320px,40vh);overflow:auto}
    .mi{display:flex;gap:8px;padding:8px 10px;border-bottom:1px solid var(--border);width:100%;box-sizing:border-box}.mi:last-child{border-bottom:0}
    .mi:hover,.mi[aria-checked=true]{background:color-mix(in srgb,var(--acc) 8%,transparent)}
    .mi .r{color:var(--acc);width:12px}.mi .s{color:var(--txd);font-size:10.5px;display:block}
    .note{margin-top:8px;font-size:11px;color:var(--txd)}.note.bad{color:var(--err)}
    .hover{position:fixed;border:2px solid var(--acc);pointer-events:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--acc) 18%,transparent)}
    .tag{position:fixed;background:var(--canvas);color:var(--acc);border:1px solid var(--border-bright);border-radius:var(--prad);padding:2px 7px;font-size:10.5px;pointer-events:none;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis}
    .area{position:fixed;border:1.5px dashed var(--acc);background:color-mix(in srgb,var(--acc) 8%,transparent);pointer-events:none}
    .pin{position:absolute;width:22px;height:22px;background:var(--canvas);color:var(--acc);border:1.5px solid var(--acc);border-radius:var(--prad);display:flex;align-items:center;justify-content:center;font-size:11px;box-shadow:0 0 8px color-mix(in srgb,var(--acc) 50%,transparent)}
    .box{position:fixed;width:280px;background:var(--panel);border:1px solid var(--border-bright);border-radius:var(--prad);padding:10px;box-shadow:0 8px 30px rgba(0,0,0,.5)}
    .box textarea{all:unset;display:block;width:100%;min-height:64px;border:1px solid var(--border);border-radius:var(--prad);padding:6px 8px;color:var(--txb);white-space:pre-wrap;box-sizing:border-box}
    .box .w{color:var(--txd);font-size:10.5px;margin-bottom:6px;word-break:break-word}
    .row{display:flex;gap:8px;justify-content:flex-end;margin-top:8px}
    .btn{border:1px solid var(--border-bright);border-radius:var(--prad);color:var(--acc);padding:4px 10px;font-size:11px;letter-spacing:1px;text-transform:uppercase}.btn.solid{background:var(--acc);color:var(--acc-on)}
    .plain :is(.tab,.add,.send,.btn){text-transform:none;letter-spacing:.02em;font-weight:600}
  </style><div class="look"><div class="marks"></div><div class="live"></div><div class="ui"></div></div>`;
  const look = root.querySelector(".look");
  const marks = root.querySelector(".marks");
  const live = root.querySelector(".live");
  const ui = root.querySelector(".ui");

  let pins = [];
  let open = false;
  let picking = false;
  let menu = false;
  let chats = null;            // {opener, chats} from the bridge
  let target = { kind: "opener" };
  let note = null;             // {text, bad}
  let busy = false;
  let spot = null;             // where you moved the tray (its top-left), kept for every site; null = its corner
  const SPOT = "tray-spot";

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // ------- naming what you point at ---------------------------------------------------
  function describe(el) {
    let name = el.tagName.toLowerCase();
    if (el.id) name += `#${el.id}`;
    else if (typeof el.className === "string" && el.className.trim()) name += "." + el.className.trim().split(/\s+/).slice(0, 2).join(".");
    const text = (el.getAttribute("aria-label") || el.innerText || el.value || el.alt || "").trim().replace(/\s+/g, " ");
    return text ? `${name} · "${text.slice(0, 40)}${text.length > 40 ? "…" : ""}"` : name;
  }
  const own = (e) => e.composedPath().includes(host);

  // ------- keeping pins ---------------------------------------------------------------
  const save = () => {
    chrome.storage.local.set({ [KEY]: pins });
    ask({ kind: "api", path: "/pins", body: { url: location.href, count: pins.length } });
  };
  chrome.storage.local.get([KEY, SPOT], (got) => { pins = got[KEY] || []; spot = got[SPOT] || null; draw(); });
  // A single-page app changes pages without a load, and this script runs once a load: follow its address.
  navigation.addEventListener("currententrychange", () => {
    const k = pageKey();
    if (k === KEY) return;
    KEY = k;
    pins = [];
    setPicking(false);       // a comment being written goes too: it points at the page that's gone
    chrome.storage.local.get(k, (got) => { if (k === KEY) { pins = got[k] || []; draw(); } });
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
    if (s.dragged) {
      const a = areaOf(s, { x: e.clientX, y: e.clientY });
      const mid = document.elementFromPoint((a.left + a.right) / 2, (a.top + a.bottom) / 2);
      const where = `area ${Math.round(a.right - a.left)}×${Math.round(a.bottom - a.top)}` + (mid && mid !== host ? ` around ${describe(mid)}` : "");
      compose({ rect: a, where, anchor: { x: a.left + scrollX, y: a.top + scrollY } });
    } else if (hovered) {
      const r = hovered.getBoundingClientRect();
      compose({ el: hovered, rect: r, where: describe(hovered), anchor: { x: r.left + scrollX, y: r.top + scrollY } });
    }
  }, true);

  // A pick's click must not reach the page (it would follow the link or press the button).
  document.addEventListener("click", (e) => { if (picking && !own(e)) { e.preventDefault(); e.stopPropagation(); } }, true);

  document.addEventListener("keydown", (e) => {
    if (own(e)) return;
    const typing = e.target.closest?.("input,textarea,select,[contenteditable=''],[contenteditable=true]");
    if (e.key === "Escape" && picking) { e.preventDefault(); setPicking(false); return; }
    if ((e.key === "c" || e.key === "C") && !typing && !e.metaKey && !e.ctrlKey && !e.altKey && !picking) {
      e.preventDefault();
      open = true;
      setPicking(true);
      if (!chats) loadChats();
    }
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
      <div class="w">${esc(p.where)}</div><textarea placeholder="What should change here?"></textarea>
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
        pins.push({ text, where: p.where, at: p.anchor, crop: await crop(rect) });
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

  // ------- sending --------------------------------------------------------------------------
  async function loadChats() {
    const got = await ask({ kind: "api", path: `/chats?url=${encodeURIComponent(location.href)}` });
    if (got.error) { note = { text: got.error, bad: true }; chats = null; }
    else {
      chats = got;
      if (target.kind === "opener" && !got.opener) target = got.chats[0] ? { kind: "chat", id: got.chats[0].id, title: got.chats[0].title } : { kind: "new" };
    }
    draw();
  }

  const sendLabel = () => target.kind === "new" ? "Send all to a new chat"
    : target.kind === "chat" ? `Send all to ${target.title}` : "Send all to this chat";

  async function sendAll() {
    if (busy || !pins.length) return;
    busy = true;
    note = { text: "Sending…" };
    draw();
    const body = {
      url: location.href, viewport: `${innerWidth}×${innerHeight}`,
      // For a new chat, the one it copies its project from: the chat picked before, else the opener, else the latest.
      target: target.kind, chat: target.id || chats?.opener?.id || chats?.chats?.[0]?.id || "",
      comments: pins.map((p) => ({ text: p.text, where: p.where, crop: p.crop })),
    };
    const got = await ask({ kind: "api", path: "/send", body });
    busy = false;
    if (got.error) { note = { text: got.error, bad: true }; draw(); return; }
    pins = [];
    save();
    target = { kind: "opener" };
    note = { text: `Sent to ${got.chat.title}. i will see to it.` };
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
  function drawMarks() {
    marks.innerHTML = pins.map((p, i) => p.at ? `<div class="pin" style="left:${p.at.x - 11}px;top:${p.at.y - 11}px">${i + 1}</div>` : "").join("");
  }

  function menuHtml() {
    if (!menu) return "";
    const row = (on, a, title, sub, id = "") => `<button class="mi" role="menuitemradio" aria-checked="${on}" data-a="${a}" data-id="${esc(id)}"><span class="r">${on ? "●" : "○"}</span><span>${esc(title)}<span class="s">${esc(sub)}</span></span></button>`;
    const o = chats?.opener;
    const rows = [];
    if (o) rows.push(row(target.kind === "opener", "opener", "This chat", o.title));
    for (const c of chats?.chats || []) rows.push(row(target.kind === "chat" && target.id === c.id, "chat", c.title, c.project || "another chat", c.id));
    rows.push(row(target.kind === "new", "new", "New chat", o ? `on ${o.project || "the same project"}` : `on ${(target.id ? chats?.chats?.find((c) => c.id === target.id) : chats?.chats?.[0])?.project || "the project of a chat you pick"}`));
    return `<div class="menu" role="menu">${rows.join("")}</div>`;
  }

  function draw() {
    drawMarks();
    if (!open || aside()) {
      ui.innerHTML = picking ? `<button class="tab on" aria-label="Stop picking">◈ Picking · Esc</button>`
        : `<button class="tab" aria-label="Mystical comments, ${pins.length} pinned">◈ Mystical${pins.length ? ` · ${pins.length}` : ""}</button>`;
      ui.querySelector(".tab").onclick = () => { if (picking) setPicking(false); else { open = true; draw(); loadChats(); } };
      return;
    }
    const list = pins.length ? pins.map((p, i) => `<div class="it"><b>${i + 1}</b><div class="sp">${esc(p.text)}<div class="w">${esc(p.where)}</div></div><button class="x" data-del="${i}" aria-label="Remove comment ${i + 1}">✕</button></div>`).join("")
      : `<div class="empty">point at what should change — press C, or + Comment.</div>`;
    ui.innerHTML = `<div class="tray" role="complementary" aria-label="Mystical comments">
      <div class="hd" title="Hold to move"><span class="lbl">◈ Mystical · ${pins.length} pinned</span><span class="sp"></span>${spot ? `<button class="x" data-a="home" aria-label="Back to its corner" title="Back to its corner">↗</button>` : ""}<button class="x" data-a="close" aria-label="Close">✕</button></div>
      <button class="add" data-a="pick" aria-pressed="${picking}">${picking ? "Picking… Esc to stop" : "+ Comment (C)"}</button>
      <div class="list">${list}</div>
      <div class="ft">${menuHtml()}
        <div class="split"><button class="send" data-a="send" ${pins.length && !busy ? "" : "disabled"}>${esc(sendLabel())}</button><button class="more" data-a="menu" aria-label="Where to send" aria-haspopup="menu" aria-expanded="${menu}">▾</button></div>
        ${note ? `<div class="note${note.bad ? " bad" : ""}" role="status">${esc(note.text)}</div>` : ""}
      </div></div>`;
    const tray = ui.querySelector(".tray");
    place(tray);
    tray.querySelector(".hd").onpointerdown = (e) => drag(e, tray);
    ui.querySelectorAll("[data-del]").forEach((b) => { b.onclick = () => { pins.splice(+b.dataset.del, 1); save(); draw(); }; });
    ui.querySelectorAll("[data-a]").forEach((b) => {
      b.onclick = () => {
        const a = b.dataset.a;
        if (a === "close") { open = false; menu = false; setPicking(false); }
        else if (a === "home") { spot = null; chrome.storage.local.remove(SPOT); draw(); }
        else if (a === "pick") setPicking(!picking);
        else if (a === "send") sendAll();
        else if (a === "menu") { menu = !menu; draw(); if (menu && !chats) loadChats(); }
        else if (a === "opener") { target = { kind: a }; menu = false; draw(); }
        else if (a === "new") { target = { kind: a, id: target.id }; menu = false; draw(); }
        else if (a === "chat") { const c = chats.chats.find((x) => x.id === b.dataset.id); target = { kind: "chat", id: c.id, title: c.title }; menu = false; draw(); }
      };
    });
  }

  document.documentElement.appendChild(host);
  draw();
})();
