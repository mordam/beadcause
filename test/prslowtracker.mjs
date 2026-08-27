#!/usr/bin/env node
/**
 * A tracker too slow to read is an answer on the delivery card, not a 500.
 *
 *     npm test
 *     node test/prslowtracker.mjs
 *
 * bc-4jkjv. `GET /api/pr` opens with a bead read — `bd show` for the id on the card —
 * and that read sat outside everything the route's own docstring promises about
 * failure. `gh` missing, the PR deleted, GitHub unreachable were all answers with a
 * sentence in `unavailable`; the bead read was not, and a `bd` that did not come back
 * fell out of the route's catch-all as a 500.
 *
 * Which is not a hypothetical shape. On 2026-08-25 one workspace's Dolt could not be
 * read at all, so **every** `bd` call on this Mac spent the full `BD_TIMEOUT` and was
 * then killed:
 *
 *     20:24:09.972Z  bd show dv-f5z3 … timed out in deluvia: still running after 120s
 *     20:24:09.988Z  slow GET /api/pr 120120ms cold — 120101ms of it waiting on 1 child
 *
 * Five of those landed inside one second. `public/report.js` files on any status `>= 500`
 * — "a 500 is the daemon failing rather than answering" — so a daemon that was serving
 * every other route on the box raised a sev2 P0 about itself, twice, and the incident
 * clock started on a card nobody could have fixed by fixing this repo.
 *
 * Three claims, and they are different in kind on purpose:
 *
 * 1. **The route answers.** Driven over real HTTP against `createApp`, because the fact
 *    under test is the status code that reaches the phone, and `ensurePr` in
 *    public/app.js only ever reads `pr` and `unavailable` off the body.
 * 2. **The sentence is written here, not passed through.** `err.message` on this path is
 *    bd's whole command line, and the actor in it is a name *and an email address* —
 *    which `ensurePr` would paint straight onto the card. So the body is asserted to
 *    carry no `bd `, no `--json`, and no `@`.
 * 3. **`timedOut` is real.** The fix keys off a flag `lib/bd.js` sets, so the flag is
 *    pinned against the actual binary-killing path rather than trusted: a fake `bd` that
 *    sleeps, a 200ms ceiling, and the error that comes back.
 *
 * And two things it deliberately does *not* pin. A `bd` that answered and said "no such
 * bead" must **not** be swallowed into a 200 — that is a different fact, and turning it
 * into the 404 it should be is bc-fggc's bead and bc-fggc's review — so what is asserted
 * is only that it is not a 200, which stays true whichever way that lands. And the found
 * path has to still work, because a route that answered everything with `unavailable`
 * would pass claim 1 while serving nothing.
 *
 * No tracker, no workspace with anything in it, and nothing here opens a window.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-prslow-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

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

/* ------------------------------------------------------------------- the app */

const ws = path.join(tmp, 'ws');
fs.mkdirSync(path.join(ws, '.beads'), { recursive: true });

// Never actually spawned on the route path — every `show` below is substituted. It has to
// exist because `Bd` is constructed with it at `createApp` time.
const FAKE = path.join(tmp, 'bd');
fs.writeFileSync(FAKE, "#!/usr/bin/env node\nprocess.stdout.write('[]');\n", { mode: 0o755 });

const cfg = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'prslow-token',
  actor: 'beadcause-test',
  bdBin: FAKE,
  workspaces: [{ name: 'demo', dir: ws }],
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const { createApp, listen } = await import(LIB('server.js'));
const { Bd } = await import(LIB('bd.js'));

const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const port = await boundPort(servers);

const get = (pathname) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', headers: { 'x-beadcause-token': cfg.token } },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, body: out, json: JSON.parse(out || '{}') }));
      }
    );
    req.on('error', reject);
    req.end();
  });

const card = '/api/pr?workspace=demo&id=bc-demo1';

/* ---------------------------------------------- a tracker that did not come back */

console.log('\na tracker that did not answer\n');

// The error `lib/bd.js` builds for a child it killed itself, verbatim — command line,
// actor, email address and all. Claim 3 below is what pins that this is still its shape.
const TIMEOUT_MESSAGE =
  'bd show bc-demo1 --json --actor beadcause (someone@example.com) timed out in demo: ' +
  'still running after 120s, killed rather than broken';

app.bd.show = async () => {
  throw Object.assign(new Error(TIMEOUT_MESSAGE), { timedOut: true });
};

const slow = await get(card);
check(() => assert.equal(slow.status, 200), 'GET /api/pr answers 200 rather than a 500 the page would file a P0 for');
check(() => assert.equal(slow.json.pr, null), 'with no pull request, because there was no bead to read one out of');
check(
  () =>
    assert.ok(
      /did not answer in time/i.test(String(slow.json.unavailable || '')),
      `unavailable was ${JSON.stringify(slow.json.unavailable)}`
    ),
  'and a sentence in `unavailable` — the channel the card already draws'
);
check(
  () =>
    assert.ok(/\bdemo\b/.test(String(slow.json.unavailable || '')), `unavailable was ${JSON.stringify(slow.json.unavailable)}`),
  'naming the workspace that is slow, so two trackers do not read as one outage'
);

for (const leak of ['bd ', '--json', '@', 'killed rather than broken']) {
  check(
    () => assert.ok(!slow.body.includes(leak), `the body carried ${JSON.stringify(leak)}: ${slow.body.slice(0, 200)}`),
    `and none of bd's own message reaches the card — no ${JSON.stringify(leak)}`
  );
}

/* ------------------------------------------- a tracker that answered and said no */

console.log('\na tracker that answered\n');

app.bd.show = async () => {
  throw new Error('bd show bc-demo1 --json failed in demo: Error fetching bc-demo1: no issues found matching');
};

const gone = await get(card);
check(
  () => assert.notEqual(gone.status, 200, `answered 200 with ${gone.body.slice(0, 160)}`),
  'a bead that is gone is not swallowed into the same 200 — that fact is bc-fggc, and it is a different one'
);

/* ------------------------------------------------------ and the found path works */

app.bd.show = async () => ({ id: 'bc-demo1', description: 'an ordinary bead with no delivery in it' });

const found = await get(card);
check(() => assert.equal(found.status, 404), 'a bead that reads gets the answer it always got — 404');
check(
  () => assert.ok(/beadpr/.test(String(found.json.error || '')), `error was ${JSON.stringify(found.json.error)}`),
  'and it is "no beadpr block on this question", so the read still reaches the parse'
);

/* ------------------------------------------------- the flag the fix is keyed on */

console.log('\nthe flag the fix reads\n');

const SLEEPER = path.join(tmp, 'bd-sleep');
fs.writeFileSync(SLEEPER, '#!/usr/bin/env node\nsetTimeout(() => {}, 60_000);\n', { mode: 0o755 });

const real = new Bd({ bin: SLEEPER, actor: 'beadcause-test' });
let killed = null;
try {
  await real.run({ name: 'demo', dir: ws }, ['show', 'bc-demo1'], { timeout: 200 });
} catch (err) {
  killed = err;
}
check(() => assert.ok(killed, 'a bd that never answers resolved instead of throwing'), 'a bd that outruns its ceiling throws');
check(
  () => assert.equal(killed?.timedOut, true, `timedOut was ${JSON.stringify(killed?.timedOut)}`),
  'and marks the error `timedOut` — the one thing telling a slow tracker from a broken one'
);

/* ------------------------------------------------------------------------ end */

for (const s of servers) s.close();
cleanupTmp(tmp);

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} ok\x1b[0m\n`);
process.exit(failures ? 1 : 0);
