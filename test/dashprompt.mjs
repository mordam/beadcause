#!/usr/bin/env node
/**
 * A prompt that begins with a dash is a prompt, not a flag (bc-i4sa).
 *
 *     npm test
 *     node test/dashprompt.mjs
 *
 * `claude`'s prompt is a **positional** argument. `-p/--print` is a boolean flag that
 * takes no value, so `claude -p "$P"` is not "the prompt of `-p`" — it is an operand
 * sitting in argv, and an operand whose first character is `-` is an *option* as far as
 * the parser is concerned:
 *
 *     $ claude -p "-hello there"
 *     error: unknown option '-hello there'
 *
 * Exit 1, nothing run. On the phone that surfaced as `claude exited 1: -hello there`,
 * because lib/console.js reports the last line of stderr when a turn produced no text —
 * so the app appeared to quote your own message back at you and call it an error. It
 * only fired on a *plain follow-up* turn: `turnPrompt` prepends the opening context on
 * the first turn and the edited draft after the cards are touched, and either of those
 * puts prose in front of the dash. So the first message worked, and the third did not.
 *
 * The fix is `--` immediately before the prompt, at every call site, with the prompt
 * last. `promptArgs` in lib/foundation.js is the one place that decides that and the
 * place the reasoning lives. What this suite pins is the three things that would let it
 * rot:
 *
 * 1. **The real parser actually behaves this way** — asserted against the installed
 *    `claude`, not against a description of it. See the note on cost below.
 * 2. **The console turn path survives a leading-dash message**, end to end through
 *    `sendTurn`, with a stand-in `claude` recording what the login shell handed it.
 * 3. **Every call site is guarded, including one added next month.** There are five, and
 *    the bead found three; a sweep of `lib/` is what makes the sixth somebody's problem
 *    at review time rather than in production.
 *
 * ## Asking the real `claude` without paying for a turn
 *
 * A parse test that spends a model turn is a parse test nobody runs. The trick is that
 * `--output-format stream-json` with `--print` and no `--verbose` is **refused during
 * validation**, after options are parsed and before anything is dispatched. So the two
 * shapes fail with two different messages, instantly and for free:
 *
 *     claude -p --output-format stream-json    "-hello"   error: unknown option '-hello'
 *     claude -p --output-format stream-json -- "-hello"   Error: … requires --verbose
 *
 * The second message is the proof: option parsing got all the way to validation, which
 * it can only do if `-hello` was taken as the prompt. Reaching a *different* error is
 * the pass condition — and the negative control is in the same check, so this cannot
 * quietly start passing because the flag was renamed.
 *
 * Skipped, loudly, when `claude` is not on PATH. Everything else here is hermetic.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-dashprompt-'));
// Before lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

let failures = 0;
let ran = 0;
let skipped = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.message).split('\n').slice(0, 6).join('\n      ')}`);
  }
}
const skip = (name, why) => {
  skipped += 1;
  console.log(`  \x1b[33m-\x1b[0m ${name} — ${why}`);
};

/** The messages a person actually types that used to kill the turn. */
const DASHED = ['- and the other thing', '--force it', '-p is what I meant', '-- literally this'];

/* ------------------------------------------------ 1. the parser we are relying on */

console.log('\nthe rule, against the installed claude');

const CLAUDE = spawnSync('command', ['-v', 'claude'], { shell: true, encoding: 'utf8' }).stdout.trim();

/** Options parsed, validation reached — whatever came after `--` was taken as a prompt. */
const REACHED_VALIDATION = /requires --verbose/;
const NOT_AN_OPTION = /unknown option/;

if (!CLAUDE) {
  skip('a leading-dash prompt parses when it follows `--`', 'no claude on PATH');
} else {
  const parse = (args) => {
    const r = spawnSync(CLAUDE, ['-p', '--output-format', 'stream-json', ...args], {
      encoding: 'utf8',
      cwd: tmp,
      timeout: 60000,
    });
    return `${r.stdout || ''}${r.stderr || ''}`;
  };

  for (const text of DASHED) {
    await check(`${JSON.stringify(text)} is an unknown option when passed bare`, () => {
      const out = parse([text]);
      assert.match(out, NOT_AN_OPTION, `the bug is meant to still be reachable this way; got: ${out.slice(0, 200)}`);
    });
    await check(`${JSON.stringify(text)} is a prompt when it follows \`--\``, () => {
      const out = parse(['--', text]);
      assert.doesNotMatch(out, NOT_AN_OPTION, `still read as a flag; got: ${out.slice(0, 200)}`);
      assert.match(out, REACHED_VALIDATION, `expected to reach validation; got: ${out.slice(0, 200)}`);
    });
  }

  // The property the old ordering existed to protect. `--tools` and `--allowedTools`
  // are variadic, which is why the prompt used to go *first* — a trailing operand would
  // be eaten as one more tool name. `--` terminates a variadic option as well, so the
  // prompt is safe last; that is the claim the whole fix rests on and it is measured
  // here rather than believed.
  await check('a variadic flag stops at the `--` and does not eat the prompt', () => {
    const out = parse(['--allowedTools', 'Read', 'Edit', '--', '-hello']);
    assert.doesNotMatch(out, NOT_AN_OPTION, `got: ${out.slice(0, 200)}`);
    assert.match(out, REACHED_VALIDATION, `the prompt was swallowed by --allowedTools; got: ${out.slice(0, 200)}`);
  });
}

