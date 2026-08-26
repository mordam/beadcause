#!/usr/bin/env node
/**
 * Repo views — a screen a repo declares about itself, and the grammar it plugs into.
 *
 *     npm test
 *     node test/repoviews.mjs
 *
 * The feature is two halves that fail in completely different ways, so this suite is two
 * halves too.
 *
 * **The server half is about reach.** A manifest is a file in somebody else's checkout
 * naming other files in that checkout, and every one of those names is resolved against a
 * prefix. The interesting cases are all the ones where a name tries to leave: a parent-
 * directory step, an absolute path, a symlink out — and the symlink is the one a shape
 * check cannot catch, which is why `resolveAsset` calls `realpath` and why there is a real
 * symlink in a real temporary directory below rather than a mock of one. A test that
 * checked the regex would have passed on the day the symlink case was written wrong.
 *
 * **The browser half is about the grammar staying one grammar.** A repo view is admitted
 * to `route.VIEWS` at runtime, gets a container adopted into the pane map, and gets a pill
 * appended to the row — three files that were written when the view list was closed. What
 * is worth asserting is not that each of them has a new function but that the *existing*
 * rules still decide everything: the pill is a `<button>` because `panes.has` says the
 * pane is here, the hash falls back to Home when it names nothing, and a repo id can never
 * be read as a bead card key.
 *
 * That last one is the whole reason a view id is `<workspace>.<id>` with a dot. Decision 1
 * in public/hashroute.js reads a `/` or a `pr:`/`jira:` prefix as the shape of a card, so
 * `#deluvia/studio` would parse as a bead nobody has — the pill would open the inbox and
 * hunt for it. There is a check for exactly that below, because it is the kind of thing
 * that works in every manual test (nobody types a hash) and fails on the one tap.
 *
 * The payload half — cache, ttl, a generator that fails after working — is asserted
 * against a real spawned process, because the property being checked is that a *failed*
 * run does not evict a *good* payload, and that is a fact about the sequence rather than
 * about any one call.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  viewId,
  splitViewId,
  viewsIn,
  resolveAsset,
  allViews,
  findView,
  payloadFor,
  forgetPayloads,
  VIEW_DIR,
  MANIFEST,
  GENERATOR_HEADER,
  GENERATOR_CODE,
} from '../lib/repoviews.js';

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

/* ============================================================ a repo on disk */

/**
 * A throwaway checkout with a `.beadcause/` in it.
 *
 * Real files in a real directory, because half of what is under test is `realpath` and a
 * fake filesystem would be asserting against the mock. `sessionDirs` is how the config
 * pins a workspace to a directory outright (see `resolvePlainSessionDir` in lib/session.js),
 * which is the shortest honest way to say "this workspace is that checkout" without
 * building a beads tracker.
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-repoviews-'));
const repo = path.join(tmp, 'somerepo');
const viewDir = path.join(repo, VIEW_DIR);
fs.mkdirSync(viewDir, { recursive: true });

const cfg = { sessionDirs: { somerepo: repo }, workspaces: [{ name: 'somerepo', dir: path.join(repo, '.beads') }] };
const WS = [{ name: 'somerepo', dir: path.join(repo, '.beads') }];

const writeManifest = (doc) =>
  fs.writeFileSync(path.join(viewDir, MANIFEST), typeof doc === 'string' ? doc : JSON.stringify(doc));

fs.writeFileSync(path.join(viewDir, 'board.js'), '// a view\n');
fs.writeFileSync(path.join(viewDir, 'board.css'), '/* a view */\n');
// The secret this feature must never be able to hand out, one level above the view
// directory — which is exactly where a repo's real files are.
fs.writeFileSync(path.join(repo, 'secrets.env'), 'TOKEN=hunter2\n');
// And the same secret reachable by a link that lives *inside* the view directory, which
// no amount of string checking can see.
fs.symlinkSync(path.join(repo, 'secrets.env'), path.join(viewDir, 'sneaky.css'));

/* ==================================================== the id, and the card grammar */

console.log('\nthe view id');

await check('a view id is <workspace>.<id>, and splits back into both', () => {
  assert.equal(viewId('deluvia', 'studio'), 'deluvia.studio');
  assert.deepEqual(splitViewId('deluvia.studio'), { workspace: 'deluvia', id: 'studio' });
});

await check('an id with no workspace, or an unusable one, splits to nothing', () => {
  assert.equal(splitViewId('studio'), null, 'a bare word names no workspace');
  assert.equal(splitViewId('.studio'), null, 'an empty workspace is not one');
  assert.equal(splitViewId('deluvia.Studio'), null, 'ids are lowercase');
  assert.equal(splitViewId('deluvia.a.b'), null, 'a second dot makes the split ambiguous');
});

/* ================================================================ the manifest */

console.log('\nwhat a repo declares');

