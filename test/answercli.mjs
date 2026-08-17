#!/usr/bin/env node
/**
 * `beadcause-answer` end to end — the command a reopened worker actually runs.
 *
 *     npm test
 *     node test/answercli.mjs
 *
 * bc-36xx.6. test/reviewanswer.mjs pins the decisions as pure functions; this drives the real
 * `bin/answer.js` against a fake tracker, because three of the ways this goes wrong are
 * only visible from outside the module:
 *
 * 1. **The write has to land in the right field, beside the other block.** The review block
 *    shares `notes` with the merge queue's own state block, and the queue rewrites its one
 *    every tick. A command that wrote the field wholesale would take the queue's attempt
 *    count with it, which nothing would notice until a merge retried from zero.
 * 2. **A refusal has to write nothing.** Every guard in `checkAnswers` is worth having only
 *    if the command stops before the `bd update` — a refusal that had already written half
 *    the answers is worse than no guard at all. The fake bd logs every argv, so the
 *    assertion is the negative one: no `update` in the log.
 * 3. **A worker names its own bead.** The brief prints the merge-bead's id, but the id in a
 *    reopened worker's head is the work bead — so the command resolves one to the other,
 *    and getting that wrong means an answer recorded against the wrong pull request.
 *
 * The fake bd holds a world file rather than only logging, for the reason test/approval.mjs's
 * does: a fake that records argv and answers nothing passes with the bug still in it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWER = path.join(HERE, '..', 'bin', 'answer.js');
const { mergeBeadBody, withQueueBlock, withReviewBlock, reviewState, queueState } = await import(
  path.join(HERE, '..', 'lib', 'mergebead.js')
);

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-answercli-'));
const CONFIG_DIR = path.join(tmp, 'config');
const wsDir = path.join(tmp, 'ws');
fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.mkdirSync(path.join(wsDir, '.beads'), { recursive: true });

const WORLD = path.join(tmp, 'world.json');
const BD_LOG = path.join(tmp, 'bd-calls.log');
const FAKE_BD = path.join(tmp, 'bd');

const world = () => JSON.parse(fs.readFileSync(WORLD, 'utf8'));
const calls = () =>
  fs
    .readFileSync(BD_LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const WORLD = ${JSON.stringify(WORLD)};
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(BD_LOG)}, JSON.stringify(args) + '\\n');
const w = JSON.parse(fs.readFileSync(WORLD, 'utf8'));
const save = () => fs.writeFileSync(WORLD, JSON.stringify(w, null, 2));
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const die = (msg) => { process.stderr.write(msg + '\\n'); process.exit(1); };

if (args[0] === 'show') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error fetching ' + args[1] + ': no issue found');
  process.stdout.write(JSON.stringify([issue]));
  process.exit(0);
}
if (args[0] === 'list') {
  process.stdout.write(JSON.stringify(Object.values(w.issues).filter((i) => i.status !== 'closed')));
  process.exit(0);
}
if (args[0] === 'update') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  const notes = flag('--notes');
  if (notes !== null) issue.notes = notes;
  save();
  process.exit(0);
}
if (args[0] === 'comment') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  (issue.comments = issue.comments || []).push(args[2]);
  save();
  process.exit(0);
}
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

fs.writeFileSync(
  path.join(CONFIG_DIR, 'config.json'),
  JSON.stringify({
    port: 4319,
    host: '127.0.0.1',
    baseUrl: 'http://127.0.0.1:4319',
    token: 'answer-token',
    actor: 'beadcause-test',
    bdBin: FAKE_BD,
    workspaces: [{ name: 'demo', dir: wsDir }],
    openSessions: false,
    claudeSessions: false,
    ntfy: { enabled: false },
    advocates: { enabled: false, workspaces: [] },
  })
);

const SPEC = {
  workspace: 'demo',
  bead: 'zz-work',
  title: 'The thing the worker did',
  repo: 'mordam/demo',
  number: 42,
  url: 'https://github.com/mordam/demo/pull/42',
  branch: 'worktree-thing-a3f',
  base: 'main',
  method: 'merge',
  summary: 'What changed and why.',
  tests: 'npm test — green',
};

const REVIEW = {
  round: 1,
  verdict: 'changes',
  reviewer: 'NeanderthalMan',
  at: '2026-08-17T18:00:00.000Z',
  comments: [
    { id: 'c1', path: 'lib/thing.js', line: 42, body: 'this throws on an empty list' },
    { id: 'c2', body: 'why is the lock taken twice' },
    { id: 'c3', body: 'this one is settled', answer: 'changed', note: 'done', resolved: true },
  ],
};

/** The merge-bead as the queue actually leaves it: both blocks in `notes`, and a human's line. */
const notesFor = () =>
  withReviewBlock(
    withQueueBlock('A line a person wrote on this bead.', { attempts: 2, downmerges: 1, refused: 'a check was pending' }),
    REVIEW
  );

const reset = () => {
  fs.writeFileSync(
    WORLD,
    JSON.stringify(
      {
        issues: {
          'zz-merge': {
            id: 'zz-merge',
            title: 'Merge #42 — zz-work',
            description: mergeBeadBody(SPEC, { tests: SPEC.tests }),
            notes: notesFor(),
            labels: ['merge-queue'],
            status: 'open',
            issue_type: 'task',
            dependencies: [],
          },
          'zz-work': {
            id: 'zz-work',
            title: 'The thing the worker did',
            description: '',
            notes: '',
            labels: [],
            status: 'in_progress',
            issue_type: 'task',
            dependencies: [],
          },
        },
      },
      null,
      2
    )
  );
  fs.writeFileSync(BD_LOG, '');
};

