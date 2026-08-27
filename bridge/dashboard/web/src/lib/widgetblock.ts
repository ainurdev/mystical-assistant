// A widget the model draws in its own prose, rather than one a tool result
// happened to carry.
//
// Measured before writing this: across every transcript on this machine, no tool
// result carries structured data at all. TodoWrite / Grep / Glob / ReportFindings
// are never called (the global instruction routes them through Bash), and every
// MCP result is `[{type:"text", text:"…"}]` or a bare string. So a sniffer over
// tool results would compile, ship, and fire zero times — the widget vocabulary
// needs a source that actually exists, and the only one left is the model.
//
// The carrier is a fenced block in the reply:
//
//     ```widget:checks
//     [{"cmd": "pytest -q", "ok": true}, {"cmd": "tsc", "ok": false}]
//     ```
//
// Chosen over a wire field because it needs NO backend: the fence is already in
// the assistant text, already stored, already streamed, and already parsed —
// `Markdown`'s `pre` handler reads the language tag today. An older client, the
// Telegram bot, and a shared transcript all keep showing a JSON code block,
// which is a readable fallback rather than a hole.
//
// Mirrors bridge/miniapp/web/src/lib/widgetblock.ts. Keep them in sync.

/** `widget:checks` / `widget-checks` -> `checks`; anything else -> null.
 *  Both spellings because remark hands the tag through verbatim and a colon is
 *  the natural way to write it, while a hyphen is what most highlighters accept. */
export function widgetLang(lang: string): string | null {
  const m = /^widget[:-]([a-z]+)$/i.exec(lang.trim());
  return m ? m[1].toLowerCase() : null;
}

/** A fence body parsed as JSON, or null when it isn't.
 *  Null is not an error path — it means "draw the code block you would have
 *  drawn anyway". A half-typed block streaming in is invalid JSON for most of
 *  its life, and must never cost the user the text they are watching arrive. */
export function widgetValue(body: string): unknown {
  const text = body.trim();
  if (!text) return null;
  // Cheap reject before handing a large paste to the parser: every shape a
  // widget takes is an array or an object.
  const head = text[0];
  if (head !== "[" && head !== "{") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
