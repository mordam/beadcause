#!/usr/bin/env node
/**
 * The net in front of the near-verbatim one — shortlist, judge, refusal.
 *
 *     npm test
 *     node test/samejob.mjs
 *
 * bc-zsajb. Two halves, tested as the two different things they are.
 *
 * **The shortlist is deterministic, so it is tested against the real corpus.**
 * `test/fixtures/samejob-pairs.json` is the twelve pairs beadcause has actually had to mark
 * `superseded-by:` by hand, each oriented the way a create-time check would meet it: the one
 * filed *second* is the candidate, the one filed first is what has to be found. Titles and
 * descriptions are the real ones, so a change to the scoring that looks harmless and quietly
 * stops finding these fails here rather than in six weeks' worth of duplicates.
 *
 * The bar is **ten of twelve**, not twelve, and the two it misses are named below rather
 * than hidden in a ratio. Both are epics with generic titles that name no path at all —
 * nothing reading text could pair them, and pretending otherwise would mean tuning until the
 * corpus passed and the live graph drowned.
 *
 * **The judge is a model, so it is tested through a fake.** `runImpl` is injected, and what
 * is asserted is the plumbing that has to hold whatever the model says: an invented id is
 * not a refusal, `none` is not a refusal, an unparseable answer is not a refusal, and a
 * spawn that throws is not a refusal. Every one of those is a filing that must still land —
 * a wrong refusal loses a discovery a session cannot find again, which is the asymmetry the
 * whole design turns on.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const { shortlist, sameJob, parseVerdict, judgePrompt, refusalComment, familyOf, surfaceUnion, SHORTLIST_MAX } =
  await import(path.join(ROOT, 'lib', 'samejob.js'));

let failures = 0;
let ran = 0;
const check = async (name, fn) => {
  ran += 1;
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.message).split('\n').slice(0, 5).join('\n      ')}`);
  }
};

console.log('\nrefusing a bead that is already on the graph\n');

const row = (id, title, over = {}) => ({ id, title, status: 'open', labels: [], description: '', ...over });
const ids = (list) => list.map((r) => r.id);

/* --------------------------------------------------------------- the shortlist, pure */

await check('a shared file surface puts a row on the list, however unlike the titles are', () => {
  const cand = { title: 'Sessions are never reaped', description: 'The tick leaks panes.', files: ['lib/advocate.js'] };
  const rows = [
    row('bc-a1', 'Dead windows pile up until the daemon restarts', { description: 'See lib/advocate.js.' }),
    row('bc-b2', 'Something else entirely about a completely unrelated matter'),
  ];
  assert.deepEqual(ids(shortlist(cand, rows, { dirs: [ROOT] })), ['bc-a1']);
});

await check('two children of one epic are candidates on kinship alone', () => {
  const cand = { id: 'bc-7qo.19', title: 'Three worker windows opened on one bead' };
  const rows = [row('bc-7qo.18', 'The daemon only ever closed one of them'), row('bc-zz.4', 'An unrelated bead')];
  assert.deepEqual(ids(shortlist(cand, rows, { dirs: [ROOT] })), ['bc-7qo.18']);
});

await check('two roots are not kin — that would be most of the graph', () => {
  assert.equal(familyOf('bc-7qo.19'), 'bc-7qo');
  const cand = { id: 'bc-aaa', title: 'The endorsement queue drops a row on every device' };
  const rows = [row('bc-bbb', 'Chrome will not open a window after a headless run')];
  assert.deepEqual(ids(shortlist(cand, rows, { dirs: [ROOT] })), []);
});

await check('titles well under the near-verbatim bar are still candidates', () => {
  const cand = { title: 'test/advswitch.mjs flakes solo under gate load' };
  const rows = [row('bc-a1', 'test/advswitch.mjs is red on main again')];
  const out = shortlist(cand, rows, { dirs: [ROOT] });
  assert.equal(out.length, 1, 'a 0.4-ish pair has to reach the judge');
});

