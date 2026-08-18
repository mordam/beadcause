/**
 * Which of the two workspace shapes each call site in the advocate actually wants.
 *
 *     node test/wsshape.mjs
 *
 * An advocate record in lib/advocate.js carries the workspace **twice** — `a.workspace` is
 * the object `{name, dir}` that `record(ws)` puts there, and `a.name` is its name as a
 * string — and the two are interchangeable to the type system and to every test that
 * builds its own fixture. Which one a call wants is decided entirely by the callee, and
 * nothing at the call site says which.
 *
 * **The failure is silent in both directions**, which is why bc-2uj4.6 lived a fortnight:
 * `openList(opened, a.workspace)` compared an object against a string, matched nothing,
 * and returned `[]` on every tick for every advocate — and an empty list is exactly what a
 * quiet laptop looks like, so nothing logged and nothing threw. Worse, `beadKey` is a
 * template literal, so it *accepted* the object and wrote seven live conversations under
 * `[object Object]/<bead>`. bc-ygwa is the audit of every other site of the same shape.
 *
 * The audit found no second instance. What this file is for is keeping that true, because
 * an audit is a fact about one afternoon and the hazard is permanent. Two halves:
 *
 *   - **The runtime guard**, `assertWorkspaceObject` in lib/bd.js. `run` is the single
 *     funnel every one of `Bd`'s ~40 public methods reaches, so one check there makes the
 *     name-for-object swap loud everywhere at once. Without it that direction is silent
 *     too: `workspace.dir` on a string is `undefined`, a spawn env drops an `undefined`
 *     value, and `bd` then answers *successfully* about whichever tracker the daemon's own
 *     cwd resolves to.
 *   - **The static read**, below. There is no funnel for the other direction — the object
 *     handed to something that wanted the name — because the name-takers are a dozen
 *     unrelated functions across six files, and half of them are template literals that
 *     accept anything. So this reads lib/advocate.js instead of running it: every
 *     `a.workspace` must sit in the argument list of a callee known to want the object,
 *     and no callee known to want the name may be handed one.
 *
 * **A new call site is meant to fail this file.** Passing `a.workspace` to a function
 * neither list names is not an error in itself — it is the one moment somebody knows which
 * shape that function wants, and the fix is to write it down in the list here. That is the
 * whole mechanism: the question is asked while the answer is cheap, rather than a fortnight
 * later off a daemon log with no line in it.
 *
 * COMMENTS ARE BLANKED FIRST (`test/helpers/blank.mjs`). lib/advocate.js argues about this
 * exact hazard in prose, quoting `a.workspace` and `openList(opened, a.workspace)` by name
 * in the header above `parkIdle` — an unblanked scan reports its own documentation as a
 * violation, which is the third time that trap has been hit here. See the memory note
 * `grepping-this-repos-own-source-must-blank-comments`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blankJs } from './helpers/blank.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (name) => path.join(HERE, '..', 'lib', name);

/* --------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err && err.message ? err.message : String(err)).split('\n').join('\n       ')}`);
  }
}

console.log('\nthe two workspace shapes, and which each call site wants\n');

/* ------------------------------------------------------- half one: the guard */

const { Bd } = await import(LIB('bd.js'));

/**
 * A `bd` binary that does not exist, on purpose: every case here must be refused *before*
 * anything is spawned, so the one that gets past the guard is identifiable by the ENOENT
 * it fails with instead. Nothing in this half touches a real tracker.
 */
const bd = new Bd({ bin: '/nonexistent/bd', actor: 'beadcause-test' });

await check('the workspace name, where a `bd` call wanted the object, is refused', async () => {
  await assert.rejects(
    () => bd.show('beadcause', 'bc-1'),
    /needs the workspace object/,
    'a string is the swap this whole file is about — it must not reach `execFile`'
  );
  // And the message says which of the two it got, because "wrong shape" over a value the
  // reader cannot see is the same dead end as no message at all.
  await bd.show('beadcause', 'bc-1').then(
    () => assert.fail('resolved'),
    (err) => {
      assert.match(err.message, /the name "beadcause"/, 'it quotes the name it was handed');
      assert.match(err.message, /bd show bc-1/, 'and which command it was about to run');
    }
  );
});

