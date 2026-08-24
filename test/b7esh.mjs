#!/usr/bin/env node
//
// b7e-sh — a multi-step shell script in one call the worktree's Bash approval would
// otherwise refuse (bc-ka5y.29).
//
//   npm test
//   node test/b7esh.mjs
//
// Two halves: lib/shguard.js's verifyScript() driven directly with hand-picked scripts
// (allow and refuse, one per shape bc-ka5y.29's evidence names), then the real CLI —
// bin/b7e-sh, spawned for real — over a throwaway tmp tree, so a change to argv parsing
// or the bash handoff fails this suite rather than going unnoticed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyScript } from '../lib/shguard.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-sh');

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

/* =================================================== 1. verifyScript — allowed shapes */

console.log('\nverifyScript allows scripts that stay inside the roots\n');

{
  const roots = ['/repo/worktree'];
  check('a plain multi-line script', verifyScript('echo one\necho two\n', roots).ok);
  check(
    'a for-loop over literal values — the bc-ka5y.19 shape',
    verifyScript('for n in 340 359 373; do sed -i \'\' "${n}s/^check(/await acheck(/" file.mjs; done\n', roots).ok,
  );
  check('cd to a relative path inside the root', verifyScript('cd sub\necho hi\n', roots).ok);
  check('cd to an absolute path inside the root', verifyScript('cd /repo/worktree/sub\necho hi\n', roots).ok);
  check('cd out and back stays inside', verifyScript('cd sub\ncd ..\necho hi\n', roots).ok);
  check('git -C into the root itself', verifyScript('git -C /repo/worktree status\n', roots).ok);
  check('a comment naming an outside path is not code', verifyScript('# see /etc/passwd for reference\necho hi\n', roots).ok);

  // Both spellings, because the attached one used to pass without ALWAYS_ALLOWED ever
  // being consulted — `2>/dev/null` was one token that did not start with `/`, so
  // substituting `/etc/passwd` for `/dev/null` passed identically (bc-4hg1a c4).
  check('redirection to /dev/null, spaced', verifyScript('some-command 2> /dev/null\n', roots).ok);
  check('redirection to /dev/null, attached', verifyScript('some-command 2>/dev/null\n', roots).ok);
  check(
    'and the attached form really is examined — /etc/passwd there is refused',
    !verifyScript('some-command 2>/etc/passwd\n', roots).ok,
  );

  // A leading `/` in an *expression* is not a path, and refusing it refuses the command's
  // own motivating use case — bc-ka5y.19's loop is a sed address away from this (c2).
  check('a sed address is an expression, not a path', verifyScript("sed -i '' '/^debug/d' f.txt\n", roots).ok);
  check('a sed address, GNU -i spelling', verifyScript("sed -i '/^debug/d' f.txt\n", roots).ok);
  check('the common sed address+substitute form', verifyScript("sed -i '' '/^check(/s/a/b/' f.mjs\n", roots).ok);
  check('an awk program', verifyScript("awk '/^foo/ {print}' f.txt\n", roots).ok);
  check('a grep pattern that looks like a path', verifyScript("grep '/api/v1' f.txt\n", roots).ok);
  check('a grep pattern behind flags with values', verifyScript("grep -m 5 '/api/v1' f.txt\n", roots).ok);
  check('sed -e expressions', verifyScript("sed -e '/^a/d' -e '/^b/d' f.txt\n", roots).ok);
  check('arithmetic is division, not the root directory', verifyScript('echo $((10 / 2))\n', roots).ok);
  check(
    'a named --allow root (a mktemp dir, say) is honoured',
    verifyScript('mkdir -p /tmp/some-scratch-dir\n', [...roots, '/tmp/some-scratch-dir']).ok,
  );
}

/* =================================================== 2. verifyScript — refused shapes */

console.log('\nverifyScript refuses the three shapes bc-ka5y.29 names\n');

{
  const roots = ['/repo/worktree'];

  {
    const v = verifyScript('echo one\ncat /etc/passwd\n', roots);
    check('an absolute path outside the roots is refused', !v.ok);
    check('names the offending line (2)', v.line === 2, JSON.stringify(v));
    check('names the target', v.target === '/etc/passwd', JSON.stringify(v));
  }

  {
    const v = verifyScript('echo one\ngit -C /Users/adammorgan/neadamthal.projects/beadcause status\n', roots);
    check('git -C into the shared checkout is refused', !v.ok);
    check('names the offending line (2)', v.line === 2, JSON.stringify(v));
  }

  {
    const v = verifyScript('cd sub\ncd ../../..\necho hi\n', roots);
    check('cd that walks out past the root is refused', !v.ok);
    check('names the offending line (2)', v.line === 2, JSON.stringify(v));
  }

  {
    const v = verifyScript('cd /Users/adammorgan\necho hi\n', roots);
    check('cd straight to an outside absolute path is refused', !v.ok);
  }

  {
    const v = verifyScript('cd "$SOME_VAR"\necho hi\n', roots);
    check('a cd target built from a variable is refused, not guessed at', !v.ok);
    check('says it cannot verify', /runtime/.test(v.reason), v.reason);
  }
}

