// WCAG contrast, measured on the rendered page rather than argued from the hex values.
//
// The reason this has to run in a browser: almost nothing in public/style.css states a
// contrast pair outright. Colours arrive through `var(--muted)`, through
// `color-mix(in srgb, var(--accent) 60%, transparent)`, through an `rgba()` over a
// surface that is itself tinted — and the background a piece of text actually sits on is
// usually painted by an ancestor three levels up. Only the computed style knows, and only
// after the cascade has run in both schemes.
//
// What it checks, per WCAG 2.2 AA:
//
//   normal text   4.5:1     under 18.66px, or under 24px when not bold
//   large text    3.0:1     >= 24px, or >= 18.66px and bold
//
// Run: node scripts/design/contrast.mjs [pathFragment] [--all]
import { writeFileSync, mkdirSync } from 'node:fs';
import { serveBundle, openPage, cardList } from './harness.mjs';

const PORT = 4579;
const showAll = process.argv.includes('--all');
const filter = process.argv.slice(2).find((a) => !a.startsWith('--'));

/**
 * The measuring script, run inside the page.
 *
 * Three things it has to get right, and each one is a way the naive version lies:
 *
 * - **Alpha.** `color` is frequently `rgba(…, .72)` here — `color-mix(… , transparent)`
 *   computes to exactly that. Text at 72% alpha is not the contrast of its own colour;
 *   it has to be composited over what is behind it first, or every muted caption in the
 *   app reports a ratio it does not have.
 * - **The real background.** `backgroundColor` is `rgba(0, 0, 0, 0)` on most elements.
 *   The ground is whichever ancestor last painted, composited down the chain — a card on
 *   a page, a chip on a card, a pill on a chip.
 * - **What is actually text.** An element with no own text node contributes nothing; its
 *   children are measured on their own terms. Measuring containers double-counts and
 *   reports the same string many times under different classes.
 */
const MEASURE = `(() => {
  const parse = (c) => {
    const m = String(c).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(/[,\\s/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  };

  // The ground under an element: walk up compositing every painted layer, ending on the
  // page itself. Anything still translucent at the root sits on the canvas colour.
  const groundOf = (el) => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const bg = parse(getComputedStyle(n).backgroundColor);
      if (bg && bg.a > 0) layers.push(bg);
      if (bg && bg.a === 1) break;
    }
    const root = parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
    let out = layers.length && layers[layers.length - 1].a === 1 ? layers.pop() : { ...root, a: 1 };
    while (layers.length) out = over(layers.pop(), out);
    return out;
  };

  // The card frame is this bundle's own furniture rather than the app's — see build.mjs.
  // Two tests and not one, because the three \`ds-\` classes are not the same kind of thing.
  // \`.ds-stack\` and \`.ds-label\` wrap the app's markup, so only the wrapper itself is
  // furniture and its children are the component. \`.ds-note\` is the card's own prose, so
  // everything inside it is furniture too — and that half was missing: a note carrying an
  // anchor gave it no class, the sliced sheet carries no element rule for one, and the
  // UA's default blue on the page measured 2.05:1. A failing rule the app does not have
  // and cannot fix is worse than no audit, because it is the one you learn to scroll past.
  const furniture = (el) =>
    /(^|\\s)ds-/.test(typeof el.className === 'string' ? el.className : '') || !!el.closest('.ds-note');

  const ownText = (el) => Array.from(el.childNodes)
    .filter((n) => n.nodeType === 3 && n.textContent.trim())
    .map((n) => n.textContent.trim().replace(/\\s+/g, ' '))
    .join(' ');

  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (furniture(el)) continue;
    const text = ownText(el);
    if (!text) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) continue;

    const ground = groundOf(el);
    const fg = parse(cs.color);
    if (!fg) continue;
    const solid = fg.a < 1 ? over(fg, ground) : fg;

    const px = parseFloat(cs.fontSize);
    const weight = Number(cs.fontWeight) || 400;
    const large = px >= 24 || (px >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    const got = ratio(solid, ground);

    out.push({
      sel: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\\s+/).join('.') : ''),
      text: text.slice(0, 44),
      px: Math.round(px * 10) / 10,
      weight,
      large,
      color: cs.color,
      ground: 'rgb(' + [ground.r, ground.g, ground.b].map(Math.round).join(', ') + ')',
      ratio: Math.round(got * 100) / 100,
      need,
      pass: got >= need,
    });
  }
  return out;
})()`;

const server = await serveBundle(PORT);
const page = await openPage('beadcause-contrast-');
const cards = await cardList(filter);

const findings = [];
let measured = 0;

for (const card of cards) {
  await page.size(card.viewport?.width || 440, card.viewport?.height || 400);
  for (const theme of ['dark', 'light']) {
    await page.theme(theme);
    await page.go(`http://127.0.0.1:${PORT}/${card.path}`);
    const rows = await page.evaluate(MEASURE);
    measured += rows.length;
    for (const r of rows) {
      if (!r.pass || showAll) findings.push({ card: card.path, group: card.group, theme, ...r });
    }
  }
  process.stdout.write('·');
}

page.close();
server.close();

mkdirSync('design-shots', { recursive: true });
writeFileSync('design-shots/contrast.json', JSON.stringify(findings, null, 2));

const fails = findings.filter((f) => !f.pass);
console.log('\n');

// Grouped by the selector rather than by the card: one rule is wrong, and it is wrong
// everywhere it is drawn. Fifty rows saying `.subtitle` is thin is one finding.
const bySel = new Map();
for (const f of fails) {
  const k = `${f.sel} · ${f.theme}`;
  if (!bySel.has(k)) bySel.set(k, { ...f, count: 0, cards: new Set() });
  const e = bySel.get(k);
  e.count++;
  e.cards.add(f.card);
  if (f.ratio < e.ratio) e.ratio = f.ratio;
}

for (const [k, e] of [...bySel.entries()].sort((a, b) => a[1].ratio - b[1].ratio)) {
  console.log(
    `${String(e.ratio).padStart(5)}:1  need ${e.need}  ${k}\n` +
    `        ${e.color} on ${e.ground} · ${e.px}px/${e.weight} · ${e.cards.size} card(s) · e.g. "${e.text}"`
  );
}
console.log(
  `\n${cards.length} cards × 2 themes · ${measured} text runs measured · ` +
  `${fails.length} below AA in ${bySel.size} distinct rules`
);

// The exit code, so this is a gate rather than a report somebody has to read. It printed
// its findings and returned 0 until bc-15tu, which is how the rules it had already found
// sat in the sheet with the command that finds them documented in this directory's README:
// a check nothing can fail is a check nothing runs. `--all` is exempt — that mode is for
// reading the ratios of rules that pass, and it is not asking a question.
if (!showAll && fails.length) process.exitCode = 1;
