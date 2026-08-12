#!/usr/bin/env node
/**
 * The four surfaces that start a process, and the repo each of them lands in and names.
 *
 *     npm test
 *     node test/openrepo.mjs
 *
 * `resolveSessionDir` learning to answer per bead (test/sessiondir.mjs) is only half of
 * it. The other half is that the things which *call* it have to hand it the bead — and
 * every one of them had a bead in hand already and was throwing it away. A surface that
 * forgets costs nothing visible: it opens in the workspace's `default` repo, which is
 * `architecture`, which is a real checkout with a real tracker in it, and a session
 * there looks exactly like a session in the right place. So the four are pinned here
 * one at a time:
 *
 * 1. **The chat console** (`createConsole`) — the whole record, because it is the one
 *    surface that neither spawns nor shells out, so its directory, its `repo`, the seed
 *    labels it keeps and the sentence its opening context gets are all reachable.
 * 2. **The in-app terminal** (`openTerminal`) — the refusal, which is the half that
 *    matters and the half that can be tested without a pty: a bead naming a checkout
 *    that cannot be placed must throw *before* `spawn`, not open one in `architecture`.
 *    Plus `summary`, `record` and the restore path, which are what put the repo on the
 *    card and keep it there across a daemon restart.
 * 3. **The iTerm session and the work session** (`windowTitle`) — the tab title is the
 *    only thing on a Mac's screen that says where a window landed, and the ordering in
 *    it is load-bearing: `safeTitle` clamps at sixty characters and eats the bead's own
 *    title first, so the repo has to sit *ahead* of it.
 * 4. **The reply agent** — covered by the shared helpers below plus test/sessiondir.mjs;
 *    it spawns `claude` in `dir` and there is nothing between the two to assert.
 *
 * And the claim that matters to everyone who is not Climative: a workspace with no
 * `repos` block gets `repo: null` on every one of these, no extra pill on any card, and
 * exactly the strings it had before.
 *
 * Entirely on a temp tree: fake checkouts, fake `config/config.yaml`, fake `~/beads`,
 * no `~`, no bd, no pty and no osascript.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-openrepo-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const { windowTitle } = await import(LIB('session.js'));
const { createConsole, getConsole, listConsoles } = await import(LIB('console.js'));
const { openTerminal, summary, restoreTerminals, listTerminals } = await import(LIB('terminal.js'));
const { forgetRepos, whereLanded, repoSummary, repoLabelsOf } = await import(LIB('repos.js'));

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

/** Assert a call throws, and check the sentence — the phone gets that sentence verbatim. */
function refusal(name, fn, ...needles) {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  if (!err) return bad(name, 'it opened something instead of refusing');
  const missing = needles.filter((n) => !err.message.includes(n));
  if (missing.length) return bad(name, `message does not say ${missing.map((m) => JSON.stringify(m)).join(', ')}: ${err.message}`);
  if (err.status !== 409) return bad(name, `status ${err.status}, expected 409`);
  ok(name);
}

/* ------------------------------------------------------------------ the tree */

const ROOT = path.join(tmp, 'climative.dev');
const BEADS = path.join(tmp, 'beads');

function checkout(name, token) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'config.yaml'), `---\nserviceName: ${name}\nserviceToken: ${token}\n`);
  return dir;
}

const ARCHITECTURE = checkout('architecture', 'architecture');
const ATHENA = checkout('athena-service', 'as');
checkout('building-service', 'bs');

function workspace(name) {
  const dir = path.join(BEADS, name, '.beads');
  fs.mkdirSync(dir, { recursive: true });
  return { name, dir };
}

const climative = workspace('climative');
const sophab = workspace('sophab');

const cfg = {
  workspaces: [climative, sophab],
  repos: {
    climative: {
      root: ROOT,
      default: 'architecture',
      approved: ['architecture', 'athena-service', 'building-service'],
    },
  },
};

/** A bead, as far as these surfaces are concerned: an id, a title and labels. */
const bead = (id, ...labels) => ({ id, title: 'Paging drops the last page under load', labels });

/* --------------------------------------------------- 1. the shared vocabulary */

console.log('\nhow a card, a title and a log line say where something landed');

{
  check('a repo is named beside its workspace', whereLanded('climative', { name: 'athena-service' }) === 'climative · athena-service');
  check(
    'and a single-repo workspace is named alone — no repeated word on every card',
    whereLanded('sophab', null) === 'sophab',
    whereLanded('sophab', null)
  );
  check(
    'a launch record keeps the name and the token and no path',
    JSON.stringify(repoSummary({ name: 'athena-service', token: 'as', dir: ATHENA })) ===
      JSON.stringify({ name: 'athena-service', token: 'as' })
  );
  check('and null where there is no repo, so a card can ask `if`', repoSummary(null) === null);
  check(
    'only the repo: labels ride along on a record',
    JSON.stringify(repoLabelsOf(bead('cl-1', 'repo:as', 'unendorsed', 'climative'))) === JSON.stringify(['repo:as'])
  );
  check('and an unlabelled bead keeps nothing', JSON.stringify(repoLabelsOf(bead('cl-1'))) === JSON.stringify([]));
}

/* ------------------------------------------------------- 2. the window titles */

