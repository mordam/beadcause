#!/usr/bin/env node
/**
 * **An epic completing chimes the phone, and never at your own tap** — bc-ka5y.15.2.
 *
 *     npm test
 *     node test/epicdone.mjs
 *
 * `epicDoneEvent` landed in lib/news.js with nothing calling it, because the *moment* an
 * epic finishes is a judgement rather than a webhook: nothing in this app closes an epic
 * on its own, so the event is the bead transitioning to closed and the detection is a
 * diff of the tracker. There are five ways for that to be quietly wrong, and this suite
 * is one section per way.
 *
 * 1. **It chimes at your own tap.** The one failure the bead names, and the one that
 *    costs the sound its meaning: close an epic on the phone and the phone congratulates
 *    you for it. The suppression is `actor` on the close, recorded in `Bd.run` — so this
 *    drives the **real** `Bd`, against a `bd` binary that is a shell script, rather than
 *    asserting that a line of lib/bd.js still says what it says.
 * 2. **It chimes at boot.** A daemon that came up an hour ago announcing every epic that
 *    finished last month. The first pass over a workspace seeds and says nothing.
 * 3. **It chimes for a tracker it could not read.** `bd.graph` answers an *empty index
 *    carrying `.error`* rather than throwing, so a `bd export` that timed out reads as
 *    "every epic vanished" — and, in a diffing sweep, makes the next good pass see the
 *    whole tracker as newly filed.
 * 4. **The count is wrong.** "N beads closed under it" is the half of the card that
 *    cannot be checked by eye, and an epic that groups its work with an `Adopts:` line
 *    rather than with children would report zero.
 * 5. **It is not wired.** The sweep exists, the cycle never calls it, and the whole
 *    feature is a quiet morning — which is what every morning looks like.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (f) => path.join(ROOT, 'lib', f);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-epicdone-'));
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
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

const { createEpicWatch, closedUnder, closedByHand, rememberHandClose, forgetHandCloses } = await import(LIB('epicdone.js'));
const { indexFrom } = await import(LIB('ancestry.js'));

const WS = { name: 'demo', dir: path.join(tmp, 'demo') };

/**
 * A tracker, as the rows `bd export` writes — one JSONL line each, fed through the real
 * `indexFrom` so the shape under test is the shape lib/bd.js actually hands a sweep.
 */
const graphOf = (rows) => indexFrom(rows.map((r) => JSON.stringify(r)).join('\n'));

const epicRow = (id, extra = {}) => ({ id, title: `epic ${id}`, issue_type: 'epic', status: 'open', priority: 2, ...extra });
const taskRow = (id, parent, extra = {}) => ({
  id,
  title: `task ${id}`,
  issue_type: 'task',
  status: 'open',
  priority: 2,
  ...(parent ? { dependencies: [{ issue_id: id, depends_on_id: parent, type: 'parent-child' }] } : {}),
  ...extra,
});

/** A `bd` with nothing on it but the one read the watcher makes. */
const fakeBd = (answers) => {
  const queue = [...answers];
  let last = null;
  return {
    calls: 0,
    async graph() {
      this.calls += 1;
      if (queue.length) last = queue.shift();
      if (last instanceof Error) throw last;
      return last;
    },
  };
};

/* ------------------------------------------------- 1. the transition, and the seed */

console.log('\nthe event is a transition, and the first look at a workspace is not one\n');

