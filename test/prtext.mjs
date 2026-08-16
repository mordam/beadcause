#!/usr/bin/env node
/**
 * lib/prtext.js — the title and the body of a pull request beadcause opens.
 *
 *     npm test
 *     node test/prtext.mjs
 *
 * No gh, no git, no network: both halves are pure functions over strings, which is the
 * reason this suite can exist at all. Until bc-kneh they were a template literal and an
 * array literal inside `bin/deliver.js`, and nothing in a repo with 250 suites in it could
 * reach either — so both were wrong for the entire life of the tool, in ways that were
 * plainly visible on github.com and invisible in the source.
 *
 * ## What is actually being defended
 *
 * **The blank lines.** The old body listed `''` where markdown needs a paragraph break and
 * then filtered every `''` out on the way to the join, because the same filter was doing
 * duty for the optional `--tests` / `--risk` / `--left`. Two rendering bugs came out of the
 * one line, and only one of them looks like a bug in the source:
 *
 * - the lead ran into the summary's first paragraph;
 * - and `---` landed directly under the last line of prose, which is **setext**, so GitHub
 *   drew the risk paragraph as an `<h2>`.
 *
 * The second is the dangerous one to lose again, because a future refactor that "tidies"
 * the joins will reintroduce it and the diff will look like whitespace. So it is asserted
 * directly: no non-empty line may be immediately followed by `---`, in any combination of
 * the optional fields. That is the property, not the shape.
 *
 * **The length.** A title is read in four narrow places — GitHub's list, an ntfy
 * notification, the delivery card's heading, `Merge #<n>? …` sliced at 160. The bead titles
 * on this board are whole sentences and one of them is 118 characters. The assertion is on
 * the *budget*, and separately on the shortening being a stop rather than a chop: a cut at
 * a comma the author wrote needs no ellipsis, and a cut mid-sentence must have one.
 *
 * **The `bead:` line.** lib/beadref.js resolves what a pull request delivers from three
 * tiers, and the strongest is a body that declares it in exactly that shape. The other two
 * — the title, the branch name — are both strings a session can overwrite with `--title` or
 * a hand-named worktree, and when they stop naming the bead lib/landed.js stops being able
 * to close it. So the declaration is asserted against `candidateTiers` itself rather than
 * against a regex copied out of it, which is the only version of that test that cannot rot
 * when the parser moves.
 */
import assert from 'node:assert/strict';
import { candidateTiers } from '../lib/beadref.js';
import { bareRefs, diffstat, filesBlock, footer, prBody, prTitle } from '../lib/prtext.js';

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
  } catch (err) {
    console.error(`✗ ${name}\n  ${err.message}`);
    process.exitCode = 1;
  }
};

/** The bead title that started this: 106 characters, a colon and a comma in it. */
const LONG = 'Pause an EpicAdvocate: stop dispatching under one P0, and tell its live windows to write their memory first';

/* ------------------------------------------------------------------------ title */

check('the bead id leads and the sentence follows', () => {
  assert.equal(prTitle('bc-7qo', 'Do the thing'), 'bc-7qo: Do the thing');
});

check('a short title is left alone but for its capital', () => {
  assert.equal(prTitle('bc-zf3n', 'measure the contrast'), 'bc-zf3n: Measure the contrast');
});

check('a long title is brought inside the budget', () => {
  const t = prTitle('bc-lco2', LONG);
  assert.ok(t.length <= 82, `${t.length} chars: ${t}`);
  assert.ok(t.startsWith('bc-lco2: Pause an EpicAdvocate'), t);
});

check('the cut is the last boundary that fits, not the first', () => {
  // The first is the colon at 21. Stopping there would spend a third of the budget and
  // throw away the clause that says what "pause" means.
  assert.equal(prTitle('bc-lco2', LONG), 'bc-lco2: Pause an EpicAdvocate: stop dispatching under one P0');
});

check('a cut at the author’s own punctuation carries no ellipsis', () => {
  assert.ok(!prTitle('bc-lco2', LONG).includes('…'), 'a comma is a place to stop, not a truncation');
});

check('a cut mid-sentence says so', () => {
  const t = prTitle('bc-y', 'A very long title with absolutely no punctuation anywhere in it that just keeps going and going');
  assert.ok(t.endsWith('…'), t);
  assert.ok(!/[\s,;:—–-]…$/.test(t), `no dangling punctuation before the ellipsis: ${t}`);
});

check('a fragment is not a title — a short head clause is refused', () => {
  // `Fix: …` must not become `bc-f: Fix`, which names nothing at all.
  const t = prTitle('bc-f', 'Fix: the thing that was broken in a way that needs a great many words to describe it');
  assert.ok(t.startsWith('bc-f: Fix: the thing'), t);
});

check('a bead id already at the front is not repeated', () => {
  assert.equal(prTitle('bc-x', 'bc-x: already prefixed'), 'bc-x: Already prefixed');
  assert.equal(prTitle('bc-x', 'bc-x — already prefixed'), 'bc-x: Already prefixed');
});

