// Spreadsheets from a view: CSV is in lib/dataview, this is .xlsx. An xlsx is a zip of a few
// XML files, and a zip that stores without compressing is 40 lines, so there's no library
// and nothing extra in a phone bundle. Pure, for viewexport.check.ts. The same file is in both apps.

import type { Col, Row } from "./dataview";

const encoder = new TextEncoder();

let table: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip with its entries stored, not deflated. */
export function zipStored(files: Record<string, string>): Uint8Array {
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let at = 0;
  const entries = Object.entries(files);
  for (const [name, text] of entries) {
    const nameB = encoder.encode(name), data = encoder.encode(text), crc = crc32(data);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true);
    head.setUint32(14, crc, true); head.setUint32(18, data.length, true); head.setUint32(22, data.length, true);
    head.setUint16(26, nameB.length, true);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true); dir.setUint16(4, 20, true); dir.setUint16(6, 20, true); dir.setUint16(8, 0x0800, true);
    dir.setUint32(16, crc, true); dir.setUint32(20, data.length, true); dir.setUint32(24, data.length, true);
    dir.setUint16(28, nameB.length, true); dir.setUint32(42, at, true);
    const h = new Uint8Array(head.buffer);
    parts.push(h, nameB, data);
    central.push(new Uint8Array(dir.buffer), nameB);
    at += h.length + nameB.length + data.length;
  }
  const size = central.reduce((t, c) => t + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, size, true); end.setUint32(16, at, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((t, a) => t + a.length, 0));
  let o = 0;
  for (const a of all) { out.set(a, o); o += a.length; }
  return out;
}

// XML 1.0 has no way to write most control characters, and one of them makes Excel refuse the file.
const xml = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const colName = (i: number): string => {
  let n = i + 1, out = "";
  while (n > 0) { const m = (n - 1) % 26; out = String.fromCharCode(65 + m) + out; n = Math.floor((n - 1) / 26); }
  return out;
};

const STYLE = { head: 1, money: 2, percent: 3, date: 4, number: 5, total: 6, totalMoney: 7 };

/** An Excel date is days since 1899-12-30. A month alone stays text. */
export function excelDate(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000);
}

function cell(ref: string, v: unknown, c: Col, total = false): string {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "number" && Number.isFinite(v)) {
    const s = total ? (c.type === "money" ? STYLE.totalMoney : STYLE.total)
      : c.type === "money" ? STYLE.money : c.type === "percent" || c.type === "progress" ? STYLE.percent : STYLE.number;
    return `<c r="${ref}" s="${s}"><v>${v}</v></c>`;
  }
  if (c.type === "date" && typeof v === "string") {
    const d = excelDate(v);
    if (d !== null) return `<c r="${ref}" s="${STYLE.date}"><v>${d}</v></c>`;
  }
  // An inline string is text to Excel: `=SUM(...)` from an agent stays words and never runs.
  return `<c r="${ref}" t="inlineStr"${total ? ` s="${STYLE.total}"` : ""}><is><t xml:space="preserve">${xml(String(v))}</t></is></c>`;
}

export function xlsx(title: string, columns: Col[], rows: Row[], totals: Record<string, number> = {}): Uint8Array {
  const sheetName = xml(title.replace(/[\][*?:/\\]/g, " ").trim().slice(0, 31) || "Sheet1");
  const widths = columns.map((c) => Math.min(60, Math.max(c.label.length + 2, ...rows.slice(0, 200).map((r) => String(r[c.key] ?? "").length + 2), c.type === "money" ? 14 : 8)));
  const head = columns.map((c, i) => `<c r="${colName(i)}1" t="inlineStr" s="${STYLE.head}"><is><t xml:space="preserve">${xml(c.label)}</t></is></c>`).join("");
  const body = rows.map((r, y) => `<row r="${y + 2}">${columns.map((c, i) => cell(`${colName(i)}${y + 2}`, r[c.key], c)).join("")}</row>`).join("");
  const has = columns.some((c) => c.key in totals);
  const last = rows.length + 2;
  const foot = has ? `<row r="${last}">${columns.map((c, i) => cell(`${colName(i)}${last}`, c.key in totals ? totals[c.key] : i === 0 ? "Total" : null, c, true)).join("")}</row>` : "";
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols><sheetData><row r="1">${head}</row>${body}${foot}</sheetData></worksheet>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="0.0&quot;%&quot;"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="8"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/></cellXfs></styleSheet>`;
  return zipStored({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": styles,
    "xl/worksheets/sheet1.xml": sheet,
  });
}
