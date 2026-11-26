// A PDF of a view: the same picture the PNG export paints (lib/viewpng), as a JPEG on one page
// its own size. The same file is in both apps.
//
// Why not a PDF library: they're hundreds of KB for what is one image on one page, and a
// PDF holding a JPEG is a few objects and an index, written here. Why a picture and not text:
// the views are drawn, not typeset, and the picture is what the PNG already gets right.
// ponytail: the text in it isn't selectable or searchable; that would mean laying the view out
// again in PDF's own text operators, which is a typesetter, not an export.

/** The PNG export, as a PDF. `scale` is the PNG's pixels per CSS pixel (viewPng draws at 2). */
export async function pdfOf(png: Blob, title: string, scale = 2): Promise<Blob> {
  const bmp = await createImageBitmap(png);
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("Couldn't make the PDF.");
  ctx.fillStyle = "#ffffff";          // JPEG has no transparency: what's clear prints white
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0);
  const jpg = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", 0.92));
  if (!jpg) throw new Error("Couldn't make the PDF.");
  const bytes = pdfFromJpeg(new Uint8Array(await jpg.arrayBuffer()), bmp.width, bmp.height, title, scale);
  return new Blob([bytes as BlobPart], { type: "application/pdf" });
}

/** A text string PDF reads in any script: UTF-16BE, as hex. */
const pdfText = (s: string) => {
  let hex = "FEFF";
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
  return `<${hex}>`;
};

/** One page, one JPEG filling it. Pure, so viewpdf.check.ts can read the bytes back. A page
 *  is in points, 72 to the inch; the picture is CSS pixels (96 to the inch) times `scale`. */
export function pdfFromJpeg(jpg: Uint8Array, w: number, h: number, title: string, scale = 2): Uint8Array {
  const pw = +((w / scale) * 0.75).toFixed(2), ph = +((h / scale) * 0.75).toFixed(2);
  const enc = new TextEncoder();
  const draw = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
  const objs: (string | [string, Uint8Array, string])[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`,
    [`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`, jpg, "\nendstream"],
    `<< /Title ${pdfText(title)} /Producer (Mystical) >>`,
  ];
  const parts: Uint8Array[] = [];
  let at = 0;
  const put = (p: string | Uint8Array) => { const b = typeof p === "string" ? enc.encode(p) : p; parts.push(b); at += b.length; };
  put("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(at);
    put(`${i + 1} 0 obj\n`);
    if (typeof o === "string") put(o);
    else { put(o[0]); put(o[1]); put(o[2]); }
    put("\nendobj\n");
  });
  const xref = at;
  put(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`);
  put(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(at);
  let k = 0;
  for (const p of parts) { out.set(p, k); k += p.length; }
  return out;
}
