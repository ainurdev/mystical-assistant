// Runs a widget page's script under Node against a fake TelegramWidget and a
// one-element page, the way windows/shim.check.mjs runs the app shim against a
// fake host. Every page check (one file per ticket) loads its page through here.
import { readFileSync } from "node:fs";
import vm from "node:vm";

export function load(page, chatData, { now = 1794300000 } = {}) {
  const html = readFileSync(new URL(`../../bridge/widgets/${page}`, import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const events = {}, timers = [], requests = [];
  const el = { innerHTML: "", addEventListener() {} };
  const clock = { now };
  const widget = {
    chatData: typeof chatData === "string" ? chatData : JSON.stringify(chatData),
    colorScheme: "dark", themeParams: {},
    onEvent: (name, fn) => { (events[name] ||= []).push(fn); },
    request: (text) => new Promise((ok, no) => requests.push({ text, ok, no })),
    ready() {},
  };
  const ctx = {
    window: { TelegramWidget: widget },
    document: { getElementById: () => el },
    setInterval: (fn) => timers.push(fn),
    Date: { now: () => clock.now * 1000 },
  };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  return {
    ctx, requests,
    html: () => el.innerHTML,
    text: () => el.innerHTML.replace(/<[^>]+>/g, " ").replace(/&#(\d+);/g, (_, c) => String.fromCharCode(c)).replace(/\s+/g, " ").trim(),
    tick(s = 1) { clock.now += s; timers.forEach((fn) => fn()); },
    data(d) { widget.chatData = JSON.stringify(d); (events.chatDataChanged || []).forEach((fn) => fn()); },
  };
}

export function check(name, fn) {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e) { console.log(`FAIL ${name}\n     ${e.message}`); process.exitCode = 1; }
}
