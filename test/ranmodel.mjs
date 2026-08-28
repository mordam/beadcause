#!/usr/bin/env node
//
// `ran:<model>` — what a finished session was actually billed to (bc-nc6o.3).
//
//   npm test                     (runs it alongside the rest)
//   node test/ranmodel.mjs       (on its own, ~1s)
//
// The two halves before this one record a *plan*: the bead's tier, and the `--model` the
// launcher turned it into. This one records the outcome, and the failures worth a suite
// are the ones where the outcome and the plan quietly agree when they shouldn't:
//
// 1. **A transcript is full of other people's model names.** Tool output quoting a docs
//    page, a `grep` for the word, an agent reasoning aloud about which one to use — every
//    one of them matches a regex over the raw line, and one of them is the source file
//    this suite tests. So the scan is asserted against a transcript that contains exactly
//    that trap, and must still answer with the one model an assistant turn was on.
// 2. **`<synthetic>` is a real model id in a real transcript and names no model.** Claude
//    Code stamps it on messages it composed itself — an interrupt, a cancelled turn. Left
//    in, every session anybody pressed escape in labels its bead with a model that does
//    not exist.
// 3. **The earlier run must survive the later one.** That is the acceptance in one line,
//    and the way to break it is an ordinary set-shaped write: labels computed as "what
//    this run used" rather than "what this run used, added to what was there".
// 4. **The ✎ must not be able to lose it.** The trap bc-nc6o.1 hit with `complexity:` and
//    wrote up: adjusting a bead's title from a phone posts the label set the card is
//    showing, and every label not in it is removed. A `ran:` label is not a chip anybody
//    types, so without `isProtectedLabel` an unrelated edit deletes the only record of
//    what an unattended hour cost.
// 5. **Truncating the log must not truncate the models.** A session long enough to blow
//    the 4MB rendering cap is exactly the session somebody changed model in.
//
// The last block runs the real `archiveSession` against a throwaway git repo and a
// throwaway `$HOME`, and reads `meta.json` back out of the ref — a mapping that is right
// and a field that never reaches the archive look identical from a unit test.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-ranmodel-'));
process.on('exit', () => removeTreeSync(tmp));

// Before lib/sessionlog.js is imported: it resolves `os.homedir()` once, at module load,
// and that is where it looks for transcripts. A suite that skipped this would read the
// real sessions on this laptop.
const HOME = path.join(tmp, 'home');
fs.mkdirSync(path.join(HOME, '.claude', 'projects'), { recursive: true });
process.env.HOME = HOME;
// And the daemon's own advocates.json is not this suite's to read or to write: CONFIG_DIR
// resolves once, at module load, exactly as it does in every other advocate suite here.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const {
  RAN_PREFIX,
  modelFamily,
  ranToken,
  ranLabel,
  isRanLabel,
  ranLabelsOf,
  modelsRan,
  modelsInTranscript,
  ranUpdate,
  ranDiverged,
} = await import('../lib/ranmodel.js');

/* ------------------------------------------------------------- the vocabulary */

console.log('reading a model id');

check('the current ids place by family', modelFamily('claude-opus-5') === 'opus');
check('and so do the other two', modelFamily('claude-sonnet-5') === 'sonnet' && modelFamily('claude-haiku-4-5-20251001') === 'haiku');
check(
  'the older shape, where the family is in the middle',
  modelFamily('claude-3-5-sonnet-20241022') === 'sonnet',
  modelFamily('claude-3-5-sonnet-20241022')
);
check(
  'and a hosted id, where a whole vendor path is in front of it',
  modelFamily('us.anthropic.claude-opus-4-20250514-v1:0') === 'opus'
);
check('an alias is already the answer', modelFamily('opus') === 'opus');
check('<synthetic> names no model', modelFamily('<synthetic>') === '');
check('nor does nothing at all', modelFamily('') === '' && modelFamily(null) === '' && modelFamily(undefined) === '');
check('an id from a family this file has never heard of places as none', modelFamily('claude-quartz-9') === '');

