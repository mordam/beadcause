#!/usr/bin/env node
/**
 * lib/jira.js — the setting, the credential, and the read-only client.
 *
 *     npm test
 *     node test/jira.mjs
 *
 * Five things are worth a file here, and the first two are the ones that would go
 * wrong quietly:
 *
 * 1. **`bd config get` reports a missing key on stdout and exits 0.** It prints
 *    `jira.url (not set)`. A parser that trusts the exit code turns that sentence into
 *    a site URL, and the first symptom is a request to a hostname made of English.
 *    That is not a hypothetical — it is what the real binary does on this machine, and
 *    the fixture below copies it byte for byte.
 * 2. **The token must never be able to reach `config.json`.** `~/.config/beadcause` is
 *    a git repo that snapshots after every write, so a secret there is in a history a
 *    rotation cannot reach. The defence is the *filename*, so the filename is asserted
 *    against lib/commonrepo.js's own denylist rather than against a copy of the rule.
 * 3. **Nothing here may write to JIRA.** Not "no caller does" — no code path exists.
 *    That is checked twice: every request the exercised functions issue is a GET with
 *    no body, and the module's source carries no other method.
 * 4. **Off has to cost nothing.** A workspace with no `jira` block must not produce a
 *    single `bd` call, let alone a network one, because most workspaces are that.
 * 5. **A first configuration goes wrong in four ways** — no site, a site that is not a
 *    URL, no address, no credential — and each has to name the fix. A 401 and a 404
 *    are the same stack trace and completely different mornings.
 *
 * No network and no `bd`: the client is handed a fetch that answers from a script, and
 * `Bd.run` is replaced by one that answers from a table.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-jira-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });
// The daemon runs under launchd and never has this. Every test that wants the env
// path sets it deliberately and puts it back.
delete process.env.JIRA_API_TOKEN;

const jira = await import(LIB('jira.js'));
const { protectedPath } = await import(LIB('commonrepo.js'));

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

const WS = { name: 'climative', dir: path.join(tmp, 'beads', 'climative', '.beads') };

/**
 * A `bd` that answers `config get` from a table and records what it was asked.
 *
 * A key with no entry answers the way the real binary does for one nobody has set:
 * the sentence, on stdout, and a zero exit — which here means a resolved promise.
 */
function fakeBd(values = {}) {
  const calls = [];
  return {
    calls,
    async run(workspace, args) {
      calls.push(args.join(' '));
      if (args[0] !== 'config') throw new Error(`unexpected bd ${args.join(' ')}`);
      const key = args[2];
      if (Object.prototype.hasOwnProperty.call(values, key)) {
        const v = values[key];
        if (v instanceof Error) throw v;
        return `${v}\n`;
      }
      return `${key} (not set)\n`;
    },
  };
}

/**
 * A fetch that answers from a script and records every request it was given.
 *
 * The body is served as **text**, because that is what the client reads: lib/atlassian.js
 * takes `res.text()` once and parses it itself, since a response body is a stream that
 * cannot be read twice and the error path wants the same bytes the success path does. A
 * fixture that only knew how to `json()` would be one no real response resembles.
 *
 * `notJson` is therefore what a captive proxy actually looks like from in here — a 200,
 * and HTML — rather than a `json()` that throws, which is a shape nothing produces.
 */
function fakeFetch(reply) {
  const seen = [];
  const impl = async (url, init) => {
    seen.push({ url, init });
    const r = typeof reply === 'function' ? reply(url, init) : reply;
    if (r instanceof Error) throw r;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => (r.notJson ? '<!doctype html><title>Sign in to the proxy</title>' : JSON.stringify(r.body ?? null)),
    };
  };
  impl.seen = seen;
  return impl;
}

const BD_FULL = { 'jira.url': 'https://climative.atlassian.net', 'jira.username': 'adam@climative.ai', 'jira.projects': 'TECH' };

