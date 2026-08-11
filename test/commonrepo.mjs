/**
 * The two rules in the common repo that only ever fail silently.
 *
 * `~/.config/beadcause` snapshots `config.json` after every write, which is the whole
 * point of it and is also why a secret that reaches it is not "on disk in the clear" but
 * *in a history* — and a rotation cannot reach back into a history. Two rules stand
 * between those, and neither of them announces itself when it stops working: the ignore
 * file, and the check the commit itself runs. So both are held here.
 *
 * ## The ignore file
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
 * hand-added rule survives, and running twice changes nothing.
 *
 * ## The secret a path cannot see
 *
 * An ignore rule and a path denylist are the whole answer for a secret with a file of its
 * own, and no answer at all for one written *inside* a file this repo commits on purpose.
 * Google sign-in arrived with exactly that — a `clientSecret` field in `config.json` —
 * and bc-m6m is the bead that closed it. Three things have to hold, and the third is the
 * only one that is actually a proof:
 *
 * - a staged file carrying a secret **aborts the commit**, and leaves nothing in the
 *   index, so the next `git commit` by hand cannot pick it up either;
 * - `loadConfig()` drains a field that got there anyway into a file the repo refuses, so
 *   the guard above heals instead of bricking the history;
 * - and `scanHistory()` answers the question against **every commit on every ref**, which
 *   is the only form of "there is no secret in here" worth saying about a repo whose
 *   purpose is remembering what the working tree used to say.
 *
 * Everything happens in a temp directory — `git init` included — and the last two cases
 * force a secret past the guard with raw `git`, because a guarantee you have only ever
 * tested from inside the code that makes it is not tested.
 *
 * `npm test`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-commonrepo-'));
// Before lib/config.js is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');

const { commit, ensureRepo, flush, scanHistory } = await import(LIB('commonrepo.js'));
const { loadConfig } = await import(LIB('config.js'));

const DIR = process.env.BEADCAUSE_CONFIG_DIR;
const CONFIG = path.join(DIR, 'config.json');
const SECRET = path.join(DIR, 'google-client-secret.key');
// A secret this test made up. Long enough that `guardedValues()` will search for it, and
// shaped like Google's so a reader knows what it is standing in for.
const SECRET_VALUE = 'GOCSPX-not-a-real-client-secret';

/** git with no help from this repo's code — the only way a secret can actually get in. */
const raw = (...args) =>
  execFileSync('git', ['-C', DIR, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });

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
  for (const rule of ['android-keystore.jks', '*.jks', '*.pem', 'tls/', '*.key', '*.crt', '*.secret', 'status.json']) {
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
  assert.ok(rules().includes('*.secret'), 'and the name an older README gave the client secret');
  assert.ok(rules().includes('notes-to-self.md'), 'a rule added by hand must survive being topped up');
});

await check('and running again adds nothing', async () => {
  const before = read();
  await ensureRepo();
  assert.equal(read(), before, 'the top-up has to be idempotent, or the file grows on every write');
});

console.log('\nthe secret a path cannot see');

await check('a client secret written into config.json aborts the commit', async () => {
  fs.writeFileSync(CONFIG, `${JSON.stringify({ auth: { google: { clientId: 'cid', clientSecret: SECRET_VALUE } } }, null, 2)}\n`);
  await assert.rejects(() => commit('config'), /a Google OAuth client secret/, 'the commit has to refuse, and say which secret');
  assert.equal(
    raw('diff', '--cached', '--name-only').trim(),
    '',
    'and leave nothing staged — an index still holding it is one `git commit` away from the history'
  );
});

