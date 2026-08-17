**PromptLine** — a terminal line led by the violet `~ ❯` glyph. Use `tone="user"` for the user's sent message in the transcript, and `caret` for the idle awaiting-input prompt. `tone="oracle"` switches to the dim italic oracle whisper for empty/idle states.

```jsx
<PromptLine>add a dark mode toggle to settings</PromptLine>
<PromptLine caret> </PromptLine>
<PromptLine tone="oracle">the runes are listening.</PromptLine>
```

Props: `prompt`, `caret`, `tone` (user · oracle). Keep oracle copy lowercase + italic; keep user copy verbatim.
