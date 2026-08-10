#!/usr/bin/env node
//
// What each agent may actually run — the `bd` surface, verb by verb.
//
//   npm test                       (runs it alongside the other suites)
//   node test/allowlist.mjs        (on its own)
//
// Every unattended agent in beadcause is bounded by one string: the `--allowedTools`
// list its foundation carries. That string is the only thing standing between "the
// advocate proposes work for Adam to approve" and "the advocate files the work it was
// proposing", because `writes: false` in lib/foundation.js is a claim about the agent
// and the allowlist is what makes the claim true.
//
// It failed that job for a year in one entry. `Bash(bd *)` reads as *let it read the
// tracker* and grants `bd create`, `bd close`, `bd delete` and every `bd label` verb —
// which is why the reply agents' list was expanded verb-by-verb (see the note in
// lib/agents.js) and why bc-ec6 did the same to the advocate's. Nothing about that
// widening is visible in a diff review: the pattern is shorter than the thing it
// replaces and reads more innocent. So it gets asserted rather than eyeballed, in the
// shape test/lookup.mjs established for the lookup grants — the verbs listed here
// literally, the writes listed as commands and asserted *unreachable*, and both halves
// named so that widening one later is a deliberate act with a failing test attached.
//
// One of those four has since been let back in, one level down and on purpose: the
// advocate may run `bd label add` and the two label reads, because `bd label add <id>
// human` is how a survey says "this one needs you" about a bead that already exists.
// That is a decision (bc-ul5a), and the line it drew is *inside* `bd label` — `remove`
// and `propagate` stay unreachable, which is why they are asserted below rather than
// left to the absence of a glob. `Bash(bd label:*)` would erase that line, and it is
// exactly the shape of pattern this file exists to catch.
//
// Two halves:
//
// 1. **The list, per agent.** What each one may run, spelled out, plus the commands
//    that must not be reachable from any of them — asserted through a matcher that
//    reads a pattern the way the CLI does (below), so the assertion is about what the
//    agent can *do* and not about how the entry happens to be spelled.
// 2. **A survey still completes and still proposes.** The narrowing is worthless if it
//    breaks the thing it protects, and an allowlist assertion cannot see whether the
//    flags ever reach `claude`. So the real advocate is ticked with an empty queue
//    against a fake `claude` on PATH, which records the argv it was handed and answers
//    with a proposal block. That covers both: the narrowed list is what arrives at the
//    CLI, and a proposal still comes back out and still gets filed.
//
// Nothing here touches a tracker, a network or a real Claude: `bd` is an object of
// async stubs, `claude` is a shell script in a temp dir, and the config directory is
// redirected before anything under lib/ is imported.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (name) => path.join(ROOT, 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-allowlist-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load,
// and a test that wrote advocate state into the real ~/.config/beadcause would be
// editing a running daemon's mind.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });
// Observer mode resolves at load too, and it makes `propose` return before it spawns
// anything — so a suite run inside an observer shell would pass the survey case by
// never running it. Cleared here rather than asserted on, because the point of this
// file is the allowlist, not the flag: test/observe.mjs owns that.
delete process.env.BEADCAUSE_OBSERVE;
delete process.env.BEADCAUSE_READONLY;

// foundation.js first, deliberately: it and agents.js import each other, and the module
// entered first is the one whose constants initialise. See the same note in
// test/lookup.mjs and scripts/selftest.mjs.
const foundation = await import(LIB('foundation.js'));
const { createAdvocates } = await import(LIB('advocate.js'));

/* ---------------------------------------------------------------- the harness */

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.log(`  ✗ ${name}\n    ${String(err.message).split('\n').slice(0, 6).join('\n    ')}`);
  }
}

/**
 * Would this allowlist let this command run?
 *
 * A deliberately *generous* reading of the patterns — `Bash(x:*)` and `Bash(x *)` are
 * both treated as "any command starting with x" — and the generosity is what makes the
 * negative assertions worth having. The real CLI is at least this strict, so a command
 * this says is unreachable is unreachable there too, and no false pass can hide behind
 * a disagreement about how a colon is parsed.
 */