/* ------------------------------------------------------- the switch, and what off costs */

console.log('\nthe switch');
{
  check('no jira block at all is off', jira.jiraEnabled({}, 'climative') === false);
  check('an empty block is off', jira.jiraEnabled({ jira: { climative: {} } }, 'climative') === false);
  check('enabled false is off', jira.jiraEnabled({ jira: { climative: { enabled: false } } }, 'climative') === false);
  check(
    'the STRING "true" is off — a config typo must not switch on a network call',
    jira.jiraEnabled({ jira: { climative: { enabled: 'true' } } }, 'climative') === false
  );
  check('enabled true is on', jira.jiraEnabled({ jira: { climative: { enabled: true } } }, 'climative') === true);
  check('a block for another workspace does not switch this one on', jira.jiraEnabled({ jira: { sophab: { enabled: true } } }, 'climative') === false);
}

{
  const bd = fakeBd(BD_FULL);
  const s = await jira.settingsFor(bd, WS, {});
  check('a workspace with no block resolves to off', s.enabled === false, JSON.stringify(s));
  check('and costs not one bd call — most workspaces are this one', bd.calls.length === 0, bd.calls.join(' | '));
}

/* ------------------------------------------------------------------ the credential file */

console.log('\nthe credential');
{
  const file = jira.credentialFile('climative');
  check('lives in the config dir', path.dirname(file) === process.env.BEADCAUSE_CONFIG_DIR, file);
  check('is named for its workspace', path.basename(file) === 'jira-climative.key', file);
  check(
    'and that name is on lib/commonrepo.js’s denylist — the protection is the filename',
    protectedPath(path.basename(file)),
    'a token in this file WOULD be committed to the config repo'
  );
  check(
    'a workspace name with a slash in it cannot escape the directory',
    path.dirname(jira.credentialFile('../../etc/evil')) === process.env.BEADCAUSE_CONFIG_DIR,
    jira.credentialFile('../../etc/evil')
  );
}

{
  check('no file and no env is no token', jira.readToken('climative') === null);

  const file = jira.writeToken('climative', '  secret-token  ');
  check('a written token comes back trimmed', jira.readToken('climative') === 'secret-token');
  check('and the file is 0600', (fs.statSync(file).mode & 0o777) === 0o600, (fs.statSync(file).mode & 0o777).toString(8));

  // The case writeFileSync alone gets wrong: `mode` is only applied when it creates
  // the file, so a 0644 left by an earlier hand survives a rewrite.
  fs.chmodSync(file, 0o644);
  jira.writeToken('climative', 'secret-token');
  check('rewriting a world-readable one puts the mode back', (fs.statSync(file).mode & 0o777) === 0o600, (fs.statSync(file).mode & 0o777).toString(8));

  process.env.JIRA_API_TOKEN = 'from-the-environment';
  check('the environment wins, because it leaves no copy on disk', jira.readToken('climative') === 'from-the-environment');
  delete process.env.JIRA_API_TOKEN;
  check('and putting it back restores the file', jira.readToken('climative') === 'secret-token');
}

/* The option lib/confluence.js has always had as `apiTokenFile`, and the hole it opens.
   Until bc-jv4p the file was not nameable here at all, which read as "JIRA does not have
   this problem" and was true only for as long as that stayed so. */
{
  const named = { jira: { climative: { enabled: true, tokenFile: 'work-jira.key' } } };
  check(
    'a relative tokenFile resolves INSIDE the config dir, not against the daemon’s cwd',
    jira.credentialFile('climative', named) === path.join(process.env.BEADCAUSE_CONFIG_DIR, 'work-jira.key'),
    jira.credentialFile('climative', named)
  );
  const absolute = { jira: { climative: { enabled: true, tokenFile: path.join(tmp, 'elsewhere', 'jira.key') } } };
  check('an absolute one is taken as written', jira.credentialFile('climative', absolute) === path.join(tmp, 'elsewhere', 'jira.key'));

  jira.writeToken('climative', 'the-other-token', named);
  check('and the token is read from the file that was named', jira.readToken('climative', named) === 'the-other-token');
  check('while the default file is untouched', jira.readToken('climative') === 'secret-token');
}

