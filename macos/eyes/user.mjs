// The user's own dashboard on this Mac, so a capture looks like what they see: Mystical.app's
// localStorage as a PRELOAD seed for cdp.mjs/wkshot.swift, and the size of its dashboard window.
// usage: node macos/eyes/user.mjs preload | size
import { execFileSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { pathToFileURL } from "node:url";

const STORE = path.join(os.homedir(), "Library/WebKit/cloud.ainurhq.mystical/WebsiteData/Default");
const KEYS = ["hud-settings"];
const mtime = f => Math.max(...["", "-wal"].map(e => (fs.existsSync(f + e) ? fs.statSync(f + e).mtimeMs : 0)));

/** localStorage.setItem calls for KEYS as Mystical.app holds them now; "" when it has none. */
export function userPreload() {
  // One store per origin the app has opened; the most recently written is the live one.
  const db = fs.existsSync(STORE)
    ? fs.globSync("*/*/LocalStorage/localstorage.sqlite3", { cwd: STORE }).map(f => path.join(STORE, f)).sort((a, b) => mtime(b) - mtime(a))[0]
    : null;
  if (!db) return "";
  // The live values sit in the -wal (it passes 1 GB), so clone all three files (APFS, instant) and
  // read the clone. It holds drafts, so it goes straight after.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eyes-ls-"));
  try {
    for (const ext of ["", "-wal", "-shm"]) if (fs.existsSync(db + ext)) execFileSync("cp", ["-c", db + ext, tmp]);
    const sql = `select key, typeof(value), hex(value) from ItemTable where key in (${KEYS.map(k => `'${k}'`).join(",")})`;
    const rows = execFileSync("sqlite3", ["-separator", "\t", path.join(tmp, "localstorage.sqlite3"), sql], { maxBuffer: 1 << 26 })
      .toString().split("\n").filter(Boolean);
    return rows.map(row => {
      const [key, type, hex] = row.split("\t");
      const value = Buffer.from(hex, "hex").toString(type === "blob" ? "utf16le" : "utf8");
      return `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)});`;
    }).join("\n");
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/** Mystical.app's dashboard window as [w, h] in CSS px; null when it has never opened. */
export function userWindow() {
  const read = key => execFileSync("defaults", ["read", "cloud.ainurhq.mystical", key], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  try {
    const [, , w, h] = read("NSWindow Frame Dashboard").split(/\s+/).map(Number);
    let zoom = 1;
    try { zoom = Number(read("pageZoom")) || 1; } catch {}
    return w > 0 && h > 0 ? [Math.round(w / zoom), Math.round(h / zoom)] : null;
  } catch { return null; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const what = process.argv[2];
  if (what === "preload") console.log(userPreload());
  else if (what === "size") console.log(userWindow()?.join(" ") ?? "");
  else { console.error("usage: node macos/eyes/user.mjs preload | size"); process.exit(2); }
}