/**
 * Run the command the way a session does — a heredoc on stdin — and hand back everything,
 * because the exit code and the sentence on stderr are what half of these assert on.
 *
 * `cwd` is the config directory rather than a checkout on purpose: it is not a git repo, so
 * the push check finds no upstream and skips, which is exactly the "not knowing is not
 * evidence" branch. The branch where git *does* answer is a worktree fixture and belongs
 * with the ones that build one.
 */
function answer(bead, input, extra = []) {
  try {
    const out = execFileSync(process.execPath, [ANSWER, '-w', 'demo', '-b', bead, ...extra], {
      cwd: CONFIG_DIR,
      encoding: 'utf8',
      input,
      env: { ...process.env, BEADCAUSE_CONFIG_DIR: CONFIG_DIR },
    });
    return { code: 0, out, err: '' };
  } catch (err) {
    return { code: err.status ?? 1, out: String(err.stdout || ''), err: String(err.stderr || '') };
  }
}

console.log('\nthe worker answers, through the command\n');

/* ------------------------------------------------------------------- the ordinary run */

reset();
const good = answer('zz-merge', '- id: c1\n  answer: changed\n  note: guarded the empty list\n- id: c2\n  answer: clarify\n  note: which lock did you mean\n');

check('it exits clean and says what it answered', good.code === 0 && /answered 2 comments on zz-merge/.test(good.out), `${good.code} ${good.err}`);
check('and says nothing is left unanswered, without claiming the review is over', /ReviewAdvocate decides/.test(good.out), good.out);

const after = reviewState(world().issues['zz-merge']);
check('the answers are in the review block', after.comments.find((c) => c.id === 'c1')?.answer === 'changed', JSON.stringify(after.comments));
check('with the note beside them', after.comments.find((c) => c.id === 'c2')?.note === 'which lock did you mean');
check('the round is untouched — a reply is not a review pass', after.round === 1 && after.verdict === 'changes');
check('the reviewer’s own resolved comment is still resolved', after.comments.find((c) => c.id === 'c3')?.resolved === true);
check(
  'the queue’s block beside it is intact — attempts, downmerges and the refusal',
  (() => {
    const q = queueState(world().issues['zz-merge']);
    return q.attempts === 2 && q.downmerges === 1 && q.refused === 'a check was pending';
  })(),
  JSON.stringify(queueState(world().issues['zz-merge']))
);
check('and so is the line a person wrote in the same field', /A line a person wrote/.test(world().issues['zz-merge'].notes));
check(
  'it comments what it said, so the bead reads as a conversation',
  (world().issues['zz-merge'].comments || []).some((c) => /The worker answered round 1/.test(c) && /Nothing here is resolved/.test(c)),
  JSON.stringify(world().issues['zz-merge'].comments)
);

/* -------------------------------------------------------------- naming the work bead */

reset();
const byWork = answer('zz-work', '- id: c1\n  answer: declined\n  note: it cannot be empty at that call site\n');
check('a worker may name its own bead rather than the merge-bead', byWork.code === 0, `${byWork.code} ${byWork.err}`);
check(
  'and the answer still lands on the merge-bead, which is where the review is',
  reviewState(world().issues['zz-merge']).comments.find((c) => c.id === 'c1')?.answer === 'declined'
);

/* ------------------------------------------------------------------------- refusals */

for (const [name, body, pattern] of [
  ['an id the review does not carry', '- id: c9\n  answer: changed\n  note: done\n', /no comment `c9`/],
  ['an answer outside the three words', '- id: c1\n  answer: rejected\n  note: no\n', /changed, clarify, declined/],
  ['a decline with no reason', '- id: c1\n  answer: declined\n', /round spent on nothing/],
  ['a resolved the worker is not allowed to write', '- id: c1\n  answer: changed\n  resolved: true\n', /reviewer's field/i],
  ['a comment the reviewer already settled', '- id: c3\n  answer: changed\n  note: again\n', /already resolved/],
  ['a document that is not YAML at all', '- id: [c1\n  answer:: changed\n', /not YAML this can read/],
]) {
  reset();
  const before = world().issues['zz-merge'].notes;
  const res = answer('zz-merge', body);
  check(`${name} is refused, with a sentence`, res.code !== 0 && pattern.test(res.err), `${res.code} ${res.err}`);
  check(`  and nothing at all is written`, world().issues['zz-merge'].notes === before && !calls().some((c) => c[0] === 'update'));
}

reset();
const empty = answer('zz-merge', '');
check('nothing piped in is refused before any read', empty.code !== 0 && /nothing was piped in/.test(empty.err), empty.err);

/* ---------------------------------------------------------------------- the dry run */

reset();
const dry = answer('zz-merge', '- id: c1\n  answer: changed\n  note: done\n', ['-n']);
check('a dry run prints the comment it would leave', dry.code === 0 && /would answer 1 comment/.test(dry.out), dry.out);
check('and writes nothing', !calls().some((c) => c[0] === 'update' || c[0] === 'comment'));

/* ------------------------------------------------------- a bead with no review on it */

reset();
const w = world();
w.issues['zz-merge'].notes = withQueueBlock('', { attempts: 0 });
fs.writeFileSync(WORLD, JSON.stringify(w, null, 2));
const unreviewed = answer('zz-merge', '- id: c1\n  answer: changed\n  note: done\n');
check(
  'a pull request nothing has reviewed says so rather than inventing a comment to answer',
  unreviewed.code !== 0 && /nothing has reviewed #42/.test(unreviewed.err),
  unreviewed.err
);

await cleanupTmp(tmp);

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : '\n\x1b[32mall checks passed\x1b[0m\n');
process.exit(failures ? 1 : 0);
