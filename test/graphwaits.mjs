#!/usr/bin/env node
/**
 * "waits on N" on a graph node's card — the number, not the layout.
 *
 *     npm test
 *     node test/graphwaits.mjs
 *
 * The card used to print `bd list`'s `dependency_count` straight through, and that
 * number answers a different question than the phrase above it. It counts the edge to
 * a bead's **parent**, so every subtask in the graph claimed to be waiting on
 * something when the only edge it had was the one to the epic above it; and it counts
 * blockers that have since closed, which have stopped blocking. bc-l8jp.7's three
 * "dependencies" were one live blocker, one closed one, and its parent — the card said
 * "waits on 3" over a bead waiting on one thing.
 *
 * bc-7w1l fixed the same sentence on the *sheet* by splitting `dependencies[]` instead
 * of trusting the count (test/graphsheet.mjs). That does not transfer here: the list
 * rows behind the graph carry counts, not the array. So `enrichGraph` counts the edges
 * bd drew — which carry a `type` — and every fixture below is a real shape out of
 * `bd graph --html`, checked against a live workspace while the code was written.
 *
 * The last check is the acceptance criterion itself, and it is deliberately textual:
 * a count of 0 only becomes "no waits on at all" because the card renders that line
 * under a truthiness guard, and that guard lives in a file no test can import.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enrichGraph } from '../lib/graph.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${err.message.split('\n')[0]}`);
  }
};

/* ------------------------------------------------------------------- the fixtures */

const node = (id, status = 'open') => ({ id, title: id, status, priority: 2, type: 'task', layer: 0 });
const edge = (source, target, type = 'blocks') => ({ source, target, type });

/** What the server hands `enrichGraph`, with the annotation call left out of it. */
const enrich = (nodes, links, rows = []) =>
  enrichGraph({ nodes, links }, rows, { since: new Date().toISOString() });

const waitsOn = (nodes, links, rows = []) =>
  Object.fromEntries(enrich(nodes, links, rows).nodes.map((n) => [n.id, n.waits]));

/* --------------------------------------------------------------------- the counts */

console.log('\nwhat the edges say');

check('a subtask whose only edge is its parent waits on nothing', () => {
  const w = waitsOn(
    [node('bc-l8jp', 'in_progress'), node('bc-l8jp.2')],
    [edge('bc-l8jp', 'bc-l8jp.2', 'parent-child')]
  );
  assert.equal(w['bc-l8jp.2'], 0);
  // And the epic is not waiting on its own child either — the edge points the
  // other way, and neither end of a parent-child edge is stuck behind anything.
  assert.equal(w['bc-l8jp'], 0);
});

check('two real blockers are two', () => {
  const w = waitsOn(
    [node('bc-6alb'), node('bc-zryi'), node('bc-d704')],
    [edge('bc-zryi', 'bc-6alb'), edge('bc-d704', 'bc-6alb')]
  );
  assert.equal(w['bc-6alb'], 2);
  // The blockers themselves wait on nothing: `blocks` is directional, and counting
  // it from either end would make every edge two beads' problem.
  assert.equal(w['bc-zryi'], 0);
  assert.equal(w['bc-d704'], 0);
});

check('a parent and two blockers at once is still two', () => {
  const w = waitsOn(
    [node('bc-l8jp', 'in_progress'), node('bc-l8jp.7'), node('bc-jf4v'), node('bc-0nnt')],
    [
      edge('bc-l8jp', 'bc-l8jp.7', 'parent-child'),
      edge('bc-jf4v', 'bc-l8jp.7'),
      edge('bc-0nnt', 'bc-l8jp.7'),
    ]
  );
  assert.equal(w['bc-l8jp.7'], 2);
});

