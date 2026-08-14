#!/usr/bin/env node
/**
 * lib/reposcan.js — the tree under a workspace's root, read out loud so it can be approved.
 *
 *     npm test
 *     node test/reposcan.mjs
 *
 * This is the half of the approved list that reads a directory, so every check here is
 * ultimately the same question: does *showing* somebody their checkouts ever amount to
 * approving one? Six things are worth a file:
 *
 * 1. **An install with no multi-repo workspace is asked nothing.** `scanTargets` returns
 *    empty, so `npm run configure` prints no last question at all. Almost every install
 *    is this one, and a wizard that asked everybody about a shape only a company has
 *    would be eleven useful questions and one that reads like a mistake.
 * 2. **The guess is narrow, and `~/beads` is never it.** A directory named after the
 *    workspace holding two or more git checkouts. `~/beads/<workspace>` is named after
 *    the workspace by construction and is the tracker's own tree, so it must never be
 *    offered as a place to open sessions in.
 * 3. **Everything under the root is shown, including what cannot be approved.** A repo
 *    that declares no token, and a directory that is not a checkout at all, are more
 *    useful on screen with the reason beside them than missing from a list about to be
 *    ticked.
 * 4. **A trailing YAML comment is not part of the token** — the same trap as
 *    `test/repos.mjs` reason 5, asserted again here because a setup screen that offered
 *    `prs   # ps already in use by project-service` would offer a token the resolver will
 *    never agree with.
 * 5. **Only what is named is approved, and Enter changes nothing.** The default the wizard
 *    offers is the current list, so it has to round-trip exactly and silently; nothing
 *    unticked may survive; and a number that is not in the printed list is dropped rather
 *    than written.
 * 6. **Nothing here writes.** Asserted against the module's own source, the way
 *    `test/repos.mjs` asserts there is no `readdir` in the resolver: discovery presented
 *    for approval is a different thing from discovery applied, and one `saveConfig` added
 *    later "to be helpful" would be the difference.
 *
 * Entirely on a temp tree, with `HOME` pointed into it — `candidateRoot` searches the home
 * directory, and a suite that let it see the real one would pass or fail depending on
 * whose Mac it ran on.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-reposcan-'));
// Before anything under lib/ is imported. os.homedir() reads $HOME on POSIX at call time,
// which is the only reason this suite can say anything about what would be guessed.
const REAL_HOME = process.env.HOME;
process.env.HOME = tmp;
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { candidateRoot, scanTargets, scanRoot, parseApproved, resolveDefaultChoice, tildeHome } = await import(
  LIB('reposcan.js')
);
const { repoList, resolveRepo, forgetRepos } = await import(LIB('repos.js'));

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

/* ------------------------------------------------------------------ the tree */

const ROOT = path.join(tmp, 'climative.dev');

