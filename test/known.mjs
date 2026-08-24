#!/usr/bin/env node
//
// b7e-known — say whether the memory store already holds this, before a fourth
// near-duplicate key (bc-xl7n.112).
//
//   npm test
//   node test/known.mjs
//
// `lib/memory.js`'s `nearestEntries` does the scoring; the bulk of this suite drives it
// directly, the way `test/memory.mjs` already tests its sibling `relevantNotes` — pure,
// nowhere near git. A handful of calls through the real `bin/b7e-known` binary, against a
// throwaway repo and a fake `bd`, cover what only the CLI does: argv parsing, gathering
// candidates out of all three stores, and the printed report.
//
// "all three stores" is load-bearing and was once only a claim: the debrief branch is the
// only genuinely new integration in this file's binary, and the only branch whose extra
// fields (`bead`, `staged`) shape what gets rendered — yet `if (false) candidates.push(…)`
// and `const family = []` both passed the whole suite, which is how a tier-4 hit shipped
// previewing `renderDebrief`'s byline instead of its report. So a debrief is seeded here
// through `lib/memory.js`'s own `debrief`, exactly as a run leaving a report would write
// it, and read back through the binary.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-known');

// `lib/config.js` reads BEADCAUSE_CONFIG_DIR at *module load*, so the tmp dir and the
// env var have to exist before `lib/memory.js` (which pulls it in through
// lib/commonrepo.js) is imported — exactly the ordering test/memory.mjs itself follows.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-known-'));
process.on('exit', () => removeTreeSync(tmp));
const configDir = path.join(tmp, 'config');
fs.mkdirSync(configDir, { recursive: true });
process.env.BEADCAUSE_CONFIG_DIR = configDir;
process.env.HOME = tmp;

const memory = await import(path.join(ROOT, 'lib', 'memory.js'));

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
function check(name, fn) {
  try {
    const detail = fn();
    if (detail === false) bad(name);
    else ok(name);
  } catch (err) {
    bad(name, err.message);
  }
}

console.log('\nb7e-known — nearestEntries (pure)\n');

/* ------------------------------------------------------------- nearestEntries, pure */

const STORE = [
  {
    store: 'note',
    key: 'orphan-census-fixtures-need-an-independent-root',
    value:
      'A fail-open guard over hasRootAbove finds an orphan only when the fixture tree carries no other root at all — a second root anywhere in the same fixture hides every orphan under it.',
    at: '2026-08-21T09:00:00.000Z',
  },
  {
    store: 'remember',
    key: 'cdp-tab-key-focus-testing',
    value: 'Driving a Tab keypress through CDP needs dispatchKeyEvent with both keyDown and keyUp, not a single synthetic event.',
    at: '2026-08-20T09:00:00.000Z',
  },
  {
    store: 'note',
    key: 'sw-cache-version-conflicts',
    value:
      "public/sw.js is the most likely merge conflict here: every branch touching public/ bumps `const CACHE = beadcause-vNN`, and resolving it is not 'take the higher number' — read both sides' comment blocks and renumber your own.",
    at: '2026-08-11T14:36:36.114Z',
  },
];

check('prose that paraphrases an existing note is matched to its key and store', () => {
  const hits = memory.nearestEntries(
    STORE,
    'A census over fixtures with a fail-open hasRootAbove check misses an orphan whenever a second root exists anywhere in that same tree.'
  );
  assert.equal(hits[0]?.key, 'orphan-census-fixtures-need-an-independent-root');
  assert.equal(hits[0]?.store, 'note');
});

check('a key with no near match in either store returns nothing', () => {
  const hits = memory.nearestEntries(STORE, 'Populate Clockify timesheets for July 2026, filling in the hours per project.');
  assert.equal(hits.length, 0);
});

check('the key itself counts towards the text — a match on vocabulary the value never quotes', () => {
  const hits = memory.nearestEntries(STORE, 'Two branches racing to bump the service worker cache version number both land, and the merge conflicts.');
  assert.equal(hits[0]?.key, 'sw-cache-version-conflicts');
});

check('debrief-shaped candidates (no key) still score and carry their own field through', () => {
  const withDebrief = [
    ...STORE,
    {
      store: 'debrief',
      key: null,
      value: 'The fail-open hasRootAbove guard misses an orphan whenever a second root exists in the fixture tree.',
      at: '2026-08-22T00:00:00.000Z',
      bead: 'bc-xl7n.83',
    },
  ];
  const hits = memory.nearestEntries(withDebrief, 'The fail-open hasRootAbove guard misses an orphan whenever a second root exists in the fixture tree.');
  assert.ok(hits.some((h) => h.store === 'debrief' && h.bead === 'bc-xl7n.83'), JSON.stringify(hits));
});

