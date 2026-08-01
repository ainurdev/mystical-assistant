// Run: node bridge/dashboard/web/src/lib/questionDraft.check.ts
// Guards the one promise a draft makes: answers you picked but never sent come
// back when you return to the question, stay separate per question, and vanish
// once it's answered.
import { clearDraft, readDraft, saveDraft } from "./questionDraft.ts";

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};

ok(Object.keys(readDraft("r1").sel).length === 0, "an untouched question starts empty");

saveDraft("r1", { sel: { Approach: ["Guardrails"] }, notes: { Approach: "prefer this" } });
ok(readDraft("r1").sel.Approach[0] === "Guardrails", "picked options survive leaving the session");
ok(readDraft("r1").notes.Approach === "prefer this", "free-text notes survive too");

// Two questions open at once must not read each other's answers.
ok(Object.keys(readDraft("r2").sel).length === 0, "a different question has its own draft");

clearDraft("r1");
ok(Object.keys(readDraft("r1").sel).length === 0, "answering the question drops its draft");

store.set("qdraft:r3", "{not json");
ok(Object.keys(readDraft("r3").notes).length === 0, "corrupt storage reads as an empty draft");

console.log("all ok");