await check('closed, human and ignored rows are never candidates', () => {
  const cand = { title: 'The advocate leaks panes', files: ['lib/advocate.js'] };
  const rows = [
    row('bc-closed', 'The advocate leaks panes', { status: 'closed' }),
    row('bc-card', 'The advocate leaks panes', { labels: ['human'] }),
    row('bc-from', 'The advocate leaks panes'),
  ];
  assert.deepEqual(ids(shortlist(cand, rows, { dirs: [ROOT], ignore: ['bc-from'] })), []);
});

await check('the list is capped and ordered best-first, ties by id', () => {
  const cand = { id: 'bc-e.99', title: 'The advocate leaks panes', files: ['lib/advocate.js'] };
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(row(`bc-e.${i}`, `A sibling bead number ${i} about nothing much`));
  rows.push(row('bc-zz', 'The advocate leaks panes', { description: 'lib/advocate.js' }));
  const out = shortlist(cand, rows, { dirs: [ROOT] });
  assert.equal(out.length, SHORTLIST_MAX);
  assert.equal(out[0].id, 'bc-zz', 'a shared file plus a matching title outranks kinship');
  const kinIds = out.slice(1).map((r) => r.id);
  assert.deepEqual(kinIds, [...kinIds].sort(), 'equal scores break on id, so two machines agree');
});

await check('a candidate with no title shortlists nothing rather than everything', () => {
  assert.deepEqual(shortlist({ title: '  ' }, [row('bc-a1', 'anything')], { dirs: [ROOT] }), []);
});

await check('the file surface is the union of declared and prose, not either alone', () => {
  const declared = { title: 'x', files: ['lib/one.js'], description: 'and also lib/samejob.js in prose' };
  const out = surfaceUnion(declared, [ROOT]);
  assert.ok(out.includes('lib/one.js'), 'the declaration survives');
  assert.ok(out.includes('lib/samejob.js'), 'and so does a real path named only in the prose');
});

/* ------------------------------------------------------------- the corpus it exists for */

const PAIRS = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'samejob-pairs.json'), 'utf8'));

/** Both epics, both with generic titles naming no path. Named, not hidden in a ratio. */
const KNOWN_MISSES = new Set(['bc-mrm77', 'bc-ka5y']);

await check('every real duplicate but the two named ones is shortlisted for its own filing', () => {
  assert.equal(PAIRS.length, 12, 'the corpus is the twelve pairs, not a sample of them');
  const missed = [];
  for (const { filed, covers } of PAIRS) {
    // The rest of the corpus stands in for the live graph: every other bead in the file is
    // an open row this filing could have been paired with instead, which is what makes a
    // hit here mean "the right one won", not "there was only one".
    const others = PAIRS.flatMap((p) => [p.filed, p.covers]).filter((b) => b.id !== filed.id);
    const out = shortlist(filed, others.map((b) => row(b.id, b.title, { description: b.description })), {
      dirs: [ROOT],
    });
    if (!ids(out).includes(covers.id)) missed.push(`${filed.id}->${covers.id}`);
  }
  const unexpected = missed.filter((m) => !KNOWN_MISSES.has(m.split('->')[0]));
  assert.deepEqual(unexpected, [], `these pairs used to be found and are not any more: ${unexpected.join(', ')}`);
  assert.ok(PAIRS.length - missed.length >= 10, `only ${PAIRS.length - missed.length} of 12 found`);
});

await check('the judge is shown the shared files, so its answer can be checked', () => {
  const cand = { title: 'Sessions are never reaped', files: ['lib/advocate.js'] };
  const rows = shortlist(cand, [row('bc-a1', 'Dead windows pile up', { description: 'lib/advocate.js' })], {
    dirs: [ROOT],
  });
  const prompt = judgePrompt(cand, rows);
  assert.match(prompt, /bc-a1/);
  assert.match(prompt, /shares lib\/advocate\.js/);
  assert.match(prompt, /If you are not sure, answer `none`/);
});

