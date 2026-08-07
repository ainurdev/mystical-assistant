// Run: node bridge/dashboard/web/src/lib/sounds.check.ts
import { packBase, packChoice, soundsFor, type Pack } from "./sounds.ts";

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

console.log("\nall sound-catalog checks passed");
