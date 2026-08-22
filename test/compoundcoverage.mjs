#!/usr/bin/env node
//
// Does the compound-coverage half of the design audit actually see what coverage.mjs
// cannot — a rule that needs two classes on the same element, where a card renders each
// class somewhere but never both together?
//
//   npm test
//   node test/compoundcoverage.mjs
//
// coverage.mjs decides coverage one class at a time, by flattening every card's markup
// into a single Set. That is exactly wrong for a selector like `.pr-stage.st-live`: both
// halves can be individually "covered" — one card draws `.pr-stage` on a span, another
// draws `.st-live` on a different one — while the rule that needs BOTH on one element
// fires nowhere in the whole bundle. `.pr-stage.st-live` sat under WCAG AA in the light
// scheme for as long as bc-15tu's five measured failures were filed, because the pills
// card drew `pill st-live` where prcard.js actually draws `pill pr-stage st-live`: the
// colour rule never matched, the card showed a grey pill, and contrast.mjs dutifully
// measured `--muted` and passed it. bc-15tu fixed the one card by hand; this bead
// (bc-ka5y.16) is the general form.
//
// Two halves below: synthetic fixtures pin the *logic* (co-occurrence, the colour flag,
// descendant selectors being out of scope, `extraClasses`/`bodyClass` not counting as a
// real combination), and the second half runs the real functions against the real sheet
// and the real manifest to pin `.pr-stage.st-live` itself as the worked example the bead
// asks for — so a regression that separates the two classes again fails here, not just
// in a browser-driven contrast run nothing gates on.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compounds, renderedClassSets, findCompounds } from '../scripts/design/compound-coverage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let ran = 0;
let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
};
const check = (name, cond, detail = '') => {
  ran += 1;
  return cond ? ok(name) : bad(name, detail);
};

console.log('the selector parser');

check(
  'two classes chained with no combinator is a compound',
  compounds('.pr-stage.st-live').length === 1 &&
    compounds('.pr-stage.st-live')[0].classes.join(',') === 'pr-stage,st-live'
);

check(
  'a descendant combinator is not a compound — that pair is not this bug\'s shape',
  compounds('.pr-stage .st-live').length === 0
);

check(
  'a single class is never a compound, whatever else is in the selector',
  compounds('.pill, .chip, div').length === 0
);

check(
  'a comma-separated list is split per part, each judged on its own',
  compounds('.a.b, .c.d').length === 2
);

check(
  'a comma inside :not() does not split the selector in two',
  compounds('.a.b:not(.c, .d)').length === 1
);

check(
  'a space inside an attribute selector does not split the compound',
  (() => {
    const c = compounds('.a.b[data-x="p q"]');
    return c.length === 1 && c[0].classes.length === 2;
  })()
);

check(
  'classes are deduped and order-independent, so .a.b and .b.a are the same requirement',
  compounds('.b.a')[0].classes.join('.') === compounds('.a.b')[0].classes.join('.')
);

console.log('\nco-occurrence and the colour flag, on a synthetic sheet');

const CSS = `
.pr-stage.st-live { color: red; }
.pr-stage.st-review { border-color: blue; }
.card.hist { opacity: 0.7; }
@media (prefers-color-scheme: dark) {
  .pr-stage.st-live { background: black; }
}
@keyframes spin { from { color: red; } to { color: blue; } }
`;

{
  const rendered = [new Set(['pill', 'pr-stage', 'st-live'])]; // one card draws both together
  const rows = findCompounds(CSS, rendered);
  const byKey = new Map(rows.map((r) => [r.classes.join('.'), r]));

  check('a rule whose classes co-occur on a rendered element is matched', byKey.get('pr-stage.st-live').matched);
  check(
    'a rule whose classes never co-occur is a gap, even though each half is covered separately',
    byKey.get('pr-stage.st-review').matched === false
  );
  check('a compound that sets a real property but no colour is not flagged', byKey.get('card.hist').color === false);
  check('a compound that sets color/background anywhere it appears is flagged', byKey.get('pr-stage.st-live').color === true);
  check('a rule nested in @media is still found', byKey.has('pr-stage.st-live'));
  check('@keyframes contributes no selectors at all', !rows.some((r) => r.selectors.has('from') || r.selectors.has('to')));
}

{
  // Each class= in the markup is its own set — two cards drawing the two halves
  // separately must not satisfy a rule that needs both on the SAME element.
  const rendered = [new Set(['pill', 'pr-stage']), new Set(['pill', 'st-live'])];
  const rows = findCompounds(CSS, rendered);
  const row = rows.find((r) => r.classes.join('.') === 'pr-stage.st-live');
  check(
    'covering each half on a different element is not covering the rule',
    row.matched === false
  );
}

console.log('\nrenderedClassSets excludes extraClasses/bodyClass — a manifest hint, not a drawn element');

{
  const groups = [{ cards: [
    { markup: '<div class="dot"></div>', extraClasses: ['busy'] },
    { markup: '<body></body>', bodyClass: 'console-body' },
  ] }];
  const sets = renderedClassSets(groups);
  check(
    'extraClasses is not folded into the markup element\'s own class set',
    !sets.some((s) => s.has('dot') && s.has('busy'))
  );
  check(
    'bodyClass is not asserted as co-occurring with anything either',
    sets.every((s) => !s.has('console-body'))
  );
}

console.log('\nthe worked example — the real sheet, the real manifest, bc-15tu\'s own case');

{
  const { GROUPS } = await import('../scripts/design/manifest.mjs');
  const css = read('public/style.css');
  const rendered = renderedClassSets(GROUPS);
  const rows = findCompounds(css, rendered);
  const byKey = new Map(rows.map((r) => [r.classes.join('.'), r]));

  check('.pr-stage.st-live is still a real compound rule in the sheet', byKey.has('pr-stage.st-live'));
  check(
    '.pr-stage.st-live is rendered together by a card, post bc-15tu — this is the fix this file pins',
    byKey.get('pr-stage.st-live')?.matched === true
  );
  check('.pr-stage.st-live sets a colour, which is why an uncovered gap here would matter', byKey.get('pr-stage.st-live')?.color === true);

  // The general finding: SOME compound rule in the real sheet is uncovered right now
  // (bc-ka5y.16 was filed because of this, and fixing every one of them is not this
  // bead's job) — pinned as a floor so this suite fails loudly the day the report
  // itself regresses to reporting nothing, which would look identical to a clean sheet.
  const gaps = rows.filter((r) => !r.matched);
  check('the report finds at least one real uncovered compound in the current sheet', gaps.length > 0, `${gaps.length} gaps`);
  check('and at least one of those sets a colour', gaps.some((r) => r.color));
}

console.log('\nwired up');

check('the script is where the acceptance criteria says a sibling to coverage.mjs would be', fs.existsSync(path.join(ROOT, 'scripts/design/compound-coverage.mjs')));
check(
  'it documents itself the way its neighbours do — a run line in the header comment',
  /node scripts\/design\/compound-coverage\.mjs/.test(read('scripts/design/compound-coverage.mjs'))
);

console.log(`\n${ran - failures}/${ran} ok`);
process.exit(failures ? 1 : 0);
