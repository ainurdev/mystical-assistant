// The right-click edit rows: the registry App reads to find a CodeMirror view,
// and the clipboard helpers its Cut / Copy / Paste rows call.
//   node --experimental-strip-types src/lib/editorctx.check.ts
type Tr = { changes?: { from: number; to: number; insert?: string }; selection?: { anchor: number } };
const fakeView = (doc: string, from: number, to: number) => {
  const dispatched: Tr[] = [];
  return {
    dispatched,
    focused: 0,
    state: {
      doc: { length: doc.length, sliceString: (a: number, b: number) => doc.slice(a, b) },
      selection: { main: { from, to } },
    },
    dispatch(tr: Tr) { dispatched.push(tr); },
    focus() { this.focused++; },
  };
};

// Node's own global navigator is a getter; replace the property outright.
const written: string[] = [];
let writeFails = false;
let read: (() => Promise<unknown[]>) | undefined;
let readText: (() => Promise<string>) | undefined;
Object.defineProperty(globalThis, "navigator", {
  value: {
    clipboard: {
      writeText: async (t: string) => { if (writeFails) throw new Error("NotAllowedError"); written.push(t); },
      get read() { return read; },
      get readText() { return readText; },
    },
  },
  configurable: true, writable: true,
});
const textItem = (s: string) => ({ types: ["text/plain"], getType: async () => new Blob([s], { type: "text/plain" }) });
const pngItem = () => ({ types: ["image/png"], getType: async () => new Blob([new Uint8Array(4)], { type: "image/png" }) });

const { registerEditor, editorFor, selectedText, copySelection, cutSelection, pasteInto } = await import("./editorctx.ts");

// registry
const v = fakeView("", 0, 0);
const off = registerEditor("composer", { view: v });
console.assert(editorFor("composer")?.view === v, "registered view is returned");
off();
console.assert(editorFor("composer") === undefined, "unregister removes it");
const a = fakeView("", 0, 0), b = fakeView("", 0, 0);
const offA = registerEditor("composer", { view: a });
const offB = registerEditor("composer", { view: b });
offA();
console.assert(editorFor("composer")?.view === b, "a stale view's unregister leaves its replacement registered");
offB();
console.assert(editorFor("composer") === undefined, "the replacement's own unregister removes it");

// selection
console.assert(selectedText(fakeView("hello world", 6, 11)) === "world", "the selected range is read");
console.assert(selectedText(fakeView("hello", 2, 2)) === "", "a caret selects nothing");

// copy / cut
console.assert(await copySelection(fakeView("hello world", 0, 5)) === true && written[0] === "hello", "copy writes the selection");
console.assert(await copySelection(fakeView("hello", 1, 1)) === false && written.length === 1, "nothing selected, nothing written");
const cutV = fakeView("hello world", 0, 6);
console.assert(await cutSelection(cutV) === true && written[1] === "hello "
  && cutV.dispatched[0].changes?.from === 0 && cutV.dispatched[0].changes?.to === 6 && cutV.dispatched[0].changes?.insert === "",
  "cut copies the range, then deletes it");
writeFails = true;
const keep = fakeView("hello world", 0, 5);
console.assert(await cutSelection(keep) === false && keep.dispatched.length === 0, "a cut whose copy failed deletes nothing");
writeFails = false;

// paste: text goes in over the selection, caret after it, focus back
read = async () => [textItem("pasted")];
const pv = fakeView("ab", 1, 1);
console.assert(await pasteInto(pv) === "text" && pv.dispatched[0].changes?.insert === "pasted"
  && pv.dispatched[0].changes?.from === 1 && pv.dispatched[0].selection?.anchor === 7 && pv.focused === 1,
  "pasted text lands at the caret, with the caret after it");
// paste: an image goes to the files sink
read = async () => [pngItem()];
const got: File[] = [];
console.assert(await pasteInto(fakeView("", 0, 0), (f) => got.push(...f)) === "files" && got.length === 1 && got[0].type === "image/png",
  "an image goes to the sink as a File");
// paste: an image with no sink is nothing usable
console.assert(await pasteInto(fakeView("", 0, 0)) === "empty", "an image with no sink is empty");
// paste: both — the image goes out and the text goes in; text names the outcome
read = async () => [pngItem(), textItem("caption")];
const both: File[] = [];
const bv = fakeView("", 0, 0);
console.assert(await pasteInto(bv, (f) => both.push(...f)) === "text" && both.length === 1 && bv.dispatched[0].changes?.insert === "caption",
  "text wins the outcome when both went somewhere");
// paste: refused
read = async () => { throw new Error("NotAllowedError"); };
console.assert(await pasteInto(fakeView("", 0, 0)) === "refused", "a refused read says so");
// paste: no read(), only readText()
read = undefined;
readText = async () => "plain";
const tv = fakeView("", 0, 0);
console.assert(await pasteInto(tv) === "text" && tv.dispatched[0].changes?.insert === "plain", "readText is the fallback");
readText = undefined;
console.assert(await pasteInto(fakeView("", 0, 0)) === "refused", "no clipboard read at all is refused");
console.log("editorctx.check: done");