{
  check('a workspace that never asked for JIRA is not told off about a file it has no opinion on', jira.tokenFileWarning({}, 'climative') === null);
  check('the default name draws no warning — the config repo refuses it', jira.tokenFileWarning({ jira: { climative: { enabled: true } } }, 'climative') === null);
  check(
    'a tokenFile the config repo would COMMIT does — the hole lib/auth.js and lib/confluence.js already covered',
    /WILL be committed/.test(jira.tokenFileWarning({ jira: { climative: { enabled: true, tokenFile: 'jira-token.txt' } } }, 'climative') || ''),
    String(jira.tokenFileWarning({ jira: { climative: { enabled: true, tokenFile: 'jira-token.txt' } } }, 'climative'))
  );
  check(
    'a file outside that directory is your business, not ours',
    jira.tokenFileWarning({ jira: { climative: { enabled: true, tokenFile: '/tmp/elsewhere.txt' } } }, 'climative') === null
  );
}

/* ------------------------------------------------------------------ reading bd's config */

console.log('\nwhat bd already knows');
{
  const bd = fakeBd(BD_FULL);
  check('a set key comes back', (await jira.bdConfig(bd, WS, 'jira.url')) === 'https://climative.atlassian.net');
  check(
    'an UNSET key is null — it prints "(not set)" on stdout and exits 0',
    (await jira.bdConfig(bd, WS, 'jira.project')) === null,
    'the sentence would otherwise become the value'
  );
  const angry = fakeBd({ 'jira.url': new Error('bd config get failed in climative: database is locked') });
  check('a bd that threw is null, not a crash in the poll loop', (await jira.bdConfig(angry, WS, 'jira.url')) === null);
  const chatty = fakeBd({ 'jira.url': 'https://one\nhttps://two' });
  check('a multi-line answer is nothing rather than a fragment', (await jira.bdConfig(chatty, WS, 'jira.url')) === null);
}

/* ------------------------------------------------------------------------ resolution */

console.log('\nresolving a workspace');
const ON = { jira: { climative: { enabled: true } } };
{
  jira.writeToken('climative', 'secret-token');
  const bd = fakeBd(BD_FULL);
  const s = await jira.settingsFor(bd, WS, ON);
  check('the site comes from bd when the block does not name one', s.url === 'https://climative.atlassian.net', s.url);
  check('and so does the address', s.email === 'adam@climative.ai', s.email);
  check('and the projects, split on the comma', JSON.stringify(s.projects) === '["TECH"]', JSON.stringify(s.projects));
  check('the token comes from the file', s.token === 'secret-token');
  check('and nothing is wrong', s.problem === null, s.problem);
}

{
  const bd = fakeBd(BD_FULL);
  const s = await jira.settingsFor(bd, WS, {
    jira: { climative: { enabled: true, url: 'https://other.atlassian.net/', email: 'me@other.com', projects: ['A', 'B'] } },
  });
  check('an explicit site wins over bd’s, and loses its trailing slash', s.url === 'https://other.atlassian.net', s.url);
  check('an explicit address wins too', s.email === 'me@other.com', s.email);
  check('and an explicit project list is taken as a list', JSON.stringify(s.projects) === '["A","B"]', JSON.stringify(s.projects));
}

