#!/usr/bin/env node
/**
 * lib/sessionaudit.js — the agent a session *ending* starts, and the four ways it lies.
 *
 *     npm test
 *     node test/sessionaudit.mjs
 *
 * bc-dgx7.1's acceptance is four sentences and every one of them is a thing that fails
 * silently, which is why they are all here rather than in a comment:
 *
 * 1. **A session ending causes an audit run.** The trigger is an archive landing, so the
 *    input is read out of `refs/beadcause/sessions/*` — a real ref, in a real repo, built
 *    the way `archiveSession` builds one. A reader that could not parse a real subject
 *    would find nothing and report "nothing is archived", which reads exactly like a
 *    quiet week.
 * 2. **Findings arrive as beads with the label and the evidence.** Through lib/filing.js,
 *    which means held, agent-filed, and clamped — a candidate that arrived workable would
 *    put an agent on work nobody agreed to.
 * 3. **Re-running over the same sessions does not file duplicates.** Twice over: a
 *    session commit already in the ledger is not read again, and a finding naming a
 *    command already filed is dropped even when it is. The second net is the one that
 *    matters, because the first is gone the moment somebody forces a run.
 * 4. **A run that finds nothing says so and files nothing.** Including the run that
 *    *found* something and had it refused — a one-off cited as three, a citation of a
 *    session the run never read, a command the repo already ships. Each of those is a
 *    plausible finding, and filing any of them costs somebody an hour of reading.
 *
 * No agent and no tracker: the `claude -p` and `bd` are fakes that record what they were
 * asked. The git is real, because the ledger's whole job is to survive a restart and an
 * in-memory fake of it would be a test of the fake.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (name) => path.join(ROOT, 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-sessionaudit-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const {
  AUDIT_REF,
  CANDIDATE_LABEL,
  MAX_FINDINGS,
  MIN_SESSIONS,
  SKILL_LABEL,
  auditPrompt,
  candidateBead,
  clipEnds,
  createAuditor,
  extractFindings,
  findingProblems,
  normalise,
  options,
  readLedger,
  sessionsIn,
  skillLibrary,
} = await import(LIB('sessionaudit.js'));
const { FILED_LABEL, PRIORITY_FLOOR } = await import(LIB('filing.js'));
const { UNENDORSED } = await import(LIB('endorse.js'));

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
const checks = (name, fn) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};
const checksAsync = async (name, fn) => {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

/* ------------------------------------------------------------------- the repo */

const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo, { recursive: true });
execFileSync('git', ['-C', repo, 'init', '-q', '--initial-branch=main']);
execFileSync('git', ['-C', repo, 'config', 'user.email', 'beadcause@localhost']);
execFileSync('git', ['-C', repo, 'config', 'user.name', 'beadcause']);
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
// mainCheckout walks up from `dir` to a common dir; a repo with no commit still answers,
// but an empty tree makes `writeTree` the first thing that ever writes here.
fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
git('add', 'README.md');
git('commit', '-q', '-m', 'fixture');

/**
 * One archived session, written the way `archiveSession` writes one: a commit on
 * `refs/beadcause/sessions/<bead>` whose tree is meta.json + session.log, and whose
 * subject is `<workspace>/<bead> · <outcome>`.
 */
let when = Date.parse('2026-08-01T09:00:00Z');
function archive(bead, { log = 'a session', outcome = 'delivered', memory = '', title = '' } = {}) {
  // A minute apart, because `git log` across refs orders by date and five commits in the
  // same second have no order at all — which is exactly the ambiguity a real archive does
  // not have, and asserting "newest first" against it would be asserting a coin toss.
  when += 60_000;
  const stamp = new Date(when).toISOString();
  const blob = (text) => execFileSync('git', ['-C', repo, 'hash-object', '-w', '--stdin'], { input: text, encoding: 'utf8' }).trim();
  const meta = JSON.stringify({ bead, workspace: 'beadcause', title, outcome, commits: ['deadbeef'] }, null, 2);
  const entries = [
    `100644 blob ${blob(meta)}\tmeta.json`,
    `100644 blob ${blob(log)}\tsession.log`,
    ...(memory ? [`100644 blob ${blob(memory)}\tmemory.md`] : []),
  ];
  const tree = execFileSync('git', ['-C', repo, 'mktree'], { input: entries.join('\n') + '\n', encoding: 'utf8' }).trim();
  const ref = `refs/beadcause/sessions/${bead}`;
  const parent = (() => {
    try {
      return git('rev-parse', '--verify', '--quiet', ref);
    } catch {
      return '';
    }
  })();
  const commit = execFileSync(
    'git',
    ['-C', repo, 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `beadcause/${bead} · ${outcome} · 1 commit(s)`],
    { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp } }
  ).trim();
  git('update-ref', ref, commit, parent || '');
  return commit;
}

