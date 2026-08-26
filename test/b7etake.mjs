#!/usr/bin/env node
/**
 * `b7e-take` — take a bead a studio role is holding. lib/take.js, lib/bd.js's new
 * `CLAIM_ROLE_GUARD_RE`/`claimedBy`/`casAssign`, and bin/b7e-take.
 *
 *     npm test
 *     node test/b7etake.mjs
 *
 * bc-dgx7.97's own acceptance criteria are what this replays: a bead held by a name in
 * the workspace's own role roster is taken and left `in_progress`; a bead held by a
 * name outside that roster is refused, by name — the "live window" case, since bd's
 * own wording never tells a role apart from a real claim; the roster is read from the
 * calling checkout (`ai-context/agents/`), never hardcoded; and a test drives all
 * three of `lib/bd.js`'s claim-refusal wordings from fixtures — the two existing ones
 * (`CLAIM_GUARD_RE`, `REASSIGN_GUARD_RE`) checked to prove the new one never misreads
 * either, alongside the new one this bead actually added.
 *
 * Same shape as test/b7ehandback.mjs: a fake `bd` reading a small mutable `world.json`,
 * spawned for real through `bin/b7e-take`, because the CLI's own argv handling is the
 * one part of this a worker actually runs. The role roster is a real filesystem fixture
 * (`ai-context/agents/<role>/` under a scratch checkout), not a JSON stand-in, so
 * `lib/take.js`'s `rolesOf` is exercised exactly the way it reads a real repo.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';
import { CLAIM_GUARD_RE, REASSIGN_GUARD_RE, CLAIM_ROLE_GUARD_RE, claimedBy, isClaimGuard, isReassignGuard } from '../lib/bd.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let failures = 0;
let ran = 0;
const check = (name, fn) => {
  ran += 1;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.message).split('\n').slice(0, 6).join('\n      ')}`);
  }
};

console.log('\nb7e-take — take a bead a studio role is holding\n');

// ---------------------------------------------------------------------------------
// The three bd refusal wordings, from fixtures — no fake bd needed for this half,
// just the exported regexes/functions and the exact sentences bd 1.2.1 says.
// ---------------------------------------------------------------------------------

const CLAIM_ROLE_FIXTURE =
  'bd update dv-b5d.24 --claim --actor neadamthal@gmail.com failed in deluvia: ' +
  'issue already claimed: already assigned to "sinew"\n' +
  'coordinate with the holder; if their claim is abandoned (crashed agent), lease ' +
  'expiry will surface it for bd reclaim';

const CLOSE_GUARD_FIXTURE =
  'bd close bc-xl7n.36 --actor beadcause failed in beadcause: ' +
  'cannot close bc-xl7n.36: assignee is "neadamthal@gmail.com", actor is ' +
  '"beadcause (neadamthal@gmail.com)"; reclaim or use --force to override';

const REASSIGN_GUARD_FIXTURE =
  'bd update bc-xl7n.61 --actor beadcause failed in beadcause: ' +
  'cannot reassign bc-xl7n.61: held by "neadamthal@gmail.com" (in_progress); ' +
  'coordinate with the holder (bd mail neadamthal@gmail.com) — pass --force only if ' +
  'their claim is abandoned (crashed agent, expired lease), or use bd reclaim';

check('CLAIM_ROLE_GUARD_RE matches the new wording and claimedBy names the role', () => {
  assert.ok(CLAIM_ROLE_GUARD_RE.test(CLAIM_ROLE_FIXTURE));
  assert.equal(claimedBy(new Error(CLAIM_ROLE_FIXTURE)), 'sinew');
});

check('the new wording is not misread as the close guard or the reassign guard', () => {
  assert.equal(isClaimGuard(new Error(CLAIM_ROLE_FIXTURE)), false);
  assert.equal(isReassignGuard(new Error(CLAIM_ROLE_FIXTURE)), false);
});

check('the close guard fixture matches CLAIM_GUARD_RE and nothing else', () => {
  assert.ok(CLAIM_GUARD_RE.test(CLOSE_GUARD_FIXTURE));
  assert.equal(isReassignGuard(new Error(CLOSE_GUARD_FIXTURE)), false);
  assert.equal(claimedBy(new Error(CLOSE_GUARD_FIXTURE)), null, 'no "already assigned to" in this sentence');
});

check('the reassign guard fixture matches REASSIGN_GUARD_RE and nothing else', () => {
  assert.ok(REASSIGN_GUARD_RE.test(REASSIGN_GUARD_FIXTURE));
  assert.equal(isClaimGuard(new Error(REASSIGN_GUARD_FIXTURE)), false);
  assert.equal(claimedBy(new Error(REASSIGN_GUARD_FIXTURE)), null, 'no "already assigned to" in this sentence either');
});

// ---------------------------------------------------------------------------------
// The CLI, against a fake bd and a real ai-context/agents/ fixture.
// ---------------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7etake-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const FAKE_BD = path.join(tmp, 'bd');
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const raw = process.argv.slice(2);
const actorAt = raw.indexOf('--actor');
const actor = actorAt > -1 ? raw[actorAt + 1] : '';
const args = raw.filter((a, i, all) => a !== '--actor' && all[i - 1] !== '--actor');
const WORLD = path.join(process.env.BEADS_DIR, 'world.json');
const w = JSON.parse(fs.readFileSync(WORLD, 'utf8'));
const save = () => fs.writeFileSync(WORLD, JSON.stringify(w, null, 2));
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
w.calls.push(args.join(' '));
save();
for (const [match, message] of Object.entries(w.refuse || {})) {
  if (args.join(' ').includes(match)) die(message);
}
const flagEq = (name) => {
  const hit = args.find((a) => a.startsWith(name + '='));
  return hit ? hit.slice(name.length + 1) : undefined;
};
const flagVal = (name) => {
  const at = args.indexOf(name);
  return at > -1 ? args[at + 1] : undefined;
};
if (args[0] === 'show') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error fetching ' + args[1] + ': no issue found');
  process.stdout.write(JSON.stringify([issue]));
  process.exit(0);
}
if (args[0] === 'update') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  const ifAssignee = flagEq('--if-assignee');
  const assignee = flagEq('--assignee');
  const claim = args.includes('--claim');
  if (claim) {
    if (issue.assignee && issue.assignee !== actor) {
      die('issue already claimed: already assigned to "' + issue.assignee + '"\\ncoordinate with the holder; if their claim is abandoned (crashed agent), lease expiry will surface it for bd reclaim');
    }
    issue.assignee = actor;
    issue.status = 'in_progress';
    save();
    process.exit(0);
  }
  if (ifAssignee !== undefined) {
    if (issue.assignee !== ifAssignee) {
      die('precondition guard did not match; nothing was written, so re-read the row and recompose the request rather than retrying it');
    }
    if (assignee !== undefined) issue.assignee = assignee;
    const status = flagVal('--status');
    if (status) issue.status = status;
    const addLabel = flagVal('--add-label');
    if (addLabel) issue.labels = [...(issue.labels || []), addLabel];
    const removeLabel = flagVal('--remove-label');
    if (removeLabel) issue.labels = (issue.labels || []).filter((l) => l !== removeLabel);
    save();
    process.exit(0);
  }
  process.exit(0);
}
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const checkoutDir = path.join(tmp, 'checkout');
const wsDir = path.join(checkoutDir, '.beads');
fs.mkdirSync(wsDir, { recursive: true });

// The role roster this checkout names — a real fixture, read by lib/take.js's
// rolesOf exactly the way it would read deluvia's own ai-context/agents/.
for (const role of ['sinew', 'vox', 'aria']) {
  fs.mkdirSync(path.join(checkoutDir, 'ai-context', 'agents', role), { recursive: true });
}

fs.writeFileSync(
  path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'),
  JSON.stringify(
    {
      bdBin: FAKE_BD,
      actor: 'beadcause-test',
      workspaces: [{ name: 'demo', dir: wsDir }],
    },
    null,
    2
  )
);

const worldFile = path.join(wsDir, 'world.json');
const issue = (id, extra = {}) => ({
  id,
  title: `bead ${id}`,
  status: 'open',
  issue_type: 'task',
  assignee: '',
  labels: [],
  ...extra,
});
const reset = (extra = {}) =>
  fs.writeFileSync(
    worldFile,
    JSON.stringify(
      {
        calls: [],
        refuse: {},
        issues: {
          'zz-unheld': issue('zz-unheld'),
          'zz-role': issue('zz-role', { assignee: 'sinew' }),
          'zz-outsider': issue('zz-outsider', { assignee: 'someone@example.com', status: 'in_progress' }),
          'zz-mine': issue('zz-mine', { assignee: 'beadcause-test', status: 'in_progress' }),
          'zz-taken': issue('zz-taken', { assignee: 'beadcause-test', status: 'in_progress', labels: ['taken-from:vox'] }),
          'zz-closed': issue('zz-closed', { status: 'closed' }),
        },
        ...extra,
      },
      null,
      2
    )
  );

const world = () => JSON.parse(fs.readFileSync(worldFile, 'utf8'));

/** The command, run exactly as a worker brief would print it — cwd inside the checkout, matching how repoRoot resolves. */
const take = (args) => {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'b7e-take'), '-w', 'demo', ...args], {
    encoding: 'utf8',
    cwd: checkoutDir,
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: process.env.BEADCAUSE_CONFIG_DIR },
  });
  if (res.error) throw res.error;
  return { status: res.status, out: res.stdout || '', err: res.stderr || '' };
};