await check('a half-built workspace with no `dir` is refused too', async () => {
  // The shape a fixture reaches for when it only needs a name — and the one that would
  // spawn `bd` with `BEADS_DIR` unset, which is not an error anywhere below here.
  await assert.rejects(() => bd.show({ name: 'beadcause' }, 'bc-1'), /needs the workspace object/);
  await assert.rejects(() => bd.listStatus(null, 'open'), /needs the workspace object/);
});

await check('and `graph`, which is the one method that is not `async`, throws where it stands', () => {
  // Asserted rather than smoothed over, because it is the guard's one visible edge. `graph`
  // builds its own promise chain and hands the failure of a `bd export` back as the *last
  // good index* — deliberately, so one failed read does not blank the board. A wrong
  // workspace is not a failed read: it is a caller bug, and routing it into that `catch`
  // would file it as "could not read the shape of " and carry on with an empty graph, which
  // is the exact silence bc-2uj4.6 hid in. So the guard runs before the chain exists and
  // comes out of `graph` synchronously, with the stack that names the call site.
  assert.throws(() => bd.graph(undefined), /needs the workspace object/);
  assert.throws(() => bd.graph('beadcause'), /needs the workspace object/);
});

await check('the object gets through, and fails on its own merits', async () => {
  await assert.rejects(
    () => bd.show({ name: 'beadcause', dir: '/tmp' }, 'bc-1'),
    (err) => {
      assert.doesNotMatch(err.message, /needs the workspace object/, 'the guard is not in the way of a correct call');
      assert.match(err.message, /ENOENT/, 'it got as far as spawning the binary, which is the whole test');
      return true;
    }
  );
});

