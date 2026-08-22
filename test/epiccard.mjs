#!/usr/bin/env node
/**
 * One card per advocate — an EpicAdvocate is not a fold inside the repo's card.
 *
 *     npm test
 *     node test/epiccard.mjs
 *
 * Until bc-henk the advocates view drew one card per repo and folded every EpicAdvocate
 * under it into a collapsed section of that card, under an "Advocates" summary counting
 * `1 + epicsOf(a).length`. The nesting made a claim that is not true: that an EpicAdvocate
 * is a part of the repo advocate. It is not — it has its own budget (`maxEpicAdvocates`),
 * its own state, its own pause and its own queue, and the only thing it shares with the
 * repo advocate is the repo.
 *
 * So an advocate is a card, and the four things that has to mean are what this suite
 * holds. All four against **the real `public/monitor.js` rendered in a `node:vm`** rather
 * than against its source, because every one of them is a claim about the page's output
 * and a source assertion can go green over markup that never renders — see
 * test/spacecard.mjs, whose harness this borrows and whose argument is the same one.
 *
 *   1. **Every advocate is a top-level `<article>`.** A repo with three assigned epics
 *      draws four cards, and no `epic-card` is inside a repo card — asserted by cutting
 *      the string at `</article>` boundaries, which is the one reading that cannot be
 *      satisfied by nesting.
 *   2. **A card is drawn per *assignment*, not per window.** That is the rule
 *      test/advocateroster.mjs holds at the daemon end and it has to survive the redraw:
 *      an epic with no window is a card, and its head says *which* of the reasons it is,
 *      because a shut card is only its head.
 *   3. **No window is on two cards.** A coder dispatched from an epic's plan
 *      (`w.group.epic`) is a row on that epic's card and is *not* a row on the repo's;
 *      one the repo advocate picked up on its own is the other way round. The bug this
 *      replaces is not "it was in the wrong place" — it is that four windows from one
 *      judgement were four unrelated rows.
 *   4. **The repo card's count still agrees with the daemon.** `Working now` is headed
 *      `codersOf/limit` — *every* coder, including the ones an epic claimed — because
 *      `limit` is what `tickOne` rations. The rows are the subset, and the card says so
 *      in a sentence rather than leaving the arithmetic to be noticed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const MONITOR = fs.readFileSync(path.join(ROOT, 'public', 'monitor.js'), 'utf8');

// The space card is drawn on this page too, from `/api/space`, and it throws on a payload
// it did not build — so the fixture is the real `spaceDetail`, exactly as test/spacecard.mjs
// builds one. A hand-typed shape here would fail for a reason that has nothing to do with
// this suite's subject.
const { spaceDetail } = await import(path.join(ROOT, 'lib', 'spaces.js'));
const SPACE = spaceDetail({ workspaces: [{ name: 'demo' }], spaces: [{ name: 'Work', workspaces: ['demo'] }] }, 'Work');

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
    console.log(`      ${err.message.split('\n')[0]}`);
  }
};

console.log('\nan EpicAdvocate is a card of its own');

/* --------------------------------------------------- the page, in a room of its own */

/**
 * `public/monitor.js` for real, with the five nodes and one storage key it insists on.
 *
 * The stub list is not arbitrary and is worth keeping in step with
 * [[rendering-monitor-js-in-a-vm]]: `getElementById` is asked for exactly `mon`, `pulse`,
 * `tally`, `observing` and `refresh`, and the last of those is *not* optional-chained, so
 * a missing stub throws at load rather than rendering something wrong.
 *
 * The open set matters as much as the payload. Every section on this page is folded by
 * default and the open set is `beadcause.mon.open` in `localStorage`, so a card renders
 * with none of its rows unless the key names them — which reads as a broken payload and is
 * not one. The keys here are the honest equivalent of the taps a thumb makes.
 */
