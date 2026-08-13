#!/usr/bin/env node
/**
 * lib/jirapoll.js — the query, the clock, what off costs, and what a failure leaves behind.
 *
 *     npm test
 *     node test/jira-poll.mjs
 *
 * test/jira.mjs covers the client underneath this: the credential, the `(not set)` trap,
 * and the fact that no code path here can write to JIRA. What is worth a second file is
 * the four things the *poller* can get wrong, and three of them go wrong quietly:
 *
 * 1. **The JQL.** It is the only question this epic asks JIRA and it is not a parameter.
 *    `resolution = EMPTY` rather than a status name, the projects scoped only when there
 *    are any, and an address escaped rather than pasted into a quoted string.
 * 2. **Off costs nothing.** A workspace with no `jira` block must not produce a network
 *    call *or* a `bd` spawn. Most workspaces on any machine are that workspace, so a
 *    poller that costs "almost nothing" for one costs the size of somebody's `~/beads`.
 * 3. **The cache is over the spawns, not over the answer.** `settingsFor` is three `bd`
 *    processes; on a one-minute timer, uncached, that is three a minute forever for a URL
 *    that changes never. But the *token* has to be re-read every sweep, because writing
 *    that file is how JIRA gets switched on, and a cached "no credential" would report a
 *    problem that was fixed ten minutes ago.
 * 4. **A failure is a record, not an empty list.** The last good answer stands in and the
 *    reason is named — lib/sweep.js's argument, applied to a third kind of read. A JIRA
 *    section that empties itself on an expired token and refills an hour later is
 *    indistinguishable, from the outside, from having no tickets.
 *
 * No network and no `bd`: the client is handed a fetch that answers from a script, and
 * `bd.run` answers `config get` from a table and counts what it was asked.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-jirapoll-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });
// The daemon runs under launchd and never has this; a test that wants it sets it itself.
delete process.env.JIRA_API_TOKEN;

const { assignedJql, createJiraPoller, escapeJql, jiraEveryMs, JIRA_FLOOR_SECONDS, ticketFrom, TICKET_FIELDS, TICKET_LIMIT } =
  await import(LIB('jirapoll.js'));
const { writeToken } = await import(LIB('jira.js'));

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));
const checks = (name, fn) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

const WS = { name: 'climative', dir: path.join(tmp, 'beads', 'climative', '.beads') };
const OTHER = { name: 'sophab', dir: path.join(tmp, 'beads', 'sophab', '.beads') };
const ON = { jira: { climative: { enabled: true, email: 'adam@climative.ai' } } };

/** `bd`, answering `config get` from a table and counting every call. */
function fakeBd(values = {}) {
  const calls = [];
  return {
    calls,
    async run(workspace, args) {
      calls.push(`${workspace?.name || '?'} ${args.join(' ')}`);
      if (args[0] !== 'config') throw new Error(`unexpected bd ${args.join(' ')}`);
      const key = args[2];
      if (Object.prototype.hasOwnProperty.call(values, key)) return `${values[key]}\n`;
      // What the real binary prints for a key nobody has set — on stdout, exit 0.
      return `${key} (not set)\n`;
    },
  };
}

const BD_FULL = { 'jira.url': 'https://climative.atlassian.net', 'jira.username': 'adam@climative.ai', 'jira.projects': 'TECH' };

/** A JIRA that answers from a script and records every request. */
function fakeFetch(reply) {
  const seen = [];
  const impl = async (url, init) => {
    seen.push({ url: String(url), init });
    const r = (typeof reply === 'function' ? reply(String(url), init, seen.length) : reply) || { status: 200, body: {} };
    if (r instanceof Error) throw r;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => JSON.stringify(r.body ?? null),
    };
  };
  impl.seen = seen;
  return impl;
}

/** An issue as JIRA hands one over, with only the fields we asked for. */
const issue = (key, over = {}) => ({
  key,
  self: `https://climative.atlassian.net/rest/api/3/issue/${key}`,
  fields: {
    summary: `${key} needs doing`,
    status: { name: 'In Progress' },
    updated: '2026-08-13T10:00:00.000+0000',
    assignee: { emailAddress: 'adam@climative.ai', displayName: 'Adam Morgan' },
    ...over,
  },
});

const searchReply = (...keys) => ({ status: 200, body: { issues: keys.map((k) => issue(k)) } });

/** The `jql` a request carried, decoded. */
const jqlOf = (req) => new URL(req.url).searchParams.get('jql');

