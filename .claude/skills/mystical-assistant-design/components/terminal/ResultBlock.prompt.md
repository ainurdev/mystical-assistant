**ResultBlock** — the framed `RESULT // OK` block that closes a run in the terminal: a tracked header bar over result text, with an optional `elapsed · cost` footer. Tone it `danger` for a failed run.

```jsx
<ResultBlock elapsed={2.4} cost={0.0031} flash>
  Build succeeded — 0 errors, 2 warnings.
</ResultBlock>

<ResultBlock title="RESULT // ERR" tone="danger">
  TypeError: cannot read properties of undefined
</ResultBlock>
```

Props: `title`, `tone` (success · accent · danger), `elapsed`, `cost`, `flash`. Precede it with `ToolTag` rows; render Markdown inside if your stream supports it.
