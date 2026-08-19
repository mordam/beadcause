#!/usr/bin/env node
/**
 * The board card draws its advocate's state, and expands into what it has done.
 *
 *     npm test
 *     node test/p0advocard.mjs
 *
 * bc-r2b5.2, the client half of bc-r2b5. bc-r2b5.1 put the daemon's own answer on the
 * payload — `advocacy`, eight fields beside the old boolean-shaped `advocate` — and until
 * this nothing drew a single one of them. The card still asked `advocate?.pid`, which for
 * a **re-entrant** supervisor is null nearly all the time: an Epic Advocate takes a turn,
 * writes up and exits, so the steady state of a correctly-advocated epic was a card
 * offering to put somebody on it. An assignment Adam made read, every time he came back to
 * it, as one that had been lost.
 *
 * Five properties, and the first three are the acceptance criterion split three ways:
 *
 * 1. **Assigned and idle is a state, and it says when.** Not "advocated" on its own —
 *    an epic whose advocate looked twenty minutes ago and one whose advocate last looked a
 *    fortnight ago are the same card without the time, and only one of them is a problem.
 *    An epic assigned but never opened says *that*, rather than borrowing "just now" from
 *    a record that does not exist.
 *
 * 2. **And it does not offer to open a second one.** `/api/bead/advocate` refuses a launch
 *    over a live window, and lib/reenter.js's sweep is what re-opens an idle one — so a
 *    button here whose only outcome is a 409 or a duplicate is worse than no button.
 *
 * 3. **Finished offers the close.** lib/finishedepic.js has already asked, on the bead,
 *    with a `decision` block; the only thing owed is the way in to the card it wrote, and
 *    that is `expand` — the inbox card with its options, its arm-then-confirm and its
 *    submit queue, never a second answer surface. Where the payload has no row for it —
 *    `scope=agent` sweeps no questions — it says where the close is instead of offering a
 *    tap that would do nothing.
 *
 * 4. **Nothing may render "we have not looked" as "there is nothing".** Every source the
 *    sheet reads has a third state: the plan is absent, unreadable or not fetched yet; the
 *    archive is looking, present, absent or failed; the waiting-on sentence is written or
 *    it is not. Each is drawn as itself.
 *
 * 5. **Nothing out of the tracker can write markup.** A hold reason, a plan group's name
 *    and a child's title all arrive from `bd` and all reach the page.
 *
 * Rendered in a `node:vm` over slices of public/app.js — no DOM and no browser, the lift
 * test/p0card.mjs uses and for its reasons.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const APP = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

let failures = 0;
let ran = 0;
const check = (name, fn) => {
  ran += 1;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.message).split('\n').slice(0, 6).join('\n      ')}`);
  }
};

/** test/p0card.mjs's lift, unchanged — see the note there. */
function lift(src, opener) {
  const at = src.indexOf(opener);
  assert.notEqual(at, -1, `public/app.js no longer declares \`${opener}\``);
  if (opener.startsWith('function')) {
    let depth = 0;
    for (let i = src.indexOf('{', at); i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (!depth) return src.slice(at, i + 1);
      }
    }
    throw new Error(`unbalanced braces after ${opener}`);
  }
  let depth = 0;
  for (let i = at; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') depth -= 1;
    else if (c === ';' && depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`no statement end after ${opener}`);
}

/* ------------------------------------------------------------------- fixtures */

const AGO = (mins) => new Date(Date.now() - mins * 60000).toISOString();

/** The eight fields `advocacyOn` sends, with nobody on the epic — bc-r2b5.1's shape. */
const NOBODY = {
  assigned: false,
  by: null,
  paused: false,
  session: null,
  lastAt: null,
  hold: null,
  heldAt: null,
  finished: false,
};

const kid = (id, over = {}) => ({
  id,
  title: `what ${id} is for`,
  status: 'open',
  parent: 'bc-r2b5',
  depth: 1,
  key: `beadcause/${id}`,
  pending: false,
  session: null,
  ...over,
});

const card = (advocacy = {}, over = {}) => ({
  key: 'beadcause/bc-r2b5',
  workspace: 'beadcause',
  id: 'bc-r2b5',
  title: 'An EpicAdvocate is a visible assignment, not a live window',
  status: 'open',
  issue_type: 'epic',
  priority: 1,
  open: 2,
  inFlight: 0,
  waitingOn: null,
  advocate: advocacy.session || null,
  advocacy: { ...NOBODY, ...advocacy },
  tree: [kid('bc-r2b5.1', { status: 'closed' }), kid('bc-r2b5.2')],
  ...over,
});

