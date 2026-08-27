#!/usr/bin/env node
//
// `ctx:<verdict>` — whether a finished session fitted the window its tier routed it into
// (bc-nc6o.8).
//
//   npm test                        (runs it alongside the rest)
//   node test/sessiontokens.mjs     (on its own, ~2s)
//
// The three parts of this epic before it record *which* model — the tier, the `--model`
// the launcher turned it into, and the ids the transcript shows. This one records how much
// room that model had and whether the hour fitted in it, and every failure worth a suite
// is a way of producing a number that looks right and means nothing:
//
// 1. **Peak occupancy cannot detect an overflow, ever.** The harness compacts *before* the
//    window is exceeded, so a session that ran out of room reads ~90% full and one with
//    plenty to spare reads the same. The verdict must come off the `compact_boundary`
//    event, and a suite that only asserted percentages would pass over an implementation
//    that could never say `over` at all.
// 2. **`manual` is not `auto`.** Somebody typing `/compact` is not the harness running out
//    of room. Counting it as an overflow puts `ctx:over` on the bead of every session
//    anybody tidied by hand — and the occupancy it reports is still real, so the peak must
//    take it while the verdict does not.
// 3. **A subagent's tokens are on the bill and not in the window.** They ride in the same
//    transcript with `isSidechain: true`. Folded into the peak, a session that fanned out
//    to six readers looks like one about to overflow — exactly backwards, since fanning out
//    is how a session *avoids* filling its window.
// 4. **The window is not in the transcript.** `message.model` is `claude-opus-5` for both
//    the 200k model and the 1M variant, so a percentage derived from a turn is a percentage
//    of a number nobody knows. It has to come off the selection the launcher used, and a
//    session whose selection was never recorded must be refused a grade rather than given
//    the default one.
// 5. **A transcript is full of other people's numbers.** Tool output quoting a bill, an
//    agent reasoning aloud about tokens, this file's own source scrolling past a `cat`.
//    Every one of them matches a regex over the raw line.
// 6. **The earlier run must survive the later one, and the ✎ must not be able to lose it.**
//    The two traps `ran:` hit and wrote up, which apply here unchanged — and one more
//    besides: `ctx:over` is the only feedback the tier decision has ever had, so a title
//    edit from a phone that dropped it would send the bead back into the queue rated
//    exactly as badly as the first time.
//
// The last two blocks run the real `archiveSession` against a throwaway git repo and a
// throwaway `$HOME`, and then a real advocate tick — a mapping that is right and a field
// that never reaches `meta.json` or the bead look identical from a unit test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { quiesce, removeTree, removeTreeSync } from './helpers/tmp.mjs';

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-sessiontokens-'));
process.on('exit', () => removeTreeSync(tmp));

// Before lib/sessionlog.js is imported: it resolves `os.homedir()` once, at module load,
// and that is where it looks for transcripts. A suite that skipped this would read the real
// sessions on this laptop.
const HOME = path.join(tmp, 'home');
fs.mkdirSync(path.join(HOME, '.claude', 'projects'), { recursive: true });
process.env.HOME = HOME;
// And the daemon's own advocates.json is not this suite's to read or to write: CONFIG_DIR
// resolves once, at module load, exactly as it does in every other advocate suite here.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const {
  CTX_PREFIX,
  DEFAULT_WINDOW,
  LONG_WINDOW,
  TIGHT_PCT,
  PRESSURES,
  contextWindow,
  usageInTranscript,
  mergeUsage,
  measured,
  pressureOf,
  sessionTokens,
  ctxLabel,
  isCtxLabel,
  ctxLabelsOf,
  pressuresSeen,
  ctxUpdate,
  tokenLine,
} = await import('../lib/sessiontokens.js');

/* ----------------------------------------------------------------- the window */

console.log('the window a selection bought');

