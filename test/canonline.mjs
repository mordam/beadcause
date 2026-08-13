#!/usr/bin/env node
/**
 * A tty holds 1024 bytes, and the session command outgrew it (bc-3lkv).
 *
 *     npm test
 *     node test/canonline.mjs
 *
 * A worker window opened, echoed its command cut off mid-argument, and sat at a prompt.
 * Nothing had crashed and nothing was logged: the command was never submitted.
 *
 * `scripts/open-session.applescript` types the command in with iTerm's `write text`,
 * and what it types into is a fresh login shell **still running `~/.zshrc`** — nvm,
 * pnpm, a second or two of nothing in particular. Until zsh's line editor takes over,
 * that tty is in canonical mode, and a canonical-mode tty on macOS holds exactly
 * `MAX_CANON` = 1024 bytes of unread input. Byte 1025 onward is discarded — and the
 * discarded part includes the newline, so the line is never submitted at all.
 *
 * The command had simply grown. On the day it was reported every session was over the
 * line: worker 1047 bytes, advocate 1541, epic-advocate 1622. The two furthest over are
 * the two with the longest allowlists, and an allowlist only ever gets longer — every
 * tool an agent is granted is another ~20 bytes of a line the tty will not read. So the
 * fix is not a shorter command. The command goes in a file and `source '<path>'` gets
 * typed: a constant ~60 bytes however large the real one grows.
 *
 * Four things, in descending order of what they cost when wrong:
 *
 * 1. **The limit is real, and it is 1024.** Measured against an actual pty, because the
 *    whole design rests on it and the number is nowhere in the code.
 * 2. **What gets typed is the short line.** Asserted against lib/session.js itself: the
 *    regression is a refactor that hands the AppleScript the command again, and the
 *    symptom is a window that looks fine until you read it.
 * 3. **Its length does not depend on the foundation.** That is the actual property —
 *    not "short today" but "short no matter what the allowlist becomes".
 * 4. **Sourcing it still works.** A file that fits but does not run is not a fix.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { sessionCommand, sourceLine } from '../lib/session.js';
import { effective } from '../lib/foundation.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (name, fn) => {
  try {
    fn();
    ok(name);
  } catch (e) {
    bad(name, e.message);
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-canon-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

/* ------------------------------------------------------------- 1. the limit is real */

console.log('\nwhat a tty will accept before its shell is ready');

/**
 * Type a line at a canonical-mode tty and report both halves of what happens to it.
 *
 * The pty comes from `expect` for the same reason it does in lib/terminal.js: there is
 * no `openpty(3)` in the Node standard library, and this has to be a real terminal —
 * a pipe has no line discipline, so a pipe cannot demonstrate the bug at all.
 *
 * Two measurements, because they are two different facts and only one of them is
 * visible from the window:
 *
 * - **echoed** — the transcript of the pty, which is the line discipline echoing back
 *   each character as it accepts it. This is the number: it stops at `MAX_CANON`. It is
 *   also the *only* thing the user ever sees, which is why the failure looks like a
 *   command sitting on a prompt half-typed.
 * - **delivered** — what the program on the other end actually read. `cat > file`, so
 *   there is no guessing which bytes on the pty were the echo and which were output.
 *
 * A `^D` follows the return, and it is not a formality. It says the difference between
 * "the shell has not run it yet" and "the shell will never see it": with the buffer
 * full and the newline dropped, EOF is the last thing that could still hand the line
 * over — so if `delivered` is empty even after it, nothing was ever going to run.
 */
const throughTty = (() => {
  const script = path.join(tmp, 'canon.exp');
  fs.writeFileSync(
    script,
    [
      'log_user 0',
      'set out [lindex $argv 0]',
      // `-a`, or nothing is written at all: `log_file` follows `log_user` unless told
      // to log regardless, and `log_user 0` is what keeps the 1500 x's off this suite's
      // output.
      'log_file -a -noappend [lindex $argv 1]',
      'set payload [read [open [lindex $argv 2] r]]',
      'spawn -noecho /bin/sh -c "cat > $out"',
      'send -- "$payload\\r"',
      'sleep 1',
      'send -- "\\004"',
      'expect eof',
      '',
    ].join('\n')
  );
  let n = 0;
  return (line) => {
    const at_ = (kind) => path.join(tmp, `tty-${(n += 1)}-${kind}`);
    const [out, echo, payload] = [at_('out'), at_('echo'), at_('in')];
    fs.writeFileSync(payload, line);
    const r = spawnSync('/usr/bin/expect', ['-f', script, out, echo, payload], { timeout: 20000 });
    if (r.error) throw r.error;
    const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
    return { delivered: read(out), echoed: read(echo) };
  };
})();

const MAX_CANON = 1024;
const long = 'x'.repeat(1500);
const { delivered, echoed } = throughTty(long);

check(`a tty in canonical mode accepts ${MAX_CANON} bytes and stops`, () => {
  // Counted rather than measured whole: an overflowing line discipline also rings the
  // bell, and a ^G on the transcript is not a character anybody typed.
  assert.equal((echoed.match(/x/g) || []).length, MAX_CANON, `sent 1500, echoed ${echoed.length} bytes`);
});

