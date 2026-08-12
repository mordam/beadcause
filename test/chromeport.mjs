#!/usr/bin/env node
/**
 * No browser check may guess Chrome's debugging port again.
 *
 *     npm test
 *     node test/chromeport.mjs
 *
 * Every `scripts/*-check.mjs` used to open Chrome on `<base> + process.pid % 100` — a
 * hundred addresses shared by eight concurrent agent sessions and by `npm run checks`,
 * which runs four at a time on its own. The loser of a collision does not error. Chrome
 * handed a port already in use just never publishes a target, so the loser's
 * `fetch('/json/list')` is answered by the *winner's* browser and the check proceeds to
 * drive a page belonging to another session's daemon. Its DOM assertions all fail; its
 * on-disk assertions all pass; and the whole thing reads as "my change broke the page".
 * That cost three consecutive false failures on an innocent five-line diff (bc-ev11).
 *
 * `scripts/helpers/chrome.mjs` fixed it by asking for port zero and reading back what
 * Chrome chose. **This suite exists because that fix is one line and reverting it is
 * invisible.** Nothing about a guessed port looks wrong in review, the failure it causes
 * is attributed to whatever else was in the diff, and a check copied from an old sibling
 * would reintroduce it silently. So the port is asserted statically, across the whole
 * directory, on every run — which is the only place a rule about thirty-two files can
 * live and stay true.
 *
 * It is deliberately pure Node and launches no browser: `npm test` does not have Chrome
 * as a dependency and this is not the suite to make it one. The behavioural half that
 * *can* be had without one — that a Chrome which will not start is reported as such
 * rather than waited on, and that it does not leave a profile directory behind — is
 * measured for real, by pointing the launcher at a binary that does not exist.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeArgs, launchChrome } from '../scripts/helpers/chrome.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SCRIPTS = path.join(ROOT, 'scripts');

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

console.log('\nchrome debugging port\n');

/* ------------------------------------------------------- the static rule */

/** Everything under scripts/ that could plausibly open a browser. */
const sources = [
  ...fs
    .readdirSync(SCRIPTS)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => path.join(SCRIPTS, f)),
  ...fs
    .readdirSync(path.join(SCRIPTS, 'helpers'))
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => path.join(SCRIPTS, 'helpers', f)),
];

// The helper's own header quotes the old lines as the thing it replaced, so the scan has
// to look at code rather than at comments. Stripping block and line comments is enough
// here: these are scripts, not a parser exercise.
const codeOf = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');

/**
 * What is wrong with one file's code, as a function, so the controls below can feed it
 * source that is not on disk. An audit measured only against a clean tree reports the
 * same "nothing found" whether the tree is clean or the audit is broken, and the broken
 * one is the likelier of the two to survive a refactor unnoticed — because it is green.
 */
export function offences(code) {
  const out = { pid: /process\.pid\s*%/.test(code), ports: [] };
  // A literal port on the flag is the same bug wearing a different hat — it is exactly
  // what two sessions running the same check would both ask for.
  for (const m of code.matchAll(/--remote-debugging-port=([^`'"\s]*)/g)) {
    if (m[1] !== '0' && m[1] !== '${port}') out.ports.push(m[0]);
  }
  return out;
}

const guessers = [];
const hardcoded = [];
for (const full of sources) {
  const rel = path.relative(ROOT, full);
  const o = offences(codeOf(fs.readFileSync(full, 'utf8')));
  if (o.pid) guessers.push(rel);
  for (const p of o.ports) hardcoded.push(`${rel} → ${p}`);
}

if (!guessers.length) ok('no script derives a port from its own pid');
else bad('no script derives a port from its own pid', guessers.join(', '));

if (!hardcoded.length) ok('every --remote-debugging-port is zero');
else bad('every --remote-debugging-port is zero', hardcoded.join('; '));

const args = chromeArgs('/tmp/whatever');
if (args.includes('--remote-debugging-port=0')) ok('the shared launcher asks for port zero');
else bad('the shared launcher asks for port zero', args.join(' '));

/* -------------------------------------------------------------- the controls */

// The exact line every check carried before bc-ev11, and the exact line it carries now.
const OLD = "  const port = 9700 + Math.floor(process.pid % 100);\n  spawn(CHROME, ['--remote-debugging-port=' + port]);";
const OLD_LITERAL = "spawn(CHROME, ['--remote-debugging-port=9222']);";
const NEW = "const { s, close } = await launchChrome('beadcause-x-');";

if (offences(OLD).pid) ok('control: the old pid arithmetic is caught');
else bad('control: the old pid arithmetic is caught', 'the scan reports a clean file, so it cannot fire at all');

if (offences(OLD_LITERAL).ports.length) ok('control: a hardcoded port on the flag is caught');
else bad('control: a hardcoded port on the flag is caught', 'the scan reports a clean file');

if (!offences(NEW).pid && !offences(NEW).ports.length) ok('control: the fixed shape is not caught');
else bad('control: the fixed shape is not caught', 'the scan fires on correct code, so a green run means nothing');

// And the comment-stripping, because the helper's own header quotes the old lines and
// would otherwise fail the repo for documenting what it fixed.
if (!offences(codeOf(`/* was: ${OLD} */\n${NEW}`)).pid) ok('control: the old line quoted in a comment does not count');
else bad('control: the old line quoted in a comment does not count', 'prose about the bug reads as the bug');

/* --------------------------------------------- and every check goes through it */

// The rule above is only worth anything while the checks actually use the helper: a
// check that grew its own launcher back would satisfy both scans by accident, because
// port zero read from DevToolsActivePort is what it would have to copy anyway. This is
// the cheaper statement of the same thing — one launcher, one place to get it wrong.
const rogue = [];
for (const full of sources) {
  const rel = path.relative(ROOT, full);
  if (rel.includes('helpers/')) continue;
  const code = codeOf(fs.readFileSync(full, 'utf8'));
  if (!/--headless/.test(code)) continue;
  if (!/launchChrome/.test(code)) rogue.push(rel);
}
if (!rogue.length) ok('every script that opens Chrome goes through the shared launcher');
else bad('every script that opens Chrome goes through the shared launcher', rogue.join(', '));

/* --------------------------------------------------------- and it fails loudly */

// A Chrome that cannot start used to be indistinguishable from a Chrome that was slow:
// sixty polls, then `Chrome never exposed a page target`. Both halves are measured —
// that it says what actually happened, and that it took its temp directory with it.
const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('beadcause-porttest-'));
let thrown = null;
try {
  await launchChrome('beadcause-porttest-', { chrome: path.join(os.tmpdir(), 'no-such-chrome-binary'), timeoutMs: 3000 });
} catch (e) {
  thrown = e;
}
if (thrown && /would not start/.test(thrown.message)) ok('a Chrome that will not start is reported as that');
else bad('a Chrome that will not start is reported as that', thrown ? thrown.message : 'it did not throw at all');

const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('beadcause-porttest-'));
if (after.length <= before.length) ok('a failed launch leaves no profile directory behind');
else bad('a failed launch leaves no profile directory behind', after.filter((f) => !before.includes(f)).join(', '));

/* -------------------------------------------------------------------- verdict */

console.log(`\n${failures ? '\x1b[31m' : '\x1b[32m'}${ran - failures}/${ran}\x1b[0m assertions passed\n`);
process.exit(failures ? 1 : 0);
