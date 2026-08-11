#!/usr/bin/env node
/**
 * A worker window counts itself down and goes out with a bang (bc-s12k).
 *
 *     npm test
 *     node test/sendoff.mjs
 *
 * `sessionEnding` is the tail of the command `lib/session.js` types into an iTerm
 * window: capture `claude`'s exit status, play a send-off, `exit`. Everything about it
 * is invisible from Node — `launch` hands the string to AppleScript and the next thing
 * that exists is a window on a screen — so this suite runs the string itself, in a real
 * `zsh`, and reads the results back off disk and stdout.
 *
 * The four things worth pinning, in descending order of what they cost when wrong:
 *
 * 1. **The done file still holds `claude`'s status.** The send-off is a pile of
 *    `printf`s and `sleep`s and every one of them clobbers `$?`. If the countdown ever
 *    drifts ahead of the capture, `lib/advocate.js` reads 0 for every session that ever
 *    ran, a failed worker becomes a successful one, and *nothing else in the system
 *    will notice* — that is the expensive bug this file exists for.
 * 2. **It is one line.** The command is typed, not executed: a newline anywhere in it
 *    is a command boundary, so a multi-line send-off runs its own back half immediately
 *    and the window still has `claude` in front of it.
 * 3. **The art survives the shell.** Backslashes are most of an explosion and none of
 *    them are safe inside a format string. Asserting on the rendered output is what
 *    catches a well-meant refactor into `printf '…\n'` — which passes review, and draws
 *    a different picture on every shell.
 * 4. **A chat session gets none of it.** No done file means the window is one you are
 *    sitting at; it must come back to a prompt and stay there, with nothing counting
 *    down at it.
 *
 * `sleep` is stubbed out on PATH, so the five real seconds cost nothing here. That is
 * also the only reason it is safe to assert on the frames: they all land at once.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { sessionEnding } from '../lib/session.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
let ran = 0;
const ok = (name) => {
  ran += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
};
const bad = (name, detail) => {
  ran += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-sendoff-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

/* ---------------------------------------------------------- the shape of the string */

const doneFile = path.join(tmp, 'worker.done');
const ending = sessionEnding(doneFile);

if (!/\n/.test(ending)) ok('the ending is a single line — AppleScript types it, it does not run it');
else bad('the ending is a single line', 'a newline in it is a command boundary, not a character');

if (ending.startsWith(`; printf '%s' "$?" >`))
  ok('the exit status is captured first, before anything that could overwrite it');
else bad('the exit status is captured first', ending.slice(0, 60));

if (ending.trimEnd().endsWith('; exit')) ok('the ending still ends the shell');
else bad('the ending still ends the shell', ending.slice(-60));

if (sessionEnding(null) === '') ok('a chat session gets no send-off and no exit — it comes back to a prompt');
else bad('a chat session gets no send-off and no exit', JSON.stringify(sessionEnding(null)));

/* ----------------------------------------------------------------- and it runs */

/**
 * Run the ending the way iTerm would, behind a command that failed.
 *
 * `(exit 7)` is the stand-in for `claude`: it is the smallest thing that leaves a
 * non-zero `$?`, and 7 rather than 1 so a status invented anywhere along the way cannot
 * pass for the real one. `zsh` because that is the shell in the window — this is also
 * what proves `%40s` and `\r` render there, which is not a given across shells.
 */
const stub = path.join(tmp, 'bin');
fs.mkdirSync(stub);
fs.writeFileSync(path.join(stub, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

const run = spawnSync('/bin/zsh', ['-c', `(exit 7)${ending}`], {
  encoding: 'utf8',
  env: { ...process.env, PATH: `${stub}:${process.env.PATH}` },
  timeout: 30000,
});

if (run.error) bad('the ending runs in zsh at all', String(run.error));
else ok('the ending runs in zsh at all');

const wrote = fs.existsSync(doneFile) ? fs.readFileSync(doneFile, 'utf8') : null;
if (wrote === '7') ok("the done file holds claude's status, not the send-off's");
else bad("the done file holds claude's status, not the send-off's", `it holds ${JSON.stringify(wrote)}`);

const out = run.stdout || '';

const counted = ['( 3 )', '( 2 )', '( 1 )'].filter((frame) => out.includes(frame));
if (counted.length === 3) ok('it counts 3, 2, 1');
else bad('it counts 3, 2, 1', `only ${counted.join(', ') || 'nothing'} was printed`);

if (out.includes('B O O M')) ok('it goes out with a bang');
else bad('it goes out with a bang', 'no explosion on stdout');

/**
 * The one assertion a format-string refactor cannot survive. Both of these lines are
 * drawn with backslashes, and `\ ` and `\(` are exactly the undefined escapes that a
 * `printf '…\n'` would be free to eat.
 */
const drawn = ['   ---  *   B O O M   *  ---', '            \\(^_^)/   all done'].filter((line) =>
  out.split('\n').includes(line)
);
if (drawn.length === 2) ok('the art lands byte for byte — backslashes and all');
else bad('the art lands byte for byte', `${drawn.length} of 2 lines matched; got:\n${out.replace(/\r/g, '⏎')}`);

/* --------------------------------------------------------- and nothing else grew one */

/**
 * The send-off hangs off the done file, which is the same condition as `exit`. Nothing
 * should ever come to depend on it separately — a window that is not closing has
 * nothing to count down to — so `launch` must build its ending from this one function
 * and not assemble a second one inline.
 */
const source = fs.readFileSync(path.join(HERE, '..', 'lib', 'session.js'), 'utf8');
const inlineEndings = source.match(/const ending = (?!sessionEnding\()/g) || [];
if (!inlineEndings.length) ok('launch takes its ending from sessionEnding and builds no second one');
else bad('launch takes its ending from sessionEnding', `${inlineEndings.length} inline ending(s) in lib/session.js`);

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
