// A Mermaid flowchart in Markdown (a report, a plan, a reply), drawn as show_data's flow
// diagram instead of printed as its source.
//
// Why not the mermaid package: it is megabytes of d3 and dagre for one fence type, it draws
// in its own palette rather than the theme tokens, and it scales a wide chart down to fit,
// which on the Mini App's 390px leaves text nobody can read. Flow (components/DataView) is
// already themed, lays a chart across or down to suit the column, and scrolls past 0.8×.
//
// So this reads the part of Mermaid's flowchart grammar that agents write: the header and its
// direction, nodes in their shapes, links solid, dotted or thick, one way, both ways or open,
// labels in both spellings (`-->|yes|` and `-- yes -->`), chains, `&`, and subgraphs, which
// become Flow's groups. Styling lines are skipped; thick links draw as solid ones. Anything
// else returns null, and the fence stays the code block it always was: a wrong picture is
// worse than the source.
//
// Direction: TB/TD/BT (and no direction, Mermaid's default) draw down, because a column is
// narrow already. LR/RL leave it to Flow, which draws across when that fits and down when it
// doesn't, so a long chain stays readable on a phone.
//
// shortcut: flowcharts only; a sequence, class or state diagram stays a code block. Add the
// mermaid package, loaded lazily, when those start turning up in reports.
//
// Mirrors bridge/miniapp/web/src/lib/mermaid.ts. Keep them in sync.

import type { FlowEdge, FlowEv, FlowNode } from "./dataview";

type Shape = FlowNode["shape"];

/** Openers longest first, so `([` wins over `(` and `{{` over `{`. */
const SHAPES: [string, string[], Shape][] = [
  ["(((", [")))"], "terminal"], ["([", ["])"], "terminal"], ["((", ["))"], "terminal"],
  ["[[", ["]]"], "process"], ["[(", [")]"], "process"], ["{{", ["}}"], "decision"],
  ["[/", ["/]", "\\]"], "process"], ["[\\", ["\\]", "/]"], "process"],
  ["(", [")"], "terminal"], ["[", ["]"], "process"], ["{", ["}"], "decision"], [">", ["]"], "process"],
];

/** A node id: letters, digits, `_`, and a `-` that doesn't start a link. */
const ID = /^[\p{L}\p{N}_]+(?:-(?![-.>])[\p{L}\p{N}_]+)*/u;
/** A link with an optional `|label|`: `-->`, `---`, `-.->`, `==>`, `<-->`, `o--o`, `~~~`. */
const LINK = /^(<|o|x)?(-{2,}|={2,}|-\.+-|~{3,})(>|o|x)?(?:\s*\|([^|]*)\|)?/;
/** The same link with its label inline: `-- yes -->`, `-. maybe .->`, `== sure ==>`. */
const INLINE = [
  /^(<)?--\s+("[^"]*"|.+?)\s+(-{2,}>|-{3,})/,
  /^(<)?-\.\s+("[^"]*"|.+?)\s+(\.-+>|\.-+)/,
  /^(<)?==\s+("[^"]*"|.+?)\s+(={2,}>|={3,})/,
];
const SKIP = /^(classDef|class|style|linkStyle|click|accTitle|accDescr|direction)\b/;
const MAX_NODES = 80;

/** Label text as it reads: no quotes, backticks, `<br/>` or other tags. */
function clean(s: string): string {
  return s.trim().replace(/^"([\s\S]*)"$/, "$1").replace(/^`([\s\S]*)`$/, "$1")
    .replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").replace(/#quot;/g, '"').replace(/\s+/g, " ").trim();
}

/** Statements: lines, split again at `;` outside quotes. Comments (`%%`) go. */
function statements(code: string): string[] {
  const out: string[] = [];
  for (const raw of code.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("%%")) continue;
    let cur = "", quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      if (ch === ";" && !quoted) { if (cur.trim()) out.push(cur.trim()); cur = ""; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
  }
  return out;
}

type Read = { id: string; text?: string; shape?: Shape; next: number };

function readNode(s: string, at: number): Read | null {
  const m = ID.exec(s.slice(at));
  if (!m) return null;
  let i = at + m[0].length;
  let text: string | undefined, shape: Shape | undefined;
  for (const [open, closes, sh] of SHAPES) {
    if (!s.startsWith(open, i)) continue;
    let j = i + open.length, end = -1;
    const q = /^\s*"/.exec(s.slice(j));
    if (q) {
      const k = s.indexOf('"', j + q[0].length);
      if (k < 0) return null;
      text = s.slice(j + q[0].length, k);
      j = k + 1 + (/^\s*/.exec(s.slice(k + 1))?.[0].length ?? 0);
      const c = closes.find((x) => s.startsWith(x, j));
      if (!c) return null;
      end = j + c.length;
    } else {
      let at2 = -1, len = 0;
      for (const c of closes) {
        const k = s.indexOf(c, j);
        if (k >= 0 && (at2 < 0 || k < at2)) { at2 = k; len = c.length; }
      }
      if (at2 < 0) return null;
      text = s.slice(j, at2);
      end = at2 + len;
    }
    text = clean(text ?? "");
    shape = sh;
    i = end;
    break;
  }
  const cls = /^:::[\w-]+/.exec(s.slice(i));
  if (cls) i += cls[0].length;
  return { id: m[0], text, shape, next: i };
}

