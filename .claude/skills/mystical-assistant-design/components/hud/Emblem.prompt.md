**Emblem** — the Mystical Assistant brand mark: a dashed phosphor ring, a diamond, and a violet core. The ring follows the active accent; the core stays violet. Use `variant="mark"` (default, optionally spinning) in chrome at ~22px, and `variant="boot"` large on boot / empty / hero screens.

```jsx
<Emblem size={22} />                       {/* header lockup */}
<Emblem size={150} variant="boot" />       {/* boot / fresh-session */}
<Emblem size={40} spin={false} />          {/* static */}
```

Props: `size`, `spin`, `core`, `variant` (mark · boot). Pair with the `MYSTICAL//ASSISTANT` wordmark (Share Tech Mono, 10px tracking) for the full lockup.