const BEADS = ['bc-aaa', 'bc-bbb.2', 'bc-ccc', 'bc-ddd', 'bc-eee'];
for (const b of BEADS) archive(b, { title: `${b} did a thing`, log: `session for ${b}\nbd show ${b}\n` });

/* ------------------------------------------------------ 1. reading the archives */

console.log('\nreading what a session left behind');

await checksAsync('every archived session is found, newest first, with its bead', async () => {
  const rows = await sessionsIn(repo, { limit: 20 });
  assert.equal(rows.length, BEADS.length, `found ${rows.length}`);
  assert.deepEqual(
    rows.map((r) => r.bead).sort(),
    [...BEADS].sort(),
    'the bead comes off the subject archiveSession writes'
  );
  assert.equal(rows[0].bead, 'bc-eee', 'newest first — the last one archived is the first row');
});

await checksAsync('a checkout with no archives is empty rather than an error', async () => {
  const bare = path.join(tmp, 'bare');
  fs.mkdirSync(bare, { recursive: true });
  execFileSync('git', ['-C', bare, 'init', '-q']);
  assert.deepEqual(await sessionsIn(bare), []);
});

await checksAsync('the library is what already ships, from bin/ and the bin map', async () => {
  assert.deepEqual(await skillLibrary(repo), [], 'a fixture repo ships nothing');
  fs.mkdirSync(path.join(repo, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'bin', 'b7e-context.js'), '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(repo, 'bin', 'notaskill.js'), '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ bin: { 'b7e-land': 'bin/b7e-land.js' } }));
  assert.deepEqual(await skillLibrary(repo), ['b7e-context', 'b7e-land'], 'both sources, and nothing else');
  fs.rmSync(path.join(repo, 'bin'), { recursive: true, force: true });
  fs.rmSync(path.join(repo, 'package.json'), { force: true });
});

checks('a clipped log says it was clipped', () => {
  const out = clipEnds('x'.repeat(100) + 'END', 50);
  assert.ok(out.includes('characters of the middle omitted'), 'a silent truncation reads as a short session');
  assert.ok(out.endsWith('END\n'), 'the end of a session is where it says what it learned');
  assert.equal(clipEnds('short', 50), 'short', 'nothing is done to a log that fits');
});

/* ---------------------------------------------------------------- 2. the block */

console.log('\nthe skills block, and what it is allowed to claim');

const blockOf = (yaml) => `Some reasoning about what these sessions did.\n\n\`\`\`skills\n${yaml}\`\`\`\n`;

const ONE_FINDING = blockOf(`findings:
  - command: b7e-context
    title: One command assembles a session's opening context
    sessions: [bc-aaa, bc-bbb.2, bc-ccc]
    evidence: |
      All three sessions opened with bd show, bd comments and a debrief read, in three
      different orders, and two of them missed the debrief entirely.
    takes: a bead id
    returns: the brief, as markdown
    where: bin/b7e-context.js
    allowlist: true
    complexity: medium
    acceptance: One call replaces the four reads.
`);

checks('no block at all is an error on the run, not an exception', () => {
  const { findings, error } = extractFindings('I looked and found nothing worth reporting.');
  assert.deepEqual(findings, []);
  assert.match(error, /no `skills` block/);
});

checks('an empty findings list is a clean run, not an error', () => {
  const { findings, error } = extractFindings(blockOf('findings: []\n'));
  assert.deepEqual(findings, []);
  assert.equal(error, null, 'nothing found is the ordinary answer');
});

checks('a block that is not YAML is reported rather than thrown', () => {
  const { error } = extractFindings(blockOf('findings:\n  - [unclosed\n'));
  assert.match(error, /not YAML/);
});

checks('a finding is normalised into something bounded', () => {
  const f = normalise({
    command: '  B7E-Context  ',
    title: 'x'.repeat(400),
    sessions: ['bc-aaa', 'not a bead id at all', 'bc-aaa', 'bc-ccc'],
    evidence: 'y'.repeat(9000),
  });
  assert.equal(f.command, 'b7e-context', 'case and whitespace are not part of a command name');
  assert.equal(f.title.length, 160);
  assert.deepEqual(f.sessions, ['bc-aaa', 'bc-ccc'], 'prose is not a bead id, and neither is a repeat');
  assert.ok(f.evidence.length <= 4000);
  assert.equal(f.allowlist, true, 'the default is that an agent should be able to call it');
});

/* ------------------------------------------------------------- 3. the refusals */

