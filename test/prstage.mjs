#!/usr/bin/env node
/**
 * The status ladder, and the two screens that draw it.
 *
 *     npm test
 *     node test/prstage.mjs
 *
 * bc-l8jp.6 took **PRs** off the bottom bar and made pull requests cards in the inbox.
 * Two things had to be true for that to be an improvement rather than a third copy of an
 * existing screen, and both are the sort that rot silently:
 *
 * 1. **One derivation.** Where a pull request has got to is decided by `stageOf` in
 *    lib/prstage.js and nowhere else. The board, the inbox card and the filter chips all
 *    read `row.stage`. A client that re-derived it from the flags would be one network hop
 *    further from the truth and would disagree the first time the rules moved — which is
 *    the whole failure this subject cannot afford, because the reason the board exists is
 *    that "did it actually ship?" must have one answer.
 * 2. **One renderer.** public/prcard.js draws a pull request, and both screens wrap what it
 *    returns. There were two before this bead.
 *
 * Neither is visible by reading one file, so this suite reads several: the ladder itself as
 * a unit (every rung, and the nulls that must never collapse into `false`), the client's
 * mirror of its words, and the wiring — the tab that is gone, the page that still serves,
 * the script order and the cache version that make the two arrive together.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { RANK, STAGES, STAGE_IDS, stageOf } from '../lib/prstage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${err.message.split('\n')[0]}`);
  }
}

/* ------------------------------------------------------------------ the ladder */

const iso = (minsAgo) => new Date(Date.now() - minsAgo * 60000).toISOString();

/** A board row, as lib/prboard.js assembles one, merged and on origin by default. */
const row = (over = {}) => ({
  state: 'MERGED',
  merged: true,
  pushed: true,
  deployed: false,
  mergedAt: iso(60),
  base: 'main',
  deployTracked: true,
  ...over,
});

/** An `ok` deploy of this repo, started after the merge — the record that buys a rung. */
const deploy = (over = {}) => ({ id: 'dep-1', workspace: 'demo', status: 'ok', startedAt: iso(30), ...over });

console.log('\nsix rungs, and each one means something different');

await check('the table, the ids and the order are one thing', () => {
  assert.deepEqual(STAGE_IDS, ['review', 'merged', 'pushed', 'deployed', 'live', 'closed']);
  for (const s of STAGES) {
    assert.ok(s.label, `${s.id} has no label`);
    assert.ok(s.note, `${s.id} has no note — the chip and the lamp would have no name`);
  }
  // The sort order is generated from the ladder rather than written out beside it, so the
  // two cannot be changed apart: what you must act on first is what is earliest.
  assert.deepEqual(
    [...STAGE_IDS].sort((a, b) => RANK[a] - RANK[b]),
    STAGE_IDS
  );
});

await check('open on GitHub is review, whatever else is true of it', () => {
  assert.equal(stageOf(row({ state: 'OPEN', merged: false })), 'review');
  assert.equal(stageOf(row({ state: 'OPEN', merged: false, draft: true })), 'review');
});

await check('closed without merging is closed, and it is off the ladder', () => {
  assert.equal(stageOf(row({ state: 'CLOSED', merged: false })), 'closed');
  // Last, so it sinks below everything there is something to do about.
  assert.equal(RANK.closed, STAGE_IDS.length - 1);
});

await check('merged is where a merge stops until this Mac has seen it on origin', () => {
  assert.equal(stageOf(row({ pushed: false })), 'merged');
  // The one that matters: `null` is "nobody has looked", and it must not read as pushed.
  assert.equal(stageOf(row({ pushed: null })), 'merged');
});

await check('pushed is on origin with no deploy behind it', () => {
  assert.equal(stageOf(row(), []), 'pushed');
  assert.equal(stageOf(row(), [deploy({ status: 'failed' })]), 'pushed', 'a failed deploy shipped nothing');
  assert.equal(stageOf(row(), [deploy({ startedAt: iso(120) })]), 'pushed', 'a deploy older than the merge');
  assert.equal(stageOf(row(), [deploy({ status: 'unconfirmed' })]), 'pushed', 'an ending that means nobody knows');
});