await check('and so does a Slack token typed in beside it', async () => {
  // A different mistake with the same ending: the README says `botTokenFile`, every
  // Slack tutorial says `botToken`, and this file is committed after every write. The
  // rule is checked here rather than trusted because these patterns are handed to `git
  // grep -E` as strings — one that quietly matches nothing is a guard that reports
  // success on the day it is needed.
  fs.writeFileSync(CONFIG, `${JSON.stringify({ slack: { enabled: true, botToken: 'xoxb-not-a-real-token' } }, null, 2)}\n`);
  await assert.rejects(() => commit('config'), /a Slack bot token/, 'the commit has to refuse, and say which secret');
  fs.writeFileSync(CONFIG, `${JSON.stringify({ slack: { enabled: true, appToken: 'xapp-not-a-real-token' } }, null, 2)}\n`);
  await assert.rejects(() => commit('config'), /a Slack app-level token/);
  // And the field that is *meant* to be here — the path, not the token — must not be
  // caught by either, or turning Slack on at all would abort every snapshot.
  fs.writeFileSync(CONFIG, `${JSON.stringify({ slack: { enabled: true, botTokenFile: '/x/slack-bot.key' } }, null, 2)}\n`);
  await commit('config');
  // Put back what the next case expects to find.
  fs.writeFileSync(CONFIG, `${JSON.stringify({ auth: { google: { clientId: 'cid', clientSecret: SECRET_VALUE } } }, null, 2)}\n`);
});

await check('loadConfig moves it somewhere the snapshot cannot reach', async () => {
  loadConfig();
  const onDisk = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  assert.equal('clientSecret' in onDisk.auth.google, false, 'the field has to be gone from the file, not just from memory');
  assert.equal(fs.readFileSync(SECRET, 'utf8').trim(), SECRET_VALUE, 'and the secret has to have survived the move');
  assert.equal(fs.statSync(SECRET).mode & 0o777, 0o600, 'at 0600, like the session key beside it');
});

await check('and then the commit lands, with no secret in it', async () => {
  await flush();
  const head = raw('rev-parse', 'HEAD').trim();
  assert.ok(head, 'there has to be a commit — a guard that only ever refuses is a broken history');
  assert.ok(!raw('show', 'HEAD:config.json').includes(SECRET_VALUE), 'and the committed config must not carry it');
  const tracked = raw('ls-tree', '--name-only', 'HEAD').split('\n');
  assert.ok(!tracked.includes('google-client-secret.key'), 'nor may the secret file itself be in there');
});

await check('the same secret pasted into any committed file is caught by its value', async () => {
  // Not hypothetical: `consoles/` is committed and holds whatever was typed into a chat.
  fs.mkdirSync(path.join(DIR, 'consoles'), { recursive: true });
  const chat = path.join(DIR, 'consoles', 'chat.json');
  fs.writeFileSync(chat, `${JSON.stringify({ turns: [{ text: `use ${SECRET_VALUE} as the secret` }] })}\n`);
  await assert.rejects(() => commit('console'), /the contents of google-client-secret\.key/);
  fs.rmSync(chat);
});

await check('the history scan says nothing when nothing got in', async () => {
  const { commits, findings } = await scanHistory();
  assert.ok(commits > 0, 'there has to be a history to have scanned');
  assert.deepEqual(findings, [], 'a clean repo has to come back clean, or the scan says nothing at all');
});

await check('and finds one forced past the guard, by content and by path', async () => {
  fs.writeFileSync(path.join(DIR, 'leak.json'), `${JSON.stringify({ auth: { google: { clientSecret: 'GOCSPX-forced-in' } } })}\n`);
  fs.writeFileSync(path.join(DIR, 'forced.key'), 'a-private-key-shaped-thing\n');
  raw('add', '-f', 'leak.json', 'forced.key');
  raw('commit', '-q', '-m', 'forced past the guard');
  const { findings } = await scanHistory();
  const content = findings.find((f) => f.file === 'leak.json');
  const byPath = findings.find((f) => f.file === 'forced.key');
  assert.ok(content, `a secret in a committed file has to be found: ${JSON.stringify(findings)}`);
  assert.equal(content.kind, 'content');
  assert.match(content.what, /client secret/);
  assert.ok(content.commits.length >= 1, 'and named by the commit it is in');
  assert.ok(byPath, 'a forbidden file that reached a commit has to be found too');
  assert.equal(byPath.kind, 'path');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} of ${ran} failed` : `\n${ran} passed`);
process.exit(failures ? 1 : 0);
