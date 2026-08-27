#!/usr/bin/env node
/**
 * Reading a Confluence page in as context for an agent.
 *
 *     npm test
 *     node test/confluenceread.mjs
 *
 * The other half of test/confluence.mjs, and the same harness: a fake Confluence on
 * loopback that answers the three v2 GETs this uses and records every one of them.
 * Nothing reaches Atlassian, and `BEADCAUSE_CONFIG_DIR` is moved before a lib module
 * is loaded.
 *
 * The four things asserted are the four decisions bc-xecw had to make, and each one is
 * a property a plausible refactor breaks:
 *
 * 1. **Only the spaces in `confluence.readSpaces`, checked against the space Confluence
 *    says the page is in.** The version of this that looks right and is wrong trusts
 *    the URL: `/wiki/spaces/ENG/pages/777` is a page id with a space key written beside
 *    it, and the key is *decoration* — Confluence serves the page whatever is in that
 *    segment. So the case below points an `ENG`-looking URL at a page that lives in
 *    `OPS` and requires the refusal. A title reference to an unlisted space is refused
 *    with **no call at all**, which is asserted on the call log rather than on the
 *    error, because "we asked Confluence and it said no" leaks that somebody asked.
 * 2. **Off by default, and off means no credential is read.** Not "it returned an
 *    error" but the token reader was never called — the same injectable `read` the
 *    publish suite uses, for the same reason. An install that publishes happily still
 *    reads nothing until it names a space.
 * 3. **A page becomes markdown**, and the conversion is asserted on the shapes a wiki
 *    page is actually made of: nested lists, a table with a header row, a code macro
 *    whose indentation is content and whose `language` parameter is not, a blockquote
 *    that contains more than one paragraph, and a macro whose body is not in the
 *    storage format at all.
 * 4. **Never cached.** Two reads of one page make two requests. A cache here is not a
 *    stale answer, it is a wrong fact with a version number on it saying otherwise.
 *
 * Plus the grant itself: the wrapper is on both allowlists, the brief is quoted into
 * both prompts, and nothing in the read path is anything but a GET.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (name) => path.join(ROOT, 'lib', name);

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));
const section = (name) => console.log(`\n${name}\n`);

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-confread-')));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });
// A token in the environment would answer for every case below and hide the file half.
delete process.env.BEADCAUSE_CONFLUENCE_TOKEN;

// foundation.js first — the habit test/lookup.mjs established. The cycle it worked
// around is gone (bc-u4na moved the list into lib/toolbelt.js) and test/loadorder.mjs
// is what guards that now, but importing the foundation first still costs nothing.
const foundation = await import(LIB('foundation.js'));
// tooldecl.js since bc-wbrhi — toolbelt.js keeps the hand-written half, and the whole
// list is that plus the b7e tools that declare themselves.
const { DEFAULT_TOOL_LIST } = await import(LIB('tooldecl.js'));
const conf = await import(LIB('confluence.js'));

/* ------------------------------------------------------------ the fake Confluence */

const pages = new Map();
const calls = [];

pages.set('777', {
  id: '777',
  title: 'On-call rota',
  spaceId: '901',
  version: { number: 14, createdAt: '2026-08-01T09:00:00.000Z' },
  body: {
    storage: {
      value: `<h2>Paging</h2><p>The <strong>primary</strong> is paged first &amp; acks.</p>
<ul><li>Ack within <code>5m</code></li><li>Escalate<ul><li>secondary</li><li>manager</li></ul></li></ul>
<table><tbody><tr><th>Day</th><th>Who</th></tr><tr><td>Mon</td><td>Ana</td></tr></tbody></table>
<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">bash</ac:parameter><ac:plain-text-body><![CDATA[pd trigger
    --urgent]]></ac:plain-text-body></ac:structured-macro>
<blockquote><p>First.</p><p>Second.</p></blockquote>
<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">TECH-1</ac:parameter></ac:structured-macro>
<p>See <a href="https://example.com/r">the runbook</a>.</p>`,
    },
  },
  _links: { webui: '/spaces/ENG/pages/777/On-call+rota' },
});
// The page the first assertion turns on: it is in OPS, and OPS is not readable. Every
// reference to it below spells ENG, because that is what a pasted URL does.
pages.set('888', {
  id: '888',
  title: 'Salary bands',
  spaceId: '902',
  version: { number: 3 },
  body: { storage: { value: '<p>Secret.</p>' } },
  _links: { webui: '/spaces/OPS/pages/888/Salary+bands' },
});
// A page big enough that its markdown, printed by the CLI, cannot fit in a 64KB pipe
// buffer — see the "through a real pipe" section below (bc-dgx7.45).
const BIG_MARKER = 'END-OF-BIG-PAGE-4f1c9a';
pages.set('999', {
  id: '999',
  title: 'A very long runbook',
  spaceId: '901',
  version: { number: 1 },
  body: { storage: { value: `<p>${'padding word '.repeat(8000)}${BIG_MARKER}</p>` } },
  _links: { webui: '/spaces/ENG/pages/999/A+very+long+runbook' },
});

