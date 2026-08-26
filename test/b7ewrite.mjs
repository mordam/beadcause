#!/usr/bin/env node
//
// b7e-write — one `bd` write that survives contention, instead of a blind retry that
// double-posts (bc-dgx7.86, re-filed from dv-k4n.14).
//
//   npm test
//   node test/b7ewrite.mjs
//
// Three sessions working other repos' bugs each had to mutate a *different* workspace's
// tracker from a Bash tool call, and each one hand-rolled raw `bd` against a workspace
// where embedded Dolt's single writer was contended all afternoon. dv-k4n.8's `bd
// comment` timed out; its own check read raced the still-queued write, answered "No
// comments", and the session retried — both writes landed, the same finding twice. This
// is the fix: a verification read after a timeout that can tell "not there" apart from
// "could not find out", so nothing is ever retried blind.
//
// Driven as a real subprocess against a stub `bd`, for the reason test/b7ews.mjs gives
// for its own sibling: the flags reaching `bd`, and how many times it is spawned, are
// the thing under test. The stub keeps one JSON world per workspace directory (read from
// `$BEADS_DIR/world.json`) and can be told, per call, to write and then hang — a timer
// rather than a spin, so it costs no CPU and is killed cleanly by `execFile`'s own
// `timeout` the moment the write under test asks for one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-write');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7ewrite-'));
const configDir = path.join(tmp, 'config');
fs.mkdirSync(configDir, { recursive: true });

/* ------------------------------------------------------------------- the stub bd */

const FAKE_BD = path.join(tmp, 'bd');
const CALLS = path.join(tmp, 'calls.jsonl');

fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const dir = process.env.BEADS_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ args, dir }) + '\\n');
const worldFile = path.join(dir, 'world.json');
const load = () => fs.existsSync(worldFile) ? JSON.parse(fs.readFileSync(worldFile, 'utf8')) : { issues: {}, comments: {}, deps: {} };
const save = (w) => fs.writeFileSync(worldFile, JSON.stringify(w));
const json = args.includes('--json');
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
// Writes to disk (if any) before this fires, so a caller that kills this process after
// the ceiling still sees a real, already-committed write on the next read — the exact
// shape a genuinely wedged Dolt would leave behind.
const hang = () => setTimeout(() => process.exit(0), 60_000);
const bead = (w, id) => w.issues[id] || (w.issues[id] = { id, status: 'open', assignee: '', labels: [], title: '', notes: '', parent: '' });