console.log('\nthe four ways a first configuration goes wrong');
{
  const s = await jira.settingsFor(fakeBd({}), WS, ON);
  check('no site names the two places a site can be set', /jira\.climative\.url|bd config set jira\.url/.test(s.problem || ''), s.problem);
}
{
  const s = await jira.settingsFor(fakeBd({ 'jira.url': 'climative.atlassian.net' }), WS, ON);
  check('a site that is not a URL says so rather than being requested', /not a URL/.test(s.problem || ''), s.problem);
}
{
  const s = await jira.settingsFor(fakeBd({ 'jira.url': 'https://x.atlassian.net' }), WS, ON);
  check('no address asks for the one whose assignments count as yours', /email/.test(s.problem || ''), s.problem);
}
{
  fs.rmSync(jira.credentialFile('climative'));
  const s = await jira.settingsFor(fakeBd(BD_FULL), WS, ON);
  check('no credential names the file it goes in', (s.problem || '').includes('jira-climative.key'), s.problem);
  jira.writeToken('climative', 'secret-token');
}

/* --------------------------------------------------------------------- the client */

console.log('\nthe client');
const settings = await jira.settingsFor(fakeBd(BD_FULL), WS, ON);

{
  const f = fakeFetch({ status: 200, body: { issues: [{ key: 'TECH-1' }, { key: 'TECH-2' }] } });
  const issues = await jira.search(settings, 'assignee = "me"', { limit: 10, fetchImpl: f });
  const req = f.seen[0];
  const url = new URL(req.url);
  check('two issues come back', issues.length === 2, JSON.stringify(issues));
  check('against the site that was resolved', url.origin === 'https://climative.atlassian.net', url.origin);
  check('at the current search endpoint', url.pathname === '/rest/api/3/search/jql', url.pathname);
  check('carrying the JQL it was given', url.searchParams.get('jql') === 'assignee = "me"', url.searchParams.get('jql'));
  check('and asking for named fields rather than the whole issue', (url.searchParams.get('fields') || '').includes('summary'), url.searchParams.get('fields'));
  check('the method is GET', req.init.method === 'GET', req.init.method);
  check('there is no body', !('body' in req.init), JSON.stringify(Object.keys(req.init)));
  check(
    'and the credential is basic auth over address:token',
    req.init.headers.Authorization === `Basic ${Buffer.from('adam@climative.ai:secret-token').toString('base64')}`,
    req.init.headers.Authorization
  );
}

{
  const f = fakeFetch({ status: 200, body: { issues: [] } });
  await jira.search(settings, 'x', { limit: 5000, fetchImpl: f });
  check(
    `a caller asking for 5000 gets ${jira.MAX_RESULTS} — the cap is here, not at the call site`,
    new URL(f.seen[0].url).searchParams.get('maxResults') === String(jira.MAX_RESULTS),
    new URL(f.seen[0].url).searchParams.get('maxResults')
  );
}

{
  const f = fakeFetch({ status: 200, body: { message: 'no issues key at all' } });
  const issues = await jira.search(settings, 'x', { fetchImpl: f });
  check('a body with no issues array is no issues, not a crash', Array.isArray(issues) && issues.length === 0);
}

console.log('\nwhat went wrong, in the words of the thing to fix');
const failed = async (status, extra = {}) => {
  try {
    await jira.search(settings, 'x', { fetchImpl: fakeFetch({ status, ...extra }) });
    return null;
  } catch (err) {
    return err.message;
  }
};
{
  const m = await failed(401);
  check('401 sends you to the credential', /credential/i.test(m || '') && (m || '').includes('jira-climative.key'), m);
  const n = await failed(404);
  check('404 sends you to the site URL — the same stack trace, a different morning', /site URL/i.test(n || ''), n);
  const p = await failed(403);
  check('403 says the credential worked and the access did not', /refused the request/i.test(p || ''), p);
  const q = await failed(500);
  check('anything else is reported as itself rather than guessed at', /answered 500/.test(q || ''), q);
  const r = await failed(200, { notJson: true });
  check('a 200 that is not JSON says so', /not JSON/.test(r || ''), r);
  check('and quotes what arrived instead, which is usually recognisable in one glance', /Sign in to the proxy/.test(r || ''), r);
}