await check('deployed is a deploy that ran, and nothing stronger', () => {
  assert.equal(stageOf(row(), [deploy()]), 'deployed');
  // Untracked is the ordinary case for every repo but beadcause: `fly deploy` shipped it
  // and no process here can look at what came up. That is exactly this rung.
  assert.equal(stageOf(row({ deployTracked: false, deployed: null }), [deploy()]), 'deployed');
});

await check('live is the build this process is running — the only claim beadcause can prove', () => {
  assert.equal(stageOf(row({ deployed: true })), 'live');
  // With no journal at all: ancestry against the boot commit needs nobody's records.
  assert.equal(stageOf(row({ deployed: true }), []), 'live');
  // And it outranks the weaker word rather than sitting beside it.
  assert.ok(RANK.live > RANK.deployed);
});

await check('a merge nobody has fetched is never called deployed, whatever ran', () => {
  // `shippedState` answers null here — no commit on origin means no deploy could have
  // carried it — and null is not true.
  assert.equal(stageOf(row({ pushed: null }), [deploy()]), 'merged');
});

await check('no row is left without a rung, including a shape nobody writes today', () => {
  assert.equal(stageOf(undefined), 'review');
  assert.equal(stageOf({}), 'review');
  assert.ok(STAGE_IDS.includes(stageOf(row({ state: 'WAT' }))));
});

/* --------------------------------------------------------- the client's mirror */

console.log('\nthe words the phone draws, against the words the daemon sends');

/** public/prcard.js in a room of its own. It touches no document at load. */
const prCard = (() => {
  const window = {};
  const ctx = vm.createContext({ window, document: { createElement: () => ({}) } });
  vm.runInContext(read('public/prcard.js'), ctx, { filename: 'prcard.js' });
  return ctx.window.beadcause.prCard;
})();

await check('every rung, in the same order, with the same words', () => {
  const mine = Array.from(prCard.STAGES).map((s) => ({ id: s.id, label: s.label, note: s.note }));
  assert.deepEqual(
    mine,
    STAGES.map((s) => ({ id: s.id, label: s.label, note: s.note })),
    'the ladder in public/prcard.js has drifted from lib/prstage.js'
  );
  assert.deepEqual(Array.from(prCard.stageIds()), STAGE_IDS);
});

await check('the client reads the rung, it does not work it out', () => {
  const src = read('public/prcard.js');
  // The two facts the daemon derives from. A client that mentioned either would be the
  // second implementation, one hop further from the checkout that knows.
  assert.ok(!/'MERGED'|"MERGED"/.test(src), 'prcard.js is deciding what merged means');
  assert.ok(!/shippedState|mergeCommit\s*\)/.test(src), 'prcard.js is deriving a stage');
  assert.ok(src.includes('p?.stage') || src.includes('p.stage'), 'prcard.js never reads the stage it is given');
});

await check('and it draws the rung as a word, with the note behind it', () => {
  const html = prCard.stageHtml({ stage: 'pushed' });
  assert.ok(html.includes('Pushed'), html);
  assert.ok(html.includes('st-pushed'), html);
  assert.ok(html.includes('no deploy has carried it'), html);
  assert.equal(prCard.stageHtml({ stage: 'nonsense' }), '', 'a rung nobody has heard of drew something');
});

