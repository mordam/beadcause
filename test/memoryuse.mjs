#!/usr/bin/env node
/**
 * Whether the memory is ever read — the instrument, the counts, and the pane over them.
 *
 *     npm test
 *     node test/memoryuse.mjs
 *
 * Three tiers of persistence shipped before anything could answer the question they
 * exist to answer: *is an agent actually carrying anything between runs?* The refs said
 * what was written and nothing said whether it came back out, so the prediction the
 * whole epic is written against — a write-only diary — was untestable for the two tiers
 * that have any data in them.
 *
 * Four things are worth pinning here and the rest is plumbing:
 *
 * 1. **A read has to be recorded, and only a read.** An agent running
 *    `beadcause-memory notes x` is a read; the daemon quoting a note into a session's
 *    prompt is not, and `notesIn` is the call that does that. If that line ever moves,
 *    every session "reads" everything, the number becomes unfalsifiable, and the
 *    instrument answers the question instead of the agents.
 * 2. **The counts have to be the refs.** The screen's numbers are checked against
 *    `git log` on the same ref in the same assertion, because a count computed from a
 *    cached shape is a count that can drift from the store without anybody noticing —
 *    and the whole point of the surface is that a number on it can be trusted.
 * 3. **`--of` keeps reader and subject apart.** Reading another agent's memory has to
 *    be attributable to the reader, or "has anything I wrote ever been useful to
 *    anyone" is unanswerable in the one case it is interesting.
 * 4. **Tier 3 must never pool.** `summary()` buckets on the arm while every row carries
 *    an agent and a workspace, which was indistinguishable from correct while exactly
 *    one agent had a repo. Two agents' `blind` arms added together is a number nobody
 *    asked for, in the one place the docstring promises never to produce one.
 *
 * A fifth thing rides along because it is the same screen and the same question — what
 * an agent has been allowed to become. Every agent's amendments share one ref, which is
 * right, and the History tab under one agent's name was drawing all of them: the
 * worker's history was a request the *dispatch* agent had made.
 *
 * Everything runs against a temp `BEADCAUSE_CONFIG_DIR` and a throwaway git repo.
 * Nothing here touches the real `~/.config/beadcause` or any repo you work in.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) return console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${detail}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-memoryuse-'));
const store = path.join(tmp, 'config');
const repo = path.join(tmp, 'repo');
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(repo, { recursive: true });
process.env.BEADCAUSE_CONFIG_DIR = store;
process.env.BEADCAUSE_AGENT = 'worker';
delete process.env.BEADCAUSE_BEAD;
process.on('exit', () => removeTreeSync(tmp));

const inRepo = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
inRepo('init', '-q', '-b', 'main');
inRepo('config', 'user.email', 'test@example.invalid');
inRepo('config', 'user.name', 'test');
fs.writeFileSync(path.join(repo, 'README.md'), '# throwaway\n');
inRepo('add', '-A');
inRepo('commit', '-qm', 'first');

// Imported after the env is set: CONFIG_DIR resolves once, at module load.
const memory = await import('../lib/memory.js');
const memoryuse = await import('../lib/memoryuse.js');
const agentrepo = await import('../lib/agentrepo.js');

// Tier 1 resolves its store from the process's cwd, which is the whole of how it knows
// which repo a note is about. So the suite stands in the throwaway one.
const started = process.cwd();
process.chdir(repo);
process.on('exit', () => process.chdir(started));

const AGENTS = ['worker', 'advocate', 'console'];
const lines = () => memoryuse.entries();

/* ------------------------------------------------------------- the instrument */

console.log('a read is recorded, and only a read');

await memory.note('worker', 'tests', 'npm test discovers test/*.mjs');
await memory.note('worker', 'tests', 'npm test discovers test/*.mjs, and scripts/test.mjs runs them');
await memory.note('worker', 'worktrees', 'a fresh one needs node_modules linked');
check('writing records nothing — the refs already say that', lines().length === 0, JSON.stringify(lines()));

await memory.notes('worker', 'tests');
const first = lines().at(-1);
check('a read by key appends one line', lines().length === 1, JSON.stringify(lines()));
check('naming the reader', first?.by === 'worker', JSON.stringify(first));
check('the store it was against', first?.tier === 'notes', JSON.stringify(first));
check('the key', first?.key === 'tests', JSON.stringify(first));
check('that it was there', first?.hit === true, JSON.stringify(first));
check(
  'and which repo, because a note is about exactly one',
  first?.repo === fs.realpathSync(repo),
  `${first?.repo} vs ${fs.realpathSync(repo)}`
);

await memory.notes('worker', 'nothing-here');
check('a miss is still a read — asking is the signal', lines().at(-1)?.hit === false, JSON.stringify(lines().at(-1)));