check('the ordinary selection is 200k', contextWindow('sonnet') === DEFAULT_WINDOW && contextWindow('opus') === DEFAULT_WINDOW);
check(
  'and the long variant is a million, in every spelling of it',
  contextWindow('opus[1m]') === LONG_WINDOW &&
    contextWindow('claude-opus-5[1m]') === LONG_WINDOW &&
    contextWindow('claude-sonnet-5[1M]') === LONG_WINDOW,
  `${contextWindow('opus[1m]')} ${contextWindow('claude-sonnet-5[1M]')}`
);
check(
  'a selection nobody recorded has no window — not the default one',
  contextWindow('') === null && contextWindow(null) === null && contextWindow(undefined) === null,
  String(contextWindow(null))
);
// The whole of trap 4, stated as an assertion: the two selections differ by a marker the
// transcript never carries, so the id off a turn cannot be substituted for the selection.
check(
  'the id a turn carries reads as 200k, which is why the selection is what is asked',
  contextWindow('claude-opus-5') === DEFAULT_WINDOW && contextWindow('claude-opus-5[1m]') === LONG_WINDOW
);
check(
  'and a date in an id is not a window — `1m` has to be its own token',
  contextWindow('claude-haiku-4-5-20251001') === DEFAULT_WINDOW &&
    contextWindow('claude-sonnet-4-5-20251m99') === DEFAULT_WINDOW,
  String(contextWindow('claude-sonnet-4-5-20251m99'))
);
check('while every real spelling of it still is', contextWindow('sonnet-1m') === LONG_WINDOW && contextWindow('1m') === LONG_WINDOW);

/* ------------------------------------------------------- reading a transcript */

console.log('reading a transcript');

/** One JSONL line per entry, the way Claude Code writes it. */
const jsonl = (events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

/** An assistant turn whose usage says the context was this full. */
const turn = (context, output = 100, extra = {}) => ({
  type: 'assistant',
  message: {
    model: 'claude-sonnet-5',
    content: [],
    usage: {
      input_tokens: 2,
      cache_read_input_tokens: context - 2,
      cache_creation_input_tokens: 0,
      output_tokens: output,
    },
  },
  ...extra,
});

/** The event the harness writes when it compacts. */
const boundary = (trigger, preTokens, dropped = preTokens) => ({
  type: 'system',
  subtype: 'compact_boundary',
  content: 'Conversation compacted',
  compactMetadata: { trigger, preTokens, postTokens: 11115, cumulativeDroppedTokens: dropped },
});

const simple = jsonl([
  { type: 'mode', mode: 'normal' },
  { type: 'user', message: { role: 'user', content: 'go' } },
  turn(20_000, 500),
  turn(60_000, 700),
  turn(41_000, 300),
]);
const plain = usageInTranscript(simple);
check('the turns are counted', plain.turns === 3, JSON.stringify(plain));
check('the output is summed', plain.output === 1500, String(plain.output));
check(
  'the peak is the largest single turn, not the last and not the total',
  plain.peakContext === 60_000,
  String(plain.peakContext)
);
check('and the cache reads are summed, because those are the bill', plain.cacheRead === 20_000 - 2 + 60_000 - 2 + 41_000 - 2, String(plain.cacheRead));

// Trap 5. Every number here is somebody else's, and one of them is a `usage` block quoted
// verbatim inside a tool result — the shape a regex over the raw line cannot tell from the
// real thing.
const trapped = jsonl([
  {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          content: 'peak was {"usage":{"input_tokens":999999,"cache_read_input_tokens":888888,"output_tokens":7}}',
        },
      ],
    },
  },
  { type: 'user', message: { role: 'user', content: 'how many input_tokens did that cost?' } },
  turn(30_000, 40),
]);
const trap = usageInTranscript(trapped);
check(
  'a usage block quoted in tool output is not a turn',
  trap.turns === 1 && trap.peakContext === 30_000 && trap.output === 40,
  JSON.stringify(trap)
);

// Trap 3.
const fannedOut = jsonl([
  turn(30_000, 100),
  turn(180_000, 100, { isSidechain: true }),
  turn(35_000, 100),
]);
const fan = usageInTranscript(fannedOut);
check(
  "a subagent's turn does not raise the peak — it is spent in its own window",
  fan.peakContext === 35_000,
  String(fan.peakContext)
);
check('but it is still on the bill', fan.cacheRead > 180_000 && fan.sidechainTurns === 1, JSON.stringify(fan));
check('and it is counted apart, so a reader is never told it was in the window', fan.turns === 2, String(fan.turns));

