// Run: node bridge/dashboard/web/src/lib/intro.check.ts
import { shuffleScene, toIntro } from "./intro.ts";

console.assert(toIntro("bridge") === "bridge", "the bridge is kept");
console.assert(toIntro("door") === "door", "the door is kept");
console.assert(toIntro("shuffle") === "shuffle", "shuffle is kept");
console.assert(toIntro("beacons") === "mystical", "an unknown scene is the emblem");
console.assert(toIntro(undefined) === "mystical", "nothing stored is the emblem");

console.assert(shuffleScene("door", 0) === "door", "a continued boot keeps the restart's scene");
console.assert(shuffleScene(null, 0) === "mystical", "the draw covers the emblem");
console.assert(shuffleScene(null, 0.5) === "bridge", "the draw covers the bridge");
console.assert(shuffleScene(null, 0.99) === "door", "the draw covers the door");
console.assert(shuffleScene("shuffle", 0.5) === "bridge", "a kept value that isn't a scene is drawn again");