/* ============================== 2b. the other spellings of the same outside path (c1) */

// A worktree here lives at `<repo>/.claude/worktrees/<name>`, so `../../..` *is* the
// shared checkout the acceptance criterion names for `git -C`. Refusing that escape by
// one spelling and permitting it by another is the criterion failing on its own target.
console.log('\nverifyScript refuses an outside path however it is spelled\n');

{
  const roots = ['/repo/wt'];

  {
    const v = verifyScript("sed -i '' 's/real/PWNED/' ../../../lib/server.js\n", roots);
    check('a relative path that walks out is refused', !v.ok);
    check('names where it lands, not what was typed', v.target === '/lib/server.js', JSON.stringify(v));
  }
  check(
    'a relative path that walks out mid-way is refused',
    !verifyScript('cat sub/../../../lib/server.js\n', roots).ok,
  );
  check('an attached redirect is refused', !verifyScript('echo hi >/abs/outside/x\n', roots).ok);
  check('a spaced redirect is refused', !verifyScript('echo hi > /abs/outside/x\n', roots).ok);
  check('an appending redirect is refused', !verifyScript('echo hi >>/abs/outside/x\n', roots).ok);
  check('a redirect that walks out is refused', !verifyScript('echo hi > ../../../lib/server.js\n', roots).ok);
  check('--flag=<abs> is refused', !verifyScript('tar --directory=/etc -cf x.tar .\n', roots).ok);
  check('git --git-dir=<abs> is refused', !verifyScript('git --git-dir=/repo/other/.git log\n', roots).ok);
  check('git --git-dir <abs> is refused', !verifyScript('git --git-dir /repo/other/.git log\n', roots).ok);
  check('a VAR=<abs> prefix is refused', !verifyScript('GIT_DIR=/repo/other/.git git log\n', roots).ok);
  check('a path built from a variable is refused', !verifyScript('cat $HOME/.ssh/id_rsa\n', roots).ok);
  check('a quoted path built from a variable is refused', !verifyScript('mkdir -p "$OUT/sub"\n', roots).ok);
  check('rm -rf / is refused', !verifyScript('rm -rf /\n', roots).ok);

  // The expression exemption is one quoted operand of a named command, and no wider:
  // unquoted, or behind a -f that says the operands are files, it is a path again.
  check('an unquoted /etc/passwd in pattern position is still a path', !verifyScript('grep /etc/passwd f.txt\n', roots).ok);
  check('sed -f naming an outside program is refused', !verifyScript('sed -f /etc/prog.sed f.txt\n', roots).ok);
  check('a cd that walks out one line at a time is refused', !verifyScript('cd ..\ncd ..\ntouch x\n', roots).ok);
}

/* ============================ 2c. a symlinked root names the same directory (c5) */

// macOS puts /tmp behind a symlink to /private/tmp, and the two things --allow exists for
// — a mktemp dir and the session scratchpad — are the two most likely to be typed in the
// other spelling. Built here with a real symlink rather than /tmp, so this means the same
// thing on a Linux CI runner, where /tmp is not a symlink at all.
console.log('\nverifyScript compares directories, not strings\n');

{
  const linkTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7esh-link-'));
  const real = path.join(linkTmp, 'real');
  const link = path.join(linkTmp, 'link');
  fs.mkdirSync(real);
  fs.symlinkSync(real, link);

  check(
    'a root named through a symlink contains its target',
    verifyScript(`cat ${path.join(real, 'f')}\n`, [link]).ok,
  );
  check(
    'and a root named directly contains the symlinked spelling',
    verifyScript(`cat ${path.join(link, 'f')}\n`, [real]).ok,
  );
  check(
    'a sibling directory is still outside either way',
    !verifyScript(`cat ${path.join(linkTmp, 'other', 'f')}\n`, [link]).ok,
  );

  fs.rmSync(linkTmp, { recursive: true, force: true });
}

/* ============================================================ 3. CLI — fixture tree */

console.log('\nb7e-sh CLI, spawned for real\n');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7esh-'));
const worktree = path.join(tmp, 'worktree');
const outside = path.join(tmp, 'outside');
fs.mkdirSync(worktree, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(outside, 'secret.txt'), 'do not touch\n');

const run = (args, opts = {}) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: worktree, ...opts });

{
  const script = path.join(worktree, 'ok.sh');
  fs.writeFileSync(script, 'echo hello from the worktree\ntouch mark.txt\n');
  const r = run([script]);
  check('exit code 0 on a script that stays inside', r.status === 0, JSON.stringify(r));
  check('stdout passes through', /hello from the worktree/.test(r.stdout), r.stdout);
  check('the script actually ran — it left mark.txt', fs.existsSync(path.join(worktree, 'mark.txt')));
}

