#!/usr/bin/env node
//
// b7e-owes — what a new route, page, module or config key still owes the registries
// that will go red without it, in one call (bc-khoe.27.7).
//
//   npm test
//   node test/b7eowes.mjs
//
// Two kinds of proof, for the reason test/evidence.mjs mixes them: the four
// extractors and gap-finders are pure functions, so the acceptance criterion's "a
// tree that adds an /api route with no README row, a lib/ module naming CONFIG_DIR
// with no lib/evidence.js claim, a public/*.html page absent from PAGES, and a
// defaulted config key with no Config row" is provable directly, against small
// fabricated snippets in the real shape rather than a whole second checkout — the
// same argument test/evidence.mjs's own "an unclaimed writer fails" makes for a
// `tmp/fake-repo` over a cloned one. Then one real run against this repo's own
// tree, because a set of regexes that agree with themselves is not the same claim
// as a set of regexes that agree with lib/server.js.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-owes.js');

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (name, fn) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

const owes = await import(BIN);

/* ===================================================================== *
 * 1. the API table
 * ===================================================================== */

console.log('\nan /api route with no README row\n');

{
  const serverSrc = "if (p === '/api/bead/create' && req.method === 'POST') return createBead(req, res);\n";
  const pairs = owes.routePairs(serverSrc);
  check('routePairs reads the forward if-form', () =>
    assert.deepEqual(pairs, [
      { path: '/api/bead/create', method: 'POST' },
      { path: '/api/health', method: 'GET' },
    ])
  );

  const readmeSrc = '| GET | `/api/bead/list` | list beads |\n';
  const documented = owes.apiTableRows(readmeSrc);
  check('apiTableRows reads a table row', () => assert.deepEqual([...documented], ['GET /api/bead/list']));

  const { missing, phantom } = owes.routeGaps(pairs, documented);
  check('the served-and-undocumented route is named', () =>
    // /api/health rides along too — routePairs always adds it, the same as
    // test/routes.mjs does, because it is served ahead of the dispatch chain these
    // pairs are read off and this fabricated README never mentions it either.
    assert.deepEqual(missing, ['GET /api/health', 'POST /api/bead/create'])
  );
  check('and the documented-and-unserved row is named the other way', () =>
    assert.deepEqual(phantom, ['GET /api/bead/list'])
  );
}

/* ===================================================================== *
 * 2. the Config table
 * ===================================================================== */

console.log('\na defaulted config key with no Config row\n');

{
  const readmeSrc = [
    '## Config — `~/.config/beadcause/config.json`',
    '',
    '| key | meaning |',
    '| --- | --- |',
    '| `port` | the port |',
    '',
    '## Something else, reusing the same row shape',
    '',
    '| key | meaning |',
    '| --- | --- |',
    '| `advocates.flagFinishedEpics` | a row that does not count — outside the Config table |',
  ].join('\n');
  const documented = owes.configTableRows(readmeSrc);
  check('configTableRows reads only the contiguous table under the heading', () =>
    assert.deepEqual([...documented], ['port'])
  );

  const served = ['port', 'advocates.flagFinishedEpics'];
  const { missing, phantom } = owes.configGaps(served, documented);
  check('the served-and-undocumented key is named', () => assert.deepEqual(missing, ['advocates.flagFinishedEpics']));
  check('a shape row covers everything under it', () => {
    const nested = owes.configGaps(['sessionWindows.card.width'], new Set(['sessionWindows.card']));
    assert.deepEqual(nested.missing, []);
  });
  check('NO_DEFAULT_CONFIG_KEYS keeps the real, undefaulted rows out of phantom', () => {
    const withNoDefault = owes.configGaps([], new Set(['claudeSessionsDir']));
    assert.deepEqual(withNoDefault.phantom, []);
  });
  check('and a row for nothing served is named in the other direction', () => assert.deepEqual(phantom, []));
  const { phantom: realPhantom } = owes.configGaps(['port'], new Set(['port', 'ghostSetting']));
  check('a genuinely dead row is a phantom', () => assert.deepEqual(realPhantom, ['ghostSetting']));
}

