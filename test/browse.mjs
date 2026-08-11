#!/usr/bin/env node
//
// Browsing: the grant, the throwaway profile, and the browser that is never driven.
//
//   npm test                       (runs it alongside the other suites)
//   node test/browse.mjs           (on its own)
//
// bc-awr settled what browsing for an agent is, and bc-8yw is the implementation. The
// ruling has two halves and this file is here for the second one:
//
//   1. Agents may render a page. Fine — `Bash(beadcause-browse:*)`, asserted below the
//      way test/lookup.mjs asserts the other three lookup grants: named literally, so
//      that adding a fifth is a deliberate act with a failing test attached.
//   2. **They do it in a headless Chrome with a throwaway --user-data-dir, never the
//      claude-in-chrome extension.** That is the half with teeth. The extension drives
//      the browser Adam is signed into, so an agent holding it acts as him on every site
//      with a live session, and its per-site permission prompt has nobody present to
//      answer it at the hour these agents run.
//
// The failure this file exists to catch is not malice. It is a future change that wants
// to reuse a warm profile because pages load faster — a reasonable-sounding optimisation
// whose entire content is one string, which hands an unattended agent every cookie on
// this machine, and which no diff review reliably catches. So the profile rule is
// asserted from three directions: the guard refuses every real profile path by name, the
// command line is read without launching anything, and a real run reports the profile it
// actually used and is checked to have deleted it.
//
// The live half needs Chrome and says so when it is not there rather than passing
// quietly — a suite that silently skips its only end-to-end case is a suite that reads
// green while the feature is broken. Nothing here touches the public network: the page
// it renders is served from a throwaway server on loopback.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import * as foundation from '../lib/foundation.js';
import { DEFAULT_TOOL_LIST } from '../lib/agents.js';
import { lookupBrief, LookupError } from '../lib/lookup.js';
import {
  browse,
  BrowseError,
  PROFILE_PREFIX,
  assertThrowawayProfile,
  makeProfile,
  chromeArgs,
  allowSubresource,
  findChrome,
} from '../lib/browse.js';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BROWSE = path.join(ROOT, 'bin', 'beadcause-browse');
const TMP = fs.realpathSync(os.tmpdir());

/** The grant, spelled out. A fifth lookup reach is a decision, and the decision is Adam's. */
const BROWSE_GRANT = 'Bash(beadcause-browse:*)';

/** Who gets it, and who deliberately does not. */
const MAY_BROWSE = ['dispatch', 'advocate'];
const MAY_NOT = ['console', 'worker'];

/**
 * Profiles that must never be driven, as paths rather than as a rule.
 *
 * Written the way the mistake would actually be made — someone reaching for the profile
 * that is already warm — because "is the guard correct?" only has an answer in terms of
 * the directories it is guarding against.
 */
const REAL_PROFILES = [
  path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'Default'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Chromium'),
  path.join(os.homedir(), '.config', 'google-chrome'),
  path.join(os.homedir(), '.config', 'chromium'),
  os.homedir(),
  path.join(ROOT, '.claude', 'chrome-profile'),
];

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.log(`  ✗ ${name}\n    ${String(err.message).split('\n').slice(0, 8).join('\n    ')}`);
  }
}

/* --------------------------------------------------------------- the allowlist */

console.log('\nthe browsing grant, agent by agent\n');

for (const agent of MAY_BROWSE) {
  await test(`${agent} has ${BROWSE_GRANT}, named`, async () => {
    const f = await foundation.effective(ROOT, agent);
    assert.ok(f.allowedTools.includes(BROWSE_GRANT), `${agent} is missing ${BROWSE_GRANT}`);
  });
}

for (const agent of MAY_NOT) {
  await test(`${agent} does not, and that is on purpose`, async () => {
    const f = await foundation.effective(ROOT, agent);
    // `worker` is interactive with no allowlist at all — Adam is in the window approving
    // in the loop — so there is nothing to assert beyond it not having quietly grown one.
    if (!f.allowedTools) return;
    assert.ok(!f.allowedTools.includes(BROWSE_GRANT), `${agent} gained ${BROWSE_GRANT} as a side effect`);
  });
}

