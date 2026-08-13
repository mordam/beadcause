#!/usr/bin/env node
/**
 * The setup question that can be answered nearly, and the one that types a secret.
 *
 *     npm test
 *     node test/signinsetup.mjs
 *
 * `npm run configure` asks about Google sign-in (lib/signinsetup.js). Two things about
 * that block are worth a suite of its own, and neither is "does it ask questions".
 *
 * **The secret must not reach `config.json`.** That file is committed to the git repo
 * lib/commonrepo.js keeps, after every write — so a secret in it is not on a disk, it is
 * in a history a rotation cannot reach back into. bc-m6m took the `clientSecret` field
 * away for exactly that reason, and a setup script that asks somebody to paste one is
 * the most natural place in the codebase to put it back by accident. So the assertion
 * here is blunt and deliberately not about fields: the pasted string must not appear
 * **anywhere** in the serialised config, and it must appear in a file at 0600.
 *
 * **Three answers out of four is off, silently.** Sign-in needs a client id, a secret, a
 * non-empty allowlist and an https callback, and short of all four `googleAuth()` returns
 * null and the only symptom is one line in the log at startup — in front of the inbox
 * that would have explained it. bc-dcom is that failure: the hand-edit this block
 * replaces gets one of the three wrong and nothing says so. So every partial answer is
 * driven here, and each is asserted to come back naming *which* piece is missing.
 *
 * The prompts are scripted rather than typed: `askSignin` takes its `ask`/`yes`/`secret`
 * from the caller, so a test can hand it a queue of answers and read back both what it
 * wrote and every line it printed. That is the whole reason the block lives in lib/
 * instead of inline in scripts/configure.js, where nothing could reach it without a pty.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-signin-'));
// Before lib/config.js is imported: CONFIG_DIR resolves once, at module load, and both
// the secret file and the certificate are looked for underneath it.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });
// The env var would mask the file in `clientSecret()`, which is precisely the thing
// several of these assertions are about.
delete process.env.BEADCAUSE_GOOGLE_CLIENT_SECRET;

const CONFIG_DIR = process.env.BEADCAUSE_CONFIG_DIR;
const { askSignin, parseAllowed } = await import(LIB('signinsetup.js'));
const { clientSecretFile, signinStatus } = await import(LIB('auth.js'));

let failures = 0;
let ran = 0;
const ok = (name) => {
  ran += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
};
const bad = (name, detail) => {
  ran += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const is = (name, got, want) =>
  got === want ? ok(name) : bad(name, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const has = (name, haystack, needle) =>
  haystack.includes(needle) ? ok(name) : bad(name, `no ${JSON.stringify(needle)} in:\n      ${haystack.replace(/\n/g, '\n      ')}`);

/* ------------------------------------------------------------------- a terminal */

/**
 * Somebody at the keyboard, replaced by a list.
 *
 * Answers are taken in order, and an empty string means they pressed Enter — which is
 * why `ask` applies the default the same way scripts/configure.js does. Running out of
 * answers throws rather than blocking, so a block that grows a question and a test that
 * does not is a failure and never a hang.
 */
function keyboard(answers) {
  const queue = [...answers];
  const lines = [];
  const take = (what) => {
    if (!queue.length) throw new Error(`ran out of scripted answers at ${what}`);
    return queue.shift();
  };
  return {
    lines,
    left: () => queue.length,
    io: {
      ask: async (q, dflt) => String(take(q)).trim() || dflt,
      yes: async (q, dflt = 'n') => /^y/i.test(String(take(q)).trim() || dflt),
      secret: async (q) => String(take(q)).trim(),
      log: (line) => lines.push(String(line)),
    },
  };
}

/** A configuration with nothing about sign-in in it, the way a fresh install arrives. */
const fresh = () => ({
  port: 4318,
  // No certificate for this name, so the redirect URI cannot be derived — the state a
  // machine is in before `tailscale cert` has ever run. Set explicitly rather than left
  // to `magicDnsName()`, which would shell out to `tailscale` from a test.
  tls: { enabled: true, name: 'no-cert.tailnet-test.ts.net' },
  auth: { google: { enabled: true, clientId: null, clientSecretFile: null, allowed: [], redirectUri: null, sessionDays: 30 } },
});