check('a dotted child id is a literal, not a wildcard', () => {
  // `bc-eqn1.11` in a regex matches `bc-eqn1x11`; the escape is what stops the strip
  // firing on a title that merely looks like it starts with the id.
  assert.equal(prTitle('bc-eqn1.11', 'bc-eqn1.11: documented control'), 'bc-eqn1.11: Documented control');
  assert.equal(prTitle('bc-eqn1.11', 'bc-eqn1x11: documented control'), 'bc-eqn1.11: Bc-eqn1x11: documented control');
});

check('a newline in a title is a broken gh argument, so there are none', () => {
  const t = prTitle('bc-x', 'first line\nsecond   line');
  assert.equal(t, 'bc-x: First line second line');
});

check('a trailing full stop goes and a question mark stays', () => {
  assert.equal(prTitle('bc-x', 'It is done.'), 'bc-x: It is done');
  assert.equal(prTitle('bc-x', 'Is it done?'), 'bc-x: Is it done?');
});

check('nothing to say still says the bead', () => {
  assert.equal(prTitle('bc-x', ''), 'bc-x');
  assert.equal(prTitle('bc-x', '   '), 'bc-x');
});

/* --------------------------------------------------------------------- diffstat */

check('numstat parses, totals, and sorts by size', () => {
  const s = diffstat('10\t2\tbin/deliver.js\n210\t0\tlib/prtext.js\n');
  assert.equal(s.added, 220);
  assert.equal(s.removed, 2);
  assert.deepEqual(
    s.files.map((f) => f.path),
    ['lib/prtext.js', 'bin/deliver.js']
  );
});

check('a binary file counts as a file and not as lines', () => {
  const s = diffstat('-\t-\tpublic/icon.png\n3\t1\tlib/a.js');
  assert.equal(s.files.length, 2);
  assert.equal(s.added, 3);
  assert.equal(s.removed, 1);
  assert.equal(s.files.find((f) => f.path === 'public/icon.png').binary, true);
});

check('a path with spaces in it survives', () => {
  const s = diffstat('1\t0\tdesign/some file.md');
  assert.equal(s.files[0].path, 'design/some file.md');
});

check('noise between the rows is not a row', () => {
  assert.equal(diffstat('warning: LF will be replaced\n1\t0\ta.js\n\n').files.length, 1);
  assert.equal(diffstat('').files.length, 0);
  assert.equal(diffstat(null).files.length, 0);
});

check('a long list stops and says how much it stopped short of', () => {
  const raw = Array.from({ length: 60 }, (_, i) => `1\t0\tfile${i}.js`).join('\n');
  const block = filesBlock(diffstat(raw), 'main');
  assert.ok(block.includes('60 files'), block.slice(0, 120));
  assert.ok(block.includes('… and 20 more'), 'the truncation is stated, never silent');
});

check('nothing changed renders nothing at all', () => {
  assert.equal(filesBlock(diffstat(''), 'main'), '');
  assert.equal(filesBlock(null, 'main'), '');
});

/* ------------------------------------------------------------------------- body */

const STAT = diffstat('10\t2\tbin/deliver.js\n210\t0\tlib/prtext.js');
const base = {
  beadId: 'bc-lco2',
  beadTitle: LONG,
  title: prTitle('bc-lco2', LONG),
  summary: 'Everything that could hold a subtree back held it for contention.\n\nSo the fact is a label.',
  stat: STAT,
  base: 'main',
  owner: 'Adam',
};

/**
 * The two rendering bugs, asserted as properties over every combination of the optional
 * fields rather than against one rendered example — the bug was that a field being absent
 * changed the separators around a field that was present.
 */
check('no paragraph is ever glued to the next one', () => {
  for (const tests of ['', 'npm test — 251/251']) {
    for (const risk of ['', 'the sweep is new']) {
      for (const left of ['', 'the docs']) {
        for (const stat of [null, STAT]) {
          const body = prBody({ ...base, tests, risk, left, stat });
          const lines = body.split('\n');
          for (let i = 1; i < lines.length; i += 1) {
            // setext: a `---` directly under a line of prose is an <h2>, not a rule.
            if (lines[i].trim() === '---') {
              assert.equal(lines[i - 1].trim(), '', `\`---\` under "${lines[i - 1]}" renders as a heading`);
            }
            // and every ** field ** must start its own paragraph
            if (/^\*\*(Tests|Worth knowing|Left undone):/.test(lines[i])) {
              assert.equal(lines[i - 1].trim(), '', `"${lines[i]}" is glued to the line above it`);
            }
          }
        }
      }
    }
  }
});

check('the summary leads — nothing is put in front of it', () => {
  const body = prBody({ ...base, tests: 'npm test' });
  assert.ok(body.startsWith('Everything that could hold'), body.slice(0, 80));
});

check('an absent optional field leaves no empty heading behind', () => {
  const body = prBody({ ...base });
  assert.ok(!body.includes('**Tests:**'), body);
  assert.ok(!body.includes('**Worth knowing:**'), body);
  assert.ok(!body.includes('**Left undone:**'), body);
});

