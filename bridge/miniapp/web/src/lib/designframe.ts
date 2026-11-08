// The frame a designed page runs in, and how what you say about it becomes a message.
//
// The page is agent-written and runs, so it gets sandbox="allow-scripts" with no same-origin: it
// can't reach this app, its session or its storage. The CSP below takes the network away except
// Google Fonts, as a design with the wrong fonts isn't the design. Local images arrive inlined
// (bridge/design_board.py). Everything the frame says back is treated as data and drawn as text.
//
// ponytail: a sandboxed frame may still navigate itself (location=...), and nothing here can stop
// that short of a CSP on the whole dashboard. It leaves the page, not this app, and only agent-
// written content could go with it; the view shows the frame stopped answering.
//
// Comments, drawing and tweaks happen inside the frame so they scroll with the page and can
// find the real element. They live in a shadow root, so they can't disturb the page's own CSS.
// Pure apart from the script text. The same file is in both apps.

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; "
  + "font-src data: https://fonts.gstatic.com; img-src data: blob:; media-src data: blob:; form-action 'none'; base-uri 'none'; frame-src 'none'";

export const SCRIPT = String.raw`(function () {
  if (window.__mysticalFrame) return;
  window.__mysticalFrame = 1;
  var post = function (m) { m.mystical = 1; parent.postMessage(m, "*"); };
  var tool = "cursor", marks = [], tweaks = [];
  var host = document.createElement("div");
  host.setAttribute("data-mystical", "");
  host.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;";
  var root = host.attachShadow({ mode: "open" });
  root.innerHTML = '<style>' +
    '.cap{position:fixed;inset:0;pointer-events:none;touch-action:none}' +
    '.cap[data-on]{pointer-events:auto;cursor:crosshair}' +
    '.box{position:fixed;display:none;outline:2px solid #e8703a;outline-offset:1px;pointer-events:none;background:rgba(232,112,58,.08)}' +
    'svg{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}' +
    'path{fill:none;stroke:#e8703a;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}' +
    'path[data-sent]{stroke:#8a8a8a}' +
    '.pin{position:absolute;width:24px;height:24px;margin:-24px 0 0 0;border-radius:50% 50% 50% 2px;background:#e8703a;color:#fff;font:600 12px/24px system-ui,sans-serif;text-align:center;cursor:pointer;pointer-events:auto;box-shadow:0 1px 5px rgba(0,0,0,.45);border:0;padding:0}' +
    '.pin[data-sent]{background:#7a7a7a}' +
    '</style><svg width="1" height="1"></svg><div class="pins"></div><div class="box"></div><div class="cap"></div>';
  (document.documentElement || document.body).appendChild(host);
  var cap = root.querySelector(".cap"), box = root.querySelector(".box"), svg = root.querySelector("svg"), pins = root.querySelector(".pins");

  var cssPath = function (el) {
    var parts = [];
    for (var n = el; n && n.nodeType === 1 && n !== document.documentElement && parts.length < 6; n = n.parentElement) {
      if (n.id) { parts.unshift("#" + CSS.escape(n.id)); break; }
      var i = 1, s = n;
      while ((s = s.previousElementSibling)) if (s.tagName === n.tagName) i++;
      parts.unshift(n.tagName.toLowerCase() + ":nth-of-type(" + i + ")");
    }
    return parts.join(" > ");
  };
  var under = function (x, y) {
    var all = document.elementsFromPoint(x, y);
    for (var i = 0; i < all.length; i++) if (all[i] !== host && all[i] !== document.documentElement) return all[i];
    return document.body;
  };
  var STYLE = ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "color", "backgroundColor", "padding", "margin", "borderRadius", "gap"];
  var info = function (el) {
    var s = getComputedStyle(el), styles = {};
    STYLE.forEach(function (k) { var v = s[k]; if (v && v !== "normal" && v !== "0px" && v !== "rgba(0, 0, 0, 0)" && v !== "none") styles[k] = v.slice(0, 80); });
    var r = el.getBoundingClientRect();
    return { selector: cssPath(el), about: el.tagName.toLowerCase() + (el.textContent ? ' "' + el.textContent.trim().replace(/\s+/g, " ").slice(0, 60) + '"' : ""), styles: styles, dx: 0, dy: 0, rect: [r.left + scrollX, r.top + scrollY, r.width, r.height] };
  };
  var draw = function () {
    svg.setAttribute("width", document.documentElement.scrollWidth);
    svg.setAttribute("height", document.documentElement.scrollHeight);
    svg.textContent = "";
    pins.textContent = "";
    marks.forEach(function (m) {
      var x = m.x, y = m.y;
      if (m.points && m.points.length) {
        var p = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p.setAttribute("d", "M" + m.points.map(function (q) { return q[0] + "," + q[1]; }).join("L"));
        if (m.sent) p.setAttribute("data-sent", "");
        svg.appendChild(p);
      }
      var b = document.createElement("button");
      b.className = "pin";
      b.textContent = String(m.n);
      if (m.sent) b.setAttribute("data-sent", "");
      b.style.left = x + "px";
      b.style.top = Math.max(y, 24) + "px";
      b.addEventListener("click", function (e) { e.stopPropagation(); post({ t: "mark", id: m.id, cx: e.clientX, cy: e.clientY }); });
      pins.appendChild(b);
    });
  };
  var applyTweaks = function () {
    tweaks.forEach(function (t) {
      if (t.selector === ":root") { document.documentElement.style.setProperty(t.prop, t.to); return; }
      var el = document.querySelector(t.selector);
      if (el) el.style.setProperty(t.prop, t.to);
    });
  };
  var stroke = null;
  cap.addEventListener("pointermove", function (e) {
    if (stroke) { stroke.push([e.clientX + scrollX, e.clientY + scrollY]); stroke.path.setAttribute("d", "M" + stroke.map(function (q) { return q[0] + "," + q[1]; }).join("L")); return; }
    if (tool === "draw") { box.style.display = "none"; return; }
    var r = under(e.clientX, e.clientY).getBoundingClientRect();
    box.style.cssText = "display:block;left:" + r.left + "px;top:" + r.top + "px;width:" + r.width + "px;height:" + r.height + "px";
  });
  cap.addEventListener("pointerleave", function () { box.style.display = "none"; });
  cap.addEventListener("pointerdown", function (e) {
    e.preventDefault();
    if (tool !== "draw") return;
    cap.setPointerCapture(e.pointerId);
    stroke = [[e.clientX + scrollX, e.clientY + scrollY]];
    stroke.path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    svg.appendChild(stroke.path);
  });
  cap.addEventListener("pointerup", function (e) {
    if (tool === "draw" && stroke) {
      var pts = stroke, xs = pts.map(function (q) { return q[0]; }), ys = pts.map(function (q) { return q[1]; });
      var mx = (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2, my = (Math.min.apply(null, ys) + Math.max.apply(null, ys)) / 2;
      stroke = null;
      post({ t: "stroke", points: pts.length > 700 ? pts.filter(function (_, i) { return i % 2 === 0; }) : pts.slice(), x: xs[0], y: ys[0], cx: e.clientX, cy: e.clientY, el: info(under(mx - scrollX, my - scrollY)) });
      return;
    }
    var el = under(e.clientX, e.clientY);
    if (tool === "comment") post({ t: "pick", x: e.clientX + scrollX, y: e.clientY + scrollY, cx: e.clientX, cy: e.clientY, el: info(el) });
    if (tool === "tweak") { var r = el.getBoundingClientRect(); box.style.cssText = "display:block;left:" + r.left + "px;top:" + r.top + "px;width:" + r.width + "px;height:" + r.height + "px"; post({ t: "select", x: r.left + scrollX, y: r.top + scrollY, el: info(el) }); }
  });
  // A link goes to another page of the board, not away from it.
  document.addEventListener("click", function (e) {
    if (window.__mysticalProxied) return;      // a real app's links are its own
    var a = e.target && e.target.closest && e.target.closest("a[href]");
    if (a && a.getAttribute("href").charAt(0) !== "#") { e.preventDefault(); post({ t: "link", href: a.getAttribute("href") }); }
  }, true);
  document.addEventListener("submit", function (e) { if (!window.__mysticalProxied) e.preventDefault(); }, true);
  // Where a real app has got to, for the address bar and to keep a comment with its screen.
  var where = "";
  var tellWhere = function () { var w = location.pathname + location.search; if (w !== where) { where = w; post({ t: "location", path: w }); } };
  if (window.__mysticalProxied) setInterval(tellWhere, 700);
  var ticking = false;
  addEventListener("scroll", function () { if (ticking) return; ticking = true; setTimeout(function () { ticking = false; post({ t: "scrolled", y: scrollY, x: scrollX }); }, 80); }, true);
  addEventListener("resize", draw);
  addEventListener("message", function (e) {
    var m = e.data;
    if (e.source !== parent || !m || !m.mystical) return;
    if (m.t === "tool") { tool = m.tool; if (tool === "cursor") { cap.removeAttribute("data-on"); box.style.display = "none"; } else cap.setAttribute("data-on", ""); }
    if (m.t === "marks") { marks = m.marks || []; tweaks = m.tweaks || []; applyTweaks(); draw(); }
    if (m.t === "scroll") scrollTo(m.x || 0, m.y || 0);
    if (m.t === "theme") { if (m.v) { document.documentElement.setAttribute("data-theme", m.v); document.documentElement.style.colorScheme = m.v; } else { document.documentElement.removeAttribute("data-theme"); document.documentElement.style.colorScheme = ""; } }
    if (m.t === "style") { var el = m.selector === ":root" ? document.documentElement : document.querySelector(m.selector); if (el) el.style.setProperty(m.prop, m.value); }
  });
  var vars = function () {
    var out = {};
    try {
      for (var i = 0; i < document.styleSheets.length; i++) {
        var rules = document.styleSheets[i].cssRules;
        for (var j = 0; j < rules.length; j++) {
          var r = rules[j];
          if (r.style && /(^|,)\s*(:root|html)\s*(,|$)/.test(r.selectorText || "")) for (var k = 0; k < r.style.length; k++) { var n = r.style[k]; if (n.indexOf("--") === 0) out[n] = r.style.getPropertyValue(n).trim().slice(0, 60); }
        }
      }
    } catch (err) {}
    return out;
  };
  var ready = function () { post({ t: "ready", vars: vars(), path: location.pathname + location.search }); draw(); };
  if (document.readyState === "complete") ready(); else addEventListener("load", ready);
})();`;

