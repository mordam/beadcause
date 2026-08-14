#!/usr/bin/env node
/**
 * **A sweep card may not outlive its record** — see `recoverSweepCards` in lib/sweepcard.js.
 *
 *     npm test
 *     node test/sweepcardorphan.mjs
 *
 * lib/sweepcard.js keeps one record per card in `~/.config/beadcause/sweep-cards.json`, and
 * `followSweepCards` iterates *the records*. A card whose record has gone is therefore not
 * merely behind — it is unreachable. Nothing visits it, so it can never be amended, can
 * never close, and since bc-9d37.8 its *Answer #n* buttons do nothing either, because
 * `resolveSweepFor` reads the same record to learn which branch to open a window on. What
 * Adam sees is a card asserting, in its own body, that it closes itself when the pull
 * requests come back mergeable — which for that card is untrue and always will be.
 *
 * It is not hypothetical. On 2026-08-14 eight of the thirteen cards filed that day were in
 * exactly that state, dropped by the `keep(id, null)` that ran whenever a card was finished
 * with, before bc-9d37.8 made it conditional (bc-xl7n.35). That particular drop is fixed;
 * the *shape* — a card in a tracker and a record on a disk, kept in step by nothing — is
 * not, and every other way of losing the file ends the same way.
 *
 * So the card is the backstop. It names the merge, the repo, the base and every pull
 * request with its branch, because it was written for a human to read, and that is enough
 * to rebuild the record. Four things are checked here, and the third is the one the bead is
 * actually about:
 *
 * 1. **An orphan is invisible to the follow loop.** The premise; asserted rather than
 *    assumed, because everything else here is only worth having if it is true.
 * 2. **A rebuilt record is the card read back**, not a guess: the same rows, branches,
 *    beads, base and merge number, and no tracker write at all to produce it.
 * 3. **The fix is what clears the inbox.** A recovered card whose pull requests have all
 *    settled closes itself on the next cycle, by the ordinary loop, with nothing done by
 *    hand.
 * 4. **A rebuilt row is never believed.** The states on the card are exactly as stale as
 *    the missing record implies, so every recovered row starts at `recovering` and GitHub
 *    decides — and until it does, nothing is written onto the card, because "we lost our
 *    own bookkeeping" is not news about a pull request.
 *
 * The tracker is a spy and `gh` is a function. Nothing here reaches GitHub or opens a
 * window.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-sweeporphan-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

// After the env, always: CONFIG_DIR resolves once, at module load.
const { SWEEP_CARDS_PATH, describeSweepCard, fileSweepCard, followSweepCards, readSweepCards, recordFromCard, recoverSweepCards, sweepCardTitle } =
  await import(LIB('sweepcard.js'));
const resolvers = await import(LIB('resolvers.js'));

const checkout = path.join(tmp, 'checkout');
fs.mkdirSync(checkout, { recursive: true });
const ws = { name: 'demo', dir: path.join(tmp, 'beads') };
const cfg = { workspaces: [ws], sessionDirs: { demo: checkout } };

/** A `bd` that records what it was asked, and hands back an inbox it was given. */
function fakeBd({ create = 'bc-card', fail = null, human = [] } = {}) {
  return {
    calls: [],
    human,
    async graph() {
      return { issues: [] };
    },
    async show(w, id) {
      this.calls.push({ kind: 'show', id });
      return { id, status: 'open' };
    },
    async listHuman() {
      this.calls.push({ kind: 'listHuman' });
      if (fail === 'listHuman') throw new Error('dolt is locked');
      return this.human;
    },
    async create(w, spec) {
      this.calls.push({ kind: 'create', spec });
      return create;
    },
    async update(w, id, fields) {
      this.calls.push({ kind: 'update', id, fields });
    },
    async close(w, id, reason) {
      this.calls.push({ kind: 'close', id, reason });
      if (fail === 'close') throw new Error('dolt is locked');
    },
  };
}

const swept = (over = {}) => ({
  key: 'demo',
  repo: 'neadamthal/beadcause',
  base: 'trunk',
  after: 231,
  conflicting: [],
  handed: [],
  queued: [],
  reused: [],
  failed: [],
  theirs: [],
  drafts: [],
  mergeable: [],
  unresolved: [],
  trouble: [],
  ...over,
});