/* ===================================================================== *
 * 3. lib/evidence.js
 * ===================================================================== */

console.log('\na lib/ module naming CONFIG_DIR with no lib/evidence.js claim\n');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7eowes-'));
{
  const root = path.join(tmp, 'fake-repo');
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'lib', 'newthing.js'),
    "import { CONFIG_DIR } from './config.js';\nconst P = path.join(CONFIG_DIR, 'newthing.json');\n"
  );
  const problems = await owes.evidenceGaps(root);
  check('the unclaimed module is named', () =>
    assert.ok(
      problems.some((p) => p.startsWith('lib/newthing.js persists state')),
      `no such problem in:\n${problems.join('\n') || '(nothing)'}`
    )
  );
}

/* ===================================================================== *
 * 4. test/pagepaths.mjs
 * ===================================================================== */

console.log("\na public/*.html page absent from test/pagepaths.mjs's PAGES\n");

{
  const serverSrc = [
    'async function serveStatic(req, res, url, urlPath) {',
    "  if (urlPath === '/skills') urlPath = '/skills.html';",
    "  if (urlPath === '/newpage') urlPath = '/newpage.html';",
    "  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\\/+/, '');",
    '}',
  ].join('\n');
  const aliases = owes.serveStaticAliases(serverSrc);
  check('serveStaticAliases reads every alias between the header and the rel line', () =>
    assert.deepEqual(aliases, ['/newpage', '/skills'])
  );

  const pagepathsSrc = "const PAGES = [{ what: 'skills', marker: '/skills.js', paths: ['/skills', '/skills.html'] }];\n";
  const gaps = owes.pageGaps(aliases, pagepathsSrc);
  check('the alias with no mention anywhere in test/pagepaths.mjs is named', () => assert.deepEqual(gaps, ['/newpage']));
}

await cleanupTmp(tmp);

/* ===================================================================== *
 * end to end, against this repo's own tree
 * ===================================================================== */

console.log('\nend to end, against this repo\n');

{
  const r = spawnSync(process.execPath, [BIN], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  check('exits 0 (nothing owed) or 1 (something is) — never a crash', () =>
    assert.ok(r.status === 0 || r.status === 1, `status ${r.status}\n${r.stderr}`)
  );
  const lines = r.stdout.split('\n').filter((l) => l.startsWith('README.md') || l.startsWith('lib/evidence.js') || l.startsWith('test/pagepaths.mjs'));
  check('every finding names one of the four suites this file checks', () =>
    assert.ok(
      lines.every((l) => /\((test\/routes\.mjs|test\/configtable\.mjs|test\/evidence\.mjs|test\/pagepaths\.mjs)\)$/.test(l)),
      lines.join('\n')
    )
  );
  // The API table, Config table and evidence register are each gated by their own
  // suite in `npm test` — test/routes.mjs, test/configtable.mjs, test/evidence.mjs —
  // so on a tree where those pass (which is the tree this suite itself runs in), this
  // tool finding anything under those three names would be this tool disagreeing with
  // a suite that is, by construction, green. It cannot find real debt there; it can
  // only be wrong.
  check('and none of the three gated-elsewhere registries show a finding', () =>
    assert.ok(
      !lines.some((l) => /\((test\/routes\.mjs|test\/configtable\.mjs|test\/evidence\.mjs)\)$/.test(l)),
      lines.join('\n')
    )
  );
  // test/pagepaths.mjs used to have no equivalent gate — nothing asserted every
  // serveStatic alias had a PAGES/REDIRECTS entry, which is the whole reason this tool
  // exists. bc-khoe.27.9 filed the five-page gap this used to assert (rather than
  // fixing it here, since each page needed its own decision about what to assert) and
  // then closed it: /foundations, /flow, /map, /requirements and /coverage all have
  // PAGES entries now, so this tool finds nothing left to name in that registry.
  check('and it finds nothing left in test/pagepaths.mjs, now that bc-khoe.27.9 landed', () =>
    assert.ok(!lines.some((l) => l.endsWith('(test/pagepaths.mjs)')), lines.join('\n'))
  );
}

console.log(failures ? `\n${failures} failed\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
