// Run: node bridge/miniapp/web/src/lib/mermaid.check.ts
import assert from "node:assert/strict";
import { mermaidFlow } from "./mermaid.ts";
import { layoutFlow } from "./dataview.ts";

// The fan the FileMaker communications guide opened with (17 Nov 2026), which a report card
// printed as its source: a stadium hub, both-way links, one one-way link.
const map = mermaidFlow(`flowchart LR
    People["Leads, students,<br/>instructors, intakers,<br/>staff, a bailiff"]
    FM(["FileMaker<br/>RSC4, RSC4_base, NR_Base,<br/>NR_decl and five helper files"])
    Mail["Mail<br/>SendGrid, SMTP, IMAP"]
    Post["PDFs, print<br/>and Print.one cards"]
    FM <--> Mail
    FM --> Post
    Mail <--> People
    Post --> People
`);
assert.ok(map);
assert.equal(map.direction, "");                                    // LR: across when it fits
assert.deepEqual(map.nodes.map((n) => n.id), ["People", "FM", "Mail", "Post"]);
assert.equal(map.nodes[1].shape, "terminal");                       // ([ ]) is a pill
assert.equal(map.nodes[1].label, "FileMaker RSC4, RSC4_base, NR_Base, NR_decl and five helper files");
assert.deepEqual(map.edges.map((e) => [e.from, e.to, e.heads ?? "end"]),
  [["FM", "Mail", "both"], ["FM", "Post", "end"], ["Mail", "People", "both"], ["Post", "People", "end"]]);

// A decision, pipe labels, a node first named in a link.
const fd = mermaidFlow(`flowchart LR
    A["Button + in TICKETS<br/>on the contact card"] --> B{"Freshdesk contact id<br/>on the card?"}
    B -->|yes| E["Ticket form,<br/>BEWAAR (save)"]
    B -->|no| C["Look the contact up"]
    C -->|not found| D["Create the contact"]
    C -->|found| E
`);
assert.ok(fd);
assert.equal(fd.nodes.find((n) => n.id === "B")?.shape, "decision");
assert.equal(fd.nodes.find((n) => n.id === "E")?.label, "Ticket form, BEWAAR (save)");   // brackets inside quotes
assert.deepEqual(fd.edges.map((e) => e.label), ["", "yes", "no", "not found", "found"]);

// Dotted links, with and without a label; a quote mark inside a label.
const calls = mermaidFlow(`flowchart LR
    B["Call<br/>(status Open)"] --> C["Task for a colleague"]
    C -.->|saving the task| F["Ticket mail"]
    B -.-> G["Contact moments<br/>on the contact's history"]
`);
assert.ok(calls);
assert.deepEqual(calls.edges.map((e) => [e.label, !!e.dashed]), [["", false], ["saving the task", true], ["", true]]);
assert.equal(calls.nodes.find((n) => n.id === "G")?.label, "Contact moments on the contact's history");

// Labels inline, chains, `&`, open and thick links, a class suffix, styling and comments.
const mix = mermaidFlow(`graph TD
    %% a comment
    A[Start]:::hot -- yes --> B(Round)
    A -. maybe .-> C
    A == sure ==> D
    B --> C --> D
    E & F --- G
    classDef hot fill:#f00
    style A stroke:#333
    linkStyle 0 stroke:red
    click A callback
`);
assert.ok(mix);
assert.equal(mix.direction, "down");
assert.deepEqual(mix.edges.map((e) => `${e.from}>${e.to}:${e.label}:${e.dashed ? "dot" : "line"}:${e.heads ?? "end"}`), [
  "A>B:yes:line:end", "A>C:maybe:dot:end", "A>D:sure:line:end", "B>C::line:end", "C>D::line:end",
  "E>G::line:none", "F>G::line:none",
]);
assert.equal(mix.nodes.find((n) => n.id === "A")?.label, "Start");
assert.equal(mix.nodes.find((n) => n.id === "B")?.shape, "terminal");

// Subgraphs are groups; a link to the box itself is dropped rather than drawn as a step.
const sub = mermaidFlow(`flowchart TB
    subgraph office [Back office]
      X[Exact] --> Y[Payments]
    end
    subgraph Apps
      Z[App]
    end
    Y --> Z
    Q[Queue] --> office
`);
assert.ok(sub);
assert.deepEqual(sub.groups, ["Back office", "Apps"]);
assert.deepEqual(sub.nodes.map((n) => [n.id, n.group]), [["X", "Back office"], ["Y", "Back office"], ["Z", "Apps"], ["Q", ""]]);
assert.deepEqual(sub.edges.map((e) => `${e.from}>${e.to}`), ["X>Y", "Y>Z"]);
// ...and boxes, named as the subgraph is titled.
assert.deepEqual(sub.clusters, [{ id: "office", label: "Back office", nodes: ["X", "Y"] }, { id: "Apps", label: "Apps", nodes: ["Z"] }]);
const boxed = layoutFlow(sub, "down");
for (const b of boxed.clusters) for (const n of boxed.nodes) {
  const inside = n.x >= b.x && n.x + n.w <= b.x + b.w && n.y >= b.y && n.y + n.h <= b.y + b.h;
  const apart = n.x + n.w <= b.x || n.x >= b.x + b.w || n.y + n.h <= b.y || n.y >= b.y + b.h;
  assert.ok(b.nodes.includes(n.id) ? inside : apart, `${n.id} vs box ${b.id}`);
}

// No direction is Mermaid's default, top to bottom; `;` separates statements; frontmatter titles.
const plain = mermaidFlow("---\ntitle: Paying an invoice\n---\ngraph\n  A-->B; B-->C");
assert.ok(plain);
assert.equal(plain.direction, "down");
assert.equal(plain.title, "Paying an invoice");
assert.equal(plain.edges.length, 2);

// What it declines, so the fence stays a code block: other diagrams, broken or half-streamed text.
assert.equal(mermaidFlow("sequenceDiagram\n  A->>B: hi"), null);
assert.equal(mermaidFlow("flowchart LR\n  A -->"), null);                // a link to nowhere
assert.equal(mermaidFlow("flowchart LR\n  A[open"), null);              // a shape never closed
assert.equal(mermaidFlow("flowchart LR\n  subgraph S\n  A"), null);     // a subgraph never ended
assert.equal(mermaidFlow(""), null);
assert.equal(mermaidFlow("flowchart LR"), null);                         // nothing to draw

// Drawn: a both-way link has a head at each end and leaves its step past the tail; an open
// link has none; a dotted one says so.
const both = layoutFlow(map, "right").arrows;
assert.ok(both[0].head && both[0].tail);
assert.ok(both[1].head && !both[1].tail);
const lay = layoutFlow(mermaidFlow("flowchart LR\n  A --- B\n  A -.-> C")!, "right").arrows;
assert.equal(lay[0].head, "");
assert.equal(lay[1].dashed, true);

// A decision's links that skip ranks ("yes" to the form, "found" past "create") bow around the
// steps between: drawn straight, the "found" label sat on the "Create the contact" step.
for (const dir of ["down", "right"] as const) {
  const drawn = layoutFlow(fd, dir);
  for (const a of drawn.arrows.filter((x) => x.label)) {
    const hit = drawn.nodes.find((n) => a.lx > n.x && a.lx < n.x + n.w && a.ly > n.y && a.ly < n.y + n.h);
    assert.equal(hit, undefined, `${dir}: label "${a.label}" sits on step "${hit?.label}"`);
  }
  assert.ok(drawn.arrows.every((x) => !x.back));                   // forward, so solid, not dashed
}