await check('a workspace with no manifest declares nothing, and that is not a fault', () => {
  const bare = path.join(tmp, 'nomanifest');
  fs.mkdirSync(path.join(bare, VIEW_DIR), { recursive: true });
  const out = viewsIn({ sessionDirs: { nomanifest: bare } }, { name: 'nomanifest', dir: path.join(bare, '.beads') });
  assert.deepEqual(out.views, []);
  assert.deepEqual(out.problems, [], 'an absent manifest is the default, not a problem');
});

await check('a good manifest yields a view with its pill, its urls and its address', () => {
  writeManifest({
    views: [{ id: 'board', label: 'Board', icon: '🎬', script: 'board.js', style: 'board.css', data: { run: ['echo', '{}'], ttl: 5 } }],
  });
  const { views, problems } = viewsIn(cfg, WS[0]);
  assert.deepEqual(problems, []);
  assert.equal(views.length, 1);
  const v = views[0];
  assert.equal(v.view, 'somerepo.board');
  assert.equal(v.label, 'Board');
  assert.equal(v.scriptUrl, '/v/somerepo/board/asset/board.js');
  assert.equal(v.styleUrl, '/v/somerepo/board/asset/board.css');
  assert.equal(v.dataUrl, '/api/views/somerepo/board/data');
  assert.equal(v.path, '/v/somerepo/board');
  assert.equal(v.ttl, 5);
});

await check('a view with no generator has no data url, and is still a view', () => {
  writeManifest({ views: [{ id: 'board', script: 'board.js' }] });
  const v = viewsIn(cfg, WS[0]).views[0];
  assert.equal(v.dataUrl, '', 'nothing to fetch');
  assert.equal(v.run, null);
  assert.equal(v.label, 'board', 'a missing label falls back to the id rather than refusing');
});

await check('a manifest that will not parse is one sentence, not an exception', () => {
  writeManifest('{ not json');
  const { views, problems } = viewsIn(cfg, WS[0]);
  assert.deepEqual(views, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /will not parse/);
});

await check('a bad entry is reported and the good ones beside it still arrive', () => {
  writeManifest({
    views: [
      { id: 'Board', script: 'board.js' },
      { id: 'board', script: 'board.js' },
      { id: 'ghost', script: 'nothere.js' },
      { id: 'board', script: 'board.js' },
    ],
  });
  const { views, problems } = viewsIn(cfg, WS[0]);
  assert.deepEqual(views.map((v) => v.id), ['board'], 'the one usable entry survives');
  assert.equal(problems.length, 3, 'the capital, the missing script and the duplicate');
  assert.ok(problems.some((p) => /not a usable view id/.test(p)));
  assert.ok(problems.some((p) => /is not there/.test(p)));
  assert.ok(problems.some((p) => /two views both call themselves/.test(p)));
});

await check('a command string where an argv belongs is refused, and said so', () => {
  writeManifest({ views: [{ id: 'board', script: 'board.js', data: { run: 'python3 gen.py; rm -rf /' } }] });
  const { views, problems } = viewsIn(cfg, WS[0]);
  assert.equal(views[0].run, null, 'nothing will be spawned');
  assert.ok(problems.some((p) => /argv array/.test(p)));
});

/* ============================================================= what it may reach */

console.log('\nwhat a manifest may name');

await check('a file inside the view directory resolves', () => {
  const out = resolveAsset(cfg, 'somerepo', 'board.js');
  assert.equal(out.problem, undefined);
  assert.equal(fs.realpathSync(path.join(viewDir, 'board.js')), out.full);
});

await check('a step out of the view directory is refused on its shape', () => {
  for (const bad of ['../secrets.env', '/etc/passwd', 'sub/../../secrets.env', '']) {
    const out = resolveAsset(cfg, 'somerepo', bad);
    assert.ok(out.problem, `${bad} resolved, and must not have`);
    assert.equal(out.full, undefined);
  }
});

await check('a symlink out of the view directory is refused too — the case a regex cannot see', () => {
  // `sneaky.css` passes every shape check there is: no dots, no slashes, no absolute path.
  // It is a link to the repo's secrets, and only `realpath` can tell.
  const out = resolveAsset(cfg, 'somerepo', 'sneaky.css');
  assert.ok(out.problem, 'a symlink out of the prefix was served');
  assert.match(out.problem, /links outside/);
});

await check('a workspace whose checkout does not resolve reaches nothing', () => {
  const out = resolveAsset({ sessionDirs: {} }, 'nosuchworkspace', 'board.js');
  assert.ok(out.problem);
});

/* ================================================================= the payload */

console.log('\nthe payload, and what a broken generator costs');

const genPath = path.join(viewDir, 'gen.mjs');
const writeGen = (body) => fs.writeFileSync(genPath, body);