const token = (name = 'climative') => writeToken(name, 'a-token');

/* --------------------------------------------------------------------------- the query */

console.log('\nthe one query');
{
  const settings = { workspace: 'climative', email: 'adam@climative.ai', projects: [], url: 'https://x.atlassian.net' };
  const jql = assignedJql(settings);
  check('it asks for what is assigned to that address', jql.includes('assignee = "adam@climative.ai"'), jql);
  check(
    'unresolved by resolution, never by a status name a site can rename',
    jql.includes('resolution = EMPTY') && !/status/i.test(jql),
    jql
  );
  check('newest first, because the list is truncated', jql.endsWith('ORDER BY updated DESC'), jql);
  check('no project clause when the workspace has no projects', !jql.includes('project'), jql);

  const scoped = assignedJql({ ...settings, projects: ['TECH', 'OPS'] });
  check('scoped to the projects when it has them', scoped.includes('project in ("TECH", "OPS")'), scoped);
  check('and the scope is ANDed onto the same query', scoped.startsWith('assignee = "adam@climative.ai" AND resolution = EMPTY AND'), scoped);

  check('a quote in an address cannot end the string', escapeJql('a"b') === 'a\\"b', escapeJql('a"b'));
  check('nor can a backslash', escapeJql('a\\b') === 'a\\\\b', escapeJql('a\\b'));
  check(
    'the escaping is applied where it matters',
    assignedJql({ ...settings, email: 'ev"il" OR project = SECRET' }).includes('\\"il\\"'),
    assignedJql({ ...settings, email: 'ev"il"' })
  );

  const asMe = assignedJql(settings, { currentUser: true });
  check('the fallback asks the same question of the token holder', asMe.startsWith('assignee = currentUser() AND resolution = EMPTY'), asMe);
}

console.log('\nwhat a held ticket is');
{
  const settings = { workspace: 'climative', url: 'https://climative.atlassian.net/', email: 'adam@climative.ai' };
  const row = ticketFrom(issue('TECH-42'), settings);
  checks('key, summary, status, updated, url, assignee — and the workspace they came from', () => {
    assert.deepEqual(Object.keys(row).sort(), ['assignee', 'key', 'status', 'summary', 'updated', 'url', 'workspace']);
    assert.equal(row.key, 'TECH-42');
    assert.equal(row.status, 'In Progress');
    assert.equal(row.assignee, 'adam@climative.ai');
    assert.equal(row.workspace, 'climative');
  });
  check('the url is the one a person means, not the REST one', row.url === 'https://climative.atlassian.net/browse/TECH-42', row.url);
  check(
    'no description body — the view fetches that',
    !('description' in row) && !TICKET_FIELDS.includes('description'),
    TICKET_FIELDS.join(',')
  );
  const anon = ticketFrom(issue('TECH-9', { assignee: { displayName: 'Adam Morgan' } }), settings);
  check('a site that hides addresses still names the person', anon.assignee === 'Adam Morgan', String(anon.assignee));
}

/* ----------------------------------------------------------------------------- the clock */

console.log('\nthe clock');
{
  check('a minute by default', jiraEveryMs({}) === 60000, String(jiraEveryMs({})));
  check('the config wins', jiraEveryMs({ jiraSeconds: 300 }) === 300000, String(jiraEveryMs({ jiraSeconds: 300 })));
  check('with a floor under it', jiraEveryMs({ jiraSeconds: 1 }) === JIRA_FLOOR_SECONDS * 1000, String(jiraEveryMs({ jiraSeconds: 1 })));
  check('and nonsense falls back rather than turning it into a busy loop', jiraEveryMs({ jiraSeconds: 'soon' }) === 60000);
  const src = fs.readFileSync(LIB('config.js'), 'utf8');
  check('the number ships in the config beside pollSeconds', /jiraSeconds: 60,/.test(src), 'no jiraSeconds default in lib/config.js');
}

/* ------------------------------------------------------------------- what off has to cost */

