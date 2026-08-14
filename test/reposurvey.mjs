#!/usr/bin/env node
/**
 * **The survey agent, in a workspace that is more than one checkout.**
 *
 *     npm test
 *     node test/reposurvey.mjs
 *
 * bc-u53i, the other half of it. `surveyAgent` in lib/advocate.js opened its read-only
 * `claude` in `resolveSessionDir(cfg, a.workspace)` and nowhere else, so an advocate for
 * forty Climative repos proposed work having read `architecture` — and, because a
 * proposal carrying no `repo:` label belongs to the *default* checkout (lib/repos.js),
 * anything it did find one repo along would have been filed against the wrong one.
 *
 * The shape of the answer is worth stating, because "run it in every repo" was the
 * obvious one and is wrong. A survey is not a question about a checkout the way "which
 * pull requests are open" is; it is a question about the *tracker* — "is this queue
 * genuinely empty" — and there is one of those per workspace however many repos hang off
 * it. Forty surveys would be forty agents proposing into one graph, each blind to the
 * other thirty-nine, and `maxProposals` would stop meaning anything. So it stays one
 * run, in the default checkout, with the rest of the approved list handed to `claude` on
 * the command line.
 *
 * Three claims, and the first two are two halves of one thing — flags without the
 * paragraph is an agent that reads the directory it is standing in, and the paragraph
 * without the flags is an agent told to read forty directories it will be refused:
 *
 * 1. **`--add-dir` for every approved checkout but the one it is standing in.** `claude`
 *    refuses a read outside its working directory, so this is the whole of whether the
 *    other repos are legible at all.
 * 2. **The prompt says so, names them, and asks for the `repo:` label.** That last one is
 *    the part the agent could not work out by looking: a bead filed without a token is
 *    not refused, it *resolves*, silently, to the default repo.
 * 3. **A single-repo workspace is untouched** — no `--add-dir`, and not a sentence about
 *    checkouts in a prompt that has never needed one.
 *
 * Built on test/allowlist.mjs's fixture: a fake `claude` on PATH that writes its argv to
 * a file and answers with a fixed proposal. That argv is the only place the flags a run
 * implies can be seen as the CLI sees them — and, because the prompt is a positional
 * argument after `--`, it is where the prompt can be read too.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-reposurvey-')));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { createAdvocates } = await import(LIB('advocate.js'));
const { forgetRepos } = await import(LIB('repos.js'));
const { cleanupTmp } = await import(path.join(HERE, 'helpers', 'tmp.mjs'));

/* --------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err && err.message ? err.message : String(err)).split('\n').join('\n       ')}`);
  }
}

/* ----------------------------------------------------------------- the checkouts */

const ORG = path.join(tmp, 'climative.dev');