const SECRET = 'GOCSPX-not-a-real-secret';
const SECRET_FILE = clientSecretFile({});
const forget = () => fs.rmSync(SECRET_FILE, { force: true });

console.log('\nnpm run configure — the sign-in block');

/* ------------------------------------------------------------------ answering n */

{
  forget();
  const cfg = fresh();
  const kb = keyboard(['n']);
  const out = await askSignin(cfg, kb.io);
  is('declining asks nothing else', kb.left(), 0);
  is('declining leaves sign-in off', out.on, false);
  is('declining changes nothing', out.changed, false);
  is('declining writes no config', cfg.auth.google.clientId, null);
  is('declining writes no secret file', fs.existsSync(SECRET_FILE), false);
  has('the current state is shown before the question', kb.lines.join('\n'), 'currently: off');
}

/* ------------------------------------------------------- the whole thing, at once */

{
  forget();
  const cfg = fresh();
  // redirect URI, client id, secret, allowlist — in the order they are asked.
  const kb = keyboard([
    'y',
    'https://mac.tailnet-test.ts.net:4318/auth/google/callback',
    'cid.apps.googleusercontent.com',
    SECRET,
    'You@Example.com, other@example.com',
  ]);
  const out = await askSignin(cfg, kb.io);

  is('every answer was used', kb.left(), 0);
  is('sign-in comes out on', out.on, true);
  is('the client id is in the config', cfg.auth.google.clientId, 'cid.apps.googleusercontent.com');
  is('the explicit redirect URI is kept', cfg.auth.google.redirectUri, 'https://mac.tailnet-test.ts.net:4318/auth/google/callback');
  is('addresses are lowercased', cfg.auth.google.allowed.join(','), 'you@example.com,other@example.com');
  is('the block turns enabled back on', cfg.auth.google.enabled, true);

  // The assertion this file exists for. Not "the clientSecret field is absent" — the
  // whole serialised config, because a secret that reached any other field would be in
  // the same committed history and pass a field-shaped check.
  is('the secret is NOWHERE in the config', JSON.stringify(cfg).includes(SECRET), false);
  is('the secret is in the file', fs.readFileSync(SECRET_FILE, 'utf8').trim(), SECRET);
  is('the file is 0600', (fs.statSync(SECRET_FILE).mode & 0o777).toString(8), '600');
  // The default path, whose `.key` name is what the config repo both ignores and refuses.
  is('the file is the .key one', path.basename(SECRET_FILE), 'google-client-secret.key');
  is('and it agrees it is on', signinStatus(cfg).on, true);
  has('it says so', kb.lines.join('\n'), 'sign-in is on for you@example.com, other@example.com');
}

/* ------------------------------------------------------ cancelled means cancelled */

{
  // scripts/configure.js promises that Ctrl+C anywhere leaves everything as it was, and
  // the secret is the one answer that goes somewhere other than the config object — so
  // it is the one place that promise could quietly stop being true. Running out of
  // scripted answers stands in for the interrupt: the block gets as far as the allowlist
  // question, with the secret already typed, and then never finishes.
  forget();
  const cfg = fresh();
  const kb = keyboard(['y', 'https://mac.tailnet-test.ts.net:4318/auth/google/callback', 'cid.apps.googleusercontent.com', SECRET]);
  let threw = false;
  try {
    await askSignin(cfg, kb.io);
  } catch {
    threw = true;
  }
  is('the block did not finish', threw, true);
  is('and the typed secret never reached the disk', fs.existsSync(SECRET_FILE), false);
}

/* ------------------------------------------------- three out of four, named aloud */

// Each of these leaves out exactly one piece and asserts the missing piece is the one
// named. That the daemon would be off is `googleAuth`'s business and test/auth.mjs's;
// what is being tested here is that a person is told, at the moment they can fix it.

