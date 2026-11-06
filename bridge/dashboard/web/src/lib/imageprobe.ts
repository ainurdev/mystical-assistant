/* Does this address load? Asked of the browser (an offscreen Image), once per URL, and
   remembered, so a keystroke in the composer never re-fetches and a turn the virtualizer
   remounts knows its images' sizes before they decode, and doesn't jump.

   A miss is only remembered briefly: a file can appear (an agent just wrote it, an
   address was typed before the file was saved), and a yes keeps until something says
   otherwise, which is an <img> failing on it (dropImage). */

export type Seen =
  | { state: "ok"; width: number; height: number }
  | { state: "bad"; at: number };

const BAD_TTL = 10_000;
const TIMEOUT = 15_000;
const KEEP = 1000;

const seen = new Map<string, Seen>();
const flying = new Map<string, Promise<Seen>>();

function remember(url: string, s: Seen) {
  seen.delete(url);
  seen.set(url, s);
  // Oldest first: a Map iterates in insertion order.
  if (seen.size > KEEP) seen.delete(seen.keys().next().value as string);
}

export const knownImage = (url: string) => seen.get(url);

/** True when a probe would tell us something: never asked, or a miss gone stale. */
export function worthProbing(url: string): boolean {
  if (flying.has(url)) return false;
  const s = seen.get(url);
  return !s || (s.state === "bad" && Date.now() - s.at > BAD_TTL);
}

export function noteImage(url: string, width: number, height: number) {
  remember(url, { state: "ok", width, height });
}

/** It was fine, and now an <img> failed on it: it's gone. */
export function dropImage(url: string) {
  remember(url, { state: "bad", at: Date.now() });
}

export function probeImage(url: string): Promise<Seen> {
  const going = flying.get(url);
  if (going) return going;
  const p = new Promise<Seen>((resolve) => {
    const img = new Image();
    // A person typed this address, and the host it names still needn't learn the page.
    img.referrerPolicy = "no-referrer";
    const done = (s: Seen) => {
      clearTimeout(t);
      img.onload = img.onerror = null;
      flying.delete(url);
      remember(url, s);
      resolve(s);
    };
    const t = window.setTimeout(() => done({ state: "bad", at: Date.now() }), TIMEOUT);
    img.onload = () => done({ state: "ok", width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => done({ state: "bad", at: Date.now() });
    img.src = url;
  });
  flying.set(url, p);
  return p;
}
