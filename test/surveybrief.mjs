#!/usr/bin/env node
/**
 * The survey opens with a premise it cannot disprove.
 *
 *     npm test
 *     node test/surveybrief.mjs
 *
 * `surveyPrompt` used to open *"there is no ready work left in this repo's beads
 * tracker"*, and that sentence was falsifiable in one command. On the one real survey
 * this Mac has run — `architecture`, 2026-08-12, the log is still in
 * `~/.config/beadcause/logs/` — the agent's third line was *"The stated premise — an
 * empty queue — doesn't match reality here; there are 49 ready beads"*, its write-up
 * opened *"First, the premise was wrong"*, and it wrote a cross-repo memory
 * (`advocate.verify-the-empty-queue-premise`) telling every future survey to treat the
 * empty-queue claim as a hypothesis. That is the prompt teaching agents to distrust
 * their own briefs, and it cost that run its opening moves re-deriving what the daemon
 * was already holding.
 *
 * The claim is now the true one — nothing in *the advocate's queue* — and the gap
 * between that list and the agent's own `bd ready` is named, with the numbers the
 * daemon has. What this suite holds:
 *
 *   1. **The false sentence is gone and cannot come back**, in the prompt text itself.
 *   2. **`queueBrief` names every filter** — the four excluded labels, the priority
 *      floor, and the hold lists — and carries the counts it was given.
 *   3. **A count it was not given is omitted, not printed as zero.** Both `bd` reads in
 *      `propose` are allowed to fail, and "nothing is waiting on you" is a different
 *      claim from "I could not ask".
 *   4. **`QUEUE_HOLDS` covers every `heldBy*` list the agent record has.** This is the
 *      one that earns its keep over time: a tenth hold filter is a red test here rather
 *      than a hold the survey silently never hears about. `heldByPause` was the ninth,
 *      added after the bead that asked for this was filed — which said "eight".
 *   5. **The wiring**, as source assertions: `propose` gathers the counts and guards
 *      both reads, and `surveyAgent` passes the brief through to the prompt. There is
 *      no way to drive a real survey in a test — it spawns a ten-minute `claude` — so
 *      the seam is pinned where it is written, the shape test/advocateroster.mjs uses.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { queueBrief, QUEUE_HOLDS } from '../lib/advocate.js';
import { QUEUE_EXCLUDED } from '../lib/endorse.js';
import { blankComments } from '../lib/evidence.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const daemon = fs.readFileSync(path.join(ROOT, 'lib/advocate.js'), 'utf8');
const code = blankComments(daemon);

let failures = 0;
let ran = 0;
const check = (name, fn) => {
  ran += 1;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 6).join('\n       ')}`);
  }
};

const OPTS = { minPriority: 3 };
const brief = (a = {}, extra = {}) => queueBrief(a, OPTS, { owner: 'Adam', ...extra });

console.log('\nsurvey brief\n');

check('the falsifiable sentence is gone from the prompt', () => {
  // The whole file, comments included — a prompt string is prose and blanking would
  // not tell them apart. The header above quotes the old wording on purpose, so the
  // match is deliberately narrow enough to sit beside a comment that discusses it.
  assert.ok(
    !/queue is empty: there is\nno ready work left/.test(daemon),
    'the survey is told again that the tracker has no ready work in it'
  );
  const open = daemon.slice(daemon.indexOf('You are the **${workspace} advocate**'));
  const first = open.slice(0, open.indexOf('${queue'));
  assert.match(first, /Your queue is empty/, 'the premise no longer says whose queue is empty');
  assert.match(first, /after the filters/, 'the premise claims an empty queue with nothing narrowing it');
});

check('every excluded label is named, with its reason', () => {
  const text = brief();
  for (const label of QUEUE_EXCLUDED) {
    assert.match(text, new RegExp(`\`${label}\``), `${label} is subtracted from the queue and never explained`);
  }
  assert.match(text, /superseded-by/, 'a bead parked behind its original is a fifth invisible subtraction');
  assert.match(text, /QUEUE_EXCLUDED/, 'the agent cannot find the list this comes from');
  // The point of the paragraph, in one assertion: the agent is told the disagreement is
  // expected. Without this it re-derives it, which is the whole incident.
  assert.match(text, /bd ready\b[\s\S]{0,200}not agree/, 'the brief does not predict the disagreement');
  assert.match(text, /not a\ncontradiction of this brief/, 'nothing tells the agent to stop and not disprove it');
});

check('the priority floor is named either way', () => {
  assert.match(brief({ deferredByPriority: 12 }), /\*\*12\*\* ready bead\(s\) sit below the floor/);
  assert.match(brief({ deferredByPriority: 12 }), /worse than P3/, 'the floor is claimed without its number');
  // Zero is not silence: the floor still explains what it would have taken out.
  assert.match(brief({ deferredByPriority: 0 }), /worse than P3 is a backlog/);
  assert.ok(!/\*\*0\*\* ready bead/.test(brief({ deferredByPriority: 0 })), 'zero deferred is reported as a count');
  // Read from the config rather than hardcoded — a workspace that lowered its floor
  // must say so, or the number in the brief is about a different queue.
  assert.match(queueBrief({}, { minPriority: 1 }, { owner: 'Adam' }), /worse than P1/);
});

check('the counts it was given are carried', () => {
  const text = brief({}, { heldForEndorsement: 37, shipWaiting: 4 });
  assert.match(text, /\*\*37\*\* ready bead\(s\) carry `unendorsed`/, 'the endorsement count is not handed over');
  assert.match(text, /\*\*4\*\* are `ship` beads/, 'the ship count is not handed over');
  // Zero here IS a claim and must print: "nothing is waiting on your endorsement" is
  // exactly the sentence that stops the survey going to look.
  assert.match(brief({}, { heldForEndorsement: 0 }), /\*\*0\*\* ready bead\(s\) carry `unendorsed`/);
});

check('a count it could not get is omitted rather than invented', () => {
  const text = brief();
  assert.ok(!/carry `unendorsed`/.test(text), 'a failed endorsement read is reported as a number anyway');
  assert.ok(!/are `ship` beads/.test(text), 'a failed ship read is reported as a number anyway');
  // And the label bullet still stands on its own — the numbers are an addition to it,
  // not the thing it is made of.
  assert.match(text, /Four labels never reach my queue/);
  // One present and one missing is the realistic failure, and it must not produce a
  // dangling "and".
  const half = brief({}, { heldForEndorsement: 3 });
  assert.match(half, /\*\*3\*\* ready bead\(s\) carry `unendorsed`\./);
  assert.ok(!/, and \./.test(half), 'a missing second count leaves a dangling conjunction');
});

check('holds are reported when they exist and promised when they do not', () => {
  const quiet = brief();
  assert.match(quiet, /Nothing was held back by contention/, 'an empty hold set is not stated as the guarantee it is');
  assert.match(quiet, new RegExp(`all ${QUEUE_HOLDS.length} of my hold lists`), 'the hold count is not derived');
  const busy = brief({ heldByPr: [1, 2], heldByNoRoot: [3] });
  assert.match(busy, /Held back this tick/, 'a non-empty hold list is still reported as "nothing held back"');
  assert.match(busy, /\*\*2\*\* — an open pull request already carries the work/);
  assert.match(busy, /\*\*1\*\* — nothing on the board has decided/);
  assert.ok(!/Nothing was held back/.test(busy), 'the guarantee is printed over holds that exist');
  // The guarantee is only sound because `propose` is reached from the one gated call
  // site. If a second caller appears without that gate, the derived branch above is
  // what keeps the brief honest — so the gate itself is worth pinning.
  const tick = code.slice(code.indexOf('const quiet ='), code.indexOf('if (free <= 0)'));
  assert.match(tick, /if \(!a\.workers\.length && !quiet && o\.propose\) await propose\(a\)/, 'the survey gate moved');
});

check('QUEUE_HOLDS covers every hold list the agent record has', () => {
  // Read off the source rather than off a constructed record: the agent record is
  // private to `createAdvocates` and its snapshot is a narrowed view, so a hold list
  // that never reaches the card would be invisible to a check that read the snapshot —
  // which is exactly the class of hold this is here to catch. Every one of them is
  // initialised as `heldByX: []` in the record and read as `a.heldByX`, so both spellings
  // are collected and a field that appears as either counts.
  const fields = [...new Set(code.match(/heldBy\w+/g) || [])].sort();
  assert.ok(fields.length >= 9, `only ${fields.length} heldBy* fields found — is this the right file?`);
  const declared = [...new Set(code.match(/heldBy\w+(?=: \[\])/g) || [])].sort();
  assert.deepEqual(declared, fields, 'a hold list is read but never initialised, or the other way round');
  const covered = new Set(QUEUE_HOLDS.map((h) => h.field));
  const missing = fields.filter((f) => !covered.has(f));
  assert.deepEqual(missing, [], `hold list(s) the survey is never told about: ${missing.join(', ')}`);
  const stale = QUEUE_HOLDS.map((h) => h.field).filter((f) => !fields.includes(f));
  assert.deepEqual(stale, [], `QUEUE_HOLDS names field(s) the record no longer has: ${stale.join(', ')}`);
  for (const h of QUEUE_HOLDS) assert.ok(h.why && h.why.length > 20, `${h.field} has no reason a reader could act on`);
});

check('propose gathers the counts and neither read can lose the survey', () => {
  const fn = code.slice(code.indexOf('async function propose(a) {'), code.indexOf('async function flagDuplicates'));
  assert.match(fn, /readyHeld\(a\.workspace\)/, 'the endorsement count is not read');
  assert.match(fn, /readyShip\s*\?/, 'readyShip is called without guarding that the bd has it');
  assert.match(fn, /surveyAgent\(a, counts\)/, 'the counts never reach the agent');
  // Both in their own try, so one failing still leaves the other number — and neither
  // aborts. Counted rather than matched: two guarded reads, two catches.
  const gather = fn.slice(fn.indexOf('const counts ='), fn.indexOf('a.surveying = true'));
  assert.equal((gather.match(/try \{/g) || []).length, 2, 'the two counts are not independently guarded');
  assert.equal((gather.match(/\} catch \(err\) \{/g) || []).length, 2, 'a failed count can abort the survey');
  assert.ok(!/return;/.test(gather), 'a failed count returns instead of degrading the paragraph');
});

check('surveyAgent passes the brief into the prompt', () => {
  const call = code.slice(code.indexOf('surveyPrompt('), code.indexOf('{ mode: 0o600 }'));
  assert.match(call, /queueBrief\(a, o, \{ owner: ownerName\(cfg\), \.\.\.counts \}\)/, 'the brief is not built');
  // Position matters: `queueBrief` is the eighth argument and `checkoutBrief` the
  // seventh. A swap would put the multi-repo paragraph where the queue one goes and
  // read perfectly well in both places.
  assert.ok(
    call.indexOf('checkoutBrief(a, dir, others)') < call.indexOf('queueBrief('),
    'the two briefs have swapped places in the argument list'
  );
  const sig = code.slice(code.indexOf('function surveyPrompt('), code.indexOf('return `You are the'));
  assert.match(sig, /checkouts = '',\s*queue = ''/, 'the prompt signature no longer ends with the queue brief');
});

console.log(`\n${ran - failures}/${ran} passed\n`);
if (failures) process.exit(1);