await check('a generator that prints JSON is the payload, and the next read is held', async () => {
  forgetPayloads();
  // `hrtime` rather than `Date.now()`: two spawns can land in the same millisecond, and
  // 'the refresh gave me the held payload' is exactly what that would look like.
  writeGen('console.log(JSON.stringify({ n: String(process.hrtime.bigint()) }));\n');
  writeManifest({
    views: [{ id: 'board', script: 'board.js', data: { run: [process.execPath, path.join(VIEW_DIR, 'gen.mjs')], ttl: 60 } }],
  });
  const v = findView(cfg, WS, 'somerepo.board');
  const first = await payloadFor(cfg, v);
  assert.equal(first.stale, false);
  assert.equal(typeof first.data.n, 'string');
  const second = await payloadFor(cfg, v);
  assert.equal(second.data.n, first.data.n, 'inside the ttl it is the held one, not a second run');
});

await check('concurrent callers share one process rather than each starting their own', async () => {
  forgetPayloads();
  const v = findView(cfg, WS, 'somerepo.board');
  const [a, b, c] = await Promise.all([payloadFor(cfg, v), payloadFor(cfg, v), payloadFor(cfg, v)]);
  assert.equal(a.data.n, b.data.n);
  assert.equal(b.data.n, c.data.n);
});

await check('?refresh spends a real run', async () => {
  const v = findView(cfg, WS, 'somerepo.board');
  const held = await payloadFor(cfg, v);
  // The generator stamps a monotonic clock, so a genuinely fresh run cannot repeat it.
  const fresh = await payloadFor(cfg, v, { refresh: true });
  assert.notEqual(fresh.data.n, held.data.n, 'refresh returned the held payload');
});

await check('a generator that breaks does NOT blank the board — the last good one comes back stale', async () => {
  const v = findView(cfg, WS, 'somerepo.board');
  const good = await payloadFor(cfg, v, { refresh: true });
  writeGen('console.error("the studio caught fire"); process.exit(3);\n');
  const after = await payloadFor(cfg, v, { refresh: true });
  assert.deepEqual(after.data, good.data, 'the last good payload was thrown away');
  assert.equal(after.stale, true);
  assert.match(after.problem, /caught fire/, "the generator's own last words are what is reported");
});

await check('a generator that has never worked is a refusal with a reason, not an empty board', async () => {
  forgetPayloads();
  writeGen('console.log("this is not json");\n');
  const v = findView(cfg, WS, 'somerepo.board');
  const out = await payloadFor(cfg, v, { refresh: true });
  assert.equal(out.data, undefined);
  assert.match(out.problem, /did not print JSON/);
});

await check('a view with no generator says so rather than spawning anything', async () => {
  writeManifest({ views: [{ id: 'board', script: 'board.js' }] });
  const out = await payloadFor(cfg, findView(cfg, WS, 'somerepo.board'), {});
  assert.match(out.problem, /no "data.run"/);
});

await check('allViews walks every workspace and keeps the config order', () => {
  writeManifest({ views: [{ id: 'board', script: 'board.js' }] });
  const { views } = allViews(cfg, [...WS, { name: 'nosuchworkspace', dir: '/nowhere/.beads' }]);
  assert.deepEqual(views.map((v) => v.view), ['somerepo.board']);
});

/* ========================================================= the browser half */