// Trap 1 and trap 2.
const overflowed = usageInTranscript(jsonl([turn(150_000), boundary('auto', 186_400, 175_000), turn(30_000)]));
check('an auto boundary is counted as one', overflowed.autoCompactions === 1 && overflowed.compactions === 1, JSON.stringify(overflowed));
check(
  "and its own occupancy reading raises the peak above any turn's",
  overflowed.peakContext === 186_400,
  String(overflowed.peakContext)
);
check('what it had to drop is kept', overflowed.droppedTokens === 175_000, String(overflowed.droppedTokens));

const byHand = usageInTranscript(jsonl([turn(120_000), boundary('manual', 220_833, 209_718), turn(11_000)]));
check('a hand-typed compaction is a compaction', byHand.compactions === 1, JSON.stringify(byHand));
check('and is NOT an overflow', byHand.autoCompactions === 0, String(byHand.autoCompactions));
check('while the occupancy it measured is still real', byHand.peakContext === 220_833, String(byHand.peakContext));

check('an empty transcript answers zeroes and does not throw', usageInTranscript('').turns === 0 && usageInTranscript(null).turns === 0);
check('and a half-written last line is skipped, not thrown over', usageInTranscript(simple + '{"type":"assist').turns === 3);
check('a turn with no usage at all is not a measurable turn', usageInTranscript(jsonl([{ type: 'assistant', message: { model: 'claude-opus-5', content: [] } }])).turns === 0);

/* ------------------------------------------------------------- two transcripts */

console.log('a session that entered a worktree');

const first = usageInTranscript(jsonl([turn(40_000, 100)]));
const second = usageInTranscript(jsonl([turn(90_000, 200), boundary('auto', 190_000, 120_000)]));
const both = mergeUsage(first, second);
check('the turns and the tokens sum', both.turns === 2 && both.output === 300, JSON.stringify(both));
check('the peak is a maximum over both halves, not a sum', both.peakContext === 190_000, String(both.peakContext));
check('and the cumulative drop is a maximum too, since it is already cumulative', both.droppedTokens === 120_000, String(both.droppedTokens));
check('merging nothing into nothing is measurable-as-nothing', !measured(mergeUsage(null, null)));

/* ------------------------------------------------------------------ the verdict */

console.log('grading the run');

check('the vocabulary is three, roomiest first', JSON.stringify(PRESSURES) === '["fit","tight","over"]');

const comfortable = usageInTranscript(jsonl([turn(40_000)]));
const nearly = usageInTranscript(jsonl([turn(Math.round(DEFAULT_WINDOW * 0.94))]));
check('a session with room to spare fitted', pressureOf(comfortable, DEFAULT_WINDOW) === 'fit');
check('one that got close fitted, tightly', pressureOf(nearly, DEFAULT_WINDOW) === 'tight');
check(
  'the threshold is where it says it is',
  pressureOf(usageInTranscript(jsonl([turn((DEFAULT_WINDOW * TIGHT_PCT) / 100)])), DEFAULT_WINDOW) === 'tight' &&
    pressureOf(usageInTranscript(jsonl([turn((DEFAULT_WINDOW * TIGHT_PCT) / 100 - 1000)])), DEFAULT_WINDOW) === 'fit'
);
check('and the same occupancy in the long window is nothing at all', pressureOf(nearly, LONG_WINDOW) === 'fit');
check('an auto-compaction is over, whatever the peak read', pressureOf(overflowed, DEFAULT_WINDOW) === 'over');
check(
  'and it survives a window nobody recorded, because it is a fact rather than a ratio',
  pressureOf(overflowed, null) === 'over',
  pressureOf(overflowed, null)
);
// Trap 4's other half: `fit` is a claim about a limit, so an unknown limit forbids it.
check(
  'a measured run with no window is refused a grade rather than told it fitted',
  pressureOf(comfortable, null) === '' && pressureOf(comfortable, 0) === '',
  `${pressureOf(comfortable, null)}/${pressureOf(comfortable, 0)}`
);
check('a run with nothing measurable is graded nothing', pressureOf(usageInTranscript(''), DEFAULT_WINDOW) === '');
check('and a hand-compacted one is graded on its occupancy, not on the compaction', pressureOf(byHand, LONG_WINDOW) === 'fit' && pressureOf(byHand, DEFAULT_WINDOW) === 'tight');

