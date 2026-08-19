// Render every card in real Chrome, in both themes, and check what came out.
//
// check.mjs reads the built files; audit.mjs reads the sheet. Neither has ever seen a
// card *render*, which is the one claim a design system actually makes. This drives the
// repo's own headless-Chrome harness — the same one scripts/topbar-check.mjs uses — over
// design-bundle/, screenshots each card light and dark, and probes the computed styles.
//
// The screenshots are for a person. The probes are the gate, because a screenshot of a
// completely unstyled page looks fine to a script and wrong only to an eye that happens
// to be looking. Three things it can prove without one:
//
//   1. the token block reached the page      — body's background IS the --bg of that theme
//   2. the two themes are really two         — the paint differs, byte for byte
//   3. the component's own rules fired       — targeted computed-style probes, per class
//
// Run: node scripts/design/shots.mjs [pathFragment]
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { serveBundle, openPage, cardList } from './harness.mjs';

const OUT = 'design-shots';
const PORT = 4578;

// The two grounds, from :root and the prefers-color-scheme override in public/style.css.
const THEMES = {
  dark: { bg: 'rgb(11, 15, 20)', surface: 'rgb(20, 26, 34)', accent: 'rgb(94, 234, 212)' },
  light: { bg: 'rgb(246, 247, 249)', surface: 'rgb(255, 255, 255)', accent: 'rgb(15, 118, 110)' },
};

/**
 * What a class must look like once the sheet has had its say.
 *
 * Only asserted when the selector is actually on the card, so one table covers all 77
 * without any per-card wiring. Each is a rule that would visibly break the component if
 * it went missing — not a restatement of the stylesheet for its own sake.
 */
// Selectors are narrowed to exactly the variant being asserted. The naive versions all
// misfired on the first run and every one of them was the probe's fault, not the card's:
// `.pill` matched `.pill.id` first (a bead id is deliberately not uppercased), `.card`
// matched `.card.open` (which squares its corners on purpose, being full-screen), and
// `.primary` matched `.primary.danger` (which is red on purpose).
const PROBES = [
  ['.card:not(.open)', 'borderRadius', (v) => v === '14px', 'the --radius corner'],
  ['.card:not(.open)', 'backgroundColor', (v, t) => v === THEMES[t].surface, 'sits on --surface'],
  ['.card.open', 'position', (v) => v === 'fixed', 'the full-screen layer'],
  ['.card.open', 'borderRadius', (v) => v === '0px', 'square, because it is the screen'],
  // Both of these were `sticky` / `fixed` until bc-khoe.1: every page is a
  // viewport-height shell now and the chrome is two rows of the flex column, so what
  // proves they are still chrome is that neither of them stretches.
  ['.topbar', 'flex', (v) => v.startsWith('0 0'), 'a row of the shell, not a stretcher'],
  ['.viewbar', 'flex', (v) => v.startsWith('0 0'), 'the second row of the shell'],
  ['.viewpill', 'borderRadius', (v) => v === '999px', 'a pill'],
  // `.filter-typeahead *` is excluded for the same reason `.id` is, and the sheet says so
  // in as many words: "The base .pill is an uppercase metadata badge; a bead id is
  // neither." Those pills are monospaced ids, so they opt out too.
  ['.pill:not(.id):not(.filter-typeahead *)', 'textTransform', (v) => v === 'uppercase', 'an uppercase badge'],
  ['.pill.id', 'textTransform', (v) => v === 'none', 'a bead id is not a badge'],
  ['.filter-typeahead .pill', 'textTransform', (v) => v === 'none', 'a picked id, not a badge'],
  ['.filter-typeahead .pill', 'fontFamily', (v) => /mono/i.test(v), 'monospaced, being an id'],
  ['.primary:not(.danger)', 'backgroundColor', (v, t) => v === THEMES[t].accent, 'filled with --accent'],
  ['.primary.danger', 'backgroundColor', (v, t) => v !== THEMES[t].accent, 'destructive, not accent'],
  ['.option.picked', 'backgroundColor', (v, t) => v === THEMES[t].accent, 'the picked option is filled'],
  ['.icon-btn', 'height', (v) => v === '40px', '40px tall'],
  ['.dot', 'borderRadius', (v) => v === '50%', 'a circle'],
  // A bare `.spark` is a static grey dot; it breathes only in the contexts that put it
  // beside something running. Asserting the bare one animates was wrong, and it is what
  // caught the tags card claiming the opposite in prose.
  ['.console-row .spark', 'animationName', (v) => v === 'breathe', 'breathing beside a live conversation'],
  ['.session-facts .spark', 'animationName', (v) => v === 'breathe', 'breathing beside a live session'],
  ['.md', 'color', (v, t) => v !== THEMES[t].bg, 'prose is not the page'],
];

