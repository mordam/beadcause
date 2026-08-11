/**
 * The one deploy beadcause declares for itself — and the four times it must not.
 *
 * `deploys` is empty by default and that is deliberate for every repo but this one:
 * the label is a constant in the tree, the program it starts is a plist this process
 * can read, and "does restarting it kill me" is a fact about `launchctl kickstart -k`.
 * So the entry gets written, once, on a Mac where it is true.
 *
 * The failures worth a test are all versions of "it was written when it was not true":
 *
 * 1. **No service.** A checkout that has never been installed declares nothing — a
 *    kickstart of a label that is not loaded is not a deploy, it is an error message.
 * 2. **Someone else's tree.** The label is installed, but its plist starts a different
 *    clone. Declaring here would fast-forward *this* checkout and restart *that* one.
 * 3. **Twice.** The receipt is spent on the first write, so an entry deleted on purpose
 *    stays deleted. This is asserted by deleting it and calling again.
 * 4. **Over a hand-written entry.** Whatever is in the config already is the more
 *    specific knowledge and is never merged into or corrected.
 *
 * Plus the one thing it must actually do: produce an entry `deployFor` turns into a
 * plan that names this checkout, expands `{uid}`, and knows the restart is ours.
 *
 * No launchctl and no launchd — the plist is a file, which is all lib/service.js reads.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-owndeploy-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const { declareOwnDeploy, ownDeployDeclaration, deployFor, deployHint } = await import(LIB('deploy.js'));
const { CONFIG_PATH, STATE_PATH, loadState } = await import(LIB('config.js'));
const { LABEL } = await import(LIB('service.js'));

/* ------------------------------------------------------------------ fixtures */

/** A checkout, as far as lib/service.js is concerned: a tree with a bin/router.js. */
function checkout(name, { apk = false } = {}) {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'router.js'), '// not run here\n');
  if (apk) {
    fs.mkdirSync(path.join(root, 'public'), { recursive: true });
    fs.writeFileSync(path.join(root, 'public', 'beadcause.apk'), 'not really an apk');
  }
  return root;
}

