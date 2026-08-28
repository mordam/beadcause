#!/usr/bin/env node
/**
 * The bead sheet — where a bead sits, what it is stuck behind, how it ended, and
 * (since bc-ka5y.43) the ⋮ that edits it.
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
 * against a copy of logic the phone no longer runs. **A renderer added below the region
 * fails in the other direction, silently**: the slice cannot see it, so it is untested
 * code under a passing suite. New ones go before `sheetHtml`, and their names go in the
 * object expression evaluated after the slice.
 *
 * **And what the slice cannot reach is asserted on the source instead.** Everything that
 * touches the DOM or the network — opening the ⋮, dismissing it, swapping the body for
 * the edit card, posting it, repainting from the answer — is a regex against the raw
 * text of public/graph.js, for the reason `and something actually resolves it` gives
 * below: every render check passes just as happily over a control nothing has wired up.
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
const { sheetHtml, relations, sessionRowHtml, sheetMenuHtml, sheetEditHtml, editFrom } = vm.runInContext(
  `${region}\n;({ sheetHtml, relations, sessionRowHtml, sheetMenuHtml, sheetEditHtml, editFrom })`,
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

console.log('\nhow it ended');

/** The shape `/api/bead` hands over for a bead bin/deliver.js closed. */
const landed = {
  id: 'bc-5uy8',
  title: 'test/dedupe.mjs can fail the whole gate on a teardown ENOTEMPTY',
  status: 'closed',
  closed_at: '2026-08-11T18:54:37Z',
  close_reason: 'Landed as #138 as 10892e4b — still owed: CAN BE DEPLOYED',
  description: 'Some prose.',
};

check('a closed bead says when it closed', () => {
  const html = sheetHtml(landed);
  assert.match(html, /class="closed-note"/, 'no outcome block on a closed bead');
  // The raw ISO stays on the element, whatever the locale renders beside it: it is
  // what a long-press shows and the only part of this an assertion can pin.
  assert.match(html, /<time datetime="2026-08-11T18:54:37Z">/, 'the close time is not machine-readable');
  assert.match(html, /Closed <time/, 'the time is there with nothing saying what it is');
});

check('and the reason it closed, through the same renderer as every other bd field', () => {
  const html = sheetHtml(landed);
  assert.ok(html.includes('<md>Landed as #138 as 10892e4b'), 'the close reason is nowhere on the sheet');
});

check('a long reason is drawn whole rather than clipped', () => {
  // 1664 characters is the worst one in this tracker, and this is the only place in the
  // app that draws the whole of one: /history clamps its copy to two lines in CSS and
  // `/api/history` stops sending at `CLOSE_REASON_MAX`, both on the understanding that
  // tapping the row lands here. Truncating here too would put the sentence nowhere.
  const long = `Landed as #99. ${'This is why it happened. '.repeat(80)}Signed off.`;
  const html = sheetHtml({ ...landed, close_reason: long });
  assert.ok(html.includes(long), 'the close reason was cut short before it reached the DOM');
});

check('the outcome sits above the description', () => {
  // The status pill raises the question; on a closed bead the answer is what you came
  // for, and below the description is where you go looking for it and give up.
  const html = sheetHtml(landed);
  assert.ok(html.indexOf('closed-note') < html.indexOf('Some prose.'), 'the outcome is below the description');
  assert.ok(html.indexOf('class="meta"') < html.indexOf('closed-note'), 'the outcome is above the pills');
});

check('a closed bead nobody gave a reason for still says when', () => {
  const html = sheetHtml({ ...landed, close_reason: '' });
  assert.match(html, /class="closed-note"/, 'the close time went with the reason');
  // The whole block, end to end: the stamp and nothing after it. An empty `.md` here
  // would be a bordered paragraph of nothing under the date.
  assert.match(
    html,
    /<div class="closed-note"><div class="closed-when">[^<]*<time[^>]*>[^<]*<\/time><\/div><\/div>/,
    'an empty reason was rendered as an empty paragraph'
  );
});

check('a closed bead with neither draws nothing at all', () => {
  const html = sheetHtml({ id: 'bc-x', title: 'x', status: 'closed' });
  assert.ok(!html.includes('closed-note'), 'an empty outcome block was drawn');
});

check('an open bead draws nothing', () => {
  assert.ok(!sheetHtml(plain).includes('closed-note'), 'a live bead was given an outcome');
});