/** Just enough of an element for the three files under test. Same shape as test/panes.mjs. */
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
class El {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.parent = null;
    this.attrs = {};
    this.dataset = {};
    this.listeners = new Map();
    this.className = '';
    this.hidden = false;
    this.scrollTop = 0;
    this.innerHTML = '';
  }
  get classList() {
    return { contains: (c) => this.classes().includes(c) };
  }
  classes() {
    return String(this.className || '').split(/\s+/).filter(Boolean);
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k.startsWith('data-')) this.dataset[camel(k.slice(5))] = String(v);
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  append(...nodes) {
    for (const n of nodes) {
      n.parent = this;
      this.children.push(n);
    }
  }
  after(node) {
    const at = this.parent.children.indexOf(this);
    node.parent = this.parent;
    this.parent.children.splice(at + 1, 0, node);
  }
  insertBefore(node, ref) {
    const at = ref ? this.children.indexOf(ref) : this.children.length;
    node.parent = this;
    this.children.splice(at === -1 ? this.children.length : at, 0, node);
  }
  /** What `<head>` is asked for — the host appends a stylesheet and a script to it. */
  appendChild(node) {
    this.append(node);
    return node;
  }
  remove() {
    if (!this.parent) return;
    const at = this.parent.children.indexOf(this);
    if (at !== -1) this.parent.children.splice(at, 1);
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  fire(type, ev) {
    for (const fn of this.listeners.get(type) || []) fn(ev);
  }
  walk() {
    return this.children.flatMap((c) => [c, ...c.walk()]);
  }
  matches(sel) {
    const attr = sel.match(/^\[([-\w]+)(?:="([^"]*)")?\]$/);
    if (attr) {
      const got = this.attrs[attr[1]];
      return attr[2] == null ? got != null : got === attr[2];
    }
    if (sel.startsWith('.')) return this.classes().includes(sel.slice(1));
    return this.tag === sel;
  }
  querySelectorAll(sel) {
    return this.walk().filter((el) => el.matches(sel));
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
}

function pane(id) {
  const el = new El('div');
  el.className = 'pane';
  el.setAttribute('data-pane', id);
  const s = new El('main');
  s.className = 'list pagescroll';
  el.append(s);
  return el;
}

/** The grammar, the panes and the row, over a body of containers. */
function boot(panes, { hash = '', pathname = '/', views = null } = {}) {
  const body = new El('body');
  const topbar = new El('header');
  topbar.className = 'topbar';
  body.append(topbar, ...panes);
  const location = { pathname, search: '', hash };
  const listeners = new Map();
  const setFromUrl = (url) => {
    location.hash = String(url).includes('#') ? String(url).slice(String(url).indexOf('#')) : '';
  };
  const ctx = {
    location,
    history: { pushState: (_s, _t, u) => setFromUrl(u), replaceState: (_s, _t, u) => setFromUrl(u) },
    document: {
      body,
      head: new El('head'),
      readyState: 'complete',
      currentScript: null,
      createElement: (tag) => new El(tag),
      getElementById: () => null,
      addEventListener() {},
      querySelector: (sel) => (body.matches(sel) ? body : body.querySelector(sel)),
      querySelectorAll: (sel) => body.querySelectorAll(sel),
    },
    console,
    // A `node:vm` context has none of these, and the host uses all three: `URLSearchParams`
    // is the shape a view's query is handed over in, and the two timers are how a `build`
    // that throws is rethrown out of the loop rather than taking the other views with it.
    URLSearchParams,
    setTimeout,
    clearTimeout,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    /* Only for the section that runs public/viewhost.js, which asks `/api/views` on boot
       and hosts whatever comes back. Absent otherwise, which the host copes with — a
       failed discovery is a console line and the pills it would have added, and nothing
       else. */
    ...(views
      ? { fetch: async (path) => ({ ok: true, json: async () => (path === '/api/views' ? { views } : {}) }) }
      : {}),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('public/hashroute.js'), ctx, { filename: 'hashroute.js' });
  const run = (file) => vm.runInContext(read(`public/${file}`), ctx, { filename: file });
  const navigate = (next) => {
    location.hash = next;
    for (const fn of listeners.get('hashchange') || []) fn();
  };
  return { ctx, body, topbar, run, navigate, bc: () => ctx.window.beadcause };
}

/** Every pill the row emitted. The id class is wide enough for a repo view's dotted id. */
const pills = (nav) =>
  [...nav.innerHTML.matchAll(/<(\w+) class="viewpill" data-pill="([^"]+)"([^>]*)>/g)].map((m) => ({
    tag: m[1],
    id: m[2],
    href: /href="([^"]*)"/.exec(m[3])?.[1] ?? null,
    pane: /data-pane="([^"]*)"/.exec(m[3])?.[1] ?? null,
    current: m[3].includes('aria-current="page"'),
  }));

console.log('\nadmitting a repo view to the grammar');

await check('a view id can never be read as a bead card key — the whole reason it is a dot', () => {
  const grammar = boot([]);
  const at = grammar.ctx.window.beadcause.route.parse('#deluvia.studio');
  // Before `add`, it is nonsense that falls to Home. What it must never be is a *card*:
  // that is the failure this shape prevents, and it is silent — the pill would switch to
  // the inbox and hunt for a bead nobody has.
  assert.equal(at.kind, 'none', 'an unknown view hash is nonsense, not a card');
  assert.equal(at.view, 'epics');
  // And the shape that would have been a card, for contrast.
  assert.equal(grammar.ctx.window.beadcause.route.parse('#deluvia%2Fstudio').kind, 'card');
});

await check('an unknown id is refused, and the five this app is cannot be shadowed', () => {
  const b = boot([pane('epics')]);
  const route = b.bc().route;
  assert.equal(route.add({ id: 'studio' }), false, 'a bare name is not a repo view id');
  assert.equal(route.add({ id: 'deluvia/studio' }), false, 'that shape is a card key');
  assert.equal(route.add({ id: 'history' }), false, 'a built-in view may not be taken over');
  assert.equal(route.add({ id: 'deluvia.studio' }), true);
  assert.equal(route.add({ id: 'deluvia.studio' }), false, 'and not twice');
});

await check('once added, a repo view is a view like any other — hash, parse and paths', () => {
  const b = boot([pane('epics')]);
  const route = b.bc().route;
  route.add({ id: 'deluvia.studio', paths: ['/v/deluvia/studio'] });
  assert.equal(route.hashFor('deluvia.studio'), '#deluvia.studio');
  assert.equal(route.parse('#deluvia.studio').kind, 'view');
  assert.equal(route.parse('#deluvia.studio').view, 'deluvia.studio');
  assert.equal(route.viewOfPath('/v/deluvia/studio'), 'deluvia.studio');
  // Copied into this realm first: an array built inside the `node:vm` has that context's
  // `Array.prototype`, and a strict deep-equal compares prototypes before contents.
  assert.deepEqual([...route.repoViews()], ['deluvia.studio']);
  // And it takes a query like every other view, so a repo view can hold a filter.
  assert.equal(route.hashFor('deluvia.studio', 'day=today'), '#deluvia.studio?day=today');
  assert.equal(route.parse('#deluvia.studio?day=today').query, 'day=today');
});

