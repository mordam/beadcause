#!/usr/bin/env node
//
// The inbox filter, which lives on the server rather than in localStorage.
//
//   npm test                     (runs it alongside the rest)
//   node test/filter.mjs
//
// Two failures are worth having a suite for, and neither is visible by reading
// one function:
//
// 1. **The poll used to clobber it.** Four call sites in lib/server.js save
//    `{ notified, commentCounts }`, and saveState replaced the file wholesale, so
//    the very next sweep dropped any key a client had written. The filter is the
//    first field in state.json with two writers, so it is the first to notice.
//
// 2. **An unreadable state file must read as "no filter".** loadState's fallback
//    was `{ notified: [] }`, which returns `filter: undefined` — and a filter that
//    arrives empty rather than absent hides every bead in the inbox with nothing
//    on screen to say why.
//
// The HTTP half proves the round trip the client actually uses: the filter is
// carried on the same payload as the questions, because a second fetch would paint
// the unfiltered list first and then snatch it away.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-filter-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { loadState, saveState, STATE_PATH } = await import(LIB('config.js'));

let failures = 0;
let ran = 0;
const ok = (name) => {
  ran += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
};
const bad = (name, detail) => {
  ran += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (fn, name) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

const writeRaw = (obj) => fs.writeFileSync(STATE_PATH, typeof obj === 'string' ? obj : JSON.stringify(obj));

console.log('inbox filter');

/* ------------------------------------------------------------ the defaults */

fs.rmSync(STATE_PATH, { force: true });
check(() => {
  assert.deepEqual(loadState().filter, { space: 'all', workspace: 'all' });
}, 'no state file at all reads as no filter, not an empty one');

writeRaw('{"notified": [');
check(() => {
  assert.deepEqual(loadState().filter, { space: 'all', workspace: 'all' });
}, 'and so does a half-written file');

writeRaw({ notified: [], filter: { space: 'personal' } });
check(() => {
  assert.deepEqual(loadState().filter, { space: 'personal', workspace: 'all' });
}, 'a filter missing one half keeps the half it has and defaults the other');

writeRaw({ notified: [], filter: 'personal' });
check(() => {
  assert.deepEqual(loadState().filter, { space: 'all', workspace: 'all' });
}, 'a filter of the wrong shape entirely falls back rather than throwing');

/* ------------------------------------------------- the clobber, both ways */

fs.rmSync(STATE_PATH, { force: true });
saveState({ notified: ['a-1'], commentCounts: { 'a-1': 2 } });
saveState({ filter: { space: 'personal', workspace: 'sophab' } });
check(() => {
  const s = loadState();
  assert.deepEqual(s.notified, ['a-1'], 'notified');
  assert.deepEqual(s.commentCounts, { 'a-1': 2 }, 'commentCounts');
  assert.deepEqual(s.filter, { space: 'personal', workspace: 'sophab' }, 'filter');
}, 'writing a filter keeps notified and commentCounts');

// The regression that matters: this is the exact literal all four poll call sites
// pass, and before saveState merged it wiped the filter on the next sweep.
saveState({ notified: ['a-1', 'a-2'], commentCounts: { 'a-1': 3 } });
check(() => {
  const s = loadState();
  assert.deepEqual(s.filter, { space: 'personal', workspace: 'sophab' }, 'filter survived the poll');
  assert.deepEqual(s.notified, ['a-1', 'a-2'], 'notified still updated');
}, 'and a poll write keeps the filter — the four saveState sites no longer clobber');

/* ----------------------------------------------------------- the round trip */

const { createApp, listen } = await import(LIB('server.js'));

const cfg = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'filter-test-token',
  actor: 'beadcause-test',
  workspaces: [],
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

// A port picked up front rather than `port: 0` and `address()`: listen() binds
// asynchronously and hands back the servers immediately, so address() is still null
// on the next line.
const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port: p } = probe.address();
    probe.close(() => resolve(p));
  });
});

const app = createApp({ ...cfg, port });
const servers = listen({ ...cfg, port }, app.handler);

const call = (pathname, opts = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: opts.method || 'GET',
        headers: { 'content-type': 'application/json', 'x-beadcause-token': cfg.token },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });

// The bind is a tick or two behind listen() returning.
for (let i = 0; i < 100; i += 1) {
  try {
    await call('/api/health');
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 50));
  }
}

const posted = await call('/api/filter', { method: 'POST', body: JSON.stringify({ space: 'work', workspace: 'climative' }) });
check(() => {
  assert.equal(posted.status, 200);
  assert.deepEqual(JSON.parse(posted.body).filter, { space: 'work', workspace: 'climative' });
}, 'POST /api/filter stores a filter and echoes it back');

check(() => {
  assert.deepEqual(loadState().filter, { space: 'work', workspace: 'climative' });
}, 'and it survives to disk, so a restart comes back to it');

const listed = await call('/api/questions');
check(() => {
  assert.equal(listed.status, 200);
  assert.deepEqual(JSON.parse(listed.body).filter, { space: 'work', workspace: 'climative' });
}, 'the inbox payload carries it, so the first render is already filtered');

const blanked = await call('/api/filter', { method: 'POST', body: JSON.stringify({}) });
check(() => {
  assert.deepEqual(JSON.parse(blanked.body).filter, { space: 'all', workspace: 'all' });
  assert.deepEqual(loadState().filter, { space: 'all', workspace: 'all' });
}, 'an empty write clears back to All rather than storing undefined');

servers.forEach((s) => s.close());
fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
