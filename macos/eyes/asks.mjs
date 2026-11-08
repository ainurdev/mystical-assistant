// Sessions that wait on you, canned, on top of roserve.mjs: drive an Ask on a real build (the dock's
// question, three questions in one ask, a permission, a reply to a question asked in prose) with
// nothing reaching the bridge. The session list is the live one with these in front. An answer is
// printed as RESPOND and written back as the event the bridge would add, so the dock moves on;
// any other write is printed as REFUSED and gets roserve's 405.
// usage: node macos/eyes/asks.mjs <distDir> [port=0 any free one] [upstream=127.0.0.1:8790]
// It prints its URL first, then one "<id> <title>" line per session. Open one by adding
// localStorage.setItem('hud-last-session', '<id>') to PRELOAD.
import http from "node:http"; import path from "node:path"; import { pathToFileURL } from "node:url";
import { serve } from "./roserve.mjs";

const now = Date.now() / 1000;
let seq = 0;
const ev = (turn_id, type, extra) => ({ type, turn_id, seq: ++seq, ts: now - 300 + seq, at: now - 300 + seq, ...extra });
const opt = (label, description) => ({ label, description });
const SHIP = { header: "Ship", multiSelect: false, question: "It's built and tested on local master. When should it go live?",
  options: [opt("When they finish (Recommended)", "Restart once the other running turns end."),
    opt("Ship now", "Restart right away; the running turns resume by themselves."), opt("Leave it", "It goes live at your next restart.")] };
const EXTRAS = { header: "Extras", multiSelect: true, question: "Which extras should come with it? Pick any, or none.",
  options: [opt("Low-limit badge", "The rail icon shows the % in amber at 25% or less."), opt("Pace line", "When the 5-hour window runs out at this pace."),
    opt("Timesheet", "Copy the week as a markdown timesheet."), opt("Fold worktrees", "Worktrees count toward their repo.")] };
const DESIGN = { header: "Design", multiSelect: false, question: "Which design should I build?",
  options: [opt("A · Seam (Recommended)", "One divider where the turn stopped."), opt("B · Card", "A card with the resume time and buttons.")] };

/** [title, the turn's status, its events]. A running turn waits on its open ask. */
const ASKS = [
  ["Ask · pick one", "running", (t) => [ev(t, "question", { request_id: "rq-1", questions: [SHIP] })]],
  ["Ask · pick several", "running", (t) => [ev(t, "question", { request_id: "rq-2", questions: [EXTRAS] })]],
  ["Ask · three questions", "running", (t) => [ev(t, "question", { request_id: "rq-3", questions: [DESIGN, EXTRAS, SHIP] })]],
  ["Ask · permission", "running", (t) => [ev(t, "permission", { request_id: "rp-4", tool_name: "Bash", summary: "git push origin master", detail: "git push origin master" })]],
  ["Ask · in prose", "done", (t) => [ev(t, "result", { result: "Drew both layouts on the live box.\n\nWant me to build the list, or the grid?" })]],
];
const DATA = Object.fromEntries(ASKS.map(([title, status, events], i) => {
  const t = `t0${i + 1}`;
  return [`f${"0".repeat(26)}e${String(i + 1).padStart(4, "0")}`, { title, turns: [{ id: t, seq: 0, prompt: title, attachments: [], status,
    outcome: null, cost: 1.2, elapsed: 300, started: now - 300, model: "claude-opus-5-5", effort: "high", permission_mode: "default" }], events: events(t) }];
}));

let base = null;   // a real session from the live list, so a canned one carries every field the page reads
const brief = (sid) => ({ ...base, id: sid, title: DATA[sid].title, origin: "dashboard", created: now - 720, updated: now - 60, job: null,
  goal: null, team: null, device: null, lifecycle: null, status: DATA[sid].turns[0].status === "running" ? "running" : "done" });
const json = (res, obj) => { const b = Buffer.from(JSON.stringify(obj)); res.writeHead(200, { "content-type": "application/json", "content-length": b.length }); res.end(b); };
const text = (stream) => new Promise((ok) => { const c = []; stream.on("data", (x) => c.push(x)); stream.on("end", () => ok(Buffer.concat(c).toString())); });

/** roserve's `canned` hook for upstream `up` (host:port). */
export function canned(up) {
  const [host, port] = up.split(":");
  return (req, res, url) => {
    const sid = decodeURIComponent(url.pathname.split("/").pop());
    if (req.method === "GET" && url.pathname === "/local/sessions") {
      const headers = { ...req.headers, host: up };
      delete headers["accept-encoding"];   // the list is rewritten, so it has to arrive plain
      http.get({ host, port: +port, path: req.url, headers }, (r) => text(r).then((body) => {
        try {
          const list = JSON.parse(body);
          base = list.sessions.find((s) => !s.team && !s.job && !s.device) ?? list.sessions[0];
          list.sessions = [...Object.keys(DATA).map(brief), ...list.sessions];
          json(res, list);
        } catch { res.writeHead(r.statusCode, r.headers); res.end(body); }
      })).on("error", (e) => { res.writeHead(502); res.end(String(e)); });
      return true;
    }
    if (!DATA[sid]) return writes(req, res, url);
    if (url.pathname === `/local/sessions/${sid}`) {
      const cursor = Number(url.searchParams.get("cursor") ?? 0);
      json(res, { session: base && brief(sid), turns: DATA[sid].turns, events: DATA[sid].events.filter((e) => e.seq > cursor), next_cursor: seq });
      return true;
    }
    if (url.pathname === `/local/stream/session/${sid}`) { res.writeHead(200, { "content-type": "text/event-stream" }); return true; }
    return writes(req, res, url);
  };
}

function writes(req, res, url) {
  if (req.method === "GET" || req.method === "HEAD") return false;
  text(req).then((body) => {
    const turn = /^\/local\/run\/([^/]+)\/respond$/.exec(url.pathname)?.[1];
    const d = Object.values(DATA).find((x) => x.turns[0].id === turn);
    if (!d) { console.log("REFUSED", req.method, url.pathname, body.slice(0, 300)); res.writeHead(405); res.end(); return; }
    console.log("RESPOND", turn, body);
    const a = JSON.parse(body || "{}");
    d.events.push(a.answers ? ev(turn, "question_answered", { request_id: a.request_id, answers: a.answers })
      : ev(turn, "permission_resolved", { request_id: a.request_id, behavior: a.behavior === "deny" ? "deny" : "allow" }));
    json(res, { noted: !!a.message });
  });
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dist, port = 0, up = "127.0.0.1:8790"] = process.argv.slice(2);
  if (!dist) { console.error("usage: node macos/eyes/asks.mjs <distDir> [port] [upstream]"); process.exit(2); }
  const s = await serve(dist, port, up, canned(up));
  console.log(`http://127.0.0.1:${s.address().port} serves ${path.resolve(dist)} with canned asks; GET/HEAD go to ${up}`);
  for (const [sid, d] of Object.entries(DATA)) console.log(sid, d.title);
}
