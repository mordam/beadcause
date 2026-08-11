#!/usr/bin/env node
/**
 * Where the Android app is allowed to send its token.
 *
 *     npm test
 *     node test/pairhost.mjs
 *
 * The app's pairing token is a bearer credential for every workspace at once, and the
 * rule about where it may go is spread across three files that cannot see each other:
 * `Address.kt` decides, `network_security_config.xml` is what the platform actually
 * enforces, and `lib/tls.js` on the Mac decides what URL is put in the QR in the first
 * place. Every way this breaks is a *silent* way — a URL the Mac hands out and the
 * phone refuses reads as "pairing is broken", and a host the app allows but the
 * platform blocks reads as "the server is down".
 *
 * Kotlin cannot be run here, so this does not test behaviour: it reads the constants
 * out of the shipping sources and checks that the three files still agree.
 *
 * 1. **The rule is not "any https".** That is what it used to be, and it would hand
 *    the token to any host on the internet with a certificate — which is all of them.
 * 2. **The name pattern is the one the Mac validates with.** `magicDnsName()` in
 *    lib/tls.js will only ever return a name matching its regex; if the app's is
 *    narrower, a legitimate tailnet cannot pair.
 * 3. **Cleartext is off, and the exceptions are the same list in both files.** A host
 *    in `Address.LOOPBACK` that the network security config does not permit fails at
 *    the socket with `UnknownServiceException` and no explanation.
 * 4. **The refusal happens before the first request**, which is the only moment it is
 *    worth anything.
 * 5. **Everything that talks to the server gates on `Prefs.isLive`**, so a pairing
 *    left on the old cleartext URL goes to the QR screen instead of spinning.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const KOTLIN = 'android/app/src/main/java/m4m/beadcause';
const address = read(`${KOTLIN}/Address.kt`);
const pair = read(`${KOTLIN}/PairActivity.kt`);
const prefs = read(`${KOTLIN}/Prefs.kt`);
// Comments stripped: that file explains itself at length, with the very examples these
// checks look for ("`100.96` would match foo.100.96 and not 100.96.105.106"), and a
// rule read out of the prose describing the rule is worth nothing.
const netconf = read('android/app/src/main/res/xml/network_security_config.xml').replace(
  /<!--[\s\S]*?-->/g,
  ''
);
const tls = read('lib/tls.js');

let failures = 0;
let ran = 0;
function check(name, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${err.message.split('\n')[0]}`);
  }
}

console.log('\npairing host policy');

/* ------------------------------------------------------------ the rule itself */

/** The MagicDNS pattern as the app ships it, as a JS RegExp. */
function appNamePattern() {
  const m = address.match(/MAGIC_DNS = Regex\("([^"]+)"\)/);
  assert.ok(m, 'Address.kt has no MAGIC_DNS regex');
  // Kotlin string escapes: "\\." is a literal backslash-dot in the pattern.
  return new RegExp(m[1].replace(/\\\\/g, '\\'));
}

/** The cleartext exceptions as the app ships them. */
function appLoopback() {
  const m = address.match(/LOOPBACK = setOf\(([^)]*)\)/);
  assert.ok(m, 'Address.kt has no LOOPBACK set');
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

check('a certificate is not enough on its own — the name has to be a tailnet name', () => {
  const name = appNamePattern();
  assert.ok(name.test('mac.tailnet.ts.net'), 'the MagicDNS name would be refused');
  assert.ok(name.test('adams-macbook-pro-m4.tail1234.ts.net'));
  for (const host of ['example.com', 'ts.net', 'evilts.net', 'ts.net.example.com']) {
    assert.equal(name.test(host), false, `${host} would be accepted as a tailnet name`);
  }
});

check('and https alone is no longer the whole check', () => {
  // The shape that used to be here: `if (url.scheme == "https") return true`.
  assert.doesNotMatch(
    address + pair,
    /scheme == "https"\)\s*return true/,
    'https to anywhere is accepted again'
  );
  // The https branch has to consult the name pattern, not just the scheme.
  assert.match(
    address,
    /scheme == "https"\)[\s\S]{0,120}?MAGIC_DNS/,
    'the https branch does not check the host name'
  );
});

