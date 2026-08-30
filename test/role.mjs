#!/usr/bin/env node
//
// b7e-role — a relay role's whole operating contract, in one call (bc-dgx7.77).
//
//   npm test
//   node test/role.mjs
//
// Two halves. The first drives lib/rolecontract.js's markdown slicing against literal
// fixture strings — no checkout needed, and it is where the fence-blanking rule earns its
// keep: clio's real output template is a worked example that itself contains `##`/`###`
// lines, and a naive heading scanner cuts it off after two lines of the example. The
// second drives the bin/b7e-role CLI end to end against a fixture directory built on disk,
// with its own isolated config (`BEADCAUSE_CONFIG_DIR`) naming a fake workspace — this
// suite must not depend on the real deluvia checkout existing on the machine it runs on.
// The one exception is the last block, which checks the *shipped* `deluvia` relay
// default — roster only, no file reads, so it holds on a machine that has never heard of
// deluvia (the same guarantee test/relay.mjs's last check already relies on).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-role');

const rc = await import(path.join(ROOT, 'lib', 'rolecontract.js'));

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

/* ==================================================================== 1. lib/rolecontract.js */

console.log('\nlib/rolecontract.js — the markdown slicing\n');

{
  const charter = [
    '# CHARTER',
    '',
    '## 1. Preamble',
    'Some prose that mentions clio and muse in passing, not as headings.',
    '',
    '## 2. The one law',
    '',
    '**Agents draft. Adam approves.**',
    '',
    '- corollary one',
    '- corollary two',
    '',
    '---',
    '',
    '## 3. The hierarchy',
    'more prose',
    '',
    '### STORY — `dept:story` · lead: script · gates G0, G1',
    '',
    '#### lore — world builder',
    '',
    '- **Job.** proposes canon',
    '- **May NOT decide.** whether it is good',
    '',
    '#### clio — continuity guardian · *the court of fact*',
    '',
    '- **Job.** checks canon',
    '- **May NOT decide.** whether it is good',
    '',
    '### DESIGN — `dept:design` · lead: palette · gate G2',
    '',
    '#### palette — art director',
    '',
    '- **Job.** sets the look',
    '',
  ].join('\n');

  const law = rc.oneLawSection(charter);
  check('finds the one-law section by heading, not by name-dropping prose', law && law.heading.includes('one law'));
  check('one-law body carries the corollaries', law.body.includes('corollary one') && law.body.includes('corollary two'));
  check('one-law body stops before the next `##` heading', !law.body.includes('The hierarchy'));
  check('the trailing --- divider is trimmed off the body', !law.body.trimEnd().endsWith('---'));
  check('one-law line numbers point at the real heading line', charter.split('\n')[law.startLine - 1].includes('The one law'));

  const clio = rc.charterBlock(charter, 'clio');
  check('finds the role by its own #### heading', clio && clio.heading.startsWith('clio'));
  check('does not match a role name mentioned only in prose', rc.charterBlock(charter, 'muse') === null);
  check('the block stops before the next #### heading (design/palette)', !clio.body.includes('DESIGN') && !clio.body.includes('palette'));
  check('the block is case-insensitive on the role name', rc.charterBlock(charter, 'CLIO') !== null);
  check('an unknown role finds no block', rc.charterBlock(charter, 'nobody') === null);

  const gates = rc.departmentGates(charter);
  check('reads a plural "gates" list', gates['dept:story']?.join(',') === 'G0,G1');
  check('reads a singular "gate"', gates['dept:design']?.join(',') === 'G2');
}

