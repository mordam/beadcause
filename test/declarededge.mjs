#!/usr/bin/env node
/**
 * A declared dependency outranks the see-also a prose mention drew — the rule, in fixtures.
 *
 *     npm test
 *     node test/declarededge.mjs
 *
 * bd holds **one row per ordered pair** and refuses a second type on it. lib/mentions.js
 * turns every bead id in prose into a `relates-to` as the prose is written, and the ids
 * in "this cannot start until bc-x lands" are bead ids in prose — so a proposal that
 * says *why* it depends on bc-x arrives already joined to bc-x, and the dependency it
 * actually declared is then refused for ever:
 *
 *     Error: dependency bc-a -> bc-b already exists with type "relates-to"
 *     (requested "blocks"); remove it first with 'bd dep remove' then re-add
 *
 * That is bc-arj0.20, and a description that explains its own dependency is the
 * description doing its job. So the collision is settled by precedence rather than by
 * ordering the writes: a `relates-to` came from a word appearing in a paragraph, a
 * `blocks` came from somebody deciding, and the decision wins. Ordering would have
 * hidden it — the prose sweep runs on its own afterwards (bc-arj0.10), so the collision
 * can arrive long after the bead was filed, on a pair nobody is writing.
 *
 * Four things are checked here and the last two are the ones that would go wrong quietly:
 *
 * 1. **What bd said**, parsed off its own sentence rather than guessed at — including
 *    through the `bd … failed in <ws>:` wrapper `Bd.run` puts in front of it.
 * 2. **What may be demoted**, which is a see-also under either of its two spellings and
 *    nothing else. `discovered-from` is the case that matters: provenance is an older
 *    fact than whatever wants the pair now, and lib/adoptsweep.js refuses on it for the
 *    same reason.
 * 3. **Both ends, when both ends are a mention.** `bd dep relate` writes two rows and bd
 *    refuses per *ordered* pair — measured, and it is the whole reason this file exists
 *    in the shape it does. Drop only the row bd named and the retry succeeds, so every
 *    test passes, and the pair is left holding a `blocks` one way and a `relates-to` the
 *    other: two rows saying different things, printed under two headings on the card.
 * 4. **That a clean write still costs one spawn.** The demotion hangs off a refusal, so
 *    the pair that has no edge — nearly every pair — must not pay a read for the pair
 *    that does.
 *
 * The `bd` here is a fake, and a *stateful* one: ordered edges in a JSON file, refusing
 * a second type on a pair exactly as the real binary was measured doing on 2026-08-17.
 * A fake that merely failed once and then succeeded would pass this file with the
 * one-row bug in place. test/declarededgereal.mjs asks the real binary the same
 * questions.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoteRows, refusedEdgeType } from '../lib/mentions.js';
import { Bd } from '../lib/bd.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
let ran = 0;
const check = (name, fn) => {
  ran += 1;
  const ok = () => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  const fail = (err) => {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${String(err.message).split('\n').slice(0, 4).join('\n      ')}`);
  };
  try {
    const out = fn();
    if (out instanceof Promise) return out.then(ok, fail);
    ok();
  } catch (err) {
    fail(err);
  }
};

/* ------------------------------------------------------------- what bd actually said */

console.log('\nreading the refusal');

check('the type bd names, out of its own sentence', () => {
  assert.equal(
    refusedEdgeType(
      `Error: dependency bc-a -> bc-b already exists with type "relates-to" (requested "blocks"); ` +
        `remove it first with 'bd dep remove' then re-add`
    ),
    'relates-to'
  );
});

check('through the wrapper Bd.run puts in front of it', () => {
  // Every error out of `Bd.run` reads `bd <argv> failed in <ws>: <what bd said>`, and
  // that is the string `addDep` has in its hand — not the bare line.
  assert.equal(
    refusedEdgeType(
      'bd dep add bc-a bc-b --actor beadcause failed in beadcause: Error: dependency bc-a -> bc-b ' +
        'already exists with type "discovered-from" (requested "blocks"); remove it first'
    ),
    'discovered-from'
  );
});

check('null for every error that is not this one', () => {
  // A Dolt lock, a bead that does not exist, a timeout. Returning a guess here would
  // hand `demoteRows` permission to delete an edge over an error nobody parsed.
  assert.equal(refusedEdgeType('bd dep add … failed in beadcause: Error: issue bc-nope not found'), null);
  assert.equal(refusedEdgeType('bd dep add … timed out in beadcause: still running after 2m'), null);
  assert.equal(refusedEdgeType(''), null);
  assert.equal(refusedEdgeType(null), null);
});

/* ------------------------------------------------------------------ what may be demoted */

console.log('\nwhat a declared edge is allowed to displace');

check('a see-also, and the pair bd named', () => {
  assert.deepEqual(demoteRows('bc-a', 'bc-b', { refused: 'relates-to' }), [['bc-a', 'bc-b']]);
});