check('and nothing at all is delivered — the newline was among the bytes it dropped', () => {
  assert.equal(delivered, '', `${delivered.length} bytes got through: ${JSON.stringify(delivered.slice(0, 40))}`);
});

/* ---------------------------------------------------- 2 & 3. what actually gets typed */

console.log('\nthe line the AppleScript is handed');

const session = fs.readFileSync(path.join(ROOT, 'lib', 'session.js'), 'utf8');

check('lib/session.js types the source line, not the command', () => {
  assert.match(session, /const command = sourceLine\(commandFile\)/, 'the typed line is no longer sourceLine()');
  assert.ok(
    !/const command = sessionCommand\(/.test(session),
    'the command is being typed straight into the shell again — that is the bug'
  );
});

const dir = path.join(tmp, 'repo');
fs.mkdirSync(dir);
const args = { dir, promptFile: '/tmp/p.md', systemFile: '/tmp/s.md', mode: 'auto', doneFile: '/tmp/d' };

// Every agent that opens a window of its own. Read from the tree rather than listed, so
// a fourth foundation is covered the day it is added.
const AGENTS = ['worker', 'advocate', 'epic-advocate'];
const lines = new Map();
for (const agent of AGENTS) {
  const f = await effective(ROOT, agent);
  const commandFile = path.join(tmp, `beadcause-cmd-${agent}.zsh`);
  lines.set(agent, {
    command: sessionCommand(f, { ...args, commandFile }),
    typed: sourceLine(commandFile),
  });
}

for (const [agent, { command, typed }] of lines) {
  check(`${agent}: ${typed.length} bytes typed for a ${command.length}-byte command`, () => {
    assert.ok(typed.length < MAX_CANON / 4, `${typed.length} bytes is close enough to the limit to be worth a look`);
  });
}

check('the typed line is the same length whatever the agent is — it cannot grow with the allowlist', () => {
  const sizes = [...lines.values()].map(({ typed }) => typed.length);
  // The paths differ only by the agent name in the temp file, which is this test's doing
  // rather than the daemon's — a real one is a fixed-width random stamp. So compare what
  // is left once the path is taken out: the fixed part is what has to be fixed.
  const shapes = new Set([...lines.values()].map(({ typed }) => typed.replace(/'.*'/, "''")));
  assert.equal(shapes.size, 1, `${shapes.size} different shapes: ${[...shapes].join(' | ')}`);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) < 40, `${sizes.join(', ')} — that is not the path length varying`);
});

check('the source line survives the tty the command could not', () => {
  const { typed } = lines.get('epic-advocate');
  const got = throughTty(typed).delivered;
  assert.equal(got.trimEnd(), typed, `got ${JSON.stringify(got)}`);
});

/* --------------------------------------------------------------- 4. and it still runs */

console.log('\nand sourcing it does what typing it did');

const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
// The stand-in for `claude`, and the send-off's five real seconds, which are worth
// nothing here — the same two stubs test/memory.mjs and test/sendoff.mjs use.
stub('claude', `printf '%s' "$PWD" > "$SPY/cwd"; printf '%s' "$BEADCAUSE_AGENT" > "$SPY/agent"; exit 7`);
stub('sleep', 'exit 0');

const spy = path.join(tmp, 'spy');
fs.mkdirSync(spy);
const promptFile = path.join(tmp, 'brief.md');
const systemFile = path.join(tmp, 'system.md');
const doneFile = path.join(tmp, 'done');
const commandFile = path.join(tmp, 'beadcause-cmd-run.zsh');
fs.writeFileSync(promptFile, 'Work bc-3lkv. This is the brief.');
fs.writeFileSync(systemFile, 'the role');
const workerF = await effective(ROOT, 'worker');
fs.writeFileSync(
  commandFile,
  sessionCommand(workerF, { dir, promptFile, systemFile, mode: 'auto', doneFile, commandFile }) + '\n'
);

const run = spawnSync('/bin/zsh', ['-lc', sourceLine(commandFile)], {
  env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SPY: spy },
  encoding: 'utf8',
  timeout: 60000,
});

const spied = (name) => (fs.existsSync(path.join(spy, name)) ? fs.readFileSync(path.join(spy, name), 'utf8') : '');

check('the sourced chain got as far as claude, in the right directory', () => {
  assert.equal(fs.realpathSync(spied('cwd') || '/'), fs.realpathSync(dir), spied('cwd') || '(claude never ran)');
});

check('the exports are still in the shell that ran it — source, not a subshell', () => {
  assert.equal(spied('agent'), 'worker', `${JSON.stringify(spied('agent'))}`);
});

check("the done file still holds claude's status, not the send-off's", () => {
  assert.equal(fs.existsSync(doneFile) ? fs.readFileSync(doneFile, 'utf8') : '', '7', run.stdout?.slice(-200));
});

check('the command file deletes itself on the way out, like the system prompt', () => {
  assert.ok(!fs.existsSync(commandFile), `${commandFile} is still there`);
  assert.ok(!fs.existsSync(systemFile), `${systemFile} is still there`);
});

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall good\x1b[0m');
process.exit(failures ? 1 : 0);