/** A home directory whose LaunchAgent starts `program`, or one with no agent at all. */
function home(name, program) {
  const dir = path.join(tmp, `home-${name}`);
  const agents = path.join(dir, 'Library', 'LaunchAgents');
  fs.mkdirSync(agents, { recursive: true });
  if (program) {
    fs.writeFileSync(
      path.join(agents, `${LABEL}.plist`),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>${program}</string>
  </array>
</dict>
</plist>
`
    );
  }
  return dir;
}

/**
 * A config on disk, as hand-kept as the real one: a few keys and nothing else. The
 * `sessionDirs` override is how a workspace is pinned to a checkout without needing a
 * projectRoot layout on the test machine.
 */
function config({ deploys = null, sessionDirs = {}, workspaces = [] } = {}) {
  const stored = { port: 4318, workspaces, sessionDirs };
  if (deploys) stored.deploys = deploys;
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(stored, null, 2)}\n`);
  // What a caller actually holds: the stored file with defaults merged over it. The
  // point of the surgical write is that saving *this* would dump all of them back.
  return { ...stored, pr: { base: 'main' }, deploys: deploys || {} };
}

/** Nothing has ever been declared on this machine. */
function forget() {
  fs.rmSync(STATE_PATH, { force: true });
}

const stored = () => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

/* --------------------------------------------------------------------- harness */

let ran = 0;
let failures = 0;
function check(what, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${what}`);
  } catch (err) {
    failures += 1;
    console.error(`  \x1b[31m✗\x1b[0m ${what}\n    ${err.message}`);
  }
}

/* ------------------------------------------------------------ what is refused */

console.log('\nwhen it declares nothing');

check('a checkout that was never installed as a service declares nothing', () => {
  forget();
  const root = checkout('never');
  const cfg = config({ workspaces: [{ name: 'beadcause', dir: path.join(tmp, 'beads') }], sessionDirs: { beadcause: root } });
  assert.equal(declareOwnDeploy(cfg, { root, home: home('never', null) }), '');
  assert.deepEqual(cfg.deploys, {});
  assert.equal(stored().deploys, undefined);
  assert.equal(loadState().ownDeployDeclared, false);
});

check('a label whose plist starts a different clone declares nothing', () => {
  forget();
  const root = checkout('mine');
  const other = checkout('theirs');
  const cfg = config({ workspaces: [{ name: 'beadcause', dir: path.join(tmp, 'beads') }], sessionDirs: { beadcause: root } });
  const h = home('theirs', path.join(other, 'bin', 'router.js'));
  assert.equal(declareOwnDeploy(cfg, { root, home: h }), '');
  assert.equal(stored().deploys, undefined);
  assert.equal(loadState().ownDeployDeclared, false);
});

check('no workspace opens in this checkout, so there is nothing to key the entry on', () => {
  forget();
  const root = checkout('unmapped');
  const elsewhere = checkout('elsewhere');
  const cfg = config({
    workspaces: [{ name: 'beadcause', dir: path.join(tmp, 'beads') }],
    sessionDirs: { beadcause: elsewhere },
  });
  assert.equal(declareOwnDeploy(cfg, { root, home: home('unmapped', path.join(root, 'bin', 'router.js')) }), '');
  assert.equal(stored().deploys, undefined);
  assert.equal(loadState().ownDeployDeclared, false);
});

check('an entry that is already there is never touched', () => {
  forget();
  const root = checkout('already');
  const mine = { command: ['bash', 'deploy.sh'] };
  const cfg = config({
    deploys: { beadcause: mine },
    workspaces: [{ name: 'beadcause', dir: path.join(tmp, 'beads') }],
    sessionDirs: { beadcause: root },
  });
  assert.equal(declareOwnDeploy(cfg, { root, home: home('already', path.join(root, 'bin', 'router.js')) }), '');
  assert.deepEqual(stored().deploys.beadcause, mine);
  assert.equal(loadState().ownDeployDeclared, false);
});

/* -------------------------------------------------------------- what it writes */

console.log('\nwhen it declares');

check('the entry lands in the stored file, and in the config the caller is holding', () => {
  forget();
  const root = checkout('live', { apk: true });
  const cfg = config({ workspaces: [{ name: 'beadcause', dir: path.join(tmp, 'beads') }], sessionDirs: { beadcause: root } });
  const notice = declareOwnDeploy(cfg, { root, home: home('live', path.join(root, 'bin', 'router.js')) });

  assert.match(notice, /deploys\.beadcause declared/);
  assert.deepEqual(stored().deploys.beadcause.command, ['launchctl', 'kickstart', '-k', `gui/{uid}/${LABEL}`]);
  assert.equal(stored().deploys.beadcause.restarts, true);
  assert.deepEqual(cfg.deploys.beadcause, stored().deploys.beadcause);
  assert.equal(loadState().ownDeployDeclared, true);
});

check('nothing else in the hand-kept file moved, and no defaults were dumped into it', () => {
  const raw = stored();
  assert.deepEqual(Object.keys(raw).sort(), ['deploys', 'port', 'sessionDirs', 'workspaces']);
  assert.equal(raw.port, 4318);
});

check('`{uid}` is left for deploy time rather than baked into a file that gets synced', () => {
  assert.ok(!JSON.stringify(stored().deploys).includes(String(os.userInfo().uid)));
});

check('deployFor turns it into a plan that names this checkout and this user', () => {
  const root = path.join(tmp, 'live');
  const cfg = {
    ...stored(),
    pr: { base: 'main' },
  };
  const plan = deployFor(cfg, 'beadcause');
  assert.deepEqual(plan.command, ['launchctl', 'kickstart', '-k', `gui/${os.userInfo().uid}/${LABEL}`]);
  assert.equal(plan.dir, path.resolve(root));
  assert.equal(plan.restarts, true);
  assert.equal(plan.pull, true);
  assert.equal(deployHint(plan), 'runs `launchctl` · rebuilds apk · restarts beadcause');
});

check('it is spent: an entry deleted on purpose is not written back', () => {
  const root = checkout('live', { apk: true });
  const cfg = config({ workspaces: [{ name: 'beadcause', dir: path.join(tmp, 'beads') }], sessionDirs: { beadcause: root } });
  assert.equal(declareOwnDeploy(cfg, { root, home: home('live', path.join(root, 'bin', 'router.js')) }), '');
  assert.equal(stored().deploys, undefined);
});

/* ---------------------------------------------------------------- the rebuild */

console.log('\nthe APK rebuild');

check('a Mac that has published an APK rebuilds it when android/ moved', () => {
  const root = checkout('withapk', { apk: true });
  const d = ownDeployDeclaration({ root, home: home('withapk', path.join(root, 'bin', 'router.js')) });
  assert.deepEqual(d.rebuild, [{ label: 'apk', when: ['android'], command: ['npm', 'run', 'android'] }]);
});

check('a Mac that has never built one declares no build it cannot run', () => {
  const root = checkout('noapk');
  const d = ownDeployDeclaration({ root, home: home('noapk', path.join(root, 'bin', 'router.js')) });
  assert.equal(d.rebuild, undefined);
  assert.equal(d.restarts, true);
});

check('and with no service installed there is no declaration at all', () => {
  const root = checkout('bare');
  assert.equal(ownDeployDeclaration({ root, home: home('bare', null) }), null);
});

/* ------------------------------------------------------------------------ end */

console.log(`\n${ran - failures}/${ran} passed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
