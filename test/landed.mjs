#!/usr/bin/env node
/**
 * A pull request merged on github.com, and the bead nothing closed.
 *
 *     npm test
 *     node test/landed.mjs
 *
 * beadcause closes a bead on the two paths where it performs the merge itself: the tap
 * on a delivery card, and a worker merging its own pull request. The merge button on
 * github.com is neither, so the bead stayed open, stayed in `bd ready`, and the advocate
 * kept opening sessions on work already in `main` — bc-4irq cost two of them, the second
 * of which existed only to discover the first had landed.
 *
 * Four things are worth asserting, and they are in descending order of what they cost:
 *
 * 1. **The tick does not open a session on landed work.** The whole bead. It is checked
 *    against a spy rather than against iTerm, and the spy is also what makes the test
 *    safe: an assertion that no window opened is worthless if the way it fails is by
 *    opening one. The control case — the same tick with the sweep switched off — is
 *    asserted too, because "no session opened" passes for a dozen uninteresting reasons
 *    and only one of them is the feature.
 * 2. **A bead that already said it landed is left alone.** `bd` clears `closed_at` on
 *    reopen, so an open bead carrying `Landed as [#42](…)` is the only trace of a human
 *    reopening something this closed. Closing it again would not be a bug so much as a
 *    fight: reopen, swept closed, reopen, swept closed.
 * 3. **A refused close writes nothing.** The comment is what the guard above reads, so a
 *    comment left on a bead whose close then failed would blind this to that bead
 *    permanently. The gate is asked before a word is written.
 * 4. **The question closes before the work bead.** A delivery parks its bead behind its
 *    card with `bd dep add`, and bd refuses to close a bead with an open blocker — so
 *    the wrong order fails on precisely the case that most needs this.
 * 5. **And it closes on the merge, not on a bead.** bc-u579: the card close lived inside
 *    the bead loop, so a merged pull request with nothing open behind it — a bead closed
 *    by hand, a bead rule 2 leaves alone, a PR tied to no bead — closed no card, and
 *    nothing else sweeps one. Three cases below, one per way of getting there.
 *
 * `gh` is a fake shell script answering three questions; `bd` is an object that records
 * what it was asked to write. Nothing here reaches GitHub, a tracker, iTerm or a repo of
 * yours.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-landed-'));
process.on('exit', () => removeTreeSync(tmp));

// Before the first import that reaches lib/config.js, which fixes CONFIG_DIR at module
// load: the advocate state file below must land in the temp directory and not in the
// one this Mac actually runs from.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const BIN = path.join(tmp, 'bin');
const REPO = path.join(tmp, 'repo');
const PRS = path.join(tmp, 'prs.json');
const ASKED = path.join(tmp, 'asked.log');
for (const d of [BIN, REPO]) fs.mkdirSync(d, { recursive: true });

fs.writeFileSync(PRS, '[]');
fs.writeFileSync(ASKED, '');
/**
 * A `gh` that honours `--search merged:A..B` and `--limit`, and answers in **creation**
 * order rather than merge order.
 *
 * That last detail is the reason lib/pr.js bisects the window instead of walking it
 * backwards a page at a time, so a fake that answered newest-merged-first would pass a
 * paging bug the real GitHub fails. Verified against this repo on 2026-08-11: sixty rows
 * came back with `mergedAt` non-monotonic.
 *
 * Every `--search` it is given is appended to a log, because "did the sweep ask for a
 * fortnight or for forty rows?" is the whole bead and is otherwise unobservable.
 */
fs.writeFileSync(
  path.join(BIN, 'gh'),
  `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
const arg = (f) => { const i = a.indexOf(f); return i === -1 ? null : a[i + 1]; };
if (a[0] === 'auth' && a[1] === 'status') process.exit(0);
if (a[0] === 'repo' && a[1] === 'view') { console.log('{"nameWithOwner":"mordam/widgets"}'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'list') {
  const rows = JSON.parse(fs.readFileSync(${JSON.stringify(PRS)}, 'utf8'));
  const search = arg('--search') || '';
  fs.appendFileSync(${JSON.stringify(ASKED)}, search + '\\n');
  const range = /merged:(\\S+?)\\.\\.(\\S+)/.exec(search);
  let out = rows;
  if (range) {
    const lo = Date.parse(range[1]);
    const hi = Date.parse(range[2]);
    out = rows.filter((r) => r.mergedAt && Date.parse(r.mergedAt) >= lo && Date.parse(r.mergedAt) <= hi);
  }
  out = out.slice().sort((x, y) => y.number - x.number).slice(0, Number(arg('--limit') || 30));
  console.log(JSON.stringify(out));
  process.exit(0);
}
console.error('unexpected gh: ' + a.join(' '));
process.exit(1);
`,
  { mode: 0o755 }
);
const asked = () => fs.readFileSync(ASKED, 'utf8').split('\n').filter(Boolean);
const forgetAsked = () => fs.writeFileSync(ASKED, '');
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;

const { reconcileLanded, landedReason, describeLanded, describeTruncation, windowDays } = await import(LIB('landed.js'));
const { forgetPrefixes } = await import(LIB('beadref.js'));
const prlib = await import(LIB('pr.js'));

