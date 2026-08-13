#!/usr/bin/env node
/**
 * What is under what — and the three ways the obvious answer is wrong.
 *
 *     npm test
 *     node test/ancestry.mjs
 *
 * bc-rfnr.2. The inbox has to draw a list containing nothing that does not descend from
 * a P0 you own, and every cheap way to ask that question is wrong in a way that is
 * silent. This suite is the record of which ways:
 *
 * 1. **Not every edge is a parent edge.** `bd export` returns `blocks`,
 *    `discovered-from`, `supersedes` and `related` in the same `dependencies` array as
 *    `parent-child`. lib/filing.js puts a `discovered-from` on *everything* an agent has
 *    ever filed, so a walk that took any edge would quietly re-admit most of the backlog
 *    through the provenance trail — and it would look like the filter working.
 * 2. **Ids are not ancestry.** `bc-rfnr.1` is under `bc-rfnr` right up until somebody
 *    runs `bd update --parent`, which does not renumber. Both directions are asserted
 *    here: a dotted id that has been moved elsewhere, and a flat id that has been moved
 *    under something.
 * 3. **A cycle must not hang the daemon.** bd will not let you make one, but this map is
 *    assembled from an export another machine or an id-rewriting import may have written
 *    (the runbook in CLAUDE.md does exactly that), and the inbox is drawn on the request
 *    path. A wrong answer is recoverable; a phone that never paints is the failure this
 *    whole app exists to prevent.
 *
 * Pure: a string of JSONL in, a map out, no tracker and no daemon. `Bd.graph` is the
 * eight lines that spawn `bd export` and cache the result, and it has nothing in it worth
 * asserting that this does not assert better.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const { PARENT_EDGE, parentsFrom, indexFrom, ancestorsOf, underAnyOf, descendantsOf } = await import(
  LIB('ancestry.js')
);

/* --------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
const check = (name, fn) => {
  ran += 1;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
};

console.log('\nwhat is under what\n');

/** One `bd export` line. `deps` is `[childOf, ...]` shorthand plus anything explicit. */
const row = (id, extra = {}) =>
  JSON.stringify({ id, title: `bead ${id}`, status: 'open', priority: 2, labels: [], dependencies: [], ...extra });

const parentEdge = (child, parent) => ({ issue_id: child, depends_on_id: parent, type: PARENT_EDGE });
const otherEdge = (from, to, type) => ({ issue_id: from, depends_on_id: to, type });

/**
 * The tracker in miniature: one P0 with a child and a grandchild, one P0 with nothing,
 * a parentless bead, and a bead attached by every edge type that is not parenthood.
 */
const EXPORT = [
  row('zz-p0', { priority: 0, labels: ['owner:adam@example.com'] }),
  row('zz-p0.1', { dependencies: [parentEdge('zz-p0.1', 'zz-p0')] }),
  row('zz-p0.1.1', { dependencies: [parentEdge('zz-p0.1.1', 'zz-p0.1')] }),
  row('zz-lonely', { priority: 0, labels: ['owner:bob@example.com'] }),
  row('zz-orphan'),
  row('zz-blocked', { dependencies: [otherEdge('zz-blocked', 'zz-p0', 'blocks')] }),
  row('zz-found', { dependencies: [otherEdge('zz-found', 'zz-p0.1', 'discovered-from')] }),
  row('zz-dupe', { dependencies: [otherEdge('zz-dupe', 'zz-p0', 'supersedes')] }),
].join('\n');

const parents = parentsFrom(EXPORT);
const MINE = new Set(['zz-p0']);

/* ------------------------------------------------------------------ the parsing */

check('a parent-child edge is a parent, and nothing else is', () => {
  assert.equal(parents.get('zz-p0.1'), 'zz-p0');
  assert.equal(parents.get('zz-p0.1.1'), 'zz-p0.1');
  assert.equal(parents.size, 2, `only two beads have a parent here, got ${[...parents.keys()].join(', ')}`);
  for (const id of ['zz-blocked', 'zz-found', 'zz-dupe']) {
    assert.equal(parents.get(id), undefined, `${id} was pulled in by an edge that is not parenthood`);
  }
});

check('and the rows come back off the same pass, so the P0s cost no second command', () => {
  const { beads } = indexFrom(EXPORT);
  assert.equal(beads.size, 8);
  assert.deepEqual(beads.get('zz-p0').labels, ['owner:adam@example.com']);
  assert.equal(beads.get('zz-p0').priority, 0);
  assert.equal(beads.get('zz-orphan').priority, 2);
});

check('a malformed line loses that line and not the export', () => {
  const broken = `${row('zz-a')}\n{ not json at all\n${row('zz-b', { dependencies: [parentEdge('zz-b', 'zz-a')] })}`;
  const { parents: p, beads } = indexFrom(broken);
  assert.equal(p.get('zz-b'), 'zz-a');
  assert.equal(beads.size, 2, 'an inbox with no P0 section is a worse answer than one short row');
});