check('the label is the family', ranLabel('claude-opus-5') === 'ran:opus', ranLabel('claude-opus-5'));
check('the prefix has one spelling', RAN_PREFIX === 'ran:' && ranLabel('sonnet').startsWith(RAN_PREFIX));
check(
  'an id naming no family is kept verbatim rather than dropped',
  ranLabel('claude-quartz-9') === 'ran:claude-quartz-9',
  ranLabel('claude-quartz-9')
);
check(
  'and one carrying characters a label cannot is folded, not lost',
  ranLabel('Claude Quartz 9 (preview)') === 'ran:claude-quartz-9-preview',
  ranLabel('Claude Quartz 9 (preview)')
);
check('a model that is not one makes no label at all — never a bare "ran:"', ranLabel('<synthetic>') === '' && ranLabel('') === '');
check('and the token behind it agrees', ranToken('<synthetic>') === '' && ranToken('claude-sonnet-5') === 'sonnet');

console.log('a [1m] selection is a distinct label (bc-nc6o.14)');

check(
  'the family is unaffected by the bracket — it is a window, not a different model',
  modelFamily('claude-opus-5[1m]') === 'opus' && modelFamily('sonnet[1m]') === 'sonnet'
);
check(
  'longWindow widens the token rather than replacing it',
  ranToken('claude-opus-5', { longWindow: true }) === 'opus-1m',
  ranToken('claude-opus-5', { longWindow: true })
);
check(
  'and the default is unchanged — nothing calls this yet without knowing the window',
  ranToken('claude-opus-5') === 'opus'
);
check(
  'so is the label',
  ranLabel('claude-opus-5', { longWindow: true }) === 'ran:opus-1m' && ranLabel('claude-opus-5') === 'ran:opus'
);
check(
  'a model naming no family still gets the suffix — it is a fact about the window, not the family',
  ranLabel('claude-quartz-9', { longWindow: true }) === 'ran:claude-quartz-9-1m',
  ranLabel('claude-quartz-9', { longWindow: true })
);
check('and a model that is not one still makes no label at all', ranLabel('<synthetic>', { longWindow: true }) === '');
check(
  'ranUpdate threads it through to every model in the run',
  JSON.stringify(ranUpdate({ labels: [] }, ['claude-sonnet-5', 'claude-opus-5'], { longWindow: true }).addLabels) ===
    '["ran:sonnet-1m","ran:opus-1m"]',
  JSON.stringify(ranUpdate({ labels: [] }, ['claude-sonnet-5', 'claude-opus-5'], { longWindow: true }).addLabels)
);
check(
  'a bead already carrying the 200k label still gets the 1m one — they are different labels',
  JSON.stringify(ranUpdate({ labels: ['ran:opus'] }, ['claude-opus-5'], { longWindow: true }).addLabels) === '["ran:opus-1m"]'
);
check(
  'and the reverse — already 1m, then a 200k run — adds the other',
  JSON.stringify(ranUpdate({ labels: ['ran:opus-1m'] }, ['claude-opus-5']).addLabels) === '["ran:opus"]'
);

check('ours is recognisable', isRanLabel('ran:opus') && isRanLabel('RAN:opus'));
check('and nothing else is', !isRanLabel('complexity:high') && !isRanLabel('running') && !isRanLabel(''));

const worked = { labels: ['dispatch', 'ran:sonnet', 'complexity:low', 'ran:opus'] };
check('the ran labels come off a bead and nothing else does', ranLabelsOf(worked).join(',') === 'ran:sonnet,ran:opus', JSON.stringify(ranLabelsOf(worked)));
check('as models', modelsRan(worked).join(',') === 'sonnet,opus', JSON.stringify(modelsRan(worked)));
check('a bead nothing has finished on has run on nothing', modelsRan({ labels: ['dispatch'] }).length === 0);
check('and neither has no bead at all', modelsRan(null).length === 0);

/* ------------------------------------------------------------- reading a transcript */

console.log('reading a transcript');

/** One JSONL line per entry, the way Claude Code writes it. */
const jsonl = (events) => events.map((e) => JSON.stringify(e)) .join('\n') + '\n';

