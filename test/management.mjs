#!/usr/bin/env node
//
// The management system's switch — off by default, on as a recorded transition.
//
//   npm test                          (runs it alongside the other suites)
//   node test/management.mjs          (on its own)
//
// Four claims, and they are the four the bead was written around:
//
// 1. **Off costs nothing, and off is what an ordinary install is.** Every read
//    answers on a directory with no ref, no `management.json` and no git repo at all,
//    and none of them throws — the same guarantee lib/requirements.js makes for an
//    absent corpus. The strict half of that is the one worth pinning: a read must not
//    even `git init` the config directory, because an install that has never enabled
//    the layer should not acquire a store by asking whether it has one.
// 2. **Nothing runs when it is off.** `whenOn` is the door, and the loader behind it
//    is never called — which is what makes a dynamic `import()` of a compliance
//    module inside that loader safe on an install that has none of what it needs.
// 3. **On and off are recorded transitions, retrievable months later.** One commit
//    each on a chained ref, the reason in the commit message, and a fresh process
//    with nothing but the config directory can read them back.
// 4. **A disabled period is visible as a period.** `windows()` and `coverage()` are
//    the reads that make a gap a gap with a reason and an author on it, rather than
//    an absence nobody can tell from "it was never on".
//
// And one static check with a real argument behind it: this module may not read the
// config. The moment `management.enabled` in config.json can influence the answer,
// the commit chain stops being the record of what was true.
//
// Everything runs against a temp BEADCAUSE_CONFIG_DIR. Nothing here touches the real
// ~/.config/beadcause, and nothing pushes anywhere.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { cleanupTmp, removeTreeSync } from './helpers/tmp.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

/* --------------------------------------------------------------- harness */

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));
const rejects = async (name, fn, match) => {
  try {
    await fn();
    bad(name, 'it resolved, and should not have');
  } catch (err) {
    check(name, match.test(err.message), err.message);
  }
};

const store = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-management-'));
process.env.BEADCAUSE_CONFIG_DIR = store;
// `removeTreeSync` rather than a bare `rmSync`, and the exit handler rather than the
// last line: the writer here is `git init` inside the config directory, and a teardown
// that walks the same tree while git is still laying down `.git/hooks/*` gets ENOTEMPTY
// after every check has already passed. See test/helpers/tmp.mjs.
process.on('exit', () => removeTreeSync(store));

const git = (...args) => execFileSync('git', ['-C', store, ...args], { encoding: 'utf8' }).trim();

// Imported after the env is set: CONFIG_DIR resolves once, at module load.
const m = await import('../lib/management.js');

/* ------------------------------------------------- an install that has none */

console.log('an install with no management system');

const before = await m.state();
check('it is off', before.on === false, JSON.stringify(before));
check('with no transition behind it', before.seq === 0, JSON.stringify(before));
check('and nothing to say about since, by or why', before.since === null && before.by === null && before.reason === null, JSON.stringify(before));
check('isOn agrees', (await m.isOn()) === false);
check('the record is empty rather than missing', JSON.stringify(await m.record()) === JSON.stringify({ on: false, since: null, transitions: [] }));
check('history is an empty list, not a throw', JSON.stringify(await m.history()) === '[]');

const v0 = await m.verify();
check('and a record with nothing in it verifies clean', v0.ok && v0.commits === 0 && v0.transitions === 0, JSON.stringify(v0));

const w0 = await m.windows();
check(
  'the timeline is one implicit off period — never enabled, by nobody',
  w0.length === 1 && w0[0].on === false && w0[0].implicit === true && w0[0].from === null,
  JSON.stringify(w0)
);

check(
  'and NOT ONE of those reads created a git repo under the config directory',
  !fs.existsSync(path.join(store, '.git')),
  fs.readdirSync(store).join(' ')
);

/* -------------------------------------------------------------- the door */

console.log('\nthe door nothing gets through when it is off');

let calls = 0;
const loader = () => {
  calls += 1;
  return 'the compliance layer';
};
const offAnswer = await m.whenOn(loader);
check('whenOn hands back null', offAnswer === null);
check('and never called the loader — so nothing behind it was even imported', calls === 0, String(calls));
check('a caller may name its own answer instead', (await m.whenOn(loader, { fallback: {} })) !== null);
check('and that still did not call it', calls === 0, String(calls));