await test('the reply agents’ baseline list carries it too', () => {
  // dispatch's foundation quotes DEFAULT_TOOL_LIST and lib/agents.js is what the phone's
  // extended-tools dialog shows. Two copies of an allowlist is one copy that widens alone.
  assert.ok(DEFAULT_TOOL_LIST.includes(BROWSE_GRANT), `DEFAULT_TOOL_LIST is missing ${BROWSE_GRANT}`);
  assert.deepEqual(DEFAULT_TOOL_LIST, foundation.baseline('dispatch').allowedTools);
});

await test('no agent gained the live logged-in browser instead', async () => {
  // The other half of the ruling, and the one this whole feature is the alternative to.
  // `browse` exists so that nobody ever has a reason to reach for these.
  const LIVE_BROWSER = [/^mcp__claude-in-chrome/, /^Bash\(open /, /^Bash\(osascript/, /^Bash\(chrome/i];
  for (const agent of foundation.AGENTS) {
    const f = await foundation.effective(ROOT, agent);
    for (const entry of f.allowedTools || []) {
      for (const pattern of LIVE_BROWSER) {
        assert.ok(!pattern.test(entry), `${agent} has ${entry}, which drives the browser Adam is signed into`);
      }
    }
  }
});

await test('and nobody gained a general node, which would be all of this and more', async () => {
  // `Bash(node:*)` would grant `beadcause-browse` and every other script in the repo and
  // any JavaScript an agent cares to write. The advocate's one node entry is the
  // screenshot script, named in full; see the note beside it in lib/foundation.js.
  for (const agent of foundation.AGENTS) {
    const f = await foundation.effective(ROOT, agent);
    for (const entry of f.allowedTools || []) {
      assert.ok(!/^Bash\(node[\s:]*\*\)$/.test(entry), `${agent} has ${entry}`);
    }
  }
});

await test('the agents are told the capability exists, and when not to use it', () => {
  // A capability an agent was never told about is a capability it does not have: it
  // simply never runs the command, which from outside is indistinguishable from it
  // having decided not to. That is the failure bc-awr was opened for, one layer up.
  const brief = lookupBrief('Adam');
  assert.ok(brief.includes('beadcause-browse'), 'the lookup brief never mentions it');
  assert.match(brief, /shell/, 'the brief never says what case this is for');
  assert.match(brief, /cannot|no way to/i, 'the brief never says what it cannot do');
  for (const file of ['lib/dispatch.js', 'lib/advocate.js']) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(src.includes('${lookupBrief(owner)}'), `${file} never quotes the lookup brief into its prompt`);
  }
});

/* ------------------------------------------------------------- the profile rule */

console.log('\nthe throwaway profile, which is the ruling\n');

await test('a real Chrome profile is refused, by every name it goes by', () => {
  for (const dir of REAL_PROFILES) {
    assert.throws(
      () => assertThrowawayProfile(dir),
      (err) => err instanceof BrowseError && err.code === 'profile',
      `${dir} was accepted — that profile carries the cookies of whoever is signed in`,
    );
  }
});

await test('so is a temp directory that is not one of ours', () => {
  // Under the system temp directory is necessary and not sufficient: another tool's
  // scratch directory is not a browser profile this module made, and deleting it on the
  // way out would be somebody else's data.
  const other = fs.mkdtempSync(path.join(TMP, 'not-beadcause-'));
  try {
    assert.throws(() => assertThrowawayProfile(other), (err) => err.code === 'profile');
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }
});

await test('and a relative path that climbs out of the temp directory', () => {
  assert.throws(() => assertThrowawayProfile(path.join(TMP, PROFILE_PREFIX + 'x', '..', '..')), (err) => err.code === 'profile');
});

await test('one this module made is accepted, and it is empty', () => {
  const p = makeProfile();
  try {
    assert.equal(assertThrowawayProfile(p), fs.realpathSync(p));
    assert.ok(path.basename(p).startsWith(PROFILE_PREFIX));
    assert.deepEqual(fs.readdirSync(p), [], 'a fresh profile is empty — no cookies, no history, no extensions');
  } finally {
    fs.rmSync(p, { recursive: true, force: true });
  }
});

await test('the command line is headless, throwaway, and names no port to collide on', () => {
  const p = path.join(TMP, `${PROFILE_PREFIX}fake`);
  const args = chromeArgs({ profile: p });
  assert.ok(args.includes('--headless=new'), 'not headless');
  assert.ok(args.includes(`--user-data-dir=${p}`), 'no throwaway profile on the command line');
  assert.ok(args.includes('--disable-extensions'), 'extensions are the thing the ruling is about');
  // Port 0: Chrome picks one and writes it into the profile. A port derived from the pid
  // collides between concurrent agents, and a fixed one is an address anything on this
  // machine could connect to — lib/lookup.js refuses loopback partly because a CDP
  // endpoint opens a tab for whoever asks.
  assert.ok(args.includes('--remote-debugging-port=0'), 'the debugging port is not ephemeral');
  // Nothing on the line may name a directory outside the temp profile.
  for (const a of args) {
    if (!a.startsWith('--user-data-dir=')) continue;
    const dir = a.slice('--user-data-dir='.length);
    assert.ok(dir.startsWith(TMP + path.sep), `${dir} is not under ${TMP}`);
  }
  assert.ok(!args.some((a) => a.includes(os.homedir())), 'a home-directory path reached the command line');
});

await test('--webgl swaps out --disable-gpu rather than adding to it', () => {
  // The trap from the sophab recipe: --disable-gpu means no WebGL at all, so a canvas
  // photographs black and the two flag sets are alternatives, not layers.
  const plain = chromeArgs({ profile: path.join(TMP, `${PROFILE_PREFIX}a`) });
  const gl = chromeArgs({ profile: path.join(TMP, `${PROFILE_PREFIX}b`), webgl: true });
  assert.ok(plain.includes('--disable-gpu'));
  assert.ok(!gl.includes('--disable-gpu'), 'WebGL was asked for and the GPU is still disabled');
  assert.ok(gl.includes('--use-angle=swiftshader'));
});

/* ------------------------------------------------------- what the page may fetch */

console.log('\nwhat the page itself is allowed to reach\n');

await test('a page cannot fetch loopback, a private range, or cloud metadata', () => {
  const blocked = [
    'http://127.0.0.1:9333/json',
    'http://localhost:4317/api/questions',
    'http://10.1.2.3/x',
    'http://192.168.0.5/x',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]:80/x',
    'http://something.local/x',
  ];
  for (const url of blocked) assert.equal(allowSubresource(url).ok, false, `${url} was allowed`);
});

await test('nor a file:// or any other scheme that is not the web', () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'chrome://settings', 'javascript:alert(1)']) {
    assert.equal(allowSubresource(url).ok, false, `${url} was allowed`);
  }
});