{
  // clio's real shape: an "## Output Format" section whose worked example is itself
  // written in headings, fenced so it reads as an example rather than more of the doc.
  const roleFile = [
    '# Someone — a title',
    '',
    '## Output Format',
    '',
    '```',
    '## Someone\'s Report — CHAPTER [N]',
    '',
    '### 1. Check — [PASS/FLAG]',
    '[finding]',
    '```',
    '',
    '---',
    '',
    '## What Someone Does Not Do',
    '- nothing outside the brief',
  ].join('\n');

  const tpl = rc.outputTemplate(roleFile);
  check('finds the Output Format heading', tpl && tpl.heading === 'Output Format');
  check(
    'a fenced worked example full of ## / ### lines does not fool the section boundary',
    tpl.body.includes('CHANGE') || tpl.body.includes('[finding]'),
  );
  check('the template stops at the next real heading, not at the example', !tpl.body.includes('Does Not Do'));

  const noTemplate = ['# Someone', '', '## Production Contract', 'a table, no Output section'].join('\n');
  check('a role file that declares no Output heading answers null, not empty', rc.outputTemplate(noTemplate) === null);

  const outputsHeading = ['# X', '', '## Outputs', 'a list of outputs', '', '## Hands to', 'y'].join('\n');
  check('"Outputs" (plural, no "Format") still matches', rc.outputTemplate(outputsHeading)?.heading === 'Outputs');

  const locationHeading = ['# X', '', '## Output Location', 'lives under out/', '', '## Next', 'z'].join('\n');
  check('"Output Location" still matches', rc.outputTemplate(locationHeading)?.heading === 'Output Location');
}

{
  const src = [
    'const x = 1;',
    '',
    'export function rolesOf(def) {',
    '  const roles = new Set();',
    '  for (const x of [1, 2]) {',
    '    if (x) roles.add(x);',
    '  }',
    '  return roles;',
    '}',
    '',
    'export function other() {}',
  ].join('\n');
  const r = rc.functionRange(src, 'rolesOf');
  check('functionRange finds the function\'s own opening line', src.split('\n')[r.startLine - 1].includes('export function rolesOf'));
  check('functionRange stops at the matching closing brace, not the first one', src.split('\n')[r.endLine - 1].trim() === '}' && r.endLine === 9);
  check('an unknown function name answers null', rc.functionRange(src, 'nope') === null);
}

/* ==================================================================== 2. bin/b7e-role CLI */

console.log('\nbin/b7e-role — the CLI, against a fixture workspace\n');

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-role-test-'));

/** A fixture workspace on disk: a two-role, one-department charter plus profile files. */
function makeWorkspace() {
  const work = path.join(tmp, `ws-${fs.readdirSync(tmp).length}`);
  fs.mkdirSync(path.join(work, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(work, 'ai-context', 'agents', 'aria'), { recursive: true });
  fs.mkdirSync(path.join(work, 'ai-context', 'agents', 'clio'), { recursive: true });
  fs.mkdirSync(path.join(work, 'ai-context', 'agents', 'vox'), { recursive: true });

  fs.writeFileSync(
    path.join(work, 'docs', 'CHARTER.md'),
    [
      '# CHARTER',
      '',
      '## 2. The one law',
      '',
      '**Agents draft. Adam approves.**',
      '',
      '---',
      '',
      '## 3. The hierarchy',
      '',
      '### EXECUTIVE',
      '',
      '#### vox — showrunner',
      '',
      '- **Job.** holds the whole thing',
      '',
      '### STORY — `dept:story` · lead: aria · gate G0',
      '',
      '#### aria — novelist',
      '',
      '- **Job.** writes chapters',
      '- **May NOT decide.** whether a chapter ships',
      '',
      '#### clio — continuity guardian',
      '',
      '- **Job.** checks canon',
      '- **May NOT decide.** whether prose is good',
      '',
    ].join('\n'),
  );

  fs.writeFileSync(
    path.join(work, 'ai-context', 'agents', 'aria', 'aria.md'),
    ['# Aria', '', '## Output Format', '', 'a chapter, in prose', '', '## Hands to', 'clio'].join('\n'),
  );
  fs.writeFileSync(
    path.join(work, 'ai-context', 'agents', 'clio', 'clio.md'),
    ['# Clio', '', '## Persona', 'suspicious of everything'].join('\n'),
  );
  // vox's profile is declared by the relay but never written — the "missing, not empty" case.
  return work;
}

/** An isolated `BEADCAUSE_CONFIG_DIR` whose config.json defines exactly one relay. */
function makeConfigDir() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-role-config-'));
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      relays: {
        teststudio: {
          profile: 'ai-context/agents/{role}/{role}.md',
          docs: ['docs/CHARTER.md'],
          filer: 'vox',
          executive: ['vox'],
          departments: {
            'dept:story': { name: 'Story', lead: 'aria', members: ['aria', 'clio'], check: ['clio'] },
          },
        },
      },
    }),
  );
  return dir;
}