{
  const script = path.join(worktree, 'exitcode.sh');
  fs.writeFileSync(script, 'exit 7\n');
  const r = run([script]);
  check("the script's own exit code passes through", r.status === 7, JSON.stringify(r));
}

{
  const script = path.join(worktree, 'escape.sh');
  fs.writeFileSync(script, `echo one\ncat ${JSON.stringify(path.join(outside, 'secret.txt'))}\n`);
  const r = run([script]);
  check('exit code 2 on a script reaching outside', r.status === 2, JSON.stringify(r));
  check('names the offending line', /line 2/.test(r.stderr), r.stderr);
  check('the outside file was never touched', fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8') === 'do not touch\n');
}

{
  // The escape the reviewer actually ran against a fixture shaped like a worktree here:
  // `<repo>/.claude/worktrees/<name>/../../..` is the shared checkout, and a relative
  // `sed -i` into it rewrote the real file with exit 0 (bc-4hg1a c1a).
  const script = path.join(worktree, 'relative-escape.sh');
  const victim = path.join(tmp, 'victim.txt');
  fs.writeFileSync(victim, 'real\n');
  fs.writeFileSync(script, "sed -i '' 's/real/PWNED/' ../victim.txt\n");
  const r = run([script]);
  check('exit code 2 on a relative path that walks out', r.status === 2, JSON.stringify(r));
  check('the file one level up was never touched', fs.readFileSync(victim, 'utf8') === 'real\n');
}

{
  const script = path.join(worktree, 'allowed-outside.sh');
  fs.writeFileSync(script, `echo one\ncat ${JSON.stringify(path.join(outside, 'secret.txt'))}\n`);
  const r = run([script, '--allow', outside]);
  check('--allow widens the roots to a named directory', r.status === 0, JSON.stringify(r));
  check('reads the file --allow named', /do not touch/.test(r.stdout), r.stdout);
}

{
  const r = run(['-c', 'for f in a b c; do echo "$f"; done']);
  check('-c runs a multi-step command string', r.status === 0, JSON.stringify(r));
  check('the loop actually ran', r.stdout === 'a\nb\nc\n', JSON.stringify(r.stdout));
}

{
  const script = path.join(worktree, 'dry.sh');
  fs.writeFileSync(script, 'touch should-not-exist.txt\n');
  const r = run([script, '--dry']);
  check('--dry exits 0 without running', r.status === 0, JSON.stringify(r));
  check('--dry did not touch the tree', !fs.existsSync(path.join(worktree, 'should-not-exist.txt')));
  check('--dry says what it verified', /verified/.test(r.stdout), r.stdout);
}

{
  const r = run(['--help']);
  check('--help exits 0', r.status === 0, JSON.stringify(r));
  check('--help prints usage', /b7e-sh/.test(r.stdout), r.stdout);
}

{
  const r = run([]);
  check('no args is refused (exit 2)', r.status === 2, JSON.stringify(r));
}

{
  const r = run(['does-not-exist.sh']);
  check('a missing script path is refused (exit 2)', r.status === 2, JSON.stringify(r));
}

/* ------------------------------------- option values are values, not the next flag (c3) */

// `--dry` is the one flag whose whole contract is "verify and run nothing". `--allow`
// used to consume it as a directory name and then run the script, exiting 0, so nothing
// downstream could tell (bc-4hg1a c3).
{
  const script = path.join(worktree, 'c3.sh');
  const mark = path.join(worktree, 'c3-mark.txt');
  fs.writeFileSync(script, 'touch c3-mark.txt\necho it ran\n');

  {
    fs.rmSync(mark, { force: true });
    const r = run([script, '--allow', '--dry']);
    check('--allow --dry is refused, not swallowed (exit 2)', r.status === 2, JSON.stringify(r));
    check('and the script did not run', !fs.existsSync(mark));
  }

  {
    fs.rmSync(mark, { force: true });
    const r = run([script, '--allow']);
    check('--allow with no value is refused (exit 2)', r.status === 2, JSON.stringify(r));
    check('with a sentence, not a stack trace', !/ERR_INVALID_ARG_TYPE|at Object\./.test(r.stderr), r.stderr);
    check('and the script did not run', !fs.existsSync(mark));
  }

  {
    const r = run([script, '--cwd']);
    check('--cwd with no value is refused, not ignored (exit 2)', r.status === 2, JSON.stringify(r));
  }

  {
    const r = run([script, '-c']);
    check('-c with no value is refused (exit 2)', r.status === 2, JSON.stringify(r));
  }

  {
    fs.rmSync(mark, { force: true });
    const r = run([script, '--Dry']);
    check('a mistyped flag is refused rather than run (exit 2)', r.status === 2, JSON.stringify(r));
    check('and the script did not run', !fs.existsSync(mark));
  }

  fs.rmSync(mark, { force: true });
}

/* ---------------------------------------------------------------- verdict */

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : '\n\x1b[32mall checks passed\x1b[0m\n');
process.exit(failures ? 1 : 0);
