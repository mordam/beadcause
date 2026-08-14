#!/usr/bin/env node
/**
 * **One card per sweep** — what conflicted, what got fixed, and what needs Adam.
 *
 *     npm test
 *     node test/sweepcard.mjs
 *
 * lib/prsweep.js decides which pull requests a merge put out of date and lib/resolvers.js
 * opens the windows; test/prsweep.mjs and test/prfull.mjs cover both. What has no surface
 * of its own is the twenty minutes *after* that, which is the whole of what lib/sweepcard.js
 * is for — and it is a part of the system where being wrong is silent by construction:
 *
 * 1. **A card that never gets amended.** The states it is filed with are all `working`,
 *    and a card frozen there is a card claiming two sessions are running hours after they
 *    stopped. So the states are chased off the two things that outlive a session — the
 *    resolver registry and GitHub — and never off the resolver's own claim.
 * 2. **A card that never closes.** The epic asks for the pull requests to be left
 *    mergeable "with no tap in between", so a sweep that ends with everything resolved has
 *    to take its own card back out of the inbox. One that ends with a hand-back must not.
 * 3. **A card per sweep that found nothing.** A merge that conflicts nobody is the
 *    ordinary case, several times a day, and a card each time is the inbox reporting the
 *    weather.
 * 4. **A hand-back with no reason on it.** GitHub can say a branch still conflicts; only
 *    the session that gave up can say why both sides were load-bearing. It is told to
 *    leave that on the pull request (`RESOLVER_SAYS`) precisely because the window it
 *    would otherwise say it in closes when it stops, and a comment from *last* week's
 *    conflict quoted as this week's reason would be a falsehood with a timestamp on it.
 * 5. **A tracker write every cycle.** The follow-up runs every slow cycle forever; one
 *    that amended whether or not anything moved would be a `bd` write and a woken phone
 *    every two minutes, saying the same thing each time.
 *
 * The tracker is a spy, `gh` is a pair of functions, and the resolver registry is the real
 * one from lib/resolvers.js — the states are read out of it, so a fake would be a test of
 * the fake. Nothing here opens a window and nothing here reaches GitHub.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-sweepcard-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

// After the env, always: CONFIG_DIR resolves once, at module load.
const {
  SWEEP_CARDS_PATH,
  chaseRow,
  describeSweepCard,
  fileSweepCard,
  followSweepCards,
  readSweepCards,
  resolverSaid,
  markResolving,
  rowsOf,
  settledReason,
  sweepAnswer,
  sweepCardBody,
  sweepCardTitle,
  tally,
} = await import(LIB('sweepcard.js'));
const resolvers = await import(LIB('resolvers.js'));
const { toQuestion } = await import(LIB('decision.js'));
const { conflictPromptFor, RESOLVER_SAYS } = await import(LIB('session.js'));

const checkout = path.join(tmp, 'checkout');
fs.mkdirSync(checkout, { recursive: true });
const ws = { name: 'demo', dir: path.join(tmp, 'beads') };
const cfg = { workspaces: [ws], sessionDirs: { demo: checkout } };

/** A `bd` that records what it was asked to do and answers plausibly. */
function fakeBd({ create = 'bc-card', fail = null, status = 'open' } = {}) {
  return {
    calls: [],
    /** What `stillOpen` asks, and the only thing that ends a record waiting on Adam. */
    status,
    async graph() {
      return { issues: [] };
    },
    async show(w, id) {
      this.calls.push({ kind: 'show', workspace: w?.name, id });
      if (fail === 'show') throw new Error('dolt is locked');
      return { id, status: this.status };
    },
    async create(w, spec) {
      this.calls.push({ kind: 'create', workspace: w?.name, spec });
      if (fail === 'create') throw new Error('dolt is locked');
      return create;
    },
    async update(w, id, fields) {
      this.calls.push({ kind: 'update', workspace: w?.name, id, fields });
      if (fail === 'update') throw new Error('dolt is locked');
    },
    async close(w, id, reason) {
      this.calls.push({ kind: 'close', workspace: w?.name, id, reason });
      if (fail === 'close') throw new Error('dolt is locked');
    },
  };
}