console.log('\noff costs nothing');
{
  const bd = fakeBd(BD_FULL);
  const fetchImpl = fakeFetch(searchReply('TECH-1'));
  const poller = createJiraPoller({ bd, fetchImpl });
  const out = await poller.sweep({ jira: {} }, [WS, OTHER]);
  check('no network call for a workspace nobody switched on', fetchImpl.seen.length === 0, `${fetchImpl.seen.length} requests`);
  check('and no bd spawn either — settingsFor is three of them', bd.calls.length === 0, bd.calls.join(' / '));
  check('nothing swept, nothing held', out.results.length === 0 && poller.tickets().length === 0);
  check('and nothing in trouble, because off is not a failure', poller.trouble().length === 0);

  // The other half of the same rule: one workspace on, one off, in the same sweep.
  const bd2 = fakeBd(BD_FULL);
  const fetch2 = fakeFetch(searchReply('TECH-1'));
  token();
  const mixed = createJiraPoller({ bd: bd2, fetchImpl: fetch2 });
  await mixed.sweep(ON, [WS, OTHER]);
  check('only the configured workspace is asked', fetch2.seen.length === 1, `${fetch2.seen.length} requests`);
  check('and only its bd is spawned', new Set(bd2.calls.map((c) => c.split(' ')[0])).size === 1, bd2.calls.join(' / '));
}

/* ----------------------------------------------------------------------------- the sweep */

console.log('\nthe sweep');
{
  token();
  const bd = fakeBd(BD_FULL);
  const fetchImpl = fakeFetch(searchReply('TECH-7', 'TECH-3'));
  const poller = createJiraPoller({ bd, fetchImpl });
  const out = await poller.sweep(ON, [WS]);

  check('the tickets arrive', out.results[0]?.state === 'ok' && poller.tickets().length === 2, JSON.stringify(out.results[0]));
  check('one request, and it is a GET', fetchImpl.seen.length === 1 && fetchImpl.seen[0].init.method === 'GET');
  check('it went to the search endpoint', fetchImpl.seen[0].url.includes('/rest/api/3/search/jql'), fetchImpl.seen[0].url);
  check('carrying the query this file owns', jqlOf(fetchImpl.seen[0]).includes('assignee = "adam@climative.ai"'), jqlOf(fetchImpl.seen[0]));
  check(
    'asking only for the fields a row draws',
    new URL(fetchImpl.seen[0].url).searchParams.get('fields') === TICKET_FIELDS.join(','),
    new URL(fetchImpl.seen[0].url).searchParams.get('fields')
  );
  check(
    'and capped, because an epic per ticket is what happens next',
    Number(new URL(fetchImpl.seen[0].url).searchParams.get('maxResults')) === TICKET_LIMIT
  );
  check('one workspace can be read on its own', poller.tickets('climative').length === 2 && poller.tickets('sophab').length === 0);

  // Newest first, whatever order two workspaces' answers happened to be folded in.
  const ordered = createJiraPoller({
    bd: fakeBd(BD_FULL),
    fetchImpl: fakeFetch({
      status: 200,
      body: {
        issues: [issue('TECH-1', { updated: '2026-01-01T00:00:00.000+0000' }), issue('TECH-2', { updated: '2026-08-01T00:00:00.000+0000' })],
      },
    }),
  });
  await ordered.sweep(ON, [WS]);
  check('held newest first', ordered.tickets().map((t) => t.key).join(',') === 'TECH-2,TECH-1', ordered.tickets().map((t) => t.key).join(','));
}

console.log('\nthe cache is over the spawns, not over the answer');
{
  token();
  const bd = fakeBd(BD_FULL);
  const fetchImpl = fakeFetch(searchReply('TECH-1'));
  const poller = createJiraPoller({ bd, fetchImpl });
  await poller.sweep(ON, [WS]);
  const first = bd.calls.length;
  // Two here rather than three, and the difference is the point: `settingsFor` asks `bd`
  // only for what the block did not answer, and this block names the address. A block
  // carrying nothing but `enabled: true` — the shortest one that works, and the one the
  // README recommends — is all three.
  check('a bd spawn per value the block did not carry', first === 2, bd.calls.join(' / '));
  const bare = fakeBd(BD_FULL);
  await createJiraPoller({ bd: bare, fetchImpl: fakeFetch(searchReply('TECH-1')) }).sweep({ jira: { climative: { enabled: true } } }, [WS]);
  check('which for the shortest working block is three', bare.calls.length === 3, bare.calls.join(' / '));
  await poller.sweep(ON, [WS]);
  await poller.sweep(ON, [WS]);
  check('and none at all on the ticks after it', bd.calls.length === first, bd.calls.join(' / '));
  check('while the reads keep happening', fetchImpl.seen.length === 3, `${fetchImpl.seen.length} requests`);
  poller.invalidate('climative');
  await poller.sweep(ON, [WS]);
  check('dropped when something says the config moved', bd.calls.length === first * 2, bd.calls.join(' / '));
}