console.log('\nthe four plausible findings that are refused');

const read = ['bc-aaa', 'bc-bbb.2', 'bc-ccc', 'bc-ddd'];
const finding = (over = {}) =>
  normalise({ command: 'b7e-context', title: 'assemble the context', sessions: ['bc-aaa', 'bc-bbb.2', 'bc-ccc'], ...over });

checks('a one-off is not a finding, whatever it says about itself', () => {
  const why = findingProblems(finding({ sessions: ['bc-aaa', 'bc-bbb.2'] }), { sessions: read });
  assert.match(why, new RegExp(`floor is ${MIN_SESSIONS}`));
});

checks('citing sessions this run never read leaves it short', () => {
  const why = findingProblems(finding({ sessions: ['bc-aaa', 'bc-zzz', 'bc-yyy'] }), { sessions: read });
  assert.match(why, /which this run did not read/);
});

checks('a command the repo already ships is a miss, not a candidate', () => {
  const why = findingProblems(finding(), { sessions: read, library: ['b7e-context'] });
  assert.match(why, /already exists/);
});

checks('a candidate already filed is not filed again', () => {
  const why = findingProblems(finding(), { sessions: read, filed: ['b7e-context'] });
  assert.match(why, /already been filed/);
});

checks('anything that is not a b7e-<verb> command is refused outright', () => {
  assert.match(findingProblems(finding({ command: 'context' }), { sessions: read }), /not a b7e-<verb>/);
  assert.equal(findingProblems(finding(), { sessions: read }), null, 'and a real one passes');
});

/* --------------------------------------------------------------- 4. the bead */

console.log('\nwhat a candidate looks like on the tracker');

checks('the bead carries the label, the evidence and the wiring', () => {
  const bead = candidateBead(finding({ evidence: 'each of them did it differently' }), { runAt: '2026-08-17T00:00:00Z' });
  assert.ok(bead.labels.includes(SKILL_LABEL), 'the whole programme is one query on this label');
  assert.ok(bead.labels.includes(CANDIDATE_LABEL));
  assert.match(bead.description, /bc-aaa, bc-bbb\.2, bc-ccc/, 'the sessions it was seen in are the evidence');
  assert.match(bead.description, /each of them did it differently/);
  assert.match(bead.description, /package-lock\.json/, 'the second registration is the one nobody remembers');
  assert.match(bead.description, /Bash\(b7e-context:\*\)/, 'and the allowlist entry, since allowlist is true');
  assert.match(bead.description, /refs\/beadcause\/sessions/, 'somebody has to be able to go and check');
});

checks('a command agents are not meant to call owes no allowlist entry', () => {
  const bead = candidateBead(finding({ allowlist: false }));
  assert.ok(!bead.description.includes('DEFAULT_TOOL_LIST'), 'an allowlist line nobody needs is a line that gets copied');
});

checks('the prompt says what already exists and what is already filed', () => {
  const text = auditPrompt({
    sessions: [{ bead: 'bc-aaa', dir: '/tmp/x/01-bc-aaa', title: 'a thing', outcome: 'delivered', commits: 2, hasMemory: true }],
    library: ['b7e-context'],
    filed: [{ slug: 'b7e-land', title: 'landing' }],
  });
  assert.match(text, /01-bc-aaa/, 'the agent is told where to read');
  assert.match(text, /left a debrief/);
  assert.match(text, /already ships/);
  assert.match(text, /do not file these again/);
  assert.match(text, new RegExp(`At most ${MAX_FINDINGS} findings`));
});

/* ----------------------------------------------------------- 5. the whole run */

console.log('\nthe run, end to end');

const WS = { name: 'beadcause', dir: path.join(tmp, 'beads', 'beadcause', '.beads') };

/** `bd`, remembering what it was asked to create. No graph, so nothing is homed. */
function fakeBd({ createFails = null } = {}) {
  const created = [];
  let n = 0;
  return {
    created,
    async exists() {
      return true;
    },
    async create(workspace, issue) {
      if (createFails) throw new Error(createFails);
      n += 1;
      const id = `bc-cand${n}`;
      created.push({ id, issue });
      return id;
    },
  };
}

const auditorOver = ({ answer = ONE_FINDING, bd, cfg = {}, now = () => Date.now(), throws = null } = {}) => {
  const prompts = [];
  const settled = [];
  const auditor = createAuditor({
    cfg: { advocates: { sessionAuditEvery: 1, sessionAuditCooldownMinutes: 0, ...cfg }, ...cfg.root },
    bd,
    now,
    log: () => {},
    warn: () => {},
    onSettled: (out) => settled.push(out),
    run: async ({ prompt, readDir }) => {
      prompts.push({ prompt, readDir });
      if (throws) throw new Error(throws);
      return answer;
    },
  });
  return { auditor, prompts, settled };
};