await check('a container adopted after boot can be shown, and one the grammar rejects cannot', () => {
  const b = boot([pane('epics')]);
  b.run('panes.js');
  const panesApi = b.bc().panes;
  const el = pane('deluvia.studio');
  b.body.append(el);
  assert.equal(panesApi.adopt('deluvia.studio', el), false, 'the grammar has to admit it first');
  b.bc().route.add({ id: 'deluvia.studio' });
  assert.equal(panesApi.adopt('deluvia.studio', el), true);
  assert.equal(el.hidden, true, 'adopting must not disturb the pane you are reading');
  b.navigate('#deluvia.studio');
  assert.equal(panesApi.showing(), 'deluvia.studio');
  assert.equal(el.hidden, false);
});

await check('landing straight on a repo view resolves the moment its pane arrives', () => {
  // The case `adopt`'s `sync()` exists for: the hash named this pane before the pane
  // existed, so `show` had already fallen back to Home — correctly, at the time.
  const b = boot([pane('epics')], { hash: '#deluvia.studio' });
  b.run('panes.js');
  assert.equal(b.bc().panes.showing(), 'epics', 'an unknown hash is Home, which is right');
  b.bc().route.add({ id: 'deluvia.studio' });
  const el = pane('deluvia.studio');
  b.body.append(el);
  b.bc().panes.adopt('deluvia.studio', el);
  assert.equal(b.bc().panes.showing(), 'deluvia.studio', 'the shortcut landed on Home and stayed there');
});

console.log('\nthe pill it gets');

await check('a repo pill goes to the end of the row, after Config, and is a button not a link', () => {
  const b = boot([pane('epics')]);
  b.run('panes.js');
  b.run('viewbar.js');
  b.bc().route.add({ id: 'deluvia.studio', paths: ['/v/deluvia/studio'] });
  const el = pane('deluvia.studio');
  b.body.append(el);
  b.bc().panes.adopt('deluvia.studio', el);
  assert.equal(b.bc().views.add({ id: 'deluvia.studio', label: 'Studio', icon: '🎬', href: '/v/deluvia/studio' }), true);

  const nav = b.topbar.parent.children.find((c) => c.className === 'viewbar');
  const row = pills(nav);
  assert.equal(row[row.length - 1].id, 'deluvia.studio', 'a repo pill takes the end of the row');
  assert.equal(row[row.length - 2].id, 'config', 'and does not displace the one that asked for it');
  const mine = row[row.length - 1];
  assert.equal(mine.tag, 'button', 'the pane is in this document, so the pill must not reload it');
  assert.equal(mine.pane, 'deluvia.studio');
  assert.ok(nav.innerHTML.includes('Studio'));
});

await check('and it is the current pill once its pane is up', () => {
  const b = boot([pane('epics')]);
  b.run('panes.js');
  b.run('viewbar.js');
  b.bc().route.add({ id: 'deluvia.studio', paths: ['/v/deluvia/studio'] });
  const el = pane('deluvia.studio');
  b.body.append(el);
  b.bc().panes.adopt('deluvia.studio', el);
  b.bc().views.add({ id: 'deluvia.studio', label: 'Studio' });
  b.navigate('#deluvia.studio');
  const nav = b.topbar.parent.children.find((c) => c.className === 'viewbar');
  const mine = pills(nav).find((p) => p.id === 'deluvia.studio');
  assert.equal(mine.current, true);
  assert.equal(mine.tag, 'span', 'the pill you are on is not a control');
});

await check('a duplicate pill is refused rather than drawn twice', () => {
  const b = boot([pane('epics')]);
  b.run('panes.js');
  b.run('viewbar.js');
  assert.equal(b.bc().views.add({ id: 'history' }), false, 'a built-in pill may not be doubled');
});

/* ============================== the SDK's half of the address (bc-k7lrc) */

/*
  A repo view could always be linked to. It could not be linked to *at* anything: which
  brief is open lived in a variable, so every share of the Briefs view was a share of the
  index of it, and the back button walked out of the view rather than back through it.

  The three lines that fix it are `ctx.query`, `ctx.setQuery` and `ctx.onQuery`, and what
  they are worth testing for is the adapter rather than the mechanism — public/panes.js's
  own suite has the mechanism. What is here: that a view is handed *its own* query and not
  whatever the URL happens to say, that its listener is never called before its `build`,
  and that a script in somebody else's checkout cannot write the address from behind a
  pane nobody is looking at.
*/

console.log('\nwhat a repo view is handed of its own address');