/**
 * The renderers, in a context with the page state you hand them.
 *
 * `renderMarkdown` is stubbed rather than lifted: it is reached only by the branch where a
 * plan comment carries the marker and no readable plan behind it, and what that branch is
 * asserted on is that the advocate's own prose survives — not how markdown is rendered,
 * which is test/markdown.mjs's.
 */
function ctx({ adv = null, detail = new Map(), arc = new Map(), byKey = () => null } = {}) {
  const state = {
    p0adv: adv,
    p0open: new Set(),
    p0beadopen: new Set(),
    p0beaddetail: detail,
    p0beadarc: arc,
    p0opening: new Map(),
    space: 'all',
    workspace: 'all',
    spaces: [],
    boardError: '',
    board: { repos: [] },
  };
  const context = vm.createContext({
    String,
    Number,
    Math,
    JSON,
    Date,
    Array,
    Map,
    Boolean,
    Object,
    encodeURIComponent,
    state,
    byKey,
    renderMarkdown: (t) => String(t),
    FROM_BD: 'bd',
    graphUrl: () => '/graph',
  });
  vm.runInContext(
    [
      lift(APP, 'const esc = ('),
      lift(APP, 'const cardId = ('),
      lift(APP, 'const STATUS_LABEL = '),
      lift(APP, 'function relTime(iso)'),
      lift(APP, 'function openingHere(key)'),
      lift(APP, 'function p0AdvState(c)'),
      lift(APP, 'function p0AdvWhen(s)'),
      lift(APP, 'function p0AdvLine(s)'),
      lift(APP, 'function p0DoneHtml(c)'),
      lift(APP, 'function p0AdvOpenHtml(c, s)'),
      lift(APP, 'function p0Control(c)'),
      lift(APP, 'function p0SessionRowsHtml(workspace, id, row, arc)'),
      lift(APP, 'const PLAN_OPEN = '),
      lift(APP, 'const PLAN_CLOSE = '),
      lift(APP, 'function p0PlanIn(text)'),
      lift(APP, 'function p0PlanFrom(comments)'),
      lift(APP, 'const p0AdvKids = ('),
      lift(APP, 'const p0AdvFactHtml = ('),
      lift(APP, 'function p0AdvPlanHtml(c, detail)'),
      lift(APP, 'function p0AdvFullHtml(c)'),
      'null;',
    ].join('\n'),
    context
  );
  return context;
}

/** The acts-row control for one card. */
const control = (c, opts) => vm.runInContext('p0Control(CARD)', Object.assign(ctx(opts), { CARD: c }));

/** The sheet for one card. */
const sheet = (c, opts = {}) => {
  const context = ctx({ ...opts, adv: c.key });
  context.CARD = c;
  return vm.runInContext('p0AdvFullHtml(CARD)', context);
};

/* ----------------------------------------------------------- the four states */

console.log('\nthe card, in the four states the payload carries');

check('nobody on it — the offer, exactly as it was', () => {
  const html = control(card());
  assert.match(html, /data-act="advocate"/);
  assert.match(html, /Put an advocate on it/);
  assert.ok(!html.includes('p0-adv-open'), 'an epic nobody is on offered a look at its advocate');
  assert.ok(!html.includes('p0-done'), 'an epic with two open children was called finished');
});

check('assigned and idle says so, and says when its last window ran', () => {
  const html = control(card({ assigned: true, by: 'label', lastAt: AGO(180) }));
  assert.match(html, /p0-adv-open/);
  assert.match(html, /🧭 Advocated/);
  assert.match(html, /last looked 3h ago/, 'idle without a time is the card bc-r2b5 is about');
});

check('AND IT DOES NOT OFFER TO OPEN A SECOND ONE', () => {
  // The acceptance criterion, and the whole reason the payload stopped being a boolean:
  // the launch door refuses this and lib/reenter.js's sweep is what re-opens an idle
  // advocate, so a button here has no outcome that is not a refusal or a duplicate.
  const html = control(card({ assigned: true, by: 'label', lastAt: AGO(180) }));
  assert.ok(!html.includes('data-act="advocate"'), 'the card offered a second advocate over an assignment');
});

check('assigned but never opened says that, rather than borrowing a time', () => {
  const html = control(card({ assigned: true, by: 'waiting' }));
  assert.match(html, /no window has run on it yet/);
  assert.ok(!html.includes('last looked'), 'a card with no record invented one');
});