/** A checkout lib/repos.js can place: a git repo whose `config/config.yaml` names a token. */
function checkout(name, token) {
  const dir = path.join(ORG, name);
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'config.yaml'), `serviceToken: ${token}\n`);
  fs.mkdirSync(path.join(dir, '.beads'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

const architecture = checkout('architecture', 'architecture');
const athena = checkout('athena-service', 'as');
const building = checkout('building-service', 'bs');
const alpha = checkout('alpha', 'alpha');

/* -------------------------------------------------------------------- fake claude */

const ARGV = path.join(tmp, 'claude-argv.json');
const ANSWER = `One thing stood out.

\`\`\`beadproposal
workspace: climative
beads:
  - title: Cache-bust site.js on deploy
    type: task
    priority: 2
    description: |
      The script tag carries no ?v=, so a shipped change looks absent.
    acceptance: A deploy changes the URL the browser asks for.
    rationale: Found while surveying.
\`\`\`
`;
fs.writeFileSync(path.join(tmp, 'answer.md'), ANSWER);
const FAKEBIN = path.join(tmp, 'bin');
fs.mkdirSync(FAKEBIN, { recursive: true });
// Extensionless on purpose: node reads it as CommonJS, so it needs nothing from this
// package and cannot be tripped up by `"type": "module"` two directories up.
fs.writeFileSync(
  path.join(FAKEBIN, 'claude'),
  `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.CLAUDE_FAKE_ARGV, JSON.stringify(process.argv.slice(2), null, 2));
const answer = fs.readFileSync(process.env.CLAUDE_FAKE_ANSWER, 'utf8');
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: answer }) + '\\n');
`,
  { mode: 0o755 }
);
process.env.CLAUDE_FAKE_ARGV = ARGV;
process.env.CLAUDE_FAKE_ANSWER = path.join(tmp, 'answer.md');
// `agentEnv` builds the child's env from `process.env`, so this is how the fake wins:
// ~/.zprofile only ever *appends* to PATH, and the real claude lives at the end of it.
process.env.PATH = `${FAKEBIN}:${process.env.PATH}`;

/* ----------------------------------------------------------------------- a survey */

/**
 * One tick against an empty queue, which is the only state that reaches `surveyAgent`
 * at all, and the argv the fake `claude` was called with.
 */
async function survey({ name, repos, sessionDirs = {} }) {
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  forgetRepos();
  fs.rmSync(ARGV, { force: true });

  const cfg = {
    spaces: [],
    claudeSessions: false,
    workspaces: [{ name, dir: path.join(tmp, 'beads', name, '.beads') }],
    repos,
    sessionDirs,
    advocates: {
      enabled: true,
      workspaces: '*',
      propose: true,
      proposeCooldownHours: 1,
      proposeTimeoutMs: 60000,
      maxProposals: 5,
      // The sweep reaches into real checkouts' worktrees and has nothing to do with
      // this; quiet hours would skip the tick outright depending on the clock; and the
      // open-PR sweep would run a real `gh` against a temp directory with no remote.
      tidyWorktrees: false,
      holdOpenPrs: false,
      respectQuietHours: false,
      settleSeconds: 0,
      launchCooldownSeconds: 0,
    },
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));

  const created = [];
  const bd = {
    // Empty: an advocate only proposes when there is nothing left to work.
    ready: async () => [],
    listLabel: async () => [],
    show: async () => null,
    listStatus: async () => [],
    create: async (workspace, spec) => {
      created.push({ workspace, spec });
      return `${name}-1`;
    },
  };
  const advocates = createAdvocates(cfg, { bd, bus: { emit() {} } });
  await advocates.tick();
  const argv = JSON.parse(fs.readFileSync(ARGV, 'utf8'));
  return {
    argv,
    // The prompt is a positional operand after `--` — see `promptArgs` — so it is the
    // last thing on the command line and reading it here needs no second fixture.
    prompt: argv[argv.length - 1],
    added: argv.flatMap((a, i) => (argv[i - 1] === '--add-dir' ? [a] : [])),
    created,
    card: advocates.snapshot().find((a) => a.workspace === name),
  };
}

/* -------------------------------------------------------------------- the cases */

console.log('\nthe survey agent across many checkouts');

const many = await survey({
  name: 'climative',
  repos: {
    climative: {
      root: ORG,
      default: 'architecture',
      approved: ['architecture', 'athena-service', 'building-service'],
    },
  },
});

await check('the survey still ran and still proposed', () => {
  assert.equal(many.card.error, null, `the advocate reported: ${many.card.error}`);
  assert.equal(many.created.length, 1, `bd.create was called ${many.created.length} times`);
});

/** The acceptance criterion: every approved checkout is legible to the run. */
await check('every approved checkout but the cwd is on the command line', () => {
  assert.deepEqual(many.added.sort(), [athena, building].sort(), JSON.stringify(many.argv));
  assert.ok(
    !many.added.includes(architecture),
    'the working directory is named twice — `cwd` already carries it'
  );
});

/** Flags without a sentence is an agent that reads the directory it is standing in. */
await check('and the prompt names them, with the paths it can actually read', () => {
  assert.match(many.prompt, /3 checkouts/, 'the prompt never says how many there are');
  for (const [name, dir] of [
    ['architecture', architecture],
    ['athena-service', athena],
    ['building-service', building],
  ]) {
    assert.ok(many.prompt.includes(name), `the prompt does not name ${name}`);
    assert.ok(many.prompt.includes(dir), `the prompt does not give ${name}'s path`);
  }
  assert.match(many.prompt, /you are here/, 'and nothing says which one it is standing in');
});

/**
 * The half the agent could not have worked out by looking. A proposed bead with no
 * `repo:` label is not refused — it resolves, to the default checkout — so work found in
 * `athena-service` and filed without one reads perfectly well on the card and opens its
 * session in the wrong tree.
 */
await check('and it asks for the repo: label a proposal one repo along needs', () => {
  assert.match(many.prompt, /repo:<token>/, many.prompt.slice(0, 400));
  assert.match(many.prompt, /service token `as`/, 'the token a bead would carry is never given');
});

/** Every workspace on this Mac but Climative, and it must pay none of the above. */
const one = await survey({ name: 'alpha', repos: {}, sessionDirs: { alpha: alpha } });

await check('a single-repo workspace gets no --add-dir and no paragraph', () => {
  assert.deepEqual(one.added, [], JSON.stringify(one.argv));
  assert.ok(!one.prompt.includes('checkouts, and you can read all of them'), 'a paragraph about one repo');
  assert.equal(one.created.length, 1, 'and it still surveyed and still proposed');
});

/* ----------------------------------------------------------------------- teardown */

await cleanupTmp(tmp);
console.log(`\n${ran - failures}/${ran} ok`);
process.exit(failures ? 1 : 0);
