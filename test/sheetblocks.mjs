#!/usr/bin/env node
/**
 * `blocks N` as a list of the beads it actually blocks.
 *
 *     npm test
 *     node test/sheetblocks.mjs
 *
 * The sheet printed `blocks 7` and stopped. Same complaint as `waits on 1` before
 * test/graphsheet.mjs — a number you cannot tap, answering none of the question it
 * raises — with one extra problem the other pill did not have: `dependent_count` counts
 * **every** edge pointing at the bead, and a child's `parent-child` edge is one of them.
 * So on bc-goo, an epic with eleven children and nothing else waiting on it, `blocks 11`
 * was eleven beads already listed under Children, described as blocked.
 *
 * What is pinned here:
 *
 * 1. **Children never appear.** The route lifts them out and `dependentsHtml` drops them
 *    again, because printing the same beads under two headings is the one failure this
 *    feature can have that looks like a feature.
 * 2. **A dependent goes in the group its edge means.** `blocks` is a queue; a
 *    `discovered-from` dependent came *out* of this bead and waits on nothing;
 *    `related` is neither. One number called all three "blocks".
 * 3. **The pill goes when the rows land, and not before.** It is what can be said at
 *    first paint and a worse version of what the rows say afterwards — and `loadLinks`
 *    leaves it alone when the call fails, because then it is all there is.
 * 4. **The rows are the rows.** Same `rel-row` as the parent link and the blockers
 *    above the description: what waits on this bead is the same kind of thing as what it
 *    waits on, and a second visual language would say it was not.
 *
 * **How it runs the real client code.** public/graph.js is one IIFE over a live DOM, so
 * it cannot be imported. The region from `beadUrl` to the end of `sheetHtml` is pure
 * string building and is sliced out and evaluated with its four helpers stubbed — the
 * same trick, and the same two markers, as test/graphsheet.mjs and
 * test/sheetchildren.mjs. `loadLinks` is *not* in that region (it touches the DOM and
 * the network), so claim 3 is checked where it is actually decided: the pill carries an
 * id in `sheetHtml`, and the one line that removes it is asserted against the file.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

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

/* ------------------------------------------------- the real code, in a bare room */

const GRAPH = read('public/graph.js');

const START = 'const beadUrl = (id) =>';
const END = "return parts.join('');";
const from = GRAPH.indexOf(START);
const to = GRAPH.indexOf(END, from);
if (from < 0 || to < 0) {
  console.log('  \x1b[31m✗\x1b[0m public/graph.js no longer has a beadUrl…sheetHtml region to slice');
  process.exit(1);
}
const close = GRAPH.indexOf('\n  }', to);
const region = GRAPH.slice(from, close + 4);

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
const ctx = vm.createContext({
  esc,
  statusColor: (s) => `colour(${s || 'open'})`,
  md: (t) => `<md>${t}</md>`,
  FROM_BD: { breaks: false },
  workspace: 'beadcause',
});
const { dependentsHtml, sheetHtml } = vm.runInContext(
  `${region}\n;({ dependentsHtml, sheetHtml })`,
  ctx,
  { filename: 'graph.js#blocks' }
);

/* ------------------------------------------------------------------- the fixtures */

const dep = (id, title, type = 'blocks', status = 'open') => ({
  id,
  title,
  status,
  dependency_type: type,
});

/** bc-4xs's four, all of them real: the tailnet-cert bead and what waited on it. */
const FOUR = [
  dep('bc-14s', 'Point the Android app at https', 'blocks', 'closed'),
  dep('bc-lza', 'Sign in with Google in the browser', 'blocks', 'closed'),
  dep('bc-ft4', 'Renew the tailnet certificate', 'blocks', 'closed'),
  dep('bc-dkq', 'Move every generated URL to the tailnet name', 'blocks'),
];