await checksAsync('a run reads the archives, files the candidate held, and records itself', async () => {
  const bd = fakeBd();
  const { auditor, prompts, settled } = auditorOver({ bd });
  const out = await auditor.audit(repo, WS);
  assert.equal(out.ran, true, out.why || 'the run did not happen');
  assert.equal(out.error, null, String(out.error));
  assert.equal(out.sessions.length, BEADS.length, 'every archived session was read');
  assert.equal(out.filed.length, 1, `filed ${JSON.stringify(out.filed)} — dropped ${JSON.stringify(out.dropped)}`);
  assert.equal(out.filed[0].slug, 'b7e-context');

  const issue = bd.created[0].issue;
  assert.ok(issue.labels.includes(UNENDORSED), 'a candidate nobody agreed to must not be workable');
  assert.ok(issue.labels.includes(FILED_LABEL), 'an agent decided this was work');
  assert.ok(issue.labels.includes(SKILL_LABEL));
  assert.ok(issue.priority >= PRIORITY_FLOOR, 'what an agent thought urgent cannot outrank what Adam chose');

  // The transcripts reach the agent as files outside the repo, and are gone afterwards.
  assert.ok(prompts[0].readDir, 'the agent was given a directory to read');
  assert.ok(!prompts[0].readDir.startsWith(repo), 'nothing is written into the checkout');
  assert.equal(fs.existsSync(prompts[0].readDir), false, 'the batch is removed whatever happens');

  assert.equal(settled.length, 1, 'a run that finished is reported, because it outlived the tick that started it');

  const ledger = await readLedger(repo);
  assert.equal(ledger.runs, 1);
  assert.equal(ledger.audited.length, BEADS.length, 'every session read is remembered');
  assert.deepEqual(
    ledger.candidates.map((c) => c.slug),
    ['b7e-context']
  );
  assert.match(git('log', '-1', '--format=%s', AUDIT_REF), /audit · 5 session\(s\) · 1 candidate\(s\)/);
});

await checksAsync('the same sessions are not audited twice', async () => {
  const bd = fakeBd();
  const { auditor, prompts } = auditorOver({ bd });
  const out = await auditor.audit(repo, WS);
  assert.equal(out.ran, false, 'a second run over the same archives is not worth an agent');
  assert.match(out.why, /already been audited/);
  assert.equal(prompts.length, 0, 'and no agent was started');
  assert.equal(bd.created.length, 0);
});

await checksAsync('and a forced re-run over them still does not file the same candidate twice', async () => {
  const bd = fakeBd();
  const { auditor } = auditorOver({ bd });
  const out = await auditor.audit(repo, WS, { force: true });
  assert.equal(out.ran, true, out.why);
  assert.equal(out.filed.length, 0, 'the ledger says this command is already filed');
  assert.equal(bd.created.length, 0, 'nothing reached the tracker');
  assert.equal(out.dropped.length, 1, JSON.stringify(out.dropped));
  assert.match(out.dropped[0], /already been filed/);
  const ledger = await readLedger(repo);
  assert.equal(ledger.candidates.length, 1, 'and the ledger did not gain a second copy');
});

await checksAsync('a run that finds nothing says so and files nothing', async () => {
  const bd = fakeBd();
  const { auditor, settled } = auditorOver({ bd, answer: blockOf('findings: []\n') });
  const out = await auditor.audit(repo, WS, { force: true });
  assert.equal(out.ran, true, out.why);
  assert.equal(out.error, null);
  assert.deepEqual(out.filed, []);
  assert.equal(bd.created.length, 0);
  // Reported, but with nothing in it — which is what lib/server.js gates its bus event
  // on, so that a quiet audit does not wake every parked phone to redraw the same inbox.
  assert.equal(settled.length, 1);
  assert.deepEqual(settled[0].filed, []);
  assert.deepEqual(settled[0].misses, []);
  assert.match(git('log', '-1', '--format=%s', AUDIT_REF), /nothing worth a command/);
});

await checksAsync('a pattern the library already covers is recorded as a miss, not filed', async () => {
  const bd = fakeBd();
  const { auditor, settled } = auditorOver({
    bd,
    answer: blockOf(`findings:
  - command: b7e-context
    kind: miss
    existing: b7e-context
    title: the context command existed and went unused
    sessions: [bc-aaa, bc-bbb.2, bc-ccc]
`),
  });
  const out = await auditor.audit(repo, WS, { force: true });
  assert.deepEqual(out.filed, [], 'a miss is not work, it is a question about adoption');
  assert.equal(out.misses.length, 1);
  assert.equal(out.misses[0].existing, 'b7e-context');
  assert.equal(bd.created.length, 0);
  assert.equal(settled.length, 1, 'a miss is still worth telling the app about');
  const ledger = await readLedger(repo);
  assert.equal(ledger.misses.length, 1, 'and it is remembered, for bc-dgx7.6 to count');
});