const plain = jsonl([
  { type: 'mode', mode: 'normal' },
  { type: 'user', message: { role: 'user', content: 'go' } },
  { type: 'assistant', message: { model: 'claude-opus-5', content: [] } },
  { type: 'assistant', message: { model: 'claude-opus-5', content: [] } },
]);
check('one model, said once', modelsInTranscript(plain).join(',') === 'claude-opus-5', JSON.stringify(modelsInTranscript(plain)));

// The trap. Every one of these lines contains the literal text a regex would match, and
// not one of them is an assistant turn on that model.
const trapped = jsonl([
  { type: 'user', message: { role: 'user', content: 'which "model":"claude-sonnet-5" should I use?' } },
  {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', content: 'lib/complexity.js:  MODEL_BY_TIER = { low: "sonnet" }\n"model":"claude-haiku-4-5"' }],
    },
  },
  { type: 'assistant', message: { model: 'claude-opus-5', content: [] } },
  { type: 'summary', summary: 'ran on claude-sonnet-5' },
]);
check(
  'a model quoted in tool output or a prompt is not a model that ran',
  modelsInTranscript(trapped).join(',') === 'claude-opus-5',
  JSON.stringify(modelsInTranscript(trapped))
);

const synthetic = jsonl([
  { type: 'assistant', message: { model: 'claude-sonnet-5', content: [] } },
  { type: 'assistant', message: { model: '<synthetic>', content: [] } },
]);
check(
  '<synthetic> is skipped rather than labelled',
  modelsInTranscript(synthetic).join(',') === 'claude-sonnet-5',
  JSON.stringify(modelsInTranscript(synthetic))
);

const moved = jsonl([
  { type: 'assistant', message: { model: 'claude-sonnet-5', content: [] } },
  { type: 'assistant', message: { model: 'claude-opus-5', content: [] } },
  { type: 'assistant', message: { model: 'claude-opus-5', content: [] } },
]);
check(
  'a session somebody typed /model in yields both, first seen first',
  modelsInTranscript(moved).join(',') === 'claude-sonnet-5,claude-opus-5',
  JSON.stringify(modelsInTranscript(moved))
);

check(
  'a half-written last line is the normal state of a file being appended to',
  modelsInTranscript(plain + '{"type":"assist').join(',') === 'claude-opus-5'
);
check('an empty transcript answers nothing, and does not throw', modelsInTranscript('').length === 0 && modelsInTranscript(null).length === 0);

/* ------------------------------------------------------------- what goes on the bead */

console.log('writing it onto the bead');

check(
  'a first run adds its label',
  JSON.stringify(ranUpdate({ labels: ['dispatch'] }, ['claude-opus-5']).addLabels) === '["ran:opus"]'
);
check(
  'the same model a second time adds nothing — no no-op edit in the bead history',
  ranUpdate({ labels: ['dispatch', 'ran:opus'] }, ['claude-opus-5']).addLabels.length === 0
);
check(
  'A BEAD WORKED TWICE ON DIFFERENT MODELS KEEPS BOTH',
  JSON.stringify(ranUpdate({ labels: ['ran:sonnet'] }, ['claude-opus-5']).addLabels) === '["ran:opus"]'
);
check(
  'a session that moved model mid-run adds both at once',
  JSON.stringify(ranUpdate({ labels: [] }, ['claude-sonnet-5', 'claude-opus-5']).addLabels) === '["ran:sonnet","ran:opus"]'
);
check(
  'two ids from one family are one label',
  JSON.stringify(ranUpdate({ labels: [] }, ['claude-opus-5', 'claude-opus-4-1']).addLabels) === '["ran:opus"]'
);
check('nothing observed is nothing written', ranUpdate({ labels: [] }, []).addLabels.length === 0);
check('and a model that is not one writes no bare prefix', ranUpdate({ labels: [] }, ['<synthetic>']).addLabels.length === 0);

console.log('did it go where it was sent');

check('routed sonnet, ran opus', ranDiverged('sonnet', ['claude-opus-5']) === true);
check('routed opus, ran opus', ranDiverged('opus', ['claude-opus-5']) === false);
check('routed opus, ran a point release of opus', ranDiverged('opus', ['claude-opus-4-1-20250805']) === false);
check(
  'a session that started where it was sent and moved has not diverged',
  ranDiverged('sonnet', ['claude-sonnet-5', 'claude-opus-5']) === false
);
check('a window nobody routed has diverged from nothing', ranDiverged(null, ['claude-opus-5']) === false);
check('and neither has a session that left no transcript', ranDiverged('opus', []) === false);

