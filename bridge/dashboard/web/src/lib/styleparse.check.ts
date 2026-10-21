// Run: node bridge/dashboard/web/src/lib/styleparse.check.ts
import { partialAnswer, styleCounts } from "./styleparse.ts";

const half = partialAnswer('{"p":"P3","pick":"c2","bg":"none","color":"#3168d0","why":"its own app ic');
console.assert(half.p === "P3" && half.pick === "c2" && half.bg === "none" && half.color === "#3168d0", "what it already says", half);
console.assert(half.why === "its own app ic", "the why so far", half.why);
console.assert(partialAnswer('{"p":"P1","pi').pick === undefined, "a field not begun yet");
console.assert(partialAnswer('{"p":"P1","why":"say \\"keep\\" it"}').why === 'say "keep" it', "escaped quotes");
console.assert(Object.keys(partialAnswer("")).length === 0, "nothing yet");

const c = styleCounts([{ how: ["logo", "background", "colour"] }, { how: ["icon", "colour"] }, { how: ["colour"] }, { how: [] }]);
console.assert(c.logos === 1 && c.icons === 1 && c.backgrounds === 1 && c.colours === 3 && c.kept === 1 && c.changed === 3, "counts", c);
console.log("styleparse ok");
