#!/usr/bin/env node
/**
 * One hash grammar, and the links that were minted before it existed (bc-khoe.30.2).
 *
 *     npm test
 *     node test/hashgrammar.mjs
 *
 * The URL hash is one slot with two claimants. It has meant `#<workspace>/<beadId>` — a
 * card to open on Home — since the app had notifications, and bc-khoe.30 wants it for
 * moving between views (`/#history`, `/#advocates`) so a pill tap costs a `display:none`
 * rather than a document load. public/hashroute.js is the one place that decides which of
 * those a given hash is; this is the suite that holds it to it.
 *
 * Four claims, and each is a way the two grammars can collide:
 *
 * 1. **The old links cannot break.** `lib/notify.js` and `lib/slack.js` mint
 *    `${baseUrl}/#${encodeURIComponent(q.key)}` and those URLs are not ours any more —
 *    they are in a notification shade, a Slack channel and the phone's own notification
 *    history, and there is no migration available for any of them. So the minting line is
 *    asserted to still be that line, and the grammar is asserted to read it back to
 *    exactly the key that went in. Both halves, because either one alone passes while the
 *    link is broken.
 *
 * 2. **A view hash is a view.** The bare names are a closed list of three and nothing
 *    else is one.
 *
 * 3. **A card hash means Home, whatever is showing.** `parse` answers with a view for
 *    every hash, and for a card that view is always Home — a deep link names a question
 *    and questions live on Home. Encoded in the module rather than at the call site
 *    because after bc-khoe.30.3 there are several panes and the answer must not depend on
 *    which one happens to be up.
 *
 * 4. **An unrecognised hash falls to Home and changes nothing.** This is the bug the bead
 *    exists to prevent, and it is not hypothetical: `focusHash` in public/app.js read
 *    *every* hash as a key, and its not-found branch widens a persisted scope filter and
 *    reloads. `/#history` landing on Home under that code silently changed a filter on
 *    its way to doing nothing. So the grammar is checked, and then app.js is checked
 *    against the grammar — the second is the one that would have caught it.
 *
 * The module touches no DOM and reads no `location` at load, so the whole grammar runs in
 * a `node:vm` with an empty context and is asserted directly rather than through a
 * browser. The wiring — that both readers go through it, and that every page which loads
 * either of them loads it first — is static text, because a script tag is markup and no
 * amount of unit testing sees a missing one. See [[render-a-page-in-a-vm-not-a-browser]]'s
 * third option, and test/prstage.mjs, whose `prCard` lift this copies.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failures = 0;
let ran = 0;
const check = (name, fn) => {
  ran += 1;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${err.message}`);
  }
};

/** public/hashroute.js in a room of its own. It touches nothing at load. */
const route = (() => {
  const window = {};
  const ctx = vm.createContext({ window });
  vm.runInContext(read('public/hashroute.js'), ctx, { filename: 'hashroute.js' });
  return ctx.window.beadcause.route;
})();

console.log('\nthe grammar');

check('it loads with no document, no location and no history', () => {
  assert.ok(route, 'public/hashroute.js did not put a route on window.beadcause');
  for (const fn of ['parse', 'hashFor', 'hashForCard', 'viewOfPath', 'go']) {
    assert.equal(typeof route[fn], 'function', `route.${fn} is missing`);
  }
});

/* -------------------------------------------------- 1. the links already minted */

console.log('\nthe links that are already on phones');

/*
  The exact expression the daemon builds a notification's `click` out of. Asserted as
  source text rather than by calling `pushQuestion`, because what has to hold is that
  nobody rewrites the line — a refactor that changed the encoding would pass any test
  that went through the function it lives in, and would break every URL already sent.
*/
const MINT = '`${cfg.baseUrl}/#${encodeURIComponent(q.key)}`';

check('lib/notify.js still mints the hash the grammar reads', () => {
  const src = read('lib/notify.js');
  const n = src.split(MINT).length - 1;
  assert.ok(n >= 1, `lib/notify.js no longer builds a click URL as ${MINT}`);
});

check('and lib/slack.js mints the same one', () => {
  assert.ok(read('lib/slack.js').includes(MINT), `lib/slack.js no longer links as ${MINT}`);
});

check('a bead key survives the round trip, encoded slash and all', () => {
  const key = 'beadcause/bc-khoe.30.2';
  const hash = route.hashForCard(key);
  assert.equal(hash, '#beadcause%2Fbc-khoe.30.2', 'the slash has to be encoded — that is the form on the phones');
  const at = route.parse(hash);
  assert.equal(at.kind, 'card');
  assert.equal(at.key, key);
});