await memory.notesIn(repo, 'worker');
check(
  'the daemon quoting a note into a prompt is NOT a read',
  lines().length === 2,
  `notesIn recorded something: ${JSON.stringify(lines().at(-1))}`
);

await memory.notesDetail('worker');
check('a bare listing records no key', lines().at(-1)?.key === null, JSON.stringify(lines().at(-1)));

await memory.recallDetail('advocate', { by: 'worker' });
const of = lines().at(-1);
check('`--of` keeps the reader and the subject apart', of?.by === 'worker' && of?.subject === 'advocate', JSON.stringify(of));

const before = lines().length;
memoryuse.recordRead({ by: '', tier: 'notes', key: 'x' });
memoryuse.recordRead({ by: 'worker', tier: 'not-a-tier', key: 'x' });
check('a read with no reader, or against no store, is dropped', lines().length === before, JSON.stringify(lines().slice(before)));

/* ------------------------------------------------------------------ the counts */

console.log('\nthe counts are the refs');

const census = await memory.census(repo, AGENTS);
const worker = census.agents.worker;
const refLog = inRepo('log', '--format=%H', 'refs/beadcause/agents/worker').split('\n').filter(Boolean);
check('three writes over two keys is two keys', worker.notes.keys.length === 2, JSON.stringify(worker.notes.keys));
check('and three writes', worker.notes.writes === 3, String(worker.notes.writes));
check('which is what git log says on the same ref', worker.notes.writes === refLog.length, `${worker.notes.writes} vs ${refLog.length}`);
check('with the newest write stamped', Boolean(worker.notes.lastWriteAt), String(worker.notes.lastWriteAt));

await memory.remember('worker', 'shape', 'evidence first');
await memory.remember('advocate', 'tone', 'short');
await memory.remember('advocate', 'tone', 'shorter');
const two = await memory.census(repo, AGENTS);
check('tier 2 is one ref for everybody, and the counts do not bleed', two.agents.worker.memory.writes === 1, String(two.agents.worker.memory.writes));
check('the other agent has its own two', two.agents.advocate.memory.writes === 2, String(two.agents.advocate.memory.writes));
check('over one key, because a write overwrites', two.agents.advocate.memory.keys.length === 1, JSON.stringify(two.agents.advocate.memory.keys));
check(
  'an agent that has never written anything is present with zeroes rather than absent',
  Boolean(two.agents.console) && two.agents.console.notes.writes === 0 && two.agents.console.memory.keys.length === 0,
  JSON.stringify(two.agents.console)
);
check(
  'and the notes ref it would write to is named even though it does not exist',
  two.agents.console.notes.ref === 'refs/beadcause/agents/console',
  two.agents.console.notes.ref
);

const seen = memoryuse.readsFor(AGENTS, { repo: fs.realpathSync(repo) });
check('the reader has its reads', seen.worker.notes.reads === 3, JSON.stringify(seen.worker.notes));
check('a listing is counted as a listing, not as a key', seen.worker.notes.listings === 1, JSON.stringify(seen.worker.notes));
check('and only keys actually asked for are keys', seen.worker.notes.keys.join(',') === 'tests,nothing-here', JSON.stringify(seen.worker.notes.keys));
check('the agent whose store was read with --of is credited the read', seen.advocate.byThem === 1, String(seen.advocate.byThem));
check(
  'and another repo\'s tier-1 reads stay out of this one',
  memoryuse.readsFor(AGENTS, { repo: '/somewhere/else' }).worker.notes.reads === 0,
  JSON.stringify(memoryuse.readsFor(AGENTS, { repo: '/somewhere/else' }).worker.notes)
);

/* --------------------------------------------------------- what the screen gets */

console.log('\nwhat the agents screen is handed');

