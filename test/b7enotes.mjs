#!/usr/bin/env node
//
// b7e-notes — ask for the notes about this bead and these files, rather than guessing
// key names (bc-khoe.43).
//
//   npm test
//   node test/b7enotes.mjs
//
// lib/b7enotes.js does the matching; most of this drives it directly against fabricated
// input (plain objects, a fabricated tree the same shape test/affected.mjs uses) so a
// regression is found in milliseconds. A handful of checks at the end run against THIS
// repo's own real tier-1 store and its real acceptance-criteria bead, the same call
// test/affected.mjs makes for its own two concrete cases: the point of `test/landcheck.mjs`
// finding `landcheck-outruns-a-300s-suite-timeout` is that it holds here, not in a fixture.
// Those last two skip on a checkout that has no such store — a CI runner or a fresh clone,
// neither of which is given the refs — for the reasons written out at section 7.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-notes');

const b7enotes = await import(path.join(ROOT, 'lib', 'b7enotes.js'));
const memory = await import(path.join(ROOT, 'lib', 'memory.js'));
const sessionlog = await import(path.join(ROOT, 'lib', 'sessionlog.js'));

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
// async-safe throughout, so the same helper covers a plain assertion and an `await
// b7enotes.gather(...)` alike — `await` on a non-promise return is a no-op, and every
// call site below awaits this regardless of which kind it is.
const check = async (name, fn) => {
  try {
    const result = await fn();
    if (result === false) throw new Error('returned false');
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};
const rejects = async (name, fn, matcher) => {
  try {
    await fn();
    bad(name, 'did not throw');
  } catch (err) {
    if (matcher && !matcher.test(err.message)) bad(name, `wrong error: ${err.message}`);
    else ok(name);
  }
};

/* ===================================================================== *
 * 1. ancestorIds — a bead's own id, every dotted prefix, and its `parent` field
 * ===================================================================== */

console.log('\nancestorIds\n');

check('a top-level bead answers only to itself', () => {
  assert.deepEqual(b7enotes.ancestorIds({ id: 'bc-khoe' }), ['bc-khoe']);
});
check('one dot adds the parent', () => {
  const ids = b7enotes.ancestorIds({ id: 'bc-khoe.43' });
  assert.deepEqual(new Set(ids), new Set(['bc-khoe.43', 'bc-khoe']));
});
check('two dots add every prefix, not just the immediate parent', () => {
  const ids = b7enotes.ancestorIds({ id: 'bc-khoe.27.1' });
  assert.deepEqual(new Set(ids), new Set(['bc-khoe.27.1', 'bc-khoe.27', 'bc-khoe']));
});
check('a recorded `parent` that disagrees with the dots is added too, not substituted', () => {
  const ids = b7enotes.ancestorIds({ id: 'bc-71pw', parent: 'bc-khoe.30' });
  assert.deepEqual(new Set(ids), new Set(['bc-71pw', 'bc-khoe.30']));
});
check('case is folded, since notes are matched case-insensitively against these', () => {
  assert.deepEqual(b7enotes.ancestorIds({ id: 'BC-Khoe.5' }), ['bc-khoe.5', 'bc-khoe']);
});
check('no id is an empty list, not a throw', () => {
  assert.deepEqual(b7enotes.ancestorIds({}), []);
});

/* ===================================================================== *
 * 2. notesForBead — names this bead's lineage, or reads like it does
 * ===================================================================== */

console.log('\nnotesForBead — group 1\n');

const bead = {
  id: 'bc-khoe.5',
  parent: 'bc-khoe',
  title: 'A poll already in flight when you tap the space picker snaps it back',
  description: 'Switching space mid-poll races the in-flight request against the new one.',
};

check('a note naming the bead itself is returned, unconditionally', () => {
  const all = { 'about-khoe5': { value: 'This is about bc-khoe.5 specifically.', at: '2026-01-01T00:00:00Z' } };
  const out = b7enotes.notesForBead(all, bead);
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'about-khoe5');
  assert.match(out[0].reason, /names bc-khoe\.5/);
});

check('a note naming only the PARENT still matches, and says which ancestor', () => {
  const all = { 'about-the-epic': { value: 'Something true of bc-khoe as a whole.', at: '2026-01-01T00:00:00Z' } };
  const out = b7enotes.notesForBead(all, bead);
  assert.equal(out.length, 1);
  assert.match(out[0].reason, /names bc-khoe$/);
});