const SPACES = { ENG: '901', OPS: '902' };

const fake = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace('/wiki/api/v2', '');
  calls.push({ method: req.method, path: p, query: url.search });
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'GET' && p === '/spaces') {
    const keys = url.searchParams.getAll('keys');
    return send(200, { results: keys.filter((k) => SPACES[k]).map((k) => ({ id: SPACES[k], key: k })) });
  }
  if (req.method === 'GET' && /^\/spaces\/\d+\/pages$/.test(p)) {
    const title = url.searchParams.get('title');
    const spaceId = p.split('/')[2];
    const found = [...pages.values()].filter((pg) => pg.title === title && pg.spaceId === spaceId);
    return send(200, { results: found, _links: { base: 'http://127.0.0.1/wiki' } });
  }
  if (req.method === 'GET' && /^\/pages\/\d+$/.test(p)) {
    const page = pages.get(p.split('/')[2]);
    return page ? send(200, page) : send(404, { errors: [{ title: 'no such page' }] });
  }
  return send(405, { errors: [{ title: `the reader made a ${req.method} to ${p}` }] });
});

// Port 0: several suites here run at once and a fixed port is how two of them collide.
await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
const site = `http://127.0.0.1:${fake.address().port}`;

const TOKEN = 'ATATT-not-a-real-token';
const cfgWith = (readSpaces) => ({ confluence: { site, email: 'you@team.com', space: 'ENG', readSpaces } });
const readToken = () => TOKEN;

/* ---------------------------------------------------------------- the config gate */

section('Which spaces may be read');

check('no readSpaces is an empty list, not an inherited one', conf.readableSpaces({ confluence: { space: 'ENG' } }).length === 0);
check('the keys are uppercased and de-duplicated', JSON.stringify(conf.readableSpaces({ confluence: { readSpaces: ['eng', 'ENG', ' ops '] } })) === '["ENG","OPS"]');
check('a bare string is one space', JSON.stringify(conf.readableSpaces({ confluence: { readSpaces: 'eng' } })) === '["ENG"]');
check('readable() answers case-insensitively', conf.readable(cfgWith(['ENG']), 'eng') && !conf.readable(cfgWith(['ENG']), 'ops'));

check('an install that asked for nothing is not told off', conf.readProblem({ confluence: { site, email: 'a@b.c' } }) === null);
check(
  'readSpaces without a site says so',
  conf.readProblem({ confluence: { readSpaces: ['ENG'] } }) === 'confluence.readSpaces is set but confluence.site or confluence.email is missing'
);
check(
  'readSpaces without a token says where to put one',
  /no API token/.test(conf.readProblem(cfgWith(['ENG']), { read: () => { throw new Error('nope'); } }) || '')
);

/* ------------------------------------------------------------------- the reference */

section('Naming a page');

const ref = (s) => JSON.stringify(conf.parseRef(s));
check('a pasted page URL', ref(`${site}/wiki/spaces/ENG/pages/777/On-call+rota`) === '{"pageId":"777","claimedSpace":"ENG"}');
check('a page id on its own', ref('777') === '{"pageId":"777"}');
check('SPACE/Title, uppercased', ref('eng/On-call rota') === '{"spaceKey":"ENG","title":"On-call rota"}');
check('the old viewpage URL', ref(`${site}/wiki/pages/viewpage.action?pageId=678`) === '{"pageId":"678"}');
check('a short link is its own answer, not "not a page"', ref(`${site}/wiki/x/AbCdEf`) === '{"shortLink":true}');
check('prose is not a page reference', conf.parseRef('the on-call page') === null && conf.parseRef('') === null);

/* -------------------------------------------------------------------- the refusals */

section('What may not be read');

{
  const read = () => {
    throw new Error('the token file was opened on an install that reads nothing');
  };
  let err = null;
  try {
    await conf.readPage({ confluence: { site, email: 'you@team.com', space: 'ENG' } }, '777', { read });
  } catch (e) {
    err = e;
  }
  check('publishing configured still reads nothing', /no spaces are listed/.test(err?.message || ''), err?.message);
  check('and no credential was read to say so', err?.status === 403);
}

