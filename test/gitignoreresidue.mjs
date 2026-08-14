#!/usr/bin/env node
//
// The two paths a Mac puts back on its own are ignored by *this* repo's `.gitignore`.
//
//   npm test
//   node test/gitignoreresidue.mjs
//
// bc-0i27.18. `.DS_Store` is written by the Finder into any folder it displays and
// `.idea/` by a JetBrains IDE at the root of any project it opens, so neither can be
// cleared in a way that lasts — they are back the next time somebody looks at the folder.
// Until this landed, `.gitignore` covered `android/.idea/` and nothing else, so the shared
// main checkout on this Mac sat permanently at `?? .DS_Store` / `?? .idea/`, and *every*
// session reading its `git status` read a dirty tree as the resting state. That cost more
// than tidiness: it was filed as a bug three separate times in two days (bc-xede,
// bc-0i27.18, bc-p49x.6) by three sessions that each diagnosed it from scratch, and for as
// long as `landLocally` refused on untracked dirt it held back every delivery's
// fast-forward at once. bc-45g8 fixed the refusal; this fixed the residue.
//
// The checks are about the two ways the fix could rot rather than about git's semantics:
//
// 1. **The rule is ours.** `git check-ignore` answers "ignored" just as happily from a
//    machine-local `core.excludesFile` — and a Mac that ignores `.DS_Store` globally is
//    the common case, which is exactly why this went unnoticed on somebody else's laptop.
//    So each check asserts the rule's *source file* is the repo's own `.gitignore`, and a
//    pass here means the next clone is covered too rather than this one being lucky.
// 2. **The `/.idea/` anchor is deliberate.** A leading slash pins it to the repo root, so
//    a fixture or a test tree named `.idea` further down is still visible. Dropping the
//    slash to "make it consistent" with `.DS_Store` above would swallow those silently,
//    which is the failure that has no symptom until something is missing from a commit.
//
// Nothing here creates a file: `check-ignore` matches a *path* against the rules and does
// not care whether it exists, so this suite writes nothing and cleans up nothing.
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message.split('\n').join('\n      ')}`);
  }
}

/**
 * `git check-ignore -v <p>` → `{ ignored, source, line, pattern }`. `source` is the file
 * the matching rule came from, which is the whole point: a global excludes file answering
 * for `.DS_Store` would otherwise read as a pass.
 */
function checkIgnore(p) {
  const res = spawnSync('git', ['check-ignore', '-v', '--no-index', '--', p], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (res.error) throw res.error;
  if (res.status === 1) return { ignored: false };
  assert.equal(res.status, 0, `git check-ignore failed for ${p}: ${res.stderr.trim()}`);
  const [source, line, pattern] = res.stdout.trim().split('\t')[0].split(':');
  return { ignored: true, source, line: Number(line), pattern };
}

check('.DS_Store at the repo root is ignored, by this repo', () => {
  const hit = checkIgnore('.DS_Store');
  assert.ok(hit.ignored, '.DS_Store is not ignored — the Finder writes it into the shared checkout');
  assert.equal(
    hit.source,
    '.gitignore',
    `.DS_Store is ignored by ${hit.source}, not this repo's own .gitignore — that is a rule on ` +
      'this machine only, and a fresh clone would still be dirty'
  );
});

check('.DS_Store is ignored at any depth, not just the root', () => {
  // No leading slash on purpose: the Finder writes one per folder it displays, so the
  // rule has to be depth-independent. `lib/` and `public/vendor/` are the ones a person
  // actually opens.
  for (const p of ['lib/.DS_Store', 'public/vendor/.DS_Store', 'docs/sw-cache/.DS_Store']) {
    const hit = checkIgnore(p);
    assert.ok(hit.ignored, `${p} is not ignored — the rule must not be anchored to the root`);
    assert.equal(hit.source, '.gitignore', `${p} is ignored by ${hit.source}, not this repo`);
  }
});

check('a root .idea/ is ignored, by this repo', () => {
  const hit = checkIgnore('.idea/workspace.xml');
  assert.ok(
    hit.ignored,
    'a root .idea/ is not ignored — android/.idea/ has been covered since the app existed, ' +
      'which is the tell that the root one was an oversight rather than a decision'
  );
  assert.equal(hit.source, '.gitignore', `.idea/ is ignored by ${hit.source}, not this repo`);
});

check('the .idea rule is anchored, so a nested .idea is still visible', () => {
  // Not a hypothetical tidy-up: `/.idea/` reads as needlessly specific next to a bare
  // `.DS_Store`, and dropping the slash would hide any `.idea` under test/ or docs/ from
  // `git status` — a missing file in a commit, with nothing to see beforehand.
  const hit = checkIgnore('test/fixtures/.idea/keep');
  assert.equal(
    hit.ignored,
    false,
    `test/fixtures/.idea/keep is ignored by ${hit.source}:${hit.line} (${hit.pattern}) — the ` +
      'leading slash on /.idea/ is what keeps this rule to the repo root; do not drop it'
  );
});

check('neither path is tracked, which is what makes ignoring them mean anything', () => {
  // `.gitignore` says nothing about a file git already has: if either of these were ever
  // committed, the rule above would be inert and the checkout dirty for a different reason.
  const res = spawnSync('git', ['ls-files', '--', '.DS_Store', '*/.DS_Store', '.idea'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `git ls-files failed: ${res.stderr.trim()}`);
  assert.equal(
    res.stdout.trim(),
    '',
    `these are tracked, so ignoring them does nothing — git rm --cached them:\n${res.stdout.trim()}`
  );
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