{
  forgetHandCloses();
  const open = graphOf([epicRow('zz-1'), taskRow('zz-1.1', 'zz-1')]);
  const shut = graphOf([epicRow('zz-1', { status: 'closed' }), taskRow('zz-1.1', 'zz-1', { status: 'closed' })]);
  const watch = createEpicWatch({ bd: fakeBd([open, shut]) });

  const first = await watch.sweep([WS]);
  check('the first pass over a workspace says nothing', first.done.length === 0, JSON.stringify(first.done));
  check('and reports that it seeded, so a quiet first beat is legible in the log', first.seeded.join(',') === 'demo', first.seeded.join(','));

  const second = await watch.sweep([WS]);
  check('an epic that was open and is now closed is one event', second.done.length === 1, JSON.stringify(second.done));
  check('nothing is seeded a second time', second.seeded.length === 0, JSON.stringify(second.seeded));
  const e = second.done[0] || {};
  check('it names the workspace and the epic', e.workspace === 'demo' && e.id === 'zz-1', JSON.stringify(e));
  check('it carries the epic’s own title, which is what the card says', e.title === 'epic zz-1', JSON.stringify(e.title));
  check('and how many beads closed under it', e.closed === 1, JSON.stringify(e.closed));

  const third = await watch.sweep([WS]);
  check('the same close is not announced again on the next beat', third.done.length === 0, JSON.stringify(third.done));
}

{
  forgetHandCloses();
  const shut = graphOf([epicRow('zz-2', { status: 'closed' })]);
  const watch = createEpicWatch({ bd: fakeBd([shut, shut]) });
  await watch.sweep([WS]);
  const again = await watch.sweep([WS]);
  check('an epic that was already closed when the daemon came up never chimes', again.done.length === 0, JSON.stringify(again.done));
}

{
  forgetHandCloses();
  const open = graphOf([taskRow('zz-3', null), epicRow('zz-4')]);
  const shut = graphOf([taskRow('zz-3', null, { status: 'closed' }), epicRow('zz-4')]);
  const watch = createEpicWatch({ bd: fakeBd([open, shut]) });
  await watch.sweep([WS]);
  const out = await watch.sweep([WS]);
  check('a task closing is not an epic completing', out.done.length === 0, JSON.stringify(out.done));
}

/* ------------------------------------------------------------ 2. your own tap */

console.log('\nan epic you closed yourself, from the app in your hand, stays silent\n');

{
  forgetHandCloses();
  const open = graphOf([epicRow('zz-5')]);
  const shut = graphOf([epicRow('zz-5', { status: 'closed' })]);
  const watch = createEpicWatch({ bd: fakeBd([open, shut]) });
  await watch.sweep([WS]);
  rememberHandClose(WS, 'zz-5');
  const out = await watch.sweep([WS]);
  check('a close made by a tap here is not announced back to you', out.done.length === 0, JSON.stringify(out.done));
}

{
  forgetHandCloses();
  const open = graphOf([epicRow('zz-6')]);
  const shut = graphOf([epicRow('zz-6', { status: 'closed' })]);
  const watch = createEpicWatch({ bd: fakeBd([open, shut]) });
  await watch.sweep([WS]);
  // The same close, six hours and a minute ago: a tap you have long forgotten is not the
  // close this sweep is looking at, and holding the suppression for ever would silence a
  // second, real close of a reopened epic.
  rememberHandClose(WS, 'zz-6', Date.now() - 6 * 60 * 60 * 1000 - 60_000);
  const out = await watch.sweep([WS]);
  check('a tap from long enough ago has expired and no longer silences anything', out.done.length === 1, JSON.stringify(out.done));
}

{
  forgetHandCloses();
  rememberHandClose(WS, 'zz-7');
  check('the ledger is per workspace', closedByHand(WS, 'zz-7') && !closedByHand({ name: 'other', dir: '/x' }, 'zz-7'));
  check('and per bead', !closedByHand(WS, 'zz-8'));
}