/** The manifest as `/api/views` hands it over, for a view with no generator — so `build`
 *  is called the moment the script defines itself and nothing waits on a payload. */
const BRIEFS = {
  view: 'deluvia.briefs',
  workspace: 'deluvia',
  id: 'briefs',
  path: '/v/deluvia/briefs',
  label: 'Briefs',
  icon: '📄',
  script: 'briefs.js',
  scriptUrl: '/v/deluvia/briefs/asset/briefs.js',
  styleUrl: '',
  dataUrl: '',
};

/** Let the boot's `/api/views` promise settle — two awaits deep, so two turns. */
const settled = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

/**
 * The shell with Briefs hosted in it, and the view's script "loaded".
 *
 * The script tag the host appends never fetches anything here, so `define` is called by
 * hand — in its two-argument form, which is the one the contract offers a script that
 * defers past its own execution and is exactly what this is.
 */
async function hosting(spec, opts) {
  // Home and the ledger, because half of what is being asserted is what a repo view does
  // while *another* pane is up, and a document with only Home in it cannot be on one.
  const b = boot([pane('epics'), pane('history')], { ...opts, views: [BRIEFS] });
  b.run('panes.js');
  b.run('viewbar.js');
  b.run('viewhost.js');
  await settled();
  b.bc().view.define('deluvia.briefs', spec);
  return b;
}

await check('build() reads the query the link arrived with', async () => {
  // The arrival a deep link *is*, and the reason `build` reads rather than waits: at the
  // moment this hash landed there was no pane to hold a listener, let alone a view.
  let saw = null;
  const b = await hosting({ build: (c) => (saw = c.query.get('b')) }, { hash: '#deluvia.briefs?b=chapter-one' });
  assert.equal(b.bc().panes.showing(), 'deluvia.briefs', 'the deep link did not reach the pane');
  assert.equal(saw, 'chapter-one');
});

await check('and reads `` while the hash is naming somebody else', async () => {
  // The ordinary state of the world for the several hundred milliseconds between
  // `/api/views` answering and a generator landing. Without `route.queryFor`'s check this
  // is where a view picks up the ledger's filters and opens a brief called `closed`.
  let saw = null;
  const b = await hosting({ build: (c) => (saw = [...c.query]) }, { hash: '#history?status=closed' });
  assert.equal(b.bc().panes.showing(), 'history');
  assert.deepEqual(saw, [], 'the view was handed another pane’s query');
});

await check('onQuery fires when the address moves under the view, with what it moved to', async () => {
  const moves = [];
  const b = await hosting({ build: (c) => c.onQuery((q) => moves.push(q.get('b'))) }, {
    hash: '#deluvia.briefs?b=one',
  });
  b.navigate('#deluvia.briefs?b=two');
  assert.deepEqual(moves, ['two'], 'the back button walked between two briefs and the view was not told');
  // Off the view and back: the query it left with is handed over again, so a pane that is
  // never rebuilt is still redrawn to the thing the address names.
  b.navigate('#history');
  b.navigate('#deluvia.briefs?b=one');
  assert.deepEqual(moves, ['two', 'one']);
});

await check('and never before the view has built', async () => {
  // `adopt` calls `sync`, so landing straight on this hash fires a query change while the
  // script has not run. Delivering it would mean every view author coping with a callback
  // that precedes their own `build`.
  const order = [];
  const b = boot([pane('epics')], { hash: '#deluvia.briefs?b=one', views: [BRIEFS] });
  b.run('panes.js');
  b.run('viewbar.js');
  b.run('viewhost.js');
  await settled();
  b.bc().view.define('deluvia.briefs', {
    build: (c) => {
      order.push('build');
      c.onQuery(() => order.push('query'));
    },
  });
  assert.deepEqual(order, ['build']);
  b.navigate('#deluvia.briefs?b=two');
  assert.deepEqual(order, ['build', 'query']);
});

await check('setQuery writes the view’s own hash and nobody else’s', async () => {
  let ctx = null;
  const b = await hosting({ build: (c) => (ctx = c) }, { hash: '#deluvia.briefs' });
  assert.equal(ctx.setQuery('b=chapter-one', { push: true }), true);
  assert.equal(b.ctx.location.hash, '#deluvia.briefs?b=chapter-one');
  assert.equal(b.bc().panes.showing(), 'deluvia.briefs', 'writing a query left the pane');
  // A `URLSearchParams` is as good as the string, because that is what `query` answers
  // with and a view should be able to hand back what it was given.
  const q = ctx.query;
  q.set('b', 'chapter-two');
  ctx.setQuery(q);
  assert.equal(b.ctx.location.hash, '#deluvia.briefs?b=chapter-two');
});

await check('a view behind a pane nobody is looking at cannot write the address', async () => {
  let ctx = null;
  const b = await hosting({ build: (c) => (ctx = c) }, { hash: '#history' });
  assert.equal(b.bc().panes.showing(), 'history');
  assert.equal(ctx.setQuery('b=chapter-one'), false);
  assert.equal(b.ctx.location.hash, '#history', 'a hidden view moved the address out from under the ledger');
});

