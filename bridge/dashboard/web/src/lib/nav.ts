// Writing the URL's search (lib/routes extrasOf/searchOf): the rail's tab and
// the one pop-up. A pop-up opened here is its own history entry, so back closes
// it; closing it here steps back off that entry rather than leaving a dead one
// behind it. Everything else is a replace: moving between rail tabs, or the
// editor moving to another file, adds no history.
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useRouter, type AnyRouter } from "@tanstack/react-router";
import { extrasOf, ownSearch, searchOf, type Extras, type Popup } from "./routes";
import { RIGHT_TABS } from "./theme";

type Loc = { pathname: string; search: string; state: { __TSR_index: number } };
// The history's own location: it writes window.location on a deferred flush, so
// that trails a navigation made a moment ago.
const here = (r: AnyRouter) => r.history.location as unknown as Loc;

/** The hash's own search ("?rail=git" or ""). Hash history appends the page's
 *  real query (?token=…&skipboot) to it, and writing that back would copy the
 *  token into the hash. */
export const hashSearch = (r: AnyRouter): string => ownSearch(here(r).search, window.location.search);

/** The URL's rail tab and pop-up, now. */
export const extrasNow = (r: AnyRouter): Extras => extrasOf(hashSearch(r), RIGHT_TABS);

/** The current path with its extras changed by `patch`. */
export function setExtras(r: AnyRouter, patch: Extras, replace: boolean) {
  const l = here(r);
  const q = hashSearch(r);
  const to = l.pathname + searchOf({ ...extrasOf(q, RIGHT_TABS), ...patch });
  if (to === l.pathname + q) return;
  if (replace) r.history.replace(to); else r.history.push(to);
}

// The entry a pop-up of ours was pushed onto (its history index), so closing it
// can step back off it.
let pushedAt: number | null = null;

/** Open a pop-up: a new entry, or in place of one we pushed (back still closes in one step).
 *  A pop-up the URL names on an entry we didn't push (a picture a reload couldn't
 *  bring back) gets an entry above it, so back never skips past the session. */
export function openPopup(r: AnyRouter, popup: Popup) {
  if (extrasNow(r).popup && pushedAt === here(r).state.__TSR_index) return setExtras(r, { popup }, true);
  setExtras(r, { popup }, false);
  pushedAt = here(r).state.__TSR_index;
}

/** Close the pop-up the URL names: back off its entry if we pushed it, else drop it from this one. */
export function closePopup(r: AnyRouter) {
  if (!extrasNow(r).popup) return;
  if (pushedAt !== null && pushedAt === here(r).state.__TSR_index) { pushedAt = null; return r.history.back(); }
  setExtras(r, { popup: undefined }, true);
}

/** The turn a picture sits in, for its viewer's URL. Absent: the viewer keeps no URL. */
export const PicTurn = createContext<string | undefined>(undefined);

/** A picture's key in the URL: a short hash of its src, so no path or token shows. */
export function picKey(src: string): string {
  let h = 5381;
  for (let i = 0; i < src.length; i++) h = (h * 33 + src.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// The picture the load's URL named, still waiting for the turn that shows it to
// mount: taken by the first viewer owner whose pictures hold it.
let waiting: Popup | undefined;
let waitingRead = false;

/** A picture viewer's open picture, kept in the URL (`pic`) when it sits in a
 *  turn: back closes it and a reload reopens it. `srcs` are the pictures this
 *  owner can open. A data: URL keeps no URL — it can't come back after a reload. */
export function usePic(srcs: readonly string[]): [string | null, (src: string | null) => void] {
  const router = useRouter();
  const turn = useContext(PicTurn);
  const [zoom, setZoom] = useState<string | null>(null);
  const mine = useRef<string | null>(null);   // the pic value this owner put in the URL
  if (!waitingRead) { waitingRead = true; waiting = extrasNow(router).popup; }

  // A reload: the picture the URL names opens once its turn is on screen.
  const key = srcs.join("\n");
  useEffect(() => {
    if (zoom || !turn || waiting?.kind !== "pic" || waiting.turn !== turn) return;
    const pic = waiting.pic;
    const src = srcs.find((s) => picKey(s) === pic);
    if (!src) return;
    waiting = undefined;
    mine.current = `${turn}.${pic}`;
    setZoom(src);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- srcs by value
  }, [turn, key]);

  // Back (or anything else) took our picture out of the URL: close. Listening
  // only while open, so a closed owner costs nothing on a navigation.
  useEffect(() => {
    if (!zoom) return;
    return router.history.subscribe(() => {
      if (!mine.current) return;
      const p = extrasNow(router).popup;
      if (p?.kind === "pic" && `${p.turn}.${p.pic}` === mine.current) return;
      mine.current = null;
      setZoom(null);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- router is stable
  }, [zoom]);

  const set = (src: string | null) => {
    setZoom(src);
    if (src && turn && !src.startsWith("data:")) {
      const pic = picKey(src);
      mine.current = `${turn}.${pic}`;
      openPopup(router, { kind: "pic", turn, pic });
    } else if (!src && mine.current) {
      mine.current = null;
      closePopup(router);
    }
  };
  return [zoom, set];
}
