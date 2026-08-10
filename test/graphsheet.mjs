#!/usr/bin/env node
/**
 * The bead sheet's relations block — where a bead sits, and what it is stuck behind.
 *
 *     npm test
 *     node test/graphsheet.mjs
 *
 * The sheet used to print `waits on 1` and stop. The count was not tappable, so the
 * one question it raised — *waiting on what?* — could only be answered in a terminal;
 * and on a subtask it was not even true, because `bd show --json` counts the edge to
 * the **parent** among the dependencies. A child that blocked on nothing whatsoever
 * announced that it was waiting on something.
 *
 * So the array is split rather than counted, and this pins the split. Every case here
 * is a real shape out of `bd show --json`, checked against a live workspace while the
 * code was written:
 *
 *   - a subtask: one `parent-child` row, nothing else → a parent link, no "waits on"
 *   - a blocked bead: `blocks` rows → one tappable row each
 *   - both at once → the parent appears exactly once, in the parent group
 *   - neither → nothing at all, not an empty heading
 *
 * **How it runs the real code.** public/graph.js is one big IIFE over a live DOM and
 * a d3 canvas, so it cannot be imported. The contiguous region from `beadUrl` to the
 * end of `sheetHtml` is pure string building, though — it touches nothing but its four
 * helpers — so the region is sliced out of the file and evaluated with those four
 * stubbed. Ship a change that moves the rendering out of that region, or renames one
 * of the two markers, and this fails loudly on the slice rather than quietly passing
 * against a copy of logic the phone no longer runs.
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
// Through the `}` that closes sheetHtml, which is the first line-initial `  }` after
// its return.
const close = GRAPH.indexOf('\n  }', to);
const region = GRAPH.slice(from, close + 4);

// The four things the region closes over, and nothing else. `esc` is the file's own
// escaper, copied rather than stubbed away: half these checks are about what happens
// to a title somebody wrote a `<` in.
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
const { sheetHtml, relations } = vm.runInContext(
  `${region}\n;({ sheetHtml, relations })`,
  ctx,
  { filename: 'graph.js#sheet' }
);

/* ------------------------------------------------------------------- the fixtures */

const parentRow = {
  id: 'bc-l8jp',
  title: 'Rework the beadcause UX end to end',
  status: 'in_progress',
  dependency_type: 'parent-child',
};
const blocker = (id, title, status = 'open') => ({ id, title, status, dependency_type: 'blocks' });

/** A subtask: bd sends the parent as a dependency, and counts it. */
const subtask = {
  id: 'bc-l8jp.2',
  title: 'Nest the terminal under Admin',
  status: 'open',
  dependencies: [parentRow],
  parent: 'bc-l8jp',
  dependency_count: 1,
  dependent_count: 0,
};

/** A blocked bead with no parent. */
const blocked = {
  id: 'bc-6alb',
  title: 'Two blockers, no parent',
  status: 'open',
  dependencies: [blocker('bc-zryi', 'The first thing'), blocker('bc-d704', 'The second thing', 'closed')],
  dependency_count: 2,
};

/** Neither: the shape most beads have. */
const plain = { id: 'bc-7w1l', title: 'On its own', status: 'open', description: 'Some prose.' };

const rows = (html, cls) => html.match(new RegExp(`<a class="${cls}"[\\s\\S]*?</a>`, 'g')) || [];
const group = (html, label) => {
  const i = html.indexOf(`>${label}</span>`);
  if (i < 0) return '';
  const end = html.indexOf('</div>', i);
  return html.slice(i, end);
};

/* ------------------------------------------------------------------ what it draws */

console.log('\nthe parent link');

check('a subtask names its parent, with the id and the title', () => {
  const html = sheetHtml(subtask);
  const parent = group(html, 'Parent');
  assert.ok(parent.includes('bc-l8jp'), 'no parent id in the parent group');
  assert.ok(parent.includes('Rework the beadcause UX end to end'), 'no parent title');
});

check('the parent link lands on the parent’s own sheet', () => {
  assert.match(
    sheetHtml(subtask),
    /href="\/graph\?ws=beadcause&amp;id=bc-l8jp&amp;open=1"/,
    'the parent link is not a /graph?…&open=1 link'
  );
});

check('a bead with no parent draws no parent heading', () => {
  const html = sheetHtml(blocked);
  assert.ok(!html.includes('>Parent</span>'), 'an empty Parent heading was drawn');
});

check('a payload that lost the row still gets a way up from `parent`', () => {
  const html = sheetHtml({ id: 'bc-x', title: 'x', parent: 'bc-l8jp', dependencies: [] });
  assert.ok(group(html, 'Parent').includes('bc-l8jp'), 'the `parent` id fallback drew nothing');
});

console.log('\nwhat it waits on');

check('one tappable row per blocker', () => {
  const waits = group(sheetHtml(blocked), 'Waits on');
  const links = rows(waits, 'rel-row');
  assert.equal(links.length, 2, `${links.length} rows for 2 blockers`);
  assert.ok(waits.includes('id=bc-zryi&amp;open=1'), 'the first blocker is not linked');
  assert.ok(waits.includes('id=bc-d704&amp;open=1'), 'the second blocker is not linked');
  assert.ok(waits.includes('The first thing'), 'a blocker row carries no title');
});