check('both ends when both ends are a see-also, because a relate writes two rows', () => {
  // The bug this shape exists to stop: drop only `a -> b` and the retry goes in, so
  // nothing looks wrong — and the pair now holds `blocks` one way and `relates-to` the
  // other, which `bd show` prints under two headings on the card.
  assert.deepEqual(demoteRows('bc-a', 'bc-b', { refused: 'relates-to', reverse: 'relates-to' }), [
    ['bc-a', 'bc-b'],
    ['bc-b', 'bc-a'],
  ]);
});

check('bd’s older spelling counts as a see-also at either end', () => {
  assert.deepEqual(demoteRows('bc-a', 'bc-b', { refused: 'related', reverse: 'related' }), [
    ['bc-a', 'bc-b'],
    ['bc-b', 'bc-a'],
  ]);
});

check('provenance is never demoted — not the row refused, not the row behind it', () => {
  assert.equal(demoteRows('bc-a', 'bc-b', { refused: 'discovered-from' }), null);
  assert.equal(demoteRows('bc-a', 'bc-b', { refused: 'parent-child' }), null);
  assert.equal(demoteRows('bc-a', 'bc-b', { refused: 'blocks' }), null);
  assert.equal(demoteRows('bc-a', 'bc-b', { refused: null }), null);
  // …and a see-also one way with something older the other keeps the older row.
  assert.deepEqual(demoteRows('bc-a', 'bc-b', { refused: 'relates-to', reverse: 'discovered-from' }), [
    ['bc-a', 'bc-b'],
  ]);
});

check('an id that is not there is not a demotion', () => {
  assert.equal(demoteRows('', 'bc-b', { refused: 'relates-to' }), null);
  assert.equal(demoteRows('bc-a', null, { refused: 'relates-to' }), null);
});

check('ids come back the way the graph spells them', () => {
  assert.deepEqual(demoteRows('BC-A', 'BC-B', { refused: 'relates-to' }), [['bc-a', 'bc-b']]);
});

/* ------------------------------------------------------------------------ and the write */

console.log('\nand what Bd.addDep does with it');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-declarededge-'));
const WS = { name: 'beadcause', dir: tmp };
const LOG = path.join(tmp, 'argv.jsonl');
const STATE = path.join(tmp, 'edges.json');

/**
 * A `bd` with a memory of its own edges — ordered pairs, one type each, refusing a
 * second exactly as the binary was measured refusing one.
 *
 * The statefulness is the point. `dep remove` really removes, `dep list` really answers
 * off what is left, and the second `dep add` really succeeds only if the row in its way
 * is gone — so a demotion that removed the wrong row fails here rather than passing.
 */
