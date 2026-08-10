/**
 * The one rule in the common repo that only ever fails silently: its ignore file.
 *
 * `~/.config/beadcause/.gitignore` is written once, before `git init`, and it is what
 * keeps a signing key and a TLS private key out of a history they could never really
 * be removed from. Which means it has two failure modes and neither of them prints
 * anything:
 *
 * - a rule added to `GITIGNORE` after an install exists never reaches that install, so
 *   the protection this file documents is only true of fresh machines. That is how the
 *   certificate broke it: `FORBIDDEN` catches the key, so a stale ignore file does not
 *   leak it — it makes every snapshot from then on refuse, and a history that has
 *   quietly stopped looks exactly like one with nothing to say;
 * - a top-up that rewrote the file would take out whatever you added by hand.
 *
 * So: a fresh directory gets the current list, a stale one is brought up to it, a
 * hand-added rule survives, and running twice changes nothing. Everything happens in a
 * temp directory — `git init` included.
 *
 * `npm test`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-commonrepo-'));
// Before lib/config.js is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');

const { ensureRepo } = await import(LIB('commonrepo.js'));

const IGNORE = path.join(process.env.BEADCAUSE_CONFIG_DIR, '.gitignore');
const read = () => fs.readFileSync(IGNORE, 'utf8');
const rules = () =>
  read()
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 6).join('\n       ')}`);
  }
}

console.log('the common repo ignore file');

await ensureRepo();

await check('a fresh directory is a repo, ignoring the key material', () => {
  assert.ok(fs.existsSync(path.join(process.env.BEADCAUSE_CONFIG_DIR, '.git')), 'git init must have run');
  for (const rule of ['android-keystore.jks', '*.jks', '*.pem', 'tls/', '*.key', '*.crt', 'status.json']) {
    assert.ok(rules().includes(rule), `missing: ${rule}`);
  }
});

await check('an ignore file from before a rule existed gains it', async () => {
  // Exactly the shape every install already has: the list as it was, plus a line
  // somebody added themselves.
  fs.writeFileSync(IGNORE, '# mine\nandroid-keystore.jks\n*.jks\nstatus.json\nnotes-to-self.md\n');
  await ensureRepo();
  assert.ok(rules().includes('tls/'), 'the certificate directory has to be ignored');
  assert.ok(rules().includes('*.key'), 'and the private key by extension too');
  assert.ok(rules().includes('notes-to-self.md'), 'a rule added by hand must survive being topped up');
});

await check('and running again adds nothing', async () => {
  const before = read();
  await ensureRepo();
  assert.equal(read(), before, 'the top-up has to be idempotent, or the file grows on every write');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} of ${ran} failed` : `\n${ran} passed`);
process.exit(failures ? 1 : 0);