const record = sessionTokens(overflowed, 'sonnet');
check('the record carries the window it was graded against', record.limit === DEFAULT_WINDOW, JSON.stringify(record.limit));
check('and the share of it that was reached', record.peakPct === 93.2, String(record.peakPct));
check('and the verdict, so nothing downstream has to re-derive it', record.pressure === 'over');
check(
  'a run that left nothing measurable is null, not a record of zeroes',
  sessionTokens(usageInTranscript(''), 'sonnet') === null,
  JSON.stringify(sessionTokens(usageInTranscript(''), 'sonnet'))
);
check(
  'a record with no window has no percentage rather than a misleading one',
  sessionTokens(comfortable, null).peakPct === null && sessionTokens(comfortable, null).limit === null
);
check(
  'the one line reads as a sentence',
  tokenLine(record) === '186k of 200k · 93.2% · auto-compacted once',
  tokenLine(record)
);
check('and there is nothing to say about a run that left nothing', tokenLine(null) === '');

/* ------------------------------------------------------------------- the label */

console.log('the label');

check('the prefix has one spelling', CTX_PREFIX === 'ctx:' && ctxLabel('over') === 'ctx:over');
check('every verdict makes one', PRESSURES.every((p) => ctxLabel(p) === `ctx:${p}`));
check('and nothing else does — never a bare "ctx:"', ctxLabel('') === '' && ctxLabel('huge') === '' && ctxLabel(null) === '');
check('ours is recognisable', isCtxLabel('ctx:over') && isCtxLabel('CTX:fit'));
check('and nothing else is', !isCtxLabel('complexity:high') && !isCtxLabel('context') && !isCtxLabel(''));

const worked = { labels: ['dispatch', 'ctx:fit', 'complexity:low', 'ctx:over', 'ran:sonnet'] };
check('the ctx labels come off a bead and nothing else does', ctxLabelsOf(worked).join(',') === 'ctx:fit,ctx:over', JSON.stringify(ctxLabelsOf(worked)));
check('as verdicts', pressuresSeen(worked).join(',') === 'fit,over', JSON.stringify(pressuresSeen(worked)));
check('a bead nothing has measured has no verdict — which is not the same as fitting', pressuresSeen({ labels: ['dispatch'] }).length === 0);
check('and neither has no bead at all', pressuresSeen(null).length === 0);

// Trap 6, first half.
check('a first run writes its verdict', JSON.stringify(ctxUpdate({ labels: ['dispatch'] }, 'over').addLabels) === '["ctx:over"]');
check('the same verdict a second time writes nothing', ctxUpdate({ labels: ['ctx:over'] }, 'over').addLabels.length === 0);
check(
  'and a later run that went differently keeps both — the work grew and the tier did not',
  JSON.stringify(ctxUpdate({ labels: ['ctx:fit'] }, 'over').addLabels) === '["ctx:over"]',
  JSON.stringify(ctxUpdate({ labels: ['ctx:fit'] }, 'over').addLabels)
);
check('a run with no verdict writes nothing rather than a placeholder', ctxUpdate({ labels: [] }, '').addLabels.length === 0);
check('and neither does one whose verdict is not one', ctxUpdate({ labels: [] }, 'enormous').addLabels.length === 0);

/* ------------------------------------------------------- the ✎ cannot lose it */

console.log('an adjust from the phone');

const { isProtectedLabel, updateFor, normalizeEdits } = await import('../lib/verdict.js');

check('a ctx label is protected', isProtectedLabel('ctx:over') && isProtectedLabel('ctx:fit'));
check(
  'the tier beside it is deliberately NOT — that one is a claim, and the ✎ is where it is corrected',
  !isProtectedLabel('complexity:high')
);