const verb = args[0];
// A write that never even reaches Dolt — the "genuinely did not land" case. Read verbs
// (used by the verification pass itself) still answer normally, so the read can prove
// the absence rather than also hanging.
const WRITE_VERBS_HERE = ['comment', 'update', 'unclaim', 'close', 'label'];
const isDepWrite = verb === 'dep' && args[1] !== 'list';
if (process.env.B7EWRITE_NEVER_WRITES && (WRITE_VERBS_HERE.includes(verb) || isDepWrite)) return hang();
if (verb === 'comment') {
  const [, id, text] = args;
  const w = load();
  w.comments[id] = w.comments[id] || [];
  w.comments[id].push({ id: 'c' + w.comments[id].length, issue_id: id, author: 'test', text, created_at: new Date().toISOString() });
  save(w);
  if (process.env.B7EWRITE_HANG_WRITE) return hang();
  process.stdout.write('Comment added\\n');
  process.exitCode = 0;
} else if (verb === 'comments') {
  const [, id] = args;
  if (process.env.B7EWRITE_HANG_VERIFY) return hang();
  const w = load();
  const rows = w.comments[id] || [];
  process.stdout.write(json ? JSON.stringify(rows) : rows.map((r) => r.text).join('\\n') + '\\n');
  process.exitCode = 0;
} else if (verb === 'show') {
  const [, id] = args;
  if (process.env.B7EWRITE_HANG_VERIFY) return hang();
  const w = load();
  const issue = w.issues[id];
  if (!issue) die('no issue found matching "' + id + '"');
  process.stdout.write(json ? JSON.stringify([issue]) : issue.id + '\\n');
  process.exitCode = 0;
} else if (verb === 'update') {
  const id = args[1];
  const w = load();
  const issue = bead(w, id);
  if (args.includes('--claim')) { issue.status = 'in_progress'; issue.assignee = 'beadcause-test'; }
  const statusFlag = args.find((a) => a.startsWith('--status='));
  if (statusFlag) issue.status = statusFlag.slice('--status='.length);
  const titleFlag = args.find((a) => a.startsWith('--title='));
  if (titleFlag) issue.title = titleFlag.slice('--title='.length);
  save(w);
  if (process.env.B7EWRITE_HANG_WRITE) return hang();
  process.stdout.write('Updated ' + id + '\\n');
  process.exitCode = 0;
} else if (verb === 'unclaim') {
  const id = args[1];
  const w = load();
  const issue = bead(w, id);
  issue.status = 'open';
  issue.assignee = '';
  save(w);
  if (process.env.B7EWRITE_HANG_WRITE) return hang();
  process.stdout.write('Released ' + id + '\\n');
  process.exitCode = 0;
} else if (verb === 'close') {
  const id = args[1];
  const w = load();
  const issue = bead(w, id);
  issue.status = 'closed';
  save(w);
  if (process.env.B7EWRITE_HANG_WRITE) return hang();
  process.stdout.write('Closed ' + id + '\\n');
  process.exitCode = 0;
} else if (verb === 'label') {
  const [, sub, id, label] = args;
  const w = load();
  const issue = bead(w, id);
  if (sub === 'add') { if (!issue.labels.includes(label)) issue.labels.push(label); }
  else if (sub === 'remove') { issue.labels = issue.labels.filter((l) => l !== label); }
  else die('label: unknown subverb ' + sub);
  save(w);
  if (process.env.B7EWRITE_HANG_WRITE) return hang();
  process.stdout.write('Labelled ' + id + '\\n');
  process.exitCode = 0;
} else if (verb === 'dep') {
  const sub = args[1];
  if (sub === 'list') {
    const id = args[2];
    if (process.env.B7EWRITE_HANG_VERIFY) return hang();
    const w = load();
    const rows = (w.deps[id] || []).map((depId) => ({ id: depId }));
    process.stdout.write(json ? JSON.stringify(rows) : rows.map((r) => r.id).join('\\n') + '\\n');
    process.exitCode = 0;
  } else {
    const [, , id, depId] = args;
    const w = load();
    w.deps[id] = w.deps[id] || [];
    if (sub === 'add') { if (!w.deps[id].includes(depId)) w.deps[id].push(depId); }
    else if (sub === 'remove') { w.deps[id] = w.deps[id].filter((d) => d !== depId); }
    else die('dep: unknown subverb ' + sub);
    save(w);
    if (process.env.B7EWRITE_HANG_WRITE) return hang();
    process.stdout.write('Linked ' + id + '\\n');
    process.exitCode = 0;
  }
} else {
  die('stub bd: unexpected verb "' + verb + '"');
}
`,
  { mode: 0o755 }
);

/* --------------------------------------------------------------- one workspace */

const WSDIR = path.join(tmp, 'alpha', '.beads');
fs.mkdirSync(WSDIR, { recursive: true });
const ALPHA = { name: 'alpha', dir: WSDIR };

fs.writeFileSync(
  path.join(configDir, 'config.json'),
  JSON.stringify({ bdBin: FAKE_BD, actor: 'beadcause-test', workspaces: [ALPHA] }, null, 2)
);

/* ------------------------------------------------------------------------- run */

const UNRELATED_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7ewrite-elsewhere-'));

function run(args, env = {}) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: UNRELATED_CWD,
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: configDir, ...env },
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function calls() {
  return fs.existsSync(CALLS)
    ? fs
        .readFileSync(CALLS, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
}
const resetCalls = () => fs.writeFileSync(CALLS, '');
const worldFile = path.join(WSDIR, 'world.json');
const worldOf = () => (fs.existsSync(worldFile) ? JSON.parse(fs.readFileSync(worldFile, 'utf8')) : { issues: {}, comments: {}, deps: {} });
/** Seeds a bead directly into the stub's world, the way a real one would already exist — `claim`/`unclaim`/`close`/`label`/`dep` all act on a bead that is already there. */
const seed = (id, fields = {}) => {
  const w = worldOf();
  w.issues[id] = { id, status: 'open', assignee: '', labels: [], title: '', notes: '', parent: '', ...fields };
  fs.writeFileSync(worldFile, JSON.stringify(w));
};

/* --------------------------------------------------------------------- harness */

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
};

console.log('\nb7e-write\n');

check('--help prints usage and exits 0, without ever calling bd', () => {
  resetCalls();
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /usage: b7e-write/);
  assert.equal(calls().length, 0, 'help must not spawn bd');
});

check('a plain comment lands on the first attempt — one bd call, exit 0', () => {
  resetCalls();
  fs.writeFileSync(path.join(tmp, 'body.txt'), 'first attempt, no contention');
  const { status, stdout } = run(['-w', 'alpha', 'comment', 'al-1', '--file', path.join(tmp, 'body.txt')]);
  assert.equal(status, 0);
  assert.match(stdout, /b7e-write: landed/);
  assert.equal(calls().length, 1, 'a clean write is exactly one bd spawn');
  assert.deepEqual(worldOf().comments['al-1'].map((c) => c.text), ['first attempt, no contention']);
});

check('comment text is refused as a positional argument, and bd is never called', () => {
  resetCalls();
  const { status, stderr } = run(['-w', 'alpha', 'comment', 'al-2', 'inline text']);
  assert.notEqual(status, 0);
  assert.match(stderr, /never a positional argument/);
  assert.equal(calls().length, 0, 'a refused comment must not spawn bd at all');
});

check(
  'a comment that times out after already writing is reported "already landed" — the dv-k4n.8 double-post does not reproduce',
  () => {
    resetCalls();
    fs.writeFileSync(path.join(tmp, 'body2.txt'), 'landed despite the kill');
    const { status, stdout } = run(
      ['-w', 'alpha', 'comment', 'al-3', '--file', path.join(tmp, 'body2.txt'), '--timeout', '300'],
      { B7EWRITE_HANG_WRITE: '1' }
    );
    assert.equal(status, 0);
    assert.match(stdout, /already landed/);
    const cs = calls();
    assert.equal(cs.length, 2, 'exactly one write attempt plus one verification read — nothing retried');
    assert.equal(cs[0].args[0], 'comment');
    assert.equal(cs[1].args[0], 'comments');
    // Exactly one comment landed, not two — the whole bug this command exists to prevent.
    assert.deepEqual(worldOf().comments['al-3'].map((c) => c.text), ['landed despite the kill']);
  }
);

check('a write that times out and truly never landed is reported "not landed" — safe to retry', () => {
  resetCalls();
  seed('al-4'); // already exists, open, unclaimed — same as any real bead a claim targets
  // The write hangs before it ever reaches `save()` — nothing is written — but the
  // verification read (a different verb) answers normally, so it can prove the absence
  // rather than time out itself.
  const { status, stderr } = run(['-w', 'alpha', 'claim', 'al-4', '--timeout', '300'], {
    B7EWRITE_NEVER_WRITES: '1',
  });
  assert.notEqual(status, 0);
  assert.match(stderr, /not landed/);
  assert.equal(worldOf().issues['al-4'].status, 'open', 'the claim never actually reached the world');
  const cs = calls();
  assert.equal(cs.length, 2, 'one write attempt plus one verification read that actually answered');
});

check('a write that times out AND whose verification read also times out is "unconfirmed" — never retried', () => {
  resetCalls();
  fs.writeFileSync(path.join(tmp, 'body3.txt'), 'ambiguous forever');
  const { status, stdout, stderr } = run(
    ['-w', 'alpha', 'comment', 'al-5', '--file', path.join(tmp, 'body3.txt'), '--timeout', '300'],
    { B7EWRITE_HANG_WRITE: '1', B7EWRITE_HANG_VERIFY: '1' }
  );
  assert.notEqual(status, 0);
  assert.match(stderr, /unconfirmed/);
  assert.match(stderr, /neither landed nor a retry/);
  void stdout;
  const cs = calls();
  assert.equal(cs.length, 2, 'exactly one write attempt plus one verification attempt — an ambiguous answer is not retried either');
});

check('claim is shorthand for `bd update <id> --claim`, and is verifiable after a timeout', () => {
  resetCalls();
  const { status, stdout } = run(['-w', 'alpha', 'claim', 'al-6', '--timeout', '300'], { B7EWRITE_HANG_WRITE: '1' });
  assert.equal(status, 0);
  assert.match(stdout, /already landed/);
  const call = calls()[0];
  assert.deepEqual(call.args.slice(0, 3), ['update', 'al-6', '--claim']);
  assert.equal(worldOf().issues['al-6'].status, 'in_progress');
});

check('unclaim, close, label add/remove and dep add/remove all land cleanly', () => {
  resetCalls();
  assert.equal(run(['-w', 'alpha', 'update', 'al-7', '--claim']).status, 0);
  assert.equal(run(['-w', 'alpha', 'unclaim', 'al-7']).status, 0);
  assert.equal(worldOf().issues['al-7'].status, 'open');

  assert.equal(run(['-w', 'alpha', 'close', 'al-7']).status, 0);
  assert.equal(worldOf().issues['al-7'].status, 'closed');

  assert.equal(run(['-w', 'alpha', 'label', 'add', 'al-7', 'human']).status, 0);
  assert.deepEqual(worldOf().issues['al-7'].labels, ['human']);
  assert.equal(run(['-w', 'alpha', 'label', 'remove', 'al-7', 'human']).status, 0);
  assert.deepEqual(worldOf().issues['al-7'].labels, []);

  assert.equal(run(['-w', 'alpha', 'dep', 'add', 'al-7', 'al-1']).status, 0);
  assert.deepEqual(worldOf().deps['al-7'], ['al-1']);
  assert.equal(run(['-w', 'alpha', 'dep', 'remove', 'al-7', 'al-1']).status, 0);
  assert.deepEqual(worldOf().deps['al-7'], []);
});

check('label add verifies after a timeout the same way comment does', () => {
  resetCalls();
  const { status, stdout } = run(['-w', 'alpha', 'label', 'add', 'al-8', 'agent-filed', '--timeout', '300'], {
    B7EWRITE_HANG_WRITE: '1',
  });
  assert.equal(status, 0);
  assert.match(stdout, /already landed/);
  assert.deepEqual(worldOf().issues['al-8'].labels, ['agent-filed']);
});

check('an unrecognised update flag cannot be judged after a timeout — reported unconfirmed, not landed', () => {
  resetCalls();
  const { status, stderr } = run(['-w', 'alpha', 'update', 'al-9', '--parent-x', 'bogus', '--timeout', '300'], {
    B7EWRITE_HANG_WRITE: '1',
  });
  assert.notEqual(status, 0);
  assert.match(stderr, /unconfirmed/);
  assert.match(stderr, /cannot be judged/);
});

check('a bd binary that refuses outright is reported "refused", never as a timeout', () => {
  const FAILS = path.join(tmp, 'bd-fails');
  fs.writeFileSync(FAILS, `#!/usr/bin/env node\nprocess.stderr.write('cannot close: assignee mismatch');\nprocess.exit(1);\n`, {
    mode: 0o755,
  });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ bdBin: FAILS, actor: 'beadcause-test', workspaces: [ALPHA] }, null, 2)
  );
  const { status, stderr } = run(['-w', 'alpha', 'close', 'al-1']);
  assert.notEqual(status, 0);
  assert.match(stderr, /refused/);
  assert.match(stderr, /assignee mismatch/);
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ bdBin: FAKE_BD, actor: 'beadcause-test', workspaces: [ALPHA] }, null, 2)
  );
});

