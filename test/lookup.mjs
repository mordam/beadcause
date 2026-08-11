#!/usr/bin/env node
//
// Looking things up: the grant, and the wrapper that bounds it.
//
//   npm test                       (runs it alongside the other suites)
//   node test/lookup.mjs           (on its own)
//
// Two halves, and the first is the one that matters most.
//
// 1. **The allowlist, named grant by grant.** bc-awr asked that whatever is granted
//    be asserted rather than eyeballed, and that the test *name* each grant so that
//    widening it later is a deliberate act with a failing test attached. So the
//    lookup entries are listed here literally, the agents that do not have them are
//    asserted not to have them, and the things that were considered and refused —
//    `Bash(curl:*)`, the claude-in-chrome MCP tools, anything that can POST — are
//    asserted absent from every agent, not just from the two that changed.
// 2. **The wrapper does what the ruling said.** GET only, http/https only, no
//    loopback, bounded redirects, a byte cap that actually cancels the stream, and a
//    timeout. Each of those is a line in Adam's ruling on bc-awr and each gets a case.
//
// Nothing here reaches the real network. The fetch cases run against a throwaway
// server on loopback, via the `allowLocal` option that exists for exactly this and is
// deliberately unreachable from the command line.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import * as foundation from '../lib/foundation.js';
import { DEFAULT_TOOL_LIST } from '../lib/agents.js';
import { get, vetUrl, isBlockedAddress, lookupBrief, LookupError, MAX_REDIRECTS } from '../lib/lookup.js';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const GET = path.join(ROOT, 'bin', 'beadcause-get');

/**
 * The four lookup grants, spelled out.
 *
 * If you are here because this array made a test fail: that is the test working. Adding
 * a reach for an unattended agent is a decision, and the decision is Adam's. Update this
 * list in the same commit that updates the foundation, and say in the commit message
 * what the new one can do that the others cannot.
 *
 * The fourth arrived that way and is what the rule looks like when it works: bc-awr
 * argued browsing and ruled on its *shape* — a headless Chrome with a throwaway profile,
 * never the claude-in-chrome extension — and bc-8yw implemented it, which made this
 * array fail until it was updated on purpose. `beadcause-browse` reads a page that only
 * exists once its JavaScript has run, which is the one case the three above cannot: to
 * them such a page is indistinguishable from a page that says nothing. Its own rules
 * live in test/browse.mjs, because "may an agent browse?" and "whose browser is it?" are
 * different questions and only the first belongs here.
 */
const LOOKUP_GRANTS = ['WebSearch', 'WebFetch', 'Bash(beadcause-get:*)', 'Bash(beadcause-browse:*)'];

/** Agents that get to look things up, and agents that deliberately do not. */
const MAY_LOOK_UP = ['dispatch', 'advocate'];
const MAY_NOT = ['console', 'worker'];

/**
 * Reaches that were considered on bc-awr and refused, as patterns.
 *
 * `Bash(curl:*)` is the important one: it reads as "let it fetch a URL" and grants
 * `-X POST`, `-d`, `--upload-file`, `-o` writing anywhere on disk, and `file://`.
 * The claude-in-chrome entries are the other: they drive Adam's real logged-in
 * browser, and the ruling was that agents get a throwaway headless profile or nothing.
 */
