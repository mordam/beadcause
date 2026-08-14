#!/usr/bin/env node
/**
 * A file claim says which *bead* holds it, not just which branch.
 *
 *     npm test
 *     node test/claimbead.mjs
 *
 * bc-q5c2.1. `scripts/claim-guard.sh` sends the branch and leaves the `bead` field empty,
 * because turning a branch tail into a verified id needs the tracker and nothing may spawn
 * `bd` in front of every Write on this Mac. lib/claimbead.js does it in the daemon instead,
 * once per branch, and lib/claims.js takes the answer afterwards.
 *
 * Six properties, and five of them fail silently if they are wrong:
 *
 * 1. **A tag is lossy, so the candidates are plural.** `tagOf` strips the punctuation a ref
 *    cannot hold, so `bc-p49x.5` and `bc-p49x5` are the same branch tail. Reading only the
 *    undotted form would leave the field empty for most of this Mac, where nearly every live
 *    worktree belongs to a child of an epic.
 * 2. **Verified, never guessed.** A candidate is an answer only once the tracker says the
 *    bead exists — `candidateTiers` in lib/beadref.js is explicit about this and it matters
 *    more here, because the alternative is a claim asserting the wrong bead.
 * 3. **An ambiguous tag names nobody.** Two beads whose tags collide cannot be told apart by
 *    a branch name, and naming the wrong one is worse than naming none.
 * 4. **Once per branch, not once per claim.** The whole cost argument. A memo that quietly
 *    stopped working would put a `bd` spawn behind every edit in every session.
 * 5. **A tracker that could not be read is not an answer**, and is asked again — otherwise a
 *    Dolt lock lasting a second costs a branch its bead for the life of the daemon.
 * 6. **And the daemon actually asks.** Asserted through a real `POST /api/claims` against a
 *    real `Bd` over a stub binary, because a unit test of the resolver passes just as
 *    happily against a server that never calls it.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-claimbead-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { candidateIds, createBranchBeads } = await import(LIB('claimbead.js'));
const { forgetPrefixes } = await import(LIB('beadref.js'));
const claims = await import(LIB('claims.js'));

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

console.log('\nwhich bead a claimed file’s branch belongs to\n');

// One workspace, its tracker directory, and the checkout a shell there would resolve to.
// `ownWorkspace` runs `resolveSessionDir` backwards over exactly these two facts.
const BEADS = path.join(tmp, 'beads', 'zz', '.beads');
const CHECKOUT = path.join(tmp, 'projects', 'zz');
fs.mkdirSync(BEADS, { recursive: true });
fs.mkdirSync(CHECKOUT, { recursive: true });
const cfgFor = (name) => ({ workspaces: [{ name, dir: BEADS }], sessionDirs: { [name]: CHECKOUT } });

/**
 * A tracker holding exactly these ids.
 *
 * `show` on anything else rejects the way the real `bd` does — non-zero, with "no issues
 * found" in the message — because that sentence is the only thing separating "there is no
 * such bead" from "the tracker could not answer", and the whole of property 5 hangs on it.
 */
function tracker(ids, { broken = () => false } = {}) {
  const asked = [];
  return {
    asked,
    async json(ws, args) {
      asked.push(args.join(' '));
      return [{ id: `${ids[0] || 'zz-none'}` }];
    },
    async show(ws, id) {
      asked.push(`show ${id}`);
      if (broken()) throw new Error(`bd show ${id} failed in ${ws.name}: dolt: could not acquire the lock`);
      if (ids.includes(id)) return { id, title: `bead ${id}` };
      throw new Error(`bd show ${id} failed in ${ws.name}: no issues found matching the provided IDs`);
    },
  };
}

/* ------------------------------------------------------------------ candidates */

await check('the undotted reading comes first, and a trailing digit or two is put back', () => {
  assert.deepEqual(candidateIds('bc', 'worktree-park-epic-p9vx'), ['bc-p9vx']);
  assert.deepEqual(candidateIds('bc', 'worktree-freeze-timers-p49x5'), ['bc-p49x5', 'bc-p49x.5']);
  assert.deepEqual(candidateIds('bc', 'worktree-advocate-reentry-goo15'), ['bc-goo15', 'bc-goo1.5', 'bc-goo.15']);
});