await test('but the ordinary things a page is made of still load', () => {
  for (const url of ['https://example.com/app.js', 'http://93.184.216.34/x.css', 'data:image/png;base64,iVBOR', 'blob:https://example.com/abc']) {
    assert.equal(allowSubresource(url).ok, true, `${url} was refused: ${allowSubresource(url).why}`);
  }
});

await test('the test-only escape hatch opens loopback and nothing else', () => {
  // `allowLocal` is narrower here than in lib/lookup.js on purpose. The fixture server
  // has to be on 127.0.0.1 and there is nowhere else to serve from offline; it does not
  // need 10/8 or the metadata address, and a flag one notch wider is a flag that would
  // have made the live assertion below impossible to write.
  assert.equal(allowSubresource('http://127.0.0.1:8080/x', { allowLocal: true }).ok, true);
  assert.equal(allowSubresource('http://169.254.169.254/x', { allowLocal: true }).ok, false);
  assert.equal(allowSubresource('http://10.1.2.3/x', { allowLocal: true }).ok, false);
});

/* ------------------------------------------------------------------- the command */

console.log('\nwhat the command will not do\n');

await test('there is no flag to run JavaScript, click, type, log in or name a file', async () => {
  // The point of a wrapper rather than a browser on the allowlist, and the same argument
  // bin/beadcause-get makes about curl: the agent names a URL, and cannot name an action.
  for (const flag of [
    '--eval=alert(1)',
    '--js=fetch("/x")',
    '--script=x.js',
    '--click=#submit',
    '--type=hello',
    '--cookie=session=abc',
    '--header=Authorization:x',
    '--user-data-dir=/tmp/x',
    '--out=/tmp/x.png',
    '--output=/tmp/x.png',
    '-e',
  ]) {
    const err = await run(process.execPath, [BROWSE, 'https://example.com', flag]).then(
      () => null,
      (e) => e,
    );
    assert.ok(err, `${flag} was accepted`);
    assert.equal(err.code, 2, `${flag} exited ${err.code}`);
    assert.match(err.stderr, /no such option/);
  }
});

