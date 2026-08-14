#!/usr/bin/env node
/**
 * `/api/bead` costs **one** `bd` spawn, not two.
 *
 *     npm test
 *     node test/beadsheetspawns.mjs
 *
 * bc-kki5. Tapping a bead opens a sheet, and the sheet was slow. The route asked
 * `bd show` and then `bd comments`, and waited on the sum of two processes: its own
 * instrument (`npm run timings`) reported `sub 1.00` at fan-out `1×` — every
 * millisecond spent waiting on one child after another, nothing overlapping. On this
 * Mac each of those spawns cost 1–2 seconds at the median, with a tail past 45.
 *
 * `bd show --include-comments` answers both in one spawn, byte-for-byte the same
 * comments `bd comments` returns. Measured paired, alternating which form ran first:
 * **13 of 14 pairs faster, median 1376ms → 1012ms.**
 *
 * **The obvious fix was measured and rejected, which is why this test asserts a count
 * and not a clock.** Starting the two calls together with `Promise.all` looks like a
 * free win and is not one: over 32 paired runs it came out a *wash to slightly worse*
 * (median 126–361ms behind the serial pair, ahead in only 10 of 32), because embedded
 * Dolt gives two concurrent readers no real concurrency — two `bd` reads at once cost
 * ~2.2× one alone. Not lock contention either: zero of 20 rounds tripped the lock
 * retry. So the property worth pinning is **how many times the route shells out**, and
 * a future "optimisation" that parallelises its way back to two spawns should fail
 * here rather than quietly cost the sheet a second.
 *
 * Four claims:
 *
 * 1. **One spawn per sheet.** The regression this whole bead is about.
 * 2. **The payload is unchanged** — the same issue fields, the same thread. A faster
 *    route that drops the comments is not a faster route.
 * 3. **A bead with no thread answers `[]`, not `null`.** `--include-comments` returns
 *    `comments: null` for an empty thread where `bd comments` returned `[]`, so this
 *    is a real shape change the client would meet as a crash rather than an empty list.
 * 4. **A `bd` too old for the flag still works.** It falls back to the two calls; a
 *    sheet that is slow beats a sheet that is broken, and an unknown flag makes `bd`
 *    exit non-zero having answered nothing at all.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-beadsheet-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

/* --------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
const check = async (name, fn) => {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String((err && err.message) || err).split('\n').slice(0, 8).join('\n       ')}`);
  }
};

console.log('\nthe bead sheet costs one bd spawn, not two\n');

const BEADS = path.join(tmp, 'beads', 'zz', '.beads');
const CHECKOUT = path.join(tmp, 'projects', 'zz');
fs.mkdirSync(BEADS, { recursive: true });
fs.mkdirSync(CHECKOUT, { recursive: true });

/**
 * A stub `bd` that logs its argv, one line per spawn.
 *
 * `modern` answers `--include-comments` the way bd 1.2.1 does — the thread inline, and
 * **`null` rather than `[]`** when there is none, which is claim 3. `legacy` rejects the
 * flag exactly as an older bd does: `unknown flag`, exit 1, nothing on stdout.
 */
const makeBd = (file, log, { modern }) => {
  fs.writeFileSync(
    file,
    [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      'const args = process.argv.slice(2);',
      'const LOG = ' + JSON.stringify(log) + ';',
      'fs.appendFileSync(LOG, args.join(" ") + "\\n");',
      'const verb = args[0];',
      "const THREAD = [{ id: 'c1', issue_id: 'zz-aaa', author: 'adam', text: 'first' }];",
      "if (verb === 'export') { console.log(''); process.exit(0); }",
      "const wants = args.includes('--include-comments');",
      `const MODERN = ${modern ? 'true' : 'false'};`,
      'if (wants && !MODERN) {',
      '  process.stderr.write("Error: unknown flag: --include-comments\\n");',
      '  process.exit(1);',
      '}',
      "if (verb === 'show') {",
      '  const id = args[1];',
      "  if (id !== 'zz-aaa' && id !== 'zz-bare') {",
      '    process.stderr.write(`Error fetching ${id}: no issue found matching "${id}"\\n`);',
      '    process.exit(1);',
      '  }',
      "  const row = { id, title: 'a bead', status: 'open', description: 'why' };",
      // The empty-thread case is `zz-bare`, and the modern bd says `null` for it.
      "  if (wants) row.comments = id === 'zz-bare' ? null : THREAD;",
      '  console.log(JSON.stringify([row]));',
      '  process.exit(0);',
      '}',
      "if (verb === 'comments') {",
      "  console.log(JSON.stringify(args[1] === 'zz-bare' ? [] : THREAD));",
      '  process.exit(0);',
      '}',
      'process.exit(0);',
    ].join('\n')
  );
  fs.chmodSync(file, 0o755);
};

const { createApp, listen } = await import(LIB('server.js'));

const baseCfg = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'beadsheet-test-token',
  actor: 'beadcause-test',
  workspaces: [{ name: 'zz', dir: BEADS }],
  sessionDirs: { zz: CHECKOUT },
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