{
  // The half that must NOT be cached: the ordinary way JIRA gets switched on is writing
  // the token file, and a held "no credential" would report a problem already fixed.
  fs.rmSync(path.join(process.env.BEADCAUSE_CONFIG_DIR, 'jira-climative.key'), { force: true });
  const bd = fakeBd(BD_FULL);
  const fetchImpl = fakeFetch(searchReply('TECH-1'));
  const poller = createJiraPoller({ bd, fetchImpl });
  await poller.sweep(ON, [WS]);
  const before = poller.trouble()[0];
  check('a workspace switched on with no credential is trouble, not silence', Boolean(before), 'nothing recorded');
  check('and the record names the file to put it in', /jira-climative\.key/.test(before?.error || ''), before?.error || '');
  check('nothing was asked of JIRA, because there was nothing to ask with', fetchImpl.seen.length === 0);
  token();
  await poller.sweep(ON, [WS]);
  check('writing the token is enough — the next tick reads it', poller.tickets().length === 1, JSON.stringify(poller.trouble()));
  check('and the trouble clears itself', poller.trouble().length === 0, JSON.stringify(poller.trouble()));
}

/* ---------------------------------------------------------------------- a failure is loud */

console.log('\na failure never reads as no tickets');
{
  token();
  let mode = 'ok';
  const fetchImpl = fakeFetch(() => (mode === 'ok' ? searchReply('TECH-7', 'TECH-3') : { status: 401, body: { errorMessages: ['nope'] } }));
  const poller = createJiraPoller({ bd: fakeBd(BD_FULL), fetchImpl });
  await poller.sweep(ON, [WS]);
  check('two held after a good sweep', poller.tickets().length === 2);

  mode = 'broken';
  const out = await poller.sweep(ON, [WS]);
  check('the failure is recorded against the workspace', poller.trouble().length === 1 && poller.trouble()[0].workspace === 'climative');
  check('on its own channel, so it is never mistaken for a bd read', poller.trouble()[0].channel === 'jira', poller.trouble()[0].channel);
  check('with the reason, in JIRA words', /refused the credential/.test(poller.trouble()[0].error), poller.trouble()[0].error);
  check('the last good answer stands in', poller.tickets().length === 2, JSON.stringify(poller.tickets()));
  check('and the outcome says it failed rather than throwing', out.results[0].state === 'failed', JSON.stringify(out.results[0]));

  mode = 'ok';
  await poller.sweep(ON, [WS]);
  check('recovery clears the record', poller.trouble().length === 0);
}

{
  // A network that is simply not there — the same class of event, arriving as a rejection
  // rather than as a status, and it must not escape the sweep.
  token();
  const poller = createJiraPoller({ bd: fakeBd(BD_FULL), fetchImpl: fakeFetch(new Error('getaddrinfo ENOTFOUND')) });
  const out = await poller.sweep(ON, [WS]);
  check('an unreachable site is a record, not a rejection', out.results[0].state === 'failed' && poller.trouble().length === 1);
  check('and the held answer is empty rather than wrong', poller.tickets().length === 0);
}

{
  // Switched off after it was on: the held rows are a stand-in for a read nobody could
  // make, and once nobody is reading there is nothing to stand in for.
  token();
  const poller = createJiraPoller({ bd: fakeBd(BD_FULL), fetchImpl: fakeFetch(searchReply('TECH-1')) });
  await poller.sweep(ON, [WS]);
  check('held while it is on', poller.tickets().length === 1);
  await poller.sweep({ jira: { climative: { enabled: false } } }, [WS]);
  check('and dropped the moment it is off', poller.tickets().length === 0, JSON.stringify(poller.tickets()));
}

console.log('\nonly a sweep that moved wakes anybody');
{
  token();
  let issues = [issue('TECH-1')];
  const poller = createJiraPoller({ bd: fakeBd(BD_FULL), fetchImpl: fakeFetch(() => ({ status: 200, body: { issues } })) });
  const first = await poller.sweep(ON, [WS]);
  check('the first answer is a change — there was nothing before it', first.changed.length === 1);
  const same = await poller.sweep(ON, [WS]);
  check('the identical answer is not', same.changed.length === 0, JSON.stringify(same.changed));

  issues = [issue('TECH-1'), issue('TECH-2')];
  check('a ticket arriving is', (await poller.sweep(ON, [WS])).changed.length === 1);
  issues = [issue('TECH-1', { updated: '2026-08-13T18:00:00.000+0000' }), issue('TECH-2')];
  check('and so is one of them moving, because the row draws when it did', (await poller.sweep(ON, [WS])).changed.length === 1);

  issues = [];
  const emptied = await poller.sweep(ON, [WS]);
  check('a ticket leaving is a change too', emptied.changed.length === 1 && poller.tickets().length === 0);
}