check('a closed blocker has stopped blocking', () => {
  // The shape `bd graph --html <id>` sends: a bead-scoped graph reaches into closed
  // neighbours and draws their edges, where `--all` prunes node and edge together.
  // Counting them would make the same bead wait on more in the scoped view than in
  // the whole-workspace one, over a blocker that is finished.
  const w = waitsOn(
    [node('bc-l8jp.7', 'in_progress'), node('bc-l8jp.6', 'closed'), node('bc-jf4v')],
    [edge('bc-l8jp.6', 'bc-l8jp.7'), edge('bc-jf4v', 'bc-l8jp.7')]
  );
  assert.equal(w['bc-l8jp.7'], 1);
});

check('discovered-from and related are not waiting', () => {
  const w = waitsOn(
    [node('bc-ne8u'), node('bc-7w1l'), node('bc-2ocm')],
    [edge('bc-7w1l', 'bc-ne8u', 'discovered-from'), edge('bc-2ocm', 'bc-ne8u', 'related')]
  );
  assert.equal(w['bc-ne8u'], 0);
});

check('an edge type nobody here has seen still counts', () => {
  // The permissive direction, and the one bd's own number is on. A new kind of edge
  // showing up as "waits on 1" is a number to argue with; silently dropping it is a
  // blocker that never appears anywhere.
  const w = waitsOn([node('bc-a'), node('bc-b')], [edge('bc-b', 'bc-a', 'invented-next-year')]);
  assert.equal(w['bc-a'], 1);
});

console.log('\nwhat the list row no longer decides');

check("the row's dependency_count is not consulted", () => {
  // bc-l8jp.7 as it really was: one live blocker among three counted dependencies.
  const w = waitsOn(
    [node('bc-l8jp', 'in_progress'), node('bc-l8jp.7', 'in_progress'), node('bc-jf4v')],
    [edge('bc-l8jp', 'bc-l8jp.7', 'parent-child'), edge('bc-jf4v', 'bc-l8jp.7')],
    [{ id: 'bc-l8jp.7', dependency_count: 3, dependent_count: 0, updated_at: null }]
  );
  assert.equal(w['bc-l8jp.7'], 1);
});

check('a node with no row at all still gets its count', () => {
  // The normal case for a bead-scoped graph, which draws closed neighbours the live
  // list deliberately excludes. Those have no dates and no counts of their own.
  const w = waitsOn([node('bc-a'), node('bc-b')], [edge('bc-b', 'bc-a')], []);
  assert.equal(w['bc-a'], 1);
});

check('links that did not parse mean nobody is waiting, not the old count', () => {
  // `parseGraph` hands over `links: []` when the array fails to parse, and there is
  // nothing in the payload to tell that from a graph with no edges. Falling back to
  // `dependency_count` there would put back exactly the number this replaced.
  const w = waitsOn([node('bc-l8jp.2')], [], [{ id: 'bc-l8jp.2', dependency_count: 1 }]);
  assert.equal(w['bc-l8jp.2'], 0);
});

check('everything else the node arrived with is untouched', () => {
  const { nodes } = enrich(
    [node('bc-a')],
    [],
    [{ id: 'bc-a', dependent_count: 4, comment_count: 2, created_at: '2026-08-01T00:00:00Z' }]
  );
  const [n] = nodes;
  assert.equal(n.blocks, 4, 'blocks is still bd’s dependent_count — bc-2ocm owns that half');
  assert.equal(n.comments, 2);
  assert.equal(n.created_at, '2026-08-01T00:00:00Z');
  assert.equal(n.title, 'bc-a');
});

console.log('\nand what the card does with a 0');

check('the card prints "waits on" only when there is something to wait on', () => {
  const graph = fs.readFileSync(path.join(ROOT, 'public/graph.js'), 'utf8');
  assert.match(
    graph,
    /if \(d\.waits\) meta\.push\(`waits on \$\{d\.waits\}`\);/,
    'the card’s "waits on" line is no longer guarded on d.waits being truthy'
  );
});

console.log(failures ? `\n${failures} failed\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
