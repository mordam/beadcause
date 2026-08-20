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
import { cleanupTmp } from './helpers/tmp.mjs';

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

console.log('\nthe lock nobody is holding');

const HEAD_LOCK = path.join(DIR, '.git', 'HEAD.lock');
const AGES_AGO = new Date(Date.now() - 60 * 60 * 1000);
/** Something for the snapshot to actually commit, so `null` can never pass for success. */
const somethingToCommit = (n) => fs.writeFileSync(path.join(DIR, 'advocates.json'), `${JSON.stringify({ n })}\n`);

await check('a lock a live process holds is left alone, and the snapshot is dropped', async () => {
  fs.writeFileSync(HEAD_LOCK, '');
  fs.utimesSync(HEAD_LOCK, AGES_AGO, AGES_AGO);
  // Old enough by any measure — the only thing standing between it and removal is that
  // this test process has it open, which is exactly the state a real `git commit` is in.
  const fd = fs.openSync(HEAD_LOCK, 'r');
  try {
    somethingToCommit(1);
    await assert.rejects(() => commit('advocates'), /lock/i, 'a held lock has to still fail the commit');
    assert.ok(fs.existsSync(HEAD_LOCK), 'and must not be removed out from under whoever is holding it');
  } finally {
    fs.closeSync(fd);
  }
});

await check('a lock made moments ago is left alone too — that one is the ordinary race', async () => {
  const now = new Date();
  fs.utimesSync(HEAD_LOCK, now, now);
  await assert.rejects(() => commit('advocates'), /lock/i, 'a fresh lock is another writer, and losing to it is the design');
  assert.ok(fs.existsSync(HEAD_LOCK), 'so it stays, and the next write picks up both changes');
});

await check('but an abandoned one is removed and the commit lands', async () => {
  // bc-xl7n.79: a zero-byte HEAD.lock from a git that died six days earlier, no holder,
  // and every snapshot since dropping the history it was asked to keep.
  fs.utimesSync(HEAD_LOCK, AGES_AGO, AGES_AGO);
  const sha = await commit('advocates');
  assert.ok(sha, 'the retry after clearing has to actually commit');
  assert.equal(fs.existsSync(HEAD_LOCK), false, 'and the dead lock has to be gone');
  assert.match(raw('show', '--name-only', '--format=%s', 'HEAD'), /advocates\.json/, 'with the pending write in it');
});

await check('and removed with a PATH that has no lsof on it — the daemon\'s PATH', async () => {
  // bc-xl7n.109, and the reason the case above passed for 37 hours while the daemon
  // cleared nothing. `lsof` was looked up by name, so it came from PATH; on macOS the
  // binary is only ever at /usr/sbin/lsof, and the daemon's launchd PATH has no
  // /usr/sbin in it. Every call threw ENOENT, which is not exit 1, so `heldBy` said "I
  // could not tell" and every lock was left alone for ever.
  //
  // An interactive shell *does* have /usr/sbin, which is why the case above — and every
  // hand-run of the fix — kept saying it worked. So this one takes it away.
  const realPath = process.env.PATH;
  // Every directory on PATH *except* the ones holding an lsof — so `git` still resolves
  // and `lsof` cannot, on any machine, however this suite was started.
  const stripped = realPath
    .split(path.delimiter)
    .filter((d) => d && !fs.existsSync(path.join(d, 'lsof')))
    .join(path.delimiter);
  assert.ok(
    ['/usr/sbin/lsof', '/usr/bin/lsof'].some((p) => fs.existsSync(p)),
    'this machine has no lsof where the code looks for one, so the case cannot be posed'
  );
  process.env.PATH = stripped;
  try {
    fs.writeFileSync(HEAD_LOCK, '');
    fs.utimesSync(HEAD_LOCK, AGES_AGO, AGES_AGO);
    somethingToCommit(2);
    const sha = await commit('advocates');
    assert.ok(sha, 'the lock has to be cleared and the snapshot retried, whatever PATH the daemon was started with');
    assert.equal(fs.existsSync(HEAD_LOCK), false, 'and the dead lock has to be gone');
  } finally {
    process.env.PATH = realPath;
  }
});

await check('and when lsof is nowhere at all, it says so once and still leaves the lock', async () => {
  // The other half of the acceptance: fail *closed* is right and stays, but the two
  // reasons for it — "lsof says nobody holds this" and "there is no lsof" — must not go
  // on being one silence. BEADCAUSE_LSOF points the search at a path that does not
  // exist, which is the only way to reach the branch on a Mac that has the real one.
  const said = [];
  const realError = console.error;
  console.error = (...args) => said.push(args.join(' '));
  process.env.BEADCAUSE_LSOF = path.join(tmp, 'no-lsof-here');
  try {
    fs.writeFileSync(HEAD_LOCK, '');
    fs.utimesSync(HEAD_LOCK, AGES_AGO, AGES_AGO);
    somethingToCommit(3);
    await assert.rejects(() => commit('advocates'), /lock/i, 'unable to ask is unable to clear — deleting on a missing binary is the worse bug');
    assert.ok(fs.existsSync(HEAD_LOCK), 'so the lock stays');
    const complaints = said.filter((line) => /no lsof at/.test(line));
    assert.equal(complaints.length, 1, `the missing tool has to be named out loud: ${JSON.stringify(said)}`);
    assert.match(complaints[0], /left in place/, 'and say what it costs, since nothing else in the log will');

    // Once per process, not once per lock: this runs on every failed snapshot, and the
    // daemon logged that failure 22,933 times over the outage this bead is about.
    somethingToCommit(4);
    await assert.rejects(() => commit('advocates'), /lock/i);
    assert.equal(said.filter((line) => /no lsof at/.test(line)).length, 1, 'and it must not repeat');
  } finally {
    console.error = realError;
    delete process.env.BEADCAUSE_LSOF;
    if (fs.existsSync(HEAD_LOCK)) fs.rmSync(HEAD_LOCK);
  }
});

await check('a refusal is never retried, lock or no lock', async () => {
  // The retry is for locks only: a secret rejected twice is a secret named twice in the
  // log, and `commitOnce` has already unstaged it by the time the first one is thrown.
  fs.writeFileSync(CONFIG, `${JSON.stringify({ slack: { botToken: 'xoxb-not-a-real-token' } }, null, 2)}\n`);
  fs.writeFileSync(HEAD_LOCK, '');
  fs.utimesSync(HEAD_LOCK, AGES_AGO, AGES_AGO);
  await assert.rejects(() => commit('config'), /a Slack bot token/, 'the secret is the answer, not the lock');
  assert.ok(fs.existsSync(HEAD_LOCK), 'and a failure that was never about the lock must not clear one');
  fs.rmSync(HEAD_LOCK);
  fs.writeFileSync(CONFIG, `${JSON.stringify({ auth: { google: { clientId: 'cid' } } }, null, 2)}\n`);
  await commit('config');
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

await cleanupTmp(tmp);
console.log(failures ? `\n${failures} of ${ran} failed` : `\n${ran} passed`);
process.exit(failures ? 1 : 0);