check('a closed blocker is coloured closed', () => {
  assert.match(sheetHtml(blocked), /background:colour\(closed\)/, 'status colour is not on the rows');
});

check('the parent is never listed among what the bead waits on', () => {
  const both = {
    ...subtask,
    dependencies: [parentRow, blocker('bc-zryi', 'The real blocker')],
    dependency_count: 2,
  };
  const html = sheetHtml(both);
  assert.equal(rows(group(html, 'Waits on'), 'rel-row').length, 1, 'the waits list is not just the blockers');
  assert.equal((html.match(/id=bc-l8jp&amp;/g) || []).length, 1, 'the parent is linked twice');
});

check('a bd count that only ever counted the parent is not printed', () => {
  // The bug this replaces: dependency_count is 1 here, and every one of those 1 is
  // the edge to the parent. The old sheet said "waits on 1" over a bead waiting on
  // nothing.
  assert.ok(!sheetHtml(subtask).includes('waits on'), 'the sheet still claims a subtask waits on its parent');
});

check('the rows replace the count rather than sitting under it', () => {
  assert.ok(!sheetHtml(blocked).includes('waits on'), 'both the pill and the rows were drawn');
});

check('a payload with a count but no rows keeps the count', () => {
  // /api/bead hands bd's row through untouched, and bd omits `dependencies` on a bead
  // that has none — but a count with no array is the one case where the pill is still
  // the only thing that can be said.
  const html = sheetHtml({ id: 'bc-x', title: 'x', dependency_count: 3 });
  assert.ok(html.includes('waits on 3'), 'the count vanished with nothing to replace it');
});

console.log('\nthe other edges, and the beads with none');

check('discovered-from is related, not something it waits on', () => {
  const html = sheetHtml({
    id: 'bc-x',
    title: 'x',
    dependencies: [{ id: 'bc-src', title: 'Where it came from', status: 'closed', dependency_type: 'discovered-from' }],
    dependency_count: 1,
  });
  assert.ok(!html.includes('>Waits on</span>'), 'a discovered-from edge was called a blocker');
  assert.ok(group(html, 'Related').includes('bc-src'), 'the discovered-from edge went nowhere');
});

check('a bead with no edges draws no relations block at all', () => {
  const html = sheetHtml(plain);
  assert.ok(!html.includes('class="rel"'), 'an empty relations block was drawn');
  assert.ok(!html.includes('rel-group'), 'an empty group was drawn');
});

check('relations sit above the description', () => {
  const html = sheetHtml({ ...subtask, description: 'Some prose.' });
  assert.ok(html.indexOf('class="rel"') < html.indexOf('Some prose.'), 'the parent is below the description');
});

check('a title with markup in it is escaped, not rendered', () => {
  const html = sheetHtml({
    id: 'bc-x',
    title: 'x',
    dependencies: [blocker('bc-evil', '<img src=x onerror="boom">')],
  });
  assert.ok(!html.includes('<img'), 'a dependency title was injected as markup');
  assert.ok(html.includes('&lt;img'), 'the title was dropped instead of escaped');
});

console.log('\nthe split itself');

check('relations() puts every edge in exactly one group', () => {
  const r = relations({
    dependencies: [parentRow, blocker('a', 'A'), { id: 'r', dependency_type: 'related' }],
  });
  assert.equal(r.parent.id, 'bc-l8jp');
  assert.deepEqual(r.waits.map((x) => x.id), ['a']);
  assert.deepEqual(r.related.map((x) => x.id), ['r']);
});

check('an edge with no type is treated as a blocker', () => {
  const r = relations({ dependencies: [{ id: 'a' }] });
  assert.deepEqual(r.waits.map((x) => x.id), ['a']);
});

/* ------------------------------------------------------- and the drawer it opens in */

check('the drawer still owns the links these rows make', () => {
  // `back closes the drawer exactly once` is drawer.js's promise, and it only applies
  // to a path in its DETAIL set: anything else is a full navigation out of the drawer.
  // Every row here links to /graph, so that membership is part of this feature.
  assert.match(read('public/drawer.js'), /const DETAIL = new Set\(\[[^\]]*'\/graph'/, "/graph is not in drawer.js's DETAIL set");
});

check('the rows have a style to wear', () => {
  const css = read('public/style.css');
  for (const sel of ['.rel-group', '.rel-row', '.rel-kind', '.rel-title', '.rel-dot']) {
    assert.ok(css.includes(sel), `${sel} has no rule in style.css`);
  }
  // 44px is the tap target the rest of the app holds to; a row you miss is a row
  // that scrolls the sheet instead of opening the bead.
  assert.match(css, /\.rel-row \{[\s\S]*?min-height: 44px/, '.rel-row is smaller than a thumb');
});

console.log(failures ? `\n${failures} failed\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