check('`keep` caps the count, best score first', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({
    store: 'note',
    key: `flake-${i}`,
    value: 'test/browse.mjs and the system temp dir, the same concurrency flake, take '.repeat(3) + i,
    at: `2026-08-1${i}T00:00:00.000Z`,
  }));
  const hits = memory.nearestEntries(many, 'test/browse.mjs and the system temp dir concurrency flake', { keep: 3 });
  assert.equal(hits.length, 3);
  assert.ok(hits[0].score >= hits[1].score && hits[1].score >= hits[2].score, JSON.stringify(hits.map((h) => h.score)));
});

/* ------------------------------------------------------------------------ the CLI */

console.log('\nb7e-known — the CLI, against a real repo and a fake bd\n');

const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@e' },
  }).trim();

const origin = path.join(tmp, 'origin.git');
const REPO = path.join(tmp, 'repo');
git(tmp, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
git(tmp, 'clone', '--quiet', origin, REPO);
git(REPO, 'config', 'user.email', 't@e');
git(REPO, 'config', 'user.name', 'test');
fs.writeFileSync(path.join(REPO, 'file.txt'), 'one\n');
git(REPO, 'add', '-A');
git(REPO, 'commit', '--quiet', '-m', 'root');
git(REPO, 'push', '--quiet', '-u', 'origin', 'main');

/* ---------------------------------------------------------------------- fake bd */

const FAKE_BD = path.join(tmp, 'bd');
const WORLD = {
  issues: {
    'ws-child': { id: 'ws-child', title: 'A child bead', status: 'open', issue_type: 'task', priority: 2, assignee: '', parent: 'ws-parent' },
    'ws-sibling': { id: 'ws-sibling', title: 'A sibling bead', status: 'open', issue_type: 'task', priority: 2, assignee: '', parent: 'ws-parent' },
  },
};
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
const world = ${JSON.stringify(WORLD)};
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
const verb = args[0];
if (verb === 'show') {
  const id = args[1];
  const issue = world.issues[id];
  if (!issue) die('Error fetching ' + id + ': no issue found matching "' + id + '"');
  process.stdout.write(JSON.stringify([issue]));
  process.exit(0);
}
die('stub bd: unexpected verb "' + verb + '"');
`,
  { mode: 0o755 }
);

/* -------------------------------------------------------------------- config */

fs.writeFileSync(
  path.join(configDir, 'config.json'),
  JSON.stringify({ bdBin: FAKE_BD, actor: 'beadcause-test', workspaces: [{ name: 'known-ws', dir: path.join(tmp, 'tracker') }], sessionDirs: { 'known-ws': REPO } }, null, 2)
);
fs.mkdirSync(path.join(tmp, 'tracker'), { recursive: true });

function run(args, { input = '', env = {} } = {}) {
  // BEADCAUSE_BEAD is deliberately cleared rather than inherited — this suite may
  // itself be running inside a real beadcause session with that env var set for its
  // own bead, and a child that inherited it would silently pass a real bead id through
  // the no-`-b` cases below.
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: tmp,
    input,
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: configDir, BEADCAUSE_AGENT: 'known-tester', BEADCAUSE_BEAD: '', ...env },
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

// Seed the note store directly through lib/memory.js's own `note`, exactly as an agent
// running from this checkout would have written it — no shortcuts through the file system.
const cwd0 = process.cwd();
process.chdir(REPO);
await memory.note('known-tester', 'orphan-census-needs-independent-root', 'A fail-open hasRootAbove check over a census misses an orphan when a second root exists anywhere in the same fixture tree.');
await memory.remember('known-tester', 'cdp-tab-focus', 'Driving Tab through CDP needs both keyDown and keyUp dispatched, not one synthetic event.');
// A real tier-4 write, so what comes back is `renderDebrief`'s output — stamp line, blank
// line, report — and not a hand-built string that would hide the byline bug.
const DEBRIEF_REPORT =
  'The parallel gate runner drops a suite whose name collides with another under the same tmpdir, so a green run can be one suite short and say nothing.';
await memory.debrief('known-tester', 'ws-child', DEBRIEF_REPORT);
// A second store, big enough that its --json report cannot fit in a 64KB pipe buffer.
const LONG = 'A fail-open hasRootAbove check over a census misses an orphan when a second root exists anywhere in the same fixture tree. '.repeat(40);
for (let i = 0; i < 30; i += 1) await memory.note('bulk-tester', `orphan-census-fixture-root-${i}`, `${LONG}${i}`);
process.chdir(cwd0);

check('--help prints usage and exits 0', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /usage: b7e-known/);
});

check('a missing -w is refused', () => {
  const { status, stderr } = run(['-b', 'ws-child'], { input: 'anything' });
  assert.notEqual(status, 0);
  assert.match(stderr, /-w\/--workspace is required/);
});

check('empty stdin is refused rather than silently checked', () => {
  const { status, stderr } = run(['-w', 'known-ws'], { input: '   \n' });
  assert.notEqual(status, 0);
  assert.match(stderr, /nothing to check/);
});

check('an unknown bead is refused, not treated as no scope', () => {
  const { status, stderr } = run(['-w', 'known-ws', '-b', 'ws-nope'], { input: 'anything' });
  assert.notEqual(status, 0);
  assert.match(stderr, /no bead ws-nope/);
});

check('prose paraphrasing an existing note names its key, store and an update command', () => {
  const { status, stdout } = run(['-w', 'known-ws'], {
    input: 'A census with a fail-open hasRootAbove guard misses an orphan whenever a second root exists in the same fixture.',
  });
  assert.equal(status, 0);
  assert.match(stdout, /note `orphan-census-needs-independent-root`/);
  assert.match(stdout, /b7e-say -w known-ws -b <bead> --note orphan-census-needs-independent-root/);
});

check('and the same for a remember, with --remember in the update line', () => {
  const { status, stdout } = run(['-w', 'known-ws'], {
    input: 'Sending a Tab key through CDP needs both a keyDown and a keyUp dispatchKeyEvent call.',
  });
  assert.equal(status, 0);
  assert.match(stdout, /remember `cdp-tab-focus`/);
  assert.match(stdout, /--remember cdp-tab-focus/);
});

check('genuinely new prose says so in one line and exits 0', () => {
  const { status, stdout } = run(['-w', 'known-ws'], { input: 'Populate Clockify timesheets for July 2026, filling in the hours per project.' });
  assert.equal(status, 0);
  const lines = stdout.trim().split('\n');
  assert.equal(lines.length, 1, `expected one line, got:\n${stdout}`);
  assert.match(stdout, /nothing on file reads like this/);
  assert.match(stdout, /Safe to file a new key/);
});

check('-b with no debrief history for that bead or its family still runs clean', () => {
  const { status, stdout } = run(['-w', 'known-ws', '-b', 'ws-child'], { input: 'Something nobody has written down yet.' });
  assert.equal(status, 0);
  assert.match(stdout, /nothing on file reads like this/);
  assert.match(stdout, /debrief entr(y|ies) for ws-child and its family/);
});

check('--json emits a parseable, structurally complete report', () => {
  const { status, stdout } = run(['-w', 'known-ws', '--json'], {
    input: 'A census with a fail-open hasRootAbove guard misses an orphan whenever a second root exists in the same fixture.',
  });
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.workspace, 'known-ws');
  assert.ok(parsed.hits.some((h) => h.key === 'orphan-census-needs-independent-root' && h.store === 'note'));
});

check('a debrief on the bead is gathered and labelled as a debrief hit', () => {
  const { status, stdout } = run(['-w', 'known-ws', '-b', 'ws-child'], {
    input: 'A parallel runner silently drops a suite whose name collides with another one under the same tmpdir, so a green run is a suite short.',
  });
  assert.equal(status, 0);
  assert.match(stdout, /debrief entry \(ws-child, pending archive\)/, stdout);
  assert.match(stdout, /append-only — no key to update/, stdout);
});

check("a debrief hit previews its report, not renderDebrief's byline", () => {
  const { status, stdout } = run(['-w', 'known-ws', '-b', 'ws-child'], {
    input: 'A parallel runner silently drops a suite whose name collides with another one under the same tmpdir, so a green run is a suite short.',
  });
  assert.equal(status, 0);
  const lines = stdout.split('\n');
  const at = lines.findIndex((l) => l.startsWith('debrief entry ('));
  assert.ok(at > -1, stdout);
  const preview = lines[at + 1].trim();
  // The stamp `renderDebrief` writes is `<agent> · <ISO>`; every tier-4 hit used to
  // preview that, identically, and never a word of the report itself.
  assert.ok(!/^known-tester · \d{4}-/.test(preview), `previewed the byline: ${preview}`);
  assert.ok(DEBRIEF_REPORT.startsWith(preview.slice(0, 40)), `expected the report, got: ${preview}`);
});

check("--json carries a debrief hit's bead and staged, which the printed form uses", () => {
  const { status, stdout } = run(['-w', 'known-ws', '-b', 'ws-child', '--json'], {
    input: 'A parallel runner silently drops a suite whose name collides with another one under the same tmpdir, so a green run is a suite short.',
  });
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.checked.debrief, 1, JSON.stringify(parsed.checked));
  const hit = parsed.hits.find((h) => h.store === 'debrief');
  assert.ok(hit, stdout);
  // `key` is null for every tier-4 hit, so without these two a machine consumer cannot say
  // which bead it came from or whether it is only staged.
  assert.equal(hit.bead, 'ws-child');
  assert.equal(hit.staged, true);
  assert.ok(!/^known-tester · \d{4}-/.test(hit.preview), `previewed the byline: ${hit.preview}`);
});

check('--json through a pipe is whole and parseable, however big the report', () => {
  // `console.log(...)` then `process.exit(0)` dropped the pending write: stdout to a pipe
  // is async, so this came back cut at exactly 65536 bytes with status 0. spawnSync's
  // stdio is a pipe, which is the case that broke.
  const { status, stdout } = run(['-w', 'known-ws', '--agent', 'bulk-tester', '--keep', '30', '--json'], {
    input: 'A fail-open hasRootAbove check over a census misses an orphan when a second root exists anywhere in the same fixture tree.',
  });
  assert.equal(status, 0);
  assert.ok(stdout.length > 65536, `payload too small to test the pipe buffer: ${stdout.length} bytes`);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.hits.length, 30, `${parsed.hits.length} hits`);
});

check('an unresolvable $BEADCAUSE_BEAD narrows the scope instead of failing the run', () => {
  // Every agent session has BEADCAUSE_BEAD stamped, so a cross-workspace call, a renamed
  // bead or a transient bd failure would otherwise take the whole tool down with no -b
  // given — over a scope the caller never asked for, in a tool that gates nothing.
  const { status, stdout, stderr } = run(['-w', 'known-ws'], {
    input: 'A census with a fail-open hasRootAbove guard misses an orphan whenever a second root exists in the same fixture.',
    env: { BEADCAUSE_BEAD: 'ws-nope' },
  });
  assert.equal(status, 0, stderr);
  assert.match(stderr, /\$BEADCAUSE_BEAD is ws-nope/);
  assert.match(stdout, /note `orphan-census-needs-independent-root`/, stdout);
});

check('but an explicit -b that does not resolve is still a hard 4', () => {
  const { status, stderr } = run(['-w', 'known-ws', '-b', 'ws-nope'], { input: 'anything' });
  assert.equal(status, 4);
  assert.match(stderr, /no bead ws-nope/);
});

check('a flag whose value is another flag, or missing, is refused as usage', () => {
  const agent = run(['-w', 'known-ws', '--agent', '--json'], { input: 'anything' });
  assert.equal(agent.status, 2, agent.stderr);
  assert.match(agent.stderr, /--agent needs a value, not the flag "--json"/);
  // A trailing `-b` used to read as "no -b at all" — a narrower answer than was asked for,
  // given silently.
  const bead = run(['-w', 'known-ws', '-b'], { input: 'anything' });
  assert.equal(bead.status, 2, bead.stderr);
  assert.match(bead.stderr, /-b needs a value/);
});

check('--keep 0 and --keep abc are refused rather than silently defaulted to 5', () => {
  for (const bad of ['0', 'abc']) {
    const { status, stderr } = run(['-w', 'known-ws', '--keep', bad], { input: 'anything' });
    assert.equal(status, 2, `--keep ${bad}: ${stderr}`);
    assert.match(stderr, /--keep takes a positive whole number/);
  }
});

check('an unreadable --file is the documented 2, not a raw ENOENT at 1', () => {
  const { status, stderr } = run(['-w', 'known-ws', '--file', path.join(tmp, 'no-such-file.txt')]);
  assert.equal(status, 2, stderr);
  assert.match(stderr, /could not read --file/);
  assert.ok(!/at Object\./.test(stderr), `raw stack: ${stderr}`);
});

check('never touches the personal memory directory — no such path appears anywhere in the source', () => {
  const src = fs.readFileSync(BIN, 'utf8');
  assert.ok(!/\.claude-personal/.test(src), 'bin/b7e-known must not reference the personal memory directory');
});

console.log(`\n${failures ? `\x1b[31m${failures} failed\x1b[0m` : '\x1b[32mall passed\x1b[0m'} (${ran} checks)\n`);
process.exit(failures ? 1 : 0);
