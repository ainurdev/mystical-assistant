// A PNG of a view. The usual trick (an SVG with <foreignObject>, drawn to a canvas) taints the
// canvas in WebKit, which is what the Mac and Linux windows are, so this paints what the page
// laid out onto a canvas itself: boxes, text and SVG shapes, with their computed colours and
// the fonts the page already loaded. It covers what views are made of, not the web.
// The same file is in both apps.

const clear = (c: string) => !c || c === "transparent" || c === "rgba(0, 0, 0, 0)";

function fontOf(s: CSSStyleDeclaration): string {
  return `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
}

function boxPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  if (r > 0 && ctx.roundRect) ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
  else ctx.rect(x, y, w, h);
}

function paintBox(ctx: CanvasRenderingContext2D, el: Element, s: CSSStyleDeclaration, x0: number, y0: number) {
  const b = el.getBoundingClientRect();
  if (!b.width || !b.height) return;
  const x = b.left - x0, y = b.top - y0, r = parseFloat(s.borderTopLeftRadius) || 0;
  if (!clear(s.backgroundColor)) {
    boxPath(ctx, x, y, b.width, b.height, r);
    ctx.fillStyle = s.backgroundColor;
    ctx.fill();
  }
  const sides: [string, string, string, number, number, number, number][] = [
    [s.borderTopWidth, s.borderTopColor, s.borderTopStyle, x, y, x + b.width, y],
    [s.borderRightWidth, s.borderRightColor, s.borderRightStyle, x + b.width, y, x + b.width, y + b.height],
    [s.borderBottomWidth, s.borderBottomColor, s.borderBottomStyle, x, y + b.height, x + b.width, y + b.height],
    [s.borderLeftWidth, s.borderLeftColor, s.borderLeftStyle, x, y, x, y + b.height],
  ];
  const on = sides.filter(([w, c, st]) => parseFloat(w) > 0 && !clear(c) && st !== "none");
  if (on.length === 4 && r > 0) {
    ctx.lineWidth = parseFloat(on[0][0]);
    ctx.strokeStyle = on[0][1];
    boxPath(ctx, x + 0.5, y + 0.5, b.width - 1, b.height - 1, r);
    ctx.stroke();
    return;
  }
  for (const [w, c, , x1, y1, x2, y2] of on) {
    ctx.beginPath();
    ctx.lineWidth = parseFloat(w);
    ctx.strokeStyle = c;
    const inX = x1 === x2 ? (x1 === x ? 0.5 : -0.5) : 0, inY = y1 === y2 ? (y1 === y ? 0.5 : -0.5) : 0;
    ctx.moveTo(x1 + inX, y1 + inY);
    ctx.lineTo(x2 + inX, y2 + inY);
    ctx.stroke();
  }
}

function paintText(ctx: CanvasRenderingContext2D, node: Text, s: CSSStyleDeclaration, x0: number, y0: number) {
  const text = node.textContent ?? "";
  if (!text.trim() || s.visibility === "hidden") return;
  ctx.font = fontOf(s);
  ctx.fillStyle = s.color;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  if ("letterSpacing" in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = s.letterSpacing === "normal" ? "0px" : s.letterSpacing;
  const m = ctx.measureText("Mg");
  const asc = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent, desc = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent;
  const range = document.createRange();
  for (const w of text.matchAll(/\S+/g)) {
    range.setStart(node, w.index ?? 0);
    range.setEnd(node, (w.index ?? 0) + w[0].length);
    const r = range.getClientRects()[0];
    if (!r) continue;
    const word = s.textTransform === "uppercase" ? w[0].toUpperCase() : w[0];
    ctx.fillText(word, r.left - x0, r.top - y0 + (r.height + asc - desc) / 2);
  }
}

function paintSvg(ctx: CanvasRenderingContext2D, svg: SVGSVGElement, x0: number, y0: number) {
  const b = svg.getBoundingClientRect();
  const box = svg.viewBox?.baseVal;
  const sx = box?.width ? b.width / box.width : 1, sy = box?.height ? b.height / box.height : 1;
  ctx.save();
  ctx.translate(b.left - x0, b.top - y0);
  ctx.scale(sx, sy);
  const walk = (el: Element) => {
    const s = getComputedStyle(el);
    const tag = el.tagName.toLowerCase();
    if (tag === "g" || tag === "svg") { for (const c of el.children) walk(c); return; }
    const num = (a: string) => parseFloat(el.getAttribute(a) ?? "0") || 0;
    ctx.globalAlpha = parseFloat(s.opacity) || 1;
    if (tag === "text") {
      ctx.font = fontOf(s);
      ctx.fillStyle = s.fill;
      ctx.textAlign = s.textAnchor === "end" ? "right" : s.textAnchor === "middle" ? "center" : "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(el.textContent ?? "", num("x"), num("y"));
    } else {
      let p: Path2D | null = null;
      if (tag === "path") p = new Path2D(el.getAttribute("d") ?? "");
      else if (tag === "line") { p = new Path2D(); p.moveTo(num("x1"), num("y1")); p.lineTo(num("x2"), num("y2")); }
      else if (tag === "rect") { p = new Path2D(); p.rect(num("x"), num("y"), num("width"), num("height")); }
      else if (tag === "circle") { p = new Path2D(); p.arc(num("cx"), num("cy"), num("r"), 0, Math.PI * 2); }
      if (p) {
        if (s.fill !== "none" && !clear(s.fill)) { ctx.fillStyle = s.fill; ctx.fill(p); }
        if (s.stroke !== "none" && !clear(s.stroke) && parseFloat(s.strokeWidth) > 0) {
          ctx.strokeStyle = s.stroke;
          ctx.lineWidth = parseFloat(s.strokeWidth);
          ctx.lineCap = s.strokeLinecap as CanvasLineCap;
          ctx.lineJoin = s.strokeLinejoin as CanvasLineJoin;
          ctx.setLineDash(s.strokeDasharray === "none" ? [] : s.strokeDasharray.split(/[\s,]+/).map(parseFloat));
          ctx.stroke(p);
          ctx.setLineDash([]);
        }
      }
    }
    ctx.globalAlpha = 1;
  };
  walk(svg);
  ctx.restore();
}

export async function viewPng(root: HTMLElement, scale = 2): Promise<Blob> {
  await document.fonts?.ready;
  const box = root.getBoundingClientRect();
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(box.width * scale);
  canvas.height = Math.ceil(box.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This window can't draw a picture.");
  ctx.scale(scale, scale);
  const walk = (el: Element) => {
    const s = getComputedStyle(el);
    if (s.display === "none") return;
    if (el instanceof SVGSVGElement) { paintSvg(ctx, el, box.left, box.top); return; }
    paintBox(ctx, el, s, box.left, box.top);
    for (const c of el.childNodes) {
      if (c.nodeType === 3) paintText(ctx, c as Text, s, box.left, box.top);
      else if (c.nodeType === 1) walk(c as Element);
    }
  };
  walk(root);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't make the picture."))), "image/png");
  });
}
