/**
 * `workspaceDirs` — the two ways `~/beads/*​/.beads` is the wrong answer.
 *
 *     node test/workspacedirs.mjs
 *
 * Discovery reads one directory and takes what is in it, which is right often enough
 * that it is still the rule. It has two failure modes, and bc-odhk is both of them
 * happening to the same tracker on the same afternoon:
 *
 * - **A workspace that lives somewhere else is invisible.** Climative's `cl-` graph —
 *   the one wired to JIRA, the one forty service repos file into — was moved into the
 *   `architecture` checkout, because a tracker a team shares has to live in the repo the
 *   team already clones. Discovery stopped seeing it, and a workspace nothing polls is
 *   indistinguishable from a workspace with nothing in it: no questions on the phone, no
 *   ready beads queued, and no line of log saying why.
 * - **The copy left behind is still swept.** It sat under `~/beads` with a dated name,
 *   so it was still discovered, still polled, and still drew its stale questions as
 *   current ones — which is worse than the first failure, because those can be answered.
 *
 * The half of this worth testing hardest is neither of those on its own: it is that the
 * answer **survives a restart**, which the workaround people were actually using — an
 * entry hand-added to `workspaces` — does not. That list is reconciled against the disk
 * on every load and the shorter list is written back, so one boot with the checkout
 * moved away drops it for good, silently. `restart:comes-back` is that case, and it is
 * the acceptance criterion of the bead.
 *
 * ## Why children
 *
 * `CONFIG_DIR` resolves once, at module load, and `discoverWorkspaces()` readdirs the
 * real `~/beads` of whoever is running this. Both are settled by the environment, so a
 * case gets its own process with `HOME` and `BEADCAUSE_CONFIG_DIR` pointing into a
 * scratch tree — the same shape `test/observe.mjs` uses, for the same reason. Nothing
 * here touches the network, spawns an agent, or writes outside `os.tmpdir()`.
 *
 * A "restart" is a second `loadConfig()` in the same process. That is honest rather than
 * a shortcut: nothing about the workspace list is memoised anywhere, so the second call
 * re-reads the file it just wrote exactly as a fresh process would.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const CASES = new Map();
const test = (name, fn) => CASES.set(name, fn);

/* ------------------------------------------------------------ what a case has */

const HOME = () => process.env.HOME;

