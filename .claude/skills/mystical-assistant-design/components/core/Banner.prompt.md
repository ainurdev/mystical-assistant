**Banner** — an inline status strip for errors and notices, square and toned. Drop it into the terminal/chat flow to surface a run error or a neutral note.

```jsx
<Banner tone="error">connection lost — retrying…</Banner>
<Banner tone="info">Stopped — send a message to continue.</Banner>
```

Props: `tone` (error · info). For a full bordered result block (`RESULT // OK`), use `ResultBlock` from the terminal group.
