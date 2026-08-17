**SurfaceBadge** — the color-coded "where this session lives" chip: VS (teal), WEB (green), TG (blue), MA (violet), CLI (grey). Put it on session rows, the terminal header, history items — anywhere a run's origin matters. Accepts an origin key or a two-letter code.

```jsx
<SurfaceBadge surface="vscode" />     {/* VS  */}
<SurfaceBadge surface="bot" />        {/* TG  */}
<SurfaceBadge surface="MA" full />    {/* Mini App */}
```

Props: `surface` (origin key or code), `full`. This is the dedicated origin chip; for generic metadata use `Chip`.