check('and when something is holding the next window, it says what', () => {
  const html = control(card({ assigned: true, by: 'label', lastAt: AGO(30), hold: 'the tick has already opened a window' }));
  assert.match(html, /the tick has already opened a window/);
  assert.match(html, /last looked 30m ago/);
});

check('paused is its own state and is not drawn as either of the two beside it', () => {
  const html = control(card({ assigned: true, by: 'label', paused: true, lastAt: AGO(90) }));
  assert.match(html, /Advocate paused/);
  assert.ok(!html.includes('data-act="advocate"'), 'a paused epic was offered a launch');
});

check('live is the session link, unchanged — and the way into its history beside it', () => {
  const live = { pid: 4242, name: 'human.bc-r2b5.epic-advocate', status: 'busy', at: AGO(1), opening: false };
  const html = control(card({ assigned: true, by: 'label', session: live, lastAt: AGO(1) }));
  assert.match(html, /href="\/session\?pid=4242"/);
  assert.match(html, /What the advocate is doing/);
  assert.match(html, /What it has done/, 'a live advocate lost the way into what it has already done');
  assert.ok(!html.includes('data-act="advocate"'));
});

check('opening is still a disabled button and still offers nothing to press', () => {
  const opening = { pid: null, name: '', status: '', at: AGO(1), opening: true };
  const html = control(card({ session: opening }, { advocate: opening }));
  assert.match(html, /disabled/);
  assert.ok(!html.includes('data-act="advocate"'), 'the launch was offered again a minute after it ran');
});

console.log('\nfinished — the close, offered rather than left to be noticed');

check('every child closed offers the close, and it opens the inbox card', () => {
  const html = control(card({ assigned: true, by: 'label', finished: true, lastAt: AGO(600) }), {
    byKey: () => ({ key: 'beadcause/bc-r2b5' }),
  });
  assert.match(html, /class="p0-done" data-act="p0-answer" data-key="beadcause\/bc-r2b5"/);
  assert.match(html, /Every child is closed/);
  // `expand` is the only way in, so nothing here rebuilds a decision block: that surface
  // is the hardest screen in public/app.js and a second copy of it drifts from the first
  // the day it lands.
  assert.ok(!html.includes('decision'), 'the card is rebuilding an answer surface of its own');
});

check('and no launch — there is nothing left under it for an advocate to plan', () => {
  const html = control(card({ finished: true }), { byKey: () => ({ key: 'beadcause/bc-r2b5' }) });
  assert.ok(!html.includes('data-act="advocate"'));
});

check('where the payload has no row for it, it says where the close is', () => {
  // `/api/questions?scope=agent` sweeps no questions at all. The epic is still finished;
  // the control is honestly unavailable, which is a different fact and is drawn as one.
  const html = control(card({ finished: true }), { byKey: () => null });
  assert.match(html, /p0-done is-none/);
  assert.match(html, /the close is on its inbox card/);
  assert.ok(!html.includes('data-act="p0-answer"'), 'a tap was offered over a row nothing can open');
});

check('nor over a bead an agent has, which is not a question anybody asked', () => {
  const html = control(card({ finished: true }), { byKey: () => ({ key: 'beadcause/bc-r2b5', agent: true }) });
  assert.match(html, /p0-done is-none/);
});

/* ------------------------------------------------------------------ the sheet */

console.log('\nthe sheet: where it is, what it planned, and what has run');

const PLAN = {
  epic: 'bc-r2b5',
  groups: [
    {
      name: 'the payload',
      beads: ['bc-r2b5.1', 'bc-r2b5.2'],
      files: ['lib/server.js'],
      prs: [{ repo: 'mordam/beadcause', title: '' }],
      prompt: 'x',
    },
  ],
};
const planComment = (plan) => ({
  text: `**Plan for bc-r2b5** — 1 group.\n\n<!-- beadcause:plan -->\n\`\`\`json\n${JSON.stringify(
    plan
  )}\n\`\`\`\n<!-- /beadcause:plan -->\n`,
});
const withPlan = (c, comments) => new Map([[c.key, { loading: false, bead: { id: c.id, comments } }]]);

check('where it is: the assignment, its carrier, and what is holding the next window', () => {
  const html = sheet(card({ assigned: true, by: 'label', lastAt: AGO(180), hold: 'another Mac holds the lease', heldAt: AGO(5) }));
  assert.match(html, /Where it is/);
  assert.match(html, /by the label the launch stamps/);
  assert.match(html, /last looked 3h ago/);
  assert.match(html, /another Mac holds the lease/);
  assert.match(html, /5m ago/);
});

