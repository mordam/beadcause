#!/usr/bin/env node
/**
 * bc-nc6o.13. `lib/dispatch.js` builds the `claude …` command as a template string and
 * used to interpolate `--model ${model}` unquoted. Every model spelling in play today is
 * a bare alias (`sonnet`, `opus`), so nothing had ever tripped it — but `sonnet[1m]` and
 * `opus[1m]`, the Claude Code spellings for forcing the 1M-context variant, are also
 * valid `--model` values, and `[1m]` is a zsh bracket glob. Unquoted, with no file in cwd
 * matching it, zsh refuses the whole command with "no matches found" before `claude` is
 * ever reached — a silent, total dispatch failure the moment any routing decision emits
 * a bracketed spelling (bc-nc6o.9 is exactly that decision, still open).
 *
 * The worker path (`lib/foundation.js` `claudeArgs`, exercised by `test/tiermodel.mjs`)
 * already quotes its `--model` with the same `shq` helper and is unaffected. This suite
 * is the dispatch.js command-string path on its own — the one the bead named.
 *
 *   npm test
 *   node test/dispatchmodel.mjs
 *
 * Real `dispatchReply`, real zsh, a stub `claude` on PATH that only records its argv —
 * so what is proved is the literal argv zsh hands the program, not a copy of the quoting
 * logic re-typed into the test.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-dispatchmodel-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

// A stub `claude` that does nothing but write its own argv to a file and exit — so the
// test never depends on whether the real CLI is installed, and never spends a real model
// turn. Put first on PATH: lib/foundation.js's `agentEnv` prepends this repo's own bin/
// (which has no `claude`), so a stub earlier still than that wins.
const FAKE_BIN = path.join(tmp, 'fakebin');
fs.mkdirSync(FAKE_BIN);
const CAPTURE = path.join(tmp, 'argv.json');
// The argv file is *renamed* into place rather than appended to, so it only ever exists
// complete. Appending a line per argument made it exist from the first argument onwards,
// and `waitForCapture` below polls for existence — so a reader arriving mid-loop read a
// truncated argv and the assertion failed with "no --model in argv" over an argv that
// simply had not finished being written. That is bc-a66ae: green on the machine this was
// written on, red on CI the same day, on a suite about quoting rather than about timing.
fs.writeFileSync(
  path.join(FAKE_BIN, 'claude'),
  `#!/bin/sh\nprintf '%s\\n' "$*" > '${CAPTURE}'\n: > '${CAPTURE}.partial'\nfor a in "$@"; do printf '%s\\n' "$a" >> '${CAPTURE}.partial'; done\nmv '${CAPTURE}.partial' '${CAPTURE}.lines'\necho '{"type":"result","result":"ok"}'\nexit 0\n`,
  { mode: 0o755 }
);
process.env.PATH = `${FAKE_BIN}:${process.env.PATH || ''}`;

const { dispatchReply } = await import(path.join(ROOT, 'lib', 'dispatch.js'));

/** The checkout dispatchReply opens in. A real git repo, same as test/tiermodel.mjs. */
const CHECKOUT = path.join(tmp, 'checkout');
fs.mkdirSync(CHECKOUT);
const git = (...args) => execFileSync('git', args, { cwd: CHECKOUT, stdio: 'pipe' });
git('init', '-q');
git('config', 'user.name', 'beadcause test');
git('config', 'user.email', 'test@example.invalid');

const ws = { name: 'demo', dir: CHECKOUT };

/** Wait for the stub to have run and captured argv, or fail loudly. */
async function waitForCapture({ timeoutMs = 10000, stepMs = 20 } = {}) {
  const linesFile = `${CAPTURE}.lines`;
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(linesFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, stepMs));
  if (!fs.existsSync(linesFile)) throw new Error('claude stub was never invoked — dispatch failed before exec');
  const argv = fs.readFileSync(linesFile, 'utf8').split('\n').filter(Boolean);
  fs.rmSync(CAPTURE, { force: true });
  fs.rmSync(linesFile, { force: true });
  return argv;
}

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
}

console.log('\ndispatch.js quotes --model, so a bracketed alias is not read as a zsh glob\n');

await check('a bracketed model spelling reaches claude as one literal argv, not a glob', async () => {
  const cfg = {
    sessionDirs: { demo: CHECKOUT },
    // Overrides the built-in `answerer` agent's model — dispatchReply prefers the
    // agent's own model over the foundation's (lib/dispatch.js: "the roster's model
    // wins over the foundation's").
    agents: [{ id: 'answerer', model: 'opus[1m]' }],
  };

  const result = await dispatchReply(cfg, ws, 'zz-model', 'a bracketed model spelling', {});
  assert.notEqual(result?.dispatched, false, `dispatchReply declined: ${result?.reason}`);

  const argv = await waitForCapture();
  const i = argv.indexOf('--model');
  assert.ok(i !== -1, `no --model in argv: ${JSON.stringify(argv)}`);
  assert.equal(argv[i + 1], 'opus[1m]', `the bracket was read as a glob rather than reaching claude intact: ${JSON.stringify(argv)}`);
});

/* -------------------------------------------------------- and the regression sentinel */

await check('lib/dispatch.js never interpolates --model unquoted again', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'dispatch.js'), 'utf8');
  assert.ok(!/--model \$\{model\}/.test(src), 'the exact unquoted spelling this bead fixed is back');
  assert.match(src, /--model \$\{shq\(model\)\}|shq\(model\)/, 'the fix — quoting model through shq — is gone');
});

await cleanupTmp(tmp);

console.log(
  `\n${failures ? '\x1b[31m' : '\x1b[32m'}${ran - failures}/${ran} checks passed\x1b[0m`
);
process.exit(failures ? 1 : 0);
