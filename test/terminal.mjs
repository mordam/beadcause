/**
 * What a terminal remembers across a daemon restart.
 *
 * The in-app terminal was the one surface a `launchctl kickstart -k` destroyed
 * outright — the registry was in memory and the pty was a child of the daemon. It
 * still kills the pty; what it must no longer do is lose the conversation. The rules
 * that make that true are small and entirely about records on disk, which is lucky,
 * because the alternative is a test that spawns a real `expect` and a real `claude`.
 *
 * So this covers the record layer and nothing below it:
 *
 * - a terminal that was running comes back as an offer to resume, with the claude
 *   session id that makes resuming possible at all;
 * - a terminal that ended stays ended — the difference between a session the daemon
 *   interrupted and one you closed is the whole feature, and getting it backwards
 *   would resurrect finished sessions on every boot;
 * - a record written before any of this existed, and a half-written one, are dropped
 *   rather than offered as something that cannot be delivered;
 * - the flags: `--session-id` the first time, `--resume` afterwards.
 *
 * Nothing here spawns a pty, opens a terminal, or writes outside a temp directory.
 * `npm test`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-terminal-'));
// Before lib/config.js is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
const TERMINALS = path.join(process.env.BEADCAUSE_CONFIG_DIR, 'terminals');
fs.mkdirSync(TERMINALS, { recursive: true });

const { restoreTerminals, listTerminals, getTerminal, closeTerminal, commandFor, summary } = await import(
  LIB('terminal.js')
);

/* ------------------------------------------------------------------ fixtures */

const cfg = { terminal: true, terminalScrollbackBytes: 16384, terminalIdleMinutes: 30 };
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

/** A record as a previous daemon would have left it. */
const write = (id, extra) =>
  fs.writeFileSync(
    path.join(TERMINALS, `${id}.json`),
    JSON.stringify({
      id,
      workspace: 'alpha',
      dir: '/tmp/alpha',
      bead: { id: 'a-1', title: 'Something' },
      cols: 100,
      rows: 30,
      claudeSessionId: '11111111-2222-3333-4444-555555555555',
      status: 'live',
      startedAt: iso(60000),
      endedAt: null,
      exitCode: null,
      exitSignal: null,
      resumedAt: null,
      savedAt: iso(1000),
      ...extra,
    })
  );

const RUNNING = 'aaaaaaaaaaaaaaa1';
const ENDED = 'aaaaaaaaaaaaaaa2';
const LONG_ENDED = 'aaaaaaaaaaaaaaa3';
const PRE_FEATURE = 'aaaaaaaaaaaaaaa4';
const GARBAGE = 'aaaaaaaaaaaaaaa5';

write(RUNNING, {});
write(ENDED, { status: 'exited', endedAt: iso(60000), exitCode: 0 });
// Older than KEEP_EXITED_MS (10 minutes), so it is past being interesting.
write(LONG_ENDED, { status: 'exited', endedAt: iso(45 * 60000), exitCode: 0 });
write(PRE_FEATURE, { claudeSessionId: null });
fs.writeFileSync(path.join(TERMINALS, `${GARBAGE}.json`), '{"id": "aaaa');

/* ------------------------------------------------------------------- harness */

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
    console.log(`       ${String(err.message).split('\n').slice(0, 6).join('\n       ')}`);
  }
}
function skip(name) {
  console.log(`  skip ${name}`);
}

const onDisk = (id) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(TERMINALS, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
};

/* --------------------------------------------------------------------- cases */

console.log('terminal persistence');

const restored = restoreTerminals(cfg);

await check('a terminal that was running comes back resumable', () => {
  const t = getTerminal(RUNNING);
  assert.ok(t, 'it must be in the registry after a restore');
  assert.equal(t.status, 'resumable', 'running at shutdown means resumable at boot');
  assert.equal(t.claudeSessionId, '11111111-2222-3333-4444-555555555555', 'the handle to resume with must survive');
  assert.equal(t.dir, '/tmp/alpha', 'and the directory, or it would resume against the wrong tracker');
  assert.equal(t.bead?.id, 'a-1');
  assert.equal(t.cols, 100, 'the size it was drawn at');
  assert.equal(t.child, null, 'restoring must not spawn anything');
  assert.equal(t.buf.length, 0, 'the scrollback is deliberately not carried across');
});