const REFUSED = [
  /^Bash\(curl/,
  /^Bash\(wget/,
  /^Bash\(http/,
  /^Bash\(nc[ :)]/,
  /^Bash\(ssh/,
  /^mcp__claude-in-chrome/,
  /^Bash\(open /,
  /^Bash\(osascript/,
];

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

/* ------------------------------------------------------------- the allowlist */

console.log('the lookup grant, agent by agent');

for (const agent of MAY_LOOK_UP) {
  await test(`${agent} has all three lookup grants, named`, async () => {
    const f = await foundation.effective(ROOT, agent);
    for (const grant of LOOKUP_GRANTS) {
      assert.ok(f.allowedTools.includes(grant), `${agent} is missing ${grant}`);
    }
  });
}

for (const agent of MAY_NOT) {
  await test(`${agent} has none of them, and that is on purpose`, async () => {
    const f = await foundation.effective(ROOT, agent);
    // `worker` is interactive with no allowlist at all — the user is present and
    // approves in the loop — so there is nothing to assert about it beyond that it
    // did not quietly acquire one.
    if (!f.allowedTools) return;
    for (const grant of LOOKUP_GRANTS) {
      assert.ok(
        !f.allowedTools.includes(grant),
        `${agent} gained ${grant}; if that is wanted it needs its own decision, not a side effect`,
      );
    }
  });
}

await test('the reply agents’ baseline list carries the grants too', () => {
  // dispatch's foundation quotes DEFAULT_TOOL_LIST, and lib/agents.js is what the
  // phone is shown. Two copies of an allowlist is one copy that widens alone.
  for (const grant of LOOKUP_GRANTS) assert.ok(DEFAULT_TOOL_LIST.includes(grant), `DEFAULT_TOOL_LIST is missing ${grant}`);
  assert.deepEqual(DEFAULT_TOOL_LIST, foundation.baseline('dispatch').allowedTools);
});

await test('no agent gained curl, the live browser, or anything that can POST', async () => {
  for (const agent of foundation.AGENTS) {
    const f = await foundation.effective(ROOT, agent);
    for (const entry of f.allowedTools || []) {
      for (const pattern of REFUSED) {
        assert.ok(!pattern.test(entry), `${agent} has ${entry}, which ${pattern} refuses`);
      }
    }
  }
});

await test('no agent gained a tracker write as a side effect', async () => {
  // dispatch is the one this is really about: it is the agent a comment from a phone
  // spawns, and its list names the read-only `bd` verbs one at a time for this reason.
  const f = await foundation.effective(ROOT, 'dispatch');
  const joined = f.allowedTools.join(' ');
  assert.ok(!/bd create|bd close|bd delete|bd label|bd update/.test(joined));
  assert.ok(!joined.includes('Bash(bd *)'));
});

await test('the agents are told the capability exists', () => {
  // A capability an agent has not been told about is a capability it does not have:
  // it simply never runs the command, and from outside that is indistinguishable from
  // it deciding not to. The prompt builders are module-private, so this asserts on
  // the call site rather than on the rendered prompt.
  const brief = lookupBrief('Adam');
  for (const cmd of ['WebSearch', 'WebFetch', 'beadcause-get', 'beadcause-browse'])
    assert.ok(brief.includes(cmd), `the brief never mentions ${cmd}`);
  assert.match(brief, /Cite what you read/);
  for (const file of ['lib/dispatch.js', 'lib/advocate.js']) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(src.includes('${lookupBrief(owner)}'), `${file} never quotes the lookup brief into its prompt`);
  }
});

/* ----------------------------------------------------------------- refusals */

console.log('what the wrapper will not do');

await test('only http and https', () => {
  for (const bad of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com', 'data:text/plain,hi']) {
    assert.throws(() => vetUrl(bad), (err) => err instanceof LookupError && err.code === 'bad-scheme', `${bad} was allowed`);
  }
  assert.throws(() => vetUrl('not a url at all'), (err) => err.code === 'bad-url');
});

await test('no loopback, no private ranges, no cloud metadata', () => {
  const blocked = [
    'http://127.0.0.1/x',
    'http://localhost:9333/json',
    'http://something.local/x',
    'http://[::1]:80/x',
    'http://10.1.2.3/x',
    'http://192.168.0.5/x',
    'http://172.20.0.1/x',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.101.102.103/x',
  ];
  for (const url of blocked) {
    assert.throws(() => vetUrl(url), (err) => err instanceof LookupError && err.code === 'local', `${url} was allowed`);
  }
  assert.doesNotThrow(() => vetUrl('https://example.com/x'));
  assert.doesNotThrow(() => vetUrl('http://93.184.216.34/x'));
});

await test('address classification, directly', () => {
  for (const ip of ['127.0.0.1', '::1', '10.0.0.1', '169.254.169.254', '::ffff:127.0.0.1', 'fe80::1', 'fd00::1'])
    assert.ok(isBlockedAddress(ip), `${ip} should be blocked`);
  for (const ip of ['8.8.8.8', '93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']) assert.ok(!isBlockedAddress(ip), `${ip} should be fine`);
});

await test('a URL carrying credentials is refused', () => {
  assert.throws(() => vetUrl('https://user:pass@example.com/x'), (err) => err.code === 'credentials');
});

await test('the command has no flag for a method, a body, a header or an output file', async () => {
  for (const flag of ['--method=POST', '--data=x', '--header=Authorization:x', '--output=/tmp/x', '-X', '-d', '-o']) {
    const err = await run(process.execPath, [GET, 'https://example.com', flag]).then(
      () => null,
      (e) => e,
    );
    assert.ok(err, `${flag} was accepted`);
    assert.equal(err.code, 2, `${flag} exited ${err.code}`);
    assert.match(err.stderr, /no such option/);
  }
});

await test('the command refuses file:// and loopback, and says why', async () => {
  for (const [url, code] of [
    ['file:///etc/hosts', /bad-scheme/],
    ['http://127.0.0.1:9333/json', /local/],
  ]) {
    const err = await run(process.execPath, [GET, url]).then(
      () => null,
      (e) => e,
    );
    assert.ok(err, `${url} was fetched`);
    assert.equal(err.code, 1);
    assert.match(err.stderr, code);
  }
});

await test('no URL at all prints the usage rather than doing something', async () => {
  const err = await run(process.execPath, [GET]).then(
    () => null,
    (e) => e,
  );
  assert.ok(err);
  assert.equal(err.code, 2);
  assert.match(err.stdout, /read one public URL/);
});

/* -------------------------------------------------------------- the fetching */

console.log('what it does when it does fetch');

// One server, several routes, on loopback. `allowLocal` is how the test reaches it —
// there is no command-line flag that sets it, because an escape hatch an agent can
// type is not a guard.
let hops = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/plain') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('the ground snow load is 2.4 kPa\n');
  } else if (url.pathname === '/big') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    // Far more than the cap the test asks for, and it keeps coming: the point is that
    // the reader stops, not that the server does.
    res.end('x'.repeat(200_000));
  } else if (url.pathname === '/binary') {
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': '12345' });
    res.end(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]));
  } else if (url.pathname === '/once') {
    res.writeHead(302, { location: '/plain' });
    res.end();
  } else if (url.pathname === '/loop') {
    hops++;
    res.writeHead(302, { location: '/loop' });
    res.end();
  } else if (url.pathname === '/to-file') {
    res.writeHead(302, { location: 'file:///etc/hosts' });
    res.end();
  } else if (url.pathname === '/hang') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('start');
    // and never finish
  } else if (url.pathname === '/missing') {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('nope');
  } else if (url.pathname === '/method') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`method=${req.method} body=${req.headers['content-length'] || '0'}`);
  } else {
    res.writeHead(500);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

await test('it reads a page', async () => {
  const res = await get(`${base}/plain`, { allowLocal: true });
  assert.equal(res.status, 200);
  assert.match(res.body, /2\.4 kPa/);
  assert.equal(res.truncated, false);
});

await test('it is a GET, with no body, always', async () => {
  const res = await get(`${base}/method`, { allowLocal: true });
  assert.equal(res.body.trim(), 'method=GET body=0');
});

await test('the byte cap stops the read rather than buffering the lot', async () => {
  const res = await get(`${base}/big`, { allowLocal: true, maxBytes: 1000 });
  assert.equal(res.bytes, 1000);
  assert.equal(res.truncated, true);
  assert.equal(res.body.length, 1000);
});

await test('a redirect is followed, and the URL it lands on is what it reports', async () => {
  const res = await get(`${base}/once`, { allowLocal: true });
  assert.match(res.body, /2\.4 kPa/);
  assert.equal(res.url, `${base}/plain`);
  assert.deepEqual(res.redirects, [`${base}/plain`]);
});

await test('a redirect loop stops at the cap instead of running forever', async () => {
  hops = 0;
  await assert.rejects(get(`${base}/loop`, { allowLocal: true }), (err) => err.code === 'redirects');
  assert.ok(hops <= MAX_REDIRECTS + 1, `followed ${hops} hops`);
});

await test('a redirect to file:// is refused, same as typing it', async () => {
  // The far end chooses the next URL, so it gets the scrutiny the first one got.
  await assert.rejects(get(`${base}/to-file`, { allowLocal: true }), (err) => err.code === 'bad-scheme');
});

await test('a binary body is described, not dumped', async () => {
  const res = await get(`${base}/binary`, { allowLocal: true });
  assert.equal(res.binary, true);
  assert.equal(res.body, '');
  assert.equal(res.declaredBytes, 12345);
});

await test('--head reads no body', async () => {
  const res = await get(`${base}/plain`, { allowLocal: true, headersOnly: true });
  assert.equal(res.status, 200);
  assert.equal(res.body, '');
});

await test('a server that never finishes is a timeout, not a hang', async () => {
  await assert.rejects(get(`${base}/hang`, { allowLocal: true, timeoutMs: 1000 }), (err) => err.code === 'timeout');
});

await test('a 404 is an answer, not a crash', async () => {
  const res = await get(`${base}/missing`, { allowLocal: true });
  assert.equal(res.status, 404);
  assert.equal(res.body, 'nope');
});

server.close();

console.log(failures ? `\n${failures} failed` : '\nlookup: all good');
process.exit(failures ? 1 : 0);