await test('it refuses file:// and loopback before it launches anything', async () => {
  for (const [url, code] of [
    ['file:///etc/hosts', /bad-scheme/],
    ['http://127.0.0.1:9333/json', /local/],
    ['https://user:pass@example.com/x', /credentials/],
  ]) {
    const err = await run(process.execPath, [BROWSE, url]).then(
      () => null,
      (e) => e,
    );
    assert.ok(err, `${url} was browsed`);
    assert.equal(err.code, 1);
    assert.match(err.stderr, code);
  }
});

await test('the library refuses the same URLs, before any Chrome exists', async () => {
  // Through the library rather than the command, so the assertion is that the refusal is
  // in the code path everything shares and not in the argument parser.
  for (const url of ['file:///etc/hosts', 'http://127.0.0.1:9333/json', 'gopher://example.com']) {
    await assert.rejects(browse(url), (err) => err instanceof LookupError, `${url} was not refused`);
  }
});

await test('no URL at all prints the usage rather than doing something', async () => {
  const err = await run(process.execPath, [BROWSE]).then(
    () => null,
    (e) => e,
  );
  assert.ok(err);
  assert.equal(err.code, 2);
  assert.match(err.stdout, /throwaway headless Chrome/);
});

/* ------------------------------------------------------------------- a real run */

const chrome = findChrome();
console.log(`\na real page, in a real Chrome${chrome ? '' : ' — SKIPPED, no Chrome on this machine'}\n`);

if (chrome) {
  // The fixture: a page whose visible text is assembled at runtime out of pieces, so the
  // string being asserted appears NOWHERE in the HTML as served. That is what makes this
  // a test of rendering rather than of fetching — the assertion below that
  // `beadcause-get` would have missed it is the same claim from the other side.
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/style.css') {
      res.writeHead(200, { 'content-type': 'text/css' });
      res.end('body{font-family:sans-serif}');
    } else if (url.pathname === '/js') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>rendered</title>
<link rel="stylesheet" href="/style.css"></head><body>
<div id="root">loading…</div>
<script>
  // Two reaches this browser must not be allowed to make, from inside the page.
  fetch('http://169.254.169.254/latest/meta-data/').catch(function(){});
  var img = new Image(); img.src = 'http://10.11.12.13/pixel.png';
  var bits = ['ground','snow','load','2','4','kPa'];
  setTimeout(function () {
    document.getElementById('root').textContent =
      bits[0] + ' ' + bits[1] + ' ' + bits[2] + ' ' + bits[3] + '.' + bits[4] + ' ' + bits[5];
    document.body.className = 'ready';
  }, 250);