/** One sweep result, in the shape lib/prsweep.js hands back. */
const swept = (over = {}) => ({
  key: 'demo',
  repo: 'neadamthal/beadcause',
  base: 'main',
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
  beads: [`bc-${number}`],
  ...over,
});

const wipe = () => fs.rmSync(SWEEP_CARDS_PATH, { force: true });

/* ------------------------------------------------------------------ the rows */

console.log('what a sweep result becomes');

const rows = rowsOf(
  swept({
    handed: [row(14)],
    queued: [row(11), { ...row(9), note: '#9 is 2nd in line' }],
    reused: [{ ...row(12), note: 'told the session already on it' }],
    failed: [{ ...row(20), why: 'iTerm refused the Apple event' }],
  })
);
check('every pull request the sweep acted on is a row', rows.length === 5, JSON.stringify(rows.map((r) => r.number)));
check('in number order, so the card does not shuffle between amendments', String(rows.map((r) => r.number)) === '9,11,12,14,20');
check('a window that opened is working', rows.find((r) => r.number === 14).state === 'working');
check('a queued one is queued', rows.find((r) => r.number === 11).state === 'queued');
// A session that already had it and a session just opened for it are the same fact to
// somebody reading the card: something is happening, nothing is needed.
check('a session that was already on it is working too', rows.find((r) => r.number === 12).state === 'working');
check('a window that would not open is a failure from the start', rows.find((r) => r.number === 20).state === 'failed');
check('and it carries why', rows.find((r) => r.number === 20).note === 'iTerm refused the Apple event');
check('the beads travel with the row', String(rows.find((r) => r.number === 14).beads) === 'bc-14');
// Everything the sweep *left alone* is the board's ordinary contents. A card listing a
// teammate's branch and three drafts buries the two rows that are actually about it.
check(
  'a sweep that only left things alone acts on nothing',
  rowsOf(swept({ theirs: [row(1)], drafts: [row(2)], mergeable: [row(3)], unresolved: [row(4)], trouble: [row(5)] })).length === 0
);

/* ---------------------------------------------------------------- the filing */

console.log('\na sweep that found nothing files nothing');

wipe();
let bd = fakeBd();
check('nothing acted on, no card', (await fileSweepCard(bd, ws, swept(), { dir: checkout })) === null);
check('and no tracker write at all', bd.calls.length === 0, JSON.stringify(bd.calls));
check('and nothing to follow up', Object.keys(readSweepCards()).length === 0);

console.log('\nand a sweep that acted files exactly one');