/** A `~/beads/<name>/.beads` for discovery to find. */
const beadsUnderHome = (name) => {
  const dir = path.join(HOME(), 'beads', name, '.beads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/** A `.beads` somewhere discovery will never look — a checkout, in every real case. */
const beadsInCheckout = (...parts) => {
  const root = path.join(HOME(), ...parts);
  fs.mkdirSync(path.join(root, '.beads'), { recursive: true });
  return root;
};

const writeConfig = (patch) => {
  const file = path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const was = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  fs.writeFileSync(file, JSON.stringify({ ...was, ...patch }, null, 2));
};

const savedConfig = () => JSON.parse(fs.readFileSync(path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'), 'utf8'));

const names = (cfg) => cfg.workspaces.map((w) => w.name);
const dirOf = (cfg, name) => cfg.workspaces.find((w) => w.name === name)?.dir || null;

/* ------------------------------------------------------------------ the cases */

// The control. Everything below adds to discovery, and none of it may replace it: an
// install that has never configured anything has to keep working, and that is most of
// them.
test('discovery:still-the-rule', async () => {
  beadsUnderHome('sophab');
  beadsUnderHome('deluvia');
  fs.mkdirSync(path.join(HOME(), 'beads', 'not-a-workspace'), { recursive: true });
  const { loadConfig } = await import(LIB('config.js'));

  const cfg = loadConfig();
  assert.deepEqual(names(cfg), ['deluvia', 'sophab'], 'both workspaces, alphabetical, with no config at all');
  assert.deepEqual(cfg.workspaceDirs, {}, 'and the new key ships empty');
});

test('named:served-from-a-checkout', async () => {
  beadsUnderHome('sophab');
  const checkout = beadsInCheckout('climative.dev', 'architecture');
  writeConfig({ workspaceDirs: { climative: checkout } });
  const { loadConfig } = await import(LIB('config.js'));

  const cfg = loadConfig();
  assert.deepEqual(names(cfg), ['climative', 'sophab'], 'the named workspace is served alongside the discovered one');
  // The checkout is what a person has in their head; the `.beads` inside it is beads'
  // business. Naming either has to mean the same thing.
  assert.equal(dirOf(cfg, 'climative'), path.join(checkout, '.beads'), 'a checkout resolves to the .beads inside it');
});

test('named:spelt-three-ways', async () => {
  const checkout = beadsInCheckout('climative.dev', 'architecture');
  const { loadConfig } = await import(LIB('config.js'));
  const want = path.join(checkout, '.beads');

  for (const [spelling, what] of [
    [checkout, 'the checkout'],
    [path.join(checkout, '.beads'), 'the .beads itself'],
    ['~/climative.dev/architecture', 'a tilde, which is what gets copied to a second Mac'],
  ]) {
    writeConfig({ workspaceDirs: { climative: spelling }, workspaces: [] });
    assert.equal(dirOf(loadConfig(), 'climative'), want, `${what} should name the same workspace`);
  }
});

// The retired tracker. The directory is *there* — that is the whole state being talked
// about — so "drop what no longer exists" can never express it.
test('null:takes-one-out-and-keeps-it-out', async () => {
  beadsUnderHome('sophab');
  beadsUnderHome('climative.retired-20260812');
  writeConfig({ workspaceDirs: { 'climative.retired-20260812': null } });
  const { loadConfig } = await import(LIB('config.js'));

  assert.deepEqual(names(loadConfig()), ['sophab'], 'the retired copy is not served');
  assert.deepEqual(names(loadConfig()), ['sophab'], 'and not on the next load either');
  assert.deepEqual(
    savedConfig().workspaces.map((w) => w.name),
    ['sophab'],
    'nor written back into the file, where the next hand-edit would meet it',
  );
  assert.ok(fs.existsSync(path.join(HOME(), 'beads', 'climative.retired-20260812', '.beads')), 'and nothing was deleted');
});

// An entry already in `workspaces` from before the key existed — the state every install
// that hand-edited its way around this is in, including the one the bead was filed from.
test('null:evicts-what-is-already-saved', async () => {
  const retired = beadsUnderHome('climative.retired-20260812');
  writeConfig({
    workspaces: [{ name: 'climative.retired-20260812', dir: retired }],
    workspaceDirs: { 'climative.retired-20260812': null },
  });
  const { loadConfig } = await import(LIB('config.js'));
  assert.deepEqual(names(loadConfig()), [], 'a saved entry is dropped by the rule, not just kept out of discovery');
});

/**
 * The acceptance criterion, and the one thing hand-editing `workspaces` cannot do.
 *
 * Reconciliation drops a saved entry whose directory is not there and writes the shorter
 * list back. For a discovered workspace that is self-healing — the next load finds it
 * again. For a hand-added one it was one-way: a single boot while the checkout was
 * moved, re-cloned, or on a volume that had not mounted yet lost it permanently, and the
 * log line said `no longer exists` at a moment when that was true.
 */
test('restart:comes-back', async () => {
  const checkout = beadsInCheckout('climative.dev', 'architecture');
  const away = path.join(HOME(), 'climative.dev', 'architecture-moved');
  writeConfig({ workspaceDirs: { climative: checkout } });
  const { loadConfig } = await import(LIB('config.js'));

  assert.deepEqual(names(loadConfig()), ['climative'], 'served on the first load');
  assert.deepEqual(names(loadConfig()), ['climative'], 'still served after a restart');

  fs.renameSync(checkout, away);
  assert.deepEqual(names(loadConfig()), [], 'gone while the checkout is gone — there is nothing to sweep');
  assert.deepEqual(savedConfig().workspaces, [], 'and the shorter list is written back, as it always was');
  assert.deepEqual(savedConfig().workspaceDirs, { climative: checkout }, 'but the rule that names it is untouched');

  fs.renameSync(away, checkout);
  assert.deepEqual(names(loadConfig()), ['climative'], 'and it comes back on its own the moment the checkout does');
});

// Two entries called `climative` pointing at two graphs is the one outcome nothing
// downstream could make sense of — a bead's `workspace/id` key would name both.
test('named:wins-over-a-discovered-one-of-the-same-name', async () => {
  const under = beadsUnderHome('climative');
  const checkout = beadsInCheckout('climative.dev', 'architecture');
  writeConfig({ workspaces: [{ name: 'climative', dir: under }], workspaceDirs: { climative: checkout } });
  const { loadConfig } = await import(LIB('config.js'));

  const cfg = loadConfig();
  assert.deepEqual(names(cfg), ['climative'], 'one workspace, not two');
  assert.equal(dirOf(cfg, 'climative'), path.join(checkout, '.beads'), 'and it is the one that was named');
});

// A workspace silently not served is the exact failure this key exists to end, so a typo
// in the key may not produce it — but it may not take out a workspace that was working
// either. Warn, and let discovery answer.
test('typo:is-loud-and-not-fatal', async () => {
  beadsUnderHome('climative');
  writeConfig({ workspaceDirs: { climative: '~/climative.dev/architecture-that-is-not-there' } });
  const { loadConfig } = await import(LIB('config.js'));

  const said = [];
  const warn = console.warn;
  console.warn = (...a) => said.push(a.join(' '));
  let cfg;
  try {
    cfg = loadConfig();
  } finally {
    console.warn = warn;
  }

  assert.deepEqual(names(cfg), ['climative'], 'the ~/beads workspace is still served');
  assert.equal(dirOf(cfg, 'climative'), path.join(HOME(), 'beads', 'climative', '.beads'), 'from where discovery found it');
  assert.ok(
    said.some((s) => s.includes('workspaceDirs.climative') && s.includes('not a directory')),
    `the typo should be named on stderr, got: ${JSON.stringify(said)}`,
  );
});

// `{"climative": true}` is somebody meaning something we cannot know. Guessing between
// "serve it from somewhere" and "never serve it" is guessing between opposites.
test('nonsense:is-ignored-with-a-word', async () => {
  beadsUnderHome('sophab');
  writeConfig({ workspaceDirs: { sophab: true, other: 42 } });
  const { loadConfig } = await import(LIB('config.js'));

  const said = [];
  const warn = console.warn;
  console.warn = (...a) => said.push(a.join(' '));
  let cfg;
  try {
    cfg = loadConfig();
  } finally {
    console.warn = warn;
  }

  assert.deepEqual(names(cfg), ['sophab'], 'neither entry decided anything');
  assert.equal(said.filter((s) => s.includes('neither a directory nor null')).length, 2, 'and both were said out loud');
});

// The install this landed on. Its `workspaces` already carried a hand-added entry
// pointing into a checkout, and the first boot after this change must not drop it — and
// must not leave it resting on the same thing it was resting on before.
test('legacy:hand-added-entry-is-adopted', async () => {
  const checkout = beadsInCheckout('climative.dev', 'architecture');
  const away = path.join(HOME(), 'climative.dev', 'architecture-moved');
  writeConfig({ workspaces: [{ name: 'architecture', dir: path.join(checkout, '.beads') }] });
  const { loadConfig } = await import(LIB('config.js'));

  assert.deepEqual(names(loadConfig()), ['architecture'], 'still served, with no workspaceDirs written by hand');
  assert.deepEqual(savedConfig().workspaceDirs, { architecture: path.join(checkout, '.beads') }, 'and written down as a rule');

  // Which is the whole point of adopting it: the fact could not survive this and the
  // rule can.
  fs.renameSync(checkout, away);
  assert.deepEqual(names(loadConfig()), [], 'gone while the checkout is gone');
  fs.renameSync(away, checkout);
  assert.deepEqual(names(loadConfig()), ['architecture'], 'and back on its own, which a hand-added entry never was');
});

// Adoption reads its own answer off the config rather than off a spent flag, so it has
// to be a no-op on everything it has already done — and on everything discovery can
// account for on its own.
test('legacy:adoption-touches-nothing-else', async () => {
  beadsUnderHome('sophab');
  const retired = beadsUnderHome('climative.retired-20260812');
  const checkout = beadsInCheckout('climative.dev', 'architecture');
  writeConfig({
    workspaces: [
      { name: 'sophab', dir: path.join(HOME(), 'beads', 'sophab', '.beads') },
      { name: 'climative.retired-20260812', dir: retired },
      { name: 'ghost', dir: path.join(HOME(), 'gone', '.beads') },
    ],
    workspaceDirs: { 'climative.retired-20260812': null, climative: checkout },
  });
  const { loadConfig } = await import(LIB('config.js'));

  loadConfig();
  const after = savedConfig().workspaceDirs;
  assert.deepEqual(
    after,
    { 'climative.retired-20260812': null, climative: checkout },
    'a discoverable entry, an excluded one and a directory that is not there are all left alone',
  );
  assert.deepEqual(names(loadConfig()), ['climative', 'sophab'], 'and the list is what the rules say');
  assert.deepEqual(savedConfig().workspaceDirs, after, 'the second start finds nothing left to adopt');
});

/**
 * Every one of these notices goes to **stderr**, and this is the case that caught it.
 *
 * `bin/file.js` prints the id it filed and callers read it with `stdout.trim()`. A
 * workspace notice on stdout does not appear beside that id — it becomes part of it, and
 * the caller then reports that nothing landed while the bead is sitting in the tracker.
 * That is exactly how `test/autoendorse.mjs` failed while this was being written, and it
 * is the argument `reconcileBaseUrl` already makes for the base-URL notice.
 */
test('quiet:never-on-stdout', async () => {
  const gone = beadsUnderHome('gone');
  beadsUnderHome('appearing');
  const checkout = beadsInCheckout('climative.dev', 'architecture');
  // One config that will make it say all three things at once: adopt the hand-added
  // entry, drop the retired one, and pick up the workspace it has never seen.
  writeConfig({
    workspaces: [
      { name: 'architecture', dir: path.join(checkout, '.beads') },
      { name: 'gone', dir: gone },
    ],
    workspaceDirs: { gone: null },
  });
  const { loadConfig } = await import(LIB('config.js'));

  const out = [];
  const log = console.log;
  console.log = (...a) => out.push(a.join(' '));
  try {
    loadConfig();
  } finally {
    console.log = log;
  }

  assert.deepEqual(
    out.filter((line) => /workspace/i.test(line)),
    [],
    `a workspace notice on stdout corrupts whatever the command was printing, got: ${JSON.stringify(out)}`,
  );
});

/* ------------------------------------------------------------------- running */

const only = process.argv[2];
if (only) {
  await CASES.get(only)();
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-workspacedirs-'));
  const plan = [...CASES.keys()];
  let failed = 0;
  for (const name of plan) {
    const home = path.join(tmp, name.replace(/[^a-z0-9]+/gi, '-'), 'home');
    const config = path.join(tmp, name.replace(/[^a-z0-9]+/gi, '-'), 'config');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(config, { recursive: true });
    try {
      execFileSync(process.execPath, [fileURLToPath(import.meta.url), name], {
        encoding: 'utf8',
        // Built from scratch: the real `~/beads` of whoever is running this must not be
        // able to decide any of it. The pinned Tailscale IP is not about Tailscale —
        // `defaults()` shells out to that binary with a 5s timeout on every `loadConfig`,
        // and this suite calls it a dozen times.
        env: {
          PATH: process.env.PATH,
          HOME: home,
          BEADCAUSE_CONFIG_DIR: config,
          BEADCAUSE_TAILSCALE_IP: '100.64.0.1',
        },
      });
      console.log(`  ok    ${name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL  ${name}\n${(err.stderr || err.message).toString().trim()}\n`);
    }
  }
  await cleanupTmp(tmp);
  console.log(failed ? `\n${failed} of ${plan.length} failed` : `\n${plan.length} passed`);
  process.exit(failed ? 1 : 0);
}
