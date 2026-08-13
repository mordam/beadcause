#!/usr/bin/env node
/**
 * "waits on N" and "blocks N" on a graph node's card — the numbers, not the layout.
 *
 *     npm test
 *     node test/graphwaits.mjs
 *
 * The card used to print bd's two counts straight through, and neither answers the
 * question the phrase above it asks. Two separate ways of being wrong, and the fixtures
 * below cover both because the numbers reach the card from more than one bd command:
 *
 *  - **A neighbour that has closed still counts.** bc-l8jp.7's three "dependencies"
 *    were one live blocker and one closed one, so the card said "waits on 3" over a
 *    bead waiting on one thing (bc-ne8u); bc-nib3.4 blocks two beads of which one has
 *    finished, and `bd list` still says two (bc-cpzm).
 *  - **The `parent-child` edge is counted among the plain dependencies at both of its
 *    ends** — by `bd show`, which is where an epic's "blocks 7" came from: bc-goo has
 *    no dependents at all and `bd show --json` returns `dependent_count: 11`, one per
 *    child. `bd list`, whose rows are what the graph is annotated from, happens *not*
 *    to do this today; counting the edges rather than trusting a row is what stops the
 *    difference between the two commands mattering.
 *
 * bc-7w1l fixed the same sentences on the *sheet* by splitting `dependencies[]` instead
 * of trusting the counts (test/graphsheet.mjs). That does not transfer here: the list
 * rows behind the graph carry counts, not the array. So `enrichGraph` counts the edges
 * bd drew — which carry a `type` — and every fixture below is a real shape out of
 * `bd graph --html`, checked against a live workspace while the code was written.
 *
 * The last two checks are the acceptance criteria themselves, and they are deliberately
 * textual: a count of 0 only becomes "no line at all" because the card renders each one
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

const blocksOf = (nodes, links, rows = []) =>
  Object.fromEntries(enrich(nodes, links, rows).nodes.map((n) => [n.id, n.blocks]));

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

console.log('\nand the same walk the other way');

check('an epic whose only edges are its children blocks nothing', () => {
  // bc-goo as it was when this was filed: seven children, no plain dependents, and a
  // "blocks 7" beside it. The edge points from the parent *at* the child, so this is the
  // direction in which bd's count goes wrong — an epic reads as holding up its contents.
  const kids = ['1', '2', '3', '4', '5', '6', '7'].map((n) => node(`bc-goo.${n}`));
  const b = blocksOf(
    [node('bc-goo', 'in_progress'), ...kids],
    kids.map((k) => edge('bc-goo', k.id, 'parent-child'))
  );
  assert.equal(b['bc-goo'], 0);
  // And no child is blocking the epic above it either, which would be the same mistake
  // read backwards.
  assert.equal(b['bc-goo.1'], 0);
});

check('two beads really held up are two', () => {
  const b = blocksOf(
    [node('bc-6alb'), node('bc-zryi'), node('bc-d704')],
    [edge('bc-6alb', 'bc-zryi'), edge('bc-6alb', 'bc-d704')]
  );
  assert.equal(b['bc-6alb'], 2);
  // The far ends block nothing: the count is directional at each node, and the same
  // fixture read from the other side is two beads each waiting on one.
  assert.equal(b['bc-zryi'], 0);
  assert.equal(b['bc-d704'], 0);
  const w = waitsOn(
    [node('bc-6alb'), node('bc-zryi'), node('bc-d704')],
    [edge('bc-6alb', 'bc-zryi'), edge('bc-6alb', 'bc-d704')]
  );
  assert.deepEqual([w['bc-zryi'], w['bc-d704'], w['bc-6alb']], [1, 1, 0]);
});

check('children and real dependents at once counts only the dependents', () => {
  const b = blocksOf(
    [node('bc-goo', 'in_progress'), node('bc-goo.1'), node('bc-goo.2'), node('bc-jf4v')],
    [
      edge('bc-goo', 'bc-goo.1', 'parent-child'),
      edge('bc-goo', 'bc-goo.2', 'parent-child'),
      edge('bc-goo', 'bc-jf4v'),
    ]
  );
  assert.equal(b['bc-goo'], 1);
});

check('a closed dependent has stopped being held up', () => {
  // Finished work is not waiting on anything, so nothing is holding it up. bc-nib3.4 is
  // the live case: it blocks two beads, one of which closed, and bd still says two.
  const b = blocksOf(
    [node('bc-jf4v', 'in_progress'), node('bc-l8jp.6', 'closed'), node('bc-l8jp.7')],
    [edge('bc-jf4v', 'bc-l8jp.6'), edge('bc-jf4v', 'bc-l8jp.7')]
  );
  assert.equal(b['bc-jf4v'], 1);
});

check('and a closed bead is holding nothing up', () => {
  // The two cards over one edge have to agree, and this is the end that is easy to get
  // wrong: testing only the *target* leaves a finished bead announcing that it blocks
  // something, beside the bead it names saying it waits on nothing. bc-zvuc, closed,
  // over a live bc-goo.6 is the shape a scoped graph really draws.
  const nodes = [node('bc-zvuc', 'closed'), node('bc-goo.6', 'in_progress')];
  const links = [edge('bc-zvuc', 'bc-goo.6')];
  assert.equal(blocksOf(nodes, links)['bc-zvuc'], 0);
  assert.equal(waitsOn(nodes, links)['bc-goo.6'], 0, 'the far end of the same edge');
});

check('a closed bead is waiting on nothing either', () => {
  const nodes = [node('bc-jf4v', 'in_progress'), node('bc-l8jp.6', 'closed')];
  const links = [edge('bc-jf4v', 'bc-l8jp.6')];
  assert.equal(waitsOn(nodes, links)['bc-l8jp.6'], 0);
  assert.equal(blocksOf(nodes, links)['bc-jf4v'], 0, 'the far end of the same edge');
});

check('discovered-from and related are not blocking either', () => {
  const b = blocksOf(
    [node('bc-ne8u'), node('bc-cpzm'), node('bc-2ocm')],
    [edge('bc-ne8u', 'bc-cpzm', 'discovered-from'), edge('bc-ne8u', 'bc-2ocm', 'related')]
  );
  assert.equal(b['bc-ne8u'], 0);
});

check('an unseen edge type blocks, the same way it waits', () => {
  const b = blocksOf([node('bc-a'), node('bc-b')], [edge('bc-a', 'bc-b', 'invented-next-year')]);
  assert.equal(b['bc-a'], 1);
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

check("the row's dependent_count is not consulted either", () => {
  // bc-goo as `bd show` describes it: eleven dependents, every one of them a child. The
  // row is fed here in that shape deliberately — `bd list` does not answer this way
  // today, and the point of the check is that it would not matter if it started to.
  const b = blocksOf(
    [node('bc-goo', 'in_progress'), node('bc-goo.1')],
    [edge('bc-goo', 'bc-goo.1', 'parent-child')],
    [{ id: 'bc-goo', dependency_count: 0, dependent_count: 7, updated_at: null }]
  );
  assert.equal(b['bc-goo'], 0);
});

check('links that did not parse mean nobody is waiting, not the old count', () => {
  // `parseGraph` hands over `links: []` when the array fails to parse, and there is
  // nothing in the payload to tell that from a graph with no edges. Falling back to
  // `dependency_count` there would put back exactly the number this replaced.
  const w = waitsOn([node('bc-l8jp.2')], [], [{ id: 'bc-l8jp.2', dependency_count: 1 }]);
  assert.equal(w['bc-l8jp.2'], 0);
});

check('and nobody blocking, for the same reason', () => {
  const b = blocksOf([node('bc-goo')], [], [{ id: 'bc-goo', dependent_count: 7 }]);
  assert.equal(b['bc-goo'], 0);
});

check('everything else the node arrived with is untouched', () => {
  const { nodes } = enrich(
    [node('bc-a')],
    [],
    [{ id: 'bc-a', dependent_count: 4, comment_count: 2, created_at: '2026-08-01T00:00:00Z' }]
  );
  const [n] = nodes;
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

check('and "blocks" only when it is holding something up', () => {
  const graph = fs.readFileSync(path.join(ROOT, 'public/graph.js'), 'utf8');
  assert.match(
    graph,
    /if \(d\.blocks\) meta\.push\(`blocks \$\{d\.blocks\}`\);/,
    'the card’s "blocks" line is no longer guarded on d.blocks being truthy'
  );
});

console.log(failures ? `\n${failures} failed\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
