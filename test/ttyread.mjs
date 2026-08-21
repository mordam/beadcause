#!/usr/bin/env node
/**
 * Something else was reading the tty we type into (bc-xl7n.113.1).
 *
 *     npm test
 *     node test/ttyread.mjs
 *
 * A worker window came up and printed this, and the third line is the whole bug:
 *
 *     [oh-my-zsh] Would you like to update? [Y/n]
 *     [oh-my-zsh] You can update manually by running `omz update`
 *     ource '/var/folders/.../beadcause-cmd-4eaf3aa87171.zsh'
 *     zsh: command not found: ource
 *
 * test/canonline.mjs is the sibling of this suite and it is about a different failure of
 * the same tty: a line too *long* for `MAX_CANON`. This one is about a line that is
 * typed while the shell's line editor is not yet the thing reading the terminal — and
 * while that is true, anything in the rc files that reads the tty reads **our bytes**.
 * `~/.oh-my-zsh/tools/check_for_upgrade.sh` is `read -r -k 1 option`: one character off
 * the front. It took the `s`, and `ource '<path>'` is what got submitted.
 *
 * The fix is `TTY_PAD` — sacrificial spaces on the front of the typed line, which a
 * shell throws away and a reader eats instead of the command. So what is pinned here is
 * not "oh-my-zsh works now"; it is the property that makes it work, against a stand-in
 * rc file that does nothing but read:
 *
 * 1. **The bug reproduces.** Unpadded, one reader, and the transcript says
 *    `command not found: ource` — the same four words the window did. This is the check
 *    that fails without the fix, and it is here so that removing the pad cannot look
 *    like a passing suite.
 * 2. **Padded, the command runs.** Same rc file, same reader, `sourceLine` as shipped.
 * 3. **There is headroom.** Three readers in a row still leave the command intact,
 *    because the pad is eight and not one.
 * 4. **It costs nothing when nobody reads.** The overwhelmingly common case: an rc file
 *    that touches no tty, and a line that runs exactly as it always did.
 * 5. **The sacrifice is a space and never a newline.** omz's arm is `[yY$'\n'])`, so a
 *    newline does not get eaten quietly — it answers *yes* and runs `omz update`. This
 *    is asserted on the string, because it is the one way to get the fix backwards
 *    while every behavioural check above still passes.
 *
 * A real pty throughout, for the reason canonline.mjs gives: `read -k` will not take a
 * pipe at all ("not interactive and can't open terminal") and leaves the byte behind, so
 * a pipe cannot demonstrate this bug — it makes it look already fixed.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { sourceLine, TTY_PAD } from '../lib/session.js';

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-ttyread-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

/* ------------------------------------------------------------------- the rc stand-in */

/**
 * An rc file that reads the terminal `readers` times, and nothing else.
 *
 * Deliberately not oh-my-zsh: what is being defended is the class, and a suite that
 * needed omz installed would be testing this Mac rather than this repo. `read -r -k 1`
 * is the one line of omz that matters, copied exactly.
 *
 * The `sleep` is the determinism. The typed bytes are put into the pty the instant after
 * the shell is spawned, and they are sitting in the terminal's input queue either way —
 * but a fifth of a second in front of the first read means the ordering cannot come down
 * to how long zsh took to start on a loaded laptop.
 *
 * `ZDOTDIR` is what makes this file the only rc file in play, which also keeps Adam's
 * own `~/.zshenv` and its `BEADS_DIR` machinery out of a suite that has no business
 * touching a tracker.
 */
const zdotdirWith = (name, readers) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const lines = ['sleep 0.2'];
  for (let i = 1; i <= readers; i += 1) {
    lines.push(`printf '[rc] reader ${i} asking: '`);
    lines.push('read -r -k 1 eaten');
    lines.push(`printf '[rc] reader ${i} ate %d byte(s)\\n' "${'${#eaten}'}"`);
  }
  fs.writeFileSync(path.join(dir, '.zshrc'), `${lines.join('\n')}\n`);
  return dir;
};

/**
 * Type one line at an interactive zsh over a real pty and hand back the transcript.
 *
 * `expect` for the pty, the same way canonline.mjs and lib/terminal.js get one: there is
 * no `openpty(3)` in Node, and a pipe is not a terminal — which is the whole point here.
 *
 * It stops as soon as the answer is known rather than sleeping out a fixed wait: the
 * marker means the command ran, "not found" means a reader ate into it. Only a suite
 * that is already failing pays the timeout.
 */
