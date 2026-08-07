import { useEffect, useState } from "react";

// A small living glyph that drifts through mystical runes where the caret used to
// blink, plus a slowly-rotating quote that types itself in and dissolves out.
// Phosphor-accent, matches the emblem/CRT identity. Two flavours: "line" (idle
// prompt line) and "block" (empty session).
const RUNES = ["✦", "◈", "⟁", "☿", "⌖", "✧", "◇", "⬡", "❖"];
const QUOTES = [
  "the bridge is open — speak your change.",
  "channeling… describe a change, paste an error.",
  "every error is a door. show me yours.",
  "name the bug; i will unmake it.",
  "between commits, all things are possible.",
  "paste the stack trace — i read entrails.",
  "the runes are listening.",
  "what shall we conjure today?",
  "a clean diff is its own kind of spell.",
];

const TYPE_MS = 26; // per-character reveal
const QUOTE_HOLD = 5200; // visible once fully typed
const QUOTE_FADE = 460; // dissolve-out duration

function useQuote() {
  const [qi, setQi] = useState(0);
  const [typed, setTyped] = useState(0);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    setTyped(0);
    setLeaving(false);
    const full = QUOTES[qi].length;
    let hold: ReturnType<typeof setTimeout> | undefined;
    let out: ReturnType<typeof setTimeout> | undefined;
    let n = 0;
    const typer = setInterval(() => {
      n += 1;
      setTyped(n);
      if (n >= full) {
        clearInterval(typer);
        hold = setTimeout(() => {
          setLeaving(true); // play the dissolve, then advance
          out = setTimeout(() => {
            // Batch all three so the next render never flashes the new quote
            // pre-reset (old `typed` against the new text).
            setTyped(0);
            setLeaving(false);
            setQi((p) => (p + 1) % QUOTES.length);
          }, QUOTE_FADE);
        }, QUOTE_HOLD);
      }
    }, TYPE_MS);
    return () => {
      clearInterval(typer);
      clearTimeout(hold);
      clearTimeout(out);
    };
  }, [qi]);

  const text = QUOTES[qi];
  return { qi, shown: text.slice(0, typed), typing: typed < text.length, leaving };
}

function useRune() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((n) => n + 1), 1700);
    return () => clearInterval(id);
  }, []);
  return RUNES[i % RUNES.length];
}

function Quote({
  shown,
  typing,
  leaving,
  qi,
  className,
}: {
  shown: string;
  typing: boolean;
  leaving: boolean;
  qi: number;
  className: string;
}) {
  return (
    <span
      key={qi}
      className={className}
      style={leaving ? { animation: `quoteout ${QUOTE_FADE}ms ease forwards` } : undefined}
    >
      {shown}
      {typing && (
        <span
          className="ml-px inline-block bg-primary align-baseline"
          style={{ width: "0.5ch", height: "1em", animation: "caret 1.05s steps(1) infinite" }}
        />
      )}
    </span>
  );
}

export function RuneSpirit({ variant = "line" }: { variant?: "line" | "block" }) {
  const rune = useRune();
  const quote = useQuote();

  if (variant === "block") {
    return (
      <div className="flex items-start gap-3.5 py-7">
        <span
          className="glow inline-flex h-[34px] w-[34px] flex-none items-center justify-center text-[length:var(--t26)] leading-none text-primary"
          style={{ animation: "twinkle 1.7s ease-in-out infinite" }}
        >
          {rune}
        </span>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-[length:var(--t11)] tracking-[1.5px] text-muted-2">
            // no messages in this session yet
          </span>
          <Quote
            {...quote}
            className="text-[length:var(--t125)] italic leading-relaxed text-muted-foreground"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2.5 flex items-center gap-[10px] text-muted-foreground">
      <span className="flex-none text-violet">~ ❯</span>
      <span
        className="glow inline-flex h-[18px] w-[18px] flex-none items-center justify-center text-[length:var(--t15)] leading-none text-primary"
        style={{ animation: "twinkle 1.7s ease-in-out infinite" }}
      >
        {rune}
      </span>
      <Quote
        {...quote}
        className="min-w-0 truncate text-[length:var(--t115)] italic tracking-[0.3px] text-muted-2"
      />
    </div>
  );
}