check('every key shape the app mints reads back as a card', () => {
  // A bead, a pull request and a JIRA ticket — the three `byKey` in public/app.js knows.
  for (const key of ['beadcause/bc-khoe.30.2', 'climative/athena-service/cl-1a2b', 'pr:beadcause#422', 'jira:TECH-1234']) {
    const at = route.parse(route.hashForCard(key));
    assert.equal(at.kind, 'card', `${key} was not read as a card`);
    assert.equal(at.key, key, `${key} did not survive the round trip`);
  }
});

check('a hash a phone sent unencoded is read the same way', () => {
  // Nothing mints this, but a hand-typed or shell-mangled URL arrives with a bare slash
  // and it names the same card. The decode is a no-op over it and the shape still holds.
  // Spread first: the module runs in a `vm` realm, so its objects have that realm's
  // prototype and `deepEqual` — which is reference-equal on prototypes — refuses a pair
  // that is otherwise identical. This bites every structural assertion in this file.
  assert.deepEqual({ ...route.parse('#beadcause/bc-khoe') }, {
    kind: 'card',
    view: 'epics',
    key: 'beadcause/bc-khoe',
    raw: 'beadcause/bc-khoe',
  });
});

check('a hash that will not decode does not throw out of boot', () => {
  // `decodeURIComponent('%')` throws, and this runs from inside load() on every page.
  assert.doesNotThrow(() => route.parse('#%'));
  assert.equal(route.parse('#%').kind, 'none');
  assert.doesNotThrow(() => route.parse(undefined));
  assert.doesNotThrow(() => route.parse(null));
});

/* ------------------------------------------------------------- 2. a view hash */

console.log('\na view hash');

check('each of the three views is named by exactly one hash, and Home by none', () => {
  const ids = [...route.VIEWS].map((v) => v.id);
  assert.deepEqual(ids, ['epics', 'history', 'advocates']);
  assert.equal(route.hashFor('epics'), '', 'Home is the empty hash — every existing link says it by saying nothing');
  assert.equal(route.hashFor('history'), '#history');
  assert.equal(route.hashFor('advocates'), '#advocates');
  assert.equal(route.hashFor('flow'), null, 'a page that is not a view has no hash, and null is how that is said');
  const hashes = [...route.VIEWS].map((v) => v.hash);
  assert.equal(new Set(hashes).size, hashes.length, 'two views claim one hash');
});

check('a view hash parses as its view and names no card', () => {
  for (const v of route.VIEWS.filter((one) => one.hash)) {
    const at = route.parse(v.hash);
    assert.equal(at.kind, 'view', `${v.hash} is not a view`);
    assert.equal(at.view, v.id);
    assert.equal(at.key, null, `${v.hash} produced a key`);
  }
});

check('an empty hash is Home rather than nothing at all', () => {
  for (const empty of ['', '#', undefined, null]) {
    const at = route.parse(empty);
    assert.equal(at.kind, 'view', `${JSON.stringify(empty)} is not a view`);
    assert.equal(at.view, route.HOME);
    assert.equal(at.key, null);
  }
});

check('no view name can ever be mistaken for a key, or a key for a view name', () => {
  // The two halves are told apart by shape, so this is the property that keeps them
  // apart: a view name with a `/` or a `pr:`/`jira:` prefix in it would be both.
  for (const v of route.VIEWS) {
    assert.ok(!v.id.includes('/') && !v.id.includes(':'), `the view id ${v.id} has a key's shape`);
  }
});

check('and the other half of the same question: which view an address names', () => {
  // The nine addresses that are all the advocate console, the two that are Home, and the
  // five pages that draw the pill row and are on no pill. `viewOfPath` is what
  // bc-khoe.30.7 will land an old path on the right pane with, and what the row already
  // lights itself by.
  assert.equal(route.viewOfPath('/'), 'epics');
  assert.equal(route.viewOfPath('/index.html'), 'epics');
  assert.equal(route.viewOfPath('/history'), 'history');
  assert.equal(route.viewOfPath('/history.html'), 'history');
  for (const p of ['/monitor', '/advocates', '/monitor.html', '/sessions', '/work', '/work.html', '/prs', '/pulls', '/prs.html']) {
    assert.equal(route.viewOfPath(p), 'advocates', `${p} is the advocate console`);
  }
  for (const p of ['/flow', '/requirements', '/endorse', '/admin', '/console']) {
    assert.equal(route.viewOfPath(p), null, `${p} draws the row and is on no pill — that is deliberate`);
  }
});