/* ------------------------------------------- 2. the turn path, with a stand-in claude */
//
// The console is the one call site a person's raw text reaches unaccompanied, so it is
// the one worth driving end to end. A stand-in `claude` earlier on PATH records the argv
// the login shell built and emits one assistant message, so the assertions are about
// what the shell handed the binary — which is the only place the bug ever lived.

console.log('\nthe console turn path');

const fakebin = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-dashprompt-bin-'));
const spy = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-dashprompt-spy-'));
process.on('exit', () => {
  fs.rmSync(fakebin, { recursive: true, force: true });
  fs.rmSync(spy, { recursive: true, force: true });
});

// argv one element per line, NUL-free and newline-delimited because none of the flags
// or the prompts here contain a newline. A reply on stdout too: `sendTurn` reports the
// tail of stderr only when the turn produced no text, so a stub that said nothing would
// pass this suite for the wrong reason.
fs.writeFileSync(
  path.join(fakebin, 'claude'),
  `#!/bin/sh
: > "$SPY/argv"
for a in "$@"; do printf '%s\\n' "$a" >> "$SPY/argv"; done
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"read you"}]}}'
exit 0
`,
  { mode: 0o755 }
);

const { createConsole, sendTurn, getConsole } = await import('../lib/console.js');

// The repo itself, because `sendTurn` resolves the foundation per turn and that is a git
// read against a real tree. `sessionDirs` is the documented override for exactly this.
const cfg = { sessionDirs: { alpha: ROOT }, ownerName: 'Adam' };
const workspace = { name: 'alpha', dir: path.join(tmp, 'alpha', '.beads') };
fs.mkdirSync(workspace.dir, { recursive: true });

/** Run one turn to completion. `sendTurn` returns at launch; the phone polls after it. */
async function turn(c, text) {
  await sendTurn(cfg, c, text);
  const until = Date.now() + 60000;
  while (getConsole(c.id)?.status === 'thinking' && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 25));
  }
  return getConsole(c.id);
}

const argvOf = () => fs.readFileSync(path.join(spy, 'argv'), 'utf8').split('\n').filter(Boolean);

const withStub = async (fn) => {
  const was = process.env.PATH;
  const wasSpy = process.env.SPY;
  process.env.PATH = `${fakebin}:${was}`;
  process.env.SPY = spy;
  try {
    return await fn();
  } finally {
    process.env.PATH = was;
    if (wasSpy === undefined) delete process.env.SPY;
    else process.env.SPY = wasSpy;
  }
};

await withStub(async () => {
  for (const text of DASHED) {
    const c = createConsole(cfg, workspace);
    // The first turn is not the one that breaks: `turnPrompt` puts the opening context
    // in front of it. Started, so the user's text is the whole prompt — which is the
    // state the bug needed and the reason it took three messages to find.
    c.started = true;

    const after = await turn(c, text);
    const argv = argvOf();

    await check(`${JSON.stringify(text)} gets a reply, not an exit code`, () => {
      assert.equal(after.error, null, `error: ${after.error}`);
      assert.equal(after.status, 'idle', `status: ${after.status}`);
      const last = after.messages[after.messages.length - 1];
      assert.match(last.text, /read you/, `reply was: ${JSON.stringify(last.text)}`);
    });

    await check(`${JSON.stringify(text)} arrived as the prompt, whole and last`, () => {
      assert.equal(argv[argv.length - 1], text, `argv tail: ${JSON.stringify(argv.slice(-3))}`);
      assert.equal(argv[argv.length - 2], '--', `nothing guarded it; argv: ${JSON.stringify(argv)}`);
      assert.equal(argv.indexOf('--'), argv.length - 2, `more than one \`--\`; argv: ${JSON.stringify(argv)}`);
    });
  }

  // The other half of what `--` has to survive: a foundation that sets a variadic flag.
  // The baseline sets neither `tools` nor `allowedTools`, so without this the ordering
  // is only ever exercised in its easy case — and the amendment that sets one is not
  // the change that should discover it.
  await check('a foundation with a variadic flag still leaves the prompt last', async () => {
    const { claudeArgs, promptArgs } = await import('../lib/foundation.js');
    const args = [...claudeArgs({ allowedTools: ['Read', 'Bash(git *)'], tools: ['Read'] }), ...promptArgs()];
    assert.equal(args[args.length - 1], '"$P"', args.join(' '));
    assert.equal(args[args.length - 2], '--', args.join(' '));
  });
});