/**
 * The funnel itself, driven for real.
 *
 * A static read of lib/bd.js would pass over a `run` that had been refactored into two
 * methods, which is exactly how a suppression stops being called. So: a real `Bd`, with
 * `bin` pointing at a script that exits 0 without doing anything, and the assertion is
 * on the ledger afterwards.
 */
{
  forgetHandCloses();
  const { Bd } = await import(LIB('bd.js'));
  const fakeBin = path.join(tmp, 'bd');
  fs.writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(fakeBin, 0o755);
  fs.mkdirSync(WS.dir, { recursive: true });
  const bd = new Bd({ bin: fakeBin, actor: 'beadcause' });

  await bd.run(WS, ['close', 'zz-tap', '--reason', 'done'], { actor: 'adam@example.com' });
  check('a `bd close` carrying a signed-in actor is remembered as a tap', closedByHand(WS, 'zz-tap'));

  await bd.run(WS, ['close', 'zz-agent', '--reason', 'done']);
  check('a close with no actor — every agent, every token caller — is not', !closedByHand(WS, 'zz-agent'));

  await bd.run(WS, ['comment', 'zz-said', 'hello'], { actor: 'adam@example.com' });
  check('and a write that is not a close is not a close', !closedByHand(WS, 'zz-said'));
}

/* --------------------------------------------- 3. closes that are not a milestone */

console.log('\na duplicate tidied away and a proposal turned down are not milestones\n');

for (const [what, labels] of [
  ['a superseded', ['superseded-by:zz-other']],
  ['an unendorsed', ['unendorsed']],
]) {
  forgetHandCloses();
  const open = graphOf([epicRow('zz-9', { labels })]);
  const shut = graphOf([epicRow('zz-9', { status: 'closed', labels })]);
  const watch = createEpicWatch({ bd: fakeBd([open, shut]) });
  await watch.sweep([WS]);
  const out = await watch.sweep([WS]);
  check(`${what} epic closing says nothing`, out.done.length === 0, JSON.stringify(out.done));
}

/* -------------------------------------------------- 4. a tracker that would not read */

console.log('\na tracker that would not read leaves what we last knew alone\n');

{
  forgetHandCloses();
  const open = graphOf([epicRow('zz-10')]);
  const shut = graphOf([epicRow('zz-10', { status: 'closed' })]);
  // `bd.graph` answers this rather than throwing when the export failed — an empty index
  // carrying `.error`. Treating it as fact would report the epic as gone.
  const blind = { parents: new Map(), beads: new Map(), adopts: new Map(), edges: new Map(), error: 'bd export timed out' };
  const watch = createEpicWatch({ bd: fakeBd([open, blind, shut]) });

  await watch.sweep([WS]);
  const dark = await watch.sweep([WS]);
  check('an empty index carrying .error is not "every epic vanished"', dark.done.length === 0, JSON.stringify(dark.done));
  check('and it is reported rather than swallowed', dark.errors.length === 1 && dark.errors[0].workspace === 'demo', JSON.stringify(dark.errors));
  check('the snapshot is left alone, so it is not re-seeded either', dark.seeded.length === 0, JSON.stringify(dark.seeded));

  const back = await watch.sweep([WS]);
  check('so the close is still seen on the pass after the tracker came back', back.done.length === 1, JSON.stringify(back.done));
}

{
  forgetHandCloses();
  const watch = createEpicWatch({ bd: fakeBd([new Error('bd: no beads database found')]) });
  const out = await watch.sweep([WS]);
  check('a `bd` that throws costs one error line and nothing else', out.errors.length === 1 && out.done.length === 0, JSON.stringify(out));
}

/* ------------------------------------------------------------- 5. the count */

console.log('\nhow many beads closed under it — children and adoptees, once each\n');