check('an unassigned bead is claimed plainly', () => {
  reset();
  const { status, out } = take(['-b', 'zz-unheld']);
  assert.equal(status, 0, out);
  const w = world();
  assert.equal(w.issues['zz-unheld'].assignee, 'beadcause-test');
  assert.equal(w.issues['zz-unheld'].status, 'in_progress');
  assert.match(out, /was unassigned/);
});

check('a bead already held by a recognised role is taken, in_progress, role recorded', () => {
  reset();
  const { status, out } = take(['-b', 'zz-role']);
  assert.equal(status, 0, out);
  const w = world();
  assert.equal(w.issues['zz-role'].assignee, 'beadcause-test');
  assert.equal(w.issues['zz-role'].status, 'in_progress');
  assert.deepEqual(w.issues['zz-role'].labels, ['taken-from:sinew']);
  assert.match(out, /taken from "sinew"/);
  const updates = w.calls.filter((c) => c.startsWith('update'));
  assert.equal(updates.length, 1, 'one atomic write, not a plain --claim followed by a fix-up');
  assert.match(updates[0], /--if-assignee=sinew/);
});

check('a bead held by a name outside the roster is refused by name — the live-window case', () => {
  reset();
  const { status, err } = take(['-b', 'zz-outsider']);
  assert.notEqual(status, 0);
  assert.match(err, /held by "someone@example\.com".*not a name in this workspace's role roster/);
  const w = world();
  assert.equal(w.issues['zz-outsider'].assignee, 'someone@example.com', 'nothing was written');
  assert.deepEqual(
    w.calls.filter((c) => c.startsWith('update')),
    []
  );
});

check('a bead already held by this same actor is idempotent', () => {
  reset();
  const { status, out } = take(['-b', 'zz-mine']);
  assert.equal(status, 0, out);
  assert.match(out, /was unassigned/, 'the plain --claim path, same as unheld — bd itself treats it as idempotent');
  assert.equal(world().issues['zz-mine'].assignee, 'beadcause-test');
});

check('a closed bead is refused — there is nothing to take', () => {
  reset();
  const { status, err } = take(['-b', 'zz-closed']);
  assert.notEqual(status, 0);
  assert.match(err, /is closed/);
  assert.deepEqual(
    world().calls.filter((c) => !c.startsWith('show')),
    []
  );
});

check('--dry-run decides and reports without writing anything', () => {
  reset();
  const { status, out } = take(['-b', 'zz-role', '--dry-run']);
  assert.equal(status, 0, out);
  assert.match(out, /dry run, nothing written/);
  const w = world();
  assert.equal(w.issues['zz-role'].assignee, 'sinew', 'unchanged');
  assert.deepEqual(
    w.calls.filter((c) => c.startsWith('update')),
    []
  );
});

check('--release hands a taken bead back to the role it came from', () => {
  reset();
  const { status, out } = take(['-b', 'zz-taken', '--release']);
  assert.equal(status, 0, out);
  const w = world();
  assert.equal(w.issues['zz-taken'].assignee, 'vox');
  assert.equal(w.issues['zz-taken'].status, 'open');
  assert.deepEqual(w.issues['zz-taken'].labels, []);
  assert.match(out, /released back to "vox"/);
});

check('--release on a bead this command never took is refused', () => {
  reset();
  const { status, err } = take(['-b', 'zz-mine', '--release']);
  assert.notEqual(status, 0);
  assert.match(err, /carries no taken-from:/);
});

check('a lost race on the atomic write is reported, not retried', () => {
  reset({
    issues: {
      'zz-role': issue('zz-role', { assignee: 'sinew' }),
    },
    refuse: { '--if-assignee=sinew': 'precondition guard did not match; nothing was written, so re-read the row and recompose the request rather than retrying it' },
  });
  const { status, err } = take(['-b', 'zz-role']);
  assert.notEqual(status, 0);
  assert.match(err, /somebody else won the race/);
  const updates = world().calls.filter((c) => c.startsWith('update'));
  assert.equal(updates.length, 1, 'no retry against the same stale guard');
});

check('an unknown workspace is refused, checked against the CLI itself, not just the fake', () => {
  reset();
  const res = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'b7e-take'), '-w', 'nowhere', '-b', 'zz-role'], {
    encoding: 'utf8',
    cwd: checkoutDir,
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: process.env.BEADCAUSE_CONFIG_DIR },
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /no workspace named "nowhere"/);
});

