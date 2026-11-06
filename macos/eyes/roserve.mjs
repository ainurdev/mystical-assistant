// Serves a dashboard build read-only: its own files from <dist>, every GET/HEAD (SSE included)
// passed to the live bridge, anything else a 405. A build sees real sessions and can't write them:
// opening a session marks its notices read, which is a POST.
// usage: node macos/eyes/roserve.mjs <distDir> [port=8798, 0 = any free one] [upstream=127.0.0.1:8790]
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import { pathToFileURL } from "node:url";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".json": "application/json", ".webmanifest": "application/manifest+json" };

/** Resolves to the listening server once it has a port (server.address().port). It runs in your
 *  process: block the event loop (execFileSync) while a page loads from it and the page never loads. */
export function serve(dist, port = 8798, up = "127.0.0.1:8790") {
  dist = path.resolve(dist);
  const [upHost, upPort] = up.includes(":") ? up.split(":") : ["127.0.0.1", up];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const file = url.pathname === "/" ? path.join(dist, "index.html") : path.join(dist, decodeURIComponent(url.pathname));
    if (file.startsWith(dist) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
      fs.createReadStream(file).pipe(res); return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); return; }
    const p = http.request({ host: upHost, port: +upPort, method: req.method, path: req.url, headers: { ...req.headers, host: `${upHost}:${upPort}` } },
      (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    p.on("error", (e) => { if (res.destroyed) return; if (!res.headersSent) res.writeHead(502); res.end(String(e)); });
    // A closed page would otherwise leave its SSE stream open on the live bridge until this server exits.
    res.on("close", () => p.destroy());
    req.pipe(p);
  });
  return new Promise(ok => server.listen(+port, "127.0.0.1", () => ok(server)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dist, port, up = "127.0.0.1:8790"] = process.argv.slice(2);
  if (!dist) { console.error("usage: node macos/eyes/roserve.mjs <distDir> [port] [upstream]"); process.exit(2); }
  const s = await serve(dist, port ?? 8798, up);
  // The URL comes first, alone, so a script can take the first word: the upstream is a host:port too.
  console.log(`http://127.0.0.1:${s.address().port} serves ${path.resolve(dist)}; GET/HEAD go to ${up}, the rest get 405`);
}
