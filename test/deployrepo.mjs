#!/usr/bin/env node
/**
 * A deploy, a board card and a release queue are keyed by **repo**, not by workspace.
 *
 *     npm test
 *     node test/deployrepo.mjs
 *
 * bc-l853.6, and the failure it is about does not look like a failure. A workspace used to
 * be a repo, so `cfg.deploys.climative` was a config line somebody could write, the Ship
 * button on a merged Climative pull request drew itself, and what it deployed was
 * `architecture` — whichever of forty services the pull request was actually in. Nothing
 * threw, nothing was red, and the wrong thing went live.
 *
 * So the assertions here are all about *not* answering:
 *
 * 1. **A bare multi-repo key resolves to nothing.** `deploys.climative` must be an error
 *    with the working key in its sentence, and never the default repo's deploy. That is
 *    the one check that would have caught the original bug.
 * 2. **Numbers do not leak between repos.** Two services in one workspace each have a #1,
 *    so the board's row keys, the release ledger and the deploy journal are all asserted to
 *    keep them apart. A ledger keyed by workspace reads #1 of one service as already filed
 *    because the other's was.
 * 3. **A deploy of one repo ships that repo only.** An `ok` record for `climative/alpha`
 *    must leave beta's merge owed, which is the whole of what a per-repo queue means.
 * 4. **Nothing changes for a workspace that is one repo.** The same cfg, the same keys, the
 *    same journal records — including ones written before keys existed, which carry a
 *    `workspace` and no `key` and must still group correctly.
 *
 * Real git in a temp directory, a fake `gh` on PATH that answers per checkout, `bd` as an
 * object. Nothing here touches the network, GitHub, a bead, or any repo of yours.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

/* ------------------------------------------------------------------ the world */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-deployrepo-'));
const CONFIG = path.join(tmp, 'config');
fs.mkdirSync(CONFIG, { recursive: true });
// Before lib/config.js is loaded: CONFIG_DIR is resolved at module load, and the deploy
// journal and the release ledger both live under it.
process.env.BEADCAUSE_CONFIG_DIR = CONFIG;

const BIN = path.join(tmp, 'bin');
const CLIMATIVE = path.join(tmp, 'climative.dev');
const BEADS = path.join(tmp, 'beads', 'climative', '.beads');
const SOLO_BEADS = path.join(tmp, 'beads', 'widgets', '.beads');
for (const d of [BIN, BEADS, SOLO_BEADS, CLIMATIVE]) fs.mkdirSync(d, { recursive: true });

const STATE = path.join(tmp, 'gh-state.json');
const LOG = path.join(tmp, 'gh-calls.log');

/**
 * A `gh` that answers **per working directory**, which is the whole point of it here: the
 * board must ask each checkout its own question, and a fake that answered the same thing
 * everywhere would pass a board that only ever looked at one repo.
 */
const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const state = JSON.parse(fs.readFileSync(process.env.GH_FAKE_STATE, 'utf8'));
const args = process.argv.slice(2);
const here = path.basename(process.cwd());
fs.appendFileSync(state.log, JSON.stringify({ args: args, cwd: process.cwd() }) + '\\n');
const out = (s) => { process.stdout.write(s); process.exit(0); };
const fail = (m) => { process.stderr.write(m + '\\nUsage: gh <command>\\n'); process.exit(1); };