{
  const index = graphOf([
    epicRow('zz-11', { status: 'closed', description: 'Adopts: zz-20, zz-21' }),
    taskRow('zz-11.1', 'zz-11', { status: 'closed' }),
    taskRow('zz-11.2', 'zz-11', { status: 'closed' }),
    taskRow('zz-11.2.1', 'zz-11.2', { status: 'closed' }),
    taskRow('zz-11.3', 'zz-11', { status: 'deferred' }),
    taskRow('zz-20', null, { status: 'closed' }),
    taskRow('zz-21', null, { status: 'open' }),
  ]);
  check('the whole subtree counts, not just the direct children', closedUnder(index, 'zz-11') === 4, String(closedUnder(index, 'zz-11')));
  check('an adopted bead is under it too', (index.adopts.get('zz-11') || []).includes('zz-20'), JSON.stringify([...index.adopts]));

  const dupe = graphOf([
    epicRow('zz-12', { status: 'closed', description: 'Adopts: zz-12.1' }),
    taskRow('zz-12.1', 'zz-12', { status: 'closed' }),
  ]);
  check('a bead that is both a child and an adoptee is counted once', closedUnder(dupe, 'zz-12') === 1, String(closedUnder(dupe, 'zz-12')));

  const lonely = graphOf([epicRow('zz-13', { status: 'closed' })]);
  check('an epic with nothing under it counts nothing rather than throwing', closedUnder(lonely, 'zz-13') === 0);
  check('and a bead the index has never heard of is zero, not a crash', closedUnder(lonely, 'zz-nope') === 0);
}

/* ---------------------------------------------------------------- 6. the wiring */

console.log('\nthe sweep is called, and what it produces is the event the phone knows\n');

{
  const server = read('lib/server.js');
  check('the poll cycle calls the sweep', /await sweepEpicsDone\(\);/.test(server));
  check('and reports its own failure, like every other sweep in the cycle', /sweepFailed\('the epic-done sweep'/.test(server));
  check('what it emits is `epicDoneEvent`, so the type and the key are lib/news.js’s', /bus\.emit\(epicDoneEvent\(/.test(server));
  check('a muted space silences it, as it does every other piece of good news', /epicDoneEvent\(epic, \{ quiet: mutedNews\(cfg, epic\.workspace\) \}\)/.test(server));
  check('the watcher is built once and held on the app, not per request', /const epicWatch = createEpicWatch\(\{ bd \}\);/.test(server));

  const { epicDoneEvent } = await import(LIB('news.js'));
  const event = epicDoneEvent({ workspace: 'demo', id: 'zz-1', title: 'epic zz-1', closed: 3 });
  check('the event the sweep’s row makes is the `epic-done` the watch service branches on', event.type === 'epic-done', event.type);
  check('and its key is the news key, never the bead’s own', event.key === 'news/epic/demo/zz-1', event.key);

  // Nothing in this file may reach CONFIG_DIR or a `refs/beadcause` ref: the snapshot is
  // in memory on purpose, and the moment it is not, lib/evidence.js has to claim it.
  // And the watcher is really on the app the poller is handed — a static read would pass
  // over a `createEpicWatch` call whose result never made it into the returned object,
  // which is the same silence as never having written the sweep.
  const { createApp } = await import(LIB('server.js'));
  const app = createApp({
    host: '127.0.0.1',
    baseUrl: 'http://127.0.0.1',
    token: 'epicdone-token',
    actor: 'beadcause-test',
    bdBin: path.join(tmp, 'no-such-bd'),
    workspaces: [],
    sessionDirs: {},
    openSessions: false,
    autoDispatch: false,
    pollSeconds: 3600,
    terminal: false,
    port: 0,
    ntfy: { enabled: false },
    advocates: { enabled: false, workspaces: [] },
  });
  check('and it is on the app object the poll cycle reads', typeof app.epicWatch?.sweep === 'function');

  // Comments blanked exactly as lib/evidence.js's own scan does it — the header argues
  // about `CONFIG_DIR` at length and prose is not a writer.
  const { blankComments } = await import(LIB('evidence.js'));
  const mod = blankComments(read('lib/epicdone.js'));
  check('the watcher writes nothing to disk', !/CONFIG_DIR|refs\/beadcause|writeFile/.test(mod));
}

await cleanupTmp(tmp);

console.log(`\n${ran - failures}/${ran} checks passed\n`);
process.exit(failures ? 1 : 0);