/* ================================================================= the wiring */

console.log('\nthe wiring, as written');

await check('index.html loads the host, and loads it last', () => {
  const html = read('public/index.html');
  assert.ok(html.includes('src="/viewhost.js"'), 'the shell does not load the host');
  const scripts = [...html.matchAll(/<script src="\/([\w.]+)"><\/script>/g)].map((m) => m[1]);
  assert.equal(scripts[scripts.length - 1], 'viewhost.js', 'it adopts panes and appends pills — everything it extends has to exist first');
});

await check('it is the shell’s file and no other page loads it', () => {
  for (const f of fs.readdirSync(path.join(ROOT, 'public'))) {
    if (!f.endsWith('.html') || f === 'index.html') continue;
    assert.ok(
      !read(`public/${f}`).includes('viewhost.js'),
      `${f} loads viewhost.js — there are no panes to adopt on a page that is not the shell`
    );
  }
});

await check('a boot-time file of the shell is precached rather than left to the network', () => {
  assert.ok(read('public/sw.js').includes("'/viewhost.js'"), 'a page cached without it has no repo views at all');
});

await check('the host refuses to run on a page with no panes', () => {
  const src = read('public/viewhost.js');
  assert.match(src, /if \(!route \|\| !panes \|\| !document\.querySelector\('\.pane'\)\) return;/);
});

await check('what a repo ships is deliberately NOT precached', () => {
  // A repo's script and payload come from a checkout only the daemon can read, and the
  // worker installs its shell all-or-nothing: one repo whose checkout has moved would
  // make `caches.addAll` reject and take the whole offline shell down with it.
  const sw = read('public/sw.js');
  assert.ok(!/'\/v\//.test(sw), 'a repo asset is in the precache list');
  assert.ok(!/api\/views/.test(sw.split('const SHELL')[1]?.split(']')[0] || ''), 'a repo payload is in the precache list');
});

/* ================================================ the routes, against a real server */

/*
  The module half above proves what a manifest means; this proves the three addresses that
  hand it over. They are worth their own section because each of them is a different kind
  of wrong when it breaks, and none of the three is visible from the module:

  - `/api/views` is behind the token like every other payload, and must not hand over the
    argv it would spawn — the browser has no use for it, and a page that knew the command
    would be a page a repo could not change its generator without.
  - `/v/<ws>/<id>` is a **hop**, not a rewrite: a pane is chosen by the hash and a hash is
    never sent to a server, so serving the shell here would draw Home from every home-
    screen shortcut. That is the bug bc-khoe.30.7 exists to prevent and it is silent.
  - `/v/<ws>/<id>/asset/<rel>` must serve the two files the manifest named, refuse a third
    file sitting beside them in the same directory, and give a `.js` a type a browser will
    execute.
*/

console.log('\nthe three addresses, against a real server');

const srv = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-repoviews-srv-'));
const srvRepo = path.join(srv, 'demo');
fs.mkdirSync(path.join(srvRepo, VIEW_DIR), { recursive: true });
fs.mkdirSync(path.join(srvRepo, '.beads'), { recursive: true });
fs.writeFileSync(path.join(srvRepo, VIEW_DIR, 'board.js'), 'window.beadcause.view.define({ build() {} });\n');
fs.writeFileSync(path.join(srvRepo, VIEW_DIR, 'board.css'), '.x { color: red; }\n');
// A file in the view directory the manifest does not name. Reachable by path, and the
// manifest is what says it is not one of this view's.
fs.writeFileSync(path.join(srvRepo, VIEW_DIR, 'notes.md'), 'private working notes\n');
fs.writeFileSync(
  path.join(srvRepo, VIEW_DIR, MANIFEST),
  JSON.stringify({ views: [{ id: 'board', label: 'Board', icon: '🎬', script: 'board.js', style: 'board.css' }] })
);

const fakeBd = path.join(srv, 'bd');
fs.writeFileSync(fakeBd, "#!/usr/bin/env node\nprocess.stdout.write('[]');\n", { mode: 0o755 });

const srvCfg = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'repoviews-token',
  actor: 'beadcause-test',
  bdBin: fakeBd,
  workspaces: [{ name: 'demo', dir: path.join(srvRepo, '.beads') }],
  sessionDirs: { demo: srvRepo },
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const { boundPort } = await import('./helpers/net.mjs');
const { createApp, listen } = await import('../lib/server.js');
const app = createApp(srvCfg);
const servers = listen(srvCfg, app.handler);
const port = await boundPort(servers);

/** A GET that does not follow redirects — the hop is the thing being asserted. */
const get = (pathname, { token = srvCfg.token } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'GET',
        headers: token ? { 'x-beadcause-token': token } : {},
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
      }
    );
    req.on('error', reject);
    req.end();
  });