if (args[0] === 'auth' && args[1] === 'status') out('Logged in to github.com\\n');
if (args[0] === 'repo' && args[1] === 'view') {
  const slug = state.slugs[here];
  if (!slug) fail('none of the git remotes point to a known GitHub host');
  // -q is a jq filter and real gh applies it. Ignoring it here printed the whole object
  // where lib/pr.js expected a branch name, which made every base 'origin/{"name…' and
  // every lamp null — a fake that is wrong in the direction of "cannot say".
  if (args.includes('-q')) out('main');
  out(JSON.stringify({ nameWithOwner: slug, defaultBranchRef: { name: 'main' } }));
}
if (args[0] === 'pr' && args[1] === 'list') out(JSON.stringify(state.prs[here] || []));
fail('unknown gh invocation: ' + args.join(' '));
`;
fs.writeFileSync(path.join(BIN, 'gh'), FAKE_GH, { mode: 0o755 });
process.env.GH_FAKE_STATE = STATE;
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;

const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 't@e',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 't@e',
    },
  }).trim();

/**
 * One approved repo: a real checkout with a real `origin`, and a `config/config.yaml`
 * declaring its service token the way a Climative service does.
 */
function makeRepo(name, token) {
  const origin = path.join(tmp, `${name}.git`);
  const dir = path.join(CLIMATIVE, name);
  git(tmp, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  git(tmp, 'clone', '--quiet', origin, dir);
  git(dir, 'config', 'user.email', 't@e');
  git(dir, 'config', 'user.name', 'test');
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'config.yaml'), `serviceToken: ${token}\nname: ${name}\n`);
  git(dir, 'add', '.');
  git(dir, 'commit', '--quiet', '-m', 'declare the service');
  const merge = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'push', '--quiet', '-u', 'origin', 'main');
  return { name, token, dir, origin, merge };
}

const alpha = makeRepo('alpha-service', 'al');
const beta = makeRepo('beta-service', 'bt');

const iso = (minsAgo) => new Date(Date.now() - minsAgo * 60000).toISOString();

/**
 * Both repos have a merged **#1**. That is not incidental — it is the collision the whole
 * per-repo keying exists for, and every fixture here would pass with distinct numbers.
 */
const mergedPr = (repo, over = {}) => ({
  number: 1,
  url: `https://github.com/acme/${repo.name}/pull/1`,
  title: `${repo.name} #1`,
  state: 'MERGED',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  headRefName: 'worktree-something',
  baseRefName: 'main',
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  statusCheckRollup: [],
  reviewDecision: null,
  mergedAt: iso(30),
  // An object, as `gh` answers it — `pr.list` reads `.oid`, and a bare string here would
  // leave every merge with no commit and every lamp answering null for the wrong reason.
  mergeCommit: { oid: repo.merge },
  body: '',
  author: { login: 'someone' },
  createdAt: iso(60),
  updatedAt: iso(30),
  ...over,
});

fs.writeFileSync(
  STATE,
  JSON.stringify(
    {
      log: LOG,
      slugs: { 'alpha-service': 'acme/alpha-service', 'beta-service': 'acme/beta-service' },
      prs: { 'alpha-service': [mergedPr(alpha)], 'beta-service': [mergedPr(beta)] },
    },
    null,
    2
  )
);

const cfg = {
  workspaces: [
    { name: 'climative', dir: BEADS },
    { name: 'widgets', dir: SOLO_BEADS },
  ],
  sessionDirs: { widgets: alpha.dir },
  repos: {
    climative: { root: CLIMATIVE, default: 'alpha-service', approved: ['alpha-service', 'beta-service'] },
  },
  pr: { base: 'main' },
  deploys: {
    'climative/beta-service': { command: ['echo', 'shipped', '{dir}'], pull: false },
  },
};

const bd = { json: async () => [], show: async () => null, listLabel: async () => [] };

const repos = await import(path.join(ROOT, 'lib', 'repos.js'));
const deploy = await import(path.join(ROOT, 'lib', 'deploy.js'));
const release = await import(path.join(ROOT, 'lib', 'release.js'));
const prboard = await import(path.join(ROOT, 'lib', 'prboard.js'));

/* ------------------------------------------------------------------- the keys */

console.log('\nthe key a repo is addressed by');