const fakeBd = (name, edges) => {
  fs.writeFileSync(STATE, JSON.stringify(edges));
  fs.writeFileSync(LOG, '');
  const file = path.join(tmp, name);
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require('node:fs');
const STATE = ${JSON.stringify(STATE)};
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify(argv) + '\\n');
const edges = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const save = () => fs.writeFileSync(STATE, JSON.stringify(edges));
if (argv[0] === 'dep' && argv[1] === 'add') {
  const [from, to] = [argv[2], argv[3]];
  const have = edges[from + '>' + to];
  if (have) {
    process.stderr.write('Error: dependency ' + from + ' -> ' + to + ' already exists with type "' + have +
      '" (requested "blocks"); remove it first with \\'bd dep remove\\' then re-add\\n');
    process.exit(1);
  }
  edges[from + '>' + to] = 'blocks';
  save();
  process.exit(0);
}
if (argv[0] === 'dep' && argv[1] === 'remove') {
  delete edges[argv[2] + '>' + argv[3]];
  save();
  process.exit(0);
}
if (argv[0] === 'dep' && argv[1] === 'list') {
  const from = argv[2];
  const up = argv.includes('up');
  const rows = Object.entries(edges)
    .filter(([k]) => (up ? k.endsWith('>' + from) : k.startsWith(from + '>')))
    .map(([k, type]) => ({ id: up ? k.split('>')[0] : k.split('>')[1], dependency_type: type }));
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
process.exit(0);
`,
    { mode: 0o755 }
  );
  return new Bd({ bin: file, actor: 'beadcause' });
};

const calls = () =>
  fs
    .readFileSync(LOG, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l).filter((a) => a !== '--actor' && a !== 'beadcause'));
const edgesNow = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
const RELATED_BOTH = { 'bc-a>bc-b': 'relates-to', 'bc-b>bc-a': 'relates-to' };

await check('a pair with no edge costs one spawn and nothing else', async () => {
  // The cost argument. Nearly every pair is this one, and it must not pay a read for
  // the rare pair a mention got to first.
  const bd = fakeBd('bd-clean', {});
  await bd.addDep(WS, 'bc-a', 'bc-b');
  assert.deepEqual(calls(), [['dep', 'add', 'bc-a', 'bc-b']]);
  assert.deepEqual(edgesNow(), { 'bc-a>bc-b': 'blocks' });
});

await check('a see-also in the way is taken off both ends and the declared edge goes in', async () => {
  const bd = fakeBd('bd-collide', { ...RELATED_BOTH });
  await bd.addDep(WS, 'bc-a', 'bc-b');
  assert.deepEqual(edgesNow(), { 'bc-a>bc-b': 'blocks' }, 'the pair should hold exactly one edge');
});

await check('and it reads the other end before deleting it, rather than assuming', async () => {
  const bd = fakeBd('bd-collide-reads', { ...RELATED_BOTH });
  await bd.addDep(WS, 'bc-a', 'bc-b');
  const verbs = calls().map((a) => a.slice(0, 4).join(' '));
  assert.deepEqual(verbs, [
    'dep add bc-a bc-b',
    'dep list bc-b --json',
    'dep remove bc-a bc-b',
    'dep remove bc-b bc-a',
    'dep add bc-a bc-b',
  ]);
});

await check('an older edge behind the see-also is left exactly where it is', async () => {
  // The pair holds a mention one way and provenance the other. Only the mention is
  // this write's to take.
  const bd = fakeBd('bd-halfold', { 'bc-a>bc-b': 'relates-to', 'bc-b>bc-a': 'discovered-from' });
  await bd.addDep(WS, 'bc-a', 'bc-b');
  assert.deepEqual(edgesNow(), { 'bc-a>bc-b': 'blocks', 'bc-b>bc-a': 'discovered-from' });
});

await check('provenance in the way is a refusal, and nothing is deleted over it', async () => {
  const bd = fakeBd('bd-provenance', { 'bc-a>bc-b': 'discovered-from' });
  await assert.rejects(() => bd.addDep(WS, 'bc-a', 'bc-b'), /discovered-from/);
  assert.deepEqual(edgesNow(), { 'bc-a>bc-b': 'discovered-from' });
  assert.deepEqual(
    calls().map((a) => a.slice(0, 2).join(' ')),
    ['dep add'],
    'a refusal that stands must not cost a read either'
  );
});

await check('and a refusal is asked once, not five times over four seconds of backoff', async () => {
  // `LOCK_RE` in lib/bd.js is a substring match on `lock`, and bd's sentence ends
  // `(requested "blocks")` — so before `TERMINAL_RE` every refused edge looked exactly
  // like Dolt lock contention and a write with four retries spent five spawns and four
  // seconds proving what the first millisecond already knew. On `/api/console/create`
  // that is four seconds per declared dependency, with somebody holding a phone.
  const bd = fakeBd('bd-nobackoff', { 'bc-a>bc-b': 'parent-child' });
  const started = Date.now();
  await assert.rejects(() => bd.addDep(WS, 'bc-a', 'bc-b'));
  assert.equal(calls().length, 1, `asked ${calls().length} times`);
  assert.ok(Date.now() - started < 2000, 'it backed off');
});

await check('a failure that is not a collision is the failure it always was', async () => {
  // A bd that cannot be run at all: no sentence to parse, so no demotion, and the
  // caller gets the error rather than a quietly emptied pair.
  const bd = new Bd({ bin: path.join(tmp, 'no-such-bd'), actor: 'beadcause' });
  await assert.rejects(() => bd.addDep(WS, 'bc-a', 'bc-b'));
});

await check('one retry and no loop, when something else is writing the same pair', async () => {
  // The fake refuses `bc-a > bc-b` for ever: `dep remove` here deletes the row, so the
  // only way to stage a second refusal is a pair that keeps coming back. A retry loop
  // would spin against whatever is racing it instead of reporting.
  const file = path.join(tmp, 'bd-stubborn');
  fs.writeFileSync(LOG, '');
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify(argv) + '\\n');
if (argv[0] === 'dep' && argv[1] === 'add') {
  process.stderr.write('Error: dependency bc-a -> bc-b already exists with type "relates-to" (requested "blocks")\\n');
  process.exit(1);
}
if (argv[0] === 'dep' && argv[1] === 'list') { process.stdout.write('[]'); process.exit(0); }
process.exit(0);
`,
    { mode: 0o755 }
  );
  const bd = new Bd({ bin: file, actor: 'beadcause' });
  await assert.rejects(() => bd.addDep(WS, 'bc-a', 'bc-b'), /relates-to/);
  assert.equal(
    calls().filter((a) => a[0] === 'dep' && a[1] === 'add').length,
    2,
    'exactly two attempts — the write and one retry'
  );
});

/* --------------------------------------------------------------------- and the far end */

console.log('\nthe rule the other way round');

check('a prose mention still never draws over an edge somebody declared', () => {
  // The reverse must never happen, and it is held by a different mechanism: `planFor`
  // skips any pair the graph already joins, so there is no demotion to reason about at
  // all. Read off the source rather than re-tested — test/mentions.mjs owns that.
  const src = fs.readFileSync(path.join(HERE, '..', 'lib', 'mentions.js'), 'utf8');
  const fn = src.slice(src.indexOf('export function planFor'));
  assert.ok(/if \(already\.has\(mentioned\)\) continue;/.test(fn), 'planFor no longer skips a linked pair');
  assert.ok(!/dropDep|dep., .remove/.test(fn), 'planFor must not remove anything');
});

/* ---------------------------------------------------------------------------- verdict */

console.log('');
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${ran - failures}/${ran} passed\n`);
if (failures) process.exit(1);