await checksAsync('an agent that will not run is a recorded run, not a lost one', async () => {
  const bd = fakeBd();
  const { auditor } = auditorOver({ bd, throws: 'could not start claude' });
  const before = (await readLedger(repo)).runs;
  const out = await auditor.audit(repo, WS, { force: true });
  assert.equal(out.ran, true, 'the run happened; it is the agent that did not');
  assert.match(out.error, /could not start claude/);
  assert.deepEqual(out.filed, []);
  assert.equal((await readLedger(repo)).runs, before + 1, 'a failure that leaves no trace is a failure nobody fixes');
});

/* ----------------------------------------------------- 6. what bounds the cost */

console.log('\nwhat stops this being an agent per session');

await checksAsync('the threshold holds a run back until enough has piled up', async () => {
  const bd = fakeBd();
  const { auditor, prompts } = auditorOver({ bd, cfg: { sessionAuditEvery: 5 } });
  archive('bc-fff', { log: 'one more session' });
  const out = await auditor.audit(repo, WS);
  assert.equal(out.ran, false);
  assert.match(out.why, /1 unread session\(s\) — the threshold is 5/);
  assert.equal(prompts.length, 0);
});

await checksAsync('the cooldown holds a run back whatever the arrivals', async () => {
  const bd = fakeBd();
  let clock = 1_000_000;
  const { auditor } = auditorOver({ bd, cfg: { sessionAuditEvery: 1, sessionAuditCooldownMinutes: 60 }, now: () => clock });
  const first = await auditor.audit(repo, WS);
  assert.equal(first.ran, true, first.why);
  archive('bc-ggg', { log: 'and another' });
  clock += 10 * 60 * 1000;
  const second = await auditor.audit(repo, WS);
  assert.equal(second.ran, false);
  assert.match(second.why, /the last audit was 10 minute\(s\) ago/);
  clock += 60 * 60 * 1000;
  const third = await auditor.audit(repo, WS);
  assert.equal(third.ran, true, third.why);
});

await checksAsync('two archives landing in one tick start one agent, not two', async () => {
  const bd = fakeBd();
  const prompts = [];
  let release;
  const held = new Promise((r) => {
    release = r;
  });
  const auditor = createAuditor({
    cfg: { advocates: { sessionAuditEvery: 1, sessionAuditCooldownMinutes: 0 } },
    bd,
    log: () => {},
    warn: () => {},
    run: async ({ prompt }) => {
      prompts.push(prompt);
      await held;
      return blockOf('findings: []\n');
    },
  });
  archive('bc-hhh', { log: 'one' });
  archive('bc-iii', { log: 'two' });
  // Both started before the first has finished deciding — which is the advocate's archive
  // loop exactly, since deciding takes two git reads and the loop awaits between archives.
  const both = Promise.all([auditor.audit(repo, WS), auditor.audit(repo, WS)]);
  release();
  const [first, second] = await both;
  assert.equal(prompts.length, 1, 'a second `claude -p` on this Mac is what the latch exists to stop');
  assert.equal(first.ran !== second.ran, true, 'exactly one of them ran');
  assert.match(first.ran ? second.why : first.why, /already running/);
});

checks('switching it off switches it off', () => {
  assert.equal(options({ advocates: { sessionAudit: false } }).enabled, false);
  assert.equal(options({}).enabled, true, 'on by default — bc-dgx7 wants it running unasked');
  assert.equal(options({ advocates: { sessionAuditEvery: 900 } }).every, 50, 'every number is clamped');
  assert.equal(options({ advocates: { sessionAuditMax: 1 } }).max, MIN_SESSIONS);
});

await checksAsync('a nudge never throws at the advocate that gave it', async () => {
  const { auditor } = auditorOver({ bd: fakeBd(), cfg: { sessionAudit: false } });
  assert.doesNotThrow(() => auditor.noteArchive({ dir: repo, workspace: WS }));
  assert.doesNotThrow(() => auditor.noteArchive({}));
  const out = await auditor.audit(repo, WS);
  assert.equal(out.ran, false);
  assert.match(out.why, /switched off/);
});

/* --------------------------------------------------------------------- done */

await cleanupTmp(tmp);
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