console.log('\nthe iTerm tab title (openSession, openWorkSession)');

{
  const repo = { name: 'athena-service', token: 'as' };
  const long = 'Paging drops the last page of results under sustained load and nobody notices';
  const withRepo = windowTitle('▶', 'cl-9f2', repo, long, 'climative');
  check('the repo is in the title at all', withRepo.includes('athena-service'), withRepo);
  check('the bead id leads it — that is what a person scans for', withRepo.trim().startsWith('cl-9f2'), withRepo);
  check(
    'and it survives the sixty-character clamp that eats the bead title',
    withRepo.length <= 60 && withRepo.includes('athena-service') && !withRepo.includes('nobody notices'),
    withRepo
  );
  const plain = windowTitle('▶', 'sp-4b1', null, 'Tidy the hero', 'sophab');
  check('a single-repo workspace gets the title it always had', plain === 'sp-4b1 Tidy the hero', plain);
  check(
    'and an untitled bead falls back to the workspace, as before',
    windowTitle('', 'sp-4b1', null, '', 'sophab') === 'sp-4b1 sophab'
  );
}

/* ------------------------------------------------------- 3. the chat console */

console.log('\nthe chat console (lib/console.js)');

{
  const c = createConsole(cfg, climative, bead('cl-9f2', 'repo:as'));
  check('it opens in the checkout the bead named, not in the default repo', c.dir === ATHENA, c.dir);
  check('the record says which repo that was', c.repo?.name === 'athena-service' && c.repo?.token === 'as', JSON.stringify(c.repo));
  check(
    'the seed keeps the label that decided it, and nothing else off the row',
    JSON.stringify(c.seed) === JSON.stringify({ id: 'cl-9f2', title: bead().title, labels: ['repo:as'] }),
    JSON.stringify(c.seed)
  );
  check('and it survives a re-read from disk', getConsole(c.id)?.repo?.name === 'athena-service');
  check(
    'the list carries it, which is what puts the pill on the card',
    listConsoles().find((row) => row.id === c.id)?.repo?.name === 'athena-service'
  );

  const plain = createConsole(cfg, climative);
  check('an unseeded chat gets the workspace default', plain.dir === ARCHITECTURE, plain.dir);
  check('and still says which repo that is — the default is a repo too', plain.repo?.name === 'architecture');

  const one = createConsole(cfg, sophab);
  check('a single-repo workspace has no repo on the record at all', one.repo === null, JSON.stringify(one.repo));
  check(
    'and the list reports null rather than inventing one',
    listConsoles().find((row) => row.id === one.id)?.repo === null
  );

  refusal(
    'a seed whose token nothing approved refuses instead of opening in architecture',
    () => createConsole(cfg, climative, bead('cl-9f2', 'repo:zz')),
    'no climative checkout for this bead',
    '"zz"'
  );
  refusal(
    'and two different repo: labels refuse rather than picking the first',
    () => createConsole(cfg, climative, bead('cl-9f2', 'repo:as', 'repo:bs')),
    'names no climative checkout'
  );
}

/* ------------------------------------------------------ 4. the in-app terminal */

console.log('\nthe in-app terminal (lib/terminal.js)');

{
  // The success path spawns a pty and is deliberately not exercised — what it costs to
  // fake is a real `expect` and a real `claude`. The refusal is the half that decides
  // whether an unattended session ends up in a repo nobody meant it to touch, and it
  // happens before anything is spawned or written.
  refusal(
    'a bead naming an unresolvable checkout refuses before the pty exists',
    () => openTerminal(cfg, climative, { bead: bead('cl-9f2', 'repo:zz') }),
    'no climative checkout for this bead'
  );
  check('and nothing was left behind by the refusal', listTerminals().length === 0);

  const rec = {
    id: 'a1b2c3d4e5f60718',
    workspace: 'climative',
    repo: { name: 'athena-service', token: 'as' },
    dir: ATHENA,
    bead: { id: 'cl-9f2', title: 'Paging', labels: ['repo:as'] },
    cols: 80,
    rows: 24,
    status: 'live',
    startedAt: new Date().toISOString(),
    claudeSessionId: '11111111-2222-3333-4444-555555555555',
    buf: [],
    lastActivity: Date.now(),
  };
  check('the summary the card is drawn from carries the repo', summary(rec).repo?.name === 'athena-service');
  check('and a record with none reports null rather than undefined', summary({ ...rec, repo: undefined }).repo === null);

  // A restart is the case the card most easily loses: the pty dies, the record is all
  // there is, and a resumed terminal that stopped naming its checkout would be worse
  // than one that never named it.
  const dir = path.join(process.env.BEADCAUSE_CONFIG_DIR, 'terminals');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${rec.id}.json`), JSON.stringify({ ...rec, buf: undefined, savedAt: rec.startedAt }));
  restoreTerminals({});
  const back = listTerminals().find((t) => t.id === rec.id);
  check('a terminal restored after a restart still names its repo', back?.repo?.name === 'athena-service', JSON.stringify(back?.repo));
  check('and the labels that decided it are still on the record, so a re-open lands there', back?.bead?.labels?.includes('repo:as'));
}

forgetRepos();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures ? `\n${failures} failed` : '\nall good');
process.exit(failures ? 1 : 0);
