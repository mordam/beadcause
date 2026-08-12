#!/usr/bin/env node
//
// The service worker's cache version agrees with the notes in docs/sw-cache/.
//
//   npm test
//   node test/swcache.mjs
//
// bc-5ghk: `const CACHE = 'beadcause-vNN'` in public/sw.js used to carry the argument for
// every bump as a comment block above it, and every branch that bumped appended to those
// same lines. With around eight worker sessions live against this repo at once, two of
// them routinely wrote that region in the same hour and GitHub refused both — the whole
// conflict being where the prose sat. The notes are one file each now, so adding a
// version is adding a file, and two branches adding different files never conflict.
//
// What that leaves is a single shared line, and its failure mode is the quiet one: two
// branches that pick the *same* number write the `const` the identical string, git merges
// it clean without a word, and the tree that comes out has two changes under one cache
// key — a cache that will never invalidate, on every installed phone, until somebody
// bumps it again for an unrelated reason. Nothing on screen says so. The `vNN.md` naming
// is the first half of the answer (same number, same path, add/add conflict git *must*
// report), and this file is the second: the number in the `const` has to be the highest
// note in the directory, so a bump that lost its renumber in a merge is a red suite
// rather than a silence.
//
// Deliberately says nothing about *whether* a given change owed a bump. That is the
// other half of the same subject and it has its own suite — test/swbump.mjs, over
// lib/swbump.js, which reads the branch's diff and asks whether it leaves a broken mixed
// pair. This file is downstream of that decision: once you have decided to bump, it
// checks the number and the notes tell one story.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const NOTES = path.join(ROOT, 'docs', 'sw-cache');

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

console.log("the service worker's cache version\n");

const sw = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const entries = fs.readdirSync(NOTES).sort();
const notes = entries.filter((f) => /^v\d+\.md$/.test(f));
const numbers = notes.map((f) => Number(f.slice(1, -3))).sort((a, b) => a - b);

/** The one line ten other suites also read, written the one way they all match. */
const declared = () => {
  const all = [...sw.matchAll(/^const CACHE = 'beadcause-v(\d+)';$/gm)];
  assert.equal(all.length, 1, `public/sw.js declares the cache version ${all.length} times, not once`);
  return Number(all[0][1]);
};

check('the version is declared once, as a plain number', () => {
  assert.ok(declared() > 0);
});

check('every note is named vNN.md, with nothing else in the directory', () => {
  // No slug in the name, on purpose: two branches that both pick v39 have to land on one
  // path so git reports the collision. `v39-chat-tabs.md` beside `v39-history.md` is two
  // files that merge without a murmur under one cache key.
  const strays = entries.filter((f) => f !== 'README.md' && !/^v\d+\.md$/.test(f));
  assert.deepEqual(strays, [], `not a version note and not the directory's own README: ${strays.join(', ')}`);
  assert.ok(notes.length > 1, `only ${notes.length} note(s) found — the read is wrong, not the directory`);
});

check('the notes are numbered without a gap or a repeat', () => {
  const missing = [];
  for (let n = numbers[0]; n < numbers[numbers.length - 1]; n++) {
    if (!numbers.includes(n)) missing.push(`v${n}`);
  }
  assert.deepEqual(missing, [], `no note for ${missing.join(', ')} — a renumber that skipped, most likely`);
  assert.equal(new Set(numbers).size, numbers.length, 'the same number twice');
});

check('the const is the highest note there is', () => {
  const highest = numbers[numbers.length - 1];
  assert.equal(
    declared(),
    highest,
    `public/sw.js says v${declared()} and the newest note is v${highest} — if this is a merge, git took ` +
      "the other branch's const silently: renumber your note to the next free number and set the const by hand"
  );
});

check('each note says its own number in its first line', () => {
  // The rename half of a conflict resolution is `git mv v39.md v40.md`, and the heading
  // is the thing that gets left behind by it. A note headed v39 in a file called v40.md
  // is a version whose argument is about the wrong pair of files.
  const wrong = [];
  for (const f of notes) {
    const first = fs.readFileSync(path.join(NOTES, f), 'utf8').split('\n')[0];
    const m = first.match(/^# v(\d+) — \S/);
    if (!m) wrong.push(`${f}: first line is not "# vNN — what changed"`);
    else if (Number(m[1]) !== Number(f.slice(1, -3))) wrong.push(`${f}: headed v${m[1]}`);
  }
  assert.deepEqual(wrong, [], wrong.join('\n'));
});

check('every note argues for itself rather than only naming the change', () => {
  // The number alone is unauditable a month later; what the notes are for is which two
  // files must not be mixed. A one-line note is a bump nobody can check.
  const thin = notes.filter((f) => fs.readFileSync(path.join(NOTES, f), 'utf8').split('\n').slice(2).join(' ').trim().length < 200);
  assert.deepEqual(thin, [], `too short to be an argument: ${thin.join(', ')}`);
});

check('the version blocks have not crept back into sw.js', () => {
  // The whole point is that the conflict-prone region is gone. A `/* v39: … */` above the
  // const is that region growing back, one branch at a time.
  const blocks = [...sw.matchAll(/\/\*+\s*v\d+:/g)].map((m) => m[0].trim());
  assert.deepEqual(blocks, [], `a per-version comment block is back in public/sw.js: ${blocks.join(', ')} — see docs/sw-cache/`);
});

check('sw.js sends a reader to the notes, and the README explains them', () => {
  assert.ok(/docs\/sw-cache\//.test(sw), 'nothing in public/sw.js points at docs/sw-cache/');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.ok(/docs\/sw-cache\//.test(readme), 'the README does not mention docs/sw-cache/ — it is the spec, so it has to');
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
