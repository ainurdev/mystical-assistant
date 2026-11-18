// The Mystical browser's comment tool, on every page (bridge/site_browser.py).
// Closed, it's a thin tab halfway up the right edge (never a corner: apps keep their own buttons
// there). C or + Comment starts picking: hover outlines an element and names it, a drag draws an
// area, a click or a finished drag opens the box to write in. Pins are kept per page until Send all
// puts them in a chat as one turn, each with a crop of what it points at.
// Everything lives in a shadow root so the page's CSS can't reach it, and the page's own keys
// and clicks are left alone unless you're picking.
(() => {
  if (window.top !== window || document.getElementById("mystical-comments")) return;
  const KEY = `pins:${location.origin}${location.pathname}${location.search}`;
  const ask = (m) => new Promise((ok) => chrome.runtime.sendMessage(m, (r) => ok(r || { error: chrome.runtime.lastError?.message || "No answer." })));

  const host = document.createElement("div");
  host.id = "mystical-comments";
  host.style.cssText = "all:initial;position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
    :host{--p:#7fe9d8;--bg:#060a0a;--pop:rgba(7,13,13,.97);--fg:#bfe6de;--fgb:#dff8f2;--dim:#6f938d;--b:rgba(127,233,216,.16);--bb:rgba(127,233,216,.4);--bad:#e0897a}
    *{box-sizing:border-box;font:12px/1.45 ui-monospace,"JetBrains Mono",Menlo,monospace;color:var(--fg)}
    button{all:unset;cursor:pointer}
    .lbl{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--p)}
    .tab{position:fixed;right:0;top:50%;transform:translateY(-50%);background:var(--bg);border:1px solid var(--bb);border-right:0;padding:10px 5px;writing-mode:vertical-rl;letter-spacing:3px;font-size:10px;color:var(--p);text-transform:uppercase;width:22px;transition:width .12s}
    .tab:hover,.tab:focus-visible{width:28px;outline:none;box-shadow:0 0 10px rgba(127,233,216,.35)}
    .tray{position:fixed;top:60px;right:0;bottom:12px;width:300px;background:var(--pop);border:1px solid var(--bb);border-right:0;display:flex;flex-direction:column;box-shadow:0 8px 30px rgba(0,0,0,.5)}
    .hd{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--b)}
    .sp{flex:1}
    .x{color:var(--dim);padding:0 4px}.x:hover{color:var(--fgb)}
    .add{margin:10px 12px;border:1px dashed var(--bb);padding:7px 10px;text-align:center;color:var(--p);letter-spacing:1.5px;font-size:11px;text-transform:uppercase}
    .add[aria-pressed=true]{background:rgba(127,233,216,.1)}
    .list{flex:1;overflow:auto}
    .it{padding:9px 12px;border-top:1px solid var(--b);display:flex;gap:9px}
    .it b{color:var(--p);font-weight:400}.it .w{color:var(--dim);font-size:10.5px;word-break:break-word}
    .empty{padding:14px 12px;color:var(--dim);font-style:italic}
    .ft{padding:10px 12px;border-top:1px solid var(--b);position:relative}
    .split{display:flex}.send{flex:1;background:var(--p);color:var(--bg);text-align:center;padding:8px 6px;letter-spacing:1.5px;font-size:11px;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .more{background:var(--p);color:var(--bg);border-left:1px solid var(--bg);padding:8px 10px}
    .send[disabled],.more[disabled]{opacity:.4;cursor:default}
    .menu{position:absolute;left:12px;right:12px;bottom:52px;background:var(--bg);border:1px solid var(--bb);max-height:320px;overflow:auto;box-shadow:0 8px 24px rgba(0,0,0,.5)}
    .mi{display:flex;gap:8px;padding:8px 10px;border-bottom:1px solid var(--b);width:100%}.mi:last-child{border-bottom:0}
    .mi:hover,.mi[aria-checked=true]{background:rgba(127,233,216,.08)}
    .mi .r{color:var(--p);width:12px}.mi .s{color:var(--dim);font-size:10.5px;display:block}
    .note{margin-top:8px;font-size:11px;color:var(--dim)}.note.bad{color:var(--bad)}
    .hover{position:fixed;border:2px solid var(--p);pointer-events:none;box-shadow:0 0 0 3px rgba(127,233,216,.18)}
    .tag{position:fixed;background:var(--bg);color:var(--p);border:1px solid var(--bb);padding:2px 7px;font-size:10.5px;pointer-events:none;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis}
    .area{position:fixed;border:1.5px dashed var(--p);background:rgba(127,233,216,.08);pointer-events:none}
    .pin{position:absolute;width:22px;height:22px;background:var(--bg);color:var(--p);border:1.5px solid var(--p);display:flex;align-items:center;justify-content:center;font-size:11px;box-shadow:0 0 8px rgba(127,233,216,.5)}
    .box{position:fixed;width:280px;background:var(--pop);border:1px solid var(--bb);padding:10px;box-shadow:0 8px 30px rgba(0,0,0,.5)}
    .box textarea{all:unset;display:block;width:100%;min-height:64px;border:1px solid var(--b);padding:6px 8px;color:var(--fgb);white-space:pre-wrap;box-sizing:border-box}
    .box .w{color:var(--dim);font-size:10.5px;margin-bottom:6px;word-break:break-word}
    .row{display:flex;gap:8px;justify-content:flex-end;margin-top:8px}
    .btn{border:1px solid var(--bb);color:var(--p);padding:4px 10px;font-size:11px;letter-spacing:1px;text-transform:uppercase}.btn.solid{background:var(--p);color:var(--bg)}
  </style><div class="marks"></div><div class="live"></div><div class="ui"></div>`;
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
  chrome.storage.local.get(KEY, (got) => { pins = got[KEY] || []; draw(); });

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
    live.innerHTML = `<div class="hover" style="left:${r.left - 3}px;top:${r.top - 3}px;width:${r.width + 6}px;height:${r.height + 6}px"></div>`
      + `<div class="tag" style="left:${Math.max(4, r.left)}px;top:${Math.max(4, r.top - 28)}px">${esc(describe(el))} · click to comment</div>`;
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
    if (!open) {
      ui.innerHTML = `<button class="tab" aria-label="Mystical comments, ${pins.length} pinned">◈ Mystical${pins.length ? ` · ${pins.length}` : ""}</button>`;
      ui.querySelector(".tab").onclick = () => { open = true; draw(); loadChats(); };
      return;
    }
    const list = pins.length ? pins.map((p, i) => `<div class="it"><b>${i + 1}</b><div class="sp">${esc(p.text)}<div class="w">${esc(p.where)}</div></div><button class="x" data-del="${i}" aria-label="Remove comment ${i + 1}">✕</button></div>`).join("")
      : `<div class="empty">point at what should change — press C, or + Comment.</div>`;
    ui.innerHTML = `<div class="tray" role="complementary" aria-label="Mystical comments">
      <div class="hd"><span class="lbl">◈ Mystical · ${pins.length} pinned</span><span class="sp"></span><button class="x" data-a="close" aria-label="Close">✕</button></div>
      <button class="add" data-a="pick" aria-pressed="${picking}">${picking ? "Picking… Esc to stop" : "+ Comment (C)"}</button>
      <div class="list">${list}</div>
      <div class="ft">${menuHtml()}
        <div class="split"><button class="send" data-a="send" ${pins.length && !busy ? "" : "disabled"}>${esc(sendLabel())}</button><button class="more" data-a="menu" aria-label="Where to send" aria-haspopup="menu" aria-expanded="${menu}">▾</button></div>
        ${note ? `<div class="note${note.bad ? " bad" : ""}" role="status">${esc(note.text)}</div>` : ""}
      </div></div>`;
    ui.querySelectorAll("[data-del]").forEach((b) => { b.onclick = () => { pins.splice(+b.dataset.del, 1); save(); draw(); }; });
    ui.querySelectorAll("[data-a]").forEach((b) => {
      b.onclick = () => {
        const a = b.dataset.a;
        if (a === "close") { open = false; menu = false; setPicking(false); }
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