check('and it names the other carrier as the other carrier', () => {
  // The two have different un-assign gestures — a label comes off with `bd label remove`
  // and the sentence is erased — so a sheet that said only "assigned" would be a screen
  // you cannot act on.
  assert.match(sheet(card({ assigned: true, by: 'waiting' })), /waiting-on block/);
});

check("the advocate's sentence in full, and 'not tracked' where there is none", () => {
  const long = 'waiting on #468 to merge before the client half can be planned at all';
  assert.match(sheet(card({ assigned: true, by: 'label' }, { waitingOn: long })), new RegExp(long));
  assert.match(sheet(card({ assigned: true, by: 'label' })), /Not tracked — no window has written/);
});

check('the plan, as groups, with how far each one has got', () => {
  const c = card({ assigned: true, by: 'label' });
  const html = sheet(c, { detail: withPlan(c, [planComment(PLAN)]) });
  assert.match(html, /the payload/);
  assert.match(html, /1 of 2 done/, 'the stage of work is the only figure here the advocate judged');
  assert.match(html, /touches lib\/server\.js/);
});

check('the LAST plan on the thread is the plan, exactly as `planFrom`', () => {
  const c = card({ assigned: true, by: 'label' });
  const second = { ...PLAN, groups: [{ ...PLAN.groups[0], name: 'the plan as revised' }] };
  const html = sheet(c, { detail: withPlan(c, [planComment(PLAN), planComment(second)]) });
  assert.match(html, /the plan as revised/);
  assert.ok(!html.includes('>the payload<'), 'the first plan is still being drawn as the plan');
});

check('a bead the plan names that has left the epic is unknown, not done and not open', () => {
  const c = card({ assigned: true, by: 'label' });
  const moved = { ...PLAN, groups: [{ ...PLAN.groups[0], beads: ['bc-r2b5.1', 'bc-elsewhere'] }] };
  const html = sheet(c, { detail: withPlan(c, [planComment(moved)]) });
  assert.match(html, /1 no longer under it/);
});

check('NO PLAN AND NOT-YET-READ ARE DIFFERENT ANSWERS', () => {
  const c = card({ assigned: true, by: 'label' });
  assert.match(sheet(c), /Reading bc-r2b5 from bd…/, '"we have not asked" was drawn as "there is none"');
  assert.match(sheet(c, { detail: withPlan(c, []) }), /No plan has been written on bc-r2b5/);
});

check('and a plan block nothing can parse keeps the prose it was written with', () => {
  const c = card({ assigned: true, by: 'label' });
  const broken = { text: '**Plan for bc-r2b5** — 1 group.\n\n<!-- beadcause:plan -->\n```json\n{ not json\n```\n' };
  const html = sheet(c, { detail: withPlan(c, [broken]) });
  assert.match(html, /could not be read as a plan/);
  assert.match(html, /Plan for bc-r2b5/, 'the advocate\'s own account of the plan was thrown away with the block');
});

check('its own sessions, in the archive\'s three states', () => {
  const c = card({ assigned: true, by: 'label' });
  assert.match(sheet(c), /looking for what it left…/, 'an archive nobody has asked for read as an empty one');
  const none = new Map([[c.key, { sessions: [] }]]);
  assert.match(sheet(c, { arc: none }), /No session archived/);
  const some = new Map([[c.key, { sessions: [{ commit: 'abc1234', at: AGO(240), subject: 'a turn' }] }]]);
  const html = sheet(c, { arc: some });
  assert.match(html, /1 session archived/);
  assert.match(html, /href="\/bead-session\?workspace=beadcause&amp;id=bc-r2b5"/);
});

check('and a check that failed offers the link anyway rather than claiming nothing ran', () => {
  const c = card({ assigned: true, by: 'label' });
  const failed = new Map([[c.key, { failed: true, sessions: [] }]]);
  assert.match(sheet(c, { arc: failed }), /if a session ran on this bead/);
});

check('per child, what ran on it — the live window and the archive', () => {
  const c = card({ assigned: true, by: 'label' });
  c.tree[1].session = { pid: 77, name: 'human.bc-r2b5.2.worker', status: 'busy' };
  const arc = new Map([['beadcause/bc-r2b5.1', { sessions: [{ commit: 'deadbee', at: AGO(600), subject: 'ran' }] }]]);
  const html = sheet(c, { arc });
  assert.match(html, /bc-r2b5\.1/);
  assert.match(html, /1 session archived/);
  assert.match(html, /A session is on it now/);
  assert.match(html, /human\.bc-r2b5\.2\.worker/);
});