{
  forget();
  const cfg = fresh();
  const kb = keyboard(['y', 'https://mac.tailnet-test.ts.net:4318/auth/google/callback', 'cid.apps.googleusercontent.com', '', 'you@example.com']);
  const out = await askSignin(cfg, kb.io);
  is('no secret → not on', out.on, false);
  has('and the secret is what it names', out.text, 'no client secret');
  has('naming the file to put it in', out.text, SECRET_FILE);
  has('out loud, not only in the return value', kb.lines.join('\n'), 'no client secret');
}

{
  forget();
  const cfg = fresh();
  const kb = keyboard(['y', 'https://mac.tailnet-test.ts.net:4318/auth/google/callback', 'cid.apps.googleusercontent.com', SECRET, 'none, of these']);
  const out = await askSignin(cfg, kb.io);
  is('an allowlist of junk → not on', out.on, false);
  has('and the allowlist is what it names', out.text, 'allowlist is empty');
  has('with the junk called out', kb.lines.join('\n'), 'ignoring "none"');
}

{
  forget();
  const cfg = fresh();
  // Enter through the redirect URI on a machine with no certificate: nothing to derive,
  // nothing typed, so there is no https callback and Google would refuse the plain-http
  // one. The failure mode the block warns about *before* asking.
  const kb = keyboard(['y', '', 'cid.apps.googleusercontent.com', SECRET, 'you@example.com']);
  const out = await askSignin(cfg, kb.io);
  is('no certificate and no URI → not on', out.on, false);
  has('and HTTPS is what it names', out.text, 'no HTTPS certificate yet');
  has('which was said before the question, too', kb.lines.join('\n'), 'no tailnet certificate yet');
  is('nothing was pinned as the redirect URI', cfg.auth.google.redirectUri, null);
}

{
  forget();
  const cfg = fresh();
  const kb = keyboard(['y', 'https://mac.tailnet-test.ts.net:4318/auth/google/callback', '', SECRET, 'you@example.com']);
  const out = await askSignin(cfg, kb.io);
  is('no client id → not on', out.on, false);
  has('and the client id is what it names', out.text, 'no clientId');
}

/* ------------------------------------------------ a certificate, and what it means */

// With a real certificate the callback is derived rather than asked for, and typing the
// derived one straight back must NOT pin it: `redirectUri` follows the certificate's
// name on purpose, and a copy of today's answer frozen into the config is a sign-in that
// breaks the day the machine is renamed.
{
  forget();
  const NAME = 'mac.tailnet-test.ts.net';
  const tlsDir = path.join(CONFIG_DIR, 'tls');
  fs.mkdirSync(tlsDir, { recursive: true });
  let madeCert = true;
  try {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tlsDir, `${NAME}.key`), '-out', path.join(tlsDir, `${NAME}.crt`), '-days', '2', '-subj', `/CN=${NAME}`],
      { stdio: ['ignore', 'ignore', 'ignore'], timeout: 60000 }
    );
  } catch {
    madeCert = false;
  }

  if (!madeCert) {
    console.log('  \x1b[33m—\x1b[0m  skipped the derived-callback assertions: no usable openssl');
  } else {
    const derived = `https://${NAME}:4318/auth/google/callback`;

    const cfg = { ...fresh(), tls: { enabled: true, name: NAME } };
    const kb = keyboard(['y', '', 'cid.apps.googleusercontent.com', SECRET, 'you@example.com']);
    const out = await askSignin(cfg, kb.io);
    has('the URI to register is printed to be copied', kb.lines.join('\n'), derived);
    is('accepting the derived URI pins nothing', cfg.auth.google.redirectUri, null);
    is('and sign-in is on anyway', out.on, true);

    // A client registered against something else — a different port, a proxy — is the
    // only reason to store one, and then it must survive.
    const other = { ...fresh(), tls: { enabled: true, name: NAME } };
    const kb2 = keyboard(['y', 'https://elsewhere.example/auth/google/callback', 'cid.apps.googleusercontent.com', SECRET, 'you@example.com']);
    await askSignin(other, kb2.io);
    is('a different URI is kept', other.auth.google.redirectUri, 'https://elsewhere.example/auth/google/callback');
  }
  fs.rmSync(path.join(CONFIG_DIR, 'tls'), { recursive: true, force: true });
}