/** A checkout with a `config/config.yaml`. `token: null` writes a file that declares none. */
function checkout(root, name, token, { git = true, file = 'config/config.yaml' } = {}) {
  const dir = path.join(root, name);
  if (git) fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  if (token !== false) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const lines = ['---', `serviceName: ${name}`];
    if (token !== null) lines.push(`serviceToken: ${token}`);
    lines.push('serviceType: internal');
    fs.writeFileSync(target, `${lines.join('\n')}\n`);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

checkout(ROOT, 'architecture', 'architecture');
checkout(ROOT, 'athena-service', 'as');
checkout(ROOT, 'audit-service', 'as');
checkout(ROOT, 'building-service', 'bs');
// The real one, comment and all.
checkout(ROOT, 'provisioning-service', 'prs   # ps already in use by project-service');
// Cloned, and it declares nothing.
checkout(ROOT, 'climative-apps', null);
// Cloned, never approved anywhere below. It has a perfectly good token.
checkout(ROOT, 'secrets-service', 'ss');
// Not a checkout at all: the scratch directory every big tree grows.
checkout(ROOT, 'tmp', false, { git: false });

// A single-repo workspace: the shape almost every install has, and it must be silent.
fs.mkdirSync(path.join(tmp, 'sophab', '.git'), { recursive: true });
// The tracker's own tree, holding something that looks like two checkouts.
checkout(path.join(tmp, 'beads', 'hivemind'), 'one', 'a');
checkout(path.join(tmp, 'beads', 'hivemind'), 'two', 'b');
// Named with a dash instead of a dot, and found the same way.
checkout(path.join(tmp, 'deluvia-src'), 'one', 'a');
checkout(path.join(tmp, 'deluvia-src'), 'two', 'b');
// A prefix with no separator after it is a different word, not this workspace.
checkout(path.join(tmp, 'climativeXX'), 'one', 'a');
checkout(path.join(tmp, 'climativeXX'), 'two', 'b');

const WORKSPACES = [{ name: 'climative' }, { name: 'sophab' }, { name: 'deluvia' }, { name: 'hivemind' }];
const BEADS = path.join(tmp, 'beads');

/* --------------------------------------------- 1. an install with one repo per workspace */

console.log('\nan install with no multi-repo workspace is asked nothing');
{
  const cfg = { workspaces: [{ name: 'sophab' }], assetRoots: [BEADS], repos: {} };
  check('scanTargets is empty, so the question is never printed', scanTargets(cfg).length === 0, JSON.stringify(scanTargets(cfg)));
  check('a workspace that is one checkout is not a candidate root', candidateRoot(cfg, 'sophab') === null, String(candidateRoot(cfg, 'sophab')));
  check('and neither is a workspace with no directory at all', candidateRoot(cfg, 'beadcause') === null, String(candidateRoot(cfg, 'beadcause')));
}

/* -------------------------------------------------------------- 2. the guess is narrow */

console.log('\nthe guess is a tree of checkouts named after the workspace, and never ~/beads');
{
  const cfg = { workspaces: WORKSPACES, assetRoots: [BEADS], projectRoot: null, repos: {} };
  check('climative → ~/climative.dev', candidateRoot(cfg, 'climative') === ROOT, String(candidateRoot(cfg, 'climative')));
  check('a dash separates just as well as a dot', candidateRoot(cfg, 'deluvia') === path.join(tmp, 'deluvia-src'), String(candidateRoot(cfg, 'deluvia')));
  check(
    '~/beads/hivemind is never offered, whatever is inside it',
    candidateRoot(cfg, 'hivemind') === null,
    String(candidateRoot(cfg, 'hivemind'))
  );
  check('a prefix with no separator is a different word', candidateRoot(cfg, 'climativeX') === null, String(candidateRoot(cfg, 'climativeX')));
  const targets = scanTargets(cfg);
  check('so two of the four workspaces are asked about', targets.length === 2, JSON.stringify(targets));
  check('each one saying it was guessed rather than configured', targets.every((t) => t.source === 'guess'), JSON.stringify(targets));
  check('and workspaces given as bare strings work the same', scanTargets({ workspaces: ['climative'] }).length === 1);
}

/* ------------------------------------------ 3. a configured workspace is always asked */

console.log('\na workspace that is already configured is asked whatever is on disk');
{
  const moved = { workspaces: WORKSPACES, repos: { climative: { root: path.join(tmp, 'gone'), approved: ['architecture'] } } };
  const [t] = scanTargets(moved);
  check('a root that has moved is still offered, so it can be fixed', t?.root === path.join(tmp, 'gone'), JSON.stringify(t));
  check('and it says the block is where that came from', t?.source === 'config', JSON.stringify(t));
  check('scanRoot says it is not there rather than throwing', scanRoot(path.join(tmp, 'gone')).exists === false);
  const rootless = scanTargets({ workspaces: WORKSPACES, repos: { climative: { approved: [] } } });
  check('a block with no root is asked for one', rootless[0]?.workspace === 'climative' && rootless[0]?.root === null, JSON.stringify(rootless));
  check('the guess does not override a configured root', scanTargets(moved).filter((x) => x.workspace === 'climative').length === 1);
}

/* ------------------------------------------------------- 4. everything under the root */

console.log('\nthe whole tree is shown, with what each directory calls itself');
{
  const scan = scanRoot(ROOT);
  const at = (n) => scan.found.find((r) => r.name === n);
  check('every directory is there, in name order', scan.found.length === 8, JSON.stringify(scan.found.map((r) => r.name)));
  check(
    'in name order',
    JSON.stringify(scan.found.map((r) => r.name)) === JSON.stringify([...scan.found.map((r) => r.name)].sort()),
    JSON.stringify(scan.found.map((r) => r.name))
  );
  check('a checkout declares its token', at('building-service')?.token === 'bs', JSON.stringify(at('building-service')));
  check('a trailing comment is not part of the token', at('provisioning-service')?.token === 'prs', JSON.stringify(at('provisioning-service')));
  check('a repo that declares none says so', /declares no serviceToken/.test(at('climative-apps')?.problem || ''), String(at('climative-apps')?.problem));
  check('and is still listed rather than hidden', !!at('climative-apps'), 'a repo with no token vanished from the tree');
  check('a directory that is not a checkout says that instead', at('tmp')?.problem === 'is not a git checkout', String(at('tmp')?.problem));
  check('an unapproved repo is shown too — showing is not approving', at('secrets-service')?.token === 'ss');
  check('a colliding token is reported against both repos', scan.shared.some((s) => s.token === 'as' && s.names.length === 2), JSON.stringify(scan.shared));
  check('and a token only one repo declares is not', !scan.shared.some((s) => s.token === 'bs'), JSON.stringify(scan.shared));
  check('the root comes back resolved', scan.root === ROOT && scan.exists === true, JSON.stringify({ root: scan.root, exists: scan.exists }));
}

console.log('\nwhere the token is read from can be overridden, like the resolver');
{
  const other = path.join(tmp, 'other.dev');
  checkout(other, 'one', 'a', { file: 'service.yaml' });
  checkout(other, 'two', 'b', { file: 'service.yaml' });
  const scan = scanRoot(other, { tokenPath: 'service.yaml', tokenKey: 'serviceToken' });
  check('tokenPath is honoured', scan.found.every((r) => r.token), JSON.stringify(scan.found));
  check('and the default path is reported missing when it is', /has no config\/config\.yaml/.test(scanRoot(other).found[0]?.problem || ''), JSON.stringify(scanRoot(other).found[0]));
}

/* ------------------------------------------------ 5. only what is named is approved */

console.log('\nonly what is named is approved');
{
  const { found } = scanRoot(ROOT);
  const names = found.map((r) => r.name);
  const p = (answer, current = []) => parseApproved(answer, found, current);

  check('a number is the printed row', JSON.stringify(p('1').approved) === JSON.stringify([names[0]]), JSON.stringify(p('1')));
  check('a range is the rows between', JSON.stringify(p('1-3').approved) === JSON.stringify(names.slice(0, 3)), JSON.stringify(p('1-3').approved));
  check('a reversed range is the same rows', JSON.stringify(p('3-1').approved) === JSON.stringify(names.slice(0, 3)), JSON.stringify(p('3-1').approved));
  check(
    'numbers, ranges and names mix',
    JSON.stringify(p('1, 3-4, secrets-service').approved) === JSON.stringify([names[0], names[2], names[3], 'secrets-service']),
    JSON.stringify(p('1, 3-4, secrets-service').approved)
  );
  check('a name and the number of the same row are one entry', p('4, building-service').approved.length === 1, JSON.stringify(p('4, building-service').approved));
  check('a name is folded to the case the directory has', p('ATHENA-Service').approved[0] === 'athena-service', JSON.stringify(p('ATHENA-Service')));
  check('the same repo named twice is listed once', p('1, architecture').approved.length === 1, JSON.stringify(p('1, architecture').approved));
  check('"none" clears it', p('none').approved.length === 0 && p('none').cleared === true, JSON.stringify(p('none')));

  const current = ['architecture', 'athena-service', 'weather-service'];
  const echoed = p(current.join(', '), current);
  check('the default — the current list — round-trips exactly', JSON.stringify(echoed.approved) === JSON.stringify(current), JSON.stringify(echoed));
  check('and silently: a repo approved but not cloned is not news', echoed.unknown.length === 0, JSON.stringify(echoed.unknown));
  check('nothing unticked survives — the answer IS the list', JSON.stringify(p('architecture', current).approved) === JSON.stringify(['architecture']), JSON.stringify(p('architecture', current).approved));

  const typo = p('architecture, weather-service');
  check('a name that is not under the root is kept', typo.approved.includes('weather-service'), JSON.stringify(typo.approved));
  check('and said out loud, because it may be a repo not cloned yet', typo.unknown.includes('weather-service'), JSON.stringify(typo.unknown));

  const stray = p('1, 99');
  check('a number that is not in the list is dropped, not written', JSON.stringify(stray.approved) === JSON.stringify([names[0]]), JSON.stringify(stray.approved));
  check('and reported', stray.dropped.includes('99'), JSON.stringify(stray.dropped));
  check('a range entirely off the end is dropped too', p('50-60').dropped.includes('50-60') && p('50-60').approved.length === 0, JSON.stringify(p('50-60')));
  check('a range running off the end takes what is there', p('7-99').approved.length === 2, JSON.stringify(p('7-99').approved));
  check('nothing at all is nothing approved', p('').approved.length === 0 && p('').cleared === true, JSON.stringify(p('')));
}

/* ------------------------------------------------------------- 6. the default repo */

console.log('\nthe default repo is one of the approved ones, or it says why not');
{
  const { found } = scanRoot(ROOT);
  const approved = ['architecture', 'building-service'];
  const d = (answer) => resolveDefaultChoice(answer, approved, found);
  check('a name is taken as it is', d('architecture').value === 'architecture' && d('architecture').problem === null, JSON.stringify(d('architecture')));
  check('a service token becomes the repo it names', d('bs').value === 'building-service', JSON.stringify(d('bs')));
  check('a path becomes the repo it points at', d(path.join(ROOT, 'building-service')).value === 'building-service', JSON.stringify(d(path.join(ROOT, 'building-service'))));
  check('blank is no default, and no complaint', d('').value === null && d('').problem === null, JSON.stringify(d('')));
  const unapproved = d('ss');
  check('the token of a repo that was NOT approved is not quietly accepted', unapproved.value === 'ss' && !!unapproved.problem, JSON.stringify(unapproved));
  check('and the sentence says what will happen to a tokenless bead', /resolve to nothing/.test(unapproved.problem || ''), String(unapproved.problem));
  check('with nothing approved, a default is refused in as many words', /nothing is approved/.test(resolveDefaultChoice('architecture', [], found).problem || ''), JSON.stringify(resolveDefaultChoice('architecture', [], found)));
}

/* ---------------------------------------- 7. what it writes is what the resolver reads */

console.log('\nwhat the wizard would write is what the resolver reads back');
{
  const { found } = scanRoot(ROOT);
  const { approved } = parseApproved('architecture, athena-service, audit-service, building-service, provisioning-service', found);
  const { value } = resolveDefaultChoice('architecture', approved, found);
  const cfg = { repos: { climative: { root: tildeHome(ROOT), approved, default: value } } };
  check('the root is written with a ~ and still resolves', tildeHome(ROOT) === '~/climative.dev', tildeHome(ROOT));
  forgetRepos();
  const list = repoList(cfg, 'climative');
  check('every ticked repo resolves', list.repos.length === 5, JSON.stringify(list.repos.map((r) => r.name)));
  check('the token the wizard showed is the token that resolves', resolveRepo(cfg, 'climative', 'bs').repo?.name === 'building-service');
  check('the comment-carrying one too', resolveRepo(cfg, 'climative', 'prs').repo?.name === 'provisioning-service');
  check('the default resolves a tokenless bead', list.fallback?.name === 'architecture', JSON.stringify(list.fallback));
  check('the collision the tree warned about is the collision the resolver reports', list.duplicates.some((d) => d.token === 'as'), JSON.stringify(list.duplicates));
  check('and the repo nobody ticked resolves to nothing', resolveRepo(cfg, 'climative', 'ss').repo === null, JSON.stringify(resolveRepo(cfg, 'climative', 'ss')));
}

/* -------------------------------------------------- presented, and never applied */

console.log('\nreading a tree is not approving one');
{
  const source = fs.readFileSync(LIB('reposcan.js'), 'utf8').replace(/^\s*\*.*$/gm, '').replace(/^\s*\/\/.*$/gm, '');
  check(
    'nothing in the module writes anything — it presents, the answer approves',
    !/writeFile|saveConfig|mkdir|rmSync|appendFile/.test(source),
    'a write here would make discovery into approval'
  );
  check('and it does not import the config it would write', !/from '\.\/config\.js'/.test(source), 'reposcan reached for saveConfig');
}

process.env.HOME = REAL_HOME;
await cleanupTmp(tmp);
console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
