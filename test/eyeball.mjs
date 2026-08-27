#!/usr/bin/env node
//
// b7e-eyeball — render a page against a fixture and hand back the pixels and the geometry
// (bc-khoe.45, folded with sophab's sp-6bt.10).
//
//   npm test
//   node test/eyeball.mjs
//
// **No Chrome anywhere in here, on purpose.** `npm test` deliberately does not depend on a
// browser — test/chromeprofile.mjs and test/chromeleak.mjs are the precedents, and the
// browser checks live in `npm run checks` for exactly this reason. So `lib/eyeball.js` is
// written with the browser as an injected `driver`, and everything else — the run plan, the
// generated fixture document, the fixture server, the verdict, the PNG writing — is driven
// here directly. What that leaves uncovered is the CDP calls in `bin/b7e-eyeball`, which is
// the right side of the line to leave uncovered: they are the part a suite could only test
// by launching the thing it was told not to.
//
// The three that are worth the suite existing, because each of them is a way a *green* run
// lies to the session that ran it:
//
//   1. The generated document. The charset trap (bc-khoe.26 chased a mojibake caret that
//      was not a bug) and the `min-width: auto` trap (bc-henk believed a card height that
//      was a third out) are both closed by *writing* the document rather than asking the
//      caller to. A regression here does not fail loudly; it produces plausible numbers.
//   2. The fixture server's alias and hop tables. A path that is now a view of the shell —
//      `/monitor` since bc-khoe.4 — is neither a file nor an alias. Serve it as a 404 and
//      Chrome renders its own error page, which carries no viewport meta, so `innerWidth`
//      comes back 980 on a 360px run and every number describes a page nobody asked for.
//      That is not a hypothetical: it is what the first real run of this command did.
//   3. The verdict. "It overflowed", "it never loaded" and "your selector matched nothing"
//      are three different failures and a run that conflates them sends a reader to the
//      wrong file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';
// The assembled list, which since bc-wbrhi is the hand-written half in lib/toolbelt.js
// plus whatever the tools in bin/ declare — so asking the module is the only reading that
// cannot go stale against a literal that is no longer there.
import { DEFAULT_TOOL_LIST } from '../lib/tooldecl.js';
import {
  DEFAULT_THEMES,
  DEFAULT_WIDTHS,
  FIXTURE_PATH,
  MOUNT_ID,
  REPO_ROOT,
  TOKEN,
  cellUrl,
  createFixtureServer,
  fixtureDocument,
  measureExpression,
  planCells,
  readPayload,
  runEyeball,
  shapeCell,
  slug,
  summaryLine,
} from '../lib/eyeball.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let failures = 0;
let ran = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (name, fn) => {
  ran += 1;
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};
const checkAsync = async (name, fn) => {
  ran += 1;
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-eyeball-test-'));
const write = (rel, body) => {
  const file = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
};

console.log('\nb7e-eyeball\n');

/* ------------------------------------------------------------- the payload */

console.log('a payload is a page payload and a route map at once');

check('every top-level "/" key is served as a route', () => {
  const f = write('p/api.json', JSON.stringify({ '/api/skills': { library: [] }, '/api/spaces': [] }));
  const p = readPayload(f);
  assert.deepEqual(Object.keys(p.routes).sort(), ['/api/skills', '/api/spaces']);
  assert.equal(p.name, 'api');
});

check('a file with no "/" keys serves nothing and is still the page payload', () => {
  const f = write('p/groups.json', JSON.stringify({ groups: [{ id: 'scope' }] }));
  const p = readPayload(f);
  assert.deepEqual(p.routes, {});
  assert.equal(p.data.groups[0].id, 'scope');
});

check('one file can be both at once — the two readings never collide', () => {
  const f = write('p/mixed.json', JSON.stringify({ '/api/skills': { library: [] }, groups: [1, 2] }));
  const p = readPayload(f);
  assert.deepEqual(Object.keys(p.routes), ['/api/skills']);
  assert.deepEqual(p.data.groups, [1, 2]);
});

check('bad JSON names the file rather than throwing a bare SyntaxError', () => {
  const f = write('p/bad.json', '{ not json');
  assert.throws(() => readPayload(f), (e) => e.message.includes('bad.json') && e.message.includes('is not JSON'));
});

/* ---------------------------------------------------------------- the plan */

console.log('\nthe run plan');

check('the default sweep is both widths and both themes', () => {
  const cells = planCells({ targets: ['/monitor'] });
  assert.equal(cells.length, DEFAULT_WIDTHS.length * DEFAULT_THEMES.length);
  assert.deepEqual([...new Set(cells.map((c) => c.width))].sort(), [...DEFAULT_WIDTHS].sort());
  assert.deepEqual([...new Set(cells.map((c) => c.theme))].sort(), [...DEFAULT_THEMES].sort());
});

check("two payloads and one width is bc-dgx7.5's four-state sweep", () => {
  const payloads = [
    { name: 'full', data: {}, routes: {} },
    { name: 'empty', data: {}, routes: {} },
  ];
  const cells = planCells({ targets: ['/skills'], widths: [393], payloads });
  assert.equal(cells.length, 4, `four cells, got ${cells.length}`);
  assert.deepEqual(
    cells.map((c) => `${c.theme}/${c.payload.name}`).sort(),
    ['dark/empty', 'dark/full', 'light/empty', 'light/full']
  );
});

check('every cell knows its PNG before anything is rendered, and no two collide', () => {
  const payloads = [
    { name: 'full', data: {}, routes: {} },
    { name: 'empty', data: {}, routes: {} },
  ];
  const cells = planCells({ targets: ['/skills', '/monitor'], payloads, outDir: '/tmp/shots' });
  assert.equal(new Set(cells.map((c) => c.png)).size, cells.length, 'two cells share a filename');
  for (const c of cells) {
    assert.ok(c.png.startsWith('/tmp/shots/'), c.png);
    assert.ok(c.png.includes(String(c.width)) && c.png.includes(c.theme) && c.png.includes(c.payload.name), c.png);
  }
});

check('REPO_ROOT is the checkout this file belongs to — the tree served without --dir', () => {
  assert.equal(fs.realpathSync(REPO_ROOT), fs.realpathSync(ROOT));
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'public', 'style.css')));
});