// The exact shape of the trap: the sheet posts the labels it is showing, and a `ctx:` chip
// is not one anybody typed, so it is missing from the patch.
const row = { id: 'bc-x1', labels: ['dispatch', 'ctx:over', 'complexity:medium'] };
const edits = normalizeEdits({ title: 'a better title', labels: ['dispatch', 'complexity:medium'] }, ['title', 'labels']);
check(
  'saving a title from the phone does not take the only feedback the tier has off the bead',
  !(updateFor(row, edits).update.removeLabels || []).includes('ctx:over'),
  JSON.stringify(updateFor(row, edits).update)
);
check(
  'and a ctx label cannot be set from there either',
  !normalizeEdits({ labels: ['ctx:fit'] }, ['labels']).labels.includes('ctx:fit'),
  JSON.stringify(normalizeEdits({ labels: ['ctx:fit'] }, ['labels']))
);

const { daemonOnly } = await import('../lib/proposedlabels.js');
check(
  'nor stated by a bead being proposed, which has never run',
  Boolean(daemonOnly('ctx:over')),
  String(daemonOnly('ctx:over'))
);
check('while the tier it should have used instead is still statable', daemonOnly('complexity:high') === null);

/* ------------------------------------------------------------------- the card */

console.log('on the card');

const { modelCard } = await import('../lib/modelcard.js');
check(
  'the sheet is handed the verdicts, derived once on the daemon',
  JSON.stringify(modelCard({ labels: ['complexity:low', 'ran:sonnet', 'ctx:over'] }).pressures) === '["over"]',
  JSON.stringify(modelCard({ labels: ['complexity:low', 'ran:sonnet', 'ctx:over'] }))
);
check(
  'and a bead nothing has measured is handed an empty list, not a reassurance',
  JSON.stringify(modelCard({ labels: ['complexity:low'] }).pressures) === '[]'
);

/* ---------------------------------------------------------------- end to end */

console.log('through the real archive');

const sessionlog = await import('../lib/sessionlog.js');

const dir = path.join(tmp, 'repo');
fs.mkdirSync(dir, { recursive: true });
const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'test@localhost');
git('config', 'user.name', 'test');
git('commit', '-q', '--allow-empty', '-m', 'root');

/** A transcript on disk, where `findTranscripts` looks — under the fake `$HOME`. */
function transcript(sessionId, text, where = '-tmp-somewhere') {
  const slug = path.join(HOME, '.claude', 'projects', where);
  fs.mkdirSync(slug, { recursive: true });
  fs.writeFileSync(path.join(slug, `${sessionId}.jsonl`), text);
}

const metaOf = (ref) => JSON.parse(execFileSync('git', ['-C', dir, 'cat-file', '-p', `${ref}:meta.json`], { encoding: 'utf8' }));

transcript('sess-over-000001', jsonl([turn(150_000), boundary('auto', 186_400, 175_000), turn(30_000)]));
const over = await sessionlog.archiveSession(dir, {
  workspace: 'test',
  bead: 'bc-ctx1',
  sessionId: 'sess-over-000001',
  outcome: 'ended',
  model: 'sonnet',
  tier: 'medium',
});
const overMeta = metaOf(over.ref);
check('meta.json records what the hour cost', overMeta.tokens?.turns === 2 && overMeta.tokens.output === 200, JSON.stringify(overMeta.tokens));
check('and the window its tier routed it into', overMeta.tokens?.limit === DEFAULT_WINDOW, String(overMeta.tokens?.limit));
check('and that it did not fit', overMeta.tokens?.pressure === 'over' && overMeta.tokens.autoCompactions === 1, JSON.stringify(overMeta.tokens?.pressure));
check('the archive hands the verdict back to whoever writes the bead', over.tokens?.pressure === 'over', JSON.stringify(over.tokens?.pressure));

// The same session, had it been opened on the long window. Nothing about the transcript
// changes — which is the whole of trap 4, end to end: the grade is a fact about the
// selection, and the file cannot tell you which one was made.
transcript('sess-roomy-000002', jsonl([turn(150_000), turn(30_000)]));
const roomy = await sessionlog.archiveSession(dir, {
  workspace: 'test',
  bead: 'bc-ctx2',
  sessionId: 'sess-roomy-000002',
  outcome: 'ended',
  model: 'opus[1m]',
  tier: 'high',
});
check('the long window grades the same occupancy as comfortable', metaOf(roomy.ref).tokens?.pressure === 'fit', JSON.stringify(metaOf(roomy.ref).tokens));
check('and says which window that was', metaOf(roomy.ref).tokens?.limit === LONG_WINDOW, String(metaOf(roomy.ref).tokens?.limit));