{
  calls.length = 0;
  let err = null;
  try {
    await conf.readPage(cfgWith(['ENG']), 'OPS/Salary bands', { read: readToken });
  } catch (e) {
    err = e;
  }
  check('a title in an unlisted space is refused', /space OPS is not one this install may read/.test(err?.message || ''), err?.message);
  check('and Confluence was never asked', calls.length === 0, `${calls.length} calls: ${JSON.stringify(calls)}`);
}

{
  // The one that matters. The URL says ENG; the page is in OPS. A check that reads the
  // URL passes this and hands an agent the salary bands.
  let err = null;
  try {
    await conf.readPage(cfgWith(['ENG']), `${site}/wiki/spaces/ENG/pages/888/Salary+bands`, { read: readToken });
  } catch (e) {
    err = e;
  }
  check('a page id is checked against the space it is really in', /not in a space this install may read/.test(err?.message || ''), err?.message);
  check('even when the URL claims a readable space', err?.status === 403);
}

{
  let err = null;
  try {
    await conf.readPage(cfgWith(['ENG']), `${site}/wiki/x/AbCdEf`, { read: readToken });
  } catch (e) {
    err = e;
  }
  check('a short link says what it is and what to do', /short link/.test(err?.message || ''), err?.message);
}

/* ------------------------------------------------------------------------ the read */

section('Reading one');

calls.length = 0;
const page = await conf.readPage(cfgWith(['ENG', 'eng']), `${site}/wiki/spaces/ENG/pages/777/On-call+rota`, { read: readToken });

check('the page comes back with what makes it citable', page.id === '777' && page.spaceKey === 'ENG' && page.version === 14, JSON.stringify(page).slice(0, 200));
check('including when it was last changed', page.updatedAt === '2026-08-01T09:00:00.000Z');
check('and a URL a person can open', page.url === `${site}/wiki/spaces/ENG/pages/777/On-call+rota`, page.url);
check('every call it made was a GET', calls.every((c) => c.method === 'GET'), JSON.stringify(calls));

const md = page.markdown;
check('a heading is a heading', md.includes('## Paging'), md.slice(0, 120));
check('bold is written once, not twice', md.includes('The **primary** is paged') && !md.includes('****'), md.slice(0, 160));
check('an entity is decoded', md.includes('first & acks'));
check('a link keeps its href', md.includes('[the runbook](https://example.com/r)'));
check('a list is one block of lines, not one block per item', md.includes('- Ack within `5m`\n- Escalate'), JSON.stringify(md.slice(md.indexOf('- Ack'), md.indexOf('- Ack') + 80)));
check('a nested list is indented two spaces', md.includes('\n  - secondary\n  - manager'), JSON.stringify(md.slice(md.indexOf('- Escalate'), md.indexOf('- Escalate') + 60)));
check('a table keeps its header rule', md.includes('| Day | Who |\n| --- | --- |\n| Mon | Ana |'));
check('a code macro keeps the indentation that is its content', md.includes('```\npd trigger\n    --urgent\n```'), JSON.stringify(md.slice(md.indexOf('```'), md.indexOf('```') + 60)));
check('and drops the language parameter rather than printing it', !md.includes('bash'));
check('a blockquote marks every line it covers', md.includes('> First.\n>\n> Second.'), JSON.stringify(md.slice(md.indexOf('> First'), md.indexOf('> First') + 40)));
check('a macro whose body is not in the page says which macro it was', md.includes('[jira macro]'));
check('and does not print the macro parameters as prose', !md.includes('TECH-1'));

{
  calls.length = 0;
  await conf.readPage(cfgWith(['ENG']), '777', { read: readToken });
  await conf.readPage(cfgWith(['ENG']), '777', { read: readToken });
  const fetches = calls.filter((c) => /^\/pages\/777$/.test(c.path)).length;
  check('the page is fetched every time — nothing is cached', fetches === 2, `${fetches} fetches of the page`);
}

/* ------------------------------------------------------------ through a real pipe */

section('Through a real pipe');

