#!/usr/bin/env node
/**
 * Handing a bead back when the window that claimed it is gone — bc-xl7n.85.
 *
 *     npm test
 *     node test/reassignguard.mjs
 *
 * bd 1.2.1 refuses to clear a claim from an actor that is not the holder. On every path
 * that puts a *worker's* bead back that is not an edge case, it is the whole of the
 * behaviour: the window claims its bead under the human's git identity as its first act,
 * every write beadcause makes is stamped `beadcause`, so actor and assignee never match
 * by construction. `Bd.reopen`'s three retries cannot help — nothing here is a race — and
 * a bead left `in_progress` and assigned is out of `bd ready` for good, which means the
 * only thing that would ever have retried it was the hand-back that just failed. Twenty
 * distinct beads had been refused in ~/Library/Logs/beadcause.log by 2026-08-17; four
 * were still sitting under no window at all, one of them for two days.
 *
 * Three things are asserted here, and they fail in three different ways:
 *
 *   - **the sentence** — `REASSIGN_GUARD_RE` matches what bd actually says, and neither
 *     it nor `CLAIM_GUARD_RE` matches the other's refusal. Both hand `--force` to their
 *     caller, so a regex that drifted wide would step over a live blocker or an epic's
 *     open children instead;
 *   - **the argv** — `reopenAbandoned` tries the plain write first and appends `--force`
 *     only when *that* refusal is what came back, while `reopen` itself never forces,
 *     because lib/jiragate.js reopens a ticket coming back off Jira whose claim may
 *     still be live and the guard is doing the job it was added for. lib/server.js's
 *     review path and `Bd.commission` were both on that list once and neither belonged
 *     there — bc-36xx.17 and bc-xl7n.88, the same mistake in the same shape twice: see
 *     test/handbackdelivery.mjs and test/answerclose.mjs, which drive each answer end to
 *     end against a bd that enforces the refusal;
 *   - **the binary**, at the bottom and skipped loudly where `bd` is not installed. The
 *     stub half above can only ever confirm what lib/bd.js already believes; that the
 *     plain reopen is refused *at all* is the belief the whole change rests on, and it is
 *     a claim about bd rather than about beadcause. Same shape as test/closegatereal.mjs.
 *
 * The last one is why the argv is asserted as a whole array rather than by a `--force`
 * substring: the flag on `bd update` lifts this guard *and* the gates around moving an
 * issue into a done status, so what makes it safe here is that the status it names is
 * pinned to `open`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const { Bd, CLAIM_GUARD_RE, REASSIGN_GUARD_RE, isClaimGuard, isReassignGuard } = await import(
  path.join(ROOT, 'lib', 'bd.js')
);

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
const check = async (name, fn) => {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, (err && err.message ? err.message : String(err)).split('\n')[0]);
  }
};

console.log('\nthe reassign guard, and the hand-back that has to step over it\n');

/* ------------------------------------------------------------------ the sentence */

// Verbatim from ~/Library/Logs/beadcause.log, 2026-08-17 — the refusal 23 hand-backs got.
const REFUSED_REASSIGN =
  'cannot reassign bc-xl7n.61: held by "neadamthal@gmail.com" (in_progress); coordinate with the ' +
  'holder (bd mail neadamthal@gmail.com) — pass --force only if their claim is abandoned (crashed ' +
  'agent, expired lease), or use bd reclaim';

// And the shape it arrives in: lib/bd.js wraps it with the argv it ran.
const WRAPPED =
  "bd update bc-xl7n.61 --status open --assignee  --actor beadcause (neadamthal@gmail.com) failed in " +
  `beadcause: ${REFUSED_REASSIGN}`;

const REFUSED_CLOSE =
  'cannot close bc-xl7n.39: assignee is "neadamthal@gmail.com", actor is "beadcause ' +
  '(neadamthal@gmail.com)"; reclaim or use --force to override';

await check('bd’s refusal to clear a claim is matched', () => {
  assert.ok(REASSIGN_GUARD_RE.test(REFUSED_REASSIGN));
  assert.ok(isReassignGuard(new Error(WRAPPED)), 'and matched through the wrapping lib/bd.js adds');
});