check('a trailing slash is the same address, and no address is claimed twice', () => {
  assert.equal(route.viewOfPath('/history/'), 'history');
  assert.equal(route.viewOfPath('///'), 'epics');
  assert.equal(route.viewOfPath(''), 'epics');
  assert.equal(route.viewOfPath(undefined), 'epics');
  const all = [...route.VIEWS].flatMap((v) => [...v.paths]);
  assert.equal(new Set(all).size, all.length, 'two views claim one address');
});

/* ---------------------------------- 3. a card arriving while another view shows */

console.log('\na card hash arriving while a non-Home pane is showing');

check('the answer is Home, from every view and every address', () => {
  const at = route.parse('#beadcause%2Fbc-khoe.30.2');
  assert.equal(at.view, route.HOME, 'a card must open on Home whatever was showing');
  // The address it arrived at makes no difference either — the same hash on /monitor is
  // the same card on Home. This is what stops a pane trying to draw a card it has none of.
  for (const p of ['/monitor', '/history', '/work.html', '/']) {
    assert.equal(route.parse('#beadcause%2Fbc-khoe.30.2').view, route.HOME, `arriving at ${p}`);
  }
});

check('and `view` is answerable for every hash, so no caller has to test `kind` first', () => {
  for (const h of ['', '#history', '#beadcause%2Fbc-x', '#wat', '#%', '#pr:beadcause#422']) {
    const at = route.parse(h);
    assert.ok(route.VIEWS.some((v) => v.id === at.view), `${h} produced no view`);
    assert.equal(at.key === null, at.kind !== 'card', `${h} disagrees about whether it names a card`);
  }
});

check('one slot, so the last write wins and nothing is held twice', () => {
  // There is no combined form to parse, and the reason is decision 2: a card already
  // names its view, so there is nothing to hold alongside it.
  assert.equal(route.parse('#history/beadcause/bc-x').kind, 'card', 'a slash makes it a key, not a pair');
  assert.equal(route.parse('#history/beadcause/bc-x').view, route.HOME);
});

/* --------------------------------------------------- 4. an unrecognised hash */

console.log('\nan unrecognised hash');

check('it falls to Home, names no card, and is not mistaken for a view', () => {
  for (const h of ['#wat', '#monitor', '#Home', '#HISTORY', '#history2', '#%', '#a b c']) {
    const at = route.parse(h);
    assert.equal(at.kind, 'none', `${h} was read as something`);
    assert.equal(at.view, route.HOME, `${h} did not fall to Home`);
    assert.equal(at.key, null, `${h} produced a key`);
  }
});