check('a path that slugs to nothing still gets a name', () => {
  assert.equal(slug('/'), 'index');
  assert.equal(slug('/monitor'), 'monitor');
  assert.equal(slug('http://x/a/b'), 'x-a-b');
});

/* ------------------------------------------------- the document it writes */

console.log('\nthe generated fixture document — the traps that cannot be reintroduced');

check('charset is always there — bc-khoe.26 chased a mojibake caret that was not a bug', () => {
  assert.ok(fixtureDocument().includes('<meta charset="utf-8">'));
});

check('the mount carries the cell width and min-width:0 — the bc-henk trap', () => {
  const doc = fixtureDocument({ width: 360 });
  assert.match(doc, new RegExp(`#${MOUNT_ID}\\s*\\{[^}]*width:\\s*360px`));
  assert.match(doc, new RegExp(`#${MOUNT_ID}\\s*\\{[^}]*min-width:\\s*0`));
});

check('the real stylesheet is linked, and more than one can be', () => {
  assert.ok(fixtureDocument().includes('<link rel="stylesheet" href="/style.css">'));
  const two = fixtureDocument({ stylesheets: ['/style.css', '/extra.css'] });
  assert.ok(two.includes('href="/style.css"') && two.includes('href="/extra.css"'));
});

check('a mounted module is imported and its namespace reaches the call', () => {
  const doc = fixtureDocument({ mounts: ['/filterpills.js'], call: 'mod.mount(mount, payload);' });
  assert.ok(doc.includes('"/filterpills.js"'), 'the specifier is not in the document');
  assert.ok(doc.includes('mod.mount(mount, payload);'), 'the call is not in the document');
  assert.ok(doc.includes('const mod = mods[0]'), 'mod is not bound');
});