const { agentDetail } = await import('../lib/agentview.js');
const detail = await agentDetail(repo, 'worker', { workspace: 'throwaway' });
const m = detail.memory;
check('the block is there at all', Boolean(m), JSON.stringify(Object.keys(detail)));
check('with the same two keys the ref has', m.notes.keys === 2, JSON.stringify(m.notes));
check('one of which was opened by name', m.notes.opened === 1, JSON.stringify(m.notes));
check('leaving one that never was', m.notes.unread === 1, JSON.stringify(m.notes));
check(
  'a read of a key that is not in the store is not one of them',
  m.notes.reads === 3 && m.notes.opened === 1,
  JSON.stringify(m.notes)
);
// The one tier-2 read this suite made was of *another* agent's store, with `--of`.
// It counts as a read the worker made — it went and looked at something — and it must
// not count as its own key having been opened, which is the confusion that would let a
// busy agent look like it revisits a memory it has never touched.
check(
  'a read of another agent\'s memory is a read, and is not a read of your own key',
  m.memory.writes === 1 && m.memory.reads === 1 && m.memory.opened === 0 && m.memory.unread === 1,
  JSON.stringify(m.memory)
);
// bc-goo.12 gave the worker a repo of its own, so this now asserts the *other* half of
// the rule it was written for: an agent that owns one gets both arms drawn even with no
// runs behind them, and an agent that owns none gets `null` rather than four zeroes that
// would read as a measurement.
check('the worker owns a repo, so tier 3 is both arms rather than null', m.own?.arms?.join() === 'blind,index', JSON.stringify(m.own));
const noRepo = (await import('../lib/agentview.js')).agentDetail;
const consoleDetail = await noRepo(repo, 'console', { workspace: 'throwaway' });
check('and the chat session owns none, so tier 3 is null rather than four zeroes', consoleDetail.memory.own === null, JSON.stringify(consoleDetail.memory.own));

/* ------------------------------------------------- the history is about this one */
//
// Not a memory tier, and it is here because it is the same screen and the same
// question: what has this agent been allowed to become. Every agent's amendments share
// one ref — which is right, because `git log refs/beadcause/foundations` as one story is
// the interesting read — and the tab under an agent's own name was showing all of them.

console.log('\nthe amendment history is about the agent whose tab it is');

const foundation = await import('../lib/foundation.js');
await foundation.amend(repo, 'worker', { purpose: 'the same, said differently' }, { justification: 'because' });
await foundation.decline(repo, 'dispatch', { request: 'allowedTools', reason: 'no' });

const all = await foundation.history(repo, {});
const workerOnly = await foundation.history(repo, { agent: 'worker' });
const dispatchOnly = await foundation.history(repo, { agent: 'dispatch' });
check('the ref itself holds both, as one story', all.length === 2, JSON.stringify(all.map((c) => c.subject)));
check('the worker tab holds only the worker\'s', workerOnly.length === 1 && /^worker: amend/.test(workerOnly[0].subject), JSON.stringify(workerOnly.map((c) => c.subject)));
check('the dispatch tab only the dispatch\'s', dispatchOnly.length === 1 && /^dispatch: decline/.test(dispatchOnly[0].subject), JSON.stringify(dispatchOnly.map((c) => c.subject)));
check(
  'and an agent nobody has amended gets an empty history rather than somebody else\'s',
  (await foundation.history(repo, { agent: 'console' })).length === 0
);
check(
  'the screen asks for the narrowed one',
  (await agentDetail(repo, 'console', { workspace: 'throwaway' })).amendmentHistory.length === 0,
  'a console tab is showing amendments made to another agent'
);

/* ------------------------------------------------------------ tier 3, per arm */

console.log('\ntier 3 reports per agent and never pools');

for (const [agent, arm, run] of [
  ['advocate', 'blind', 'r1'],
  ['advocate', 'index', 'r2'],
  ['scribe', 'blind', 'r3'],
]) {
  agentrepo.record({ run, agent, workspace: 'throwaway', arm, verb: 'session' });
  agentrepo.record({ run, agent, workspace: 'throwaway', arm, verb: 'ls', kind: 'read' });
}
const pooled = agentrepo.summary();
const mine = agentrepo.summary({ agent: 'advocate' });
check('unfiltered, two agents land in the same bucket', pooled.blind.runs === 2, JSON.stringify(pooled.blind));
check('narrowed to one agent, only its runs count', mine.blind.runs === 1, JSON.stringify(mine.blind));
check('and the other arm is its own', mine.index.runs === 1, JSON.stringify(mine.index));
check(
  'a workspace nobody ran in is empty rather than everybody',
  agentrepo.summary({ workspace: 'elsewhere' }).blind.runs === 0,
  JSON.stringify(agentrepo.summary({ workspace: 'elsewhere' }).blind)
);

/* ------------------------------------------------------- and the pane over it */
//
// public/foundations.js is one IIFE over a live DOM, so it cannot be imported. The
// memory tab's rendering is a contiguous region that touches nothing but `$`, `esc`,
// `relTime` and `state`, so the region is sliced out and run with those four stubbed.
// Move the rendering out of it, or rename either marker, and this fails on the slice
// rather than quietly passing against markup the phone no longer draws.

console.log('\nthe pane says what the numbers mean');

const SRC = fs.readFileSync(path.join(ROOT, 'public/foundations.js'), 'utf8');
const START = 'const plural = (n, one, many';
const END = 'This agent owns no repo.';
const from = SRC.indexOf(START);
const to = SRC.indexOf(END, from);
if (from < 0 || to < 0) {
  console.log('  \x1b[31m✗\x1b[0m public/foundations.js no longer has a plural…renderMemory region to slice');
  process.exit(1);
}
const region = SRC.slice(from, SRC.indexOf('\n  }', to) + 4);