const units = repos.repoUnits(cfg, 'climative');
check(
  'a workspace with an approved list has one unit per repo, in the order it was written',
  units.length === 2 && units[0].key === 'climative/alpha-service' && units[1].key === 'climative/beta-service',
  JSON.stringify(units.map((u) => u.key))
);
check(
  'a workspace that is one repo keys by its own name, exactly as it always did',
  JSON.stringify(repos.repoUnits(cfg, 'widgets').map((u) => u.key)) === '["widgets"]',
  JSON.stringify(repos.repoUnits(cfg, 'widgets'))
);

const byName = repos.unitFor(cfg, 'climative/beta-service');
const byToken = repos.unitFor(cfg, 'climative/bt');
check(
  'the half after the slash names a repo by directory name or by service token',
  byName.repo?.dir === beta.dir && byToken.key === 'climative/beta-service',
  `${byName.repo?.dir} / ${byToken.key}`
);

const bare = repos.unitFor(cfg, 'climative');
check(
  'a bare multi-repo workspace names no checkout, and the refusal carries a key that works',
  Boolean(bare.problem) && !bare.repo && bare.problem.includes('climative/alpha-service'),
  bare.problem || '(no problem reported)'
);
check(
  'an unknown repo is refused with the approved list in the sentence, never the default',
  (() => {
    const u = repos.unitFor(cfg, 'climative/gamma-service');
    return !u.repo && /gamma-service/.test(u.problem || '') && /alpha-service/.test(u.problem || '');
  })(),
  JSON.stringify(repos.unitFor(cfg, 'climative/gamma-service'))
);
check(
  'a single-repo workspace refuses a repo half rather than ignoring it',
  Boolean(repos.unitFor(cfg, 'widgets/anything').problem),
  JSON.stringify(repos.unitFor(cfg, 'widgets/anything'))
);

/* ----------------------------------------------------------------- the deploy */

console.log('\nthe declaration');

const plan = deploy.deployFor(cfg, 'climative/beta-service');
check(
  'the plan names the repo it is about and that repo’s own checkout',
  plan?.dir === fs.realpathSync(beta.dir) || plan?.dir === beta.dir,
  `${plan?.dir} (wanted ${beta.dir})`
);
check(
  'and carries the key, the workspace and the repo, which are three different facts',
  plan?.key === 'climative/beta-service' && plan?.workspace === 'climative' && plan?.repo === 'beta-service',
  JSON.stringify({ key: plan?.key, workspace: plan?.workspace, repo: plan?.repo })
);
check(
  '{dir} expands to that repo and not to the workspace’s default',
  plan?.command.join(' ').includes(beta.dir),
  plan?.command.join(' ')
);
check(
  'the repo that declared nothing gets null, which is a state and not an error',
  deploy.deployFor(cfg, 'climative/alpha-service') === null,
  'alpha-service resolved a plan it never declared'
);

let threw = null;
try {
  deploy.deployFor({ ...cfg, deploys: { climative: { command: ['echo', 'no'] } } }, 'climative');
} catch (err) {
  threw = err;
}
check(
  'a declaration keyed by a multi-repo workspace throws rather than deploying the default repo',
  threw?.status === 422 && /names no checkout/.test(threw.message),
  threw ? threw.message : '(it resolved a plan)'
);

check(
  'deployable lists repo keys, so a button is offered for the one repo that declared one',
  JSON.stringify(deploy.deployable(cfg)) === '["climative/beta-service"]',
  JSON.stringify(deploy.deployable(cfg))
);

check(
  'a journal record written before keys existed still groups by its workspace',
  deploy.keyOf({ workspace: 'widgets' }) === 'widgets' &&
    deploy.keyOf({ key: 'climative/beta-service', workspace: 'climative' }) === 'climative/beta-service',
  'keyOf disagreed with an older record'
);
check(
  'and a record says where it ran without repeating the workspace where it is the repo',
  deploy.whereOf({ workspace: 'widgets' }) === 'widgets' &&
    deploy.whereOf({ workspace: 'climative', repo: 'beta-service' }) === 'climative · beta-service',
  `${deploy.whereOf({ workspace: 'widgets' })} / ${deploy.whereOf({ workspace: 'climative', repo: 'beta-service' })}`
);