const rows = (html) => html.match(/<a class="rel-row[\s\S]*?<\/a>/g) || [];
const group = (html, label) => {
  const i = html.indexOf(`>${label}</span>`);
  if (i < 0) return '';
  const end = html.indexOf('</div>', i);
  return html.slice(i, end);
};

/* ------------------------------------------------------------------ what it draws */

console.log('\nthe list');

check('one tappable row per dependent, under a Blocks heading', () => {
  const html = dependentsHtml(FOUR);
  assert.equal(rows(html).length, 4, `${rows(html).length} rows for 4 dependents`);
  assert.ok(html.includes('>Blocks</span>'), 'no Blocks heading');
});

check('a row carries the id, the title and the status as colour', () => {
  const html = dependentsHtml([dep('bc-dkq', 'Move every generated URL')]);
  assert.ok(html.includes('bc-dkq'), 'no id on the row');
  assert.ok(html.includes('Move every generated URL'), 'no title on the row');
  assert.match(html, /background:colour\(open\)/, 'no status colour on the row');
});

check('and lands on that bead’s own sheet', () => {
  assert.match(
    dependentsHtml([dep('bc-dkq', 'Move every generated URL')]),
    /href="\/graph\?ws=beadcause&amp;id=bc-dkq&amp;open=1"/,
    'a dependent row is not a /graph?…&open=1 link'
  );
});

check('a closed dependent is coloured closed, like every other row on the sheet', () => {
  assert.match(dependentsHtml(FOUR), /background:colour\(closed\)/, 'status colour is not on the rows');
});

check('a title somebody wrote markup into is escaped, not rendered', () => {
  const html = dependentsHtml([dep('bc-evil', '<img src=x onerror="boom">')]);
  assert.ok(!html.includes('<img'), 'a dependent title was injected as markup');
  assert.ok(html.includes('&lt;img'), 'the title was dropped instead of escaped');
});

check('nothing waiting on it is nothing at all, not an empty heading', () => {
  assert.equal(dependentsHtml([]), '');
  assert.equal(dependentsHtml(null), '');
});

console.log('\nchildren are not in it');

check('a parent-child row is dropped even if the route hands one over', () => {
  // Belt and braces on purpose: the route filters them out, and this filters again.
  // An epic printing its eleven children under "Blocks" as well as under "Children" is
  // the whole failure the split exists to prevent.
  const html = dependentsHtml([
    { id: 'bc-goo.6', title: 'Tier 3 experiment', status: 'open', dependency_type: 'parent-child' },
    dep('bc-2ocm', 'Something waiting on it'),
  ]);
  assert.equal(rows(html).length, 1, 'a child survived into the Blocks list');
  assert.ok(html.includes('bc-2ocm'), 'the row left is not the non-child dependent');
});

check('an epic whose every dependent is a child draws no block at all', () => {
  const kids = [1, 2, 3].map((n) => ({
    id: `bc-goo.${n}`,
    title: `Child ${n}`,
    status: 'closed',
    dependency_type: 'parent-child',
  }));
  assert.equal(dependentsHtml(kids), '', 'an empty Blocks heading was drawn over an epic');
});

console.log('\nthe edges that are not a queue');

check('discovered-from is work that came out of the bead, not work stuck behind it', () => {
  const html = dependentsHtml([dep('bc-new', 'Found while doing it', 'discovered-from')]);
  assert.ok(!html.includes('>Blocks</span>'), 'a discovery was called blocked');
  assert.ok(group(html, 'Discovered here').includes('bc-new'), 'the discovery went nowhere');
});

check('related is related, whichever end of the edge you are reading from', () => {
  const html = dependentsHtml([dep('bc-dte', 'The other one', 'related')]);
  assert.ok(!html.includes('>Blocks</span>'), 'a related bead was called blocked');
  assert.ok(group(html, 'Related').includes('bc-dte'), 'the related bead went nowhere');
});

check('all three at once, each in its own group and each exactly once', () => {
  const html = dependentsHtml([
    dep('bc-dkq', 'Blocked on it'),
    dep('bc-new', 'Found while doing it', 'discovered-from'),
    dep('bc-dte', 'Merely related', 'related'),
  ]);
  assert.equal(rows(html).length, 3, `${rows(html).length} rows for 3 dependents`);
  assert.ok(group(html, 'Blocks').includes('bc-dkq'), 'the blocked bead is not under Blocks');
  assert.ok(group(html, 'Discovered here').includes('bc-new'), 'the discovery is not under Discovered here');
  assert.ok(group(html, 'Related').includes('bc-dte'), 'the related bead is not under Related');
  for (const id of ['bc-dkq', 'bc-new', 'bc-dte']) {
    assert.equal((html.match(new RegExp(`id=${id}&amp;`, 'g')) || []).length, 1, `${id} is linked twice`);
  }
});

check('an edge with no type at all is treated as a blocker', () => {
  // The same benefit of the doubt `relations()` gives a typeless dependency going the
  // other way — a bd that grows a fifth edge type should read as a queue, not vanish.
  const html = dependentsHtml([{ id: 'bc-x', title: 'No type', status: 'open' }]);
  assert.ok(group(html, 'Blocks').includes('bc-x'), 'a typeless dependent was dropped');
});

console.log('\nthe pill it replaces');

const epic = { id: 'bc-goo', title: 'An epic', status: 'in_progress', description: 'Some prose.', dependent_count: 11 };

check('the count is still what the first paint says, because the rows are not here yet', () => {
  assert.ok(sheetHtml(epic).includes('blocks 11'), 'the count vanished with nothing to replace it');
});

check('and it is findable, so the rows can take it away when they land', () => {
  assert.match(sheetHtml(epic), /<span class="pill" id="pill-blocks">blocks 11<\/span>/, 'the pill has no id');
});

check('loadLinks removes it the moment the edges arrive', () => {
  // Not reachable from the sliced region — this is the line, in the file.
  assert.match(GRAPH, /\$\('pill-blocks'\)\?\.remove\(\);/, 'nothing takes the pill off when the rows land');
});

check('a failed call leaves it alone — then the count really is all there is', () => {
  const loader = GRAPH.slice(GRAPH.indexOf('async function loadLinks'), GRAPH.indexOf("$('sheet-links')"));
  const bail = loader.indexOf('} catch {');
  const strip = loader.indexOf("$('pill-blocks')");
  assert.ok(bail > -1 && strip > bail, 'the pill is removed before the fetch can fail');
  assert.match(loader.slice(bail), /return;/, 'a failed fetch does not bail out');
});

check('a bead nothing points at has no pill and no slot', () => {
  const html = sheetHtml({ id: 'bc-7w1l', title: 'On its own', status: 'open', description: 'Some prose.' });
  assert.ok(!html.includes('blocks'), 'a bead with no dependents claims to block something');
  assert.ok(!html.includes('sheet-links'), 'a bead with no dependents carries a links slot');
});

console.log(failures ? `\n${failures} failed\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
