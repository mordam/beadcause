#!/usr/bin/env node
/**
 * Is there an unresolved merge in what is about to be committed, or pushed? —
 * `npm run conflicts`.
 *
 *   node scripts/conflict-check.mjs                 # this branch, against origin/main
 *   node scripts/conflict-check.mjs --staged        # what `git commit` would write now
 *   node scripts/conflict-check.mjs --commit HEAD   # one commit, against its parent
 *   node scripts/conflict-check.mjs --install-hook  # and never have to remember again
 *
 * The reasoning is in `lib/conflicted.js`; this is the interface. Exit 0 means nothing
 * was found, exit 1 means something was — which makes it usable as a `pre-commit` hook
 * unchanged, and that is what `--install-hook` installs.
 *
 * **A worktree does not need its own install.** Git resolves hooks through the *common*
 * git directory unless `core.hooksPath` says otherwise, so a hook written once in the
 * main checkout is already running in all ~25 worktrees of this repo — including ones
 * created after the install. `git rev-parse --git-path hooks` is what says so, from
 * wherever this is run. And running `--install-hook` *from* a worktree is equally safe:
 * the command it writes always points at the main checkout's own copy of this script,
 * never the installing worktree's, so retiring that worktree later does not take the
 * hook down with it — bc-xl7n.125.
 *
 * The hook is a real guard rather than a comfort: it fires on `git commit` for every
 * session, human or agent, and it costs a few hundred milliseconds. `git commit
 * --no-verify` still skips it, as it skips every hook, which is the correct answer for
 * a repo whose whole subject matter is unattended agents — the guard that cannot be
 * bypassed on purpose is the one somebody disables permanently at three in the morning.
 * `bin/deliver.js` runs the same check with no `--no-verify` to reach for, and that is
 * the one that actually stands between this and `origin`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectBranch, inspectCommit, inspectStaged, report } from '../lib/conflicted.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const arg = (n, fallback) => {
  const i = argv.indexOf(n);
  return i > -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const git = (args, cwd = process.cwd()) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

if (has('--help') || has('-h')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
  process.exit(0);
}

/* --------------------------------------------------------------- install the hook */

if (has('--install-hook')) {
  // `--git-path` rather than `<root>/.git/hooks`: in a worktree `.git` is a *file*
  // pointing elsewhere, and this resolves to the shared hooks directory either way.
  const hooks = path.resolve(process.cwd(), git(['rev-parse', '--git-path', 'hooks']));

  // `core.hooksPath` can redirect that resolution anywhere, including a directory
  // nothing else manages — bc-y3qk.13 was exactly that: it named `.beads/hooks` in a
  // checkout with no `.beads` directory at all, git ran no hook and warned nobody, and
  // `mkdirSync` below would have happily created that path and reported success,
  // leaving the guard live only until something next deletes the directory it invented.
  // A hooks path under the repo's own git directory does not have that failure mode —
  // it is `rm -rf .git`, which is a different class of accident — so this only fires
  // for a path `core.hooksPath` sent somewhere else.
  const commonDir = path.resolve(process.cwd(), git(['rev-parse', '--git-common-dir']));
  const owned = hooks === commonDir || hooks.startsWith(commonDir + path.sep);
  if (!owned) {
    console.error(`${red('✗')} core.hooksPath points outside this repo's git directory: ${hooks}`);
    console.error(`  Installing there would work only for as long as that directory happens to exist —`);
    console.error(`  nothing else creates or protects it. Unset the override and re-run:\n`);
    console.error(`      git config --local --unset core.hooksPath`);
    console.error(`      node ${path.relative(process.cwd(), fileURLToPath(import.meta.url))} --install-hook\n`);
    process.exit(1);
  }

  // The command the hook execs has to keep working after *this worktree* is retired —
  // bc-xl7n.125. `ROOT` above is `import.meta.url`, i.e. wherever this file happens to
  // live right now, which is the installing worktree's own copy when `--install-hook`
  // runs from inside one; every worktree gets retired eventually, so a hook pointing
  // there is a MODULE_NOT_FOUND waiting to happen. `commonDir` just above is already
  // the answer to "which checkout owns this git directory" — for an ordinary (non-bare)
  // repo it is `<checkout>/.git`, and that checkout is the *main* one: a worktree
  // shares the common dir, it does not own it, and the main checkout is what stays put
  // when worktrees come and go. Confirmed rather than assumed: nothing guarantees the
  // repo being installed into is even a checkout of *this* project (a scratch fixture
  // in a test, say), so this only trusts the candidate when it actually holds a copy
  // of the script — otherwise ROOT, wherever this process is actually running from, is
  // still the only sane answer.
  const candidateRoot = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : null;
  const mainCheckout =
    candidateRoot && fs.existsSync(path.join(candidateRoot, 'scripts', 'conflict-check.mjs'))
      ? candidateRoot
      : ROOT;
  const script = path.join(mainCheckout, 'scripts', 'conflict-check.mjs');

  fs.mkdirSync(hooks, { recursive: true });
  const file = path.join(hooks, 'pre-commit');
  const marker = 'beadcause conflict-check';
  const body = `#!/bin/sh
# ${marker} — refuses a commit carrying an unresolved merge or a file that does not
# parse. Installed by \`node scripts/conflict-check.mjs --install-hook\`; delete this
# file to remove it. Shared by every worktree of this repo, by way of the common git
# directory, and points at the *main checkout's* copy of this script regardless of
# which worktree ran the install — bc-xl7n.125 — so retiring that worktree does not
# break the hook everywhere else. \`git commit --no-verify\` skips it.
exec node "${script}" --staged
`;

  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8');
    // Somebody else's hook is not ours to replace, and overwriting one silently is how a
    // repo loses a check nobody remembers installing.
    if (!existing.includes(marker)) {
      console.error(`${red('✗')} ${file} already exists and is not ours — not touching it.`);
      console.error(`  Add this line to it instead:\n\n      exec node "${script}" --staged\n`);
      process.exit(1);
    }
  }
  fs.writeFileSync(file, body, { mode: 0o755 });
  console.log(`${green('✓')} pre-commit hook installed at ${file}`);
  console.log('  Every worktree of this repo shares it. `git commit --no-verify` skips it.');
  process.exit(0);
}

/* ------------------------------------------------------------------------ the scan */

const dir = process.cwd();
let findings;
let what;
let subject;

if (has('--staged')) {
  what = 'the commit';
  subject = 'staged';
  findings = inspectStaged(dir);
} else if (has('--commit')) {
  const ref = arg('--commit', 'HEAD');
  what = `${ref}`;
  subject = `commit ${ref}`;
  findings = inspectCommit(dir, ref);
} else {
  const ref = 'HEAD';
  // `origin/main` if this laptop has it, the local branch if it does not — offline, a
  // fresh clone, or a repo whose default branch is named something else.
  let base = arg('--base', '');
  if (!base) {
    for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
      try {
        git(['rev-parse', '--verify', '--quiet', candidate], dir);
        base = candidate;
        break;
      } catch {
        /* try the next one */
      }
    }
  }
  if (!base) {
    console.error(`${red('✗')} no base branch to compare against — pass --base <ref>`);
    process.exit(2);
  }
  what = 'the commit';
  subject = `this branch against ${base}`;
  findings = inspectBranch(dir, { ref, base });
}

if (!findings.length) {
  if (!has('--quiet')) console.log(`${green('✓')} ${subject}: no conflict markers, everything parses`);
  process.exit(0);
}

console.error(`\n${red('✗')} ${subject} — refusing:\n`);
console.error(report(findings, { what }));
console.error('');
process.exit(1);
