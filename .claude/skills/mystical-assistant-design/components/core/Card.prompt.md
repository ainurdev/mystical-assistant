**Card** — a translucent dark surface (`--card`) for grouping content, square-cornered. The plain sibling of `Panel`: no corner brackets, no header. Use inside panels or for permission/question cards.

```jsx
<Card bordered>
  <div>Allow <b>Bash</b>?</div>
</Card>
```

Props: `bordered`, `padding`. For the framed instrument look with a header + corner brackets, use `Panel` instead.
