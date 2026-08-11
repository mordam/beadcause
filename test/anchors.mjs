#!/usr/bin/env node
//
// Every `](#…)` link in the README points at a heading that exists — and the mirror has
// a section for them to point at.
//
//   npm test
//   node test/anchors.mjs
//
// bc-h3t7: the README is this project's spec, ~250 headings of it, and it cross-links
// itself constantly — which is the only thing that makes a document that long navigable.
// Nothing checked those links. A broken one is silent in the worst way: GitHub renders it
// as an ordinary link, clicking it scrolls nowhere, and the reader concludes the section
// it promised does not exist. Three were already broken when this file was written, two of
// them because a heading had been *retitled* — `## Pull requests — merged, pushed,
// deployed` gained "review" and "live", and every link to it died without anything moving.
// That is the failure this catches, and it is the common one: a heading is edited in one
// place and the links to it are somewhere else entirely.
//
// The slug rules are GitHub's, and the trap is the em dash: it is punctuation, so it is
// *dropped* rather than replaced, and the spaces on either side of it both become hyphens.
// `## A second instance — observer mode` is `#a-second-instance--observer-mode`, with two.
//
// Deliberately only the anchors: this says nothing about whether the prose is right, only
// that a link you followed lands where it says it does. It does not police *duplicate*
// headings either — "Checking it" is how nine different sections end, and that is fine
// until something links to one, at which point GitHub decides by document order. Two links
// in here are already in that position and both happen to resolve correctly today; filed
// as its own bead rather than retitled from under this one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message.split('\n').join('\n      ')}`);
  }
}

/** GitHub's heading slug: lowercased, punctuation dropped, spaces to hyphens. */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\- ]+/g, '')
    .replace(/ /g, '-');
}

console.log('README cross-links\n');

const md = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

// Fenced code blocks hold sketches and shell snippets, and a `#comment` in one is not a
// link. Blanked rather than dropped so the line numbers below still mean something.
const prose = md.replace(/^```[\s\S]*?^```/gm, (block) => block.replace(/[^\n]/g, ' '));

const headings = new Map();
for (const m of prose.matchAll(/^#{1,6} +(.+)$/gm)) headings.set(slug(m[1]), m[1].trim());

const lineOf = (index) => prose.slice(0, index).split('\n').length;

check('the README has headings to link to', () => {
  assert.ok(headings.size > 100, `only ${headings.size} headings found — the parse is wrong, not the file`);
});

check('every in-page link resolves to a heading', () => {
  const broken = [];
  for (const m of prose.matchAll(/\]\(#([^)\s]+)\)/g)) {
    if (!headings.has(m[1])) broken.push(`README.md:${lineOf(m.index)}  #${m[1]}`);
  }
  assert.deepEqual(
    broken,
    [],
    `${broken.length} link(s) point at no heading — a retitled heading is the usual cause:\n` + broken.join('\n')
  );
});

check('the mirror is a section, and the tab-bar decision links to it', () => {
  // bc-h3t7: the mirror's prose lived only in the header of `public/mirror.js`, and the
  // one README subsection that mentioned it did so in order to argue about the tab bar.
  // A surface with a mechanism this size gets a section like every other surface does.
  // `## ` exactly: a `###` under the tab bar is what there was before, and is not this.
  const heading = [...prose.matchAll(/^## +(.+)$/gm)].map((m) => m[1].trim()).find((h) => /^The mirror\b/i.test(h));
  assert.ok(heading, 'no top-level section on the mirror — see bc-h3t7');
  const anchor = `#${slug(heading)}`;
  const decision = prose.slice(prose.indexOf('### The Mirror is a pane, not a tab'));
  const body = decision.slice(0, decision.indexOf('\n## '));
  assert.ok(
    body.includes(anchor),
    `"The Mirror is a pane, not a tab" does not link to ${anchor} — that subsection is the ` +
      'decision, not the description, and it should point at the description rather than restate it'
  );
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
