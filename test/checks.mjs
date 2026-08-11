#!/usr/bin/env node
/**
 * The browser checks, held to account by something that is not a person remembering.
 *
 *     npm test
 *     node test/checks.mjs
 *
 * `scripts/*-check.mjs` covers layout, taps and the phone — the only cover any of that
 * has — and none of it is in `npm test`, because each one wants a Chrome and ten to
 * forty seconds. `npm run checks` runs them for real. This suite is what runs in the
 * four minutes nobody has, and it is aimed at exactly one failure:
 *
 * **A check does not rot by failing. It rots by pressing something that is not there.**
 * Working bc-xqnj the inbox's `[data-space]` chips were removed. `shade-check.mjs`
 * pressed those chips, so it broke outright, and two assertions in `launcher-check.mjs`
 * went with it — and `npm test` was green through all of it. They were found by reading
 * the scripts, which is not a mechanism. Nothing bounds how long that gap can be, and a
 * check that has silently not passed for a month is worse than no check at all: the next
 * person to run it reads its failures as their own change breaking something.
 *
 * So the load-bearing assertion here is the selector audit — every static selector every
 * check presses, looked up in `public/`. It is a text search, it costs milliseconds, and
 * it fires on precisely the thing that used to be invisible.
 *
 * ## Why the controls are half this file
 *
 * "the audit found nothing" is the same output whether the tree is clean or the audit is
 * broken, and an audit that can never fire is the more likely of the two to survive a
 * refactor unnoticed — it is green. So it is measured in both directions against
 * synthetic trees: a token removed from `public/` must be found, a token that lives only
 * in a check's own fixture must not be, and a token named only in a comment must not
 * vouch for itself. Without those, the clean run above proves nothing.
 *
 * The rest is inventory: every check on disk is in the list `npm run checks` runs, every
 * check still parses, and every relative import in one still resolves — the three ways a
 * check can be dead on arrival before Chrome is even reached.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { audit, auditSource, discover, selectorsIn, tokensOf } from '../lib/checkaudit.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const RUNNER = path.join(ROOT, 'scripts', 'checks.mjs');

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-checks-'));

/* ------------------------------------------------------------------ there is a command */

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

if (pkg.scripts.checks === 'node scripts/checks.mjs') ok('npm run checks exists and delegates to the runner');
else bad('npm run checks exists and delegates to the runner', `scripts.checks is ${JSON.stringify(pkg.scripts.checks)}`);

/**
 * The counterpart property to `scripts/test.mjs`: the command names no check, so adding
 * one is adding a file and conflicts with nobody.
 */
const named = (pkg.scripts.checks || '').match(/[\w-]+-check\.mjs/g) || [];
if (!named.length) ok('the command names no individual check — adding one edits no shared line');
else bad('the command names no individual check', `it names ${named.join(', ')}`);

/* ---------------------------------------------------------------- the list is the directory */

const onDisk = fs
  .readdirSync(path.join(ROOT, 'scripts'))
  .filter((f) => f.endsWith('-check.mjs'))
  .sort()
  .map((f) => `scripts/${f}`);

const discovered = discover(ROOT);
if (JSON.stringify(discovered) === JSON.stringify(onDisk)) ok(`every scripts/*-check.mjs is discovered (${onDisk.length})`);
else bad('every scripts/*-check.mjs is discovered', `on disk ${onDisk.length}, discovered ${discovered.length}`);

const listed = spawnSync(process.execPath, [RUNNER, '--list'], { encoding: 'utf8' });
const list = listed.stdout.trim().split('\n').filter(Boolean);
if (listed.status === 0 && JSON.stringify(list) === JSON.stringify(onDisk)) {
  ok('--list prints exactly what is on disk — nothing silently dropped');
} else {
  const missing = onDisk.filter((f) => !list.includes(f));
  bad('--list prints exactly what is on disk', missing.length ? `not listed: ${missing.join(', ')}` : `exit ${listed.status}`);
}

const only = spawnSync(process.execPath, [RUNNER, '--list', '--only', 'tabbar'], { encoding: 'utf8' });
if (only.stdout.trim() === 'scripts/tabbar-check.mjs') ok('--only narrows the run to one check');
else bad('--only narrows the run to one check', JSON.stringify(only.stdout.trim()));

/* ------------------------------------------------------- dead on arrival, three ways */