/* ------------------------------------------------------------------------ the verdict */

const said = (id, why = 'same fix') => `\`\`\`samejob\nduplicate: ${id}\nwhy: ${why}\n\`\`\``;

await check('a named row is a verdict; none, an invention and the unparseable are not', () => {
  assert.deepEqual(parseVerdict(said('bc-a1'), ['bc-a1']), { duplicate: 'bc-a1', why: 'same fix' });
  assert.equal(parseVerdict(said('none'), ['bc-a1']).duplicate, null);
  assert.equal(parseVerdict(said('bc-nope'), ['bc-a1']).duplicate, null, 'an id it was never shown is not a refusal');
  assert.equal(parseVerdict('I think it is bc-a1, personally.', ['bc-a1']).duplicate, null);
  assert.equal(parseVerdict('```samejob\n{{{not yaml\n```', ['bc-a1']).duplicate, null);
  assert.equal(parseVerdict('', ['bc-a1']).duplicate, null);
});

await check('the why survives even when the verdict is none, because it is the reason', () => {
  assert.equal(parseVerdict(said('none', 'different subsystem'), ['bc-a1']).why, 'different subsystem');
});

/* ------------------------------------------------------------------------ end to end */

const CAND = { title: 'Sessions are never reaped', description: 'The tick leaks panes.', files: ['lib/advocate.js'] };
const ROWS = [row('bc-a1', 'Dead windows pile up until restart', { description: 'lib/advocate.js' })];

await check('a judge naming a shortlisted row refuses the filing', async () => {
  const out = await sameJob(CAND, ROWS, { dirs: [ROOT], runImpl: async () => said('bc-a1') });
  assert.equal(out.duplicate, 'bc-a1');
  assert.equal(out.why, 'same fix');
});

await check('an empty shortlist never spawns anything at all', async () => {
  let spawned = 0;
  const out = await sameJob({ title: 'A bead resembling nothing whatsoever here' }, ROWS, {
    dirs: [ROOT],
    runImpl: async () => {
      spawned += 1;
      return said('bc-a1');
    },
  });
  assert.equal(spawned, 0);
  assert.equal(out.duplicate, null);
});

await check('a judge that throws files the bead and says so, rather than losing it', async () => {
  const heard = [];
  const out = await sameJob(CAND, ROWS, {
    dirs: [ROOT],
    onWarn: (m) => heard.push(m),
    runImpl: async () => {
      throw new Error('could not start claude: ENOENT');
    },
  });
  assert.equal(out.duplicate, null, 'a failure is a pass');
  assert.ok(heard.some((m) => /without the duplicate judge/.test(m)), heard.join(' | '));
});

await check('a judge that answers nothing usable files the bead', async () => {
  const out = await sameJob(CAND, ROWS, { dirs: [ROOT], runImpl: async () => 'Hard to say, really.' });
  assert.equal(out.duplicate, null);
});

await check('what was considered comes back, so the caller can say what it looked at', async () => {
  const out = await sameJob(CAND, ROWS, { dirs: [ROOT], runImpl: async () => said('none') });
  assert.deepEqual(ids(out.rows), ['bc-a1']);
});

/* ----------------------------------------------------------------- the refusal itself */

await check('the refusal comment carries the observation, not just the refusal', () => {
  const text = refusalComment(CAND, { why: 'one fix in lib/advocate.js', from: 'bc-7qo' });
  assert.match(text, /Sessions are never reaped/, 'the title it tried to file');
  assert.match(text, /The tick leaks panes\./, 'and what it actually wrote — this is the point of it');
  assert.match(text, /one fix in lib\/advocate\.js/);
  assert.match(text, /bc-7qo/);
  assert.match(text, /--force/, 'and the way out, on the bead where it will be read');
});

await check('a refusal comment with nothing but a title still reads as English', () => {
  const text = refusalComment({ title: 'A bead' }, {});
  assert.match(text, /A bead/);
  assert.doesNotMatch(text, /undefined|\[object/);
});

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