check('a module that throws is recorded rather than photographed as an empty box', () => {
  const doc = fixtureDocument({ mounts: ['/x.js'] });
  assert.ok(doc.includes('window.__eyeball = { ok: false'), 'no failure branch');
  assert.ok(doc.includes('window.__eyeball = { ok: true,'), 'no success branch');
});

check('a payload containing </script> cannot end the tag it is inside', () => {
  const doc = fixtureDocument({ payload: { evil: '</script><img onerror=1>' } });
  assert.ok(!doc.includes('</script><img'), 'the payload closed its own script tag');
  assert.ok(doc.includes('\\u003c/script>'), 'the < was not escaped');
  // and it is still the same value once a JS engine has read it back
  assert.equal(JSON.parse(doc.match(/const payload = (.*);\n/)[1]).evil, '</script><img onerror=1>');
});

check('the document parses as a whole document, head before body', () => {
  const doc = fixtureDocument({ html: '<div class="card">x</div>' });
  assert.ok(doc.startsWith('<!doctype html>'));
  assert.ok(doc.indexOf('</head>') < doc.indexOf('<body'));
  assert.ok(doc.includes('<div class="card">x</div>'));
});

/* ------------------------------------------------------ what it asks the page */

console.log('\nthe measurement expression');

check('it is a single valid expression', () => {
  const expr = measureExpression(['.brand', '.observing']);
  assert.doesNotThrow(() => new Function(`return ${expr}`));
});

check('the selectors given are the selectors asked about', () => {
  const expr = measureExpression(['.brand', '.observing']);
  assert.ok(expr.includes('".brand"') && expr.includes('".observing"'));
});

check('overflow:hidden is NOT an exemption — it is the case worth reporting hardest', () => {
  const expr = measureExpression([]);
  // A carousel may be wider than the phone; a clipped control may not. If this ever
  // exempts 'hidden' again, an element cut off the side of a card goes silent in both
  // halves at once — out of scrollWidth *and* out of the offender list.
  assert.ok(expr.includes("ox === 'auto' || ox === 'scroll'"), 'the scrollable test changed shape');
  assert.ok(!/ox !== 'visible'/.test(expr), "'hidden' is being treated as a scroller again");
});

check('it reports the mount width beside the viewport, so the two can be seen to agree', () => {
  const expr = measureExpression([]);
  assert.ok(expr.includes('mountWidth'), 'nothing reports the mount width');
  assert.ok(expr.includes('scrollWidth'), 'nothing reports the document scroll width');
  assert.ok(expr.includes('offenders'), 'nothing walks for elements past the edge');
});

/* -------------------------------------------------------- the fixture server */

console.log('\nthe fixture server — the working tree, on a port nobody else owns');

const server = await createFixtureServer({ root: ROOT });
const get = async (p, opts = {}) => {
  const res = await fetch(`${server.origin}${p}`, { redirect: 'manual', ...opts });
  return { status: res.status, location: res.headers.get('location'), type: res.headers.get('content-type'), body: await res.text() };
};

await checkAsync('the port is the kernel\'s, never a number in the source', async () => {
  // sp-jb1 spent four calls measuring another session's worktree because both had picked
  // 8099. There is nothing to collide with when nothing chose.
  assert.ok(server.port > 0 && server.port < 65536, `port ${server.port}`);
  const second = await createFixtureServer({ root: ROOT });
  assert.notEqual(second.port, server.port, 'two servers were given the same port');
  await second.close();
});

await checkAsync('a real file under public/ is served with its type', async () => {
  const r = await get('/style.css');
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/css/);
  assert.ok(r.body.length > 100);
});