/* ------------------------------------------------------------- the ✎ cannot lose it */

console.log('an adjust from the phone');

const { isProtectedLabel, updateFor, normalizeEdits } = await import('../lib/verdict.js');

check('a ran label is protected', isProtectedLabel('ran:opus'));
check(
  'the tier is deliberately NOT — that one is a claim, and the ✎ is where it is corrected',
  !isProtectedLabel('complexity:high')
);

// The exact shape of the trap: the sheet posts the labels it is showing, and a `ran:`
// chip is not one anybody typed, so it is missing from the patch.
const row = { id: 'bc-x1', labels: ['dispatch', 'ran:opus', 'complexity:low'] };
const edits = normalizeEdits({ title: 'a better title', labels: ['dispatch', 'complexity:low'] }, ['title', 'labels']);
const { update } = updateFor(row, edits);
check(
  'saving a title from the phone does not take the record off',
  !(update.removeLabels || []).includes('ran:opus'),
  JSON.stringify(update)
);
check(
  'and a ran label cannot be set from there either',
  !normalizeEdits({ labels: ['ran:opus'] }, ['labels']).labels.includes('ran:opus'),
  JSON.stringify(normalizeEdits({ labels: ['ran:opus'] }, ['labels']))
);

/* ------------------------------------------------------------- end to end */

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
function transcript(sessionId, text) {
  const slug = path.join(HOME, '.claude', 'projects', '-tmp-somewhere');
  fs.mkdirSync(slug, { recursive: true });
  fs.writeFileSync(path.join(slug, `${sessionId}.jsonl`), text);
}

transcript('sess-moved-0001', moved);

const res = await sessionlog.archiveSession(dir, {
  workspace: 'test',
  bead: 'bc-ran1',
  sessionId: 'sess-moved-0001',
  outcome: 'ended',
  model: 'sonnet',
  tier: 'low',
});

check('the archive hands the models back to whoever writes the bead', res.ran.join(',') === 'claude-sonnet-5,claude-opus-5', JSON.stringify(res.ran));

const metaOf = (ref) => JSON.parse(execFileSync('git', ['-C', dir, 'cat-file', '-p', `${ref}:meta.json`], { encoding: 'utf8' }));
const meta = metaOf(res.ref);

check('meta.json records what it was routed to', meta.model === 'sonnet', JSON.stringify(meta.model));
check('and what that was decided from', meta.tier === 'low', JSON.stringify(meta.tier));
check('and every model it actually ran on, as ids', JSON.stringify(meta.ran) === '["claude-sonnet-5","claude-opus-5"]', JSON.stringify(meta.ran));
check(
  'the divergence is stored rather than left to be recomputed',
  meta.ranDiverged === false,
  JSON.stringify(meta.ranDiverged)
);

transcript('sess-diverged-002', jsonl([{ type: 'assistant', message: { model: 'claude-opus-5', content: [] } }]));
const two = await sessionlog.archiveSession(dir, {
  workspace: 'test',
  bead: 'bc-ran2',
  sessionId: 'sess-diverged-002',
  outcome: 'ended',
  model: 'sonnet',
  tier: 'medium',
});
check('a session routed cheap that ran expensive says so in its own archive', metaOf(two.ref).ranDiverged === true);