check('a reopened bead does not carry the reason it closed last time', () => {
  // `bd` clears `closed_at` on reopen and leaves `close_reason` sitting there — see
  // lib/landed.js, which leans on exactly that. Reading the field without the status
  // would tell you a bead that is open again finished a week ago.
  const html = sheetHtml({ ...landed, status: 'open', closed_at: null });
  assert.ok(!html.includes('closed-note'), 'a reopened bead still claims it landed');
});

check('the outcome block has a style to wear, and none of it clamps', () => {
  const css = read('public/style.css');
  for (const sel of ['.closed-note', '.closed-when']) {
    assert.ok(css.includes(sel), `${sel} has no rule in style.css`);
  }
  const rules = css.slice(css.indexOf('.closed-note {'), css.indexOf('.closed-note .md > *:last-child'));
  assert.ok(!/line-clamp|text-overflow/.test(rules), 'the sheet clamps the reason /history already clamped');
});

console.log('\nthe way through to what its session did');

/** What `/api/session-archive?workspace=&id=` hands back for a bead that was worked. */
const worked = {
  ref: 'refs/beadcause/sessions/bc-nib3.5',
  sessions: [
    { commit: 'a1b2c3d4', at: '2026-08-11T16:12:04Z', subject: 'beadcause/bc-nib3.5 · done · 4 commit(s)' },
    { commit: 'e5f6a7b8', at: '2026-08-10T09:41:00Z', subject: 'beadcause/bc-nib3.5 · blocked · 0 commit(s)' },
  ],
};

check('every sheet draws a session row, before the answer is in', () => {
  const html = sheetHtml(plain);
  assert.ok(html.includes('id="sheet-session"'), 'no session row on the sheet at first paint');
  assert.ok(html.includes('sheet-session is-checking'), 'the first-paint row is not in its unresolved state');
});

check('the unresolved row cannot be tapped', () => {
  // The one-directional flicker: quiet then tappable never loses a tap, and the reverse
  // does. So nothing here may be an <a> until the answer says there is something behind it.
  const row = sessionRowHtml('bc-x', null);
  assert.ok(row.trimStart().startsWith('<div'), 'the unresolved row is a link');
  assert.ok(!row.includes('href='), 'the unresolved row carries an href');
});

check('an archived session is a link to /bead-session for that bead', () => {
  const row = sessionRowHtml('bc-nib3.5', worked);
  assert.ok(row.trimStart().startsWith('<a'), 'a bead with a session got no link');
  assert.match(
    row,
    /href="\/bead-session\?workspace=beadcause&amp;id=bc-nib3\.5"/,
    'the link is not a /bead-session?workspace=&id= link'
  );
});

check('and says how many there were, and when the newest ran', () => {
  const row = sessionRowHtml('bc-nib3.5', worked);
  assert.ok(row.includes('2 sessions'), 'the session count is not on the row');
  assert.ok(row.includes('newest'), 'nothing says which of the two the link opens');
  // The rendered date is locale-dependent; the year is the part any locale keeps.
  assert.match(row, /newest [^<]*2026/, 'the newest session has no date beside it');
  assert.ok(sessionRowHtml('bc-x', { sessions: [worked.sessions[0]] }).includes('1 session'), 'one session is pluralised');
});

check('a bead nothing ever ran on reads as unavailable and cannot be tapped', () => {
  const row = sessionRowHtml('bc-x', { ref: 'refs/beadcause/sessions/bc-x', sessions: [] });
  assert.ok(row.includes('is-none'), 'the empty answer is not drawn as the empty state');
  assert.ok(!row.includes('href='), 'a bead with no archive still offers a link');
  assert.ok(!row.includes('sess-go'), 'the empty state still wears the chevron that means "goes somewhere"');
  assert.ok(/No session archived/.test(row), 'the row does not say what is missing');
});

check('a check that failed offers the link rather than claiming nothing ran', () => {
  // The asymmetry argued in sessionRowHtml: "no session" over a bead that has one hides
  // the page for good, where a link over a bead that has none costs one tap onto a page
  // built to say plainly what is not there.
  const row = sessionRowHtml('bc-x', { failed: true, sessions: [] });
  assert.ok(row.includes('href='), 'a failed check was reported as an empty archive');
  assert.ok(!row.includes('is-none'), 'a failed check wears the empty state');
});

check('the row sits under the pills and the outcome, above the description', () => {
  const html = sheetHtml(landed);
  assert.ok(html.indexOf('class="meta"') < html.indexOf('sheet-session'), 'the session row is above the pills');
  assert.ok(html.indexOf('closed-note') < html.indexOf('sheet-session'), 'the session row is above the outcome');
  assert.ok(html.indexOf('sheet-session') < html.indexOf('Some prose.'), 'the session row is below the description');
});

