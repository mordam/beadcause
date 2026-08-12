#!/usr/bin/env node
/**
 * lib/atlassian.js — the credential convention and the wire, shared by JIRA and Confluence.
 *
 *     npm test
 *     node test/atlassian.mjs
 *
 * This module exists because two integrations had a copy each of the same answers
 * (bc-jv4p), and the whole value of merging them is that a fix lands once. So what is
 * asserted here is the *rules*, not either integration — test/jira.mjs and
 * test/confluence.mjs still own their own sentences, and deliberately so.
 *
 * Five things, and four of them are the ones that would go wrong quietly:
 *
 * 1. **The filename is the entire protection.** `~/.config/beadcause` is a git repo that
 *    snapshots after every write, so a credential is safe there only because its name is
 *    one lib/commonrepo.js refuses. That is asserted against that module's own denylist
 *    rather than against a copy of the rule — the copy is exactly what went wrong before:
 *    lib/confluence.js was checking a hand-written `/\.(key|secret)$/` that had never
 *    heard of `.pem` or `google-client-secret`, so the *warning* and the *refusal*
 *    disagreed about which files are safe.
 * 2. **0600, including on a rewrite.** `writeFileSync` applies `mode` only when it
 *    creates the file, so a 0644 left by an earlier hand survives — which is a token
 *    that is world-readable and looks fine.
 * 3. **The two products disagree about how a failure is shaped.** Confluence answers
 *    `errors: [{title}]`; JIRA answers `errorMessages: []` *and* an `errors` object keyed
 *    by field. One reader has to know both, and it is the reader — not either caller —
 *    that this is proved against.
 * 4. **A timeout and a bad hostname are the same rejection** from `fetch` and completely
 *    different mornings, so `Unreachable` carries which it was rather than every caller
 *    re-deciding by comparing against a class name node could rename.
 * 5. **The body is read once, as text, and parsed here.** An empty body, an HTML login
 *    page from a proxy, and a body that really is `null` all leave `json` null, and only
 *    the middle one is a fault — which is what `parsed` is for.
 *
 * No network: `send` is handed a fetch that answers from a script.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-atlassian-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });
const CONFIG_DIR = process.env.BEADCAUSE_CONFIG_DIR;

const at = await import(LIB('atlassian.js'));
const { protectedPath } = await import(LIB('commonrepo.js'));

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

/* ------------------------------------------------------------------- the credential */

console.log('\nthe header Atlassian Cloud actually wants');
{
  check(
    'basic auth over address:token, not a bearer token',
    at.basicAuth('a@b.com', 'tok') === `Basic ${Buffer.from('a@b.com:tok').toString('base64')}`,
    at.basicAuth('a@b.com', 'tok')
  );
  check(
    'and the bytes are utf8 — an accented address must not become mojibake in a header',
    at.basicAuth('rené@b.com', 'tok') === `Basic ${Buffer.from('rené@b.com:tok', 'utf8').toString('base64')}`
  );
}

console.log('\nwhere a credential lives');
{
  const file = at.credentialFile('jira-climative');
  check('inside the config directory', path.dirname(file) === CONFIG_DIR, file);
  check('named .key', path.basename(file) === 'jira-climative.key', file);
  check(
    'and that name is one lib/commonrepo.js’s denylist refuses — the protection IS the filename',
    protectedPath(path.basename(file)),
    'a token in this file WOULD be committed to the config repo'
  );
  check(
    'a name with a slash in it cannot escape the directory whose rules are the protection',
    path.dirname(at.credentialFile('../../etc/evil')) === CONFIG_DIR,
    at.credentialFile('../../etc/evil')
  );
}