/* ------------------------------------------------------------------ the board */

console.log('\nthe board');

const BOOT = { dir: ROOT, common: ROOT, commit: 'f'.repeat(40), short: 'fffffff', at: new Date().toISOString() };

/** A deploy of alpha only, exited 0, after both merges. Beta must stay owed. */
const journal = [
  {
    id: 'd-alpha',
    key: 'climative/alpha-service',
    workspace: 'climative',
    repo: 'alpha-service',
    status: 'ok',
    requestedAt: iso(5),
    startedAt: iso(5),
    finishedAt: iso(4),
  },
];

prboard.forgetBoard();
prboard.forgetRows();
const board = await prboard.collectBoard(bd, cfg, { force: true, boot: BOOT, deploys: journal });
const cards = (board.repos || []).filter((c) => c.workspace === 'climative');

check(
  'a workspace with an approved list draws one card per approved repo',
  cards.length === 2 && cards.every((c) => c.repo),
  JSON.stringify(cards.map((c) => [c.key, c.repo]))
);
check(
  'each card names its own GitHub repo, its own checkout and its own key',
  cards.every((c) => c.repo === `acme/${c.repoName}` && c.dir.endsWith(c.repoName) && c.key === `climative/${c.repoName}`),
  JSON.stringify(cards.map((c) => [c.key, c.repo, c.dir]))
);
check(
  'a row is keyed by repo and number, so two #1s in one workspace are two rows',
  (() => {
    const keys = cards.flatMap((c) => c.prs.map((p) => p.key)).sort();
    return keys.length === 2 && keys[0] === 'climative/alpha-service#1' && keys[1] === 'climative/beta-service#1';
  })(),
  JSON.stringify(cards.flatMap((c) => c.prs.map((p) => p.key)))
);
check(
  'the single-repo workspace on the same board keeps the key it always had',
  (board.repos || []).some((c) => c.key === 'widgets'),
  JSON.stringify((board.repos || []).map((c) => c.key))
);

const alphaCard = cards.find((c) => c.repoName === 'alpha-service');
const betaCard = cards.find((c) => c.repoName === 'beta-service');
check(
  'the declared deploy is on the repo that declared it and on no other card',
  betaCard?.deployDeclared === true && alphaCard?.deployDeclared === false,
  JSON.stringify({ alpha: alphaCard?.deployDeclared, beta: betaCard?.deployDeclared })
);
check(
  'a deploy of one repo settles that repo’s merge and leaves the other owed',
  alphaCard?.prs[0]?.shipped === true && betaCard?.prs[0]?.shipped === false,
  JSON.stringify({ alpha: alphaCard?.prs[0]?.shipped, beta: betaCard?.prs[0]?.shipped })
);

/* ------------------------------------------------------------------ the queue */

console.log('\nthe release queue');

const decorated = release.decorateBoard(board, {}, journal);
const queueOf = (name) => decorated.repos.find((c) => c.repoName === name)?.release;
check(
  'the queue is per repo: beta owes one ship, alpha owes none',
  queueOf('beta-service')?.count === 1 && queueOf('alpha-service')?.count === 0,
  JSON.stringify({ alpha: queueOf('alpha-service')?.count, beta: queueOf('beta-service')?.count })
);
check(
  'and the button says which of the two acts it is, per repo',
  queueOf('beta-service')?.can === 'deploy' && queueOf('alpha-service')?.can === 'session',
  JSON.stringify({ alpha: queueOf('alpha-service')?.can, beta: queueOf('beta-service')?.can })
);

/* A ledger keyed by workspace: #1 filed for one repo, which must say nothing about the
   other repo's #1. This is the state the old shape produced, read back through the new
   code — the assertion is that they are separate entries, not that one is missing. */