async function draw(data, open = []) {
  const node = () => ({
    innerHTML: '',
    textContent: '',
    title: '',
    className: '',
    hidden: false,
    dataset: {},
    classList: { add() {}, remove() {} },
    addEventListener() {},
    contains: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  const nodes = { mon: node(), pulse: node(), tally: node(), observing: node(), refresh: node() };
  const store = { 'beadcause.token': 'tok', 'beadcause.mon.open': JSON.stringify(open) };

  const ctx = vm.createContext({
    window: {
      beadcause: {
        space: {
          filter: { space: 'Work' },
          matches: () => true,
          label: () => 'Work',
          adopt() {},
          onChange() {},
        },
      },
    },
    document: { getElementById: (id) => nodes[id] || null, addEventListener() {}, activeElement: null },
    location: { search: '', pathname: '/monitor', hash: '' },
    history: { replaceState() {} },
    localStorage: { getItem: (k) => store[k] ?? null, setItem(k, v) { store[k] = v; } },
    URLSearchParams,
    JSON,
    Date,
    Math,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async (url) => {
      const body = url.startsWith('/api/work')
        ? data
        : url.startsWith('/api/questions')
          ? { questions: [] }
          : url.startsWith('/api/space')
            ? SPACE
            : url.startsWith('/api/prs')
              ? { repos: [] }
              : {};
      return { ok: true, status: 200, json: async () => body };
    },
  });
  vm.runInContext(MONITOR, ctx, { filename: 'monitor.js' });
  for (let i = 0; i < 80; i += 1) await new Promise((r) => setImmediate(r));
  return nodes.mon.innerHTML;
}

/**
 * The rendered page cut into top-level cards.
 *
 * `<article>` never nests on this page, so splitting on the open tag and stopping each
 * slice at the first `</article>` gives exactly the run of cards a thumb scrolls past —
 * and it is the reading that makes claim 1 mean something: an `epic-card` drawn *inside* a
 * repo card would land in that card's slice and be counted as part of it, not as a card.
 */
function cards(html) {
  const OPEN = '<article ';
  const starts = [];
  for (let i = html.indexOf(OPEN); i !== -1; i = html.indexOf(OPEN, i + 1)) starts.push(i);
  return starts
    .map((s, n) => {
      const slice = html.slice(s, starts[n + 1] ?? html.length);
      const end = slice.indexOf('</article>');
      return end === -1 ? slice : slice.slice(0, end);
    })
    // The space's own settings card is an `<article>` on this page too and is not an
    // advocate — it is drawn above the roster when no Config pane exists to draw it into.
    .filter((c) => !/\bspace-card\b/.test(c));
}

const isEpic = (c) => /class="[^"]*\bepic-card\b/.test(c);
// A repo card's name is its `<h2>`; an epic card's is the title inside the button that is
// also its fold — the head *is* the summary there, which is what keeps twelve of them
// affordable. Both are the first name the card states, so one reader covers the pair.
const heading = (c) =>
  (c.match(/<h2>([^<]*)<\/h2>/) || c.match(/<span class="mon-sum-title">([^<]*)<\/span>/) || [, ''])[1];

/* ------------------------------------------------------------------------ the payload */

const worker = (id, over) => ({
  id,
  title: `work on ${id}`,
  batch: [],
  group: null,
  planning: false,
  at: '2026-08-17T12:00:00.000Z',
  repo: null,
  claimed: true,
  ended: false,
  pid: null,
  sessionStatus: null,
  attempt: 1,
  reachable: true,
  asked: null,
  checkedInAt: null,
  checkinNote: '',
  ...over,
});

const epic = (id, over) => ({
  id,
  title: `${id} the epic`,
  type: 'epic',
  labels: [],
  paused: false,
  assigned: true,
  window: null,
  why: 'nothing under it is ready to plan yet',
  ...over,
});

/**
 * One repo, three assigned epics, four coders and one planner.
 *
 * Shaped as the daemon's snapshot builds it (`lib/advocate.js`), not as this file finds
 * convenient: `epicAdvocates` is the *roster* and `workers` is the *windows*, they have
 * different lifetimes, and the two of them disagreeing is the normal state — `bc-e2` here
 * is assigned with no window, which is what nineteen of twenty epics looked like on the
 * day the roster landed.
 */
const PAYLOAD = {
  observing: false,
  workspaces: [{ name: 'demo', sessions: [], working: [], open: 0, ready: 0 }],
  roster: [{ workspace: 'demo', advocated: true }],
  elsewhere: [],
  advocates: [
    {
      workspace: 'demo',
      limit: 4,
      ceiling: 9,
      epicLimit: 3,
      epicCeiling: 9,
      globalMax: 9,
      globalHeld: false,
      queue: 0,
      next: [],
      closing: [],
      parked: [],
      paused: false,
      quiet: false,
      surveying: false,
      draining: false,
      error: null,
      note: '',
      lastSurveyAt: '2026-08-17T12:00:00.000Z',
      lastLaunchAt: null,
      lastProposalAt: null,
      repos: null,
      archive: null,
      epicAdvocates: [
        epic('bc-e1', {
          window: { at: '2026-08-17T12:00:00.000Z', pid: null, claimed: true, ended: false, beads: 5, reachable: true, asked: null, checkedInAt: null },
          why: null,
        }),
        epic('bc-e2', { why: 'waiting for a slot — 1 of 3 EpicAdvocates are open' }),
        epic('bc-e3', { paused: true, why: 'paused — nothing will be dispatched under it until it is resumed' }),
      ],
      workers: [
        worker('bc-solo'),
        worker('bc-g1', { group: { epic: 'bc-e1', name: 'the parser' } }),
        worker('bc-g2', { group: { epic: 'bc-e1', name: 'the parser' } }),
        worker('bc-g3', { group: { epic: 'bc-e3', name: 'the sweep' } }),
        worker('bc-plan', { planning: true, group: { epic: 'bc-e1', name: 'plan' } }),
      ],
    },
  ],
};

const OPEN = ['demo:work', 'demo:epic:bc-e1', 'demo:epic:bc-e3', 'demo:advocates'];

/* -------------------------------------------------------------------------- the claims */

await check('every advocate is a top-level card — one repo with three epics draws four', async () => {
  const drawn = cards(await draw(PAYLOAD));
  assert.equal(drawn.length, 4, `drew ${drawn.length} cards: ${drawn.map(heading).join(' | ')}`);
  assert.equal(drawn.filter(isEpic).length, 3, 'the epics are not three cards of their own');
  // Order: the repo, then its epics, so a repo stays one readable run on a phone.
  assert.ok(!isEpic(drawn[0]), 'the repo card is not first in its own run');
  assert.deepEqual(drawn.slice(1).map(isEpic), [true, true, true]);
  // And nothing is nested: a card that folded its epics inside itself would have all
  // three headings in the first slice and only one card in the list.
  assert.ok(!/epic-card/.test(drawn[0]), 'an epic card is drawn inside the repo card');
});

await check('a card per assignment, not per window — and it names the epic and its id', async () => {
  const drawn = cards(await draw(PAYLOAD)).filter(isEpic);
  assert.deepEqual(drawn.map(heading), ['bc-e1 the epic', 'bc-e2 the epic', 'bc-e3 the epic']);
  for (const [i, id] of ['bc-e1', 'bc-e2', 'bc-e3'].entries()) {
    assert.match(drawn[i], new RegExp(`<span class="pill id">${id}</span>`), `${id}'s card does not carry its id`);
  }
});

await check('the head says whether there is a window and, when there is not, why not', async () => {
  const [one, two, three] = cards(await draw(PAYLOAD)).filter(isEpic);
  // Head only — the reason has to be readable on a shut card, which is all head.
  const head = (c) => c.slice(0, c.indexOf('</div>'));
  assert.match(head(one), /writing this epic&#39;s plan|writing this epic's plan/, 'a windowed epic does not say so');
  assert.match(head(two), /waiting for a slot/, 'an unwindowed epic does not say why, which is the actionable half');
  // Paused beats a reason and beats a window: the epic has stopped, and that is the fact.
  assert.match(head(three), /paused/, 'a paused epic does not say so in its head');
});

await check('it can be paused and resumed from its own head', async () => {
  const [one, , three] = cards(await draw(PAYLOAD)).filter(isEpic);
  const head = (c) => c.slice(0, c.indexOf('</div>'));
  assert.match(head(one), /data-epic="epicPause" data-ws="demo" data-id="bc-e1"/, 'no pause in the head');
  assert.match(head(three), /data-epic="epicResume" data-ws="demo" data-id="bc-e3"/, 'a paused epic offers no way back');
  assert.match(head(one), /href="\/graph\?ws=demo&amp;id=bc-e1">Open the epic/, 'no way into the epic from its head');
});

await check('shut, a card is its head — and the head still names all four things', async () => {
  // The head *is* the fold, which is what makes a dozen of these affordable at all; the
  // cost of that is that a shut card is only its head, so everything the acceptance asks
  // an epic card to say has to be in it. Measured in Chrome at 393x852: 107px a card,
  // 1656px for a repo with twelve — where twelve folds inside one card were 2304px.
  const [, , e2] = cards(await draw(PAYLOAD)); // repo, bc-e1, bc-e2 — the one with no window
  assert.match(e2, /<button class="mon-sum epic-sum" data-toggle="demo:epic:bc-e2" aria-expanded="false"/,
    'the head is not the fold — there is a section strip under it, and twelve of those is the wall');
  assert.ok(!e2.includes('mon-body'), 'a shut card is drawing its body');
  assert.match(e2, /bc-e2 the epic/, 'shut, it does not name its epic');
  assert.match(e2, /<span class="pill id">bc-e2<\/span>/, 'shut, it does not carry its id');
  assert.match(e2, /waiting for a slot/, 'shut, it does not say why it has no window');
  assert.match(e2, /data-epic="epicPause"/, 'shut, it cannot be paused');
});

await check('a window dispatched from a plan is on that epic\'s card and on no other', async () => {
  const drawn = cards(await draw(PAYLOAD, OPEN));
  const [repo, e1, e2, e3] = drawn;
  const holds = (c, id) => new RegExp(`<span class="pill id">${id}</span>`).test(c);

  assert.ok(holds(e1, 'bc-g1') && holds(e1, 'bc-g2'), "bc-e1's two windows are not on its card");
  assert.ok(holds(e3, 'bc-g3'), "bc-e3's window is not on its card");
  assert.ok(!holds(e2, 'bc-g1') && !holds(e2, 'bc-g3'), 'a window landed on an epic that did not dispatch it');

  // The other half, and the one that was broken: they are not *also* rows on the repo's.
  for (const id of ['bc-g1', 'bc-g2', 'bc-g3']) {
    assert.ok(!holds(repo, id), `${id} is drawn twice — on the repo card and on its epic's`);
  }
  assert.ok(holds(repo, 'bc-solo'), 'the bead the repo advocate picked up on its own has left the repo card');
  for (const c of [e1, e2, e3]) assert.ok(!holds(c, 'bc-solo'), 'an unclaimed bead landed on an epic card');
});

await check('and the planner window is drawn once, on its epic, never as a coder', async () => {
  const drawn = cards(await draw(PAYLOAD, OPEN));
  const whole = drawn.join('');
  assert.equal(whole.split('<span class="pill id">bc-plan</span>').length - 1, 0, 'the planner is a coder row somewhere');
  // It is the epic card's own row instead, which says what it is rather than quoting a bead.
  assert.match(drawn[1], /Writing this epic&#39;s plan|Writing this epic's plan/, "bc-e1's planner window has no row at all");
});

await check('Working now still counts every coder against the limit, and says where they went', async () => {
  const repo = cards(await draw(PAYLOAD, OPEN))[0];
  // Four coders, limit four: the number the daemon rations, not the number of rows drawn.
  assert.match(repo, /<span class="mon-n[^"]*">4\/4<\/span>/, 'the count no longer agrees with the daemon');
  assert.match(repo, /3 more sessions came out of an epic&#39;s plan|3 more sessions came out of an epic's plan/,
    'the card does not account for the rows its count includes and its list does not');
});

await check('the repo advocate\'s own numbers survive, and stop counting the epics', async () => {
  const repo = cards(await draw(PAYLOAD, OPEN))[0];
  // The fold that used to hold the epics is narrowed to the advocate it is about, rather
  // than deleted: it is where the two counts the daemon rations against live.
  const sum = repo.slice(repo.indexOf('data-toggle="demo:advocates"'));
  assert.match(sum.slice(0, sum.indexOf('</button>')), /The repo advocate/, 'the roster fold is gone rather than narrowed');
  assert.ok(
    !/<span class="mon-n[^"]*">4<\/span>/.test(sum.slice(0, sum.indexOf('</button>'))),
    'the roster summary still counts 1 + the epics — the fold is still claiming them'
  );
  assert.match(repo, /4 of 4 sessions/, 'coders against limit has gone from the card');
  assert.match(repo, /1 of 3 EpicAdvocates/, 'planners against epicLimit has gone from the card');
  assert.match(repo, /3 epics have an advocate assigned — one card each/, 'the card does not point at the cards below it');
});

await check('an advocate with no assigned epic still draws exactly one card', async () => {
  const bare = { ...PAYLOAD, advocates: [{ ...PAYLOAD.advocates[0], epicAdvocates: [], workers: [worker('bc-solo')] }] };
  const drawn = cards(await draw(bare, OPEN));
  assert.equal(drawn.length, 1, 'an empty roster grew or lost a card');
  assert.match(drawn[0], /No epic has an advocate assigned/, 'and the card does not say the roster is empty');
  assert.ok(!/came out of an epic/.test(drawn[0]), 'it accounts for windows that do not exist');
});

await check(
  'a root that merely qualifies is not drawn as though it were advocated — bc-r2b5.3',
  async () => {
    // A graph carrying both shapes at once: two epics with an advocate actually on them,
    // one that only qualifies (`wantsAdvocate`) and has never had one. The count and the
    // unassigned card's own head both have to say so.
    const cold = {
      ...PAYLOAD,
      advocates: [
        {
          ...PAYLOAD.advocates[0],
          epicAdvocates: [
            ...PAYLOAD.advocates[0].epicAdvocates,
            epic('bc-e4', { assigned: false, why: 'nothing under it is ready to plan yet' }),
          ],
        },
      ],
    };
    const drawn = cards(await draw(cold, OPEN));
    const repo = drawn[0];
    assert.match(
      repo,
      /3 epics have an advocate assigned — one card each.*1 more open epic could have one and has not been assigned yet/,
      'the count still claims every qualifying root is advocated'
    );
    const coldCard = drawn.find((c) => c.includes('data-epic-card="bc-e4"'));
    assert.match(coldCard, /not yet assigned/, "bc-e4's card reads identically to an idle assigned epic");
  }
);

/* `EYEBALL=1 node test/epiccard.mjs` prints the cards this suite asserted against.
   Kept because the one thing a string assertion cannot answer is whether a repo with a
   dozen assigned epics still reads as a screenful, and reading the markup is a great deal
   cheaper than driving Chrome to find out. */
if (process.env.EYEBALL) {
  for (const c of cards(await draw(PAYLOAD, OPEN))) console.log('\n========\n' + c);
}

console.log(`\n${ran - failures}/${ran} passed`);
process.exit(failures ? 1 : 0);