check('an unrelated note that shares no vocabulary is not returned', () => {
  const all = { unrelated: { value: 'Timesheets are due Friday, submit them to payroll.', at: '2026-01-01T00:00:00Z' } };
  assert.deepEqual(b7enotes.notesForBead(all, bead), []);
});

check('a note that reads like the bead, without naming it, is found by similarity', () => {
  const all = {
    'the-two-warmers-decide-the-same-question': {
      value:
        'A poll already in flight when the space picker is tapped mid-flight races the in-flight ' +
        'request against the new space and the old one can snap the board back after the switch.',
      at: '2026-01-01T00:00:00Z',
    },
  };
  const out = b7enotes.notesForBead(all, bead);
  assert.equal(out.length, 1);
  assert.equal(out[0].reason, 'reads like this bead');
});

check('named beats similar, and similar beats nothing, in the sort order', () => {
  const all = {
    similar: {
      value: 'A poll already in flight races the in-flight request against a switch of the space picker.',
      at: '2026-01-01T00:00:00Z',
    },
    named: { value: 'A short note that happens to say bc-khoe.5 once.', at: '2026-01-01T00:00:00Z' },
  };
  const out = b7enotes.notesForBead(all, bead);
  assert.deepEqual(out.map((n) => n.key), ['named', 'similar']);
});

check('`keep` bounds the count', () => {
  const all = {};
  for (let i = 0; i < 20; i += 1) all[`n${i}`] = { value: `bc-khoe.5 appears in note ${i}.`, at: '2026-01-01T00:00:00Z' };
  assert.equal(b7enotes.notesForBead(all, bead, { keep: 3 }).length, 3);
});

check('an empty store is an empty list, not a throw', () => {
  assert.deepEqual(b7enotes.notesForBead({}, bead), []);
});

/* ===================================================================== *
 * 3. notesForPaths — group 2, against a fabricated tree
 * ===================================================================== */

console.log('\nnotesForPaths — group 2\n');

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-b7enotes-test-'));

/** A fresh `<tmp>/<name>/` tree holding the given files at the given repo-relative paths —
 * the same helper test/affected.mjs uses, so `lib/affected.js`'s suite derivation sees a
 * real import graph rather than nothing. */
const tree = (name, files) => {
  const dir = path.join(tmp, name);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return dir;
};

check('the acceptance case: a note naming nothing but the given path is found', () => {
  const all = {
    'landcheck-timing': {
      value: 'test/landcheck.mjs needs a longer per-suite timeout than the rest of the sweep.',
      at: '2026-01-01T00:00:00Z',
    },
  };
  const out = b7enotes.notesForPaths(all, ['test/landcheck.mjs']);
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'landcheck-timing');
  assert.match(out[0].reason, /test\/landcheck\.mjs/);
});

check('a note naming only the bare stem still matches', () => {
  const all = { about: { value: 'landcheck is the slowest suite in the repo.', at: '2026-01-01T00:00:00Z' } };
  const out = b7enotes.notesForPaths(all, ['test/landcheck.mjs']);
  assert.equal(out.length, 1);
});

check('a note about a different file entirely is not returned', () => {
  const all = { about: { value: 'public/app.js handles the tab bar.', at: '2026-01-01T00:00:00Z' } };
  assert.deepEqual(b7enotes.notesForPaths(all, ['test/landcheck.mjs']), []);
});

check('a covering suite counts too, and a generic bare stem from it does not flood the result', () => {
  const dir = tree('suites', {
    'lib/a.js': "export const A = 1;\n",
    // Two suites import lib/a.js; one has a distinctive name, one a common English word —
    // the exact shape that flooded an early version of this with every note that ever said
    // "session" or "check".
    'test/aspecific.mjs': "import { A } from '../lib/a.js';\n",
    'test/session.mjs': "import { A } from '../lib/a.js';\n",
  });
  const all = {
    specific: { value: 'test/aspecific.mjs is the one covering lib/a.js worth reading first.', at: '2026-01-01T00:00:00Z' },
    generic: { value: 'A session is what an agent runs inside; unrelated to any of the files here.', at: '2026-01-01T00:00:00Z' },
  };
  const out = b7enotes.notesForPaths(all, ['lib/a.js'], { root: dir });
  assert.deepEqual(out.map((n) => n.key), ['specific']);
});