console.log('\nreading it, and writing it');
{
  const file = at.credentialFile('unit-test');
  check('no file and no env is no token', at.readCredential(file, { envVar: 'BEADCAUSE_UNIT_TOKEN' }) === null);

  at.writeCredential(file, '  secret-token  ');
  check('a written token comes back trimmed', at.readCredential(file) === 'secret-token');
  check('and the file is 0600', (fs.statSync(file).mode & 0o777) === 0o600, (fs.statSync(file).mode & 0o777).toString(8));

  // The case writeFileSync alone gets wrong: `mode` is only applied when it creates the
  // file, so a 0644 left by an earlier hand survives a rewrite and nothing says so.
  fs.chmodSync(file, 0o644);
  at.writeCredential(file, 'secret-token');
  check('rewriting a world-readable one puts the mode back', (fs.statSync(file).mode & 0o777) === 0o600, (fs.statSync(file).mode & 0o777).toString(8));

  const nested = path.join(tmp, 'not-yet', 'made', 'x.key');
  at.writeCredential(nested, 'v');
  check('a directory that is not there yet is made', fs.readFileSync(nested, 'utf8').trim() === 'v');

  process.env.BEADCAUSE_UNIT_TOKEN = 'from-the-environment';
  check(
    'the environment wins, because it leaves no copy on disk',
    at.readCredential(file, { envVar: 'BEADCAUSE_UNIT_TOKEN' }) === 'from-the-environment'
  );

  let reads = 0;
  at.readCredential(file, { envVar: 'BEADCAUSE_UNIT_TOKEN', read: () => (reads += 1, 'x') });
  check('and the file is not so much as opened when it does', reads === 0, `${reads} reads`);

  delete process.env.BEADCAUSE_UNIT_TOKEN;
  check('with it gone, the file answers again', at.readCredential(file, { envVar: 'BEADCAUSE_UNIT_TOKEN' }) === 'secret-token');
  check('an empty file is no token rather than an empty string', at.readCredential(file, { read: () => '\n  \n' }) === null);
}

console.log('\nthe hole the naming scheme leaves, and what is said about it');
{
  check('a .key name inside the config repo draws nothing', at.tokenFileWarning(path.join(CONFIG_DIR, 'confluence.key')) === null);
  check(
    'a name the repo would commit does',
    /WILL be committed/.test(at.tokenFileWarning(path.join(CONFIG_DIR, 'confluence-token.txt')) || ''),
    String(at.tokenFileWarning(path.join(CONFIG_DIR, 'confluence-token.txt')))
  );
  check('a file outside that directory is your business, not ours', at.tokenFileWarning('/tmp/elsewhere.txt') === null);
  check(
    'and a .pem is silent because the denylist REFUSES it — the warning and the refusal must agree',
    at.tokenFileWarning(path.join(CONFIG_DIR, 'token.pem')) === null,
    'a hand-copied /\\.(key|secret)$/ said this one WILL be committed, and it would in fact abort the commit'
  );
  check(
    'so is a google-client-secret with no extension at all, for the same reason',
    at.tokenFileWarning(path.join(CONFIG_DIR, 'google-client-secret')) === null
  );
  check('a subdirectory is still inside the repo', /WILL be committed/.test(at.tokenFileWarning(path.join(CONFIG_DIR, 'sub', 'tok.txt')) || ''));
}

/* --------------------------------------------------------- what the site said, either way */

console.log('\nthe two shapes a failure arrives in');
{
  check(
    'Confluence answers an errors ARRAY of titles',
    at.saidAboutFailure({ errors: [{ title: 'space ENG not found' }, { detail: 'and again' }] }) === 'space ENG not found; and again'
  );
  check('JIRA answers errorMessages', at.saidAboutFailure({ errorMessages: ['The JQL is malformed.'], errors: {} }) === 'The JQL is malformed.');
  check(
    'and JIRA’s "errors" is an OBJECT keyed by field, which is not the same errors at all',
    at.saidAboutFailure({ errorMessages: [], errors: { project: 'no project could be found' } }) === 'project: no project could be found'
  );
  check(
    'both halves of a JIRA body are carried',
    at.saidAboutFailure({ errorMessages: ['nope'], errors: { jql: 'bad' } }) === 'jql: bad; nope'
  );
  check('nothing recognisable is null rather than an empty sentence', at.saidAboutFailure({ message: 'hm' }) === null);
  check('and so is a body that did not parse at all', at.saidAboutFailure(null) === null);
}

/* -------------------------------------------------------------------------- the wire */

console.log('\none request');
const reply = (r) => async () => ({ status: r.status ?? 200, text: async () => r.text ?? '' });

