// Run: node bridge/dashboard/web/src/lib/facts.check.ts
// The answer's facts (.mystical/design-drafts/session-one-feel, C · SPINE): a list whose
// every item opens with a bold label is drawn as label · text rows; any other list stays a list.
import assert from "node:assert/strict";
import type { Element, ElementContent } from "hast";
import { isFactList } from "./facts.ts";

const t = (value: string): ElementContent => ({ type: "text", value });
const el = (tagName: string, ...children: ElementContent[]): Element => ({ type: "element", tagName, properties: {}, children });
const ul = (...items: Element[]) => el("ul", t("\n"), ...items.flatMap((li) => [li, t("\n")]));

assert.ok(isFactList(ul(
  el("li", el("strong", t("Merge:")), t(" fast-forward.")),
  el("li", el("strong", t("Checks:")), t(" 127/127 "), el("code", t("index.css"))),
)), "every item opens with a label: facts");

assert.ok(isFactList(ul(el("li", t("\n"), el("p", el("strong", t("Cleanup:")), t(" gone.")), t("\n")))),
  "a loose list's items hold a paragraph: the label leads it");

assert.ok(!isFactList(ul(
  el("li", el("strong", t("Merge:")), t(" fast-forward.")),
  el("li", t("Checks passed.")),
)), "one item without a label: a plain list");

assert.ok(!isFactList(ul(el("li", t("Run "), el("strong", t("Fix:")), t(" now")))),
  "a label after words is emphasis, not a fact's label");

assert.ok(!isFactList(ul(el("li", el("strong", t("72 passed, 1 failed")), t(" today")))),
  "a bold without a colon is emphasis");

assert.ok(!isFactList(ul()), "an empty list");
