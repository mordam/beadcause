#!/usr/bin/env node
/**
 * **`QUEUED-` becomes `DONE-` when the branch lands** — the rename the daemon owes a
 * window it did not open.
 *
 *     npm test
 *     node test/retitle.mjs
 *
 * A worker used to merge its own branch, so `DONE-` on its name was true when it wrote
 * it. Since bc-r941 it hands the branch to the merge queue and the merge happens later,
 * in another process — so the last thing the session says about itself is a claim it
 * cannot check, and the thing it would hide is exactly the failure the prefix exists to
 * make visible: a bead closed over a branch nobody merged.
 *
 * So the worker writes `QUEUED-` and lib/mergequeue.js writes `DONE-` over it. Four
 * failures are worth a suite, and none of them is visible by reading `mergedTitle`:
 *
 * 1. **Renaming the wrong window.** The only tie between a session and a bead is its
 *    name, and every id is a prefix of its own subtasks' ids. A merge on `al-1` that
 *    renames the window working `al-1.2` marks unfinished work as landed.
 * 2. **Writing one store and reporting both.** A name lives in the pid record *and* in
 *    the transcript, and they answer different questions — the record is what every
 *    guard in this codebase reads, the transcript is what `/resume` shows forever.
 *    Writing only the second renames the window for a human and leaves the daemon
 *    reading the old name.
 * 3. **Shoving an old session to the top of `/resume`.** The picker orders by mtime, so
 *    a retitle that touches it makes yesterday's finished work look like the most
 *    recent thing on the Mac — every time the queue merges anything.
 * 4. **Stacking prefixes.** `DONE-DONE-` is the one visible bug this module can have,
 *    and the hand-shipped spelling (`done- `, from `rename-session.sh --done`) has to
 *    count as already-done or every merge writes over it.
 *
 * The stores are real files in a scratch `~/.claude`, because the whole module is a
 * claim about two file formats that belong to Claude Code rather than to us.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupTmp } from './helpers/tmp.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-retitle-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { mergedTitle, retitle, markMerged, describeMarked } = await import('../lib/retitle.js');

const SESSIONS = path.join(tmp, 'claude', 'sessions');
const PROJECTS = path.join(tmp, 'claude', 'projects');
fs.mkdirSync(SESSIONS, { recursive: true });
fs.mkdirSync(path.join(PROJECTS, '-repo-widgets'), { recursive: true });

const cfg = { claudeSessionsDir: SESSIONS, workspaces: [] };

let failures = 0;
let ran = 0;
const check = async (name, fn) => {
  ran += 1;
  try {
    await fn();
    console.log(`  \x1b[32mok\x1b[0m   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}\n       ${String(err.message).split('\n').join('\n       ')}`);
  }
};

/** A live session record and its transcript, the way Claude Code writes them. */
function window({ pid = process.pid, sessionId = 'sess-abcdefgh', name, transcript = true } = {}) {
  fs.writeFileSync(
    path.join(SESSIONS, `${pid}.json`),
    JSON.stringify({ pid, sessionId, name, cwd: '/repo/widgets', status: 'idle', statusUpdatedAt: Date.now() })
  );
  const file = path.join(PROJECTS, '-repo-widgets', `${sessionId}.jsonl`);
  if (transcript) fs.writeFileSync(file, `${JSON.stringify({ type: 'user', message: { content: 'go' } })}\n`);
  else fs.rmSync(file, { force: true });
  return { pid, sessionId, name, cwd: '/repo/widgets', file, record: path.join(SESSIONS, `${pid}.json`) };
}

const titles = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === 'custom-title')
    .map((e) => e.customTitle);

/* ------------------------------------------------------------------ the name */

await check('a queued window becomes a done one, keeping everything after the prefix', () => {
  assert.equal(mergedTitle('QUEUED-Beadcause - bc-a7pw the rename'), 'DONE-Beadcause - bc-a7pw the rename');
  // The id has to come through untouched: `beadInName` reads the second field, and it
  // is the only thing joining this window to a bead.
  assert.equal(mergedTitle('QUEUED-Alpha - al-1.2 a subtask'), 'DONE-Alpha - al-1.2 a subtask');
});

await check('and a window that never renamed itself is prefixed rather than left', () => {
  // A session that skipped its own protocol still delivered a branch that merged, and a
  // window saying nothing is the case the reaper's sweep can never pick up.
  assert.equal(mergedTitle('Beadcause - bc-a7pw the rename'), 'DONE-Beadcause - bc-a7pw the rename');
});

await check('ALREADY DONE IS LEFT ALONE, IN BOTH SPELLINGS', () => {
  assert.equal(mergedTitle('DONE-Beadcause - bc-a7pw the rename'), null);
  assert.equal(mergedTitle('done- Sophab - sp-iai s-sheet, shipped'), null, 'the by-hand spelling counts');
  // Twice through the queue — a re-merge, a second tick over a bead closed already —
  // must not produce `DONE-DONE-`.
  assert.equal(mergedTitle(mergedTitle('QUEUED-Alpha - al-1 a bead')), null);
});

await check('and an unnamed window gets nothing invented for it', () => {
  // A fabricated name is indistinguishable from one the session chose, and every guard
  // downstream reads the name as the session's own account of itself.
  assert.equal(mergedTitle(''), null);
  assert.equal(mergedTitle(null), null);
  assert.equal(mergedTitle('   '), null);
});

/* ---------------------------------------------------------------- both stores */