check('--json carries the same facts the printed report does', () => {
  reset();
  const { status, out } = take(['-b', 'zz-role', '--json']);
  assert.equal(status, 0, out);
  const payload = JSON.parse(out);
  assert.equal(payload.bead, 'zz-role');
  assert.equal(payload.role, 'sinew');
  assert.equal(payload.ok, true);
  assert.equal(payload.row.assignee, 'beadcause-test');
});

check('a workspace naming no ai-context/agents directory refuses every held bead, conservatively', () => {
  const bareDir = path.join(tmp, 'bare');
  const bareWs = path.join(bareDir, '.beads');
  fs.mkdirSync(bareWs, { recursive: true });
  fs.writeFileSync(
    path.join(bareWs, 'world.json'),
    JSON.stringify({ calls: [], refuse: {}, issues: { 'zz-role': issue('zz-role', { assignee: 'sinew' }) } }, null, 2)
  );
  const cfgFile = path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.workspaces.push({ name: 'bare', dir: bareWs });
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  const res = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'b7e-take'), '-w', 'bare', '-b', 'zz-role'], {
    encoding: 'utf8',
    cwd: bareDir,
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: process.env.BEADCAUSE_CONFIG_DIR },
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /not a name in this workspace's role roster/);
});

console.log(`\n${ran - failures}/${ran} passed`);
cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