/* ------------------------------------------------------- turning it on */

console.log('\nturning it on');

await rejects('an enable with no reason is refused', () => m.enable({}), /needs a reason/);
await rejects('and so is a disable with no reason', () => m.disable({ reason: '   ' }), /needs a reason/);
check('the refusals wrote nothing', (await m.state()).seq === 0);

const on = await m.enable({ reason: 'SOC 2 Type II observation window opens', by: 'Adam', bead: 'bc-7r4l' });
check('enabling changes something', on.changed === true, JSON.stringify(on));
check('and the state says on', on.state.on === true && on.state.seq === 1, JSON.stringify(on.state));
check('with the reason and the person on it', on.state.reason === 'SOC 2 Type II observation window opens' && on.state.by === 'Adam', JSON.stringify(on.state));
check('and the bead that asked for it', on.state.bead === 'bc-7r4l', JSON.stringify(on.state));

const log1 = git('log', '--format=%H', m.MANAGEMENT_REF).split('\n').filter(Boolean);
check('one commit on the ref', log1.length === 1, JSON.stringify(log1));
const msg1 = git('log', '-1', '--format=%B', m.MANAGEMENT_REF);
check('whose message is what an auditor reads', /^management: on \(bc-7r4l\)/.test(msg1) && msg1.includes('SOC 2 Type II observation window opens') && msg1.includes('enabled by Adam'), JSON.stringify(msg1));

const again = await m.enable({ reason: 'no, really' });
check('enabling an install that is already on records nothing', again.changed === false, JSON.stringify(again));
check('and leaves the ref where it was — a record padded with non-events is unreadable', git('log', '--format=%H', m.MANAGEMENT_REF).split('\n').filter(Boolean).length === 1);

calls = 0;
check('now whenOn calls the loader', (await m.whenOn(loader)) === 'the compliance layer' && calls === 1, String(calls));
check('and hands the state to it', await m.whenOn((s) => s.on) === true);

/* -------------------------------------------------- and off again, visibly */

console.log('\nand off again, which is the transition an auditor reads');

// Two transitions in the same millisecond would make the derived timeline ambiguous,
// and a real one never is: nobody disables a management system 0ms after enabling it.
await new Promise((r) => setTimeout(r, 20));
const off = await m.disable({ reason: 'the gate blocked the release and we needed the release', by: 'Adam' });
check('disabling changes something', off.changed === true && off.state.on === false, JSON.stringify(off));
check('and it is transition 2', off.state.seq === 2, JSON.stringify(off.state));
check('two commits, one chain', git('log', '--format=%H', m.MANAGEMENT_REF).split('\n').filter(Boolean).length === 2);

await new Promise((r) => setTimeout(r, 20));
await m.enable({ reason: 'gate fixed, window resumes', by: 'Adam' });

const w = await m.windows();
check('the timeline is four periods', w.length === 4, JSON.stringify(w.map((x) => x.on)));
check('opening with the implicit off nobody decided', w[0].implicit === true && w[0].on === false, JSON.stringify(w[0]));
check('then on, then off, then on', w[1].on === true && w[2].on === false && w[3].on === true, JSON.stringify(w.map((x) => x.on)));
check(
  'and the disabled period is a period, with the reason given at the time',
  w[2].from && w[2].to && w[2].reason === 'the gate blocked the release and we needed the release' && w[2].by === 'Adam',
  JSON.stringify(w[2])
);
check('only the current period is open-ended', w[3].to === null && w[1].to !== null, JSON.stringify(w.map((x) => x.to)));

const rec = await m.record();
const t = rec.transitions;
const spanFrom = new Date(Date.parse(t[0].at) - 1000).toISOString();
const cov = await m.coverage({ from: spanFrom });
check('a window spanning the outage is not covered', cov.complete === false, JSON.stringify(cov));
check(
  'and the gaps name themselves — the one before it was ever on, and the one somebody decided',
  cov.gaps.length === 2 && cov.gaps[0].implicit === true && cov.gaps[1].reason === 'the gate blocked the release and we needed the release',
  JSON.stringify(cov.gaps)
);
check('with the disabled gap bounded by the two transitions', cov.gaps[1].from === t[1].at && cov.gaps[1].to === t[2].at, JSON.stringify(cov.gaps[1]));