await check('BOTH STORES ARE WRITTEN, BECAUSE THEY ANSWER DIFFERENT QUESTIONS', () => {
  const w = window({ name: 'QUEUED-Alpha - al-1 a bead' });
  const out = retitle(cfg, w, 'DONE-Alpha - al-1 a bead');
  assert.deepEqual({ record: out.record, transcript: out.transcript }, { record: true, transcript: true });
  // The record is what lib/claude.js reads, and so what the reaper and the advocate
  // mean by a window's name.
  assert.equal(JSON.parse(fs.readFileSync(w.record, 'utf8')).name, 'DONE-Alpha - al-1 a bead');
  // The transcript is what `/resume` labels the conversation with, forever.
  assert.deepEqual(titles(w.file), ['DONE-Alpha - al-1 a bead']);
});

await check('the record says the name was chosen, and for which conversation', () => {
  const w = window({ name: 'QUEUED-Alpha - al-1 a bead' });
  retitle(cfg, w, 'DONE-Alpha - al-1 a bead');
  const rec = JSON.parse(fs.readFileSync(w.record, 'utf8'));
  // `/clear` rewrites this record in place with a new session id but keeps `name`;
  // without `nameSessionId` the status line flies a name chosen for a dead conversation.
  assert.equal(rec.nameSource, 'user');
  assert.equal(rec.nameSessionId, w.sessionId);
});

await check('RETITLING DOES NOT SHOVE THE SESSION TO THE TOP OF /resume', () => {
  const w = window({ name: 'QUEUED-Alpha - al-1 a bead' });
  const then = new Date(Date.now() - 36 * 3600 * 1000);
  fs.utimesSync(w.file, then, then);
  retitle(cfg, w, 'DONE-Alpha - al-1 a bead');
  // The picker orders by mtime. A merge queue that touched it would reorder the list
  // every time it landed anything, which is worse than the wrong title.
  assert.equal(Math.round(fs.statSync(w.file).mtimeMs / 1000), Math.round(then.getTime() / 1000));
});

await check('and each half fails on its own rather than taking the other with it', () => {
  const w = window({ name: 'QUEUED-Alpha - al-1 a bead', transcript: false });
  const out = retitle(cfg, w, 'DONE-Alpha - al-1 a bead');
  // A cleared conversation has no transcript. The window is still there and still has
  // the wrong name on it, so the half that can be written is.
  assert.equal(out.record, true);
  assert.equal(out.transcript, false);
  assert.match(describeMarked([out]), /one of the two stores/);
});

/* ------------------------------------------------------------ which window */

await check('ONLY THE WINDOW ON THAT BEAD IS RENAMED, NOT ITS SUBTASK\'S', () => {
  const parent = { pid: 1, sessionId: 's-parent', name: 'QUEUED-Alpha - al-1 a bead', cwd: '/repo/widgets' };
  const kid = { pid: 2, sessionId: 's-kid', name: 'QUEUED-Alpha - al-1.2 the subtask', cwd: '/repo/widgets' };
  const marked = markMerged(cfg, 'al-1', { sessions: [parent, kid] });
  // `namesBead` again, and the reason it exists: every parent id is a prefix of its
  // children's, so a merge on the parent marking the child's window landed would say
  // unfinished work had shipped.
  assert.deepEqual(marked.map((m) => m.pid), [1]);
});

await check('two windows on one bead are both renamed', () => {
  const a = { pid: 3, sessionId: 's-a', name: 'QUEUED-Alpha - al-1 a bead', cwd: '/repo/widgets' };
  const b = { pid: 4, sessionId: 's-b', name: 'Alpha - al-1 a bead', cwd: '/repo/widgets' };
  // Two windows on one bead is a real state on this Mac rather than an error, so this
  // renames both instead of picking one and leaving the other lying.
  assert.deepEqual(markMerged(cfg, 'al-1', { sessions: [a, b] }).map((m) => m.pid), [3, 4]);
});

await check('and a merge with no window left to rename is silent, not an error', () => {
  // The ordinary case: most merges land long after the window that delivered them was
  // reaped, and a pull request Adam opened by hand never had one.
  assert.deepEqual(markMerged(cfg, 'al-1', { sessions: [] }), []);
  assert.equal(describeMarked([]), '');
  assert.deepEqual(markMerged(cfg, '', { sessions: [] }), []);
});

await check('a window already saying done- is not renamed again', () => {
  const w = { pid: 5, sessionId: 's-done', name: 'DONE-Alpha - al-1 a bead', cwd: '/repo/widgets' };
  assert.deepEqual(markMerged(cfg, 'al-1', { sessions: [w] }), []);
});

/* ---------------------------------------------------------- end to end */

await check('a live session record is found by pid and rewritten in place', () => {
  const w = window({ name: 'QUEUED-Alpha - al-1 a bead', sessionId: 'sess-live-01' });
  // Through `liveSessions` this time rather than a handed-in list: the pid has to be
  // alive for it to be listed at all, which is why this one uses our own.
  const marked = markMerged(cfg, 'al-1');
  assert.equal(marked.length, 1, 'the live window was not found');
  assert.equal(JSON.parse(fs.readFileSync(w.record, 'utf8')).name, 'DONE-Alpha - al-1 a bead');
  assert.deepEqual(titles(w.file), ['DONE-Alpha - al-1 a bead']);
  assert.match(describeMarked(marked), /renamed 1 window DONE-/);
});

/* ------------------------------------------------------------------------ done */

await cleanupTmp(tmp);
console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