</script></body></html>`);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const before = fs.readdirSync(TMP).filter((d) => d.startsWith(PROFILE_PREFIX));
  let result = null;

  await test('a page that only renders under JavaScript is read', async () => {
    result = await browse(`${base}/js`, { allowLocal: true, waitFor: 'body.ready', timeoutMs: 60_000 });
    assert.equal(result.title, 'rendered');
    assert.match(result.text, /ground snow load 2\.4 kPa/, `what came back was: ${JSON.stringify(result.text.slice(0, 200))}`);
    assert.ok(!result.text.includes('loading…'), 'the placeholder is still there — nothing rendered');
  });

  await test('and the served HTML does not contain it, which is the whole point', async () => {
    // The other half of the claim: what `WebFetch` and `beadcause-get` see is a shell.
    const raw = await (await fetch(`${base}/js`)).text();
    assert.ok(!raw.includes('ground snow load 2.4 kPa'), 'the fixture is not actually JavaScript-rendered');
    assert.ok(raw.includes('loading…'));
  });

  await test('the profile it used was a throwaway, and it is gone', () => {
    assert.ok(result.profile.startsWith(TMP + path.sep), `${result.profile} is not under ${TMP}`);
    assert.ok(path.basename(result.profile).startsWith(PROFILE_PREFIX));
    assert.ok(!result.profile.startsWith(os.homedir() + path.sep) || result.profile.startsWith(TMP + path.sep));
    assert.equal(result.profileRemoved, true, 'browse() reported it could not delete the profile');
    assert.equal(fs.existsSync(result.profile), false, `${result.profile} is still on disk`);
    const after = fs.readdirSync(TMP).filter((d) => d.startsWith(PROFILE_PREFIX));
    assert.deepEqual(after, before, `the run left ${after.length - before.length} profile(s) behind`);
  });

  await test('the page’s own reach into this machine was refused', () => {
    // The interception is live, not just the policy function above: the fixture asked for
    // the cloud-metadata address and for a private-range image, from inside the page.
    const what = result.blocked.map((b) => b.what).join('\n');
    assert.ok(
      /169\.254\.169\.254|10\.11\.12\.13/.test(what),
      `neither blocked reach was recorded; blocked was: ${JSON.stringify(result.blocked)}`,
    );
    // And it did not block everything, which would pass the assertion above for the
    // wrong reason: the page's own stylesheet is on loopback and had to load.
    assert.ok(!/127\.0\.0\.1/.test(what), `the page's own subresources were blocked too: ${what}`);
  });

  await test('--html gives the DOM after JavaScript, not the HTML as served', async () => {
    const dom = await browse(`${base}/js`, { allowLocal: true, html: true, waitFor: 'body.ready', timeoutMs: 60_000 });
    assert.equal(dom.isHtml, true);
    assert.match(dom.text, /ground snow load 2\.4 kPa/);
    assert.match(dom.text, /<div id="root"/);
    assert.equal(dom.profileRemoved, true);
  });

  await test('the character cap truncates rather than returning everything', async () => {
    const small = await browse(`${base}/js`, { allowLocal: true, maxChars: 5, waitFor: 'body.ready', timeoutMs: 60_000 });
    assert.equal(small.text.length, 5);
    assert.equal(small.truncated, true);
    assert.ok(small.chars > 5, 'the full length was not reported');
  });

  await test('a page that is not there is a failure and says so', async () => {
    await assert.rejects(
      browse(`${base}/nope`, { allowLocal: true, timeoutMs: 30_000 }),
      (err) => err instanceof BrowseError,
      'a 404 came back as a page that rendered',
    );
  });

  server.close();
} else {
  // Not a silent skip. The end-to-end case is the only thing here that proves a page is
  // actually rendered, and a suite that hides its absence reads green while the feature
  // is broken.
  console.log('  ! set CHROME_PATH, or install Chrome, to run the end-to-end case');
}

console.log(failures ? `\n${failures} failed` : '\nbrowse: all good');
process.exit(failures ? 1 : 0);