const inside = await m.coverage({ from: t[2].at, to: new Date(Date.parse(t[2].at) + 5000).toISOString() });
check('a window entirely inside an on period is covered, with no gaps', inside.complete === true && inside.gaps.length === 0, JSON.stringify(inside));
check('and its covered time is the whole of it', inside.coveredMs === inside.totalMs && inside.totalMs === 5000, JSON.stringify(inside));

/* --------------------------------------------------- retrievable months later */

console.log('\nretrievable by something that is not this process');

const { stdout: status } = await run(process.execPath, [path.join(ROOT, 'bin', 'management.js'), 'status'], { env: process.env });
check('a fresh process reads the same state back', /management system: on since/.test(status), JSON.stringify(status));

const { stdout: windowsOut } = await run(process.execPath, [path.join(ROOT, 'bin', 'management.js'), 'windows'], { env: process.env });
check('and the CLI prints the disabled period as a period', /^OFF .*the gate blocked the release/m.test(windowsOut), JSON.stringify(windowsOut));

let refused = null;
try {
  await run(process.execPath, [path.join(ROOT, 'bin', 'management.js'), 'off'], { env: process.env });
} catch (err) {
  refused = err;
}
check('the CLI refuses an off with no reason', refused !== null && /the reason is what the record is for/.test(String(refused?.stderr || '')), String(refused?.stderr || 'it succeeded'));
check('so the state is still on', (await m.isOn()) === true);

/* ------------------------------------------------------------ the chain */

console.log('\nwhether the chain holds together');

const good = await m.verify();
check('three transitions, three commits, consistent', good.ok && good.commits === 3 && good.transitions === 3, JSON.stringify(good));

// Tamper: keep the commits, drop a transition from the payload. This is the shape a
// rewritten record takes when somebody edits the JSON rather than the history, and it
// is exactly what the commit count is compared against.
const doctored = { ...rec, transitions: [t[0], t[2]] };
const blob = execFileSync('git', ['-C', store, 'hash-object', '-w', '--stdin'], { input: JSON.stringify(doctored, null, 2) + '\n', encoding: 'utf8' }).trim();
const tree = execFileSync('git', ['-C', store, 'mktree'], { input: `100644 blob ${blob}\t${m.STATE_FILE}\n`, encoding: 'utf8' }).trim();
const parent = git('rev-parse', m.MANAGEMENT_REF);
const commit = execFileSync('git', ['-C', store, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-p', parent, '-m', 'management: tampered'], { encoding: 'utf8' }).trim();
git('update-ref', m.MANAGEMENT_REF, commit, parent);

const tampered = await m.verify();
check('a payload with a transition removed does not verify', tampered.ok === false, JSON.stringify(tampered));
check('and the report names both halves of the mismatch', tampered.problems.some((p) => /4 commits on the ref but 2 transitions/.test(p)), JSON.stringify(tampered.problems));
check('and the seq hole is reported too', tampered.problems.some((p) => /carries seq 3/.test(p)), JSON.stringify(tampered.problems));

/* ------------------------------------------------- it may not read the config */

console.log('\nthe state is a commit, not a setting');

const src = fs.readFileSync(path.join(ROOT, 'lib', 'management.js'), 'utf8');
check(
  'lib/management.js takes CONFIG_DIR from config.js and nothing else',
  /import \{[^}]*\bCONFIG_DIR\b[^}]*\} from '\.\/config\.js'/.test(src),
  'the import line changed shape'
);
check(
  'and never calls loadConfig — a switch that can be flipped by a settings file is not a control',
  !/\bloadConfig\b/.test(src)
);
check(
  'nor reads a config key of its own',
  !/\bcfg\.\w|\bconfig\.management\b/.test(src)
);

/* ------------------------------------------------------------------ done */

await cleanupTmp(store);
console.log(failures ? `\n${failures} check${failures === 1 ? '' : 's'} failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