await check('it is read off either stream, like its neighbour', () => {
  const err = new Error('bd exited 1');
  err.stderr = REFUSED_REASSIGN;
  assert.ok(isReassignGuard(err));
  assert.equal(isReassignGuard(null), false, 'and nothing is not a refusal');
});

await check('a close refused over the same claim is not this', () => {
  // The two sentences share no wording at all, which is why they are two exports rather
  // than a third alternation in one. Widening `CLAIM_GUARD_RE` to cover the reassign
  // would hand `--force` to five close paths on a sentence none of them can produce.
  assert.equal(isReassignGuard(new Error(REFUSED_CLOSE)), false);
  assert.equal(isClaimGuard(new Error(REFUSED_REASSIGN)), false, 'and not the other way either');
  assert.ok(CLAIM_GUARD_RE.test(REFUSED_CLOSE), 'while each still matches its own');
});

await check('every refusal `--force` must never be reached for is refused', () => {
  // The whole objection to a wide regex: the caller's answer to a match is the flag, and
  // the flag lifts these too.
  for (const said of [
    'cannot close bc-w156: 3 open child issue(s); close children first or use --force to override',
    'cannot close bc-3muu.12: bc-3muu.12 is blocked by [bc-3muu.4]',
    'cannot close bc-xl7n: an epic closes when its theme is done, not on a merge reason',
    'dolt: database is locked',
    'cannot reassign bc-x: no such issue',
  ]) {
    assert.equal(isReassignGuard(new Error(said)), false, said);
  }
});

/* ---------------------------------------------------------------------- the argv */

const PLAIN = (id) => ['update', id, '--status', 'open', '--assignee', ''];
const FORCED = (id) => ['update', id, '--status', 'open', '--assignee', '', '--force'];

/** A `Bd` whose only real part is the method under test — `run` records and answers. */
function stub(answers) {
  const bd = new Bd({ bin: 'bd', actor: 'beadcause' });
  const calls = [];
  bd.run = async (_ws, args) => {
    calls.push(args);
    const answer = answers[calls.length - 1];
    if (answer instanceof Error) throw answer;
    return answer ?? '';
  };
  return { bd, calls };
}
const WS = { name: 'alpha', dir: '/nowhere/.beads' };

await check('an unheld bead is handed back with no flag at all', async () => {
  const { bd, calls } = stub([]);
  await bd.reopenAbandoned(WS, 'x-1');
  assert.deepEqual(calls, [PLAIN('x-1')], 'one write, and it is the one `reopen` has always made');
});

await check('the refusal, and only the refusal, escalates', async () => {
  const { bd, calls } = stub([new Error(WRAPPED)]);
  await bd.reopenAbandoned(WS, 'x-1');
  assert.deepEqual(calls, [PLAIN('x-1'), FORCED('x-1')]);
  // `--status open` is pinned by that deepEqual on purpose: `--force` on `bd update` lifts
  // this guard and the gates around moving an issue into a done status, and the reason it
  // is safe here is that the status it carries can never be one.
});

await check('any other refusal comes straight back, unforced', async () => {
  const { bd, calls } = stub([new Error('dolt: database is locked')]);
  await assert.rejects(() => bd.reopenAbandoned(WS, 'x-1'), /database is locked/);
  assert.deepEqual(calls, [PLAIN('x-1')], 'a lock is not an abandoned claim');
});

await check('a second refusal is not forced twice', async () => {
  const { bd, calls } = stub([new Error(WRAPPED), new Error(WRAPPED)]);
  await assert.rejects(() => bd.reopenAbandoned(WS, 'x-1'), /cannot reassign/);
  assert.equal(calls.length, 2, 'it steps over the guard once and then reports');
});

