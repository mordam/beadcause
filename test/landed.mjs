#!/usr/bin/env node
/**
 * A pull request merged on github.com, and the bead nothing closed.
 *
 *     npm test
 *     node test/landed.mjs
 *
 * beadcause closes a bead on the two paths where it performs the merge itself: the tap
 * on a delivery card, and a worker merging its own pull request. The merge button on
 * github.com is neither, so the bead stayed open, stayed in `bd ready`, and the advocate
 * kept opening sessions on work already in `main` — bc-4irq cost two of them, the second
 * of which existed only to discover the first had landed.
 *
 * Four things are worth asserting, and they are in descending order of what they cost:
 *
 * 1. **The tick does not open a session on landed work.** The whole bead. It is checked
 *    against a spy rather than against iTerm, and the spy is also what makes the test
 *    safe: an assertion that no window opened is worthless if the way it fails is by
 *    opening one. The control case — the same tick with the sweep switched off — is
 *    asserted too, because "no session opened" passes for a dozen uninteresting reasons
 *    and only one of them is the feature.
 * 2. **A bead that already said it landed is left alone.** `bd` clears `closed_at` on
 *    reopen, so an open bead carrying `Landed as [#42](…)` is the only trace of a human
 *    reopening something this closed. Closing it again would not be a bug so much as a
 *    fight: reopen, swept closed, reopen, swept closed.
 * 3. **A refused close writes nothing.** The comment is what the guard above reads, so a
 *    comment left on a bead whose close then failed would blind this to that bead
 *    permanently. The gate is asked before a word is written.
 * 4. **The question closes before the work bead.** A delivery parks its bead behind its
 *    card with `bd dep add`, and bd refuses to close a bead with an open blocker — so
 *    the wrong order fails on precisely the case that most needs this.
 *
 * `gh` is a fake shell script answering three questions; `bd` is an object that records
 * what it was asked to write. Nothing here reaches GitHub, a tracker, iTerm or a repo of
 * yours.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-landed-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

// Before the first import that reaches lib/config.js, which fixes CONFIG_DIR at module
// load: the advocate state file below must land in the temp directory and not in the
// one this Mac actually runs from.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const BIN = path.join(tmp, 'bin');
const REPO = path.join(tmp, 'repo');
const PRS = path.join(tmp, 'prs.json');
for (const d of [BIN, REPO]) fs.mkdirSync(d, { recursive: true });

fs.writeFileSync(PRS, '[]');
fs.writeFileSync(
  path.join(BIN, 'gh'),
  `#!/bin/sh
case "$1 $2" in
  "auth status") exit 0 ;;
  "repo view") echo '{"nameWithOwner":"mordam/widgets"}' ; exit 0 ;;
  "pr list") cat ${JSON.stringify(PRS)} ; exit 0 ;;
esac
echo "unexpected gh: $*" >&2
exit 1
`,
  { mode: 0o755 }
);
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;

const { reconcileLanded, landedReason } = await import(LIB('landed.js'));
const { forgetPrefixes } = await import(LIB('beadref.js'));

/* ------------------------------------------------------------------ harness */

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
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

/** A merged pull request in `gh pr list --json` vocabulary — what the fake gh serves. */
const mergedRow = (over = {}) => ({
  number: 42,
  url: 'https://github.com/mordam/widgets/pull/42',
  title: 'wg-aaa: fix the thing',
  state: 'MERGED',
  headRefName: 'worktree-fix-the-thing-aaa',
  baseRefName: 'main',
  body: 'Closes wg-aaa once merged.',
  mergedAt: new Date().toISOString(),
  mergeCommit: { oid: 'abc1234def5678' },
  statusCheckRollup: [],
  ...over,
});

/**
 * The same row after lib/pr.js has folded it — which is the only shape `reconcileLanded`
 * ever sees, because `pr.list` is what feeds it.
 *
 * Written out rather than imported so the cases below are honest about the contract:
 * `mergeCommit` is an *object* on the wire and a string by the time anything reads it,
 * and a fixture that skipped the fold let a `[object Object]` into a close reason here
 * before anyone noticed.
 */
const asListed = (row) => ({
  number: row.number,
  url: row.url,
  title: row.title,
  state: String(row.state || '').toUpperCase(),
  branch: row.headRefName || '',
  base: row.baseRefName || '',
  body: row.body || '',
  mergedAt: row.mergedAt || null,
  mergeCommit: row.mergeCommit?.oid || null,
});

/**
 * A tracker that answers and records, with one bead per id.
 *
 * `writes` is the whole assertion surface: every close and comment in the order it was
 * asked for, which is how the ordering claim (question before work bead) is checked
 * without a real bd to refuse it.
 */