/** A page, ready for srcdoc. `drop` takes away what would navigate the frame on its own. */
export function frameDoc(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${CSP.replace(/"/g, "&quot;")}">`;
  const page = html.replace(/<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*>/gi, "");
  const script = `<script>${SCRIPT}</script>`;
  const head = /<head[^>]*>/i.exec(page);
  const withMeta = head ? `${page.slice(0, head.index + head[0].length)}${meta}${page.slice(head.index + head[0].length)}`
    : /<html[^>]*>/i.test(page) ? page.replace(/<html[^>]*>/i, (m) => `${m}<head>${meta}</head>`)
    : `<!doctype html><html><head>${meta}</head><body>${page}</body></html>`;
  const end = withMeta.toLowerCase().lastIndexOf("</body>");
  return end >= 0 ? `${withMeta.slice(0, end)}${script}${withMeta.slice(end)}` : withMeta + script;
}

export type DesignComment = {
  id: string; kind: "comment" | "draw" | "tweak"; page: string; text: string; x: number; y: number; status: "open" | "sent";
  selector?: string; about?: string; path?: string; styles?: Record<string, string>; points?: number[][]; changes?: { prop: string; from: string; to: string }[]; at?: number;
};
export type DesignPage = { name: string; direction?: string; file: string; url?: string };
export type DesignBoard = { id: string; title: string; pages: DesignPage[]; updated: number; open?: number };

/** What you said, as a message an agent can act on: which file, which element, and your words. */
export function commentsMessage(board: DesignBoard, comments: DesignComment[], note = ""): string {
  const open = comments.filter((c) => c.status !== "sent");
  const lines: string[] = [`Design feedback on "${board.title}" (board ${board.id}). Edit the page files and I'll see it live.`];
  if (note.trim()) lines.push(note.trim());
  for (const page of board.pages) {
    const mine = open.filter((c) => c.page === page.name);
    if (!mine.length) continue;
    lines.push(`\nPage "${page.name}" (${page.file}):`);
    mine.forEach((c, i) => {
      const screen = page.url && c.path ? ` on ${c.path}` : "";
      const where = (c.about ? `${c.about}${c.selector ? ` [${c.selector}]` : ""}` : `at ${Math.round(c.x)},${Math.round(c.y)}`) + screen;
      if (c.kind === "tweak") {
        const set = (c.changes ?? []).map((ch) => `${ch.prop}: ${ch.from || "unset"} → ${ch.to}`).join("; ");
        lines.push(`${i + 1}. Apply these exact values to ${where}: ${set}${c.text ? `. ${c.text}` : ""}`);
      } else if (c.kind === "draw") {
        lines.push(`${i + 1}. I drew around ${where}${c.text ? `: ${c.text}` : " (no comment: look at what's marked there)"}`);
      } else {
        const looks = c.styles ? ` (now ${Object.entries(c.styles).slice(0, 4).map(([k, v]) => `${k} ${v}`).join(", ")})` : "";
        lines.push(`${i + 1}. On ${where}${looks}: ${c.text}`);
      }
    });
  }
  return lines.join("\n");
}

export const ASPECTS = ["Layout", "Typography", "Colour", "Spacing and density", "Components and details"];

/** A remix as a request: what to take from which page. */
export function remixMessage(board: DesignBoard, picks: Record<string, string>, note: string): string {
  const parts = ASPECTS.filter((a) => picks[a]).map((a) => `- ${a} from "${picks[a]}"`);
  return [`Remix the directions on "${board.title}" (board ${board.id}) into a new page on that board:`, ...parts, note.trim()].filter(Boolean).join("\n");
}