const panel = { innerHTML: '' };
const ctx = vm.createContext({
  $: (sel) => (sel === '#tab-memory' ? panel : null),
  esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
  relTime: () => 'an hour ago',
  state: { agent: {} },
});
const { renderMemory } = vm.runInContext(`${region}\n;({ renderMemory })`, ctx, { filename: 'foundations.js#memory' });

const blank = { keys: 0, writes: 0, lastWriteAt: null, reads: 0, listings: 0, opened: 0, unread: 0, lastReadAt: null, sessions: 0 };
const draw = (memoryBlock) => {
  ctx.state.agent = { memory: memoryBlock };
  panel.innerHTML = '';
  renderMemory();
  return panel.innerHTML;
};

const diary = draw({
  workspace: 'throwaway',
  repo,
  notes: { ...blank, keys: 244, writes: 244, lastWriteAt: '2026-08-13T11:09:00Z', unread: 244, ref: 'refs/beadcause/agents/worker' },
  memory: { ...blank },
  bus: { reads: 0, topics: 0, lastReadAt: null },
  debriefs: { reads: 0, lastReadAt: null },
  readByOthers: 0,
  own: null,
});
check('a store written 244 times and never opened says so in words', /write-only diary/.test(diary), diary.slice(0, 400));
check('and the count is on the row', /244 keys/.test(diary), diary.slice(0, 400));
check('an empty store is drawn as empty rather than left out', /Nothing written here yet/.test(diary), diary.slice(0, 800));
check('an agent with no repo of its own is told so', /owns no repo/.test(diary), diary.slice(-400));

const readBack = draw({
  workspace: 'throwaway',
  repo,
  notes: { ...blank, keys: 4, writes: 6, lastWriteAt: '2026-08-13T11:09:00Z', reads: 5, listings: 2, opened: 3, unread: 1, lastReadAt: '2026-08-14T01:00:00Z', sessions: 2, ref: 'r' },
  memory: { ...blank },
  bus: { reads: 2, topics: 1, lastReadAt: '2026-08-14T01:00:00Z' },
  debriefs: { reads: 1, lastReadAt: null },
  readByOthers: 3,
  own: { arms: ['blind', 'index'], summary: { blind: { runs: 1, touched: 1, read: 0, wrote: 1, readFirst: 0, commands: 2 }, index: { runs: 0, touched: 0, read: 0, wrote: 0, readFirst: 0, commands: 0 } } },
});
check('a store that is read back says how much, and how', /Opened 5 times/.test(readBack), readBack.slice(0, 600));
check('the whole-store listings are kept apart from the keys', /2 whole-store listings and 3 of 4 keys/.test(readBack), readBack.slice(0, 600));
check('and what has never been asked for by name is named', /1 key has never been asked/.test(readBack), readBack.slice(0, 600));
check('both arms are drawn even when one has no runs', /pill id">blind/.test(readBack) && /pill id">index/.test(readBack), readBack.slice(-900));
check(
  'and 1-versus-0 says the comparison cannot be computed rather than reading as a result',
  /cannot be computed/.test(readBack),
  readBack.slice(-600)
);

// bc-goo.6: the shape the real log actually has — both arms full, and nothing ever
// written. The `index` arm's subtitle claims the agent was told what is in the repo,
// which is true and empty: it was told it was empty, every time. Two full columns of
// zeroes under that subtitle read as the prediction confirmed, so the pane has to say
// what it is instead.
const untouched = draw({
  workspace: 'throwaway',
  repo,
  notes: { ...blank, ref: 'r' },
  memory: { ...blank },
  bus: { reads: 0, topics: 0, lastReadAt: null },
  debriefs: { reads: 0, lastReadAt: null },
  readByOthers: 0,
  own: {
    arms: ['blind', 'index'],
    summary: {
      blind: { runs: 14, touched: 0, read: 0, wrote: 0, readFirst: 0, commands: 0 },
      index: { runs: 13, touched: 0, read: 0, wrote: 0, readFirst: 0, commands: 0 },
    },
  },
});
check('both arms full and never written to is not drawn as a null result', /never applied/.test(untouched), untouched.slice(-800));
check('…and the index arm stops claiming it was told anything', /only ever been "it is empty"/.test(untouched), untouched.slice(-1400));
check('…and the runs are still drawn, because they happened', /14 runs/.test(untouched) && /13 runs/.test(untouched), untouched.slice(-1400));

/* ------------------------------------------------------------------------ done */

console.log(failures ? `\n${failures} check${failures === 1 ? '' : 's'} failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