const tightRun = await (async () => {
  transcript('sess-tight-000003', jsonl([turn(Math.round(DEFAULT_WINDOW * 0.94))]));
  return sessionlog.archiveSession(dir, {
    workspace: 'test',
    bead: 'bc-ctx3',
    sessionId: 'sess-tight-000003',
    outcome: 'ended',
    model: 'sonnet',
    tier: 'low',
  });
})();
check('a session that fitted with nothing to spare says so', metaOf(tightRun.ref).tokens?.pressure === 'tight', JSON.stringify(metaOf(tightRun.ref).tokens?.pressure));

const gone = await sessionlog.archiveSession(dir, {
  workspace: 'test',
  bead: 'bc-ctx4',
  sessionId: 'sess-vanished-04',
  outcome: 'ended',
  model: 'sonnet',
});
check('a session whose transcript is gone records null rather than a record of zeroes', metaOf(gone.ref).tokens === null, JSON.stringify(metaOf(gone.ref).tokens));

// Trap 1, one more time, through the file this time: a session long enough to blow the 4MB
// rendering cap is the session most likely to have run out of window, so the cap must not
// take the cost with it.
const filler = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'x'.repeat(700) }] } };
transcript(
  'sess-long-000005',
  jsonl([turn(50_000), ...Array.from({ length: 7500 }, () => filler), boundary('auto', 191_000, 160_000)])
);
const long = await sessionlog.archiveSession(dir, {
  workspace: 'test',
  bead: 'bc-ctx5',
  sessionId: 'sess-long-000005',
  outcome: 'ended',
  model: 'sonnet',
});
check(
  'a log truncated at 4MB still reports that the session ran out of context',
  metaOf(long.ref).tokens?.pressure === 'over',
  JSON.stringify(metaOf(long.ref).tokens)
);

// A session that entered a worktree, which is two files under two project slugs.
transcript('sess-split-000006', jsonl([turn(40_000, 100)]), '-tmp-somewhere');
transcript('sess-split-000006', jsonl([turn(120_000, 200)]), '-tmp-somewhere-else');
const split = await sessionlog.archiveSession(dir, {
  workspace: 'test',
  bead: 'bc-ctx6',
  sessionId: 'sess-split-000006',
  outcome: 'ended',
  model: 'sonnet',
});
check(
  'both halves of one conversation are one cost',
  metaOf(split.ref).tokens?.turns === 2 && metaOf(split.ref).tokens.peakContext === 120_000,
  JSON.stringify(metaOf(split.ref).tokens)
);

check(
  'ranFactsOf answers the same thing without archiving anything',
  sessionlog.ranFactsOf('sess-over-000001').usage.autoCompactions === 1,
  JSON.stringify(sessionlog.ranFactsOf('sess-over-000001').usage)
);
check('and answers an unmeasurable nothing for a session id nothing wrote', !measured(sessionlog.ranFactsOf('sess-nothing-0000').usage));
check('and for no session id at all', !measured(sessionlog.ranFactsOf(null).usage));
check('while ranModelsOf still answers exactly what it did before', sessionlog.ranModelsOf('sess-over-000001').join(',') === 'claude-sonnet-5');

/* ---------------------------------------------------------- onto the real bead */

console.log('through a real advocate tick');

/**
 * The wiring, which is the half a unit test cannot see: a window ends, and the verdict
 * appears on the bead. Same fixture shape as test/ranmodel.mjs — a fake `bd` that is a
 * small mutable world, `open`/`openPlan` injected so nothing reaches iTerm — with the three
 * cases that take different routes to the same answer.
 */
const { createAdvocates } = await import('../lib/advocate.js');