check('the app accepts exactly the names the Mac can hand out', () => {
  // magicDnsName() refuses to report anything this does not match, so a narrower
  // pattern on the phone means a tailnet that can never pair, and a wider one means
  // the phone trusts a name the Mac would not have used.
  const daemon = tls.match(/return (\/\^\[a-z0-9\.-\]\+\\\.ts\\\.net\$\/i)\.test\(name\)/);
  assert.ok(daemon, 'lib/tls.js no longer validates the MagicDNS name the way this test expects');
  assert.equal(
    appNamePattern().source.toLowerCase(),
    '^[a-z0-9.-]+\\.ts\\.net$',
    'Address.kt and magicDnsName() disagree about what a MagicDNS name looks like'
  );
});

/* ------------------------------------------------ what the platform enforces */

check('cleartext is off by default', () => {
  assert.match(
    netconf,
    /<base-config\s+cleartextTrafficPermitted="false"\s*\/>/,
    'the base config still permits cleartext everywhere'
  );
});

check('and its exceptions are the same three hosts the code allows', () => {
  const permitted = [...netconf.matchAll(/<domain[^>]*>([^<]+)<\/domain>/g)].map((m) => m[1].trim());
  assert.deepEqual(
    [...permitted].sort(),
    [...appLoopback()].sort(),
    'Address.LOOPBACK and network_security_config.xml name different hosts'
  );
  assert.ok(permitted.includes('10.0.2.2'), 'an emulator can no longer reach the host Mac');
});

check('nothing permits cleartext to the tailnet address any more', () => {
  assert.doesNotMatch(netconf, /100\.\d/, 'a 100.x host is named in the network security config');
  // The CGNAT arithmetic survives in Address.kt, but only to explain the refusal.
  assert.match(
    address,
    /NO_CERTIFICATE/,
    'a cleartext tailnet address gets no answer of its own'
  );
  assert.match(pair, /Reach\.NO_CERTIFICATE -> getString\(R\.string\.pair_no_certificate/);
});

/* ------------------------------------------------------- when it is asked */

check('the address is judged before the token is sent, not after', () => {
  const body = pair.match(/private fun verifyAndSave\([\s\S]*?\n    \}/);
  assert.ok(body, 'verifyAndSave has moved');
  const checked = body[0].indexOf('Address.reach(baseUrl)');
  const sent = body[0].indexOf('Api.verify');
  assert.ok(checked !== -1, 'verifyAndSave no longer consults Address');
  assert.ok(sent !== -1 && checked < sent, 'the token is sent before the address is judged');
});

check('typing a bare hostname by hand means https, not a cleartext refusal', () => {
  assert.match(
    pair,
    /if \(address\.startsWith\("http"\)\) address else "https:\/\/\$address"/,
    'manual entry still assumes http'
  );
});

/* ------------------------------------- a phone that was paired before all this */

check('a pairing on the old URL is kept, not silently thrown away', () => {
  assert.match(prefs, /fun needsRepair\(ctx: Context\) = isPaired\(ctx\) && !Address\.isPairable/);
  assert.doesNotMatch(
    prefs.match(/fun needsRepair[\s\S]*?\n\n/)[0],
    /unpair|clear\(\)/,
    'needsRepair destroys the pairing it is describing'
  );
});

check('and everything that talks to the server waits for a live one', () => {
  for (const file of ['MainActivity.kt', 'WatchService.kt', 'ShareActivity.kt']) {
    const src = read(`${KOTLIN}/${file}`);
    assert.match(src, /Prefs\.isLive\(/, `${file} does not gate on Prefs.isLive`);
    assert.doesNotMatch(src, /Prefs\.isPaired\(/, `${file} still gates on the weaker Prefs.isPaired`);
  }
});

check('the QR screen says which address it is refusing, and why', () => {
  const strings = read('android/app/src/main/res/values/strings.xml');
  for (const id of ['pair_not_private', 'pair_no_certificate', 'pair_stale']) {
    assert.match(strings, new RegExp(`name="${id}"`), `no ${id} string`);
  }
  assert.match(pair, /EXTRA_STALE/, 'PairActivity cannot be told why it was opened');
  assert.match(read(`${KOTLIN}/MainActivity.kt`), /PairActivity\.EXTRA_STALE/, 'and nothing tells it');
});

console.log(`\n${ran - failures}/${ran} checks passed\n`);
process.exit(failures ? 1 : 0);
