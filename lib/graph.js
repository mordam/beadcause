/**
 * Make `bd graph --html` fit inside beadcause.
 *
 * bd already emits a complete, interactive D3 dependency graph — nodes coloured
 * by status, drag, zoom, click-for-detail — so there is nothing to build here.
 * Two things stop that page working on a phone over a tailnet, and both are one
 * line of rewriting:
 *
 * 1. It loads D3 from `https://d3js.org`. The whole app has to work with no
 *    internet route (see scripts/vendor.js), so the tag is repointed at the
 *    vendored copy. If that copy is missing — a `git pull` without `npm install`
 *    — the CDN URL is left alone, because a graph that needs the internet beats
 *    a graph that is a blank screen.
 * 2. It has no viewport meta, so a phone lays it out at 980px and then shrinks
 *    it: legible on a desktop, a postage stamp in your hand. The SVG is sized in
 *    `vw`/`vh`, so declaring the real viewport is all it takes.
 * 3. Its stylesheet says `svg { width: 100vw; height: 100vh }`, which is meant for
 *    the canvas but also lands on the two 30x10 line swatches inside the legend —
 *    CSS beats the `width` attribute, so each swatch inflates to a full screen and
 *    the legend becomes a 1900px box with one stray word visible. That's bd's bug,
 *    not ours (it misdraws in a desktop browser too), but it's a one-line override
 *    and the alternative is shipping a graph with a wrecked legend.
 *
 * Kept as a pure string function, away from the server, so the day bd's HTML
 * changes shape you can see exactly what beadcause assumed about it.
 */

const D3_CDN_RE = /(<script[^>]+src=")https?:\/\/d3js\.org\/[^"]+(")/i;

const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">';

// `width: auto` on an <svg> carrying width/height attributes falls back to those
// attributes, so the swatches go back to being swatches and #graph keeps its rule.
const PATCH_CSS = '<style>svg:not(#graph) { width: auto; height: auto; }</style>';

export function localizeGraphHtml(html, { d3Url = null } = {}) {
  let out = String(html || '');
  if (d3Url) out = out.replace(D3_CDN_RE, `$1${d3Url}$2`);
  if (!/name=["']viewport["']/i.test(out)) {
    // After the charset meta when there is one — it has to stay inside the first
    // 1024 bytes of the document, and nothing should be pushed in front of it.
    out = /<meta[^>]+charset=/i.test(out)
      ? out.replace(/<meta[^>]+charset=[^>]*>/i, (m) => `${m}\n${VIEWPORT}`)
      : out.replace(/<head[^>]*>/i, (m) => `${m}\n${VIEWPORT}`);
  }
  // Last thing in the head, so it wins over bd's own block on equal specificity.
  out = /<\/head>/i.test(out) ? out.replace(/<\/head>/i, `${PATCH_CSS}\n</head>`) : out + PATCH_CSS;
  return out;
}