{
  const seen = [];
  const impl = async (url, init) => (seen.push({ url, init }), { status: 200, text: async () => '{"a":1}' });
  const res = await at.send('https://x.atlassian.net/rest/x', { method: 'GET', headers: { Accept: 'application/json' }, fetchImpl: impl });
  check('the parsed body comes back', res.ok === true && res.json.a === 1, JSON.stringify(res));
  check('the method is the caller’s', seen[0].init.method === 'GET');
  check(
    'and with no body given there is no body KEY — which is what test/jira.mjs asserts read-only against',
    !('body' in seen[0].init),
    JSON.stringify(Object.keys(seen[0].init))
  );
  check('a signal is always attached, because every request is abandonable', Boolean(seen[0].init.signal));
}

{
  const seen = [];
  const impl = async (url, init) => (seen.push(init), { status: 200, text: async () => '{}' });
  await at.send('https://x/y', { method: 'PUT', body: JSON.stringify({ a: 1 }), fetchImpl: impl });
  check('a body given is passed through untouched', seen[0].body === '{"a":1}' && seen[0].method === 'PUT');
}

{
  const res = await at.send('https://x/y', { fetchImpl: reply({ status: 404, text: '{"errors":[{"title":"no such page"}]}' }) });
  check('a failure is not thrown — the caller decides what a status means', res.ok === false && res.status === 404);
  check('and its body is parsed, so the caller can quote the site’s own words', at.saidAboutFailure(res.json) === 'no such page');
}

console.log('\nthe three ways there is no JSON, and only one of them is a fault');
{
  const empty = await at.send('https://x/y', { fetchImpl: reply({ status: 204, text: '' }) });
  check('an empty body did not parse and is not JSON', empty.parsed === false && empty.json === null);

  const html = await at.send('https://x/y', { fetchImpl: reply({ status: 200, text: '<!doctype html><title>Sign in</title>' }) });
  check('nor did a proxy’s login page, and the bytes are kept so it can be quoted', html.parsed === false && /doctype/.test(html.text));

  const literal = await at.send('https://x/y', { fetchImpl: reply({ status: 200, text: 'null' }) });
  check(
    'but a body that really IS null parsed fine — which is why `parsed` exists and `json === null` will not do',
    literal.parsed === true && literal.json === null
  );
}

console.log('\nunreachable, and which kind');
{
  let err = null;
  try {
    await at.send('https://x/y', {
      fetchImpl: () => Promise.reject(new Error('getaddrinfo ENOTFOUND x')),
    });
  } catch (e) {
    err = e;
  }
  check('a network failure is Unreachable', err instanceof at.Unreachable, String(err));
  check('it is not a timeout, and it carries the reason', err?.timedOut === false && /ENOTFOUND/.test(err?.message || ''), err?.message);
}

{
  // A fetch that never answers, against a 60ms deadline: the abort has to come from
  // here, because nothing else in this test is going to end that promise.
  let err = null;
  const hang = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  try {
    await at.send('https://x/y', { fetchImpl: hang, timeoutMs: 60 });
  } catch (e) {
    err = e;
  }
  check('a request that never answers is abandoned', err instanceof at.Unreachable, String(err));
  check('and says it was a timeout rather than leaving the caller to guess', err?.timedOut === true, JSON.stringify(err?.timedOut));
}

{
  // The other half of the same promise, and the one no assertion about a *value* would
  // ever catch: an uncleared deadline is not a wrong answer, it is a timer holding the
  // event loop open, so every suite that touches this module sits there for the length
  // of the longest timeout it happened to set before the process will exit.
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const before = timers();
  await at.send('https://x/y', { fetchImpl: async () => ({ status: 200, text: async () => '{}' }), timeoutMs: 60_000 });
  check('a request that answered cleared its own deadline, rather than holding the loop open', timers() <= before, `${before} → ${timers()}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n\x1b[31m${failures} check${failures === 1 ? '' : 's'} failed\x1b[0m\n` : '\n\x1b[32mall good\x1b[0m\n');
process.exit(failures ? 1 : 0);