await check('every public `Bd` method funnels through the guarded `run`', async () => {
  // The claim the guard rests on. A method that spawned `execFile` itself would be a hole
  // in it, and would look exactly like the rest of the class from the outside.
  const src = blankJs(fs.readFileSync(LIB('bd.js'), 'utf8'));
  const spawns = [...src.matchAll(/\bexecFile\s*\(/g)];
  assert.equal(spawns.length, 1, `one spawn in lib/bd.js, inside \`run\` — found ${spawns.length}`);
  const runAt = src.indexOf('\n  run(workspace, rawArgs');
  assert.ok(runAt > 0, 'the `run` funnel is still called `run` and still takes the workspace first');
  assert.ok(spawns[0].index > runAt, 'and the one spawn is inside it');
});

/* --------------------------------------------- half two: the advocate's sites */

const ADVOCATE = 'lib/advocate.js';
const src = blankJs(fs.readFileSync(path.join(ROOT, ADVOCATE), 'utf8'));
const lineOf = (index) => src.slice(0, index).split('\n').length;

/**
 * Callees that want the workspace **object** — every one confirmed by reading it, in the
 * bc-ygwa audit. `bd.*` is the overwhelming majority and is matched as a family; the rest
 * are helpers that take it only to hand it on to `bd`, or that read `.dir` off it.
 */
const WANT_OBJECT = [
  // Not a name: `prs`, `open`, `openPlan` and `openAdvocate` are the injectable defaults
  // in `createAdvocates`, so the shape is decided by lib/inflight.js and lib/session.js.
  'prs',
  'open',
  'openPlan',
  'openAdvocate',
  'resolveSessionDir',
  'readPlan',
  'filePromotion',
  'homeIn',
  'markForGlean',
  'reconcileLanded',
  'sweepSuperseded',
  'sweepInMain',
  'sweepNotInMain',
  'followNotInMain',
  'amendment.openSelfAsk',
  'amendment.fileRequest',
  // Reads the queue through `bd.ready(ws)`, and every public `Bd` method takes the
  // workspace object — the check two above this one is the same rule from the other side.
  'sweepFinishedEpics',
  // lib/sessionaudit.js:743 normalises with `workspace?.name || String(workspace || '')`,
  // so it wants the object and merely survives a name. Passed as a property rather than
  // positionally, which is why it reads oddly here.
  'audit?.noteArchive',
];

/**
 * Callees that want the workspace **name**. Handing one the object is the bc-2uj4.6 bug,
 * and every one of these fails silently on it rather than throwing:
 *
 *   - lib/parked.js keys its store `<name>/<bead>` and filters on `rec.workspace === name`
 *     — an object is never equal to a string, and the key is a template literal that takes
 *     the object happily. It normalises with a private `nameOf` since bc-2uj4.6, so the
 *     class is dead there; the rule at the call site has not changed.
 *   - lib/repos.js looks the name up in a config block. A miss reads as "this workspace has
 *     one checkout", which is a plausible answer and a wrong one.
 *   - lib/spaces.js the same: no space found reads as the default policy.
 *   - `doneFileFor`/`checkinFileFor` are the nastiest of the set. Both build a filename by
 *     interpolation and then replace everything outside `[A-Za-z0-9._-]` with `_`, so the
 *     object arrives as `_object_Object_-bc-x.done` — a perfectly valid filename with the
 *     `[object Object]` marker *scrubbed out of it*, which is what lib/parked.js's stray
 *     adoption uses to find and rescue its own bad records. There would be nothing to find.
 */
const WANT_NAME = [
  'multiRepo',
  'repoList',
  'resolveRepo',
  'repoKey',
  'spaceFor',
  'isWorkspaceQuiet',
  'workerLimit',
  'epicAdvocateLimit',
  'beadKey',
  'prKey',
  'parkedList',
  'openList',
  'adoptStrays',
  'doneFileFor',
  'checkinFileFor',
  'readDone',
  'clearDone',
  'readCheckin',
  'clearCheckin',
  'surveyPrompt',
  'checkinMessage',
  'proposalTitle',
  'proposalBody',
  'agentrepo.startRun',
];

/** The argument list of one call, by balanced parens — `null` if they never balance. */
function argsAt(text, openParen) {
  let depth = 0;
  for (let i = openParen; i < text.length; i++) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return { from: openParen + 1, to: i, text: text.slice(openParen + 1, i) };
    }
  }
  return null;
}

/** Every call to `name(` in the blanked source, with the span its arguments occupy. */
function callsTo(name) {
  // Escape every regex metacharacter a callee name can contain, not only the dot: an
  // optional-chained name like `audit?.noteArchive` carries a `?`, and leaving it live
  // turns the preceding character into an optional one and the pattern silently stops
  // matching the thing it names.
  const escaped = name.replace(/[.?*+^$()[\]{}|\\]/g, '\\$&');
  // `\??\.?` so an optional call — `f?.(x)` — is seen. Without it every `?.()` in the
  // advocate was invisible to this audit rather than merely unlisted, which is the worse
  // of the two failures: an unlisted call is reported, an unseen one is not.
  const re = new RegExp(`(^|[^\\w$.])${escaped}\\s*\\??\\.?\\s*\\(`, 'g');
  const out = [];
  for (const m of src.matchAll(re)) {
    const open = src.indexOf('(', m.index + m[0].length - 1);
    const args = argsAt(src, open);
    if (args) out.push({ name, at: m.index, ...args });
  }
  return out;
}

await check('no name-taking callee in the advocate is handed the workspace object', () => {
  const bad = [];
  for (const name of WANT_NAME) {
    for (const call of callsTo(name)) {
      if (/\ba\.workspace\b/.test(call.text)) bad.push(`${ADVOCATE}:${lineOf(call.at)} — ${name}(… a.workspace …)`);
    }
  }
  assert.deepEqual(bad, [], `these want the name, not the object:\n       ${bad.join('\n       ')}`);
});