const unparseable = [];
const unresolved = [];
for (const rel of discovered) {
  const full = path.join(ROOT, rel);
  const parsed = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8' });
  if (parsed.status !== 0) unparseable.push(`${rel}: ${(parsed.stderr || '').trim().split('\n')[0]}`);
  const src = fs.readFileSync(full, 'utf8');
  for (const m of src.matchAll(/^import[^'"]*['"](\.[^'"]+)['"]/gm)) {
    if (!fs.existsSync(path.resolve(path.dirname(full), m[1]))) unresolved.push(`${rel} → ${m[1]}`);
  }
}

if (!unparseable.length) ok(`every check parses (${discovered.length})`);
else bad('every check parses', unparseable.join('; '));

if (!unresolved.length) ok('every relative import in a check resolves');
else bad('every relative import in a check resolves', unresolved.join('; '));

/* ----------------------------------------------------------------- the selector audit */

const { tokens, findings } = audit(ROOT);

if (!findings.length) {
  ok(`every selector the checks press is still in public/ (${tokens})`);
} else {
  bad(
    'every selector the checks press is still in public/',
    findings.map((f) => `${f.check}:${f.line} presses ${f.token} — nothing in public/ has it`).join('; '),
  );
}

/**
 * A guard on the guard. If the audit ever stops finding selectors — a regex that no
 * longer matches, a `public/` that moved — it goes green and stays green, and the number
 * above is the only thing that would have said so.
 */
if (tokens > 100) ok(`the audit is actually reading the checks — ${tokens} selectors, not zero`);
else bad('the audit is actually reading the checks', `only ${tokens} selectors found; it has stopped seeing them`);

/* ------------------------------------------------------------------------- the controls */

/**
 * The audit fires when a selector leaves. Synthetic rather than this repo's own sources,
 * so it measures the audit and not today's `public/`.
 */
const removed = auditSource('scripts/x-check.mjs', `document.querySelector('.gone-away').click();\n`, 'nothing here mentions it');
if (removed.findings.length === 1 && removed.findings[0].token === '.gone-away') ok('the control: a selector missing from public/ IS found');
else bad('the control: a selector missing from public/ IS found', `${removed.findings.length} findings — the audit cannot fire`);

const kept = auditSource('scripts/x-check.mjs', `document.querySelector('.still-here').click();\n`, '<div class="still-here">');
if (!kept.findings.length) ok('a selector still in public/ is not reported');
else bad('a selector still in public/ is not reported', 'false alarm');

/**
 * A check that serves its own fixture markup owns those classes; reporting them would be
 * noise, and an audit with noise in it is an audit people learn to ignore.
 */
const ownFixture = auditSource(
  'scripts/x-check.mjs',
  `const html = '<div class="fixture-only">hi</div>';\ndocument.querySelector('.fixture-only');\n`,
  'public has never heard of it',
);
if (!ownFixture.findings.length) ok("a class from the check's own fixture is not a finding");
else bad("a class from the check's own fixture is not a finding", 'false alarm on self-served markup');

/**
 * But a comment is not markup. This is the tuning that stops a header paragraph naming
 * `.shade-ask` from being what keeps the audit quiet about `.shade-ask` having left.
 */
const inComment = auditSource(
  'scripts/x-check.mjs',
  `// the pane is .prose-only and matters\n/* .prose-only again */\ndocument.querySelector('.prose-only');\n`,
  'public has never heard of it',
);
if (inComment.findings.length === 1) ok('a token named only in a comment does not vouch for itself');
else bad('a token named only in a comment does not vouch for itself', 'prose is being read as evidence');

/** An interpolated selector has no text to look for, and must not be guessed at. */
const interpolated = auditSource('scripts/x-check.mjs', 'document.querySelector(`.card[data-key="${k}"]`);\n', '');
if (!interpolated.findings.length) ok('an interpolated selector is skipped rather than guessed at');
else bad('an interpolated selector is skipped rather than guessed at', interpolated.findings.map((f) => f.token).join(', '));

/** A tag name is not evidence of anything — every page has an `li`. */
if (!selectorsIn(`document.querySelectorAll('li');\n`).length) ok('a bare tag name is not audited');
else bad('a bare tag name is not audited', 'li would be looked up in public/');

/** Compound selectors come apart, because their parts are removed one at a time. */
const parts = tokensOf('.card.open [data-role="answer"]').map((t) => t.token).sort();
if (JSON.stringify(parts) === JSON.stringify(['.card', '.open', '[data-role="answer"]', '[data-role]'])) {
  ok('a compound selector is audited part by part');
} else {
  bad('a compound selector is audited part by part', parts.join(' '));
}

/* --------------------------------------------------- end to end, on a tree of its own */

/**
 * `audit(root)` rather than `auditSource`, so discovery, the `public/` walk and the
 * vendor exclusion are all in the path — the wiring the assertions above step over.
 */
const tree = path.join(tmp, 'repo');
fs.mkdirSync(path.join(tree, 'scripts'), { recursive: true });
fs.mkdirSync(path.join(tree, 'public', 'vendor'), { recursive: true });
fs.writeFileSync(path.join(tree, 'public', 'app.js'), `el.className = 'lives-here';\n`);
fs.writeFileSync(path.join(tree, 'public', 'vendor', 'big.js'), `// vendored: lives-in-vendor\n`);
fs.writeFileSync(
  path.join(tree, 'scripts', 'demo-check.mjs'),
  `document.querySelector('.lives-here');\ndocument.querySelector('.lives-in-vendor');\n`,
);

const endToEnd = audit(tree);
if (endToEnd.checks.length === 1 && endToEnd.findings.length === 1 && endToEnd.findings[0].token === '.lives-in-vendor') {
  ok('end to end: public/ is searched, vendor/ is not, and the odd one out is named');
} else {
  bad(
    'end to end: public/ is searched, vendor/ is not, and the odd one out is named',
    `${endToEnd.checks.length} checks, findings: ${endToEnd.findings.map((f) => f.token).join(', ') || 'none'}`,
  );
}

/** And the runner exits non-zero on it, rather than reporting and carrying on. */
const auditRun = spawnSync(process.execPath, [RUNNER, '--audit'], { encoding: 'utf8', cwd: ROOT });
if (auditRun.status === 0) ok('--audit on this repo exits 0');
else bad('--audit on this repo exits 0', auditRun.stdout.trim());

/* -------------------------------------------------------- how the runner ends a run */

/**
 * A tree of checks that pass, fail and hang on purpose. Running the real twenty-six to
 * find out what the runner does with a failure would take four minutes and a Chrome,
 * and would depend on this repo's own checks — which are the thing under observation,
 * not the instrument.
 *
 * The hang is the one that matters. Twenty-five checks were running fine on the day
 * `agent-chooser-check.mjs` stopped answering four minutes in; without a timeout the
 * run never ends, and a run that never ends reports nothing about any of them. That is
 * strictly worse than the by-hand state this replaced, because at least a person gives up.
 */
const bench = path.join(tmp, 'bench');
fs.mkdirSync(path.join(bench, 'scripts'), { recursive: true });
fs.mkdirSync(path.join(bench, 'public'), { recursive: true });
fs.writeFileSync(path.join(bench, 'public', 'app.js'), '// no selectors here\n');
fs.writeFileSync(path.join(bench, 'scripts', 'green-check.mjs'), `console.log('fine');\n`);
fs.writeFileSync(path.join(bench, 'scripts', 'red-check.mjs'), `console.log('a reason');\nprocess.exit(2);\n`);
fs.writeFileSync(path.join(bench, 'scripts', 'stuck-check.mjs'), `console.log('going quiet');\nsetInterval(() => {}, 1000);\n`);

const benched = spawnSync(process.execPath, [RUNNER, '--dir', bench, '--jobs', '3', '--timeout', '3', '--no-retry'], {
  encoding: 'utf8',
  timeout: 60_000,
});
const said = `${benched.stdout}${benched.stderr}`;

if (benched.status === 1) ok('a run with failures in it exits 1');
else bad('a run with failures in it exits 1', `exit ${benched.status}`);

if (/stuck-check/.test(said) && /timed out after 3s/.test(said)) ok('a check that hangs is killed and reported, not waited on forever');
else bad('a check that hangs is killed and reported, not waited on forever', said.trim().split('\n').slice(-4).join(' / '));

if (/2 of 3 checks failed/.test(said)) ok('the summary counts the failures');
else bad('the summary counts the failures', said.trim().split('\n').slice(-6).join(' / '));

for (const named of ['scripts/red-check.mjs', 'scripts/stuck-check.mjs']) {
  if (said.includes(named)) ok(`the summary names ${named}`);
  else bad(`the summary names ${named}`, 'a failure that is not named is a failure nobody will look at');
}

if (/a reason/.test(said)) ok("a failing check's own output is replayed, not just its exit code");
else bad("a failing check's own output is replayed, not just its exit code", 'the output was swallowed');

if (!/green-check\.mjs\s*$/m.test(said.split('checks failed')[1] || '')) ok('a check that passed is not in the failure list');
else bad('a check that passed is not in the failure list', 'green-check was reported as failing');

const allGreen = path.join(tmp, 'allgreen');
fs.mkdirSync(path.join(allGreen, 'scripts'), { recursive: true });
fs.mkdirSync(path.join(allGreen, 'public'), { recursive: true });
fs.writeFileSync(path.join(allGreen, 'scripts', 'green-check.mjs'), `console.log('fine');\n`);
const greenRun = spawnSync(process.execPath, [RUNNER, '--dir', allGreen], { encoding: 'utf8', timeout: 60_000 });
if (greenRun.status === 0 && /all 1 checks passed/.test(greenRun.stdout)) ok('a tree where everything passes exits 0');
else bad('a tree where everything passes exits 0', `exit ${greenRun.status}`);

/* ------------------------------------------------------ the retry, both directions */

/**
 * A check that fails once and passes on the second run — which is what a timing-sensitive
 * check under four Chromes looks like. It must end up green *and* be called out, because
 * a retry that silently converts red to green is how a runner acquires a folklore of
 * checks that are "always a bit red".
 */
const retry = path.join(tmp, 'retry');
fs.mkdirSync(path.join(retry, 'scripts'), { recursive: true });
fs.mkdirSync(path.join(retry, 'public'), { recursive: true });
fs.writeFileSync(
  path.join(retry, 'scripts', 'once-check.mjs'),
  `import fs from 'node:fs';\n` +
    `const stamp = new URL('./once.ran', import.meta.url);\n` +
    `if (fs.existsSync(stamp)) { console.log('fine alone'); process.exit(0); }\n` +
    `fs.writeFileSync(stamp, '');\nconsole.log('too busy');\nprocess.exit(1);\n`,
);
fs.writeFileSync(path.join(retry, 'scripts', 'green-check.mjs'), `console.log('fine');\n`);

const retried = spawnSync(process.execPath, [RUNNER, '--dir', retry], { encoding: 'utf8', timeout: 60_000 });
const retriedSaid = `${retried.stdout}${retried.stderr}`;

if (retried.status === 0) ok('a check that passes on its own is not reported as a failure');
else bad('a check that passes on its own is not reported as a failure', `exit ${retried.status}`);

if (/passed only when re-run alone/.test(retriedSaid) && /once-check/.test(retriedSaid)) {
  ok('but it is named as one that only passes alone — the retry does not bury it');
} else {
  bad('but it is named as one that only passes alone', retriedSaid.trim().split('\n').slice(-4).join(' / '));
}

/** And --no-retry is the raw parallel pass, for when the retry is what is in question. */
fs.rmSync(path.join(retry, 'scripts', 'once.ran'), { force: true });
const raw = spawnSync(process.execPath, [RUNNER, '--dir', retry, '--no-retry'], { encoding: 'utf8', timeout: 60_000 });
if (raw.status === 1 && /once-check/.test(raw.stdout)) ok('--no-retry reports the first pass raw');
else bad('--no-retry reports the first pass raw', `exit ${raw.status}`);

/**
 * A check that is broken rather than shy fails twice, and the second failure is the one
 * reported — with the retry said out loud, so a red line cannot be waved away as the
 * scheduler's fault.
 */
const stubborn = spawnSync(process.execPath, [RUNNER, '--dir', bench, '--timeout', '3'], { encoding: 'utf8', timeout: 120_000 });
const stubbornSaid = `${stubborn.stdout}${stubborn.stderr}`;
if (stubborn.status === 1 && /on its own — not a scheduling accident/.test(stubbornSaid)) {
  ok('a check that fails twice is still a failure, and says the retry happened');
} else {
  bad('a check that fails twice is still a failure, and says the retry happened', `exit ${stubborn.status}`);
}

/** And a run where nothing failed says nothing about retries at all. */
if (!/re-running/.test(greenRun.stdout) && !/passed only when re-run alone/.test(greenRun.stdout)) {
  ok('a clean run says nothing about retries');
} else {
  bad('a clean run says nothing about retries', 'it re-ran something that had not failed');
}

/** Vacuous green is the failure mode of every discovering runner. */
const barren = path.join(tmp, 'barren');
fs.mkdirSync(path.join(barren, 'scripts'), { recursive: true });
const barrenRun = spawnSync(process.execPath, [RUNNER, '--dir', barren], { encoding: 'utf8', timeout: 60_000 });
if (barrenRun.status !== 0) ok('a tree with no checks at all fails rather than passing vacuously');
else bad('a tree with no checks at all fails rather than passing vacuously', 'exit 0 on nothing');

fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