/* ------------------------------------------------------ 3. the other four call sites */

console.log('\nevery line that starts a claude');

const { sessionCommand } = await import('../lib/session.js');
const { commandFor } = await import('../lib/terminal.js');

await check('a work session: the brief is last, behind the `--`', async () => {
  const { effective } = await import('../lib/foundation.js');
  const f = await effective(ROOT, 'worker');
  const line = sessionCommand(f, { dir: tmp, promptFile: '/tmp/p.md', systemFile: '/tmp/s.md', mode: 'auto' });
  // Not anchored at the end: a session with a system file appends its own `rm -f` after
  // the command, and a work session appends the whole send-off. What has to hold is that
  // nothing sits between the last flag and the prompt.
  assert.match(line, /--append-system-prompt-file '\/tmp\/s\.md' -- "\$P"(;|$)/, line);
});

await check('a terminal: the typed opening prompt is last, behind the `--`', () => {
  const line = commandFor({}, '/tmp/slave', '/tmp/prompt.md', { claudeSessionId: 'abc-123' });
  assert.match(line, /claude --session-id 'abc-123' -- "\$P"$/, line);
});

// The sweep, and the reason this file is worth more than two string assertions. The bead
// named three call sites; there are five, and lib/dispatch.js was the one nobody had
// counted. A sixth is a `spawn` away and it will be written by copying one of these five,
// so the rule is asserted against the tree rather than against a list of names.
//
// Right now the tree gives it nothing to reject — every site goes through `promptArgs`,
// so the string is spelled out in exactly one place, the definition. A sweep that can
// only ever pass is not a test, so it is run twice: over `lib/`, where the answer must be
// nothing, and over the five lines as they were *before* this change, where the answer
// must be all five. The second half is what says the first half means something.

/** Lines that hand `claude` a `$P` with nothing stopping it being read as a flag. */
const unguarded = (name, text) =>
  text
    .split('\n')
    .map((line, i) => [i + 1, line.trim()])
    // Comments describe the shape and are allowed to quote it; code has to obey it.
    .filter(([, code]) => !code.startsWith('*') && !code.startsWith('//') && !code.startsWith('/*'))
    .filter(([, code]) => code.includes('"$P"'))
    // `promptArgs` is the definition of the rule, not a call site of it.
    .filter(([, code]) => !code.includes('export function promptArgs'))
    .filter(([, code]) => !/--\s+"\$P"/.test(code))
    .map(([n, code]) => `${name}:${n}: ${code}`);

await check('no line in lib/ passes the prompt to claude unguarded', () => {
  const offenders = fs
    .readdirSync(path.join(ROOT, 'lib'))
    .filter((f) => f.endsWith('.js'))
    .flatMap((name) => unguarded(`lib/${name}`, fs.readFileSync(path.join(ROOT, 'lib', name), 'utf8')));
  assert.deepEqual(offenders, [], `\n${offenders.join('\n')}\n\nUse promptArgs() — see lib/foundation.js.`);
});

await check('and it rejects all five call sites as they were before the fix', () => {
  // Verbatim from the five files at 4e1bf7d, which is the diff this suite belongs to.
  const before = [
    `    '"$P"',`,
    '    `claude "$P"${flags}${sessionEnding(doneFile, systemFile ? [systemFile] : [])}`,',
    '  return `P="$(cat ${shq(promptFile)})" && rm -f ${shq(promptFile)} && ${relay} ${claude} "$P"`;',
    '      `exec claude -p "$P" ${claudeArgs(f).join(\' \')} --output-format stream-json --verbose`;',
    `    \`exec claude -p "$P" --allowedTools '\${tools}'\${`,
  ];
  const caught = unguarded('before', before.join('\n'));
  assert.equal(caught.length, before.length, `only caught ${caught.length} of ${before.length}:\n${caught.join('\n')}`);
});

console.log(
  `\n${failures ? '\x1b[31m' : '\x1b[32m'}${ran - failures}/${ran} checks passed\x1b[0m` +
    (skipped ? ` (${skipped} skipped)` : '')
);
process.exit(failures ? 1 : 0);