const row = (number, over = {}) => ({
  number,
  branch: `worktree-thing-${number}`,
  title: `Thing ${number}`,
  url: `https://github.com/x/y/pull/${number}`,
  beads: [`bc-ab${number}`],
  ...over,
});

const wipe = () => fs.rmSync(SWEEP_CARDS_PATH, { force: true });

/** The card as it is in the tracker, off the `create` the filing made. */
const asBead = (bd, { id = 'bc-card', created_at = '2026-08-14T02:42:26Z' } = {}) => {
  const spec = bd.calls.find((c) => c.kind === 'create').spec;
  return { id, title: spec.title, description: spec.body, status: 'open', created_at };
};

/** GitHub, as `chaseRow` asks it. */
const github = (answer) => async (dir, number) => answer(number);
const mergeable = github((number) => ({ pr: { number, state: 'OPEN', mergeable: 'MERGEABLE' }, unresolved: false }));
const silent = github((number) => ({ pr: { number, state: 'OPEN', mergeable: 'UNKNOWN' }, unresolved: true }));

/* ------------------------------------------------------------ the premise */

console.log('a card whose record is gone is unreachable');

resolvers.reset();
wipe();
let bd = fakeBd();
await fileSweepCard(bd, ws, swept({ handed: [row(14), row(11)] }), { dir: checkout });
const card = asBead(bd);
check('the filing left a record', Object.keys(readSweepCards()).length === 1);

// However it happened — the bug bc-xl7n.35 is about, a config directory that would not
// take the write, a file removed by hand. What matters is only that the card outlived it.
wipe();
bd = fakeBd({ human: [card] });
let out = await followSweepCards(bd, cfg, { mergeability: mergeable });
check('the follow loop never sees it', out.length === 0, JSON.stringify(out));
check('so it is never amended and never closed', bd.calls.length === 0, JSON.stringify(bd.calls.map((c) => c.kind)));

/* ----------------------------------------------------------- the rebuilding */

console.log('\nso the card itself is read back into one');

out = await recoverSweepCards(bd, cfg);
check('one card recovered', out.length === 1 && out[0].recovered === true, JSON.stringify(out));
check('and it says how much there is to re-check', /2 pull requests to re-check/.test(describeSweepCard(out[0])), describeSweepCard(out[0]));
check('nothing was written to the tracker to do it', !bd.calls.some((c) => c.kind !== 'listHuman'), JSON.stringify(bd.calls.map((c) => c.kind)));

let rec = readSweepCards()['bc-card'];
check('the record is back', !!rec, JSON.stringify(readSweepCards()));
check('addressed to the workspace the card is in', rec.workspace === 'demo' && rec.key === 'demo');
check('naming the repo the card names', rec.repo === 'neadamthal/beadcause', rec.repo);
check('and the merge it was filed for', rec.after === 231, String(rec.after));
check('and the base, off the card body rather than assumed', rec.base === 'trunk', rec.base);
check('both pull requests, in order', String(rec.prs.map((r) => r.number)) === '11,14');
check('with the branch a window would have to open on', rec.prs.find((r) => r.number === 14).branch === 'worktree-thing-14');
check('the title it was named by', rec.prs.find((r) => r.number === 11).title === 'Thing 11');
check('and the beads that rode it', String(rec.prs.find((r) => r.number === 11).beads) === 'bc-ab11');
check('when the card was filed, which is not when the record was rebuilt', rec.filedAt === '2026-08-14T02:42:26.000Z', rec.filedAt);
check('and it is marked as rebuilt', rec.recovered === true);

/**
 * The one thing not read back. Whatever the card says a row is, the missing record is
 * proof that nobody has checked lately — and a row recovered straight into `handed-back`
 * is a row `chaseRow` returns unchanged forever, which is the orphan again with extra
 * steps.
 */
check('every row starts at recovering, not at what the card claims', rec.prs.every((r) => r.state === 'recovering'));

/* ---------------------------------------------------- and it is never believed */

console.log('\nand nothing is written onto the card until GitHub has said something');

const quiet = bd.calls.length;
out = await followSweepCards(bd, cfg, { mergeability: silent });
check('a GitHub that will not answer costs no tracker write', !bd.calls.slice(quiet).some((c) => c.kind !== 'listHuman'), JSON.stringify(bd.calls.slice(quiet)));
check('and no outcome, so nothing wakes a phone', out.length === 0, JSON.stringify(out));
check('the record is kept for the next cycle', readSweepCards()['bc-card']?.prs.every((r) => r.state === 'recovering'));
check('and the card is not re-recovered on top of itself', (await recoverSweepCards(bd, cfg)).length === 0);