/**
 * Same relay as `makeConfigDir`, but with a `cfg.workspaces` entry too, so
 * `resolveSessionDir` (lib/session.js) can place `teststudio` at `checkoutDir` — the
 * `--dir`-free path a real relay session actually takes. No `projectRoot` is set, so
 * `resolveSessionDir` takes its simplest branch: the parent of the workspace's own `.beads`
 * path, which is `checkoutDir` itself here.
 */
function makeConfigDirWithWorkspace(checkoutDir) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-role-config-ws-'));
  // `reconcileWorkspaces` (lib/config.js) drops any configured workspace whose `.dir` does
  // not exist on disk — real, or this entry never survives `loadConfig()` to be found.
  fs.mkdirSync(path.join(checkoutDir, '.beads'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      workspaces: [{ name: 'teststudio', dir: path.join(checkoutDir, '.beads') }],
      relays: {
        teststudio: {
          profile: 'ai-context/agents/{role}/{role}.md',
          docs: ['docs/CHARTER.md'],
          filer: 'vox',
          executive: ['vox'],
          departments: {
            'dept:story': { name: 'Story', lead: 'aria', members: ['aria', 'clio'], check: ['clio'] },
          },
        },
      },
    }),
  );
  return dir;
}

function run(args, { dir, configDir } = {}) {
  return spawnSync('node', [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, BEADCAUSE_CONFIG_DIR: configDir || makeConfigDir() },
    cwd: dir,
  });
}

{
  const work = makeWorkspace();
  const configDir = makeConfigDir();
  const r = run(['-w', 'teststudio', 'aria', '--dir', work], { configDir });
  check('exits 0 when every section resolves', r.status === 0, r.stderr);
  check('prints the one law', r.stdout.includes('Agents draft. Adam approves.'));
  check('prints the role\'s own charter block, not another role\'s', r.stdout.includes('novelist') && !r.stdout.includes('showrunner'));
  check('prints the role file in full', r.stdout.includes('a chapter, in prose'));
  check('prints the output template location', r.stdout.includes('Output Format'));
  check('cites a source path and line range beside the one law', /docs\/CHARTER\.md:\d+-\d+/.test(r.stdout));
  check('cites a source path and line range for the role file', /aria\.md:1-\d+/.test(r.stdout));
  check('lists the legal --next targets, excluding the role itself', r.stdout.includes('clio') && !/next targets[\s\S]*\baria\b/.test(r.stdout.split('Legal --next')[1] || ''));
}

{
  const work = makeWorkspace();
  const configDir = makeConfigDir();
  const r = run(['-w', 'teststudio', 'aria', '--next'], { dir: work, configDir });
  check('--next with cwd inside the workspace needs no --dir', r.status === 0, r.stderr);
  check('--next prints only the roster, not the contract', r.stdout.trim() === 'clio\nvox');
  check('--next never lists the role itself', !r.stdout.split('\n').includes('aria'));
}

{
  // No --dir, and cwd is `tmp` — nowhere near the fixture checkout. Only a `cfg.workspaces`
  // entry (resolveSessionDir) can find the real files here, the same mechanism a relay
  // session opened somewhere else would rely on.
  const work = makeWorkspace();
  const configDir = makeConfigDirWithWorkspace(work);
  const r = run(['-w', 'teststudio', 'aria'], { dir: tmp, configDir });
  check('with no --dir and cwd elsewhere, resolveSessionDir still finds the checkout', r.status === 0, r.stderr);
  check('and prints the real contract, not a cwd-relative miss', r.stdout.includes('a chapter, in prose'));
}

{
  const work = makeWorkspace();
  const configDir = makeConfigDir();
  const r = run(['-w', 'teststudio', 'vox', '--dir', work], { configDir });
  check('a role with no profile file on disk still exits (partial contract)', r.status === 4, `status=${r.status} stderr=${r.stderr}`);
  check('the missing role file is reported as missing, not printed empty', r.stdout.includes('MISSING'));
  check('the sections that do resolve are still printed', r.stdout.includes('holds the whole thing'));
}

{
  const work = makeWorkspace();
  const configDir = makeConfigDir();
  const r = run(['-w', 'teststudio', 'nobody', '--dir', work], { configDir });
  check('an unknown role refuses with exit 3, mirroring beadcause-relay', r.status === 3);
  check('the refusal lists the real roster', r.stdout.includes('aria') || r.stderr.includes('aria'));
}