/** Does `merged:A..B` span roughly `days`? Roughly, because both ends round to a second. */
function spans(search, days) {
  const m = /merged:(\S+?)\.\.(\S+)/.exec(search);
  if (!m) return false;
  const width = (Date.parse(m[2]) - Date.parse(m[1])) / 86400000;
  return Math.abs(width - days) < 0.01;
}

/* ------------------------------------------------------------------ harness */

let failures = 0;
let ran = 0;
const ok = (name) => {
  ran += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
};
const bad = (name, detail) => {
  ran += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

/** A merged pull request in `gh pr list --json` vocabulary — what the fake gh serves. */
const mergedRow = (over = {}) => ({
  number: 42,
  url: 'https://github.com/mordam/widgets/pull/42',
  title: 'wg-aaa: fix the thing',
  state: 'MERGED',
  headRefName: 'worktree-fix-the-thing-aaa',
  baseRefName: 'main',
  body: 'Closes wg-aaa once merged.',
  mergedAt: new Date().toISOString(),
  mergeCommit: { oid: 'abc1234def5678' },
  statusCheckRollup: [],
  ...over,
});

/**
 * The same row after lib/pr.js has folded it — which is the only shape `reconcileLanded`
 * ever sees, because `pr.list` is what feeds it.
 *
 * Written out rather than imported so the cases below are honest about the contract:
 * `mergeCommit` is an *object* on the wire and a string by the time anything reads it,
 * and a fixture that skipped the fold let a `[object Object]` into a close reason here
 * before anyone noticed.
 */
const asListed = (row) => ({
  number: row.number,
  url: row.url,
  title: row.title,
  state: String(row.state || '').toUpperCase(),
  branch: row.headRefName || '',
  base: row.baseRefName || '',
  body: row.body || '',
  mergedAt: row.mergedAt || null,
  mergeCommit: row.mergeCommit?.oid || null,
});

/**
 * A tracker that answers and records, with one bead per id.
 *
 * `writes` is the whole assertion surface: every close and comment in the order it was
 * asked for, which is how the ordering claim (question before work bead) is checked
 * without a real bd to refuse it.
 */
function fakeBd(beads, { gate = () => null, comments = () => [], questions = [], live = null } = {}) {
  const rows = new Map(beads.map((b) => [b.id, { status: 'open', title: '', ...b }]));
  const writes = [];
  // Counted, because "how many times did it ask" is itself an assertion below: the card
  // list is the same list every sweep and asking per merged pull request made the cost
  // of a sweep a function of how busy the fortnight had been. `show` is counted for the
  // same reason and it is the one that decides whether a fortnight is affordable — it
  // is what `beadsFor` spends per candidate id on every row it is handed.
  const calls = { listLabel: 0, listLive: 0, show: 0 };
  return {
    writes,
    rows,
    calls,
    async json(_ws, args) {
      // Only `prefixFor` asks, and only for one row: the id's prefix is the answer.
      if (args[0] === 'list') return [{ id: 'wg-1' }];
      return [];
    },
    async listLive() {
      calls.listLive += 1;
      // `live: false` is a tracker that will not answer, which must switch the gate off
      // rather than read as "nothing is open" — see `liveBeads` in lib/landed.js.
      if (live === false) throw new Error('database is locked');
      return live || [...rows.values()].filter((r) => r.status !== 'closed').map((r) => ({ id: r.id }));
    },
    async show(_ws, id) {
      calls.show += 1;
      return rows.get(id) || null;
    },
    async comments(_ws, id) {
      return comments(id);
    },
    async listLabel() {
      calls.listLabel += 1;
      return questions;
    },
    async closeGate(_ws, id) {
      return gate(id);
    },
    async comment(_ws, id, text) {
      writes.push({ kind: 'comment', id, text });
    },
    async close(_ws, id, reason) {
      const refusal = gate(id);
      if (refusal) throw new Error(refusal);
      writes.push({ kind: 'close', id, reason });
      const row = rows.get(id);
      if (row) row.status = 'closed';
    },
    async ready() {
      return [...rows.values()]
        .filter((r) => r.status === 'open' && !(r.labels || []).includes('human'))
        .map((r) => ({ id: r.id, title: r.title, priority: 1, created_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-01T00:00:00Z' }));
    },
  };
}

const ws = (name) => ({ name, dir: path.join(tmp, 'beads', name, '.beads') });

/* ------------------------------------------------- the sweep, on its own */

console.log('\nreconcileLanded');

{
  forgetPrefixes();
  const bd = fakeBd([{ id: 'wg-aaa', title: 'fix the thing' }]);
  const result = await reconcileLanded(bd, ws('one'), REPO, { rows: [asListed(mergedRow())] });
  const closed = bd.writes.filter((w) => w.kind === 'close');
  const said = bd.writes.find((w) => w.kind === 'comment');

  check('an open bead whose PR merged is closed', closed.length === 1 && closed[0].id === 'wg-aaa', JSON.stringify(bd.writes));
  check(
    'the close reason names the PR, the commit and where it merged',
    /#42/.test(closed[0]?.reason || '') && /abc1234/.test(closed[0]?.reason || '') && /on GitHub/.test(closed[0]?.reason || ''),
    closed[0]?.reason
  );
  check('and a comment says so on the bead', /Landed as \[#42\]/.test(said?.text || ''), said?.text);
  check('the result names what it closed', result.closed.length === 1 && result.closed[0].id === 'wg-aaa', JSON.stringify(result));
  check('the sweep reports itself as having run', result.ok === true && result.checked === 1, JSON.stringify(result));
}

{
  forgetPrefixes();
  // The regression that makes this a fight rather than a bug: closed once, reopened by
  // hand, and the comment from the first close is the only evidence that happened.
  const bd = fakeBd([{ id: 'wg-aaa' }], {
    comments: () => [{ text: 'Landed as [#42 as abc1234](https://github.com/mordam/widgets/pull/42) — merged.' }],
  });
  await reconcileLanded(bd, ws('two'), REPO, { rows: [asListed(mergedRow())] });
  check('a bead closed on this PR once and reopened is left alone', bd.writes.length === 0, JSON.stringify(bd.writes));
}

{
  forgetPrefixes();
  // The near-miss of the case above: "Delivered as #42" is a bead *waiting* on a card
  // about #42, which is exactly what should close when #42 turns out to have merged.
  const bd = fakeBd([{ id: 'wg-aaa' }], {
    comments: () => [{ text: 'Delivered as [#42](https://github.com/mordam/widgets/pull/42) on `worktree-fix-the-thing-aaa`.' }],
  });
  await reconcileLanded(bd, ws('three'), REPO, { rows: [asListed(mergedRow())] });
  check('but a bead only *delivered* on it still closes', bd.writes.some((w) => w.kind === 'close'), JSON.stringify(bd.writes));
}

{
  forgetPrefixes();
  const bd = fakeBd([{ id: 'wg-aaa', status: 'closed' }]);
  await reconcileLanded(bd, ws('four'), REPO, { rows: [asListed(mergedRow())] });
  check('an already-closed bead is not written to again', bd.writes.length === 0, JSON.stringify(bd.writes));
}

{
  forgetPrefixes();
  const bd = fakeBd([{ id: 'wg-aaa' }]);
  const result = await reconcileLanded(bd, ws('five'), REPO, { rows: [asListed(mergedRow({ state: 'OPEN', mergedAt: null }))] });
  check('an open PR closes nothing', bd.writes.length === 0 && result.checked === 0, JSON.stringify(bd.writes));
}

{
  forgetPrefixes();
  const old = new Date(Date.now() - 60 * 86400000).toISOString();
  const bd = fakeBd([{ id: 'wg-aaa' }]);
  const result = await reconcileLanded(bd, ws('six'), REPO, { rows: [asListed(mergedRow({ mergedAt: old }))] });
  check(
    'a merge from two months ago is skipped, and says it was',
    bd.writes.length === 0 && result.skipped.some((s) => /days ago/.test(s.why)),
    JSON.stringify(result)
  );
}

{
  forgetPrefixes();
  // The guard behind the guard. A close bd refuses must leave no comment, or the next
  // sweep reads its own "Landed as #42" and skips this bead for good.
  const bd = fakeBd([{ id: 'wg-aaa' }], { gate: (id) => (id === 'wg-aaa' ? 'blocked by 1 open issue' : null) });
  const result = await reconcileLanded(bd, ws('seven'), REPO, { rows: [asListed(mergedRow())] });
  check('a close bd would refuse writes nothing at all', bd.writes.length === 0, JSON.stringify(bd.writes));
  check('and the refusal travels back in bd’s own words', result.skipped.some((s) => /blocked by/.test(s.why)), JSON.stringify(result));
}

{
  forgetPrefixes();
  // The shape `Bd.closeGate` actually answers with, which is not a string: it is
  // `{ kind, blockers, reason }`, and lib/server.js and lib/owed.js both read `.reason`.
  // This file interpolated the object, so the one line the advocate prints about a bead
  // it could not close said `left bc-goo open — [object Object]`. A dry run over the real
  // fortnight hit it twelve times in a single tick.
  const bd = fakeBd([{ id: 'wg-aaa' }], {
    gate: (id) => (id === 'wg-aaa' ? { kind: 'epic', blockers: [{ id: 'wg-kid' }], reason: 'an epic with 1 open child issue' } : null),
  });
  const result = await reconcileLanded(bd, ws('seven-b'), REPO, { rows: [asListed(mergedRow())] });
  check(
    'and an object refusal is read for its sentence, not stringified',
    result.skipped.some((s) => s.why === 'an epic with 1 open child issue'),
    JSON.stringify(result.skipped)
  );
}

{
  forgetPrefixes();
  const questions = [
    {
      id: 'wg-card',
      status: 'open',
      description: 'Merge #42?\n\n```beadpr\nworkspace: widgets\nbead: wg-aaa\nnumber: 42\nurl: https://github.com/mordam/widgets/pull/42\nbranch: worktree-fix-the-thing-aaa\nbase: main\nmethod: merge\n```',
    },
  ];
  const bd = fakeBd([{ id: 'wg-aaa' }], { questions });
  await reconcileLanded(bd, ws('eight'), REPO, { rows: [asListed(mergedRow())] });
  const order = bd.writes.filter((w) => w.kind === 'close').map((w) => w.id);
  check('the stale delivery card closes too', order.includes('wg-card'), JSON.stringify(bd.writes));
  check(
    'and it closes before the bead it blocks, or bd would refuse that close',
    order.indexOf('wg-card') === 0 && order.indexOf('wg-aaa') === 1,
    JSON.stringify(order)
  );
}

/**
 * The card on its own — bc-u579, and the three ordinary ways to reach it.
 *
 * The card close used to live *inside* the bead loop, so it only ever happened while some
 * bead behind the pull request was still open and unskipped. Each case below is a merged
 * pull request with no such bead, and nothing else in beadcause sweeps a delivery card:
 * before the fix each of these left one in the inbox permanently.
 */
const deliveryCard = (over = {}) => ({
  id: 'wg-card',
  status: 'open',
  description:
    'Merge #42?\n\n```beadpr\nworkspace: widgets\nbead: wg-aaa\nnumber: 42\nurl: https://github.com/mordam/widgets/pull/42\nbranch: worktree-fix-the-thing-aaa\nbase: main\nmethod: merge\n```',
  ...over,
});

{
  forgetPrefixes();
  // Somebody closed the work bead by hand — from the terminal, or from another session
  // that noticed the merge first. The card is still on the phone asking to merge #42.
  const bd = fakeBd([{ id: 'wg-aaa', status: 'closed' }], { questions: [deliveryCard()] });
  const result = await reconcileLanded(bd, ws('nine'), REPO, { rows: [asListed(mergedRow())] });
  const closed = bd.writes.filter((w) => w.kind === 'close').map((w) => w.id);
  check('a card closes even though its work bead was already closed', closed.length === 1 && closed[0] === 'wg-card', JSON.stringify(bd.writes));
  check('and the result names the card it closed', result.cards.length === 1 && result.cards[0].id === 'wg-card', JSON.stringify(result));
}

{
  forgetPrefixes();
  // Rule 2: the bead was closed on this PR once and reopened, so it is left alone — but
  // the reopening says nothing about whether #42 merged, and the card only asks that.
  const bd = fakeBd([{ id: 'wg-aaa' }], {
    questions: [deliveryCard()],
    comments: () => [{ text: 'Landed as [#42 as abc1234](https://github.com/mordam/widgets/pull/42) — merged.' }],
  });
  await reconcileLanded(bd, ws('ten'), REPO, { rows: [asListed(mergedRow())] });
  const closed = bd.writes.filter((w) => w.kind === 'close').map((w) => w.id);
  check('a card closes even where rule 2 leaves the bead reopened', closed.length === 1 && closed[0] === 'wg-card', JSON.stringify(bd.writes));
}

{
  forgetPrefixes();
  // No bead at all: a hand-opened pull request, or a tracker that would not hand back
  // the ids this tick. The card still states the number it acts on, and that is enough.
  const bd = fakeBd([{ id: 'wg-aaa' }], { questions: [deliveryCard()] });
  const row = asListed(mergedRow({ title: 'tidy the readme', body: 'no bead named here', headRefName: 'patch-1' }));
  await reconcileLanded(bd, ws('eleven'), REPO, { rows: [row] });
  const closed = bd.writes.filter((w) => w.kind === 'close').map((w) => w.id);
  check('a card closes for a PR that resolves to no bead at all', closed.length === 1 && closed[0] === 'wg-card', JSON.stringify(bd.writes));
}

{
  forgetPrefixes();
  // A card is not a bead, and a tick that closed only one must still say so: the summary
  // is what reaches the log and the advocate's own line on the screen.
  const bd = fakeBd([{ id: 'wg-aaa', status: 'closed' }], { questions: [deliveryCard()] });
  const result = await reconcileLanded(bd, ws('twelve'), REPO, { rows: [asListed(mergedRow())] });
  const line = describeLanded(result);
  check('and a card-only sweep still describes itself', /delivery card/.test(line) && /wg-card \(#42\)/.test(line), JSON.stringify(line));
}

{
  forgetPrefixes();
  // The card whose PR has not merged is the reason this is keyed on the number: an open
  // pull request must leave its card exactly where it is.
  const bd = fakeBd([{ id: 'wg-aaa' }], { questions: [deliveryCard()] });
  await reconcileLanded(bd, ws('thirteen'), REPO, { rows: [asListed(mergedRow({ state: 'OPEN', mergedAt: null }))] });
  check('but an open PR still closes no card', bd.writes.length === 0, JSON.stringify(bd.writes));
}

{
  forgetPrefixes();
  // The card list is asked once for the sweep, not once for every merged pull request.
  // `bd` here is a subprocess and a Dolt read, so the old shape charged a query per row
  // — and the rows are the busiest thing about a busy week.
  const bd = fakeBd([{ id: 'wg-aaa' }], { questions: [deliveryCard()] });
  const rows = [1, 2, 3].map((n) => asListed(mergedRow({ number: 40 + n, title: `wg-b${n}: something` })));
  await reconcileLanded(bd, ws('fourteen'), REPO, { rows });
  check('the delivery cards are listed once per sweep, not once per pull request', bd.calls.listLabel === 1, `listLabel called ${bd.calls.listLabel}×`);
}

{
  forgetPrefixes();
  // bc-8ug and bc-jin: forty merged pull requests is under a day on this repo, so the
  // fourteen-day window is a ceiling the query cap never lets it reach — and a bead that
  // falls out the far end falls out for good, because the next sweep asks the same
  // question of a window that has moved further forward. Saying so is the whole fix here.
  const bd = fakeBd([{ id: 'wg-aaa', status: 'closed' }]);
  const rows = [1, 2, 3].map((n) => asListed(mergedRow({ number: 40 + n, title: `wg-b${n}: something` })));
  const result = await reconcileLanded(bd, ws('fifteen'), REPO, { rows, limit: 3 });
  check('a full query that never reached the cutoff reports the cap that stopped it', !!result.truncated, JSON.stringify(result.truncated));
  check('and says how far back it did reach', result.truncated?.limit === 3 && /nothing merged earlier than/.test(describeTruncation(result.truncated)), describeTruncation(result.truncated));
}

{
  forgetPrefixes();
  // The control. One row past the cutoff proves the *window* decided where to stop, so
  // there is nothing beyond it this failed to look at, and nothing to warn about.
  const bd = fakeBd([{ id: 'wg-aaa', status: 'closed' }]);
  const old = new Date(Date.now() - 60 * 86400000).toISOString();
  const rows = [asListed(mergedRow({ number: 41 })), asListed(mergedRow({ number: 40, mergedAt: old }))];
  const result = await reconcileLanded(bd, ws('sixteen'), REPO, { rows, limit: 2 });
  check('but a query that aged a row out is not truncated — the window decided, not the cap', result.truncated === null, JSON.stringify(result.truncated));
}

{
  forgetPrefixes();
  // The summary is written when a tick *did* something; the reach is true every ten
  // minutes until the repo quietens, so it rides along rather than speaking on its own.
  const bd = fakeBd([{ id: 'wg-aaa' }]);
  const rows = [1, 2].map((n) => asListed(mergedRow({ number: 40 + n, title: n === 1 ? 'wg-aaa: fix the thing' : 'wg-zzz: other' })));
  const result = await reconcileLanded(bd, ws('seventeen'), REPO, { rows, limit: 2 });
  check('a sweep that closed something mentions the cap in its summary', /query cap/.test(describeLanded(result)), describeLanded(result));
  check('and a sweep that closed nothing stays quiet in the summary', describeLanded({ ok: true, closed: [], cards: [], truncated: result.truncated }) === '', 'expected an empty summary');
}

/* ------------------------------------------------- and this Mac's own main */

/**
 * bc-6sqs. A worker's delivery brings the main checkout up after its merge, and so does
 * the tap on the pull request board — which left exactly one door into `main` that did
 * not: a pull request merged on github.com itself, which is the door this whole file
 * exists for. The bead closed, the board drew merged, and local `main` stayed behind
 * until something else happened to fetch, so every worktree cut afterwards branched from
 * before the merge.
 *
 * `landLocally` is injected here rather than run: what is being asserted is *when* the
 * sweep asks for the fast-forward and what it does with the answer. That it refuses a
 * dirty checkout is lib/prboard.js's claim and test/prboard.mjs's to make.
 */
console.log('\nbringing this Mac up');

const spyLand = (answer = { fetched: true, advanced: true, note: 'fast-forwarded main to origin/main' }) => {
  const calls = [];
  const land = async (dir, base) => {
    calls.push({ dir, base });
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { calls, land };
};

{
  forgetPrefixes();
  const bd = fakeBd([{ id: 'wg-aaa', title: 'fix the thing' }]);
  const spy = spyLand();
  const result = await reconcileLanded(bd, ws('land-one'), REPO, { rows: [asListed(mergedRow())], land: spy.land });
  check('a sweep that closed a bead fast-forwards the checkout it swept', spy.calls.length === 1, JSON.stringify(spy.calls));
  check('the checkout and the base are the sweep’s own', spy.calls[0]?.dir === REPO && spy.calls[0]?.base === 'main', JSON.stringify(spy.calls[0]));
  check('and what happened travels back for the log', /fast-forwarded/.test(result.landed?.note || ''), JSON.stringify(result.landed));
}

{
  forgetPrefixes();
  // The ordinary tick: a fortnight of merges whose beads are all closed already. Asking
  // git anything here is a fetch per repo per interval — forty of them on a workspace
  // like climative — for an answer that is nearly always "nothing to do".
  const bd = fakeBd([{ id: 'wg-aaa', status: 'closed' }], { live: [] });
  const spy = spyLand();
  const result = await reconcileLanded(bd, ws('land-two'), REPO, { rows: [asListed(mergedRow())], land: spy.land });
  check('a sweep that closed nothing does not touch the checkout at all', spy.calls.length === 0, JSON.stringify(spy.calls));
  check('and says nothing about it', result.landed === null, JSON.stringify(result.landed));
}

{
  forgetPrefixes();
  // A stale delivery card closing is still this daemon noticing a merge it did not
  // perform, which is the whole trigger — the bead behind it having been closed by hand
  // does not put the checkout any less far behind.
  const bd = fakeBd([{ id: 'wg-aaa', status: 'closed' }], { questions: [deliveryCard()], live: [] });
  const spy = spyLand();
  await reconcileLanded(bd, ws('land-three'), REPO, { rows: [asListed(mergedRow())], land: spy.land });
  check('closing only a stale card is still enough to bring main up', spy.calls.length === 1, JSON.stringify(spy.calls));
}

/*
 * And the other thing a merge nothing here performed leaves behind — bc-9d37.4, rule 5.
 *
 * The same gate as the fast-forward above and for a reason one sentence along from it: a
 * merge does not only leave this laptop behind, it leaves every branch still open on that
 * base measured against a base it has never seen. Three of the four doors into `main`
 * know the moment they merge; this is the one where the trigger arrives late and still
 * has to fire once. `requestSweep` is injected because the sweep itself belongs to the
 * daemon and nothing in this repo's tests may open an iTerm window — lib/mergesweep.js
 * and test/mergesweep.mjs are where what it asks for is acted on.
 */
const spySweep = () => {
  const calls = [];
  return { calls, request: (rec) => (calls.push(rec), rec) };
};

{
  forgetPrefixes();
  const bd = fakeBd([{ id: 'wg-aaa', title: 'fix the thing' }]);
  const spy = spyLand();
  const swept = spySweep();
  const result = await reconcileLanded(bd, ws('sweep-one'), REPO, {
    rows: [asListed(mergedRow())],
    key: 'sweep-one',
    land: spy.land,
    request: swept.request,
  });
  check('a sweep that closed a bead asks for the conflict sweep too', swept.calls.length === 1, JSON.stringify(swept.calls));
  check('for the repo it swept, keyed the way resolvers are', swept.calls[0]?.key === 'sweep-one' && swept.calls[0]?.workspace === 'sweep-one');
  check('naming the merge it just found out about', swept.calls[0]?.number === mergedRow().number, JSON.stringify(swept.calls[0]));
  check('and the request travels back on the result', result.swept?.key === 'sweep-one', JSON.stringify(result.swept));
}

{
  forgetPrefixes();
  // The ordinary tick again, and the same argument as the fetch above: a `gh pr list` per
  // repo per interval, on a workspace of forty checkouts, for an answer that is nearly
  // always "nothing conflicts".
  const bd = fakeBd([{ id: 'wg-aaa', status: 'closed' }], { live: [] });
  const swept = spySweep();
  const result = await reconcileLanded(bd, ws('sweep-two'), REPO, { rows: [asListed(mergedRow())], land: spyLand().land, request: swept.request });
  check('a sweep that closed nothing asks for nothing', swept.calls.length === 0, JSON.stringify(swept.calls));
  check('and says so', result.swept === null, JSON.stringify(result.swept));
}

{
  forgetPrefixes();
  // No key from the caller. Right for every single-repo workspace and refused rather than
  // resolved for the others, which is `unitFor`'s job and not this file's.
  const bd = fakeBd([{ id: 'wg-aaa', title: 'fix the thing' }]);
  const swept = spySweep();
  await reconcileLanded(bd, ws('sweep-three'), REPO, { rows: [asListed(mergedRow())], land: spyLand().land, request: swept.request });
  check('a caller that names no repo gets the workspace name', swept.calls[0]?.key === 'sweep-three', JSON.stringify(swept.calls[0]));
}

{
  forgetPrefixes();
  const bd = fakeBd([{ id: 'wg-aaa', title: 'fix the thing' }]);
  const spy = spyLand(new Error('fatal: could not read from remote repository'));
  const result = await reconcileLanded(bd, ws('land-four'), REPO, { rows: [asListed(mergedRow())], land: spy.land });
  check('a git that will not answer does not cost the bead its close', bd.writes.some((w) => w.kind === 'close'), JSON.stringify(bd.writes));
  check('and the failure is a sentence rather than a throw', /could not bring local main up/.test(result.landed?.note || ''), JSON.stringify(result.landed));
}

/* ------------------------------------------ the window, and what it costs to reach */

/**
 * bc-fwfz. The fourteen days above were decoration: the sweep asked for the forty most
 * recent merges and then filtered *those* to a fortnight, and forty merges is under a day
 * on this repo. A bead past the fortieth row did not fall out for a fortnight, it fell out
 * for good — the next sweep asked the same question of a window that had moved further
 * forward, so nothing ever looked again. bc-8ug and bc-jin were closed by hand.
 *
 * The reason it was a cap and not a window is the cost, and that is what these assert.
 * `beadsFor` spends a `bd show` per candidate id on every row it is handed, so widening
 * the window used to multiply subprocesses by how busy the fortnight had been. It no
 * longer does, and the counter on the fake tracker is the proof.
 */
console.log('\nthe window it says it has');

{
  forgetPrefixes();
  forgetAsked();
  // A fortnight of merges, all of them for beads that are already closed — the ordinary
  // state of a busy repo, and the one the old cap was protecting against.
  const bd = fakeBd([...Array(60)].map((_, i) => ({ id: `wg-c${i}`, status: 'closed' })));
  const rows = [...Array(60)].map((_, i) =>
    asListed(mergedRow({ number: 100 + i, title: `wg-c${i}: something`, body: `Closes wg-c${i}.`, headRefName: `worktree-thing-c${i}` }))
  );
  const result = await reconcileLanded(bd, ws('window-cheap'), REPO, { rows });
  check('every row in the window is considered', result.checked === 60, `checked ${result.checked}`);
  check(
    'but a row whose beads are all closed costs no bd show at all',
    bd.calls.show === 0,
    `${bd.calls.show} bd show call(s) for 60 merged pull requests`
  );
  check('and the live list is asked for once, not once per row', bd.calls.listLive === 1, `listLive called ${bd.calls.listLive}×`);
}

{
  forgetPrefixes();
  // The control, and the point: the gate must not be able to skip the one row that
  // matters. Fifty-nine settled merges and one that is still open behind it.
  const beads = [...Array(59)].map((_, i) => ({ id: `wg-c${i}`, status: 'closed' }));
  beads.push({ id: 'wg-live', title: 'still open' });
  const bd = fakeBd(beads);
  const rows = [...Array(59)].map((_, i) =>
    asListed(mergedRow({ number: 100 + i, title: `wg-c${i}: something`, body: `Closes wg-c${i}.`, headRefName: `worktree-thing-c${i}` }))
  );
  rows.push(asListed(mergedRow({ number: 999, title: 'wg-live: still open', body: 'Closes wg-live.', headRefName: 'worktree-still-open-live' })));
  const result = await reconcileLanded(bd, ws('window-finds'), REPO, { rows });
  check(
    'the one row with a live bead behind it is still closed, sixty merges deep',
    result.closed.length === 1 && result.closed[0].id === 'wg-live',
    JSON.stringify(result.closed)
  );
}

{
  forgetPrefixes();
  // A tracker that will not answer must switch the gate off, not read as "nothing is
  // open". The permissive direction is the only safe one: the worst a disabled gate
  // costs is one expensive sweep, and the worst an empty one costs is every close.
  const bd = fakeBd([{ id: 'wg-aaa', title: 'fix the thing' }], { live: false });
  const result = await reconcileLanded(bd, ws('window-blind'), REPO, { rows: [asListed(mergedRow())] });
  check('an unreadable live list gates nothing out', result.closed.length === 1 && result.closed[0].id === 'wg-aaa', JSON.stringify(result));
}

{
  forgetPrefixes();
  // And a bead the live list does not know about is still not skipped on the strength of
  // a *stale* list: the gate reads open beads, so an id it has never heard of falls
  // through to `beadsFor` exactly as before.
  const bd = fakeBd([{ id: 'wg-aaa', title: 'fix the thing' }], { live: [{ id: 'wg-aaa' }, { id: 'wg-other' }] });
  const result = await reconcileLanded(bd, ws('window-stale'), REPO, { rows: [asListed(mergedRow())] });
  check('a live list naming the bead lets the row through', result.closed.length === 1, JSON.stringify(result.closed));
}

{
  forgetPrefixes();
  forgetAsked();
  // Through the real fetch, which is where the bead actually lives: the sweep must ask
  // GitHub for a span of *time*. Nothing here filters to forty rows.
  const bd = fakeBd([{ id: 'wg-aaa', title: 'fix the thing' }]);
  fs.writeFileSync(PRS, JSON.stringify([mergedRow()]));
  const result = await reconcileLanded(bd, ws('window-query'), REPO);
  const q = asked();
  check('the sweep asks GitHub for a date range, not for the N most recent', q.length === 1 && /^merged:\d{4}-\d\d-\d\dT/.test(q[0]), JSON.stringify(q));
  check('and the range it asks for is the fourteen days the file advertises', /\.\./.test(q[0]) && spans(q[0], windowDays()), q[0]);
  check('the row inside it still closes its bead', result.closed.length === 1 && result.closed[0].id === 'wg-aaa', JSON.stringify(result.closed));
  check('and nothing is reported as out of reach', result.truncated === null, JSON.stringify(result.truncated));
}

/* --------------------------------------------------- and the paging underneath it */

/**
 * `pr.listMergedSince` on its own, because the paging is the part with a wrong answer
 * available to it.
 *
 * The obvious loop — take the oldest row you got, ask again for everything older — is
 * what this deliberately is not. `gh pr list --search` answers in *creation* order, so a
 * full page is an arbitrary subset with respect to `mergedAt`, and moving the bound to
 * its minimum steps straight over every row that merged in between and was not on that
 * page. The fake `gh` above reproduces that ordering on purpose; a fake that answered
 * newest-merged-first would let the broken version pass.
 */
console.log('\nlistMergedSince');

{
  forgetAsked();
  // Sixty merges, one a second, against a per-query limit of twenty. Only halving the
  // interval covers this, and the assertion is that every one of the sixty came back.
  const base = Date.parse('2026-06-01T12:00:00Z');
  fs.writeFileSync(
    PRS,
    JSON.stringify([...Array(60)].map((_, i) => mergedRow({ number: 300 + i, mergedAt: new Date(base + i * 1000).toISOString() })))
  );
  const got = await prlib.listMergedSince(REPO, { since: base - 5000, until: base + 65000, limit: 20 });
  check('every merge in the window comes back, however many queries that takes', got.rows.length === 60, `${got.rows.length} of 60 in ${asked().length} queries`);
  check('and it says so', got.complete === true && got.cap === null, JSON.stringify({ complete: got.complete, cap: got.cap }));
  check('newest first, whatever order GitHub answered in', got.rows[0].number === 359 && got.rows.at(-1).number === 300, `${got.rows[0].number}…${got.rows.at(-1).number}`);
  check('the rows are folded the way the sweep reads them', got.rows[0].mergeCommit === 'abc1234def5678' && got.rows[0].branch === 'worktree-fix-the-thing-aaa', JSON.stringify(got.rows[0]).slice(0, 160));
  // Both ends, and the upper one is the point. Halving is correct at any cost and a
  // sweep runs every ten minutes, so a paging change that quietly triples the round
  // trips is a regression even while every row still comes back. Three rounds cover
  // this fixture; twelve is room to be a little worse without being silent about it.
  check('at a query count that pays for itself', asked().length > 1 && asked().length <= 12, `${asked().length} queries`);
}

{
  forgetAsked();
  // The one thing halving cannot solve: more merges inside a single second than a query
  // will answer with. There is nothing left to split, so it says it fell short and names
  // the number that stopped it, rather than reporting a covered window.
  const base = Date.parse('2026-06-02T12:00:00Z');
  fs.writeFileSync(PRS, JSON.stringify([...Array(5)].map((_, i) => mergedRow({ number: 400 + i, mergedAt: new Date(base).toISOString() }))));
  const got = await prlib.listMergedSince(REPO, { since: base - 4000, until: base + 4000, limit: 2 });
  check('a second with more merges in it than a query can answer is reported, not hidden', got.complete === false, JSON.stringify(got.cap));
  check('and the cap it names is the one that bit', got.cap === 2, String(got.cap));
}

{
  forgetAsked();
  // A window with nothing in it is one query and an empty answer, not an error and not
  // a bisection: the sweep runs every ten minutes on repos that merged nothing.
  const got = await prlib.listMergedSince(REPO, { since: Date.parse('2020-01-01T00:00:00Z'), until: Date.parse('2020-01-02T00:00:00Z'), limit: 10 });
  check('an empty window costs exactly one query', got.rows.length === 0 && got.complete === true && asked().length === 1, `${asked().length} queries`);
}

fs.writeFileSync(PRS, '[]');

check(
  'landedReason is one sentence naming the PR, the commit and the base',
  landedReason({ number: 7, mergeCommit: 'deadbeefcafe' }, 'main') === 'Merged #7 as deadbeef into main on GitHub',
  landedReason({ number: 7, mergeCommit: 'deadbeefcafe' }, 'main')
);

/* ---------------------------------------------------- and through the tick */

console.log('\nthe advocate tick');

const { createAdvocates } = await import(LIB('advocate.js'));

/**
 * One tick, with the launcher replaced by a spy.
 *
 * `open` is injected rather than stubbed through the module system for a reason worth
 * stating: the real one drives iTerm, and a test asserting that no window opened must
 * not be able to fail by opening one.
 */
async function tickWith(bd, { reconcileLanded: on = true } = {}) {
  const workspace = { name: 'widgets', dir: path.join(tmp, 'beads', 'widgets', '.beads') };
  const opened = [];
  const cfg = {
    workspaces: [workspace],
    spaces: [],
    claudeSessions: false,
    sessionDirs: { widgets: REPO },
    pr: { enabled: true, base: 'main' },
    advocates: {
      enabled: true,
      workspaces: ['*'],
      settleSeconds: 0,
      launchCooldownSeconds: 0,
      // Off: they are other features with their own suites, and both would otherwise
      // run real git and a real agent against a temp directory on every case here.
      tidyWorktrees: false,
      propose: false,
      respectQuietHours: false,
      sessionLog: false,
      reconcileLanded: on,
    },
  };
  const advocates = createAdvocates(cfg, {
    bd,
    bus: { emit() {} },
    open: async (_cfg, _ws, bead) => {
      opened.push(bead.id);
      return { dir: REPO, mode: 'test', term: null };
    },
  });
  await advocates.tick();
  return { opened, advocates };
}

fs.writeFileSync(PRS, JSON.stringify([mergedRow()]));

{
  forgetPrefixes();
  const bd = fakeBd([{ id: 'wg-aaa', title: 'fix the thing' }]);
  const { opened } = await tickWith(bd);
  check('the tick closes the bead whose PR merged on GitHub', bd.rows.get('wg-aaa').status === 'closed', JSON.stringify(bd.writes));
  check('and opens no session on it', opened.length === 0, `opened: ${opened.join(', ')}`);
}

{
  forgetPrefixes();
  // The control. Without this the case above passes for any reason at all — a cooldown,
  // a settle window, a config typo — and would keep passing with the feature removed.
  const bd = fakeBd([{ id: 'wg-aaa', title: 'fix the thing' }]);
  const { opened } = await tickWith(bd, { reconcileLanded: false });
  check('with the sweep off, that same tick does open one', opened.includes('wg-aaa'), `opened: ${opened.join(', ')}`);
  check('and the bead is still open', bd.rows.get('wg-aaa').status === 'open');
}

console.log(`\n${ran - failures}/${ran} passed`);
process.exit(failures ? 1 : 0);