/* ---------------------------------------------------------- the acceptance */

console.log('\nand a recovered card whose pull requests have settled closes itself');

out = await followSweepCards(bd, cfg, { mergeability: mergeable });
check('closed by the follow loop, with no hand in it', out[0]?.closed === true, JSON.stringify(out));
const closing = bd.calls.find((c) => c.kind === 'close');
check('naming both pull requests in the reason', /#11/.test(closing?.reason || '') && /#14/.test(closing?.reason || ''), closing?.reason);
check('the record is dropped, because there is nothing left to chase', Object.keys(readSweepCards()).length === 0);
check('and it was amended once on the way out, never with `recovering` on it', !/being re-checked/.test(bd.calls.filter((c) => c.kind === 'update').pop()?.fields.description || ''));

console.log('\nand one that still needs him stays, with its buttons working again');

resolvers.reset();
wipe();
bd = fakeBd();
await fileSweepCard(bd, ws, swept({ handed: [row(14), row(11)] }), { dir: checkout });
const waiting = asBead(bd);
wipe();
bd = fakeBd({ human: [waiting] });
await recoverSweepCards(bd, cfg);
const since = [];
out = await followSweepCards(bd, cfg, {
  mergeability: github((number) => ({ pr: { number, state: 'OPEN', mergeable: number === 11 ? 'CONFLICTING' : 'MERGEABLE' }, unresolved: false })),
  said: async (dir, number, from) => {
    since.push(from);
    return 'both sides are load-bearing';
  },
});
check('the card is finished with but not closed', out[0]?.done === true && out[0]?.closed !== true, JSON.stringify(out));
const body = bd.calls.filter((c) => c.kind === 'update').pop()?.fields.description || '';
check('it now says what is actually true of each row', /#14/.test(body) && /mergeable again/.test(body) && /handed back/.test(body), body);
check('with the reason the resolver left', /both sides are load-bearing/.test(body), body);
/**
 * The record was rebuilt a moment ago and the card was filed hours before it, so the
 * comment worth quoting is older than the record. `chaseRow` asks from `filedAt` for that
 * reason — from `at` it would filter out the very sentence it went looking for.
 */
check('asked for from when the card was filed, not from when the record was rebuilt', since.every((s) => s === '2026-08-14T02:42:26.000Z'), JSON.stringify(since));
check('and the record is kept, so his answer has a branch to land on', readSweepCards()['bc-card']?.prs.find((r) => r.number === 11)?.branch === 'worktree-thing-11');

/* ------------------------------------------------------------ the folded card */

console.log('\nand a card that has been folded through several merges is read back whole');

resolvers.reset();
wipe();
bd = fakeBd();
await fileSweepCard(bd, ws, swept({ after: 244, handed: [row(14)] }), { dir: checkout });
// A second merge, the same branch still conflicting: since bc-xl7n.36 this folds into the
// open card rather than filing beside it, and the title and heading both change shape.
await fileSweepCard(bd, ws, swept({ after: 247, handed: [row(14)] }), { dir: checkout });
const amend = bd.calls.filter((c) => c.kind === 'update').pop();
const foldedCard = { id: 'bc-card', title: amend.fields.title, description: amend.fields.description, status: 'open', created_at: '2026-08-14T02:42:26Z' };
check('the fold happened, so this is the shape being tested', /survived 2 merges since #244/.test(foldedCard.title), foldedCard.title);

wipe();
bd = fakeBd({ human: [foldedCard] });
out = await recoverSweepCards(bd, cfg);
check('a folded card is recognised as a sweep card too', out[0]?.recovered === true, JSON.stringify(out));
rec = readSweepCards()['bc-card'];
/**
 * The merges are the point. The title and the heading are written out of them, so a
 * folded card recovered without them would be amended straight back into "#244 left 1
 * conflicting pull request behind it" — the card claiming to be about one merge when it
 * has eaten several, which is the sentence bc-xl7n.36 removed.
 */
check('every merge it was folded through, oldest first', String(rec?.merges) === '244,247', JSON.stringify(rec?.merges));
check('and `after` is the oldest, as `mergesOf` reads a pre-fold record', rec.after === 244, String(rec.after));
check('the base still comes off the folded heading', rec.base === 'trunk', rec.base);
check('and the row survives with its branch', rec.prs[0].branch === 'worktree-thing-14');
check('so the card it is amended back into keeps its folded title', /survived 2 merges since #244/.test(sweepCardTitle(rec)), sweepCardTitle(rec));

/* ------------------------------------------------------------- the refusals */

console.log('\nwhat it will not pick up');

resolvers.reset();
wipe();
bd = fakeBd({
  human: [
    { id: 'bc-ask', title: 'Which of these two should win?', description: 'a question', status: 'open' },
    { id: 'bc-half', title: '#231 left 2 conflicting pull requests behind it in neadamthal/beadcause', description: waiting.description.replace(/^- \[#14\][^\n]*\n[^\n]*\n/m, ''), status: 'open' },
  ],
});
out = await recoverSweepCards(bd, cfg);
check('an ordinary question in the inbox is not a sweep card', !out.some((o) => o.card === 'bc-ask'), JSON.stringify(out));
/**
 * The title counts the rows and the body lists them, and the two were written together. A
 * mismatch means the body is not the one this title belongs to, and half a record is worse
 * than none: it would close the card on behalf of a pull request it never asked about.
 */
check('a card that does not read back whole is refused', out.find((o) => o.card === 'bc-half')?.unreadable === true, JSON.stringify(out));
check('and said, because nothing else would ever mention it', /will not read back/.test(describeSweepCard(out.find((o) => o.card === 'bc-half'))));
check('nothing half-built was written', Object.keys(readSweepCards()).length === 0, JSON.stringify(readSweepCards()));

check('a bead with no title at all is simply not one', recordFromCard({ id: 'x' }, cfg, 'demo') === null);
check('and neither is a body with no rows in it', recordFromCard({ id: 'x', title: '#1 left 1 conflicting pull request behind it in a/b', description: 'nothing here' }, cfg, 'demo') === null);

wipe();
bd = fakeBd({ fail: 'listHuman', human: [] });
out = await recoverSweepCards(bd, cfg);
check('a tracker that will not answer is reported, not thrown', /could not read the inbox/.test(out[0]?.error || ''), JSON.stringify(out));
check('and the log line does not pretend to name a card', /^could not read the inbox/.test(describeSweepCard(out[0])), describeSweepCard(out[0]));

/* -------------------------------------------------- the other way to orphan one */

console.log('\nand a close that fails no longer orphans the card it could not close');

resolvers.reset();
wipe();
bd = fakeBd({ fail: 'close' });
await fileSweepCard(bd, ws, swept({ handed: [row(14)] }), { dir: checkout });
out = await followSweepCards(bd, cfg, { mergeability: mergeable });
check('the failure is reported', /could not close/.test(out[0]?.error || ''), JSON.stringify(out));
check('and the record is kept rather than dropped', Object.keys(readSweepCards()).length === 1, JSON.stringify(readSweepCards()));
bd.calls.length = 0;
out = await followSweepCards(bd, cfg, { mergeability: mergeable });
check('so the next cycle tries the close again', bd.calls.some((c) => c.kind === 'close'), JSON.stringify(bd.calls.map((c) => c.kind)));

/* -------------------------------------------------------------- the wiring */

console.log('\nand the wiring nothing else can see');

const server = fs.readFileSync(LIB('server.js'), 'utf8');
check('the daemon runs the recovery', /recoverSweepCards\(/.test(server), 'nothing ever recovers an orphan');
/**
 * In front of the follow-up and not behind it. `followSweepCards` reads the record file
 * once, at its top, so a card recovered after it has started is a card that waits a whole
 * cycle to be chased for no reason at all.
 */
check(
  'in front of the follow-up, so a card recovered this cycle is chased this cycle',
  server.indexOf('recoverSweepCards(') < server.indexOf('followSweepCards('),
  'the recovery runs after the loop it feeds'
);
check('on a clock of its own rather than every cycle', /RECOVER_EVERY_MS/.test(server), 'the scan runs every poll');

await cleanupTmp(tmp);

console.log(`\n${ran - failures}/${ran} checks passed`);
process.exit(failures ? 1 : 0);