await check('and a branch that could not be a tag yields nothing to ask about', () => {
  // `main` is a *candidate* rather than an exclusion, and that is the design: nothing here
  // decides what a branch name means, the tracker does. `bc-main` costs one `bd show`, once
  // in the life of the daemon, and comes back not-a-bead.
  assert.deepEqual(candidateIds('bc', 'main'), ['bc-main']);
  assert.deepEqual(candidateIds('bc', ''), []);
  assert.deepEqual(candidateIds('bc', 'worktree-x-thistagiswaytoolong'), []);
  assert.deepEqual(candidateIds('', 'worktree-x-p9vx'), [], 'no prefix, no candidates: a tracker mid-write asks again later');
});

/* ------------------------------------------------------------ the lookup itself */

await check('a child bead is resolved from the tail its ref could not keep the dot in', async () => {
  forgetPrefixes();
  claims.reset();
  const bd = tracker(['zz-p49x.5']);
  const beads = createBranchBeads({ cfg: cfgFor('zz'), bd, attribute: claims.attribute, log: () => {} });
  assert.equal(await beads.follow(CHECKOUT, 'worktree-freeze-timers-p49x5'), 'zz-p49x.5');
  assert.ok(bd.asked.includes('show zz-p49x5'), 'the undotted candidate is asked about first');
});

await check('AN UNVERIFIED TAIL IS NOT AN ANSWER', async () => {
  forgetPrefixes();
  claims.reset();
  const bd = tracker(['zz-p49x.5']);
  const beads = createBranchBeads({ cfg: cfgFor('zz'), bd, attribute: claims.attribute, log: () => {} });
  // A tree somebody named by hand. The tail looks exactly like a tag and belongs to no bead.
  assert.equal(await beads.follow(CHECKOUT, 'worktree-advocate-reentry-g15'), '');
});

await check('two beads whose tags collide name nobody', async () => {
  forgetPrefixes();
  claims.reset();
  const said = [];
  const bd = tracker(['zz-p49x5', 'zz-p49x.5']);
  const beads = createBranchBeads({ cfg: cfgFor('zz'), bd, attribute: claims.attribute, log: (m) => said.push(m) });
  assert.equal(await beads.follow(CHECKOUT, 'worktree-freeze-timers-p49x5'), '');
  assert.match(said.join('\n'), /could be zz-p49x5 or zz-p49x\.5/, 'and it says so, because it is a real ambiguity');
});

await check('a checkout belonging to no workspace asks the tracker nothing at all', async () => {
  forgetPrefixes();
  claims.reset();
  const bd = tracker(['zz-p49x.5']);
  const beads = createBranchBeads({ cfg: cfgFor('zz'), bd, attribute: claims.attribute, log: () => {} });
  assert.equal(await beads.follow(path.join(tmp, 'somewhere-else'), 'worktree-x-p49x5'), '');
  assert.deepEqual(bd.asked, [], 'no workspace, no prefix, no spawn');
});

await check('ONCE PER BRANCH — the second claim from it costs nothing', async () => {
  forgetPrefixes();
  claims.reset();
  const bd = tracker(['zz-p49x.5']);
  const beads = createBranchBeads({ cfg: cfgFor('zz'), bd, attribute: claims.attribute, log: () => {} });
  await beads.follow(CHECKOUT, 'worktree-freeze-timers-p49x5');
  const after = bd.asked.length;
  await beads.follow(CHECKOUT, 'worktree-freeze-timers-p49x5');
  await beads.follow(CHECKOUT, 'worktree-freeze-timers-p49x5');
  assert.equal(bd.asked.length, after, 'thousands of claims a day against thirty branches ever');
  // And the branch that resolved to nothing is remembered too, or the cost lands on
  // exactly the sessions whose worktree was named by hand.
  await beads.follow(CHECKOUT, 'worktree-x-nope1');
  const asked = bd.asked.length;
  await beads.follow(CHECKOUT, 'worktree-x-nope1');
  assert.equal(bd.asked.length, asked, 'a verified absence is an answer, and is kept like one');
});