await checkAsync("an alias serves the page it serves in the app — /skills is skills.html", async () => {
  const r = await get('/skills');
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/html/);
  assert.ok(r.body.includes('<!doctype html>') || r.body.includes('<!DOCTYPE html>'));
});

await checkAsync('a view hop answers with the hop the daemon answers with — /monitor', async () => {
  // The failure this is here for: 404 -> Chrome's own error page -> no viewport meta ->
  // innerWidth 980 on a 360px run, and every number in the record about the wrong page.
  const r = await get('/monitor?t=x');
  assert.equal(r.status, 302, `expected a hop, got ${r.status}`);
  assert.ok(r.location.includes('#advocates'), `landed on ${r.location}`);
});

await checkAsync('every other /api/* answers {} rather than 404', async () => {
  const r = await get('/api/anything-at-all');
  assert.equal(r.status, 200);
  assert.equal(r.body, '{}');
});

await checkAsync('a payload route is served, and only for the cell that carries it', async () => {
  server.serve({ routes: { '/api/skills': { library: [{ command: 'b7e-eyeball' }] } } });
  const fed = await get('/api/skills');
  assert.deepEqual(JSON.parse(fed.body).library, [{ command: 'b7e-eyeball' }]);
  server.serve({});
  const bare = await get('/api/skills');
  assert.equal(bare.body, '{}', 'a previous cell\'s payload outlived its cell');
});

await checkAsync('the generated fixture is served at its own path, and only when there is one', async () => {
  const missing = await get(FIXTURE_PATH);
  assert.equal(missing.status, 404);
  server.serve({ document: fixtureDocument({ width: 393, html: '<p>hello</p>' }) });
  const r = await get(FIXTURE_PATH);
  assert.equal(r.status, 200);
  assert.ok(r.body.includes('<p>hello</p>'));
  assert.match(r.type, /text\/html/);
  server.serve({});
});

await checkAsync('a missing file is a 404 and a path out of public/ is refused', async () => {
  assert.equal((await get('/no-such-file.js')).status, 404);
  const escaped = await get('/../package.json');
  assert.ok(escaped.status === 403 || escaped.status === 404, `traversal answered ${escaped.status}`);
});

await checkAsync('--baseline serves the committed text, which is the before-shot', async () => {
  const head = execFileSync('git', ['show', 'HEAD:public/style.css'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString();
  const base = await createFixtureServer({ root: ROOT, baseline: true });
  const r = await fetch(`${base.origin}/style.css`);
  assert.equal((await r.text()).length, head.length, 'baseline did not serve HEAD');
  await base.close();
});

await checkAsync('--dir serves another tree, and takes that tree\'s aliases with it', async () => {
  write('tree/public/index.html', '<!doctype html><title>other</title>');
  write('tree/lib/server.js', "if (urlPath === '/thing') urlPath = '/index.html';\n");
  const other = await createFixtureServer({ root: path.join(tmp, 'tree') });
  const bare = await fetch(`${other.origin}/`);
  assert.ok((await bare.text()).includes('other'), 'the other tree was not served');
  const aliased = await fetch(`${other.origin}/thing`);
  assert.ok((await aliased.text()).includes('other'), "the other tree's alias was not honoured");
  // and this repo's own aliases are NOT inherited by it
  assert.equal((await fetch(`${other.origin}/skills`)).status, 404);
  await other.close();
});

check('the URL a cell is navigated to carries the fake token, and it is fake', () => {
  const cell = { target: '/monitor', width: 393, theme: 'dark', payload: null, png: 'x.png' };
  const u = new URL(cellUrl(server.origin, cell));
  assert.equal(u.pathname, '/monitor');
  assert.equal(u.searchParams.get('t'), TOKEN);
  const fx = new URL(cellUrl(server.origin, cell, { fixture: true }));
  assert.equal(fx.pathname, FIXTURE_PATH);
});

/* ---------------------------------------------------------------- the verdict */

console.log('\nthe verdict — three failures that send a reader to three different files');

const cell = { target: '/x', width: 393, theme: 'dark', payload: null, png: path.join(tmp, 'shot.png'), label: 'x' };
const clean = {
  measure: {
    title: 'x',
    viewport: { w: 393, h: 852 },
    scrollWidth: 393,
    mountWidth: 393,
    offenders: [],
    measured: { '.brand': { n: 1, nodes: [{ w: 52, children: 2 }] } },
    fixture: { ok: true },
  },
  problems: [],
  failed: null,
  png: null,
};

check('a clean cell is clean', () => {
  const r = shapeCell(cell, clean);
  assert.equal(r.ok, true, r.reasons.join('; '));
  assert.deepEqual(r.reasons, []);
});

check('a wider scrollWidth fails the width and says by how much', () => {
  const r = shapeCell(cell, { ...clean, measure: { ...clean.measure, scrollWidth: 536 } });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(' '), /overflows 393px/);
});

check('an element past the edge fails it even when scrollWidth is clean', () => {
  // The half scrollWidth cannot answer: an ancestor with overflow-x:hidden clips the
  // offender out of the document's width while it is still being cut off the phone.
  const r = shapeCell(cell, {
    ...clean,
    measure: { ...clean.measure, offenders: [{ sel: 'div.card', right: 536, w: 520, over: 143 }] },
  });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(' '), /widest div\.card/);
});