check('the bead id is escaped into the href, not injected through it', () => {
  const row = sessionRowHtml('bc-x"><img src=x>', worked);
  assert.ok(!row.includes('<img'), 'a bead id was injected as markup');
  assert.ok(row.includes('%22%3E%3Cimg'), 'the id was dropped instead of encoded');
});

check('the page the row opens is one the drawer owns', () => {
  // Without this membership the link is a full navigation out of the drawer, and the back
  // gesture no longer returns you to the tab you tapped the row from.
  assert.match(
    read('public/drawer.js'),
    /const DETAIL = new Set\(\[[^\]]*'\/bead-session'/,
    "/bead-session is not in drawer.js's DETAIL set"
  );
});

check('the row has a style to wear, in every state, and it is thumb-sized', () => {
  const css = read('public/style.css');
  for (const sel of ['.sheet-session', '.sess-glyph', '.sess-main', '.sess-what', '.sess-sub', '.sess-go',
    '.sheet-session.is-checking', '.sheet-session.is-none']) {
    assert.ok(css.includes(sel), `${sel} has no rule in style.css`);
  }
  assert.match(css, /\.sheet-session \{[\s\S]*?min-height: 44px/, '.sheet-session is smaller than a thumb');
});

check('and something actually resolves it', () => {
  // Every check above this line renders the three states from a fixture. All of them pass
  // just as happily over a sheet whose row is stuck saying "looking…" forever, so the four
  // lines that do the resolving are asserted on the source: the call, the request behind
  // it, the sequence guard that drops an answer for a bead you have left, and the
  // `outerHTML` swap without which a `div` could never become an `a`.
  assert.match(GRAPH, /loadSession\(full, seq\)/, 'openSheet never asks whether a session was archived');
  assert.match(GRAPH, /\/api\/session-archive\?workspace=/, 'loadSession asks nothing for the answer');
  assert.match(
    GRAPH,
    /async function loadSession[\s\S]*?if \(seq !== sheetSeq\) return;/,
    'loadSession would paint an answer onto whatever sheet is open now'
  );
  assert.match(GRAPH, /slot\.outerHTML = sessionRowHtml/, 'the resolved row replaces only the inside of the element');
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

/* ------------------------------------------------------------ whose bead this is */

check('a P0 says who owns it, and says so even when nobody does', () => {
  // An unowned P0 is the state bc-rfnr.5's triage exists to clear, so the row has to be
  // drawn on the screen you are already looking at rather than only where an owner
  // already exists — otherwise the one bead you would fix never asks to be fixed.
  const html = sheetHtml({ id: 'bc-x', title: 'x', priority: 0, labels: [], dependencies: [] });
  assert.match(html, /class="owner-row"/, 'a P0 sheet draws no owner row');
  assert.match(html, /unowned/, 'an unowned P0 does not say so');
  const owned = sheetHtml({ id: 'bc-x', title: 'x', priority: 0, labels: ['owner:adam@example.com'], dependencies: [] });
  assert.match(owned, /owner-who" title="adam@example.com">adam</, 'the handle is not drawn, or not titled with the whole of it');
});

check('AND A BEAD THAT IS NEITHER A P0 NOR OWNED IS THE SHEET IT ALWAYS WAS', () => {
  // Most beads. The row is for the board, and a P3 gaining furniture it has no use for
  // is the cost this feature must not impose on the rest of the tracker.
  const html = sheetHtml({ id: 'bc-x', title: 'x', priority: 3, labels: ['inbox'], dependencies: [] });
  assert.ok(!html.includes('owner-row'), 'a P3 with no owner grew an owner row');
  // But a P1 somebody deliberately took still says so: ownership is recorded on any
  // bead, and only the *default* is P0-only (lib/bd.js).
  const kept = sheetHtml({ id: 'bc-x', title: 'x', priority: 1, labels: ['owner:bob@example.com'], dependencies: [] });
  assert.match(kept, /class="owner-row"/, 'an owned P1 hides who owns it');
});

check('two owners are drawn as two, rather than resolved down to one', () => {
  // It means two machines wrote before either synced (lib/ownership.js). Showing one is
  // how a tracker starts lying about who is answerable.
  const html = sheetHtml({
    id: 'bc-x', title: 'x', priority: 0,
    labels: ['owner:adam@example.com', 'owner:bob@example.com'], dependencies: [],
  });
  assert.match(html, /adam<\/span><span class="owner-and">/, 'the second owner is missing');
  assert.match(html, /bob<\/span>/);
});

check('the owner row has a style to wear, and it is thumb-sized', () => {
  const css = read('public/style.css');
  for (const sel of ['.owner-row', '.owner-kind', '.owner-who', '.owner-btn', '.owner-acts']) {
    assert.ok(css.includes(sel), `${sel} has no rule in style.css`);
  }
  assert.match(css, /\.owner-row \{[\s\S]*?min-height: 44px/, '.owner-row is smaller than a thumb');
});

/* ------------------------------------------------ the ⋮, and the card behind it */

console.log('\nthe ⋮ on the sheet head');

const HTML = read('public/graph.html');

check('the sheet head carries a ⋮, in a wrap the popover can hang off', () => {
  // The popover is positioned against `.menu-wrap` (`.menu { position: absolute; right: 0 }`),
  // so a ⋮ that is not inside one draws its menu against the page instead of the button.
  // From the sheet's own head, not the page's: /graph has a `<header>` of its own above
  // the canvas, so a slice to the first `</header>` in the file is a slice of that one.
  const at = HTML.indexOf('<header class="sheet-head">');
  const head = HTML.slice(at, HTML.indexOf('</header>', at));
  assert.match(head, /<div class="menu-wrap">/, 'the ⋮ has no wrap to position its menu against');
  assert.match(head, /id="sheet-menu" class="kebab"/, 'no ⋮ button on the sheet head');
  assert.match(head, /aria-haspopup="true"/, 'the ⋮ does not announce that it opens a menu');
  // Left of the two that are about the sheet rather than about the bead.
  assert.ok(head.indexOf('sheet-menu') < head.indexOf('sheet-expand'), 'the ⋮ is not first of the three');
  assert.ok(head.indexOf('sheet-expand') < head.indexOf('sheet-close'), 'the way out is no longer hard right');
});

check('the menu offers Edit', () => {
  const menu = sheetMenuHtml(plain);
  assert.match(menu, /class="menu" role="menu"/, 'the popover is not the card menu');
  assert.match(menu, /data-sheet-act="edit"/, 'nothing behind the ⋮ edits the bead');
  assert.match(menu, /class="menu-item"/, 'the item is not drawn as one');
});

check('a closed bead gets Edit greyed out, with the reason under it', () => {
  // The route's one predictable refusal (409, lib/beadedit.js). Predicted as a *missing*
  // item it would read as "this app has no editor"; disabled with the reason it is the
  // same fact, said.
  const menu = sheetMenuHtml({ ...plain, status: 'closed' });
  assert.match(menu, /data-sheet-act="edit" disabled/, 'a closed bead still offers a live Edit');
  assert.match(menu, /class="menu-why"/, 'the item is greyed out with nothing saying why');
  assert.ok(/record of what was done/.test(menu), 'the reason does not say what a closed bead is');
});

check('and every other status does not', () => {
  for (const status of ['open', 'in_progress', 'blocked']) {
    assert.ok(!sheetMenuHtml({ ...plain, status }).includes('disabled'), `${status} cannot be edited`);
  }
});

console.log('\nthe edit card');

/** A bead with something in all six fields, plus labels of both kinds. */
const rich = {
  id: 'bc-x9',
  title: 'Rewrite the picker',
  issue_type: 'feature',
  priority: 1,
  status: 'open',
  description: 'The prose as filed.',
  acceptance_criteria: 'It picks.',
  labels: ['ui', 'owner:adam@example.com', 'unendorsed', 'ran:opus', 'complexity:high'],
};

check('the card opens on what the bead says, field by field', () => {
  const card = sheetEditHtml(rich);
  assert.match(card, /data-edit="title" value="Rewrite the picker"/, 'the title is not prefilled');
  assert.match(card, /<option value="feature" selected>/, 'the bead’s type is not the selected one');
  assert.match(card, /<option value="1" selected>P1<\/option>/, 'the bead’s priority is not the selected one');
  assert.ok(card.includes('>The prose as filed.</textarea>'), 'the description is not prefilled');
  assert.ok(card.includes('>It picks.</textarea>'), 'the acceptance criteria are not prefilled');
});

check('a bead with none of them opens on the defaults rather than on "undefined"', () => {
  const card = sheetEditHtml({ id: 'bc-x', title: 'x' });
  assert.ok(!card.includes('undefined'), 'an absent field reached the box as the word undefined');
  assert.match(card, /<option value="task" selected>/, 'the default type is not task');
  assert.match(card, /<option value="2" selected>P2<\/option>/, 'the default priority is not P2');
});

check('the labels the daemon owns are not in the box', () => {
  // `isProtectedLabel` in lib/verdict.js is the authority; the card mirrors it because
  // the card posts the label set it is showing, so a protected label drawn here is one
  // you can delete and watch come back. `human` is the same failure by a different route
  // — `normalizeEdits` filters it out of the incoming set, so the card can never send it.
  const labels = sheetEditHtml(rich).match(/data-edit="labels" value="([^"]*)"/)[1];
  assert.equal(labels, 'ui, complexity:high', `the box offers ${labels}`);
  const human = sheetEditHtml({ ...rich, labels: ['human', 'inbox'] }).match(/data-edit="labels" value="([^"]*)"/)[1];
  assert.equal(human, 'inbox', 'the box offers a `human` label no save can keep');
});

check('and complexity: is deliberately still in it', () => {
  // Not protected server-side and argued for in normalizeEdits: a claim somebody made
  // about the work, which correcting from a phone is exactly what the card is for.
  assert.ok(editFrom(rich).labels.includes('complexity:high'), 'the tier label was hidden with the protected ones');
});

check('a title with markup in it reaches the box escaped, not as markup', () => {
  const card = sheetEditHtml({ id: 'bc-x', title: '"><img src=x onerror="boom">' });
  assert.ok(!card.includes('<img'), 'a title broke out of the value attribute');
  assert.ok(card.includes('&quot;&gt;&lt;img'), 'the title was dropped instead of escaped');
});

check('it carries Save and Cancel, and no verdict', () => {
  const card = sheetEditHtml(rich);
  assert.match(card, /data-sheet-act="save"/, 'nothing saves the card');
  assert.match(card, /data-sheet-act="cancel"/, 'nothing cancels the card');
  // The point of the separate route: endorsing is a decision about a bead, and this card
  // is about its fields. /endorse's form has the pair; this one must not.
  assert.ok(!card.includes('save-endorse'), 'the sheet offers a verdict it has no route for');
  // Two controls on the card, and they are these two. Asserted on the acts rather than
  // on the prose, which says "endorse" twice in the course of promising not to.
  assert.deepEqual(
    [...card.matchAll(/data-sheet-act="([a-z-]+)"/g)].map((m) => m[1]).sort(),
    ['cancel', 'save'],
    'the card grew a third control'
  );
});

check('it carries the bead id, so the save knows what it is writing', () => {
  assert.match(sheetEditHtml(rich), /id="sheet-edit" data-id="bc-x9"/, 'the card does not say which bead it is');
});

check('the card and the menu have styles to wear', () => {
  const css = read('public/style.css');
  for (const sel of ['.kebab', '.menu-wrap', '.menu-item', '.menu-why', '.eq-edit', '.eq-lab', '.edit-err']) {
    assert.ok(css.includes(sel), `${sel} has no rule in style.css`);
  }
  // The ⋮ is one of three controls on the head and `.icon-btn` — the other two — is
  // 40px square. Its native 48px circle beside them reads as furniture from another app.
  assert.match(css, /\.sheet-head \.kebab \{[^}]*height: 40px/, 'the ⋮ does not match the head it sits in');
});

console.log('\nand something actually drives it');

check('the ⋮ opens the menu, and a tap outside closes it', () => {
  // Every check above renders a string. The four lines that make it a control are on the
  // source: the button's own listener, the document-level dismiss, and the surgery both
  // ends use — a popover rebuilt through a repaint would throw away a half-typed card.
  assert.match(GRAPH, /\$\('sheet-menu'\)\.addEventListener/, 'the ⋮ is not wired to anything');
  assert.match(GRAPH, /if \(sheetMenuOpen\(\)\) closeSheetMenu\(\);\s*\n\s*else openSheetMenu\(\)/, 'the ⋮ does not toggle');
  assert.match(
    GRAPH,
    /if \(sheetMenuOpen\(\) && !ev\.target\.closest\('\.menu-wrap'\)\) closeSheetMenu\(\)/,
    'a tap outside the menu does not dismiss it'
  );
  assert.match(GRAPH, /insertAdjacentHTML\('beforeend', sheetMenuHtml\(sheetBead\)\)/, 'the menu is not opened by surgery');
});

check('Escape takes the popover, and only the popover', () => {
  // /graph runs inside the drawer's frame, and public/drawer.js already spends Escape on
  // the drawer. A page that closed a layer of its own on the same key would dismiss two
  // things a reader asked to dismiss one of — so this closes the menu, stops the press
  // there, and leaves the sheet to ✕.
  const key = GRAPH.slice(GRAPH.indexOf("if (ev.key !== 'Escape'"));
  const body = key.slice(0, key.indexOf('\n  });'));
  assert.match(body, /!sheetMenuOpen\(\)\) return;/, 'Escape acts with no menu open');
  assert.match(body, /ev\.stopPropagation\(\);/, 'the press that shuts the menu also leaves the page');
  assert.match(body, /closeSheetMenu\(\);/, 'Escape does not close the menu');
  assert.ok(!/closeSheet\(\)/.test(body), 'Escape closes the sheet as well as the popover');
});

check('Edit swaps the body for the card, prefilled from the bead the sheet is showing', () => {
  assert.match(GRAPH, /\$\('sheet-body'\)\.innerHTML = sheetEditHtml\(sheetBead\)/, 'Edit does not draw the card');
  assert.match(GRAPH, /closest\('\.sheet-head \[data-sheet-act="edit"\]'\)/, 'Edit is not caught above the body it replaces');
});

check('Save posts to the edit route, not to the verdict beside it', () => {
  assert.match(GRAPH, /post\('\/api\/bead\/edit', \{ workspace, id, edits: editsNow\(card\) \}\)/, 'Save does not post the card');
  assert.ok(!/post\('\/api\/bead\/adjust'/.test(GRAPH), 'the sheet posts a verdict on a proposal');
});

check('and then repaints from what the server holds, never from the form', () => {
  // The acceptance criterion, and the one thing a render check cannot see. `/api/bead/edit`
  // answers what *moved*; the bead itself is what the sheet draws, so the save re-reads it
  // — which is also how the thread line the edit just wrote arrives on screen.
  assert.match(GRAPH, /await paintSheet\(id, sheetSeq\)/, 'the save does not redraw the bead it wrote');
  assert.match(
    GRAPH,
    /async function paintSheet[\s\S]*?api\(`\/api\/bead\?workspace=/,
    'paintSheet does not ask the server for the bead'
  );
  assert.match(
    GRAPH,
    /async function paintSheet[\s\S]*?if \(seq !== sheetSeq\) return;\s*\n\s*sheetBead = full;/,
    'a repaint would land on whatever sheet is open now'
  );
});

check('a refusal keeps the card and everything typed into it', () => {
  // The case: a 409 on a bead somebody closed while you were typing. Throwing the text
  // away would be the app punishing you for its own stale copy.
  const save = GRAPH.slice(GRAPH.indexOf('async function saveEdit()'));
  const body = save.slice(0, save.indexOf('\n  }'));
  assert.match(body, /err\.hidden = false;/, 'a refusal is not shown on the card');
  assert.ok(!/sheetHtml|paintSheet/.test(body.slice(body.indexOf('catch'), body.indexOf('return;'))), 'a refusal repaints the sheet');
});

check('Cancel puts back the bead the server last described, and writes nothing', () => {
  const listener = GRAPH.slice(GRAPH.indexOf("btn.dataset.sheetAct === 'cancel'"));
  const body = listener.slice(0, listener.indexOf('\n  });'));
  assert.match(body, /\$\('sheet-body'\)\.innerHTML = sheetHtml\(b\)/, 'Cancel does not redraw the bead');
  assert.ok(!/post\(|api\(/.test(body), 'Cancel writes to the server');
  // The late arrivals go with it, or a cancelled edit leaves the sheet without the rows
  // `openSheet` drew the first time.
  for (const late of ['loadLinks(b, seq)', 'loadSession(b, seq)', 'loadOwnerActions(b, seq)', 'loadAdoptActions(b, seq)']) {
    assert.ok(body.includes(late), `Cancel drops ${late}`);
  }
});

check('and the sheet forgets its bead when it closes', () => {
  // Or the next ⋮ is answered out of the bead you were reading a moment ago — which on a
  // closed one is the difference between a live Edit and a greyed-out one.
  const close = GRAPH.slice(GRAPH.indexOf('function closeSheet()'));
  assert.match(close.slice(0, close.indexOf('\n  }')), /sheetBead = null;/, 'closeSheet keeps the last bead');
});

console.log(failures ? `\n${failures} failed\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