await check('A TRACKER THAT COULD NOT ANSWER IS ASKED AGAIN', async () => {
  forgetPrefixes();
  claims.reset();
  let down = true;
  const said = [];
  const bd = tracker(['zz-p49x.5'], { broken: () => down });
  const beads = createBranchBeads({ cfg: cfgFor('zz'), bd, attribute: claims.attribute, log: (m) => said.push(m) });
  assert.equal(await beads.follow(CHECKOUT, 'worktree-freeze-timers-p49x5'), '', 'no answer, and no claim of one');
  assert.match(said.join('\n'), /could not resolve a bead/);
  await beads.follow(CHECKOUT, 'worktree-freeze-timers-p49x5');
  await beads.follow(CHECKOUT, 'worktree-freeze-timers-p49x5');
  assert.equal(said.length, 1, 'said once per branch, not once per edit — an outage must stay readable');
  down = false;
  assert.equal(await beads.follow(CHECKOUT, 'worktree-freeze-timers-p49x5'), 'zz-p49x.5', 'a Dolt lock is not a verdict');
});

await check('and a tracker with no prefix to give is the same kind of silence', async () => {
  forgetPrefixes();
  claims.reset();
  let down = true;
  const bd = tracker(['zz-p49x.5']);
  // `prefixFor` swallows its own error and answers null, which is also what an empty
  // workspace answers — so a null prefix must not be cached as a verdict about a branch.
  const asking = bd.json.bind(bd);
  bd.json = async (ws, args) => {
    if (down) throw new Error('bd list failed: dolt: could not acquire the lock');
    return asking(ws, args);
  };
  const beads = createBranchBeads({ cfg: cfgFor('zz'), bd, attribute: claims.attribute, log: () => {} });
  assert.equal(await beads.follow(CHECKOUT, 'worktree-freeze-timers-p49x5'), '');
  down = false;
  assert.equal(await beads.follow(CHECKOUT, 'worktree-freeze-timers-p49x5'), 'zz-p49x.5');
});

/* --------------------------------------------------------- and onto the records */

await check('the answer lands on the claims already held, and on the ones after them', async () => {
  forgetPrefixes();
  claims.reset();
  const live = { alive: () => true };
  const now = Date.parse('2026-08-14T09:00:00Z');
  const first = claims.claim('s1', { repo: CHECKOUT, file: 'lib/foo.js', dir: '/wt/a', branch: 'worktree-t-p49x5' }, now, live);
  assert.equal(first.record.bead, '', 'the hook does not know, and does not pretend to');

  const bd = tracker(['zz-p49x.5']);
  const beads = createBranchBeads({ cfg: cfgFor('zz'), bd, attribute: claims.attribute, log: () => {} });
  await beads.follow(CHECKOUT, 'worktree-t-p49x5');

  const [held] = claims.list(now, live);
  assert.equal(held.bead, 'zz-p49x.5', 'back-filled onto the claim that was already there');
  assert.equal(held.since, first.record.since, 'and nothing about who holds what has moved');
  assert.equal(held.state, 'held');

  const later = claims.claim('s1', { repo: CHECKOUT, file: 'lib/bar.js', dir: '/wt/a', branch: 'worktree-t-p49x5' }, now + 1000, live);
  assert.equal(later.record.bead, 'zz-p49x.5', 'and a later claim from that branch arrives with it, without asking again');
});

await check('a branch name in another repo is another branch', async () => {
  claims.reset();
  const live = { alive: () => true };
  const now = Date.parse('2026-08-14T09:00:00Z');
  claims.attribute(CHECKOUT, 'worktree-t-p49x5', 'zz-p49x.5');
  const other = claims.claim('s2', { repo: '/elsewhere/sophab', file: 'lib/foo.js', branch: 'worktree-t-p49x5' }, now, live);
  assert.equal(other.record.bead, '', 'two repos can carry a branch of the same name, and `main` is the obvious one');
  assert.equal(claims.attribute(CHECKOUT, '', 'zz-p49x.5'), 0, 'and a write missing any of the three is not a write');
});