check('a selector that matched nothing fails — a green run that measured nothing is a lie', () => {
  const r = shapeCell(cell, {
    ...clean,
    measure: { ...clean.measure, measured: { '.gone': { n: 0, nodes: [] } } },
  });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(' '), /matched nothing: \.gone/);
});

check("a document that never arrived is not the same failure as an overflow", () => {
  const r = shapeCell(cell, { measure: null, problems: [], failed: 'net::ERR_CONNECTION_REFUSED', png: null });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(' '), /page: net::ERR_CONNECTION_REFUSED/);
  assert.match(r.reasons.join(' '), /nothing was measured/);
});

check("a fixture module that threw is reported as having thrown", () => {
  const r = shapeCell(cell, { ...clean, measure: { ...clean.measure, fixture: { ok: false, error: 'TypeError: x is not a function\n  at y' } } });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(' '), /fixture threw: TypeError/);
  assert.ok(!r.reasons.join(' ').includes('at y'), 'the whole stack went into the one-line reason');
});

check('console errors are reported always and fail only under --strict', () => {
  const noisy = { ...clean, problems: [{ kind: 'http', text: '401 /api/questions', n: 1 }] };
  assert.equal(shapeCell(cell, noisy).ok, true);
  assert.equal(shapeCell(cell, noisy).problems.length, 1, 'the problem was dropped rather than reported');
  assert.equal(shapeCell(cell, noisy, { strict: true }).ok, false);
});

check('the summary names the payload, not just the width and theme', () => {
  const records = [
    shapeCell({ ...cell, payload: { name: 'full' } }, { ...clean, measure: { ...clean.measure, scrollWidth: 999 } }),
    shapeCell({ ...cell, payload: { name: 'empty' } }, clean),
  ];
  const line = summaryLine(records);
  assert.match(line, /1\/2 cells clean/);
  assert.match(line, /full/);
  assert.ok(!line.includes('empty'), 'a clean cell was named among the failures');
});

/* ------------------------------------------------------------------- the run */

console.log('\nthe run, against a driver that is not a browser');