check('a file the caller actually named outranks one only derived as a covering suite', () => {
  const dir = tree('priority', {
    'lib/b.js': "export const B = 1;\n",
    'test/b.mjs': "import { B } from '../lib/b.js';\n",
  });
  const all = {
    // Mentions the DERIVED suite (test/b.mjs) and is the newer note.
    derived: { value: 'test/b.mjs is worth reading.', at: '2026-06-01T00:00:00Z' },
    // Mentions the GIVEN path (lib/b.js) directly and is the older note.
    given: { value: 'lib/b.js is worth reading.', at: '2026-01-01T00:00:00Z' },
  };
  const out = b7enotes.notesForPaths(all, ['lib/b.js'], { root: dir });
  assert.deepEqual(out.map((n) => n.key), ['given', 'derived']);
});

check('no paths at all is an empty list, not a throw', () => {
  assert.deepEqual(b7enotes.notesForPaths({ x: { value: 'y' } }, []), []);
});

check('`keep` bounds the count here too', () => {
  const all = {};
  for (let i = 0; i < 20; i += 1) all[`n${i}`] = { value: `note ${i} about test/landcheck.mjs`, at: '2026-01-01T00:00:00Z' };
  assert.equal(b7enotes.notesForPaths(all, ['test/landcheck.mjs'], { keep: 4 }).length, 4);
});

/* ===================================================================== *
 * 4. capDebriefs — bounding group 3 the way debriefBrief bounds the brief
 * ===================================================================== */

console.log('\ncapDebriefs — bounding group 3\n');

check('an empty list caps to nothing, with nothing "more"', () => {
  assert.deepEqual(b7enotes.capDebriefs([]), { picked: [], more: 0 });
});

check('the first entry is kept whole, however long, even past the char budget', () => {
  const long = 'x'.repeat(b7enotes.DEBRIEF_CHARS * 10);
  const { picked, more } = b7enotes.capDebriefs([{ bead: 'a', text: long }], { keep: 3, chars: 100 });
  assert.equal(picked.length, 1);
  assert.equal(picked[0].text, long);
  assert.equal(more, 0);
});

check('a later entry is clipped once the running total passes the char budget', () => {
  // Room after the first entry (1000 - 700 = 300) clears the 200-char minimum
  // `debriefBrief` itself uses, so the second entry is clipped rather than dropped.
  const { picked, more } = b7enotes.capDebriefs(
    [
      { bead: 'a', text: 'x'.repeat(700) },
      { bead: 'b', text: 'y'.repeat(500) },
    ],
    { keep: 3, chars: 1000 }
  );
  assert.equal(picked.length, 2);
  assert.equal(picked[0].text.length, 700);
  assert.ok(picked[1].text.length < 500, picked[1].text.length);
  assert.match(picked[1].text, /clipped/);
  assert.equal(more, 0);
});

check('a later entry too short to be worth a fragment is dropped, not clipped to nothing', () => {
  // Room after the first entry (500 - 490 = 10) is under the 200-char minimum, so the
  // second entry is left out of `picked` entirely and counted in `more` instead.
  const { picked, more } = b7enotes.capDebriefs(
    [
      { bead: 'a', text: 'x'.repeat(490) },
      { bead: 'b', text: 'y'.repeat(50) },
    ],
    { keep: 3, chars: 500 }
  );
  assert.equal(picked.length, 1);
  assert.equal(more, 1);
});

check('`keep` bounds the entry count and reports the rest as "more"', () => {
  const list = Array.from({ length: 5 }, (_, i) => ({ bead: `b${i}`, text: `report ${i}` }));
  const { picked, more } = b7enotes.capDebriefs(list, { keep: 2, chars: 4000 });
  assert.equal(picked.length, 2);
  assert.equal(more, 3);
});

check('a blank entry is skipped rather than counted', () => {
  const { picked } = b7enotes.capDebriefs([{ bead: 'a', text: '   ' }, { bead: 'b', text: 'real report' }]);
  assert.deepEqual(picked.map((p) => p.bead), ['b']);
});

/* ===================================================================== *
 * 5. gather() — the whole pipeline, against a real (scratch) git repo
 * ===================================================================== */

console.log('\ngather() — the whole pipeline\n');

/** A throwaway repo with one commit, so tier-1 notes and tier-4 debriefs have somewhere
 * to live — the same fixture shape test/memory.mjs uses for the stores this reads. */
