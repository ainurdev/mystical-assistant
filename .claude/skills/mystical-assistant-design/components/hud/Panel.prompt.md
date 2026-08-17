**Panel** — the framed instrument and the system's signature container: corner brackets (`.panel`), a `LABEL ··· TITLE` header, and a drawline divider that wipes in. Everything on the dashboard lives inside one. Stagger several with increasing `delay`.

```jsx
<Panel title="WORKSPACE" delay=".06s">
  <div style={{ padding: 14 }}>…readouts…</div>
</Panel>

<Panel label="PANEL" title="AGENT TELEMETRY" flex>
  …scrolling body…
</Panel>
```

Props: `label`, `title`, `delay`, `flex` (fill + scroll), `boot` (toggle entrance). Body is whatever children you pass — pad it ~14px. Use `Card` for an unframed surface.
