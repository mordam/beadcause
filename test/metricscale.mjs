#!/usr/bin/env node
//
// Are the corner radii, the font weights and the type sizes still a scale, or a habit again?
//
//   npm test
//   node test/metricscale.mjs
//
// bc-03pz measured what the 77 design cards actually render and found the two halves of
// this system in very different health. The colours were disciplined — 12 distinct text
// colours, every one of them a token, nothing drifted. The metrics had smeared: 23
// distinct corner radii, 16 font weights, each new value a reasonable local call at the
// time and the set as a whole no longer a system anybody could hold in their head.
//
// The difference between the two halves is not care. It is that **the palette was
// checkable and the metrics were not** — a colour off the palette is a literal hex in a
// sheet where every other colour says `var(--…)`, and it stands out in review. `9px` in
// a sheet that also says `10px` and `11px` and `12px` does not stand out at all. So this
// suite is the thing the palette had and the metrics did not.
//
// ## The scales
//
// **Radius: 6 / 10 / 14 / 18, four apart, plus 999px and 50%.** Four apart is the point
// rather than an aesthetic: `scripts/design/vocabulary.mjs` treats two radii within 2px
// of each other as a smear, so a scale whose own steps are 2px apart would be one. 6px
// is inline furniture, 10px a control inside a card, 14px (`--radius`) the card, 18px a
// sheet against the bottom edge.
//
// **A thin bar is 999px, not a small radius.** Every sub-4px value in the sheet was a
// fully-rounded end drawn as a corner — a 2px progress line at 1px, a 4px sheet grip at
// 2px, a 3px scroll rail at 3px. The browser clamps a radius to half the box's smallest
// side, so all of them already computed to exactly what 999px gives; saying 999px is
// what they mean and costs nothing.
//
// **Weight: 400 / 550 / 600 / 650 / 700.** The first four are the ones bc-03pz measured
// as carrying the app (704, 100, 259 and 118 rendered elements); 700 is the fifth and it
// is real. The other eleven — 420, 450, 500, 520, 540, 560, 570, 590, 620, 630, 640, 660,
// 680, 800 — were a handful of uses each.
//
// **Type: 9 / 11 / 13 / 16 / 19 / 24.** This one had to be *asked* rather than decided,
// which is why it arrived a fortnight after the other two. A radius cannot move a box and
// a weight barely can — the whole of bc-03pz's snap moved seven text runs by 1–3px and not
// one box height — where a font-size moves layout on a 360px phone, so this was a design
// decision rather than a normalization. bc-ka5y.22 measured all four candidate scales
// against the real sheet before Adam picked this one: apply each candidate, re-render all
// 77 cards, and diff the computed-style fingerprint. It keeps 11, 13, 16 and 24 exactly
// where they already were, and no declaration moved more than 2px.
//
// **The rounding rule is part of the scale, and it mattered more than the scale did.**
// Three sizes were equidistant from two steps — 10px (×9 declarations), 12px (×71) and
// 14.5px (×18) — and they round **down**, to 9, 11 and 13. Measured, that is 6 boxes
// taller and 27 shorter; rounding the same 98 declarations up instead gives 29 taller and
// 7 shorter, with one card growing 83px. So a later addition at 12px is not a near-miss to
// be waved through: it is 11px or it is 13px, and the sheet has already decided which.
//
// **What this cannot reach**, and it is deliberate rather than a gap: `code` at 0.94em and
// one 0.78em track their parent and no px scale can snap them, so they are in `SIZE_FREE`
// the way `0`/`inherit` are free of the radius scale. The browser's own 13.3333px for
// `small` and a bare `input` has no declaration to hold to anything.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The app's two stylesheet surfaces: the sheet, and flow.js's embedded one. */
const SHEETS = ['public/style.css', 'public/flow.js'];

const RADII = ['6px', '10px', '14px', '18px', '999px', '50%'];
const WEIGHTS = ['400', '550', '600', '650', '700'];
const SIZES = ['9px', '11px', '13px', '16px', '19px', '24px'];

/** Values that are not a step and never were: no corner at all, or one inherited. */
const RADIUS_FREE = new Set(['0', '0px', 'inherit', 'var(--radius)']);

/** Sizes relative to their parent, which a px scale cannot express — see the header. */
const SIZE_FREE = new Set(['0.94em', '0.78em', 'inherit', '100%']);

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

/**
 * Comments and quoted strings blanked, newlines kept — the same move test/css.mjs makes
 * and for the same reason. `.ds-note` prose in a template literal talks about "11px
 * corner", and a suite that reads its own documentation as a violation is worse than no
 * suite: the fix for it is to stop writing the documentation.
 */
const blank = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (m) => m.replace(/[^\n]/g, ' '));