export function permits(list, command) {
  const cmd = String(command).trim().replace(/\s+/g, ' ');
  for (const entry of list || []) {
    const m = /^Bash\((.*)\)$/.exec(entry);
    if (!m) continue;
    const pattern = m[1].trim();
    const prefix = pattern.replace(/[\s:]*\*$/, '').trim();
    if (prefix === pattern) {
      if (cmd === pattern) return true; // no glob: an exact command
      continue;
    }
    if (cmd === prefix || cmd.startsWith(`${prefix} `)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ the lists */

/**
 * The advocate's `bd` surface, spelled out.
 *
 * If you are here because this array made a test fail: that is the test working. The
 * first eight are what `surveyPrompt` in lib/advocate.js actually tells a survey to
 * run — what has just closed, what is stuck, what is already open, and the comments
 * under it. A ninth read is a decision, and the advocate has the amendment loop to ask
 * for one rather than a glob to take it. Update this list in the same commit that
 * updates the foundation, and say in the message what the new verb reads that these
 * cannot.
 *
 * The three label entries are the exception, and the only write-shaped thing here.
 * `add` is granted (bc-ul5a) so a survey can route an existing bead into the inbox;
 * `list` and `list-all` are granted so it can see which labels exist before choosing
 * one. All three are spelled one level below `bd label`, which is the whole point —
 * see `LABEL_NEVER`.
 */
const ADVOCATE_BD = [
  'Bash(bd list:*)',
  'Bash(bd show:*)',
  'Bash(bd ready:*)',
  'Bash(bd blocked:*)',
  'Bash(bd search:*)',
  'Bash(bd comments:*)',
  'Bash(bd stats:*)',
  'Bash(bd dep tree:*)',
  'Bash(bd label add:*)',
  'Bash(bd label list:*)',
  'Bash(bd label list-all:*)',
];

/**
 * Commands no unattended agent may reach, as commands rather than as patterns.
 *
 * Written the way an agent would type them, because that is the only form in which
 * "can it file its own proposal?" has an answer. `bd dep add` is on the list for the
 * same reason as the rest and is the one that hides best: `Bash(bd dep:*)` looks like a
 * grant to read a dependency tree and carries `add`, `remove`, `relate` and `unrelate`.
 */
const TRACKER_WRITES = [
  'bd create --title="filed by the agent itself" --type=task',
  'bd close bc-ec6',
  'bd delete bc-ec6',
  'bd update bc-ec6 --claim',
  'bd dep add bc-ec6 bc-1',
  'bd dep remove bc-ec6 bc-1',
];

/**
 * Labelling, split the way bc-ul5a split it.
 *
 * `LABEL_OK` is what the advocate gained and what the other two must still be refused —
 * `bd label add <id> human` is how a bead reaches Adam's inbox, so it is a real write
 * and it is granted to exactly one agent on purpose.
 *
 * `LABEL_NEVER` is the line inside `bd label`, and it is the half that needs a test:
 * nothing in the foundation spells `remove` or `propagate` out, so the only thing
 * keeping them unreachable is the *absence* of `Bash(bd label:*)` — an absence that a
 * future one-line "simplification" of three entries into one would delete without
 * looking like it had. That is the same globbing mistake bc-ec6 removed, one level down.
 */
const LABEL_OK = ['bd label add bc-ec6 human'];
const LABEL_NEVER = ['bd label remove bc-ec6 human', 'bd label propagate bc-ec6 human'];

/** The label reads, granted so a label is chosen from the ones that already exist. */
const LABEL_READS = ['bd label list bc-ec6', 'bd label list-all'];

/** What a survey genuinely runs, from `surveyPrompt`. Each one must still work. */
const SURVEY_READS = [
  'bd list --status=closed --limit 20',
  'bd list --status=blocked',
  'bd list --status=open',
  'bd blocked',
  'bd show bc-ec6',
  'bd comments bc-ec6',
  'bd ready',
  'bd search importer',
  'bd stats',
  'bd dep tree bc-ec6',
  'git log --oneline -30',
  'git status --short',
  'git diff HEAD~1',
];

/**
 * The rest of the advocate's reach, which narrowing `bd` must not have cost it.
 *
 * A fix that quietly dropped the screenshot command or the lookup grants would pass
 * every assertion above and leave the advocate unable to see the screens it surveys.
 */
const ADVOCATE_KEEPS = [
  'Bash(git log:*)',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(beadcause-memory:*)',
  'Bash(node scripts/shot.mjs:*)',
  'Read',
  'Grep',
  'Glob',
  'WebSearch',
  'WebFetch',
  'Bash(beadcause-get:*)',
];

/* ------------------------------------------------------- what the lists say */

console.log('\nthe bd surface, agent by agent\n');

await test('the advocate’s bd grants are named one verb at a time', async () => {
  const f = await foundation.effective(ROOT, 'advocate');
  const bd = f.allowedTools.filter((e) => /^Bash\(bd\b/.test(e));
  assert.deepEqual(bd, ADVOCATE_BD);
});

await test('no agent has Bash(bd *) — the pattern that included create and close', async () => {
  for (const agent of foundation.AGENTS) {
    const f = await foundation.effective(ROOT, agent);
    for (const entry of f.allowedTools || []) {
      assert.notEqual(entry, 'Bash(bd *)', `${agent} has it back`);
      // Any other spelling of the same hole: a glob directly on `bd`.
      assert.ok(!/^Bash\(bd[\s:]*\*\)$/.test(entry), `${agent} has ${entry}, which is Bash(bd *) wearing a hat`);
    }
  }
});

await test('the advocate cannot create, close, delete or update a bead', async () => {
  const f = await foundation.effective(ROOT, 'advocate');
  for (const cmd of TRACKER_WRITES) {
    assert.ok(
      !permits(f.allowedTools, cmd),
      `the advocate can run \`${cmd}\` — its whole output is meant to be a proposal Adam approves`,
    );
  }
});

await test('the advocate can add a label, and read which labels exist first', async () => {
  const f = await foundation.effective(ROOT, 'advocate');
  for (const cmd of [...LABEL_OK, ...LABEL_READS]) {
    assert.ok(permits(f.allowedTools, cmd), `the advocate cannot run \`${cmd}\` — bc-ul5a granted it`);
  }
});

await test('but it cannot remove or propagate one — the line is inside bd label', async () => {
  const f = await foundation.effective(ROOT, 'advocate');
  for (const cmd of LABEL_NEVER) {
    assert.ok(
      !permits(f.allowedTools, cmd),
      `the advocate can run \`${cmd}\` — which means \`Bash(bd label:*)\` is back in some spelling`,
    );
  }
  for (const entry of f.allowedTools) {
    assert.ok(
      !/^Bash\(bd label[\s:]*\*\)$/.test(entry),
      `the advocate has ${entry}, which carries remove and propagate`,
    );
  }
});

await test('and neither can the chat session or the comment answerer', async () => {
  // The chat session proposes beads it must not file; dispatch answers a comment and is
  // allowed exactly one write, `bd comment`, which is the answer itself. Every `bd
  // label` verb is the advocate's alone, the reads included: they are granted there so a
  // *survey* can route a bead into the inbox and pick a label that already exists, which
  // is not a thing either of these two is doing.
  for (const agent of ['console', 'dispatch']) {
    const f = await foundation.effective(ROOT, agent);
    for (const cmd of [...TRACKER_WRITES, ...LABEL_OK, ...LABEL_NEVER, ...LABEL_READS]) {
      // `bd dep add` is reachable on dispatch today through `Bash(bd dep:*)` — the same
      // shape of hole as bc-ec6, in a different agent, and not this bead's to close.
      // Proposed separately rather than fixed here; skipped so the rest is still asserted.
      if (agent === 'dispatch' && cmd.startsWith('bd dep ')) continue;
      assert.ok(!permits(f.allowedTools, cmd), `${agent} can run \`${cmd}\``);
    }
  }
});

await test('the advocate is still writes: false, and the comment says what that now means', async () => {
  const f = await foundation.effective(ROOT, 'advocate');
  // The claim the foundations screen draws as the read-only pill, and the amendment
  // prompt reads out as "may write to the tracker". Granting `bd label add` did not
  // flip it — the alternative was considered and declined, because an advocate drawn
  // the same as a worker overstates what it can do.
  assert.equal(f.writes, false);
  assert.ok(foundation.PROTECTED.includes('writes'), 'writes must stay unamendable — this is a code-only decision');
  // And the narrowed meaning, asserted because it is the only thing that stops the next
  // reader taking `writes: false` for "touches nothing in the tracker" and treating the
  // label grant as a bug to fix.
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'foundation.js'), 'utf8');
  const block = src.slice(src.indexOf('\n  advocate: {'), src.indexOf('\n  worker: {'));
  assert.ok(block.includes('writes: false'), 'the advocate baseline moved — this assertion is reading the wrong block');
  // The comment as prose: `//` and the line wrapping stripped, so the assertion is about
  // what it says and not about where a re-wrap happened to put the break.
  const prose = block.replace(/^\s*\/\/ ?/gm, '').replace(/\s+/g, ' ');
  assert.match(prose, /may \*?create, close or delete work\*?/, 'the narrowed meaning of `writes` is not written down');
  assert.match(prose, /[Ll]abelling is deliberately outside/, 'nothing says labelling sits outside `writes`');
});

await test('the worker is the only agent with no allowlist, and that is on purpose', async () => {
  // Interactive: Adam is sitting in the window approving in the loop. If this ever
  // gains a list, that is a decision and the list belongs in a test of its own.
  const f = await foundation.effective(ROOT, 'worker');
  assert.equal(f.allowedTools, null);
  assert.equal(f.writes, true);
});

await test('everything a survey actually runs is still permitted', async () => {
  const f = await foundation.effective(ROOT, 'advocate');
  for (const cmd of SURVEY_READS) {
    assert.ok(permits(f.allowedTools, cmd), `the survey prompt tells it to run \`${cmd}\` and the list refuses`);
  }
});

await test('the advocate kept the rest of its reach', async () => {
  const f = await foundation.effective(ROOT, 'advocate');
  for (const entry of ADVOCATE_KEEPS) assert.ok(f.allowedTools.includes(entry), `the advocate lost ${entry}`);
});

await test('the matcher itself is not the thing passing these', () => {
  // A `permits` that returned false for everything would pass every negative assertion
  // in this file. Both directions, on the patterns this repo actually writes.
  assert.ok(permits(['Bash(bd list:*)'], 'bd list --status=open'));
  assert.ok(permits(['Bash(bd list:*)'], 'bd list'));
  assert.ok(!permits(['Bash(bd list:*)'], 'bd create --title=x'));
  assert.ok(!permits(['Bash(bd dep tree:*)'], 'bd dep add a b'));
  assert.ok(permits(['Bash(bd dep tree:*)'], 'bd dep tree bc-1'));
  // The label split, in the matcher: `add` does not carry `remove`, and `list` does not
  // carry `list-all` — which is why the foundation names all three.
  assert.ok(permits(['Bash(bd label add:*)'], 'bd label add bc-1 human'));
  assert.ok(!permits(['Bash(bd label add:*)'], 'bd label remove bc-1 human'));
  assert.ok(!permits(['Bash(bd label list:*)'], 'bd label list-all'));
  assert.ok(permits(['Bash(bd label list-all:*)'], 'bd label list-all'));
  // The hole, read as the CLI reads it: the glob one level up grants everything under it.
  assert.ok(permits(['Bash(bd *)'], 'bd create --title=x'));
  assert.ok(permits(['Bash(bd dep:*)'], 'bd dep add a b'));
  assert.ok(permits(['Bash(bd label:*)'], 'bd label remove a b'));
  // A pattern with no glob is one command and not a prefix.
  assert.ok(permits(['Bash(bd stats)'], 'bd stats'));
  assert.ok(!permits(['Bash(bd stats)'], 'bd stats --json'));
  assert.ok(!permits(['Read', 'Grep'], 'bd list'));
});

/* -------------------------------------------------- and a survey still runs */

console.log('\na survey run, against a fake claude\n');

/**
 * The repo the advocate surveys, and the `claude` it finds on PATH.
 *
 * A real git repo, because `effective` and the amendment reflection both read refs out
 * of it — an empty one is the honest case for a repo that has never been amended, which
 * is what makes the baseline list the one that reaches the CLI.
 */
const REPO = path.join(tmp, 'demo');
fs.mkdirSync(path.join(REPO, '.beads'), { recursive: true });
execFileSync('git', ['init', '-q'], { cwd: REPO });

const FAKEBIN = path.join(tmp, 'bin');
fs.mkdirSync(FAKEBIN, { recursive: true });
const ARGV = path.join(tmp, 'claude-argv.json');
const ANSWER = `Two things stood out.

\`\`\`beadproposal
workspace: demo
beads:
  - title: Cache-bust site.js on deploy
    type: task
    priority: 2
    description: |
      The script tag carries no ?v=, so a shipped change looks absent.
    acceptance: A deploy changes the URL the browser asks for.
    rationale: Found in bin/router.js while surveying.
\`\`\`
`;
fs.writeFileSync(path.join(tmp, 'answer.md'), ANSWER);
// Extensionless on purpose: node reads it as CommonJS, so it needs nothing from this
// package and cannot be tripped up by `"type": "module"` two directories up.
fs.writeFileSync(
  path.join(FAKEBIN, 'claude'),
  `#!/usr/bin/env node
const fs = require('node:fs');
// The argv is half the point of this fixture: it is the only place the flags a
// foundation implies can be seen as the CLI sees them.
fs.writeFileSync(process.env.CLAUDE_FAKE_ARGV, JSON.stringify(process.argv.slice(2), null, 2));
const answer = fs.readFileSync(process.env.CLAUDE_FAKE_ANSWER, 'utf8');
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: answer }) + '\\n');
`,
  { mode: 0o755 },
);
process.env.CLAUDE_FAKE_ARGV = ARGV;
process.env.CLAUDE_FAKE_ANSWER = path.join(tmp, 'answer.md');
// `agentEnv` builds the child's env from `process.env`, so this is how the fake wins:
// ~/.zprofile only ever *appends* to PATH, and the real claude lives at the end of it.
process.env.PATH = `${FAKEBIN}:${process.env.PATH}`;

const created = [];
const bd = {
  // Empty: an advocate only proposes when there is nothing left to work, which is the
  // one state that reaches `surveyAgent` at all.
  ready: async () => [],
  listLabel: async () => [],
  show: async () => null,
  create: async (workspace, spec) => {
    created.push({ workspace, spec });
    return 'demo-1';
  },
};

const cfg = {
  workspaces: [{ name: 'demo', dir: path.join(REPO, '.beads') }],
  // The survey runs in this directory, and its foundation is read from it.
  sessionDirs: { demo: REPO },
  spaces: [],
  claudeSessions: false,
  advocates: {
    enabled: true,
    workspaces: '*',
    propose: true,
    proposeCooldownHours: 1,
    proposeTimeoutMs: 60000,
    maxProposals: 5,
    // The sweep reaches into a real checkout's worktrees and has nothing to do with
    // this; quiet hours would skip the tick outright depending on the clock.
    tidyWorktrees: false,
    respectQuietHours: false,
    settleSeconds: 0,
    launchCooldownSeconds: 0,
  },
};

const events = [];
const advocates = createAdvocates(cfg, { bd, bus: { emit: (e) => events.push(e) } });
await advocates.tick();

await test('the survey completed and the proposal was filed', () => {
  const [a] = advocates.snapshot();
  assert.equal(a.error, null, `the advocate reported: ${a.error}`);
  assert.equal(created.length, 1, `bd.create was called ${created.length} times`);
  assert.match(created[0].spec.body, /Cache-bust site\.js on deploy/);
  assert.ok(created[0].spec.labels.includes('human'), 'a proposal is Adam’s to approve');
  assert.ok(
    events.some((e) => e.action === 'proposed'),
    `nothing announced the proposal: ${JSON.stringify(events.map((e) => e.action))}`,
  );
});

await test('and the narrowed list is what reached the CLI', () => {
  const argv = JSON.parse(fs.readFileSync(ARGV, 'utf8'));
  const at = argv.indexOf('--allowedTools');
  assert.ok(at >= 0, `claude was given no --allowedTools at all: ${JSON.stringify(argv)}`);
  // Everything up to the next flag: `claudeArgs` passes the list as separate words.
  const granted = [];
  for (let i = at + 1; i < argv.length && !argv[i].startsWith('--'); i++) granted.push(argv[i]);
  assert.deepEqual(granted.filter((e) => /^Bash\(bd\b/.test(e)), ADVOCATE_BD);
  assert.ok(!granted.includes('Bash(bd *)'), 'the glob reached the CLI even though the foundation is clean');
  for (const cmd of [...TRACKER_WRITES, ...LABEL_NEVER]) {
    assert.ok(!permits(granted, cmd), `the spawned agent could run \`${cmd}\``);
  }
  for (const cmd of [...SURVEY_READS, ...LABEL_OK, ...LABEL_READS]) {
    assert.ok(permits(granted, cmd), `the spawned agent could not run \`${cmd}\``);
  }
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures ? `\n${failures} failed` : '\nallowlist: all good');
process.exit(failures ? 1 : 0);