check('ONE LEVEL, which is what "per child" means and what a `git log` each costs', () => {
  // A whole subtree would be one `/api/session-archive` — one `git log` — per descendant on
  // one tap. lib/finishedepic.js asks the tracker the same one-level question for the same
  // reason, so the two can never disagree about what a child is.
  const c = card({ assigned: true, by: 'label' });
  c.tree.push(kid('bc-r2b5.2.1', { parent: 'bc-r2b5.2', depth: 2 }));
  const html = sheet(c);
  assert.ok(!html.includes('bc-r2b5.2.1'), 'the sheet is asking the archive for a whole subtree');
});

check('an epic with nothing under it says so rather than drawing an empty section', () => {
  assert.match(sheet(card({ assigned: true, by: 'label' }, { tree: [] })), /Nothing hangs off bc-r2b5 yet/);
});

check('and a finished epic offers the close from in here too', () => {
  const html = sheet(card({ assigned: true, by: 'label', finished: true }), {
    byKey: () => ({ key: 'beadcause/bc-r2b5' }),
  });
  assert.match(html, /every child is closed, and the close is waiting on you/);
  assert.match(html, /data-act="p0-answer"/);
});

console.log('\nand nothing out of the tracker writes markup');

check('a hold reason, a group name and a child title are all escaped', () => {
  const c = card({ assigned: true, by: 'label', hold: '<img src=x onerror=alert(1)>' });
  c.tree[0].title = '<script>alert(2)</script>';
  const evil = { ...PLAN, groups: [{ ...PLAN.groups[0], name: '<b>bold</b>', files: ['<i>x</i>'] }] };
  const html = sheet(c, { detail: withPlan(c, [planComment(evil)]) });
  assert.ok(!html.includes('<img src=x'), 'a hold reason wrote markup into the sheet');
  assert.ok(!html.includes('<script>alert(2)'), 'a child title wrote markup into the sheet');
  assert.ok(!html.includes('<b>bold</b>'), 'a plan group name wrote markup into the sheet');
  assert.match(html, /&lt;img src=x/);
});

check('and the card control escapes the same three', () => {
  const html = control(card({ assigned: true, by: 'label', hold: '"><img src=x>' }));
  assert.ok(!html.includes('"><img src=x>'));
});

/* ------------------------------------------------------------------- the wiring */

console.log('\nthe wiring, which a renderer test would pass without');

check('the section draws the sheet, from a card that is still on the board', () => {
  // From `mine` rather than from the key alone: an epic taken off the board while its
  // advocate was open takes the sheet with it, instead of leaving a layer over a board it
  // is not on.
  assert.match(APP, /const advOn = mine\.find\(\(c\) => \(c\.key \|\| `\$\{c\.workspace\}\/\$\{c\.id\}`\) === state\.p0adv\);/);
  assert.match(APP, /advOn \? p0AdvFullHtml\(advOn\) : ''/);
});

check('the tap is a state write and a repaint, and it fetches three things', () => {
  const at = APP.indexOf("if (act === 'p0-adv' || act === 'p0-adv-close')");
  assert.notEqual(at, -1, 'the advocate sheet has no tap');
  const body = APP.slice(at, APP.indexOf('\n      return;\n    }', at));
  assert.match(body, /state\.p0adv = want;/);
  assert.match(body, /render\(true\);/);
  assert.match(body, /loadBeadDetail\(want, card\.workspace, card\.id\);/);
  assert.match(body, /loadBeadArchive\(want, card\.workspace, card\.id\);/);
  assert.match(body, /for \(const row of p0AdvKids\(card\)\)/);
  // The sheet covers the page, so holding the offset underneath is a promise about a
  // screen nobody can see — the same rule `p0-answer` keeps.
  assert.ok(!body.includes('keepTheScreenStill'), 'the tap is holding a page it is about to cover');
});

check('and the sheet is over the layer it can be opened from', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8');
  assert.match(css, /\.p0-adv \{ z-index: 41; \}/, 'the advocate sheet is not above the epic tab it opens over');
  assert.match(css, /\.p0-full \{[\s\S]*?z-index: 40;/);
});

check('answering puts the sheet away first, or the card opens underneath it', () => {
  const at = APP.indexOf("if (act === 'p0-answer') {");
  const body = APP.slice(at, APP.indexOf('\n      return;\n    }', at));
  assert.match(body, /state\.p0adv = null;/);
});

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall good\x1b[0m (${ran})\n`);
process.exit(failures ? 1 : 0);