check('blank input is an empty map, not a throw', () => {
  assert.equal(parentsFrom('').size, 0);
  assert.equal(parentsFrom(null).size, 0);
  assert.equal(parentsFrom('\n\n  \n').size, 0);
});

/* ------------------------------------------------------------------ the walking */

check('ancestors come back nearest first, and a root has none', () => {
  assert.deepEqual(ancestorsOf(parents, 'zz-p0.1.1'), ['zz-p0.1', 'zz-p0']);
  assert.deepEqual(ancestorsOf(parents, 'zz-p0.1'), ['zz-p0']);
  assert.deepEqual(ancestorsOf(parents, 'zz-p0'), []);
  assert.deepEqual(ancestorsOf(parents, 'zz-nothing-like-this'), []);
});

check('a P0 is under itself, so one predicate serves the board and the gate', () => {
  assert.equal(underAnyOf(parents, 'zz-p0', MINE), true);
  assert.equal(underAnyOf(parents, 'zz-p0.1.1', MINE), true, 'at any depth');
  assert.equal(underAnyOf(parents, 'zz-lonely', MINE), false, 'somebody else’s P0 is not yours');
  assert.equal(underAnyOf(parents, 'zz-orphan', MINE), false);
});

check('NO EDGE BUT PARENTHOOD ADMITS A BEAD', () => {
  // The one that would look like the filter working. `discovered-from` is on every bead
  // lib/filing.js has ever created.
  assert.equal(underAnyOf(parents, 'zz-found', MINE), false);
  assert.equal(underAnyOf(parents, 'zz-blocked', MINE), false);
  assert.equal(underAnyOf(parents, 'zz-dupe', MINE), false);
});

check('an empty root set admits nothing, which is the caller’s cue not to filter', () => {
  assert.equal(underAnyOf(parents, 'zz-p0.1', new Set()), false);
  assert.equal(underAnyOf(parents, 'zz-p0.1', null), false);
  assert.equal(underAnyOf(parents, '', MINE), false);
});

/* ----------------------------------------------------- ids are not ancestry */

check('A DOTTED ID THAT WAS REPARENTED IS NOT UNDER THE EPIC ITS ID NAMES', () => {
  // `bd update --parent` does not renumber. Reading the id would put this card under
  // zz-p0 on the phone while the tracker says it belongs to somebody else's week.
  const moved = parentsFrom([row('zz-p0.9', { dependencies: [parentEdge('zz-p0.9', 'zz-lonely')] })].join('\n'));
  assert.deepEqual(ancestorsOf(moved, 'zz-p0.9'), ['zz-lonely']);
  assert.equal(underAnyOf(moved, 'zz-p0.9', MINE), false);
});

check('and a flat id that was reparented IS under the epic it was moved to', () => {
  // The same mistake in the other direction, and the more expensive one: this bead is
  // work under your P0 and an id-reading filter would hide it from the only list that
  // would have shown it to you.
  const adopted = parentsFrom([row('zz-flat', { dependencies: [parentEdge('zz-flat', 'zz-p0')] })].join('\n'));
  assert.equal(underAnyOf(adopted, 'zz-flat', MINE), true);
});

/* --------------------------------------------------------------- a cycle */

check('A CYCLE ANSWERS, RATHER THAN HANGING THE DAEMON', () => {
  const looped = parentsFrom(
    [
      row('zz-a', { dependencies: [parentEdge('zz-a', 'zz-b')] }),
      row('zz-b', { dependencies: [parentEdge('zz-b', 'zz-c')] }),
      row('zz-c', { dependencies: [parentEdge('zz-c', 'zz-a')] }),
    ].join('\n')
  );
  assert.deepEqual(ancestorsOf(looped, 'zz-a'), ['zz-b', 'zz-c']);
  assert.equal(underAnyOf(looped, 'zz-a', new Set(['zz-c'])), true);
  assert.equal(underAnyOf(looped, 'zz-a', new Set(['zz-elsewhere'])), false);
});

check('and a bead is never its own parent, however the export spells it', () => {
  const selfish = parentsFrom([row('zz-self', { dependencies: [parentEdge('zz-self', 'zz-self')] })].join('\n'));
  assert.equal(selfish.size, 0);
  assert.deepEqual(ancestorsOf(selfish, 'zz-self'), []);
});

/* ------------------------------------------------------------------ the set form */

check('descendantsOf is the same answer for a whole list, roots included', () => {
  const ids = ['zz-p0', 'zz-p0.1', 'zz-p0.1.1', 'zz-lonely', 'zz-orphan', 'zz-found'];
  assert.deepEqual([...descendantsOf(parents, ids, MINE)].sort(), ['zz-p0', 'zz-p0.1', 'zz-p0.1.1']);
  assert.equal(descendantsOf(parents, [], MINE).size, 0);
  assert.equal(descendantsOf(parents, ids, new Set()).size, 0);
});

/* ------------------------------------------------------------------------ done */

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