const MARKER = 'BEADCAUSE-COMMAND-RAN';
const typeInto = (() => {
  const script = path.join(tmp, 'read.exp');
  fs.writeFileSync(
    script,
    [
      'log_user 0',
      'set timeout 15',
      // `-a`, or `log_user 0` suppresses the file too — same trap canonline.mjs notes.
      'log_file -a -noappend [lindex $argv 0]',
      'set zdot [lindex $argv 1]',
      'set payload [read [open [lindex $argv 2] r]]',
      'spawn -noecho env ZDOTDIR=$zdot /bin/zsh -i',
      // Not inside "…": the payload is a shell-quoted path and Tcl would go looking for
      // variables in it. One word either way, leading spaces included.
      'send -- $payload',
      'send -- "\\r"',
      `expect {`,
      `  "${MARKER}" { }`,
      `  "not found" { }`,
      `  timeout { }`,
      `}`,
      // The shell may already be gone if the sourced file ended it; neither of these is
      // allowed to be the reason the suite fails.
      'catch { send -- "exit\\r" }',
      'catch { expect eof }',
      '',
    ].join('\n')
  );
  let n = 0;
  return (zdot, line) => {
    const at = (kind) => path.join(tmp, `pty-${(n += 1)}-${kind}`);
    const [log, payload] = [at('log'), at('in')];
    fs.writeFileSync(payload, line);
    const r = spawnSync('/usr/bin/expect', ['-f', script, log, zdot, payload], { timeout: 40000 });
    if (r.error) throw r.error;
    return fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  };
})();

/** What a session's command file is, reduced to the one thing worth observing. */
const commandFile = (() => {
  const file = path.join(tmp, 'beadcause-cmd-ttyread.zsh');
  fs.writeFileSync(file, `print -r -- '${MARKER}'\n`, { mode: 0o600 });
  return file;
})();

const ran = (transcript) => transcript.includes(MARKER);

/* ----------------------------------------------------------------- 1 & 2. the bug */

console.log('\na startup reader eating the front of the typed line');

const oneReader = zdotdirWith('one-reader', 1);
// The fix turned off, which is what this line was before it existed — taken from
// `sourceLine` rather than spelled out here, so the reproduction cannot drift away from
// the thing being fixed and quietly start reproducing nothing.
const unpadded = sourceLine(commandFile, 0);
const bare = typeInto(oneReader, unpadded);

check('the unpadded line is what it always was', () => {
  assert.equal(unpadded, `source '${commandFile}'`, unpadded);
});

check('unpadded, a single-character reader breaks the command exactly as reported', () => {
  assert.ok(!ran(bare), `the command ran anyway — has something stopped reading the tty?\n${bare.slice(-400)}`);
  assert.match(bare, /command not found: ource/, bare.slice(-400));
});

const padded = sourceLine(commandFile);
const withPad = typeInto(oneReader, padded);

check('padded, the reader eats a space and the command still runs', () => {
  assert.ok(ran(withPad), `${JSON.stringify(padded.slice(0, 20))} never ran:\n${withPad.slice(-400)}`);
  assert.doesNotMatch(withPad, /not found/, withPad.slice(-400));
});

/* --------------------------------------------------------------------- 3. headroom */

console.log('\nand more than one of them');

check(`three readers in a row are still inside a pad of ${TTY_PAD}`, () => {
  assert.ok(TTY_PAD >= 3, `${TTY_PAD} spaces is not three readers' worth`);
  const t = typeInto(zdotdirWith('three-readers', 3), sourceLine(commandFile));
  assert.ok(ran(t), t.slice(-400));
  // All three really did read — a pad that worked because the rc file was skipped would
  // pass the line above and prove nothing.
  assert.equal((t.match(/ate 1 byte/g) || []).length, 3, `readers that fired: ${t.slice(-400)}`);
});

/* ------------------------------------------------------------ 4. and the usual case */

console.log('\nwhat it costs when nothing is reading');

check('an rc file that touches no tty runs the padded line unchanged', () => {
  const t = typeInto(zdotdirWith('no-reader', 0), sourceLine(commandFile));
  assert.ok(ran(t), t.slice(-400));
});

/* --------------------------------------------------------- 5. the shape of the pad */

console.log('\nthe pad itself');

check('it is leading spaces — not a newline, which omz reads as yes and updates on', () => {
  const pad = padded.slice(0, padded.length - unpadded.length);
  assert.equal(pad, ' '.repeat(TTY_PAD), `the pad is ${JSON.stringify(pad)}`);
  assert.ok(!/[\r\n]/.test(padded), 'a newline in the typed line answers oh-my-zsh rather than feeding it');
  assert.equal(padded.trimStart(), unpadded, 'the pad is the only difference — the command itself must not change');
});

check('the pad is nowhere near the 1024 bytes canonline.mjs measures', () => {
  assert.ok(padded.length < 256, `${padded.length} bytes typed is close enough to MAX_CANON to be worth a look`);
});

check('the pad is the whole of the change — nothing else about the line moved', () => {
  assert.equal(padded, ' '.repeat(TTY_PAD) + unpadded, padded);
});

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall good\x1b[0m');
process.exit(failures ? 1 : 0);
