# og — the social card

`og.html` is the source for `public/og.png` (1200×630), the image the `og:image`
and `twitter:image` tags point at. It restates the hero in a fixed 1200×630 frame
and reuses the page's palette and both webfonts, so the card and the page match.

It is a screenshot, not a checked-in design. To re-render after changing the
hero copy:

```bash
cd site/tools/og
python3 -m http.server 8932 &
chrome --headless --hide-scrollbars --window-size=1200,630 \
  --virtual-time-budget=8000 --screenshot=../../public/og.png \
  'http://127.0.0.1:8932/og.html'
```

Any headless Chrome works; the fonts load from Google Fonts, so the render needs
network. `mystical.svg` is duplicated here rather than referenced out of
`public/` so the page renders standalone when served from this directory.
