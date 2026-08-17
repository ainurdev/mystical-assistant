**ToolTag** — a tool invocation in the terminal transcript. Bare, it's the bordered UPPERCASE tool label colored by family (Bash=teal, Read=violet, Write/Edit=green). With a `summary` it renders the full indented row `[TAG]  detail` exactly as the run stream shows.

```jsx
<ToolTag name="Bash" summary="npm run build" animate />
<ToolTag name="Read" summary="src/App.tsx" />
<ToolTag name="Write" summary="tokens/colors.css" />
<ToolTag name="Grep" />            {/* bare tag */}
```

Props: `name`, `summary`, `animate`. Follow it with a `ResultBlock` for the run's `RESULT // OK` output.