await check('the advocate’s hold says it too — the field’s other reader', async () => {
  const { busyWhy } = await import(LIB('beadfiles.js'));
  const rec = { file: 'lib/foo.js', branch: 'worktree-t-p49x5', bead: 'zz-p49x.5', state: 'held' };
  assert.match(busyWhy([rec], 'declared'), /worktree-t-p49x5 \(zz-p49x\.5\)/, 'the branch to look at, the bead to type');
  assert.match(busyWhy([{ ...rec, bead: '' }], 'declared'), /on worktree-t-p49x5 —/, 'and it degrades to what it always said');
});

/* ------------------------------------------------------------- through the daemon */
//
// The half no unit test reaches: a real `Bd` over a stub binary, a real claim over HTTP,
// and the sentence the hook would print. A resolver the server never calls passes
// everything above.

forgetPrefixes();
claims.reset();

const BD = path.join(tmp, 'fake-bd');
fs.writeFileSync(
  BD,
  [
    '#!/usr/bin/env node',
    "const args = process.argv.slice(2);",
    "const KNOWN = ['zz-bbb.1'];",
    "if (args[0] === 'list') { console.log(JSON.stringify([{ id: 'zz-bbb.1', title: 'a bead' }])); process.exit(0); }",
    "if (args[0] === 'show') {",
    '  const id = args[1];',
    "  if (KNOWN.includes(id)) { console.log(JSON.stringify([{ id, title: 'a bead', status: 'open' }])); process.exit(0); }",
    '  process.stderr.write(`Error fetching ${id}: no issue found matching "${id}"\\n`);',
    "  console.log(JSON.stringify({ error: 'no issues found matching the provided IDs' }));",
    '  process.exit(1);',
    '}',
    'process.exit(0);',
  ].join('\n')
);
fs.chmodSync(BD, 0o755);

const { createApp, listen } = await import(LIB('server.js'));

const cfg = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'claimbead-test-token',
  actor: 'beadcause-test',
  bdBin: BD,
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

const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const port = await boundPort(servers);

const call = (pathname, opts = {}) => {
  const payload = opts.body === undefined ? null : Buffer.from(JSON.stringify(opts.body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: opts.method || 'GET',
        headers: {
          'content-type': 'application/json',
          'x-beadcause-token': cfg.token,
          ...(payload ? { 'content-length': payload.length } : {}),
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
};

/** The lookup is deliberately not awaited by the request, so the reader waits instead. */
const until = async (want, why) => {
  for (let i = 0; i < 100; i += 1) {
    const seen = await want();
    if (seen) return seen;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`gave up waiting: ${why}`);
};

const treeA = path.join(tmp, 'wt-a');
const treeB = path.join(tmp, 'wt-b');
fs.mkdirSync(treeA);
fs.mkdirSync(treeB);
const post = (body) => call('/api/claims', { method: 'POST', body });

const held = await post({ session: 'e2e-a', repo: CHECKOUT, file: 'lib/foo.js', dir: treeA, branch: 'worktree-server-bbb1' });

await check('the daemon resolves the branch of a claim it just took', async () => {
  assert.equal(held.body.decision, 'held');
  assert.equal(held.body.holders.length, 0);
  const found = await until(async () => {
    const { body } = await call('/api/claims');
    return (body.claims || []).find((c) => c.session === 'e2e-a' && c.bead);
  }, 'the claim never gained a bead');
  assert.equal(found.bead, 'zz-bbb.1', 'the dotted candidate, verified against the tracker rather than assumed');
});

await check('and the refusal a second session gets names the bead, not just the branch', async () => {
  const denied = await post({ session: 'e2e-b', repo: CHECKOUT, file: 'lib/foo.js', dir: treeB, branch: 'worktree-other-nope2' });
  assert.equal(denied.body.decision, 'conflict');
  assert.match(denied.body.reason, /zz-bbb\.1 on worktree-server-bbb1/, 'the whole point of the bead: one hop, not two');
});

for (const s of servers) s.close();
cleanupTmp(tmp);

/* ---------------------------------------------------------------------- report */

console.log(`\n${ran - failures}/${ran} claim-bead checks passed`);
process.exit(failures ? 1 : 0);