/* --------------------------------------------------- the site that will not take an address */

console.log('\na site that refuses to search by address');
{
  token();
  const seenJql = [];
  const fetchImpl = fakeFetch((url) => {
    if (url.includes('/myself')) return { status: 200, body: { emailAddress: 'adam@climative.ai', displayName: 'Adam Morgan' } };
    const jql = new URL(url).searchParams.get('jql');
    seenJql.push(jql);
    if (jql.includes('currentUser()')) return searchReply('TECH-5');
    return { status: 400, body: { errorMessages: ["Field 'assignee' does not exist"] } };
  });
  const poller = createJiraPoller({ bd: fakeBd(BD_FULL), fetchImpl });
  await poller.sweep(ON, [WS]);
  check('the ticket still arrives', poller.tickets().length === 1 && poller.tickets()[0].key === 'TECH-5', JSON.stringify(poller.trouble()));
  check('having confirmed whose credential it is first', fetchImpl.seen.some((r) => r.url.includes('/rest/api/3/myself')));
  await poller.sweep(ON, [WS]);
  check('and it is remembered — the refused query is not asked twice', seenJql.filter((j) => j.includes('"adam@')).length === 1, seenJql.join(' | '));
}

{
  // The guard: a block naming somebody else's address must never quietly answer with the
  // token holder's tickets. bc-0i27.4 files an epic per row, under this person's name.
  token();
  const fetchImpl = fakeFetch((url) => {
    if (url.includes('/myself')) return { status: 200, body: { emailAddress: 'somebody.else@climative.ai' } };
    return { status: 400, body: { errorMessages: ["Field 'assignee' does not exist"] } };
  });
  const poller = createJiraPoller({ bd: fakeBd({ ...BD_FULL, 'jira.username': 'colleague@climative.ai' }), fetchImpl });
  await poller.sweep({ jira: { climative: { enabled: true, email: 'colleague@climative.ai' } } }, [WS]);
  check('no fallback when the credential belongs to someone else', poller.tickets().length === 0, JSON.stringify(poller.tickets()));
  check('and the failure reported is the one JIRA actually gave', /answered 400/.test(poller.trouble()[0]?.error || ''), poller.trouble()[0]?.error || '');
  check('the second query was never issued', !fetchImpl.seen.some((r) => String(r.url).includes('currentUser')), 'currentUser() was asked anyway');
}

/* ------------------------------------------------------------------ wired into the daemon */

console.log('\nwired into the poll cycle');
{
  const src = fs.readFileSync(LIB('server.js'), 'utf8');
  check('the poller exists in the daemon', /createJiraPoller\(\{ bd \}\)/.test(src));
  check('on a clock of its own, not on pollSeconds', /jiraEveryMs\(cfg\)/.test(src));
  check('and its failure is reported like every other sweep', /sweepFailed\('the JIRA poll'/.test(src));
  check(
    'the tickets ride the inbox payload as `tickets`, which is what the row reads',
    /tickets: liveTickets\(jira\.tickets\(\)\)/.test(src)
  );
  check(
    'each one stamped with its space, or the inbox filter files it under Other',
    /space: spaceFor\(cfg, t\.workspace\)\?\.name \|\| null/.test(src),
    'no space on a ticket row'
  );
  check(
    'and a sweep that moved wakes the parked phones',
    /for \(const o of out\.changed \|\| \[\]\)[\s\S]{0,400}app\.bus\.emit\(\{ type: 'jira'/.test(src),
    'nothing emits when the tickets change — a parked /api/poll would never learn'
  );
  check('and so does the unmerged record', /jiraTrouble: jira\.trouble\(\)/.test(src));
  check(
    'the merged banner carries the JIRA read too',
    /mergeTrouble\(\.\.\.channels\.map\(\(c\) => sweeps\[c\]\)\.filter\(Boolean\), jira\)/.test(src),
    'the JIRA record is not merged into `trouble`'
  );
}

console.log(failures ? `\n${failures} failed` : '\nall good');
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
