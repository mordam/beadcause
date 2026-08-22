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
// that a link you followed lands where it says it does.
//
// Duplicate headings are still fine — "Checking it" is how nine different sections end,
// and nothing needs those to be unique. What is *not* fine is linking to one, because
// GitHub resolves an ambiguous slug by document order, and that is the last check here
// (bc-gop1). Two links were in exactly that position when this file was written: both
// happened to land on the heading they meant, because the intended heading was the first
// occurrence in both cases, and neither was stable — inserting a section with the same
// subheading *earlier* in the file would have silently redirected the link, with nothing
// to see. The link still renders. It just scrolls somewhere else. The fix was to retitle
// the later duplicates ("What a chat session costs you to know", "What the terminal costs
// you to know", "Whose answer a Slack press is"), so a link that reads as unambiguous is
// unambiguous. This check is what stops the next one being written.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { slug } from '../lib/readme.js';

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

console.log('README cross-links\n');

const md = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

// Fenced code blocks hold sketches and shell snippets, and a `#comment` in one is not a
// link. Blanked rather than dropped so the line numbers below still mean something.
const prose = md.replace(/^```[\s\S]*?^```/gm, (block) => block.replace(/[^\n]/g, ' '));

const headings = new Map();
// Every line a slug is produced on, not just the last: `headings` collapses duplicates by
// definition, which is the thing the ambiguity check below has to see.
const slugLines = new Map();
for (const m of prose.matchAll(/^#{1,6} +(.+)$/gm)) {
  const s = slug(m[1]);
  headings.set(s, m[1].trim());
  if (!slugLines.has(s)) slugLines.set(s, []);
  slugLines.get(s).push(prose.slice(0, m.index).split('\n').length);
}

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

check('no link points at a slug more than one heading produces', () => {
  const ambiguous = [];
  for (const m of prose.matchAll(/\]\(#([^)\s]+)\)/g)) {
    const lines = slugLines.get(m[1]);
    if (!lines || lines.length < 2) continue;
    ambiguous.push(`README.md:${lineOf(m.index)}  #${m[1]}  → headings at ${lines.join(', ')}`);
  }
  assert.deepEqual(
    ambiguous,
    [],
    `${ambiguous.length} link(s) point at a slug more than one heading produces — GitHub picks the\n` +
      'first by document order, so the link works until somebody inserts a section above it. Retitle\n' +
      'the duplicate that is *not* being linked to, rather than the one that is:\n' +
      ambiguous.join('\n')
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
