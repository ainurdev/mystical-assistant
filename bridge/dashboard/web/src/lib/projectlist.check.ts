// Run: node bridge/dashboard/web/src/lib/projectlist.check.ts
import { filterRows, folders, matches, parentOf, span } from "./projectlist.ts";

console.assert(parentOf("/ainurhq/efas/app") === "ainurhq/efas" && parentOf("/aligned") === "" && parentOf("rivendell:jobs") === "", "parentOf");

const rows = [
  { rel: "/ainurhq/efas/app", name: "Efas App", remote: "efasone/app", hidden: false },
  { rel: "/ainurhq/nationale-rijschool/cbrmux-api", name: "cbrmux-api", remote: "ainurdev/cbrmux-api", hidden: false },
  { rel: "/ainurhq/unideck-mono/unideck-api", name: "unideck-api", remote: "ainurdev/unideck-api", hidden: true },
  { rel: "/aligned", name: "aligned", remote: "", hidden: true },
];
// the name, the path and the remote all match, in any case; blank matches all
console.assert(matches(rows[0], "EFASONE") && matches(rows[1], "rijschool") && matches(rows[3], "  ") && !matches(rows[3], "efas"), "matches");

let f = filterRows(rows, "api", "all");
console.assert(f.rows.length === 2 && f.counts.all === 2 && f.counts.shown === 1 && f.counts.hidden === 1, `api/all ${JSON.stringify(f.counts)}`);
f = filterRows(rows, "api", "hidden");
console.assert(f.rows.length === 1 && f.rows[0].name === "unideck-api" && f.counts.all === 2, "api/hidden: counts follow the query, not the filter");
f = filterRows(rows, "", "shown");
console.assert(f.rows.length === 2 && f.counts.all === 4 && f.counts.hidden === 2, "blank/shown");

console.assert(folders(rows).map((s) => s.parent).join("|") === "ainurhq/efas|ainurhq/nationale-rijschool|ainurhq/unideck-mono|", "folders");
// a folder before its sub-folder even when the sub-folder's first row sorts first; top level last
const nest = folders([{ rel: "/aligned" }, { rel: "/org/sub/aaa" }, { rel: "/org/zzz" }, { rel: "/org/sub/bbb" }]);
console.assert(nest.map((s) => s.parent).join("|") === "org|org/sub|" && nest[1].rows.length === 2, `nesting: ${nest.map((s) => s.parent).join("|")}`);

const order = ["a", "b", "c", "d"];
console.assert(span(order, "d", "b").join() === "b,c,d" && span(order, "a", "a").join() === "a" && span(order, "x", "c").join() === "c", "span");

console.log("projectlist.check: done");