await check('a terminal that ended stays ended', () => {
  const t = getTerminal(ENDED);
  assert.ok(t, 'a recently-ended terminal is still listed, as it was before a restart');
  assert.equal(t.status, 'exited', 'a session you finished must never be resurrected');
});

await check('an old ended terminal is forgotten, file and all', () => {
  assert.equal(getTerminal(LONG_ENDED), null, 'past the keep window it should be gone from the registry');
  assert.equal(onDisk(LONG_ENDED), null, 'and its record should be deleted, not left to accumulate');
});

await check('a record with no session id is dropped rather than offered', () => {
  assert.equal(getTerminal(PRE_FEATURE), null, 'there is no handle to resume it with');
  assert.equal(onDisk(PRE_FEATURE), null);
});

await check('one unreadable record does not lose the others', () => {
  assert.equal(getTerminal(GARBAGE), null);
  assert.equal(restored, 2, `only the running and recently-ended ones should restore, got ${restored}`);
  assert.deepEqual(
    listTerminals()
      .map((t) => t.status)
      .sort(),
    ['exited', 'resumable'],
    'the list is what the phone sees — it must not carry the dropped ones'
  );
});

await check('the summary tells a client which is which', () => {
  const t = summary(getTerminal(RUNNING));
  assert.equal(t.status, 'resumable');
  assert.equal(t.resumedAt, null, 'nothing has resumed it yet');
  assert.equal(t.bytes, 0);
});

await check('closing one that was never resumed ends it, on disk too', () => {
  assert.equal(closeTerminal(RUNNING), true, 'there is no process, but the offer is still closeable');
  assert.equal(getTerminal(RUNNING).status, 'exited');
  const rec = onDisk(RUNNING);
  assert.equal(rec.status, 'exited', 'the next restart must not offer it again');
  assert.ok(rec.endedAt, 'and it must say when it ended');
});

await check('the flags: named the first time, resumed after', () => {
  const fresh = commandFor(cfg, '/tmp/slave', null, { claudeSessionId: 'abc-123' });
  assert.match(fresh, /claude --session-id 'abc-123'$/, `got: ${fresh}`);

  const again = commandFor(cfg, '/tmp/slave', null, { claudeSessionId: 'abc-123', resume: true });
  assert.match(again, /claude --resume 'abc-123'$/, `got: ${again}`);

  // The brief form still reads and deletes the prompt file before exec, and the
  // session flag has to land on `claude` rather than on the relay. The prompt is last
  // and behind a `--` (bc-i4sa): this one is typed by a person into the opening field,
  // so a leading dash would otherwise be parsed as a flag and the pty would just close.
  const seeded = commandFor(cfg, '/tmp/slave', '/tmp/prompt.md', { claudeSessionId: 'abc-123' });
  assert.match(seeded, /rm -f '\/tmp\/prompt\.md'/, `got: ${seeded}`);
  assert.match(seeded, /claude --session-id 'abc-123' -- "\$P"$/, `got: ${seeded}`);

  // No id at all is what a caller from before this existed looks like: unchanged.
  assert.match(commandFor(cfg, '/tmp/slave', null), /claude$/);
});

// Honest about what is not covered: everything below the record layer needs a real
// pty. `expect` and `claude` both being on PATH is not something a test should
// assume, and a test that opened one would leave a Claude session running in a temp
// directory. The seam these tests hold is that resuming is a flag and a record.
skip('the pty itself — spawn, resume banner, and the kill on shutdown');

await cleanupTmp(tmp);
console.log(failures ? `\n${failures} of ${ran} failed` : `\n${ran} passed`);
process.exit(failures ? 1 : 0);