/** A daemon over a stub bd, plus a `call` bound to its port and the log it writes. */
const daemon = async (tag, { modern }) => {
  const log = path.join(tmp, `${tag}.log`);
  const bin = path.join(tmp, `bd-${tag}`);
  fs.writeFileSync(log, '');
  makeBd(bin, log, { modern });
  const cfg = { ...baseCfg, bdBin: bin };
  const app = createApp(cfg);
  const servers = listen(cfg, app.handler);
  const port = await boundPort(servers);
  const call = (pathname) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: pathname, method: 'GET', headers: { 'x-beadcause-token': cfg.token } },
        (res) => {
          let raw = '';
          res.on('data', (d) => (raw += d));
          res.on('end', () => {
            let body = null;
            try {
              body = JSON.parse(raw);
            } catch {
              body = raw;
            }
            resolve({ status: res.statusCode, body });
          });
        }
      );
      req.on('error', reject);
      req.end();
    });
  // Only the spawns this route caused: the daemon warms `bd export` behind every
  // request and counting that would make this a test of the sweep instead.
  const spawns = () =>
    fs
      .readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .filter((l) => !l.startsWith('export'));
  const reset = () => fs.writeFileSync(log, '');
  return { call, spawns, reset, servers };
};

/* ------------------------------------------------------------------- the claims */

const modern = await daemon('modern', { modern: true });

const sheet = await modern.call('/api/bead?workspace=zz&id=zz-aaa');

await check('the sheet still carries the bead and its whole thread', () => {
  assert.equal(sheet.status, 200, `expected 200, got ${sheet.status}`);
  assert.equal(sheet.body.id, 'zz-aaa');
  assert.equal(sheet.body.title, 'a bead');
  assert.equal(sheet.body.workspace, 'zz');
  assert.equal(sheet.body.comments.length, 1, 'the comments came back with it, not instead of it');
  assert.equal(sheet.body.comments[0].text, 'first');
});

await check('and cost exactly one bd spawn to do it', () => {
  const spawns = modern.spawns();
  assert.equal(
    spawns.length,
    1,
    `the sheet shelled out ${spawns.length} times, not once: ${JSON.stringify(spawns)}. ` +
      'Two spawns is the regression this bead fixed — see the note at the top of this file, ' +
      'and note that parallelising them back is measured to be no faster.'
  );
  assert.match(spawns[0], /^show zz-aaa --include-comments/, 'the one call must be the one that carries the thread');
});

await check('a bead with no thread answers [], not null', async () => {
  modern.reset();
  const bare = await modern.call('/api/bead?workspace=zz&id=zz-bare');
  assert.equal(bare.status, 200);
  assert.deepEqual(bare.body.comments, [], '`--include-comments` says null for an empty thread; the sheet must never see it');
  assert.equal(modern.spawns().length, 1, 'still one spawn on the empty-thread path');
});

await check('a bead that does not exist is still a 404, not a 500', async () => {
  const missing = await modern.call('/api/bead?workspace=zz&id=zz-nope');
  assert.equal(missing.status, 404, `expected 404 for an unknown bead, got ${missing.status}`);
  assert.match(String(missing.body.error), /no such bead: zz-nope/);
});

/* -------------------------------------------------- and on a bd without the flag */

const legacy = await daemon('legacy', { modern: false });

await check('a bd too old for the flag falls back to the two calls rather than breaking', async () => {
  const old = await legacy.call('/api/bead?workspace=zz&id=zz-aaa');
  assert.equal(old.status, 200, `an older bd must still serve the sheet, got ${old.status}`);
  assert.equal(old.body.id, 'zz-aaa');
  assert.equal(old.body.comments.length, 1, 'the thread still arrives, by the slow road');
  const spawns = legacy.spawns();
  assert.equal(spawns.length, 3, `expected the rejected probe plus two calls, got ${JSON.stringify(spawns)}`);
  assert.match(spawns[0], /^show zz-aaa --include-comments\b/, 'it probes once');
  assert.match(spawns[1], /^show zz-aaa (?!--include-comments)/, 'then the plain show');
  assert.match(spawns[2], /^comments zz-aaa\b/, 'then the thread on its own');
});

await check('and it remembers, so the wasted probe happens once and not once per tap', async () => {
  legacy.reset();
  const again = await legacy.call('/api/bead?workspace=zz&id=zz-aaa');
  assert.equal(again.status, 200);
  const spawns = legacy.spawns();
  assert.equal(spawns.length, 2, `the second sheet must not probe again, got ${JSON.stringify(spawns)}`);
  assert.ok(
    !spawns.some((s) => s.includes('--include-comments')),
    'it asked for the flag a second time after being told it does not exist'
  );
});

for (const s of [...modern.servers, ...legacy.servers]) s.close();
cleanupTmp(tmp);

/* ---------------------------------------------------------------------- report */

console.log(`\n${ran - failures}/${ran} bead-sheet spawn checks passed`);
process.exit(failures ? 1 : 0);
