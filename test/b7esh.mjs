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
  check('redirection to /dev/null', verifyScript('some-command 2>/dev/null\n', roots).ok);
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

/* ---------------------------------------------------------------- verdict */

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : '\n\x1b[32mall checks passed\x1b[0m\n');
process.exit(failures ? 1 : 0);