await check('`reopen` itself never forces — the one remaining live-holder path keeps its guard', async () => {
  // lib/jiragate.js reopens a ticket coming back off Jira, and there the holder may
  // still be typing. bc-xl7n.85 is explicit that force belongs at the call site that
  // has established the window is gone.
  //
  // This list used to name lib/server.js's "changes requested" path (bc-36xx.17) and
  // then `Bd.commission` (bc-xl7n.88) as such cases, and both were the same mistake: a
  // worker delivers and stops, so by the time an answer comes back the holder is always
  // gone. The assertion below is unchanged — `reopen` still never forces — but the
  // reason it is safe is now about who calls it, not about either retired path.
  const { bd, calls } = stub([new Error(WRAPPED)]);
  await assert.rejects(() => bd.reopen(WS, 'x-1'), /cannot reassign/);
  assert.deepEqual(calls, [PLAIN('x-1')]);
});

/* ----------------------------------------------------------------- the call sites */

/** Comments blanked to spaces, so prose naming an argv is not read as one. */
function code(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + m.slice(p.length).replace(/./g, ' '));
}

await check('nothing outside lib/bd.js spells the hand-back out for itself', () => {
  // The bug was a hand-rolled argv in two places — lib/advocate.js went through `reopen`,
  // bin/plan.js wrote the array itself — so neither had anywhere to put the escalation.
  // Whoever writes the third one should get this failure rather than 20 stranded beads.
  const spelt = /'--status',\s*'open',\s*'--assignee'/;
  for (const file of ['lib/advocate.js', 'bin/plan.js', 'lib/server.js', 'lib/mergequeue.js']) {
    assert.equal(spelt.test(code(file)), false, `${file} builds the reopen argv itself`);
  }
  assert.ok(spelt.test(code('lib/bd.js')), 'while lib/bd.js, which owns it, still does');
});