async function tick({ sessionLog, workerDir = dir, sessionId = 'sess-over-000001' }) {
  const cfgDir = process.env.BEADCAUSE_CONFIG_DIR;
  // `quiesce` + `removeTree` rather than a bare recursive `rmSync`: every write of
  // `advocates.json` schedules a common-repo commit 2000ms out whose `git init` lands in
  // `CONFIG_DIR`, and rmdir on a directory that gained a file since it was read is
  // ENOTEMPTY. test/tmpadoption.mjs fails the repo for the bare form (bc-9d37.9).
  await quiesce();
  for (const f of fs.readdirSync(cfgDir)) await removeTree(path.join(cfgDir, f));

  const cfg = {
    projectRoot: path.join(tmp, 'projects'),
    fallbackWorkspace: 'other',
    claudeSessionsDir: path.join(tmp, 'claude-sessions'),
    spaces: [],
    // No `gh`, in either direction: with it off nothing shells out, and with it on a
    // machine that happens to be authenticated would run real queries against a temp repo.
    pr: { enabled: false },
    workspaces: [{ name: 'alpha', dir: path.join(tmp, 'beads', 'alpha', '.beads') }],
    sessionDirs: { alpha: dir },
    advocates: {
      enabled: true,
      workspaces: '*',
      maxWorkers: 5,
      maxWorkersLimit: 5,
      settleSeconds: 0,
      launchCooldownSeconds: 0,
      sessionLog,
      // Everything with a suite of its own, which would otherwise run `gh` or a real agent
      // against a temp directory on every case here.
      propose: false,
      tidyWorktrees: false,
      respectQuietHours: false,
      reconcileLanded: false,
      askSuperseded: false,
      flagInMain: false,
    },
  };
  fs.mkdirSync(cfg.claudeSessionsDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify(cfg, null, 2));
  // A worker whose window is gone — `at` is old, so `reconcile` times the slot out and the
  // session reaches `finish`, which is the one door everything here is behind.
  fs.writeFileSync(
    path.join(cfgDir, 'advocates.json'),
    JSON.stringify({
      alpha: {
        workers: [
          { id: 'x-1', title: 'x-1', at: '2020-01-01T00:00:00Z', attempt: 1, sessionId, dir: workerDir, model: 'sonnet', tier: 'medium' },
        ],
        attempts: {},
      },
    })
  );

  const row = { id: 'x-1', title: 'x-1', priority: 2, issue_type: 'task', status: 'in_progress', labels: ['dispatch'], created_at: '2020-01-01T00:00:00Z' };
  const added = [];
  const bd = {
    ready: async () => [],
    listLabel: async () => [],
    listStatus: async () => [],
    show: async (_ws, id) => (id === 'x-1' ? row : null),
    children: async () => [],
    comments: async () => [],
    create: async () => 'new-1',
    addLabel: async (_ws, id, labelName) => {
      added.push(`${id} ${labelName}`);
      row.labels.push(labelName);
    },
    reopen: async () => {},
  };

  const advocates = createAdvocates(cfg, {
    bd,
    bus: { emit() {} },
    open: async () => {
      throw new Error('this suite must never open a window');
    },
    openPlan: async () => {
      throw new Error('this suite must never open a window');
    },
  });
  await advocates.tick();
  return { added, row };
}

const logged = await tick({ sessionLog: true });
check(
  'a finished window puts the verdict on its bead, beside what it ran on',
  logged.added.join(' | ') === 'x-1 ran:sonnet | x-1 ctx:over',
  JSON.stringify(logged.added)
);

const unlogged = await tick({ sessionLog: false });
check(
  'and does so even where this workspace keeps no session log at all',
  unlogged.added.join(' | ') === 'x-1 ran:sonnet | x-1 ctx:over',
  JSON.stringify(unlogged.added)
);

const broken = await tick({ sessionLog: true, workerDir: path.join(tmp, 'not-a-repo') });
check(
  'an archive that fails still leaves the verdict on the bead — that is when it matters most',
  broken.added.join(' | ') === 'x-1 ran:sonnet | x-1 ctx:over',
  JSON.stringify(broken.added)
);

const unmeasured = await tick({ sessionLog: true, sessionId: 'sess-vanished-04' });
check(
  'and a window that left no transcript writes no verdict rather than guessing at one',
  unmeasured.added.length === 0,
  JSON.stringify(unmeasured.added)
);

console.log(failures ? `\n${failures} failed` : '\nall good');
process.exit(failures ? 1 : 0);