type Link = { label: string; dashed: boolean; heads: FlowEdge["heads"]; hidden: boolean; next: number };

function readLink(s: string, at: number): Link | null {
  const rest = s.slice(at);
  for (const re of INLINE) {
    const m = re.exec(rest);
    if (m) {
      const open = !m[3].endsWith(">");
      return { label: clean(m[2]), dashed: m[3].startsWith("."), heads: m[1] ? (open ? "end" : "both") : open ? "none" : "end",
        hidden: false, next: at + m[0].length };
    }
  }
  const m = LINK.exec(rest);
  if (!m) return null;
  const start = !!m[1], end = !!m[3];
  return { label: clean(m[4] ?? ""), dashed: m[2].includes("."), heads: start && end ? "both" : end ? "end" : "none",
    hidden: m[2].startsWith("~"), next: at + m[0].length };
}

/** The fence's flowchart as show_data's flow, or null when it isn't one this can read. */
export function mermaidFlow(code: string): FlowEv | null {
  let body = code.replace(/\r/g, "");
  let title = "";
  const front = /^\s*---\n([\s\S]*?)\n---\s*\n/.exec(body);
  if (front) {
    title = clean(/^title:\s*(.+)$/m.exec(front[1])?.[1] ?? "");
    body = body.slice(front[0].length);
  }
  const lines = statements(body);
  const head = /^(?:flowchart|graph)(?:-elk)?(?:\s+(TB|TD|BT|RL|LR))?$/i.exec(lines[0] ?? "");
  if (!head) return null;
  const dir = (head[1] ?? "TB").toUpperCase();

  const nodes = new Map<string, FlowNode & { said: boolean }>();
  const edges: FlowEdge[] = [];
  const subs: { id: string; title: string }[] = [];
  const subIds = new Set<string>();
  const groups: string[] = [];

  const declare = (n: Read): string => {
    const group = subs.length ? subs[subs.length - 1].title : "";
    const had = nodes.get(n.id);
    const node = had ?? { id: n.id, label: n.id, note: "", shape: "process" as Shape, group, said: false };
    if (n.text !== undefined) { node.label = n.text || n.id; node.said = true; }
    if (n.shape) { node.shape = n.shape; node.said = true; }
    if (!node.group && group) node.group = group;
    nodes.set(n.id, node);
    return n.id;
  };

  for (const st of lines.slice(1)) {
    if (SKIP.test(st)) continue;
    if (st === "end") { if (!subs.pop()) return null; continue; }
    const sub = /^subgraph\s+(.+)$/.exec(st);
    if (sub) {
      const spec = sub[1].trim();
      const named = /^([\p{L}\p{N}_-]+)\s*\[\s*(.*?)\s*\]$/u.exec(spec);
      const id = named ? named[1] : clean(spec);
      const t = named ? clean(named[2]) || id : clean(spec);
      subs.push({ id, title: t });
      subIds.add(id);
      if (!groups.includes(t)) groups.push(t);
      continue;
    }
    let i = 0;
    const skip = () => { while (i < st.length && /\s/.test(st[i])) i++; };
    const group = (): string[] | null => {
      const ids: string[] = [];
      for (;;) {
        skip();
        const n = readNode(st, i);
        if (!n) return null;
        ids.push(declare(n));
        i = n.next;
        skip();
        if (st[i] !== "&") return ids;
        i++;
      }
    };
    let left = group();
    if (!left) return null;
    for (;;) {
      skip();
      if (i >= st.length) break;
      const link = readLink(st, i);
      if (!link) return null;
      i = link.next;
      const right = group();
      if (!right) return null;
      if (!link.hidden) {
        for (const from of left) for (const to of right) {
          edges.push({ from, to, label: link.label, ...(link.dashed ? { dashed: true } : {}), ...(link.heads !== "end" ? { heads: link.heads } : {}) });
        }
      }
      left = right;
    }
  }
  if (subs.length) return null;

  // A subgraph's id used as a link end is the box, which Flow doesn't draw: drop those links.
  const boxes = new Set([...subIds].filter((id) => !nodes.get(id)?.said));
  const shown = [...nodes.values()].filter((n) => !boxes.has(n.id));
  if (!shown.length || shown.length > MAX_NODES) return null;
  return {
    type: "data", title: title || "Diagram", view: "diagram", kind: "flow",
    nodes: shown.map(({ said: _, ...n }) => n),
    edges: edges.filter((e) => !boxes.has(e.from) && !boxes.has(e.to)),
    groups: groups.filter((g) => shown.some((n) => n.group === g)),
    direction: dir === "LR" || dir === "RL" ? "" : "down",
  };
}