await check('four lamps, and the unknown one is neither on nor off', () => {
  const lamps = (p) =>
    [...prCard.lampsHtml(p).matchAll(/class="lamp (on|off|unknown)"[^>]*>.*?<\/span>(\w+)</g)].map(
      (m) => `${m[1]}:${m[2]}`
    );
  assert.deepEqual(lamps(row({ deployed: true, shipped: true })), [
    'on:Merged',
    'on:Pushed',
    'on:Deployed',
    'on:Live',
  ]);
  assert.deepEqual(lamps(row({ shipped: false })), ['on:Merged', 'on:Pushed', 'off:Deployed', 'off:Live']);
  // Nobody has looked, on either of the two questions only this Mac can answer.
  assert.deepEqual(lamps(row({ pushed: null, shipped: null, deployed: null })), [
    'on:Merged',
    'unknown:Pushed',
    'unknown:Deployed',
    'unknown:Live',
  ]);
});

await check('one row renderer, and both screens call it', () => {
  const body = prCard.bodyHtml(
    { ...row({ deployed: true, shipped: true }), number: 7, title: 'a pull request', workspace: 'demo', beads: [], additions: 1, deletions: 2, files: 3, stage: 'live', url: 'https://x/7' },
    { titleHref: 'https://x/7', repo: true }
  );
  assert.ok(body.includes('#7') && body.includes('a pull request'), body.slice(0, 200));
  assert.ok(body.includes('demo'), 'the inbox card cannot say which repo it is from');
  assert.ok(body.includes('href="https://x/7"'), 'the title is not a link where it is the only one');

  const prs = read('public/prs.js');
  const app = read('public/app.js');
  assert.ok(/bodyHtml\(p\)/.test(prs), 'the board no longer draws its rows through the shared renderer');
  assert.ok(!/class="board-lamps"/.test(prs), 'the board still has a lamp renderer of its own');
  assert.ok(/prCard/.test(app) && /bodyHtml\(/.test(app), 'the inbox is not drawing its cards through it');
  assert.ok(!/class="board-lamps"/.test(app), 'the inbox grew a second lamp renderer');
});

/* -------------------------------------------------------------------- wiring */

console.log('\nthe tab that went, and the pill that came back');

/* bc-l8jp.6 took the board off the bottom bar, on the rule that a tab was a claim a page
   is somewhere you *live* — and a fifth of a five-tab bar is a lot to claim for a screen
   you glance at twice a day. bc-d4d5 then found that taking it off had left nothing at
   all pointing at it, and made it a chip on /monitor.

   bc-khoe.1 is where that argument ends, because the thing it was about is gone: the row
   scrolls sideways and holds roughly nine pills, so a view costs one of them rather than
   a fifth of the screen's width. What is asserted here is the shape either way — one
   entry, in one table, pointing at all three of the board's paths. */
await check('the pill row has a PRs pill, and it is the board’s three paths', () => {
  const bar = read('public/viewbar.js');
  const ids = [...bar.matchAll(/^\s*\{?\s*id: '(\w+)'/gm)].map((m) => m[1]);
  assert.ok(ids.includes('prs'), `the row has no PRs pill: ${ids.join(', ')}`);
  assert.ok(ids.includes('inbox'), `the row lost Home: ${ids.join(', ')}`);
  assert.match(bar, /paths: \['\/prs', '\/pulls', '\/prs\.html'\]/, 'the pill does not answer to all three paths');
  // And nothing is left of the bar that used to hold it.
  assert.ok(!fs.existsSync(path.join(ROOT, 'public/tabbar.js')), 'public/tabbar.js is back');
  assert.ok(!fs.existsSync(path.join(ROOT, 'scripts/tabbar-check.mjs')), 'scripts/tabbar-check.mjs is back');
});

await check('the board is still served, and still has the bar on it', () => {
  // The paths themselves are asked of a real server in test/pagepaths.mjs; what is here is
  // the pair that makes a *shortcut* still work — the aliases and the page's own bar.
  const server = read('lib/server.js');
  assert.ok(/'\/pulls'/.test(server), 'the /pulls alias is gone');
  // The board is a pane on the advocates page now (bc-d4d5), so what used to be checked
  // of prs.html is checked of the page that absorbed it — and one thing more, that the
  // three old paths land on that page rather than on nothing.
  assert.ok(
    /urlPath === '\/prs' \|\| urlPath === '\/pulls' \|\| urlPath === '\/prs\.html'/.test(server),
    'the board’s three paths no longer land together'
  );
  const html = read('public/monitor.html');
  assert.ok(html.includes('/viewbar.js'), 'the board lost the pill row, which is the only way off it');
  assert.ok(html.includes('/prcard.js'), 'the board does not load the shared renderer');
  assert.ok(html.indexOf('/prcard.js') < html.indexOf('/prs.js'), 'prs.js runs before the renderer it uses');
  assert.ok(/data-tab="prs"/.test(html), 'there is no PRs chip, so nothing points at the board again');
});

/* One full-screen view of a pull request, reached from both screens that draw its row.
   The sheet is the inbox's (bc-l8jp.7) and the board links into it rather than growing a
   second one — which is only true while the two halves of that link agree, and neither
   half can be read from the other file. */
await check('the board reaches the inbox’s full view rather than drawing its own', () => {
  const board = read('public/prs.js');
  assert.ok(
    /href="\/#\$\{encodeURIComponent\(`pr:\$\{p\.key\}`\)\}"/.test(board),
    'the board no longer links into the inbox by the key its deep links use'
  );
  assert.ok(!/class="card pr-card open"/.test(board), 'the board has grown a full-screen sheet of its own');
  const app = read('public/app.js');
  // `pr:` + the board's own `<workspace>#<number>` is what byKey resolves; the board
  // writes that string and the inbox reads it, and there is nothing between them.
  assert.ok(/startsWith\('pr:'\)/.test(app), 'the inbox no longer resolves a pr: key at all');
  // And the widening, which is what makes the link land on the rows the board is *about*:
  // the inbox's status default is `unmerged` and every merged-not-shipped row is hidden
  // under it, so without this a Full view on the board's whole subject opens nothing.
  assert.ok(/function revealPr\(row\)/.test(app), 'the inbox cannot widen for a hidden pull request');
  assert.ok(/revealPr\(byKey\(key\)\)/.test(app), 'and nothing calls it from the deep-link path');
});

await check('the inbox loads the renderer before the filter that reads its ladder', () => {
  const html = read('public/index.html');
  // The `src=` and not the bare path: both files are named in prose in this document, and
  // the prose comes first.
  const at = (f) => html.indexOf(`src="${f}"`);
  const card = at('/prcard.js');
  const filter = at('/inboxfilter.js');
  const app = at('/app.js');
  assert.ok(card > 0, 'the inbox does not load prcard.js at all');
  assert.ok(card < filter, 'the filter builds its status chips before the ladder exists');
  assert.ok(filter < app, 'app.js runs before the control it mounts');
});

await check('the service worker ships it, on a version a cached phone will notice', () => {
  const sw = read('public/sw.js');
  assert.ok(sw.includes("'/prcard.js'"), 'not in SHELL');
  const version = Number(sw.match(/const CACHE = 'beadcause-v(\d+)'/)?.[1]);
  // Five files changed together — the navigation (public/viewbar.js, public/tabbar.js as
  // was), app.js, inboxfilter.js, prs.js and this new one. Any older cache beside any of
  // them is an app that looks complete and is not.
  assert.ok(version >= 25, `CACHE is still v${version} — the five cannot arrive together`);
});

await check('a closed pull request never becomes an inbox card', () => {
  const app = read('public/app.js');
  assert.ok(/stage !== 'closed'/.test(app), 'the inbox would carry pull requests no filter offers');
  assert.ok(/BOARD_MS/.test(app) && /prsWanted\(\)/.test(app), 'the board is fetched on the inbox’s own poll');
});

console.log(`\n${failures ? `\x1b[31m${failures} of ${ran} failed\x1b[0m` : `\x1b[32mall ${ran} checks passed\x1b[0m`}\n`);
process.exit(failures ? 1 : 0);