check('a summary that opens by restating the bead title loses that line', () => {
  const body = prBody({ ...base, summary: `${LONG}.\n\nAnd then the real paragraph.` });
  assert.ok(body.startsWith('And then the real paragraph.'), body.slice(0, 80));
});

check('a summary that opens by restating the shortened PR title loses it too', () => {
  const body = prBody({ ...base, summary: 'Pause an EpicAdvocate: stop dispatching under one P0\n\nAnd then the paragraph.' });
  assert.ok(body.startsWith('And then the paragraph.'), body.slice(0, 80));
});

check('a one-line summary that is the title is still the whole summary', () => {
  // Stripping here would leave a pull request with no description at all, which is worse
  // than a description that repeats a title.
  const body = prBody({ ...base, summary: LONG });
  assert.ok(body.startsWith('Pause an EpicAdvocate'), body.slice(0, 60));
});

check('a summary that merely starts similarly is left alone', () => {
  const body = prBody({ ...base, summary: 'Pause an EpicAdvocate and also do six other things.\n\nDetail.' });
  assert.ok(body.startsWith('Pause an EpicAdvocate and also'), body.slice(0, 80));
});

check('the diffstat is in the body and states what it is against', () => {
  const body = prBody({ ...base });
  assert.ok(body.includes('lib/prtext.js'), 'the reconciliation is the point of it');
  assert.ok(body.includes('2 files · +220 −2'), body);
  assert.ok(body.includes('against `main`'), body);
});

check('the two endings say different things about who merges', () => {
  const mine = prBody({ ...base, autoMerge: true });
  const theirs = prBody({ ...base, autoMerge: false });
  assert.ok(mine.includes('merges itself'), mine.slice(-400));
  assert.ok(theirs.includes('not merged until Adam'), theirs.slice(-400));
  assert.notEqual(mine, theirs);
});

check('a space that wants a review says so, and one that does not stays quiet', () => {
  assert.ok(prBody({ ...base, autoMerge: true, requireApproval: true }).includes('approving review'));
  assert.ok(!prBody({ ...base, autoMerge: true, requireApproval: false }).includes('approving review'));
});

check('an in-app edit says why it is being asked about', () => {
  const body = prBody({ ...base, autoMerge: false, editHold: true });
  assert.ok(body.includes('edit mode'), body.slice(-400));
});

check('the footer names the bead in full, since the title could not', () => {
  const body = prBody({ ...base });
  assert.ok(body.includes(LONG), 'the sentence the title had to cut is still somewhere');
});

/* ------------------------------------------------------- bare cross-repo references */

check('a bare #N is found', () => {
  assert.deepEqual(bareRefs('this follows on from #412 in athena-service'), ['#412']);
});

check('a #N inside a url is not a bare reference', () => {
  assert.deepEqual(bareRefs('see https://github.com/Climative/athena-service/pull/412'), []);
  assert.deepEqual(bareRefs('https://example.com/x#412'), []);
});

check('a full url on the same line does not excuse the bare one', () => {
  // This is the exact shape the skill warns about: GitHub links the `#412` to *this*
  // repo and renders the URL beside it, so the sentence looks right and is not.
  assert.deepEqual(bareRefs('#412 (https://github.com/Climative/athena-service/pull/412)'), ['#412']);
});

check('a fenced block is code, not prose', () => {
  assert.deepEqual(bareRefs('ordinary text\n```\n# heading\ncurl -H "x: #12"\n```\n'), []);
});

check('a colour and an anchor are not references', () => {
  assert.deepEqual(bareRefs('the token is #fff and the id is section#2'), []);
});

check('the same reference twice is one warning', () => {
  assert.deepEqual(bareRefs('#7 and again #7'), ['#7']);
});

/* ------------------------------------------------- the declaration lib/landed.js reads */

check('the body declares its bead where beadref looks for it', () => {
  const body = prBody({ ...base });
  const tiers = candidateTiers({ title: 'nothing useful here', branch: 'some-branch', body }, 'bc');
  assert.ok(tiers[0]?.includes('bc-lco2'), `strongest tier was ${JSON.stringify(tiers)}`);
});

check('the declaration survives a hand-written title and a hand-named branch', () => {
  // The case it exists for: `--title "tidy up"` on `worktree-whatever`, where neither of
  // the other two tiers names anything, and lib/landed.js would never close the bead.
  const tiers = candidateTiers({ title: 'tidy up', branch: 'worktree-whatever', body: prBody({ ...base }) }, 'bc');
  assert.equal(tiers[0][0], 'bc-lco2');
});

check('the declaration is its own line, which is what makes it findable', () => {
  assert.match(prBody({ ...base }), /^bead: bc-lco2$/m);
});

check('the footer is the footer whether or not there is a body above it', () => {
  assert.match(footer({ beadId: 'bc-x', owner: 'Adam' }), /^bead: bc-x$/m);
});

if (!process.exitCode) console.log(`prtext: ${passed} checks pass`);