function scratchRepo() {
  const dir = path.join(tmp, `repo-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  const g = (...a) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' }).trim();
  g('init', '-q', '--initial-branch=main');
  fs.writeFileSync(path.join(dir, 'README'), 'scratch\n');
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib', 'thing.js'), "export const THING = 1;\n");
  fs.writeFileSync(path.join(dir, 'test', 'thing.mjs'), "import { THING } from '../lib/thing.js';\n");
  g('add', '-A');
  g('commit', '-q', '-m', 'first');
  return dir;
}

const at = async (dir, fn) => {
  const back = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(back);
  }
};

const repo = scratchRepo();
await at(repo, async () => {
  await memory.note('worker', 'thing-js-is-fiddly', 'lib/thing.js has a trap: it is imported by test/thing.mjs and nothing else.');
  await memory.note('worker', 'unrelated', 'Nothing to do with any of this.');
  await memory.debrief('worker', 'bc-fix.1', 'First run at the sibling: found the trap in lib/thing.js.');
});

await check('a bead with no declared or guessed files falls back to nothing, not a throw', async () => {
  const result = await b7enotes.gather(repo, { id: 'bc-fix.2', parent: 'bc-fix', title: 'Fix the other half' }, []);
  assert.deepEqual(result.paths, []);
  assert.deepEqual(result.files, []);
});

await check('a bead that declares its files (lib/beadfiles.js block) gets them by default', async () => {
  const declaring = {
    id: 'bc-fix.3',
    parent: 'bc-fix',
    title: 'Fix the thing',
    description: '```beadfiles\nlib/thing.js\n```',
  };
  const result = await b7enotes.gather(repo, declaring, []);
  assert.deepEqual(result.paths, ['lib/thing.js']);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].key, 'thing-js-is-fiddly');
});

await check('paths passed explicitly win over the bead\'s own declared surface', async () => {
  const declaring = { id: 'bc-fix.3', parent: 'bc-fix', title: 'x', description: '```beadfiles\nlib/thing.js\n```' };
  const result = await b7enotes.gather(repo, declaring, ['test/thing.mjs']);
  assert.deepEqual(result.paths, ['test/thing.mjs']);
});

await check('the sibling\'s debrief comes back under the parent, not only under an exact self match', async () => {
  const result = await b7enotes.gather(repo, { id: 'bc-fix.2', parent: 'bc-fix', title: 'x' }, ['lib/thing.js']);
  assert.equal(result.debriefs.length, 1);
  assert.equal(result.debriefs[0].bead, 'bc-fix.1');
  assert.match(result.debriefs[0].text, /trap in lib\/thing\.js/);
  assert.equal(result.moreDebriefs, 0);
});

await check('a bead with no family at all in the debrief store gets an empty group, not a throw', async () => {
  const result = await b7enotes.gather(repo, { id: 'bc-nothing.1', parent: 'bc-nothing', title: 'x' }, ['lib/thing.js']);
  assert.deepEqual(result.debriefs, []);
});

/* ===================================================================== *
 * 6. bin/b7e-notes — end to end, against the same scratch repo
 * ===================================================================== */

console.log('\nbin/b7e-notes — end to end\n');

/** A fake `bd` on PATH that answers exactly `show <id> --json`, the one call this bin
 * makes — the same array-or-error shape lib/bd.js documents for the real binary. */
const fakebin = fs.mkdtempSync(path.join(tmp, 'fakebin-'));
const WORLD = {
  'bc-fix.3': { id: 'bc-fix.3', title: 'Fix the thing', parent: 'bc-fix', description: '```beadfiles\nlib/thing.js\n```' },
  // A family of its own, with no debrief anywhere under it, so a query against it can
  // legitimately come back with all three groups empty. Vocabulary chosen to share
  // nothing with the fixture notes above — even a bare bead title feeds `notesForBead`'s
  // similarity scoring, and a small shared token count can still clear `RELEVANT` when
  // both bags are this small.
  'bc-lonely.1': { id: 'bc-lonely.1', title: 'Rename the favicon on the settings page', parent: 'bc-lonely', description: '' },
};
fs.writeFileSync(
  path.join(fakebin, 'bd'),
  `#!/usr/bin/env node
const args = process.argv.slice(2);
const world = ${JSON.stringify(WORLD)};
if (args[0] === 'show') {
  const row = world[args[1]];
  if (!row) {
    process.stdout.write(JSON.stringify({ error: 'no issues found matching the provided IDs' }) + '\\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify([row]) + '\\n');
  process.exit(0);
}
process.stderr.write('fake bd: unsupported ' + args.join(' ') + '\\n');
process.exit(1);
`
);
fs.chmodSync(path.join(fakebin, 'bd'), 0o755);
const PATH_WITH_FAKE_BD = `${fakebin}:${process.env.PATH}`;

const run = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, PATH: PATH_WITH_FAKE_BD } });

check('no bead id at all is refused with exit 2', () => {
  const r = run([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});

check('an unrecognised flag is refused with exit 2', () => {
  const r = run(['bc-fix.3', '--nope']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unrecognised flag/);
});

check('a bead `bd show` cannot find is refused with exit 2, not a crash', () => {
  const r = run(['bc-does-not-exist', '--dir', repo]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /b7e-notes:/);
});

check('the real end-to-end call: declared surface, a matched note, exit 0', () => {
  const r = run(['bc-fix.3', '--dir', repo]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /bc-fix\.3/);
  assert.match(r.stdout, /thing-js-is-fiddly/);
  assert.match(r.stdout, /lib\/thing\.js/);
});

check('--json prints the same three groups as structured data', () => {
  const r = run(['bc-fix.3', '--dir', repo, '--json']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.deepEqual(parsed.paths, ['lib/thing.js']);
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0].key, 'thing-js-is-fiddly');
});

check('a bead with no family and a path with nothing to say about it is exit 1, not 0', () => {
  const r = run(['bc-lonely.1', '--dir', repo, 'README']);
  assert.equal(r.status, 1, r.stderr);
});

/* ===================================================================== *
 * 7. against THIS repo's own real store — the acceptance-criteria case
 * ===================================================================== */

console.log("\nagainst this repo's real notes store — bc-khoe.43's own acceptance case\n");

// No git fixture and no fake bd here on purpose: lib/b7enotes.js reads the same tier-1
// ref (refs/beadcause/agents/worker) this checkout already has, shared with every
// worktree of it — the point of the case below is that it holds in THIS repo, not a
// fabricated stand-in for it. See test/affected.mjs's own final section for the
// precedent.
//
// WHICH IS WHY BOTH CHECKS SKIP WHEN THE STORE IS EMPTY, and test/affected.mjs's
// precedent stops short of here: that suite's real-repo section reads the file TREE,
// which every checkout has. These two read refs the checkout HOLDS — tier-1 notes on
// `refs/beadcause/agents/worker`, tier-4 debriefs on the session refs beside them — and
// those are never pushed anywhere (`git ls-remote origin 'refs/beadcause/*'` comes back
// empty). `actions/checkout` fetches the branch and nothing else, so on a CI runner, and
// in any fresh clone, both stores are simply absent and these two assertions fail for a
// reason that has nothing to do with the code under test. Same shape as
// test/closegatereal.mjs skipping when there is no `bd` on PATH.
//
// Keyed on the store being EMPTY rather than on $CI deliberately: "this checkout cannot
// be asked" is the real precondition, and it is as true of a colleague's fresh clone as
// of a runner. On a machine that does have the store — where the acceptance criteria are
// actually provable — both still run and still have to pass.
const skip = (name, why) => console.log(`  \x1b[33m—\x1b[0m ${name}\n      skipped: ${why}`);
const NEVER_PUSHED = 'the beadcause refs are local to a checkout and are never pushed';

const realNotes = await memory.notesIn(ROOT, 'worker');
const debriefedBeads = await sessionlog.debriefBeads(ROOT);

// `notesIn` answers a key→text OBJECT, not a list — `.length` on it is `undefined`, which
// is falsy, which would skip this check on every machine including the ones that can
// actually prove it. Count the keys.
const LANDCHECK_CASE = 'test/landcheck.mjs alone finds landcheck-outruns-a-300s-suite-timeout, without the bead being named';
if (!Object.keys(realNotes).length) skip(LANDCHECK_CASE, `no tier-1 notes store in this checkout — ${NEVER_PUSHED}`);
else check(LANDCHECK_CASE, () => {
  const out = b7enotes.notesForPaths(realNotes, ['test/landcheck.mjs'], { root: ROOT });
  assert.ok(
    out.some((n) => n.key === 'landcheck-outruns-a-300s-suite-timeout'),
    `keys: ${out.map((n) => n.key).join(', ')}`
  );
});

const FAMILY_CASE = "gather() against the real repo pulls bc-khoe's own debrief history for a bc-khoe.* sibling";
if (!debriefedBeads.size) skip(FAMILY_CASE, `no tier-4 debrief store in this checkout — ${NEVER_PUSHED}`);
else await check(FAMILY_CASE, async () => {
  const result = await b7enotes.gather(ROOT, { id: 'bc-khoe.999-does-not-exist', parent: 'bc-khoe', title: 'x' }, ['README.md']);
  assert.ok(result.debriefs.length > 0, 'expected at least one debrief from the bc-khoe family');
});

/* ===================================================================== */

for (const dir of [tmp]) removeTreeSync(dir);

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