{
  // `process.exit(0)` right after printing the page used to drop whatever of it was
  // still pending: stdout to a **pipe** is async in Node, so a big page — up to
  // DEFAULT_MAX_CHARS, 200,000 characters — could cut at the 64KB pipe buffer with a
  // success status and no signal at all (bc-dgx7.45).
  //
  // `spawn`, not `spawnSync` — the fake Confluence above is served by *this* process,
  // and `spawnSync` blocks this event loop until the child exits, which would starve
  // the very server the child is trying to reach. See test/monitorwidth.mjs's own note
  // on the same trap.
  fs.writeFileSync(
    path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'),
    JSON.stringify({ confluence: { site, email: 'you@team.com', space: 'ENG', readSpaces: ['ENG'] } }, null, 2)
  );
  const BIN = path.join(ROOT, 'bin', 'beadcause-confluence');
  const run = (args) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [BIN, ...args], {
        env: { ...process.env, BEADCAUSE_CONFLUENCE_TOKEN: TOKEN },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
      child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });

  const printed = await run(['999']);
  check('printed status 0', printed.status === 0, `status ${printed.status}: ${printed.stderr}`);
  check('printed payload too small to test the pipe buffer would be a bad test', printed.stdout.length > 65536, `${printed.stdout.length} bytes`);
  check('the printed page is whole — ends with the page, not cut mid-write', printed.stdout.trimEnd().endsWith(BIG_MARKER), printed.stdout.slice(-80));

  const jsoned = await run(['999', '--json']);
  check('--json status 0', jsoned.status === 0, `status ${jsoned.status}: ${jsoned.stderr}`);
  check('--json payload too small to test the pipe buffer would be a bad test', jsoned.stdout.length > 65536, `${jsoned.stdout.length} bytes`);
  const parsed = JSON.parse(jsoned.stdout); // throws (failing the check below) if cut mid-JSON
  check('--json is whole and parseable, and carries the whole page', parsed.markdown?.endsWith(BIG_MARKER), parsed.markdown?.slice(-80));
}

/* -------------------------------------------------------------------- what it is not */

section('The shape of the wrapper');

const libSrc = fs.readFileSync(LIB('confluence.js'), 'utf8');
const readHalf = libSrc.slice(libSrc.indexOf('reading one back in'));
check('the read half constructs no request body', !/\bcall\([^)]*'(POST|PUT|DELETE)'/.test(readHalf));
check("and asks for nothing but pages and spaces", [...readHalf.matchAll(/call\(\s*\w+,\s*'GET',\s*`([^`]+)`/g)].every((m) => /^\/(pages|spaces)/.test(m[1])));

const binSrc = fs.readFileSync(path.join(ROOT, 'bin', 'beadcause-confluence'), 'utf8');
// The *import*, not the file: the header prose says the word "publish" out loud, on
// purpose, because how this differs from the publish half is the thing worth saying.
const imported = /import \{([^}]*)\} from '\.\.\/lib\/confluence\.js'/.exec(binSrc)?.[1] || '';
check('the command imports only the reader', /readPage/.test(imported) && !/publish|toStorage|target/.test(imported), imported.trim());
check('and offers no flag that could write', !/--(method|data|header|output|title|space)=/.test(binSrc));

/* ----------------------------------------------------------------------- the grant */

section('Who may run it');

const GRANT = 'Bash(beadcause-confluence:*)';
check('the reply agents have it', DEFAULT_TOOL_LIST.includes(GRANT));
check('the dispatch foundation is still the same list', JSON.stringify(DEFAULT_TOOL_LIST) === JSON.stringify(foundation.baseline('dispatch').allowedTools));
check('the advocate has it too', foundation.baseline('advocate').allowedTools.includes(GRANT));
check(
  'and it is not in package.json only as a leftover',
  JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).bin['beadcause-confluence'] === 'bin/beadcause-confluence'
);

check('nothing is said about it when no space is readable', conf.confluenceBrief({ confluence: { site, email: 'a@b.c' } }) === '');
check('nothing is said when the site is missing either', conf.confluenceBrief({ confluence: { readSpaces: ['ENG'] } }) === '');
{
  const brief = conf.confluenceBrief(cfgWith(['ENG']), 'Adam');
  check('the brief names the spaces that are open', brief.includes('ENG') && brief.includes('beadcause-confluence'), brief.slice(0, 120));
  check('and says whose account it reads as', brief.includes('reads as Adam'));
  for (const file of ['dispatch.js', 'advocate.js']) {
    const src = fs.readFileSync(LIB(file), 'utf8');
    check(`${file} quotes the brief into its prompt`, src.includes('confluenceBrief(cfg') && src.includes('${wiki'));
  }
}

/* ------------------------------------------------------------------------- the end */

fake.close();
await cleanupTmp(tmp);
console.log(failures ? `\n${failures} failed\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