/** Every `prop: value` in the app's stylesheets, with where it is. */
function declarations(prop) {
  const out = [];
  for (const file of SHEETS) {
    const src = blank(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    src.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(new RegExp(`${prop}\\s*:\\s*([^;}\\n]+)`, 'g'))) {
        out.push({ where: `${file}:${i + 1}`, value: m[1].trim() });
      }
    });
  }
  return out;
}

const num = (v) => (/^-?[\d.]+px$/.test(v) ? parseFloat(v) : null);

{
  // `border-radius` takes up to four lengths — a speech bubble's tail corner, a pill
  // sliced down one side. Each part is held to the scale on its own, which is what
  // catches `12px 12px 4px 12px` where a whole-value check would not.
  const decls = declarations('border-radius');
  const offenders = [];
  for (const d of decls) {
    for (const part of d.value.split(/\s+/)) {
      if (RADIUS_FREE.has(part) || RADII.includes(part)) continue;
      offenders.push(`${d.where}  ${d.value}  (${part})`);
    }
  }
  check(
    `every corner radius is one of ${RADII.join(' / ')}`,
    offenders.length === 0,
    offenders.slice(0, 12).join('\n      ')
  );
  check('the sheet still has radii to check', decls.length > 100, `${decls.length} declarations`);

  // The property that makes it a scale rather than a shorter list.
  const steps = RADII.map(num).filter((n) => n !== null && n < 100).sort((a, b) => a - b);
  const tight = steps.slice(1).map((s, i) => [steps[i], s]).filter(([a, b]) => b - a <= 2);
  check(
    'no two radius steps are within 2px of each other — the threshold vocabulary.mjs calls a smear',
    tight.length === 0,
    JSON.stringify(tight)
  );
}

{
  const decls = declarations('font-weight');
  const offenders = decls.filter((d) => !WEIGHTS.includes(d.value) && !/^var\(/.test(d.value));
  check(
    `every font-weight is one of ${WEIGHTS.join(' / ')}`,
    offenders.length === 0,
    offenders.slice(0, 12).map((d) => `${d.where}  ${d.value}`).join('\n      ')
  );
  check('the sheet still has weights to check', decls.length > 100, `${decls.length} declarations`);

  // The `font:` shorthand carries a weight too, and it is the one place a stray value
  // hides from the longhand check above.
  const shorthand = [];
  for (const file of SHEETS) {
    const src = blank(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    src.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/font\s*:\s*(\d{3})\b/g)) {
        if (!WEIGHTS.includes(m[1])) shorthand.push(`${file}:${i + 1}  font: ${m[1]}`);
      }
    });
  }
  check('and the `font:` shorthand is on the scale too', shorthand.length === 0, shorthand.join('\n      '));
}

{
  // Type is the third axis and the one that had to be asked about rather than decided:
  // bc-ka5y.22 measured all four candidate scales against the real sheet before Adam
  // picked this one, because a font-size moves layout where a radius cannot.
  const decls = declarations('font-size');
  const offenders = decls.filter(
    (d) => !SIZES.includes(d.value) && !SIZE_FREE.has(d.value) && !/^var\(/.test(d.value)
  );
  check(
    `every font-size is one of ${SIZES.join(' / ')}`,
    offenders.length === 0,
    offenders.slice(0, 12).map((d) => `${d.where}  ${d.value}`).join('\n      ')
  );
  check('the sheet still has sizes to check', decls.length > 400, `${decls.length} declarations`);

  // Same property the radius steps are held to, and for the same reason: vocabulary.mjs
  // calls two sizes within 1px of each other a smear, so a scale whose own steps were
  // 1px apart would be reported as one by the very script that argued for it.
  const steps = SIZES.map(num).sort((a, b) => a - b);
  const tight = steps.slice(1).map((s, i) => [steps[i], s]).filter(([a, b]) => b - a <= 1);
  check(
    'no two type steps are within 1px of each other — the threshold vocabulary.mjs calls a smear',
    tight.length === 0,
    JSON.stringify(tight)
  );

  // The `font:` shorthand carries a size as well as a weight. One rule uses it (the body
  // font at 16px); the check is here so a second one cannot arrive off the scale.
  const shorthand = [];
  for (const file of SHEETS) {
    const src = blank(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    src.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/font\s*:\s*(?:\d{3}\s+)?(\d+(?:\.\d+)?px)\b/g)) {
        if (!SIZES.includes(m[1])) shorthand.push(`${file}:${i + 1}  font: … ${m[1]}`);
      }
    });
  }
  check('and the size in a `font:` shorthand is on the scale too', shorthand.length === 0, shorthand.join('\n      '));
}

{
  // The blanking is load-bearing — without it this suite reads manifest.mjs-style prose
  // and its own header as violations. Prove it still works rather than assuming it.
  const src = blank('a { /* border-radius: 7px; */ color: red; }\nb { content: "border-radius: 9px"; }');
  check('comments and strings are blanked before matching', !/border-radius:\s*[79]px/.test(src), src);
}

console.log(failures ? `\n${failures} failed` : '\nall good');
process.exit(failures ? 1 : 0);