await check('GET /api/views lists what the repo declared', async () => {
  const res = await get('/api/views');
  assert.equal(res.status, 200);
  const out = JSON.parse(res.body);
  assert.deepEqual(out.problems, []);
  assert.equal(out.views.length, 1);
  assert.equal(out.views[0].view, 'demo.board');
  assert.equal(out.views[0].scriptUrl, '/v/demo/board/asset/board.js');
  assert.equal(out.views[0].generated, false, 'this view declares no generator');
});

await check('and it never hands over the argv it would spawn', async () => {
  const out = JSON.parse((await get('/api/views')).body);
  assert.equal(out.views[0].run, undefined, 'the browser was told the command to run');
});

await check('it is behind the credential, like every other payload', async () => {
  assert.equal((await get('/api/views', { token: '' })).status, 401);
});

await check('a scoped address is served the shell, at the address it was asked for', async () => {
  // bc-xnj67, and the one claim about it that reading the source cannot make: a rewrite
  // rather than a hop, so the space stays in the address bar while the hash goes on naming
  // the view. A 302 here would put the address on screen for one round trip and then take
  // it away, which is the whole thing this shape exists to avoid.
  const res = await get('/bdcoz/personal/demo');
  assert.equal(res.status, 200, 'a scoped address did not serve the shell');
  assert.match(res.headers['content-type'] || '', /text\/html/);
  assert.ok(res.body.includes('data-pane='), 'what came back is not the shell');
  // Any scope is served, including one naming no configured space. This file has no
  // business being the place that knows which spaces exist, and a typo should show you the
  // app rather than a 404 — the client drops an unknown scope back to the stored filter.
  assert.equal((await get('/bdcoz/nosuchspace')).status, 200);
});

await check('/v/demo/board hops to the hash rather than serving the shell', async () => {
  const res = await get('/v/demo/board');
  assert.equal(res.status, 302, 'a rewrite here draws Home from every home-screen shortcut');
  // Unscoped, because `demo` is in no configured space in this fixture — the hop upgrades
  // to `/bdcoz/<space>/<ws>#…` only when there is a space to name (bc-xnj67).
  assert.equal(res.headers.location, '/#demo.board');
});

await check('and the daemon query survives the hop while everything else goes behind the #', async () => {
  const res = await get('/v/demo/board?t=abc&day=today');
  assert.equal(res.headers.location, '/?t=abc#demo.board?day=today');
});

await check('an asset the manifest named is served, with a type a browser will run', async () => {
  const js = await get('/v/demo/board/asset/board.js');
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'], /javascript/);
  assert.match(js.body, /define/);
  const css = await get('/v/demo/board/asset/board.css');
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /text\/css/);
});

await check('a file beside them that the manifest did not name is refused', async () => {
  // It is inside `.beadcause/` and resolves perfectly well. The manifest is the allowlist.
  const res = await get('/v/demo/board/asset/notes.md');
  assert.equal(res.status, 404);
  assert.match(JSON.parse(res.body).error, /declares no such asset/);
});

await check('and so is a view nobody declared, and a hand-edited address', async () => {
  assert.equal((await get('/v/demo/ghost/asset/board.js')).status, 404);
  assert.equal((await get('/v/demo/board/asset/%')).status, 404, 'a lone % must be a 404, not a throw');
});

await check('a view with no generator answers the data route with a reason, not a crash', async () => {
  const res = await get('/api/views/demo/board/data');
  assert.equal(res.status, 502);
  assert.match(JSON.parse(res.body).error, /no "data.run"/);
});

await check('and that 502 says it is the generator failing, not the daemon — bc-3wf1r', async () => {
  // public/report.js files a sev2 P0 for every 5xx that does not say otherwise, and this
  // one is a script this daemon spawned on another repo's behalf — or, here, a manifest
  // that named none. The header is what stops the false P0; the body's `code` is for a
  // caller that has already parsed it.
  const res = await get('/api/views/demo/board/data');
  assert.equal(res.headers[GENERATOR_HEADER], '1', 'the view-data 502 carries no generator marker');
  assert.equal(JSON.parse(res.body).code, GENERATOR_CODE);
});

await check('and the browser reads that same header literally, since public/ cannot import lib/', () => {
  // The one thing that can silently break this: renaming the constant in lib/repoviews.js
  // and leaving public/report.js matching the old string. Then every view-generator 502
  // files a P0 again and nothing goes red. See the comment at the exemption in report.js.
  const reporter = fs.readFileSync(new URL('../public/report.js', import.meta.url), 'utf8');
  assert.ok(
    reporter.includes(`'${GENERATOR_HEADER}'`),
    `public/report.js does not excuse ${GENERATOR_HEADER}`
  );
});

for (const s of servers) s.close();

/* ===================================================================== the end */

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(srv, { recursive: true, force: true });

console.log(
  failures
    ? `\n\x1b[31m${failures} of ${ran} checks failed\x1b[0m\n`
    : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`
);
process.exit(failures ? 1 : 0);
