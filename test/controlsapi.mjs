#!/usr/bin/env node
/**
 * `GET /api/controls` — the internal-audit instrument, over the real server. bc-eqn1.3.
 *
 *     npm test
 *     node test/controlsapi.mjs
 *
 * The route is booted through the real `createApp` rather than asserted against a fake,
 * for the reason test/routes.mjs sets out at length: a suite that checks a contract
 * against its own server can be green while the real one answers something else.
 *
 * What is asserted, and why each would be a silent lie:
 *
 * 1. **It always has a denominator.** `/api/requirements` answers `{ corpus: null }` on an
 *    install with no architecture checkout, because that corpus lives in a repo most Macs
 *    do not have. This one cannot: lib/controls.js ships with beadcause and is built at
 *    import, so a payload with no `total` would mean the build was broken rather than that
 *    the install was ordinary. Every field a report reads has to be there on a machine
 *    that has recorded nothing at all — which is what this suite's machine is.
 * 2. **The four findings are lists, not counts.** "137 unevidenced" is a statistic;
 *    `SOC2.CC6.1` is a task. A payload that summarised them would be one nobody could act
 *    on without a second request per row.
 * 3. **`?id=` resolves through the corpus, and refuses.** An unknown id is a 404 rather
 *    than an empty edge list, because an empty edge list is indistinguishable from a real
 *    control nothing has evidenced yet — which is the ordinary state of almost every
 *    control here, and therefore the worst possible thing to confuse a typo with.
 * 4. **`?months=` changes the window, not the corpus.** A report over a quarter measures
 *    staleness against a quarter and still counts all 192 controls.
 * 5. **It is behind the token like everything else under `/api`.**
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-controlsapi-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });
process.on('exit', () => removeTreeSync(tmp));

let failures = 0;
const acheck = async (name, fn) => {
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${err.message.split('\n')[0]}`);
  }
};
const assert = (ok, why) => {
  if (!ok) throw new Error(why);
};

const wsDir = path.join(tmp, 'ws');
fs.mkdirSync(path.join(wsDir, '.beads'), { recursive: true });

// A `bd` that answers nothing. This route reads git refs and an in-process corpus and
// never asks the tracker anything, which is itself worth pinning: a compliance denominator
// that depended on a workspace being reachable would go blank on the day one was not.
const FAKE = path.join(tmp, 'fake-bd');
fs.writeFileSync(FAKE, '#!/usr/bin/env node\nprocess.stdout.write("[]");\n', { mode: 0o755 });

const TOKEN = 'controlsapi-token';
const cfg = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: TOKEN,
  actor: 'beadcause-test',
  bdBin: FAKE,
  workspaces: [{ name: 'demo', dir: path.join(wsDir, '.beads') }],
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const { createApp, listen } = await import(path.join(ROOT, 'lib', 'server.js'));
const { boundPort } = await import('./helpers/net.mjs');
const { corpus } = await import(path.join(ROOT, 'lib', 'controls.js'));

const app = createApp({ ...cfg, port: 0 });
const servers = listen({ ...cfg, port: 0 }, app.handler);
const port = await boundPort(servers);

// `agent: false` for test/historyapi.mjs's reason: a kept-alive socket makes
// `server.close()` wait for ever, and the suite passes every check and then hangs.
const ask = (query, headers = { 'x-beadcause-token': TOKEN }) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: `/api/controls${query}`, method: 'GET', agent: false, headers },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(body);
          } catch {
            /* a non-JSON body is the assertion's problem */
          }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });

const size = corpus().size;

console.log('the denominator is always there');

await acheck('the summary answers with the whole corpus', async () => {
  const { status, body } = await ask('');
  assert(status === 200, `status ${status}`);
  assert(body.size === size, `size ${body.size} of ${size}`);
  assert(body.totals.total === size, `total ${body.totals?.total}`);
  assert(body.crosswalkEdges > 0, 'no crosswalk edges');
});

await acheck('every framework is a row, even the ones nothing has recorded', async () => {
  const { body } = await ask('');
  assert(body.frameworks.length === 6, `${body.frameworks.length} frameworks`);
  assert(
    body.frameworks.every((f) => f.total > 0),
    JSON.stringify(body.frameworks.map((f) => [f.token, f.total]))
  );
  assert(body.frameworks.some((f) => f.certifiable === false), 'no guidance framework is marked as such');
});

await acheck('the findings are lists with names in them, not counts', async () => {
  const { body } = await ask('');
  assert(Array.isArray(body.unevidenced) && body.unevidenced.length === size, `${body.unevidenced?.length} unevidenced`);
  assert(body.unevidenced.includes('SOC2.CC6.1'), 'a known criterion is missing from the list');
  assert(Array.isArray(body.forecastOnly) && Array.isArray(body.stale) && Array.isArray(body.orphans), 'a finding is not a list');
});

await acheck('and it says so in one sentence a person can read', async () => {
  const { body } = await ask('');
  assert(body.summary.includes(`of ${size} controls are proved by a merge`), body.summary);
  assert(body.summary.includes('with no evidence at all'), body.summary);
});

console.log('\nthe window is a parameter, the corpus is not');

await acheck('?months= measures against a different period and counts the same controls', async () => {
  const { body } = await ask('?months=3');
  assert(body.reviewMonths === 3, `reviewMonths ${body.reviewMonths}`);
  assert(body.totals.total === size, `total ${body.totals.total}`);
});

await acheck('and nonsense in it falls back to the default rather than to zero', async () => {
  const { body } = await ask('?months=nonsense');
  assert(body.reviewMonths === 12, `reviewMonths ${body.reviewMonths}`);
});

console.log('\ndrilling into one control');

await acheck('?id= answers with the record and both directions of the crosswalk', async () => {
  const { status, body } = await ask('?id=SOC2.CC6.1');
  assert(status === 200, `status ${status}`);
  assert(body.control.title.length > 0, 'no title');
  assert(body.control.kind === 'criterion', body.control.kind);
  assert(body.satisfiedBy.length > 0, 'nothing satisfies CC6.1, which the corpus disagrees with');
  assert(Array.isArray(body.edges) && body.edges.length === 0, 'this machine has recorded nothing');
});

await acheck('an id the corpus does not have is a 404, not an empty answer', async () => {
  const { status, body } = await ask('?id=ISO42001.A.6.2.9');
  assert(status === 404, `status ${status}`);
  assert(body.error.includes('ISO42001.A.6.2.9'), body.error);
});

await acheck('and it needs the token like everything else under /api', async () => {
  const { status } = await ask('', {});
  assert(status === 401 || status === 403, `status ${status}`);
});

for (const s of servers) s.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
