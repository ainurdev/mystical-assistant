// Run: node bridge/dashboard/web/src/lib/sounds.check.ts
import {
  audition, catLabel, packBase, packChoice, playSound, preloadSound, soundsFor, type Pack,
} from "./sounds.ts";

const ok = (cond: boolean | undefined, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

const pack = (extra: Partial<Pack> = {}): Pack => ({
  name: "glados", display_name: "GLaDOS (Portal)", categories: ["task.complete"],
  source_repo: "PeonPing/og-packs", source_ref: "v1.0.0", source_path: "glados", ...extra,
});

// A pack inside a monorepo hangs off its subdirectory; one that IS the repo
// carries source_path "." (or nothing), which must not become a trailing slash.
{
  ok(packBase(pack()) === "https://raw.githubusercontent.com/PeonPing/og-packs/v1.0.0/glados",
    "a sub-path pack resolves to its directory");
  ok(packBase(pack({ source_path: "." })) === "https://raw.githubusercontent.com/PeonPing/og-packs/v1.0.0",
    "source_path '.' means the repo root, with no trailing slash");
  ok(packBase(pack({ source_path: undefined })) === "https://raw.githubusercontent.com/PeonPing/og-packs/v1.0.0",
    "an absent source_path means the repo root");
}

// Every pack stores its audio at sounds/<basename>, but manifests spell the
// path three different ways. Taking the spelling literally 404s the bare form —
// which is what the live catalog actually does (office_space_peter et al).
{
  const c = packChoice(pack(), { file: "sounds/Fantastic.mp3", label: "Fantastic" });
  ok(c.src === "https://raw.githubusercontent.com/PeonPing/og-packs/v1.0.0/glados/sounds/Fantastic.mp3",
    "a sounds/-prefixed path keeps its one prefix");
  ok(c.label === "GLaDOS (Portal) · Fantastic", "the label names the voice, not just the line");
  ok(packChoice(pack(), { file: "./sounds/Yes.mp3" }).src.endsWith("/glados/sounds/Yes.mp3"),
    "a './' prefixed path doesn't double the slash");
  ok(packChoice(pack(), { file: "bare.mp3" }).src.endsWith("/glados/sounds/bare.mp3"),
    "a bare filename is resolved under sounds/, not the pack root");
  ok(packChoice(pack(), { file: "clips/deep/x.mp3" }).src.endsWith("/glados/sounds/x.mp3"),
    "any other directory collapses to its basename under sounds/");
  ok(packChoice(pack(), { file: "sounds/what would you say.mp3" }).src
      .endsWith("/sounds/what%20would%20you%20say.mp3"),
    "spaces in a filename are encoded, not sent raw");
  ok(packChoice(pack(), { file: "sounds/IKnow.mp3" }).label === "GLaDOS (Portal) · IKnow",
    "a sound with no label falls back to its filename, extension stripped");
}

// The picker opens on the category written for the event, but every other
// category stays available underneath it — that's the "assign anything" promise.
{
  const groups = soundsFor({
    "task.error": [{ file: "a.mp3" }],
    "task.complete": [{ file: "b.mp3" }],
    "input.required": [{ file: "c.mp3" }],
    "session.end": [],
  }, "task.complete");
  ok(groups[0]?.cat === "task.complete", "the event's own category sorts first");
  ok(groups.length === 3, "the other categories stay listed");
  ok(!groups.some((g) => g.cat === "session.end"), "a category with no sounds is dropped");
  ok(soundsFor({ "task.error": [{ file: "a.mp3" }] }, "resource.limit")[0]?.cat === "task.error",
    "a pack missing the event's category still offers what it has");
}

// The raw category key names the hook that fires it; the picker shows what it's for.
{
  ok(catLabel("user.spam").label === "ANNOYED", "user.spam reads as the lines for prompts sent too fast");
  ok(catLabel("task.complete").label === "FINISHED", "task.complete reads as finished");
  ok(catLabel("mystery.cat").label === "MYSTERY.CAT" && !catLabel("mystery.cat").hint,
    "a category the picker doesn't know shows its own key and no made-up hint");
}

// ---- playback, against a stand-in for <audio> -------------------------------
// Node has no HTMLAudioElement. This one does what matters here the way the real
// one does: load() resets the element, so whatever it was playing stops; play()
// settles however the test says (a 404 rejects, a pause() before playback got
// going rejects with AbortError); "ended" fires when a line plays out.
class FakeAudio {
  static made: FakeAudio[] = [];
  src: string;
  preload = "";
  volume = 1;
  currentTime = 0;
  paused = true;
  error: { code: number } | null = null;
  loads = 0;
  playResult: () => Promise<void> = () => Promise.resolve();
  on = new Map<string, Set<() => void>>();
  constructor(src: string) { this.src = src; FakeAudio.made.push(this); }
  load() { this.loads++; this.paused = true; }
  play() { this.paused = false; return this.playResult(); }
  pause() { this.paused = true; }
  addEventListener(t: string, f: () => void) {
    if (!this.on.has(t)) this.on.set(t, new Set());
    this.on.get(t)!.add(f);
  }
  removeEventListener(t: string, f: () => void) { this.on.get(t)?.delete(f); }
  fire(t: string) { this.paused = true; for (const f of [...(this.on.get(t) ?? [])]) f(); }
}
(globalThis as { Audio?: unknown }).Audio = FakeAudio;
const made = (src: string) => FakeAudio.made.find((a) => a.src === src)!;
const url = (name: string) => `https://raw.githubusercontent.com/x/y/v1/sounds/${name}.mp3`;
const tick = () => new Promise((r) => setTimeout(r, 0));

// Picking a pack sound in the settings plays it and assigns it in one click;
// the assignment re-runs the dashboard's preload over every assigned sound.
// That preload used to load() the very element the click had just started —
// so the preview died on the spot and the fallback blip rang instead.
{
  playSound({ src: url("GoodNews"), label: "x · Good news" }, 0.5, "blip");
  preloadSound(url("GoodNews"));
  ok(!made(url("GoodNews")).paused && made(url("GoodNews")).loads === 0,
    "preloading a sound that is already playing leaves it playing");
}
{
  preloadSound(url("Flaky"));
  made(url("Flaky")).error = { code: 2 };   // MEDIA_ERR_NETWORK — offline when the page opened
  preloadSound(url("Flaky"));
  ok(made(url("Flaky")).loads === 1, "a sound that failed to fetch is fetched again the next time it's wanted");
}

// ---- audition: the settings picker's ▶ --------------------------------------
// Auditioning is clicking down a pack's lines: one plays at a time, the next
// cuts the last, and whoever started one hears exactly once when it stops.
{
  const ends: string[] = [];
  audition(url("A"), 0.5, (played) => ends.push(`A:${played}`));
  audition(url("B"), 0.5, (played) => ends.push(`B:${played}`));
  ok(made(url("A")).paused && !made(url("B")).paused, "a second audition cuts the first off");
  ok(ends.join() === "A:true", "the one cut off hears that it stopped — as a stop, not a failure");
  audition(null, 0.5);
  ok(made(url("B")).paused && ends.join() === "A:true,B:true", "audition(null) stops the one playing");
  audition(null, 0.5);
  ok(ends.length === 2, "stopping when nothing plays tells nobody");
}
{
  const ends: boolean[] = [];
  audition(url("C"), 0.5, (played) => ends.push(played));
  made(url("C")).fire("ended");
  audition(null, 0.5);
  ok(ends.join() === "true", "a line that plays to its end reports once, and a later stop is a no-op");
}
{
  // A real element sets .error before it rejects the pending play().
  preloadSound(url("Missing"));
  const el = made(url("Missing"));
  el.playResult = () => {
    el.error = { code: 4 };   // MEDIA_ERR_SRC_NOT_SUPPORTED — the 404
    return Promise.reject(Object.assign(new Error("404"), { name: "NotSupportedError" }));
  };
  let result: boolean | undefined;
  audition(url("Missing"), 0.5, (fine) => { result = fine; });
  await tick();
  ok(result === false, "a sound whose file won't load is reported broken");
}
{
  // No user gesture behind it (a recorder, a page playing on its own): the
  // browser refuses to start it, but the file is fine — not a broken sound.
  preloadSound(url("Refused"));
  made(url("Refused")).playResult = () =>
    Promise.reject(Object.assign(new Error("no gesture"), { name: "NotAllowedError" }));
  let result: boolean | undefined;
  audition(url("Refused"), 0.5, (fine) => { result = fine; });
  await tick();
  ok(result === true, "a play the browser refuses is not a broken sound");
}
{
  preloadSound(url("Slow"));
  let abort!: (e: Error) => void;
  made(url("Slow")).playResult = () => new Promise((_, rej) => { abort = rej; });
  const ends: string[] = [];
  audition(url("Slow"), 0.5, (p) => ends.push(`Slow:${p}`));
  audition(url("Next"), 0.5, (p) => ends.push(`Next:${p}`));
  abort(Object.assign(new Error("interrupted"), { name: "AbortError" }));   // what pause() does to a pending play()
  await tick();
  ok(ends.join() === "Slow:true", "a cut-off line's late AbortError is neither a failure nor a second report");
  audition(null, 0.5);
}
{
  audition(url("D"), 0.5);
  let played: boolean | undefined;
  audition("tone:blip", 0.5, (p) => { played = p; });
  ok(made(url("D")).paused && played === true,
    "a tone cuts a playing line and ends at once — it's a blip, not a line");
}

console.log("\nall sound-catalog checks passed");