/* --------------------------------------------------------- keeping and turning off */

{
  // A second run over a working install: Enter through every answer, and in particular
  // an empty secret. Blank there means "keep it", not "wipe it" — the alternative is a
  // configure run that signs everybody out for touching an unrelated question.
  forget();
  const cfg = fresh();
  const kb = keyboard(['y', 'https://mac.tailnet-test.ts.net:4318/auth/google/callback', 'cid.apps.googleusercontent.com', SECRET, 'you@example.com']);
  await askSignin(cfg, kb.io);

  const again = keyboard(['y', '', '', '', '']);
  const out = await askSignin(cfg, again.io);
  is('Enter through it all keeps sign-in on', out.on, true);
  is('the secret file is untouched', fs.readFileSync(SECRET_FILE, 'utf8').trim(), SECRET);
  is('the client id is untouched', cfg.auth.google.clientId, 'cid.apps.googleusercontent.com');
  is('the allowlist is untouched', cfg.auth.google.allowed.join(','), 'you@example.com');
  has('and it offers to keep the secret rather than asking for it again', again.lines.join('\n'), 'One is already there');

  // "none" is the way out, and it is the same word the workspace and advocate questions
  // use. It must not delete the secret file: that is not this script's to throw away.
  const off = keyboard(['y', '', 'none']);
  const gone = await askSignin(cfg, off.io);
  is('"none" turns sign-in off', gone.on, false);
  is('and says off rather than half-configured', gone.text, 'off');
  is('the client id is cleared', cfg.auth.google.clientId, null);
  // Without this the leftover secret file reads as "wants sign-in", and every summary
  // afterwards would report a deliberate off as a misconfiguration.
  is('and it is switched off, not merely emptied', cfg.auth.google.enabled, false);
  is('a summary after that says off', signinStatus(cfg).text, 'off');
  is('the allowlist is kept for next time', cfg.auth.google.allowed.join(','), 'you@example.com');
  is('the secret file is left where it is', fs.readFileSync(SECRET_FILE, 'utf8').trim(), SECRET);
  has('and says so', off.lines.join('\n'), SECRET_FILE);

  // And turning it back on is one run of the same question, with the switch flipped back.
  const back = keyboard(['y', 'https://mac.tailnet-test.ts.net:4318/auth/google/callback', 'cid.apps.googleusercontent.com', '', '']);
  is('answering it again turns sign-in back on', (await askSignin(cfg, back.io)).on, true);
  is('enabled comes back with it', cfg.auth.google.enabled, true);
}

/* ------------------------------------------------------------------- the parsing */

console.log('\naddresses');

{
  const { allowed, ignored } = parseAllowed('  A@b.com , a@b.com,  , not-an-address, c@d.org ');
  is('lowercased and de-duplicated', allowed.join(','), 'a@b.com,c@d.org');
  is('the rest is named rather than dropped in silence', ignored.join(','), 'not-an-address');
  is('an empty line is an empty list', parseAllowed('').allowed.length, 0);
  is('so is "none" — and it is reported', parseAllowed('none').ignored.join(','), 'none');
}

/* -------------------------------------------------------------------- the summary */

console.log('\nthe line in the summary');

{
  // No secret file either: one left on disk from an earlier sign-in is itself a piece of
  // the configuration, and `googleProblem` is right to say so.
  forget();
  is('nothing configured reads as off', signinStatus(fresh()).text, 'off');
  const half = fresh();
  half.auth.google.clientId = 'cid.apps.googleusercontent.com';
  has('half configured says which piece', signinStatus(half).text, 'NOT on —');
  is('and is not on', signinStatus(half).on, false);
}

await cleanupTmp(tmp);

console.log(`\n${failures ? `\x1b[31m${failures} failed\x1b[0m` : '\x1b[32mall passed\x1b[0m'} (${ran} checks)\n`);
process.exit(failures ? 1 : 0);