const ledger = {
  'climative/beta-service': { since: iso(600), handled: { 1: { bead: 'cl-bbb', shippedAt: null } } },
};
// `releaseFor` takes *this repo's* records — the grouping is `decorateBoard`'s, asserted
// above — so beta's are none of them: the only deploy in the journal is alpha's.
const withBead = release.releaseFor(betaCard, [], ledger);
const alphaOwed = release.releaseFor(
  { ...alphaCard, prs: alphaCard.prs.map((p) => ({ ...p, shipped: false })) },
  [],
  ledger
);
check(
  'a ship bead filed for one repo’s #1 is not read as the other repo’s #1',
  withBead.prs[0]?.bead === 'cl-bbb' && (alphaOwed.prs[0]?.bead ?? null) === null,
  JSON.stringify({ beta: withBead.prs[0]?.bead, alpha: alphaOwed.prs[0]?.bead })
);

/* The watermark, through the real sweep. Two repos, two entries, and nothing filed —
   which is the first-sight rule, and the reason a re-key is safe rather than a flood. */
const swept = await release.sweepReleases(bd, cfg, decorated, { deploys: journal, owner: 'you' });
const marked = swept.watermarked.map((w) => w.key).sort();
check(
  'the first sweep watermarks the repo it could ship, keyed per repo, and files nothing',
  swept.filed.length === 0 && marked.length === 1 && marked[0] === 'climative/beta-service',
  JSON.stringify({ filed: swept.filed, marked })
);
check(
  'and skips the repo whose ship it could never see — a bead nothing can close is not filed',
  !marked.includes('climative/alpha-service'),
  JSON.stringify(marked)
);
check(
  'and the log line for it names the repo rather than only the tracker',
  swept.watermarked.every((w) => w.where === `climative · ${w.key.split('/')[1]}`),
  JSON.stringify(swept.watermarked.map((w) => w.where))
);

/* ------------------------------------------------------ what the sweep asked gh */

console.log('\nwhat it cost');

const calls = fs
  .readFileSync(LOG, 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const listed = calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'list');
check(
  'the board asked each approved checkout for its own pull requests',
  new Set(listed.map((c) => path.basename(c.cwd))).size === 2,
  JSON.stringify(listed.map((c) => path.basename(c.cwd)))
);

const before = listed.length;
const listCalls = () =>
  fs
    .readFileSync(LOG, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((c) => c.args[0] === 'pr' && c.args[1] === 'list');

await prboard.collectBoard(bd, cfg, { force: true, boot: BOOT, deploys: journal });
const forced = listCalls().length;
check(
  'a forced sweep re-asks — force must reach the per-repo cache, or ⟳ is a lie',
  forced > before,
  `${before} → ${forced} pr list calls`
);

/* The poll's own path: the board cache is warm, so nothing is asked at all. This is the
   one that decides whether a phone left open on /prs is forty network calls every 25
   seconds or none. */
await prboard.collectBoard(bd, cfg, { boot: BOOT, deploys: journal });
check(
  'an unforced sweep inside the board cache asks gh nothing',
  listCalls().length === forced,
  `${forced} → ${listCalls().length} pr list calls`
);

/* And the act path. `forgetBoard(dir)` is what a merge calls: the repo it acted on must be
   re-asked — a merged pull request drawn as open is the whole point of dropping it — and the
   others must not be, because on a forty-repo workspace that is thirty-nine calls to learn
   nothing. */
prboard.forgetBoard(betaCard.dir);
await prboard.collectBoard(bd, cfg, { boot: BOOT, deploys: journal });
const afterAct = listCalls();
const asked = afterAct.slice(forced).map((c) => path.basename(c.cwd));
check(
  'dropping one checkout’s cache re-asks that repo and only that repo',
  asked.length === 1 && asked[0] === 'beta-service',
  JSON.stringify(asked)
);

/* ------------------------------------------------------------------------ done */

console.log(failures ? `\n${failures} failed` : '\nall good');
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