// ---------------------------------------------------------------------------- drive

const only = process.argv[2];
const server = await serveBundle(PORT);
const page = await openPage('beadcause-designshots-');
const cards = await cardList(only);

rmSync(OUT, { recursive: true, force: true });

const evaluate = (expression) => page.evaluate(expression);

const probeSrc = (theme) => `(() => {
  const out = { probes: [], overflow: null, height: null, bodyBg: null };
  const cs = (el) => getComputedStyle(el);
  out.bodyBg = cs(document.body).backgroundColor;
  out.overflow = document.documentElement.scrollWidth > window.innerWidth + 1;
  out.height = document.body.scrollHeight;
  const table = ${JSON.stringify(PROBES.map(([sel, prop, , why]) => ({ sel, prop, why })))};
  for (const t of table) {
    const el = document.querySelector(t.sel);
    if (!el) continue;
    out.probes.push({ sel: t.sel, prop: t.prop, why: t.why, value: cs(el)[t.prop] });
  }
  return out;
})()`;

const results = [];
for (const card of cards) {
  const row = { path: card.path, group: card.group, problems: [], shots: {} };
  const w = card.viewport?.width || 440;
  const h = card.viewport?.height || 400;
  await page.size(w, h);

  const paint = {};
  for (const theme of ['dark', 'light']) {
    await page.theme(theme);
    page.drainErrors();
    await page.go(`http://127.0.0.1:${PORT}/${card.path}`);

    const probe = await evaluate(probeSrc(theme));

    if (probe.bodyBg !== THEMES[theme].bg) {
      row.problems.push(`${theme}: body is ${probe.bodyBg}, not --bg ${THEMES[theme].bg} — the token block did not reach the page`);
    }
    if (probe.overflow) row.problems.push(`${theme}: the page scrolls sideways at ${w}px`);
    if (probe.height < 24) row.problems.push(`${theme}: rendered ${probe.height}px tall — the card is collapsed`);
    for (const p of probe.probes) {
      const rule = PROBES.find((r) => r[0] === p.sel && r[1] === p.prop);
      if (rule && !rule[2](p.value, theme)) {
        row.problems.push(`${theme}: ${p.sel} ${p.prop} is ${p.value} — expected ${p.why}`);
      }
    }
    const logged = page.drainErrors();
    if (logged.length) row.problems.push(`${theme}: console — ${logged.slice(0, 2).join(' | ')}`);

    const shot = await page.s.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const file = join(OUT, card.path.replace(/\.html$/, `.${theme}.png`));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    row.shots[theme] = file;
    paint[theme] = shot.data;
  }

  // The two themes must actually be two. A card that hardcoded its colours, or lost the
  // prefers-color-scheme block in slicing, paints identically and passes everything else.
  if (paint.dark === paint.light) row.problems.push('dark and light paint identically — the theme override is not reaching this card');

  results.push(row);
  process.stdout.write(row.problems.length ? '✗' : '·');
}

page.close();
server.close();

writeFileSync(join(OUT, 'report.json'), JSON.stringify(results, null, 2));

const bad = results.filter((r) => r.problems.length);
console.log('\n');
for (const r of bad) {
  console.log(`✗ ${r.path}`);
  for (const p of r.problems) console.log(`    ${p}`);
}
console.log(`${results.length} cards rendered in both themes · ${results.length * 2} screenshots in ${OUT}/ · ${bad.length} with problems`);
process.exit(bad.length ? 1 : 0);
