#!/usr/bin/env node
/**
 * `external_ref` against the binary that has to store it — does bd actually keep this?
 *
 *     npm test
 *     node test/jiraepicreal.mjs
 *
 * test/jiraepic.mjs proves the filer decides correctly. It cannot prove the one thing the
 * whole feature rests on, because its `bd` is a fake that agrees with lib/bd.js by
 * construction: **that a ref written on the way in comes back out on the way past.** If
 * `bd create --external-ref` were a flag bd accepted and dropped, or if `bd list --json`
 * omitted the field, every sweep would look up a ticket, find nothing, and file another
 * epic — a minute apart, forever, and each one perfectly well-formed. That is the failure
 * this file exists to make impossible, and only the real binary can answer it.
 *
 * Four claims, all about bd rather than about beadcause:
 *
 * 1. `--external-ref` on **create** survives into `bd list --json` as `external_ref`.
 * 2. `--external-ref` on **update** does the same — which is the whole of what makes an
 *    adopted bead stay adopted rather than be re-matched by title on every restart.
 * 3. A **closed** bead still carries its ref in `bd list --all`, so "exactly one, forever"
 *    survives the epic being finished.
 * 4. `--type epic` at `--priority 1` with a label is stored as asked, so the epic the
 *    filer describes is the bead the tracker ends up with.
 *
 * The workspace is a fresh `mkdtemp`, so this takes no Dolt lock any other session is
 * waiting on and reads nobody's real tracker. Skipped, loudly, where `bd` is not
 * installed — a machine without the tracker cannot answer the question, and failing there
 * would say something untrue about the code.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-jiraepicreal-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { Bd } = await import(LIB('bd.js'));
const { epicIssue, refFor, refIndex, refOn } = await import(LIB('jiraepic.js'));
const { UNENDORSED } = await import(LIB('endorse.js'));

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
const check = (fn, name) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

console.log('\nthe ref, against the real bd\n');

const bdOnPath = !spawnSync('bd', ['version'], { encoding: 'utf8' }).error;
if (!bdOnPath) {
  console.log('  \x1b[33m—\x1b[0m skipped: no `bd` on PATH, so what it stores cannot be asked here');
  console.log('\n0/0 passed\n');
  await cleanupTmp(tmp);
  process.exit(0);
}

const dir = path.join(tmp, '.beads');
fs.mkdirSync(dir, { recursive: true });
// Spawned directly, never through a shell: `~/.zshenv` rewrites BEADS_DIR from the
// shell's cwd, so a shell here would resolve to somebody's actual tracker.
const env = { ...process.env, BEADS_DIR: dir };
const bdRun = (args) => spawnSync('bd', args, { env, cwd: tmp, encoding: 'utf8', timeout: 120_000 });

const init = bdRun(['init', '--skip-agents', '--prefix', 'je']);
if (init.status !== 0) {
  bad('a temp workspace can be made to ask in', (init.stderr || init.stdout || '').split('\n')[0]);
  await cleanupTmp(tmp);
  console.log(`\n${failures}/${ran} failed\n`);
  process.exit(1);
}

const bd = new Bd({ bin: 'bd', actor: 'beadcause' });
const ws = { name: 'jiraepicreal', dir };
const ticket = {
  workspace: 'jiraepicreal',
  key: 'TECH-1',
  summary: 'Fix the login redirect loop',
  status: 'In Progress',
  updated: '2026-08-13T10:00:00.000+0000',
  url: 'https://example.atlassian.net/browse/TECH-1',
  assignee: 'adam@example.com',
};

const issue = epicIssue(ticket);
const id = await bd.create(ws, issue);
const rowFor = async (want) => (await bd.listAll(ws)).find((r) => r.id === want);

check(() => assert.ok(id, 'bd create returned no id'), 'the epic is created');

{
  const row = await rowFor(id);
  check(() => assert.equal(refOn(row), refFor('TECH-1')), 'the ref written on create comes back on `bd list`');
  check(() => assert.equal(refIndex([row]).get('jira-TECH-1')?.id, id), 'and the index the sweep looks up finds it');
  check(() => assert.equal(row?.issue_type, 'epic'), 'it is stored as an epic');
  check(() => assert.equal(Number(row?.priority), 1), 'at P1');
  check(() => assert.ok((row?.labels || []).includes(UNENDORSED)), 'carrying the hold');
  check(() => assert.ok((row?.labels || []).includes('jira-ticket')), 'and the provenance label');
}

{
  // The adoption path: a bead that already existed, linked afterwards.
  const other = await bd.create(ws, { title: 'TECH-2: raised by hand', body: 'x', priority: 2, type: 'task', labels: [] });
  await bd.update(ws, other, { externalRef: refFor('TECH-2') });
  const row = await rowFor(other);
  check(
    () => assert.equal(refOn(row), 'jira-TECH-2'),
    'a ref written by `bd update` sticks — which is what makes an adoption permanent'
  );
}

{
  // "Exactly one, forever" has to survive the epic being finished.
  const done = await bd.create(ws, { title: 'TECH-3 — done last month', body: 'x', priority: 1, type: 'epic', labels: [], externalRef: refFor('TECH-3') });
  await bd.close(ws, done, 'shipped');
  const rows = await bd.listAll(ws);
  const row = rows.find((r) => r.id === done);
  check(() => assert.equal(String(row?.status), 'closed'), 'a closed epic is still in `bd list --all`');
  check(
    () => assert.equal(refIndex(rows).get('jira-TECH-3')?.id, done),
    'and still answers for its ticket — or a finished epic buys the ticket a second one'
  );
}

await cleanupTmp(tmp);
console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