check('non-mutating verbs are refused with a pointer to b7e-ws, and bd is never called', () => {
  resetCalls();
  for (const verb of ['show', 'comments', 'list', 'ready', 'search']) {
    const { status, stderr } = run(['-w', 'alpha', verb, 'al-1']);
    assert.notEqual(status, 0, `${verb} must be refused`);
    assert.match(stderr, /use b7e-ws/, `${verb} should point at b7e-ws`);
  }
  assert.equal(calls().length, 0, 'a refused read verb must not spawn bd at all');
});

check('an unrecognised verb (e.g. create) is refused, listing the mutating set', () => {
  const { status, stderr } = run(['-w', 'alpha', 'create', 'al-1']);
  assert.notEqual(status, 0);
  assert.match(stderr, /not a mutating verb/);
  assert.match(stderr, /comment.*update.*close.*claim.*unclaim.*label.*dep/s);
});

check('a missing issue id is refused before anything is resolved', () => {
  const { status, stderr } = run(['-w', 'alpha', 'update']);
  assert.notEqual(status, 0);
  assert.match(stderr, /an issue id is required/);
});

check('an unconfigured workspace name is refused, naming the ones that exist', () => {
  const { status, stderr } = run(['-w', 'nope', 'comment', 'al-1']);
  assert.notEqual(status, 0);
  assert.match(stderr, /no workspace named "nope"/);
  assert.match(stderr, /alpha/);
});

console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