await check('every path that releases a dead window’s claim asks for the abandoned one', () => {
  assert.match(code('lib/advocate.js'), /bd\.reopenAbandoned\(a\.workspace, w\.id\)/);
  assert.match(code('bin/plan.js'), /bd\.reopenAbandoned\(ws, epicId\)/);
  // bc-36xx.17. Both answers that end an attempt without ending the work — `changes` and
  // `decline` — go through one helper, and the helper is the only thing in lib/server.js
  // that reopens a work bead. Asserted as "there is exactly one call, and it is the
  // abandoned one", because the failure this replaces was a second call site nobody
  // noticed had the same problem.
  const server = code('lib/server.js');
  assert.match(server, /await bd\.reopenAbandoned\(ws, bead\)/, 'the helper forces when the guard is what refused');
  assert.equal((server.match(/bd\.reopen\(/g) || []).length, 0, 'and nothing there calls the plain reopen any more');
  assert.equal(
    (server.match(/await handBackWorkBead\(ws, /g) || []).length,
    2,
    'both the changes path and the decline path go through it'
  );
  // bc-xl7n.88. `commission` is `Bd`'s own reopen call, and it made the identical
  // mistake in the identical shape: a plain `reopen` refused on the ordinary case, not
  // the edge case, because the assignee it is clearing is always a window that has
  // already stopped.
  const bdSrc = code('lib/bd.js');
  assert.match(bdSrc, /await this\.reopenAbandoned\(workspace, id\);/, 'commission asks for the abandoned reopen');
});

/* ------------------------------------------------------------------- the binary */

const bdOnPath = !spawnSync('bd', ['version'], { encoding: 'utf8' }).error;
if (!bdOnPath) {
  console.log('  \x1b[33m—\x1b[0m skipped: no `bd` on PATH, so what it refuses cannot be asked here');
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-reassignguard-'));
  const dir = path.join(tmp, '.beads');
  fs.mkdirSync(dir, { recursive: true });

  // Spawned directly, never through a shell: `~/.zshenv` rewrites BEADS_DIR from the
  // shell's cwd, so a shell here would resolve to somebody's actual tracker and this
  // file *takes claims off beads*. Same reason lib/bd.js uses execFile.
  const env = { ...process.env, BEADS_DIR: dir };
  const raw = (args) => spawnSync('bd', args, { env, cwd: tmp, encoding: 'utf8', timeout: 120_000 });

  const init = raw(['init', '--skip-agents', '--prefix', 'rg']);
  if (init.status !== 0) {
    bad('a temp workspace can be made to ask in', (init.stderr || init.stdout || '').split('\n')[0]);
  } else {
    const bd = new Bd({ bin: 'bd', actor: 'beadcause' });
    const ws = { name: 'reassignguard', dir };
    // The two identities the whole bug is made of: a window claims as the human, and
    // every write beadcause makes is its own.
    const HOLDER = 'a-window@example.invalid';
    const claimed = async (title) => {
      const id = await bd.create(ws, { title, body: 'x', priority: 2, type: 'task', labels: [] });
      raw(['update', id, '--status', 'in_progress', '--assignee', HOLDER, '--actor', HOLDER]);
      return id;
    };
    const row = (id) => {
      const rows = JSON.parse(raw(['show', id, '--json']).stdout);
      return (Array.isArray(rows) ? rows : rows.issues || [])[0] || null;
    };

    await check('bd refuses the plain hand-back, in the words the regex is cut from', async () => {
      const id = await claimed('a bead whose window is gone');
      const err = await bd.reopen(ws, id).then(
        () => null,
        (e) => e
      );
      assert.ok(err, 'the write is refused rather than quietly ignored');
      assert.ok(isReassignGuard(err), `bd said: ${String(err.message).split('\n')[0]}`);
      assert.equal(row(id).status, 'in_progress', 'and the bead is exactly where it was');
    });

    await check('and `reopenAbandoned` gets it back into `bd ready`', async () => {
      const id = await claimed('a bead handed back over the guard');
      await bd.reopenAbandoned(ws, id);
      const after = row(id);
      assert.equal(after.status, 'open', 'open');
      assert.ok(!after.assignee, `and unassigned — both halves, or \`bd ready\` still skips it (${after.assignee})`);
    });

    await check('a bead nobody is holding needs no flag to come back', async () => {
      // The lazy path's other half: `reopenAbandoned` is not a louder `reopen`, and on the
      // ordinary case it makes exactly the write it always made.
      const id = await bd.create(ws, { title: 'a bead nobody claimed', body: 'x', priority: 2, type: 'task', labels: [] });
      await bd.run(ws, ['update', id, '--status', 'in_progress']);
      await bd.reopenAbandoned(ws, id);
      assert.equal(row(id).status, 'open');
    });

    // bc-xl7n.88: the other half of the same guard, hit on the answer path rather than
    // the hand-back. A question is `in_progress` from the moment a worker claims it —
    // `closeAnswered`'s bare `--assignee ''` clear and `commission`'s reopen both
    // reassign away from that holder, and both used to be refused every time.

    await check('a claimed question closes anyway, and the clear that took no flag before now needs one', async () => {
      const id = await claimed('a claimed question, answered');
      const err = await bd.run(ws, ['update', id, '--assignee', ''], { actor: 'beadcause' }).then(
        () => null,
        (e) => e
      );
      assert.ok(isReassignGuard(err), `the bare clear is refused while it is in_progress: ${String(err?.message).split('\n')[0]}`);

      await bd.closeAnswered(ws, id, 'Answered via Beadcause', { actor: 'beadcause' });
      const after = row(id);
      assert.equal(after.status, 'closed', 'closeAnswered gets past the guard it just hit');
      assert.ok(!after.assignee, 'and the claim is gone, not merely forced past');
    });

    await check('a commissioned question reopens anyway, over the same guard', async () => {
      const id = await claimed('a claimed question, commissioned');
      const err = await bd.reopen(ws, id).then(
        () => null,
        (e) => e
      );
      assert.ok(isReassignGuard(err), `the plain reopen commission used to call is refused the same way: ${String(err?.message).split('\n')[0]}`);

      await bd.commission(ws, id, 'Build both as written.');
      const after = row(id);
      assert.equal(after.status, 'open', 'open');
      assert.ok(!after.assignee, 'and unassigned — back in `bd ready`, not stranded like bc-xl7n.85');
    });
  }

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