// The rendering has a 4MB budget and the models must not share it: the long session is
// exactly the one somebody changed model in.
// `renderEvent` clips each part to 600 characters, so blowing a 4MB budget takes
// thousands of turns rather than one enormous one — which is also what a real long
// session looks like.
const filler = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'x'.repeat(700) }] } };
const long = jsonl([
  { type: 'assistant', message: { model: 'claude-sonnet-5', content: [] } },
  ...Array.from({ length: 7500 }, () => filler),
  { type: 'assistant', message: { model: 'claude-opus-5', content: [] } },
]);
transcript('sess-long-000003', long);
const three = await sessionlog.archiveSession(dir, {
  workspace: 'test',
  bead: 'bc-ran3',
  sessionId: 'sess-long-000003',
  outcome: 'ended',
  model: 'sonnet',
});
check(
  'a log long enough to be truncated still reports the model it ended on',
  three.ran.includes('claude-opus-5'),
  JSON.stringify(three.ran)
);
check(
  'and the rendering really was truncated, so that check meant something',
  // maxBuffer, because the whole point of this fixture is a log past 4MB and the default
  // is 1MB — a suite that left it would fail here with ENOBUFS and read as a bug in the
  // archive.
  execFileSync('git', ['-C', dir, 'cat-file', '-p', `${three.ref}:session.log`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).includes('rendering truncated')
);

const gone = await sessionlog.archiveSession(dir, {
  workspace: 'test',
  bead: 'bc-ran4',
  sessionId: 'sess-vanished-04',
  outcome: 'ended',
  model: 'opus',
});
check('a session whose transcript is gone reports nothing rather than the plan', gone.ran.length === 0, JSON.stringify(gone.ran));
check('and its archive says so too', JSON.stringify(metaOf(gone.ref).ran) === '[]');

check(
  'ranModelsOf answers the same thing without archiving anything',
  sessionlog.ranModelsOf('sess-moved-0001').join(',') === 'claude-sonnet-5,claude-opus-5',
  JSON.stringify(sessionlog.ranModelsOf('sess-moved-0001'))
);
check('and answers empty for a session id nothing wrote', sessionlog.ranModelsOf('sess-nothing-0000').length === 0);
check('and for no session id at all', sessionlog.ranModelsOf(null).length === 0);

/* ------------------------------------------------------------- onto the real bead */

console.log('through a real advocate tick');

/**
 * The wiring, which is the half a unit test cannot see: a window ends, and the label
 * appears on the bead. Same fixture shape as test/handback.mjs — a fake `bd` that is a
 * small mutable world, `open`/`openPlan` injected so nothing reaches iTerm — with the two
 * cases that take different routes to the same answer.
 */
const { createAdvocates } = await import('../lib/advocate.js');

async function tick({ sessionLog, workerDir = dir, model = 'sonnet', sessionId = 'sess-moved-0001' }) {
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
          { id: 'x-1', title: 'x-1', at: '2020-01-01T00:00:00Z', attempt: 1, sessionId, dir: workerDir, model, tier: 'low' },
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
  'a finished window puts what it ran on onto its bead',
  logged.added.join(' | ') === 'x-1 ran:sonnet | x-1 ran:opus',
  JSON.stringify(logged.added)
);

const unlogged = await tick({ sessionLog: false });
check(
  'and does so even where this workspace keeps no session log at all',
  unlogged.added.join(' | ') === 'x-1 ran:sonnet | x-1 ran:opus',
  JSON.stringify(unlogged.added)
);

const broken = await tick({ sessionLog: true, workerDir: path.join(tmp, 'not-a-repo') });
check(
  'an archive that fails still leaves the record on the bead — that is when it matters most',
  broken.added.join(' | ') === 'x-1 ran:sonnet | x-1 ran:opus',
  JSON.stringify(broken.added)
);

/**
 * bc-nc6o.14 — a `[1m]` selection is a different `ran:` label than the 200k one.
 *
 * `message.model` never carries the marker (see the doc comment on `ranToken`), so this
 * transcript's assistant turn is `claude-opus-5`, exactly like every 200k one above — the
 * `usage` on it is what lets `sessionTokens` grade a real window, and it is the worker
 * record's `model: 'opus[1m]'`, not anything in the transcript, that says which one.
 */
transcript(
  'sess-longwindow-0001',
  jsonl([
    {
      type: 'assistant',
      message: {
        model: 'claude-opus-5',
        content: [],
        usage: { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 50 },
      },
    },
  ])
);
const longWindow = await tick({ sessionLog: true, model: 'opus[1m]', sessionId: 'sess-longwindow-0001' });
check(
  'a session opened on the 1M window gets a label the 200k one never would',
  longWindow.added.join(' | ') === 'x-1 ran:opus-1m | x-1 ctx:fit',
  JSON.stringify(longWindow.added)
);

console.log(failures ? `\n${failures} failed` : '\nall good');
process.exit(failures ? 1 : 0);