/*
  And the half that matters more than the grammar: what public/app.js does with it.

  `focusHash` used to be `decodeURIComponent(location.hash.replace(/^#/, ''))` handed
  straight to `byKey`, and the not-found branch widens `state.scope` from `agent` to
  `both`, writes it to localStorage and reloads. That rescue is right for a deep link to a
  card the current scope hides and wrong for everything else — so under the old code every
  hash that was not a key ran it, and `/#history` on Home changed a filter you had set.
  The fix is one line: only a `card` gets past the top of the function. Asserted as source
  text because the alternative is booting the whole inbox in a fake DOM to watch a
  localStorage write that must not happen.
*/
check('public/app.js reads the hash through the grammar and acts only on a card', () => {
  const src = read('public/app.js');
  assert.ok(
    /async function focusHash\(\)\s*\{[\s\S]{0,400}?window\.beadcause\.route\.parse\(location\.hash\)/.test(src),
    'focusHash no longer parses the hash through public/hashroute.js'
  );
  assert.ok(
    /async function focusHash\(\)\s*\{[\s\S]{0,400}?kind !== 'card'/.test(src),
    "focusHash no longer leaves early for a hash that is not a card — the scope-widening bug is back"
  );
  assert.ok(
    !/decodeURIComponent\(location\.hash/.test(src),
    'public/app.js is decoding the hash itself again, which is a second grammar'
  );
});

check('and it is the only file in public/ that reads the hash as a route', () => {
  // The three `location.pathname + location.hash` lines that preserve a hash across a
  // replaceState are not readers of it, so the test is for the two ways of *asking what
  // it says* rather than for the string.
  for (const f of fs.readdirSync(path.join(ROOT, 'public')).filter((n) => n.endsWith('.js'))) {
    if (f === 'hashroute.js') continue;
    const src = read(path.join('public', f));
    assert.ok(
      !/location\.hash\.(replace|slice|substring|split)/.test(src),
      `public/${f} is taking the hash apart itself — that belongs in public/hashroute.js`
    );
  }
});

/* ------------------------------------------------------------------ the wiring */

console.log('\nboth readers go through it, and every page that loads them loads it first');

check('public/viewbar.js asks which view an address is rather than holding the table', () => {
  const src = read('public/viewbar.js');
  assert.ok(src.includes('route.viewOfPath(location.pathname)'), 'viewbar.js no longer asks hashroute.js what view it is on');
  assert.ok(!/^\s*paths:/m.test(src), 'the paths table is back in viewbar.js — there are two answers again');
  assert.ok(!/\['\/', '\/index\.html'\]/.test(src), 'viewbar.js is deciding what Home is again');
});

check('the pill ids and the view ids are the same words', () => {
  // The row lights the pill named by the view. Two vocabularies would be one more thing
  // to keep in step, and it is what `lit = route.HOME` above depends on.
  const src = read('public/viewbar.js');
  const pills = [...src.matchAll(/\{ id: '([a-z]+)'/g)].map((m) => m[1]);
  assert.ok(pills.length >= 7, `could not read the pill list out of viewbar.js: ${pills.join(', ')}`);
  for (const v of route.VIEWS) assert.ok(pills.includes(v.id), `the view ${v.id} has no pill of that name`);
});

check('every page that loads viewbar.js or app.js loads hashroute.js before it', () => {
  const pages = fs.readdirSync(path.join(ROOT, 'public')).filter((n) => n.endsWith('.html'));
  let seen = 0;
  for (const page of pages) {
    const src = read(path.join('public', page));
    const at = (f) => src.indexOf(`src="/${f}"`);
    const needs = ['viewbar.js', 'app.js'].filter((f) => at(f) >= 0);
    if (!needs.length) continue;
    seen += 1;
    const mine = at('hashroute.js');
    assert.ok(mine >= 0, `public/${page} loads ${needs.join(' and ')} and never loads hashroute.js`);
    for (const f of needs) {
      assert.ok(mine < at(f), `public/${page} loads hashroute.js after ${f}, so the call on boot throws`);
    }
  }
  assert.equal(seen, 9, `expected the nine pages that draw the pill row, found ${seen}`);
});

check('and the service worker precaches it, because both callers call it flat', () => {
  const sw = read('public/sw.js');
  assert.ok(/^\s*'\/hashroute\.js',/m.test(sw), "'/hashroute.js' is not in the service worker's SHELL");
});

/* ------------------------------------------------------------------- writing it */

console.log('\nwriting the slot');

check('setting a view hash writes it', () => {
  const loc = { hash: '#beadcause%2Fbc-x', pathname: '/', search: '' };
  route.go(route.hashFor('history'), loc);
  assert.equal(loc.hash, '#history', 'the card that was in the slot should be gone — one slot, last write wins');
});

check('clearing it leaves no bare # on the URL', () => {
  // `location.hash = ''` leaves a `#` hanging, and `${baseUrl}/#` is a different URL from
  // the `${baseUrl}/` a phone's home screen holds.
  const loc = { hash: '#history', pathname: '/', search: '' };
  let wrote = null;
  route.go(route.hashFor('epics'), loc, { replaceState: (_s, _t, url) => (wrote = url) });
  assert.equal(wrote, '/', 'Home was not written with replaceState');
  assert.equal(loc.hash, '#history', 'replaceState is what clears it; the hash must not also be assigned');
});

check('and a query survives being sent Home', () => {
  const loc = { hash: '#history', pathname: '/', search: '?kind=pr' };
  let wrote = null;
  route.go('', loc, { replaceState: (_s, _t, url) => (wrote = url) });
  assert.equal(wrote, '/?kind=pr');
});

check('with nowhere to write, it says so rather than throwing', () => {
  assert.equal(route.go('#history', null), false);
});

console.log(
  failures ? `\n\x1b[31m${failures} of ${ran} checks failed\x1b[0m` : `\n\x1b[32mall ${ran} checks passed\x1b[0m`
);
process.exit(failures ? 1 : 0);