/* JIRA's own sentence about the request, which lib/atlassian.js reads out of a body
   shaped nothing like Confluence's. Appended rather than substituted: it is precise
   about the request and says nothing about which install asked. */
{
  const m = await failed(400, { body: { errorMessages: ["Field 'assigne' does not exist."], errors: {} } });
  check('a 400 carries JIRA’s own words about it', /assigne/.test(m || '') && /answered 400/.test(m || ''), m);
  const n = await failed(400, { body: { errorMessages: [], errors: { project: 'no project could be found' } } });
  check('including the per-field object, which is a different "errors" entirely', /project: no project could be found/.test(n || ''), n);
  const q = await failed(401, { body: { errorMessages: ['Client must be authenticated.'] } });
  check('and a 401 still names the file first — the site’s words do not replace ours', /jira-climative\.key/.test(q || '') && /Client must be/.test(q || ''), q);
}

{
  const boom = fakeFetch(() => Object.assign(new Error('aborted'), { name: 'AbortError' }));
  let msg = null;
  try {
    await jira.search(settings, 'x', { fetchImpl: boom });
  } catch (err) {
    msg = err.message;
  }
  check('a timeout reads as unreachable with the number in it', /unreachable/.test(msg || '') && /\d+s/.test(msg || ''), msg);
}

{
  const dead = fakeFetch(() => new Error('getaddrinfo ENOTFOUND climative.atlassian.net'));
  let msg = null;
  try {
    await jira.search(settings, 'x', { fetchImpl: dead });
  } catch (err) {
    msg = err.message;
  }
  check('and so does a name that does not resolve, carrying the reason', /unreachable/.test(msg || '') && /ENOTFOUND/.test(msg || ''), msg);
}

{
  let msg = null;
  try {
    await jira.search({ ...settings, enabled: false }, 'x', { fetchImpl: fakeFetch({ status: 200, body: {} }) });
  } catch (err) {
    msg = err.message;
  }
  check('a disabled workspace cannot be read from by passing settings by hand', /not enabled/.test(msg || ''), msg);

  let other = null;
  try {
    await jira.search({ ...settings, problem: 'no JIRA credential for climative' }, 'x', { fetchImpl: fakeFetch({ status: 200, body: {} }) });
  } catch (err) {
    other = err.message;
  }
  check('and neither can one whose configuration is broken', /no JIRA credential/.test(other || ''), other);
}

{
  const f = fakeFetch({ status: 200, body: { emailAddress: 'adam@climative.ai' } });
  const c = await jira.check(settings, { fetchImpl: f });
  check('the configuration check says who it authenticated as', c.ok === true && c.as === 'adam@climative.ai', JSON.stringify(c));
  const b = await jira.check(settings, { fetchImpl: fakeFetch({ status: 401 }) });
  check('and a failing one carries the reason instead of throwing', b.ok === false && /credential/i.test(b.problem || ''), JSON.stringify(b));
}

/* ------------------------------------------------- nothing here can write to JIRA */

console.log('\nread-only by construction');
{
  const source = fs.readFileSync(LIB('jira.js'), 'utf8');
  const methods = [...source.matchAll(/method:\s*'([A-Z]+)'/g)].map((m) => m[1]);
  check(
    `every method literal in the module is GET (found ${methods.join(', ') || 'none'})`,
    methods.length > 0 && methods.every((m) => m === 'GET'),
    methods.join(', ')
  );
  check(
    'and nothing constructs a request body — the way lib/lookup.js enforces the same rule',
    !/\bbody:\s/.test(source.replace(/^\s*\*.*$/gm, '')),
    'a body: in this module is the door a write would come through'
  );
  const writes = Object.keys(jira).filter((k) => /^(post|put|patch|delete|create|update|transition|comment)/i.test(k));
  check('and no exported name promises a write', writes.length === 0, writes.join(', '));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