{
  const r = run(['-w', 'nope-workspace', 'aria']);
  check('an unknown workspace refuses with exit 2', r.status === 2);
}

{
  const work = makeWorkspace();
  const configDir = makeConfigDir();
  const r = run(['-w', 'teststudio', 'aria', '--dir', '/definitely/not/a/real/dir'], { configDir });
  check('a --dir that does not exist refuses with exit 2', r.status === 2);
}

{
  const work = makeWorkspace();
  const configDir = makeConfigDir();
  const r = run(['-w', 'teststudio', '--all', '--dir', work], { configDir });
  check('--all exits 0', r.status === 0, r.stderr);
  check('--all lists every role the relay knows', r.stdout.includes('aria') && r.stdout.includes('clio') && r.stdout.includes('vox'));
  check('--all names the department', r.stdout.includes('Story'));
  check('--all names the gate', r.stdout.includes('G0'));
  check('--all marks the executive role as executive', /vox\s+executive/.test(r.stdout));
}

{
  const work = makeWorkspace();
  const configDir = makeConfigDir();
  const r = run(['-w', 'teststudio', 'aria', '--json', '--dir', work], { configDir });
  check('--json exits 0 and parses', r.status === 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  check('json carries the department', parsed.department?.key === 'dept:story');
  check('json carries the one-law text and line range', parsed.oneLaw?.text?.includes('Agents draft') && parsed.oneLaw?.startLine > 0);
  check('json carries the charter block', parsed.charterBlock?.text?.includes('novelist'));
  check('json carries the full role file and its line count', parsed.profile?.found === true && parsed.profile?.endLine === 8);
  check('json carries the output template', parsed.outputTemplate?.text?.includes('a chapter, in prose'));
  check('json carries the legal next roles', parsed.next?.roles?.length === 2 && parsed.next.roles.join(',') === 'clio,vox');
}

{
  const r = spawnSync('node', [BIN, '--help'], { encoding: 'utf8' });
  check('--help exits 0 and prints usage', r.status === 0 && r.stdout.includes('b7e-role'));
}

{
  const r = spawnSync('node', [BIN], { encoding: 'utf8' });
  check('no arguments at all is a usage refusal, exit 1', r.status === 1);
}

/* ---------------------------------------------------- 3. the shipped deluvia default */

console.log('\nthe shipped `deluvia` relay — roster only, no checkout required\n');

// An isolated CONFIG_DIR with an *empty* config.json — `loadConfig` merges the shipped
// defaults() over it, so `relays.deluvia` survives, and it stays untouched by whatever
// `relays` block is actually written into the real ~/.config/beadcause/config.json on
// this Mac. Deliberately not `makeConfigDir()`: that one's config.json states `relays`
// at all, which replaces the default map outright (see lib/config.js's shallow merge)
// and would make `deluvia` disappear along with `teststudio`.
const emptyConfigDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-role-config-empty-'));
fs.writeFileSync(path.join(emptyConfigDir, 'config.json'), '{}');

{
  // No --dir, no fixture: this must hold on a machine that has never heard of deluvia.
  // The roster comes off config.relays.deluvia (lib/config.js), never off a file read.
  const r = run(['-w', 'deluvia', '--all', '--json'], { configDir: emptyConfigDir });
  check('the shipped deluvia relay answers --all with no checkout on disk', r.status === 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  check('nineteen roles', parsed.roles.length === 19, String(parsed.roles.length));
  check('clio is Story', parsed.roles.find((x) => x.role === 'clio')?.dept === 'dept:story');
  check('vox is executive', parsed.roles.find((x) => x.role === 'vox')?.executive === true);

  const next = run(['-w', 'deluvia', 'clio', '--next'], { configDir: emptyConfigDir });
  check('the shipped deluvia relay answers --next with no checkout on disk', next.status === 0, next.stderr);
  const targets = next.stdout.trim().split('\n');
  check('eighteen legal next-roles for clio — the roster minus clio itself', targets.length === 18, String(targets.length));
  check('never includes clio itself', !targets.includes('clio'));
}

console.log(`\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