await check('no `bd` call in the advocate is handed the workspace name', () => {
  // Belt for the guard in lib/bd.js: that one throws when the tick reaches the call, this
  // one is red before anything runs, and a `bd` call on a rarely-taken branch is exactly
  // the kind that a suite can miss and a scan cannot.
  const bad = [];
  for (const m of src.matchAll(/\bbd\.([a-zA-Z]+)\s*\(\s*a\.name\b/g)) {
    bad.push(`${ADVOCATE}:${lineOf(m.index)} — bd.${m[1]}(a.name …)`);
  }
  assert.deepEqual(bad, [], `every \`bd.*\` takes the object:\n       ${bad.join('\n       ')}`);
});

await check('the workspace object never reaches a template literal', () => {
  // The `[object Object]/bc-x` class in its own right. A key built by interpolation is the
  // one shape that takes the wrong argument *and* writes a plausible-looking result, so
  // there is nothing downstream that can tell it went wrong.
  const bad = [];
  for (const m of src.matchAll(/\$\{[^}]*\ba\.workspace\b[^}]*\}/g)) {
    bad.push(`${ADVOCATE}:${lineOf(m.index)} — ${m[0]}`);
  }
  assert.deepEqual(bad, [], `interpolating it yields "[object Object]":\n       ${bad.join('\n       ')}`);
});

await check('every `a.workspace` in the advocate sits in a call that wants the object', () => {
  const spans = [];
  for (const name of WANT_OBJECT) for (const call of callsTo(name)) spans.push(call);
  for (const m of src.matchAll(/\bbd\.[a-zA-Z]+\s*\(/g)) {
    const args = argsAt(src, src.indexOf('(', m.index));
    if (args) spans.push({ name: m[0].trim(), ...args });
  }

  /**
   * The one site that is not an argument to anything: the maintenance collection falls
   * back to the advocated workspaces when `cfg.workspaces` is empty, and `cfg.workspaces`
   * is itself a list of `{name, dir}` (see `discoverWorkspaces` in lib/workspaceroots.js),
   * so the object is what belongs in that list.
   */
  const NOT_A_CALL = [/order\.map\(\(a\) => a\.workspace\)/];

  const orphans = [];
  for (const m of src.matchAll(/\ba\.workspace\b/g)) {
    if (spans.some((s) => m.index >= s.from && m.index < s.to)) continue;
    const line = src.split('\n')[lineOf(m.index) - 1];
    if (NOT_A_CALL.some((re) => re.test(line))) continue;
    orphans.push(`${ADVOCATE}:${lineOf(m.index)} — ${line.trim()}`);
  }

  assert.deepEqual(
    orphans,
    [],
    'each of these hands the workspace object to a callee neither list names. Read the\n' +
      '       callee, decide which shape it wants, and add it to WANT_OBJECT or WANT_NAME in\n' +
      '       this file — that decision is what the swap costs when nobody makes it:\n' +
      `       ${orphans.join('\n       ')}`
  );
});

await check('and the audit actually found something to check', () => {
  // A scan that matches nothing passes every case above, and a rename of `a.workspace`
  // would do exactly that silently. Deliberately a floor rather than an equality: the
  // advocate gains `bd` calls most weeks, and a suite that has to be edited for every one
  // of them is a suite that gets its numbers bumped without being read.
  const sites = [...src.matchAll(/\ba\.workspace\b/g)].length;
  assert.ok(sites >= 40, `expected the advocate's 47 \`a.workspace\` sites, found ${sites}`);
  const named = [...src.matchAll(/\ba\.name\b/g)].length;
  assert.ok(named >= 100, `expected the advocate's 158 \`a.name\` sites, found ${named}`);
});

console.log(`\n${ran - failures}/${ran} checks passed\n`);
process.exit(failures ? 1 : 0);