wipe();
bd = fakeBd();
let filed = await fileSweepCard(bd, ws, swept({ handed: [row(14), row(11)], queued: [row(9)] }), { dir: checkout });
check('one card', filed?.card === 'bc-card', JSON.stringify(filed));
check('one create and nothing else', bd.calls.length === 1 && bd.calls[0].kind === 'create', JSON.stringify(bd.calls));
// A parentless `human` bead is not merely held by the dispatch gate — it is not drawn on
// the phone at all (lib/homing.js). A card filed to a screen that will not show it is this
// whole file reporting into a void.
check('it goes through the homing seam', 'parent' in bd.calls[0].spec, JSON.stringify(bd.calls[0].spec));
check('it is a question, so it lands in the inbox', bd.calls[0].spec.labels.includes('human'));
check('P2, like everything else the daemon files unasked', bd.calls[0].spec.priority === 2);
check('the title names the merge and the repo', /#231/.test(bd.calls[0].spec.title) && /beadcause/.test(bd.calls[0].spec.title), bd.calls[0].spec.title);
check('all three pull requests are on it', ['#14', '#11', '#9'].every((n) => bd.calls[0].spec.body.includes(n)), bd.calls[0].spec.body);

const record = readSweepCards()['bc-card'];
check('and the follow-up record is on disk', !!record, JSON.stringify(readSweepCards()));
check('naming the checkout to ask GitHub in', record.dir === checkout);
check('the merge that caused it', record.after === 231);
check('and the three rows to chase', record.prs.length === 3);

wipe();
bd = fakeBd({ fail: 'create' });
const refused = await fileSweepCard(bd, ws, swept({ handed: [row(14)] }), { dir: checkout });
check('a tracker that refuses the card says so rather than throwing', /could not file/.test(refused?.error || ''), JSON.stringify(refused));
check('and nothing is left to follow up', Object.keys(readSweepCards()).length === 0);

/* ------------------------------------------------------------------ the card */

console.log('\nwhat the card says');

const rec = {
  card: 'bc-card',
  workspace: 'demo',
  key: 'demo',
  dir: checkout,
  repo: 'neadamthal/beadcause',
  after: 231,
  base: 'main',
  at: new Date().toISOString(),
  prs: rowsOf(swept({ handed: [row(14), row(11)], queued: [row(9)] })),
};
const asked = (body) => toQuestion('demo', { id: 'bc-card', title: 'x', description: body, labels: ['human'] });

let q = asked(sweepCardBody(rec));
check('the decision block parses', (q.errors || []).length === 0, JSON.stringify(q.errors));
check('with one option, and it closes', q.decision?.options?.length === 1 && q.decision.options[0].closes !== false, JSON.stringify(q.decision?.options));
check('and prose above it', (q.sections || []).length >= 1);
check('the title is fixed by the merge, not by the states', sweepCardTitle(rec) === sweepCardTitle({ ...rec, prs: rec.prs.map((r) => ({ ...r, state: 'resolved' })) }));

const mixed = {
  ...rec,
  prs: [
    { ...rec.prs[0], state: 'resolved' },
    { ...rec.prs[1], state: 'handed-back', said: 'both sides rewrote timerFor() and only you can say which wins' },
    { ...rec.prs[2], state: 'working' },
  ],
};
check('the three states are counted separately', JSON.stringify(tally(mixed)) === JSON.stringify({ live: 1, needing: 1, settled: 1 }), JSON.stringify(tally(mixed)));
const body = sweepCardBody(mixed);
check('the resolved one is named as mergeable again', /mergeable again/.test(body));
check('the running one is named as still running', /still moving/.test(body) || /working on it/.test(body));
check("the handed-back one carries the resolver's own sentence", /only you can say which wins/.test(body), body);
check('and a paragraph saying nothing more will happen to it', /waiting on you/.test(body), body);
q = asked(body);
check('and that still parses with a sentence somebody else wrote in it', (q.errors || []).length === 0, JSON.stringify(q.errors));
// A quote in the resolver's sentence must not reach the YAML. It is markdown above the
// block, deliberately, because a block that will not parse is a card with no buttons.
q = asked(sweepCardBody({ ...mixed, prs: mixed.prs.map((r) => (r.said ? { ...r, said: 'it said "no" and: yes — #x' } : r)) }));
check('even one full of quotes and colons', (q.errors || []).length === 0, JSON.stringify(q.errors));

check(
  'a note from the sweep is not carried onto a state it is not about',
  !/1st in line/.test(sweepCardBody({ ...rec, prs: [{ ...rec.prs[0], state: 'resolved', note: '#9 is 1st in line' }] })),
  'a stale queue note shown beside "mergeable again"'
);

/* --------------------------------------------------------------- the chasing */

console.log('\nhow a state is learned');

resolvers.reset();
const live = { number: 14, branch: 'b', state: 'working', note: '', said: '', beads: [] };
resolvers.remember('demo', 14, { branch: 'b', term: 'w1' });
check(
  'a pull request the registry still holds is left working',
  (await chaseRow(rec, live, { mergeability: async () => { throw new Error('asked GitHub about a live one'); } })).state === 'working'
);

resolvers.reset();
const answer = (state, mergeable, unresolved = false) => async () => ({ pr: { state, mergeable, number: 14 }, unresolved });
check('one the registry has let go and GitHub calls mergeable is resolved', (await chaseRow(rec, live, { mergeability: answer('OPEN', 'MERGEABLE') })).state === 'resolved');
check('one that merged meanwhile is merged', (await chaseRow(rec, live, { mergeability: answer('MERGED', 'UNKNOWN') })).state === 'merged');
check('one that was closed meanwhile is closed', (await chaseRow(rec, live, { mergeability: answer('CLOSED', 'UNKNOWN') })).state === 'closed');

let handed = await chaseRow(rec, live, { mergeability: answer('OPEN', 'CONFLICTING'), said: async () => 'both sides are load-bearing' });
check('and one that still conflicts was handed back', handed.state === 'handed-back');
check('with the sentence the session left on the pull request', handed.said === 'both sides are load-bearing');

// `UNKNOWN` is the absence of GitHub having said anything, and a hand-back declared on one
// would be a card telling Adam to decide something nobody has established.
check('a GitHub that would not answer changes nothing', (await chaseRow(rec, live, { mergeability: answer('OPEN', 'UNKNOWN', true) })).state === 'working');
check('and neither does a `gh` that fell over', (await chaseRow(rec, live, { mergeability: async () => { throw new Error('gh exploded'); } })).state === 'working');
check(
  'a terminal row is never asked about again',
  (await chaseRow(rec, { ...live, state: 'resolved' }, { mergeability: async () => { throw new Error('asked about a finished row'); } })).state === 'resolved'
);

/* ------------------------------------------------------- the resolver sentence */

console.log("\nreading the resolver's own sentence off the pull request");

const at = (mins) => new Date(Date.now() + mins * 60000).toISOString();
const thread = [
  { body: `${RESOLVER_SAYS} an older conflict, from last week`, at: at(-60 * 24 * 7) },
  { body: 'looks good to me', at: at(5) },
  { body: `${RESOLVER_SAYS} both sides rewrote the same function`, at: at(10) },
  { body: `${RESOLVER_SAYS} and then I stood down — pid 4021 has the tree`, at: at(20) },
];
const since = new Date().toISOString();
check(
  'the newest marked comment since the sweep began wins',
  (await resolverSaid(checkout, 14, since, { comments: async () => thread })) === 'and then I stood down — pid 4021 has the tree'
);
check(
  'a comment from before the sweep is not this sweep evidence',
  (await resolverSaid(checkout, 14, since, { comments: async () => [thread[0]] })) === ''
);
check('an unmarked thread says nothing', (await resolverSaid(checkout, 14, since, { comments: async () => [thread[1]] })) === '');
check('and a `gh` that failed says nothing rather than throwing', (await resolverSaid(checkout, 14, since, { comments: async () => { throw new Error('no'); } })) === '');
check(
  'the resolver is actually told to write one',
  conflictPromptFor('demo', { number: 14, branch: 'b', base: 'main', title: 't', beads: [] }, 'Adam', { sweptAfter: 231 }).includes(RESOLVER_SAYS),
  'conflictPromptFor never mentions the marker, so nothing would ever write one'
);

/* -------------------------------------------------------------- the follow-up */

console.log('\nthe acceptance: one card, three pull requests, three states');

resolvers.reset();
wipe();
bd = fakeBd();
filed = await fileSweepCard(bd, ws, swept({ handed: [row(14), row(11)], queued: [row(9)] }), { dir: checkout });
check('one card for the sweep', filed.card === 'bc-card');

// #14 resolved, #11 was handed back, #9 is still being worked — the exact scenario the
// bead asks for, and the states are read the way the daemon reads them: the registry for
// the live one, GitHub for the two it has let go of.
resolvers.remember('demo', 9, { branch: 'worktree-thing-9', term: 'w9' });
const github = async (dir, number) => ({
  pr: { number, state: 'OPEN', mergeable: number === 14 ? 'MERGEABLE' : 'CONFLICTING' },
  unresolved: false,
});
let out = await followSweepCards(bd, cfg, { mergeability: github, said: async () => 'you have to pick a side here' });
check('one outcome, for the one card', out.length === 1, JSON.stringify(out));
check('the card was amended rather than replaced', out[0].amended === true && out[0].card === 'bc-card', JSON.stringify(out[0]));
check('still exactly one create in the whole run', bd.calls.filter((c) => c.kind === 'create').length === 1);
check('and it is not closed — something needs Adam', !bd.calls.some((c) => c.kind === 'close'), JSON.stringify(bd.calls.map((c) => c.kind)));

const amended = bd.calls.filter((c) => c.kind === 'update').pop().fields.description;
check('#14 is mergeable again', /#14/.test(amended) && /mergeable again/.test(amended), amended);
check('#11 was handed back, with its reason', /pick a side here/.test(amended), amended);
check('#9 is still being worked', /working on it/.test(amended), amended);
check('all three are named on the one card', ['#14', '#11', '#9'].every((n) => amended.includes(n)));
check('the record still has the running one to chase', readSweepCards()['bc-card']?.prs.filter((r) => r.state === 'working').length === 1);

console.log('\nand it does not write when nothing has moved');

const before = bd.calls.length;
out = await followSweepCards(bd, cfg, { mergeability: github, said: async () => 'you have to pick a side here' });
check('a quiet cycle costs no tracker write', bd.calls.length === before, JSON.stringify(bd.calls.slice(before)));
check('and reports nothing worth a log line', out.length === 0 || describeSweepCard(out[0]) === '', JSON.stringify(out));

console.log('\nand when the last one finishes it stops');

resolvers.reset();
out = await followSweepCards(bd, cfg, { mergeability: github, said: async () => 'you have to pick a side here' });
check('the card is finished', out[0]?.done === true, JSON.stringify(out));
check('it stays open, because one of them still needs Adam', out[0].closed !== true && !bd.calls.some((c) => c.kind === 'close'));
/**
 * And the record is *kept*, which is bc-9d37.8 and used to be the opposite.
 *
 * Nothing moves out of `handed-back` on its own — that is why this used to be the end of
 * the record — but Adam's answer moves it, and the record is the only thing that can say
 * which repo, which checkout and which branch a window for it would open on. So the card
 * is what bounds it, and the card is asked rather than a clock.
 */
check('the record is kept — his answer still has somewhere to land', Object.keys(readSweepCards()).length === 1);
check('and the row it kept is the one waiting on him', readSweepCards()['bc-card']?.prs.find((r) => r.number === 11)?.state === 'handed-back');

const quiet = bd.calls.length;
out = await followSweepCards(bd, cfg, { mergeability: github, said: async () => 'you have to pick a side here' });
check('a further quiet cycle writes nothing', !bd.calls.slice(quiet).some((c) => c.kind !== 'show'), JSON.stringify(bd.calls.slice(quiet)));
check('but it does ask whether the card is still there', bd.calls.slice(quiet).some((c) => c.kind === 'show'));
check('and the record survives an open card', Object.keys(readSweepCards()).length === 1);

bd.status = 'closed';
out = await followSweepCards(bd, cfg, { mergeability: github, said: async () => 'you have to pick a side here' });
check('a card he has answered or dismissed ends the record', Object.keys(readSweepCards()).length === 0);
check('and it says so', out[0]?.gone === true, JSON.stringify(out));

console.log('\nbut a sweep that resolved itself takes its own card back out of the inbox');

resolvers.reset();
wipe();
bd = fakeBd();
await fileSweepCard(bd, ws, swept({ handed: [row(14), row(11)] }), { dir: checkout });
out = await followSweepCards(bd, cfg, { mergeability: async (dir, number) => ({ pr: { number, state: 'OPEN', mergeable: 'MERGEABLE' }, unresolved: false }) });
check('closed by itself', out[0]?.closed === true, JSON.stringify(out));
const closing = bd.calls.find((c) => c.kind === 'close');
check('with a reason naming what became mergeable', /#14/.test(closing?.reason || '') && /#11/.test(closing?.reason || ''), closing?.reason);
check('and it says nothing needed him', /Nothing needed you/.test(settledReason({ ...rec, prs: [] })));
check('the record is gone', Object.keys(readSweepCards()).length === 0);
check('and the log line says so', /every conflicting pull request came back mergeable/.test(describeSweepCard(out[0])), describeSweepCard(out[0]));

/* --------------------------------------------------------------- the refusals */

console.log('\nand the records it stops chasing');

resolvers.reset();
wipe();
bd = fakeBd();
await fileSweepCard(bd, ws, swept({ handed: [row(14)] }), { dir: checkout });
out = await followSweepCards(bd, cfg, { now: Date.now() + 5 * 60 * 60 * 1000, mergeability: github });
check('a record past its window stops claiming a session is on it', out[0]?.done === true, JSON.stringify(out));
check('the card says nothing here can say', /nothing here can say/.test(bd.calls.filter((c) => c.kind === 'update').pop()?.fields.description || ''));
check('it is not closed — an unknown is not a resolution', !bd.calls.some((c) => c.kind === 'close'));
// Kept, for the reason above: an `unknown` is one of the three states that need him, and
// the card is still in his inbox with a button on it that has to reach a checkout.
check('and it is kept, because it is still waiting on him', Object.keys(readSweepCards()).length === 1);

resolvers.reset();
wipe();
bd = fakeBd();
await fileSweepCard(bd, ws, swept({ handed: [row(14)] }), { dir: checkout });
out = await followSweepCards(bd, { workspaces: [] }, { mergeability: github });
check('a workspace that is not configured any more is dropped', out[0]?.gone === true, JSON.stringify(out));
check('without writing to a tracker it cannot address', !bd.calls.some((c) => c.kind !== 'create'), JSON.stringify(bd.calls.map((c) => c.kind)));
check('and it says so', /not a configured workspace/.test(describeSweepCard(out[0])), describeSweepCard(out[0]));

resolvers.reset();
wipe();
bd = fakeBd({ fail: 'update' });
await fileSweepCard(bd, ws, swept({ handed: [row(14)] }), { dir: checkout });
out = await followSweepCards(bd, cfg, { mergeability: github });
check('a tracker that will not take the amendment reports it', /could not amend/.test(out[0]?.error || ''), JSON.stringify(out));
check('and keeps the record, so the next cycle tries again', Object.keys(readSweepCards()).length === 1);

/* ------------------------------------------------------------------ the wiring */

console.log('\nand the wiring nothing else can see');

const mergesweep = fs.readFileSync(LIB('mergesweep.js'), 'utf8');
check('a sweep that ran files the card', /fileSweepCard/.test(mergesweep), 'lib/mergesweep.js never files one');
const server = fs.readFileSync(LIB('server.js'), 'utf8');
check('the daemon chases them in the poll cycle', /followSweepCards\(/.test(server), 'nothing drains the follow-up');
check(
  'inside the same guard as the sweep that files them',
  server.indexOf('followSweepCards(') > server.indexOf('const sweepMerges = async () => {') &&
    server.indexOf('followSweepCards(') < server.indexOf("sweepFailed('the release sweep'"),
  'the follow-up is not in the conflict sweep step'
);
// A card that reaches the browser only when something else happens to move is a card that
// looks like a feature that does not work — see the poll handler's `changed`.
check('and a card filed or amended wakes the phones parked on /api/poll', /type: 'sweep-card'/.test(server), 'no bus event');

/* ------------------------------------------------------- answering a hand-back */

/**
 * bc-9d37.8. The card used to have one button and it only dismissed, so the far end of
 * the loop was open: a resolver said only Adam could pick a winner, the card said so, he
 * typed which one wins, and nothing read it.
 *
 * What is asserted here is the *card's* half — the options it emits and how it reads an
 * answer back. The act is `resolveSweepFor` in lib/server.js and test/sweepanswer.mjs
 * drives it through a real `POST /api/respond`; the split is the one the file keeps,
 * because only the daemon may open a resolver.
 */
console.log('\nthe hand-back is answerable now');

const waiting = {
  card: 'bc-card',
  workspace: 'demo',
  key: 'demo',
  dir: checkout,
  repo: 'neadamthal/beadcause',
  after: 231,
  base: 'main',
  at: new Date().toISOString(),
  prs: [
    { ...row(11), state: 'handed-back', note: '', said: 'both sides rewrote renderRow' },
    { ...row(14), state: 'failed', note: 'iTerm refused the Apple event', said: '' },
    { ...row(9), state: 'resolved', note: '', said: '' },
  ],
};

const cardQ = toQuestion('demo', { id: 'bc-card', title: sweepCardTitle(waiting), description: sweepCardBody(waiting) });
check('the block still parses with options on it', !cardQ.decisionError && (cardQ.decision?.options || []).length === 3, JSON.stringify(cardQ.decisionError || cardQ.decision));
check('one option per row that is waiting, and Noted last', String((cardQ.decision?.options || []).map((o) => o.id)) === 'resolve-11,resolve-14,noted');
check('a resolved row gets no button — there is nothing to decide about it', !(cardQ.decision?.options || []).some((o) => o.id === 'resolve-9'));
check('the tap writes the marker into the box rather than answering', cardQ.decision.options[0].response === 'RESOLVE #11: ');
// The whole reason it may not close: the card amends itself as the row it just restarted
// finishes, and a closed card cannot report the end of what it began.
check('and it does not close the card', cardQ.decision.options[0].closes === false && cardQ.decision.options[2].closes === true);
check('the card says how to answer it', /Say which side wins/.test(sweepCardBody(waiting)));

// The rule this file has always kept, now that there is more in the block to break it:
// nothing interpolated into the YAML is text beadcause did not write. A branch name may
// legally carry a double quote, and one of those in a scalar is a card with no buttons.
const hostile = {
  ...waiting,
  prs: [{ ...row(11), branch: 'wt-"quote"-11', title: 'a: title — with "quotes" and #hashes', state: 'handed-back', note: '', said: 'he said "both"' }],
};
const hostileQ = toQuestion('demo', { id: 'bc-card', title: 'x', description: sweepCardBody(hostile) });
check('a branch or a title full of quotes still parses', !hostileQ.decisionError && (hostileQ.decision?.options || []).length === 2, JSON.stringify(hostileQ.decisionError));
check(
  'and the resolver own words stay in the markdown, never in the block',
  /he said "both"/.test(sweepCardBody(hostile)) && !/he said/.test(JSON.stringify(hostileQ.decision)),
  JSON.stringify(hostileQ.decision)
);

console.log('\nand reading the answer back');

check('the tapped option names the pull request', sweepAnswer(waiting, 'RESOLVE #11: take main’s renderRow', 'resolve-11')?.number === 11);
check('and the marker is stripped off the instruction', sweepAnswer(waiting, 'RESOLVE #11: take main’s renderRow', 'resolve-11')?.note === 'take main’s renderRow');
// The surfaces that can only send text — an ntfy action button, a Slack button.
check('the marker alone is enough', sweepAnswer(waiting, 'RESOLVE #14: give it another go')?.number === 14);
// Two rows waiting, so "take main's version" is an instruction to nobody in particular.
check('a bare sentence over two waiting rows is an ordinary answer', sweepAnswer(waiting, 'take main’s renderRow') === null);
check('Noted is never read as an instruction', sweepAnswer(waiting, 'Noted — read the sweep of x.', 'noted') === null);

const alone = { ...waiting, prs: [waiting.prs[0], waiting.prs[2]] };
check('with exactly one waiting, a bare sentence is unambiguous', sweepAnswer(alone, 'take main’s renderRow')?.number === 11);
check('and it carries the whole sentence', sweepAnswer(alone, 'take main’s renderRow')?.note === 'take main’s renderRow');
check('an empty box is not an answer', sweepAnswer(alone, '   ') === null);
// Tapped but nothing typed: the caller has to say so rather than open a window on a
// decision nobody made — asserted end to end in test/sweepanswer.mjs.
check('a tap with no instruction still names the row, with nothing to say', sweepAnswer(alone, 'RESOLVE #11:', 'resolve-11')?.note === '');

console.log('\nand the row goes back into motion');

wipe();
bd = fakeBd();
await fileSweepCard(bd, ws, swept({ handed: [row(14)], failed: [{ ...row(11), why: 'iTerm refused' }] }), { dir: checkout });
const restarted = markResolving('bc-card', 11, 'working', '');
check('the answered row is live again', restarted.prs.find((r) => r.number === 11)?.state === 'working');
check('and the record on disk says so', readSweepCards()['bc-card'].prs.find((r) => r.number === 11)?.state === 'working');
check('the other rows are untouched', restarted.prs.find((r) => r.number === 14)?.state === 'working');
check('a card whose record has gone is said so rather than invented', markResolving('bc-nothing', 11, 'working') === null);

const wired = fs.readFileSync(LIB('server.js'), 'utf8');
check('the daemon is what acts on it', /resolveSweepFor\(/.test(wired), 'nothing in the server answers a sweep card');
check('beside the other three answers that write something', wired.indexOf('resolveSweepFor(ws,') < wired.indexOf('await bd.respond(ws, body.id'), 'the act runs after the close');

/* ------------------------------------------------------------------------ done */

await cleanupTmp(tmp);
console.log(`\n${failures ? `${failures} of ${ran} failed` : `${ran} passed`}`);
process.exit(failures ? 1 : 0);