function fakeBd(beads, { gate = () => null, comments = () => [], questions = [] } = {}) {
  const rows = new Map(beads.map((b) => [b.id, { status: 'open', title: '', ...b }]));
  const writes = [];
  return {
    writes,
    rows,
    async json(_ws, args) {
      // Only `prefixFor` asks, and only for one row: the id's prefix is the answer.
      if (args[0] === 'list') return [{ id: 'wg-1' }];
      return [];
    },
    async show(_ws, id) {
      return rows.get(id) || null;
    },
    async comments(_ws, id) {
      return comments(id);
    },
    async listLabel() {
      return questions;
    },
    async closeGate(_ws, id) {
      return gate(id);
    },
    async comment(_ws, id, text) {
      writes.push({ kind: 'comment', id, text });
    },
    async close(_ws, id, reason) {
      const refusal = gate(id);
      if (refusal) throw new Error(refusal);
      writes.push({ kind: 'close', id, reason });
      const row = rows.get(id);
      if (row) row.status = 'closed';
    },
    async ready() {
      return [...rows.values()]
        .filter((r) => r.status === 'open' && !(r.labels || []).includes('human'))
        .map((r) => ({ id: r.id, title: r.title, priority: 1, created_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-01T00:00:00Z' }));
    },
  };
}

const ws = (name) => ({ name, dir: path.join(tmp, 'beads', name, '.beads') });

/* ------------------------------------------------- the sweep, on its own */

console.log('\nreconcileLanded');

{
  forgetPrefixes();
  const bd = fakeBd([{ id: 'wg-aaa', title: 'fix the thing' }]);
  const result = await reconcileLanded(bd, ws('one'), REPO, { rows: [asListed(mergedRow())] });
  const closed = bd.writes.filter((w) => w.kind === 'close');
  const said = bd.writes.find((w) => w.kind === 'comment');

  check('an open bead whose PR merged is closed', closed.length === 1 && closed[0].id === 'wg-aaa', JSON.stringify(bd.writes));
  check(
    'the close reason names the PR, the commit and where it merged',
    /#42/.test(closed[0]?.reason || '') && /abc1234/.test(closed[0]?.reason || '') && /on GitHub/.test(closed[0]?.reason || ''),
    closed[0]?.reason
  );
  check('and a comment says so on the bead', /Landed as \[#42\]/.test(said?.text || ''), said?.text);
  check('the result names what it closed', result.closed.length === 1 && result.closed[0].id === 'wg-aaa', JSON.stringify(result));
  check('the sweep reports itself as having run', result.ok === true && result.checked === 1, JSON.stringify(result));
}

{
  forgetPrefixes();
  // The regression that makes this a fight rather than a bug: closed once, reopened by
  // hand, and the comment from the first close is the only evidence that happened.
  const bd = fakeBd([{ id: 'wg-aaa' }], {
    comments: () => [{ text: 'Landed as [#42 as abc1234](https://github.com/mordam/widgets/pull/42) — merged.' }],
  });
  await reconcileLanded(bd, ws('two'), REPO, { rows: [asListed(mergedRow())] });
  check('a bead closed on this PR once and reopened is left alone', bd.writes.length === 0, JSON.stringify(bd.writes));
}

{
  forgetPrefixes();
  // The near-miss of the case above: "Delivered as #42" is a bead *waiting* on a card
  // about #42, which is exactly what should close when #42 turns out to have merged.
  const bd = fakeBd([{ id: 'wg-aaa' }], {
    comments: () => [{ text: 'Delivered as [#42](https://github.com/mordam/widgets/pull/42) on `worktree-fix-the-thing-aaa`.' }],
  });
  await reconcileLanded(bd, ws('three'), REPO, { rows: [asListed(mergedRow())] });
  check('but a bead only *delivered* on it still closes', bd.writes.some((w) => w.kind === 'close'), JSON.stringify(bd.writes));
}

{
  forgetPrefixes();
  const bd = fakeBd([{ id: 'wg-aaa', status: 'closed' }]);
  await reconcileLanded(bd, ws('four'), REPO, { rows: [asListed(mergedRow())] });
  check('an already-closed bead is not written to again', bd.writes.length === 0, JSON.stringify(bd.writes));
}

{
  forgetPrefixes();
  const bd = fakeBd([{ id: 'wg-aaa' }]);
  const result = await reconcileLanded(bd, ws('five'), REPO, { rows: [asListed(mergedRow({ state: 'OPEN', mergedAt: null }))] });
  check('an open PR closes nothing', bd.writes.length === 0 && result.checked === 0, JSON.stringify(bd.writes));
}

{
  forgetPrefixes();
  const old = new Date(Date.now() - 60 * 86400000).toISOString();
  const bd = fakeBd([{ id: 'wg-aaa' }]);
  const result = await reconcileLanded(bd, ws('six'), REPO, { rows: [asListed(mergedRow({ mergedAt: old }))] });
  check(
    'a merge from two months ago is skipped, and says it was',
    bd.writes.length === 0 && result.skipped.some((s) => /days ago/.test(s.why)),
    JSON.stringify(result)
  );
}

{
  forgetPrefixes();
  // The guard behind the guard. A close bd refuses must leave no comment, or the next
  // sweep reads its own "Landed as #42" and skips this bead for good.
  const bd = fakeBd([{ id: 'wg-aaa' }], { gate: (id) => (id === 'wg-aaa' ? 'blocked by 1 open issue' : null) });
  const result = await reconcileLanded(bd, ws('seven'), REPO, { rows: [asListed(mergedRow())] });
  check('a close bd would refuse writes nothing at all', bd.writes.length === 0, JSON.stringify(bd.writes));
  check('and the refusal travels back in bd’s own words', result.skipped.some((s) => /blocked by/.test(s.why)), JSON.stringify(result));
}

{
  forgetPrefixes();
  const questions = [
    {
      id: 'wg-card',
      status: 'open',
      description: 'Merge #42?\n\n```beadpr\nworkspace: widgets\nbead: wg-aaa\nnumber: 42\nurl: https://github.com/mordam/widgets/pull/42\nbranch: worktree-fix-the-thing-aaa\nbase: main\nmethod: merge\n```',
    },
  ];
  const bd = fakeBd([{ id: 'wg-aaa' }], { questions });
  await reconcileLanded(bd, ws('eight'), REPO, { rows: [asListed(mergedRow())] });
  const order = bd.writes.filter((w) => w.kind === 'close').map((w) => w.id);
  check('the stale delivery card closes too', order.includes('wg-card'), JSON.stringify(bd.writes));
  check(
    'and it closes before the bead it blocks, or bd would refuse that close',
    order.indexOf('wg-card') === 0 && order.indexOf('wg-aaa') === 1,
    JSON.stringify(order)
  );
}

check(
  'landedReason is one sentence naming the PR, the commit and the base',
  landedReason({ number: 7, mergeCommit: 'deadbeefcafe' }, 'main') === 'Merged #7 as deadbeef into main on GitHub',
  landedReason({ number: 7, mergeCommit: 'deadbeefcafe' }, 'main')
);

/* ---------------------------------------------------- and through the tick */

console.log('\nthe advocate tick');

const { createAdvocates } = await import(LIB('advocate.js'));

/**
 * One tick, with the launcher replaced by a spy.
 *
 * `open` is injected rather than stubbed through the module system for a reason worth
 * stating: the real one drives iTerm, and a test asserting that no window opened must
 * not be able to fail by opening one.
 */
async function tickWith(bd, { reconcileLanded: on = true } = {}) {
  const workspace = { name: 'widgets', dir: path.join(tmp, 'beads', 'widgets', '.beads') };
  const opened = [];
  const cfg = {
    workspaces: [workspace],
    spaces: [],
    claudeSessions: false,
    sessionDirs: { widgets: REPO },
    pr: { enabled: true, base: 'main' },
    advocates: {
      enabled: true,
      workspaces: ['*'],
      settleSeconds: 0,
      launchCooldownSeconds: 0,
      // Off: they are other features with their own suites, and both would otherwise
      // run real git and a real agent against a temp directory on every case here.
      tidyWorktrees: false,
      propose: false,
      respectQuietHours: false,
      sessionLog: false,
      reconcileLanded: on,
    },
  };
  const advocates = createAdvocates(cfg, {
    bd,
    bus: { emit() {} },
    open: async (_cfg, _ws, bead) => {
      opened.push(bead.id);
      return { dir: REPO, mode: 'test', term: null };
    },
  });
  await advocates.tick();
  return { opened, advocates };
}

fs.writeFileSync(PRS, JSON.stringify([mergedRow()]));

{
  forgetPrefixes();
  const bd = fakeBd([{ id: 'wg-aaa', title: 'fix the thing' }]);
  const { opened } = await tickWith(bd);
  check('the tick closes the bead whose PR merged on GitHub', bd.rows.get('wg-aaa').status === 'closed', JSON.stringify(bd.writes));
  check('and opens no session on it', opened.length === 0, `opened: ${opened.join(', ')}`);
}

{
  forgetPrefixes();
  // The control. Without this the case above passes for any reason at all — a cooldown,
  // a settle window, a config typo — and would keep passing with the feature removed.
  const bd = fakeBd([{ id: 'wg-aaa', title: 'fix the thing' }]);
  const { opened } = await tickWith(bd, { reconcileLanded: false });
  check('with the sweep off, that same tick does open one', opened.includes('wg-aaa'), `opened: ${opened.join(', ')}`);
  check('and the bead is still open', bd.rows.get('wg-aaa').status === 'open');
}

console.log(`\n${ran - failures}/${ran} passed`);
process.exit(failures ? 1 : 0);