await checkAsync('every cell runs, is served its own payload, and gets its own PNG', async () => {
  const outDir = path.join(tmp, 'shots');
  const payloads = [
    { name: 'full', data: { n: 1 }, routes: { '/api/skills': { library: [1] } } },
    { name: 'empty', data: { n: 0 }, routes: { '/api/skills': { library: [] } } },
  ];
  const cells = planCells({ targets: ['/skills'], widths: [393], themes: ['dark'], payloads, outDir });
  const seen = [];
  const fake = {
    async shoot({ url, cell: c }) {
      // Whatever this cell's payload is, the server must be answering with it *now*.
      const served = await (await fetch(`${server.origin}/api/skills`)).json();
      seen.push({ url, width: c.width, theme: c.theme, payload: c.payload.name, served });
      return { ...clean, measure: { ...clean.measure, viewport: { w: c.width, h: 852 }, scrollWidth: c.width }, png: Buffer.from('PNG') };
    },
    close() {},
  };
  const result = await runEyeball({ cells, selectors: [], server, driver: fake });
  assert.equal(result.records.length, 2);
  assert.equal(result.ok, true, result.records.flatMap((r) => r.reasons).join('; '));
  assert.deepEqual(seen.map((s) => s.payload), ['full', 'empty']);
  assert.deepEqual(seen.map((s) => s.served.library.length), [1, 0], 'a cell was measured against the wrong payload');
  for (const c of cells) assert.ok(fs.existsSync(c.png), `${c.png} was not written`);
  assert.equal(result.records.every((r) => r.shot), true);
});

await checkAsync('a fixture run writes the document per cell, at that cell\'s width', async () => {
  const cells = planCells({ targets: ['fixture'], widths: [360, 393], themes: ['dark'], outDir: path.join(tmp, 'shots') });
  const docs = [];
  const fake = {
    async shoot({ url, cell: c }) {
      docs.push({ width: c.width, doc: (await (await fetch(url)).text()) });
      return { ...clean, measure: { ...clean.measure, viewport: { w: c.width, h: 852 }, scrollWidth: c.width, mountWidth: c.width }, png: null };
    },
    close() {},
  };
  await runEyeball({ cells, fixture: { mounts: ['/filterpills.js'], call: 'void 0;' }, server, driver: fake });
  assert.equal(docs.length, 2);
  assert.match(docs[0].doc, /width: 360px/);
  assert.match(docs[1].doc, /width: 393px/);
  for (const d of docs) assert.ok(d.doc.includes('<meta charset="utf-8">'), 'a generated document lost its charset');
});

await checkAsync('a driver that throws fails that cell and does not stop the sweep', async () => {
  const cells = planCells({ targets: ['/a', '/b'], widths: [393], themes: ['dark'], outDir: path.join(tmp, 'shots') });
  let n = 0;
  const fake = {
    async shoot({ cell: c }) {
      if (n++ === 0) throw new Error('Chrome exited during launch');
      return { ...clean, measure: { ...clean.measure, viewport: { w: c.width, h: 852 }, scrollWidth: c.width }, png: null };
    },
    close() {},
  };
  const result = await runEyeball({ cells, server, driver: fake });
  assert.equal(result.records.length, 2, 'the sweep stopped at the first failure');
  assert.equal(result.records[0].ok, false);
  assert.match(result.records[0].reasons.join(' '), /Chrome exited during launch/);
  assert.equal(result.records[1].ok, true);
  assert.equal(result.ok, false);
});

await server.close();

/* --------------------------------------------------------- the registrations */

console.log('\nthe registrations a new bin/ command owes');

check('bin/b7e-eyeball is executable, extensionless, and has a shebang', () => {
  // Extensionless because lib/foundation.js puts the MAIN CHECKOUT's bin/ on PATH, so a
  // command resolves by the name it is typed as — a package.json rename resolves only
  // after an `npm link` this install has never had.
  const file = path.join(ROOT, 'bin', 'b7e-eyeball');
  assert.ok(fs.existsSync(file), 'bin/b7e-eyeball is missing');
  assert.ok(fs.statSync(file).mode & 0o111, 'bin/b7e-eyeball is not executable');
  assert.ok(fs.readFileSync(file, 'utf8').startsWith('#!/usr/bin/env node'), 'no shebang');
});

