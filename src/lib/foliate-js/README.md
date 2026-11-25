# foliate-js (vendored)

E-book renderer used by the book player, from https://github.com/johnfactotum/foliate-js
at commit `78914ae` (MIT, see `LICENSE`). Upstream publishes no package and recommends
pinning a copy.

Only the modules needed for reflowable and fixed-layout EPUB, MOBI/AZW3, FB2 and CBZ are
included. Local changes:

- `view.js`: removed the PDF branch of `makeBook` (PDF has its own player, and `pdf.js`
  uses top-level await, which the ES5 build cannot emit).
- `paginator.js`: replaced a lookbehind regex with an equivalent capture group so the
  build passes `es-check`.
- `mobi.js`: BigInt literals (`0n`) replaced with `BigInt()` calls for the same reason.
- `view.js`: renderers are constructed with `new` instead of `document.createElement`,
  because the legacy `webcomponents.js` polyfill wraps `createElement` and leaves native
  custom elements un-upgraded.
- `paginator.js`: `animate` finishes on a timer if animation frames stop arriving (a
  backgrounded WebView), so a pending page turn cannot leave the paginator locked.