check('it is registered in package.json AND in package-lock.json', () => {
  // test/lockfile.mjs is pinned first in the sweep for this reason: a lock that disagrees
  // with package.json stops every later suite, and this is the registration nobody
  // remembers.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(pkg.bin['b7e-eyeball'], 'bin/b7e-eyeball');
  assert.equal(lock.packages[''].bin['b7e-eyeball'], 'bin/b7e-eyeball');
});

check('the README says it exists — a feature is not finished here until it does', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /^### .*`b7e-eyeball`/m, 'no ### section names b7e-eyeball');
});

check('it is deliberately NOT on DEFAULT_TOOL_LIST, and the reason is written down', () => {
  // It spawns a browser and binds a port — the shape lib/grants.js already classifies as a
  // write (`Bash(npm test:*)`, merge-advocate alone, "nothing about run the tests is a
  // read"), and the only agent DEFAULT_TOOL_LIST governs is `dispatch`: one turn, one
  // `bd comment`, no branch. Adding it here would also turn test/grants.mjs red on sight
  // for being unclassified, and the answer to that failure is not to classify it.
  //
  // Both halves are still asserted, and since bc-wbrhi they live in two different places
  // on purpose: the *decision* is `@grant excluded` in the tool's own header, where it
  // cannot be made by accident, and the *reason* is the paragraph in lib/tooldecl.js,
  // which is where the whole of that argument moved so it could keep arguing by
  // cross-reference. Checking only the first would let the paragraph be deleted; checking
  // only the second is what this used to do, and it could not tell a decision from a
  // passing mention.
  const src = fs.readFileSync(path.join(ROOT, 'bin', 'b7e-eyeball'), 'utf8');
  assert.match(src, /^\s*\*\s*@grant excluded\s*$/m, 'b7e-eyeball no longer declares itself off the list');
  assert.ok(!DEFAULT_TOOL_LIST.includes('Bash(b7e-eyeball:*)'), 'b7e-eyeball was granted to dispatch');
  const argument = fs.readFileSync(path.join(ROOT, 'lib', 'tooldecl.js'), 'utf8');
  assert.ok(argument.includes('b7e-eyeball'), 'the reason it is not on the list is not written down');
});

/* ------------------------------------------------------ every b7e-* answers --help */

// bc-dgx7.31 (`bin/b7e-usage`): the second half of what makes that command safe to
// trust — it reads a header doc comment and never runs the command it describes, but
// that promise is worthless if the command itself does not treat `--help` as inert.
// `bin/b7e-gate` used to fall through `--help` into a real 400-suite sweep;
// `bin/b7e-affected` and five others turned it away as an "unrecognised flag" or a
// missing positional, which is a refusal, not an answer. This spawns every `bin/b7e-*`
// file with `--help` and a closed stdin (several of the family read stdin when no
// other input is given, and `--help` must never wait on that) and asserts each one
// exits 0 within a few seconds — cheap, once, rather than trusting the doc comment.
console.log('\nevery bin/b7e-* answers --help inertly');

check('every bin/b7e-* exits 0 on --help, fast, with a closed stdin', () => {
  const binDir = path.join(ROOT, 'bin');
  const files = fs
    .readdirSync(binDir)
    .filter((f) => f.startsWith('b7e-'))
    .filter((f) => fs.statSync(path.join(binDir, f)).isFile());
  assert.ok(files.length >= 60, `only ${files.length} bin/b7e-* files found — the scan is not reading bin/`);
  const bad = [];
  for (const f of files) {
    try {
      execFileSync('node', [path.join(binDir, f), '--help'], {
        cwd: ROOT,
        input: '',
        timeout: 8000,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (err) {
      bad.push(`${f} (${err.signal || `exit ${err.status}`})`);
    }
  }
  assert.deepEqual(bad, [], `did not answer --help cleanly: ${bad.join(', ')}`);
});

/* ------------------------------------------------------------------- done */

removeTreeSync(tmp);

console.log(`\n${ran - failures}/${ran} checks passed\n`);
process.exit(failures ? 1 : 0);
