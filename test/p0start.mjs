#!/usr/bin/env node
/**
 * Starting an epic from the board, and taking one off again.
 *
 *     npm test
 *     node test/p0start.mjs
 *
 * bc-s8mc. The board is the P0s you have *started* (bc-6s96), which left the one screen
 * that says what the week is about as the one screen that could not change it: putting an
 * epic on it meant a laptop and `bd update <id> --claim`. This is the picker and the two
 * writes behind it, and both halves are here because the failure that matters spans them —
 * a list drawn from one rule and a door guarded by another lets you tap something that is
 * then refused, or worse, offers nothing and looks like a feature that is simply off.
 *
 * **The picker was at the foot of the board until bc-khoe.27.2 and is now what ＋ opens on
 * My Epics**, ＋ having become the view's own create (bc-khoe.27). The list, the rules
 * behind it and every refusal below are unchanged by that; what moved is which control
 * shows it, so the checks that used to read the section's own offer now read the rows on
 * their own and the section is checked for no longer carrying one.
 *
 * Seven things, and five of them fail quietly:
 *
 * 1. **The list is the server's and the picker draws it whole.** Which P0s may be offered is
 *    a question about the tracker — endorsed, not superseded, not a crash this app filed at
 *    P0 itself, open rather than blocked, yours rather than a colleague's — and every one of
 *    those is read off the graph the board is already built from. A client-side rule over
 *    the cards it happens to have would be a second answer, drawn from a payload that
 *    deliberately carries only the started ones.
 *
 * 2. **A crash is not an epic.** lib/errors.js files every daemon crash at P0 *with an
 *    owner*, so on a bad week the picker is a list of stack traces with the two epics you
 *    were looking for underneath them — and nothing about that reads as a bug, it reads as
 *    a tracker in a state. Same sentence `wantsAdvocate` makes, same rule.
 *
 * 3. **The write is a status write and nothing else.** Not `bd update --claim`, which is the
 *    same status plus an assignee: the assignee of an epic is who is on it, and a tap saying
 *    "this is my week" is not a claim to be doing it this minute. Asserted on the argv,
 *    because the wrong flag here works perfectly and quietly rewrites a field nobody looked
 *    at.
 *
 * 4. **The card arrives without a reload.** The board comes off `Bd.graph`, which is cached
 *    for a *minute* — so a write that does not refresh it leaves the screen with nothing to
 *    say for up to sixty seconds, having worked. That is the "silently absent card" this
 *    bead names, and the only way to catch it is to ask again immediately, well inside the
 *    TTL, and require the card to be there.
 *
 * 5. **Every refusal is loud.** The picker's list is up to one poll old, so the races it
 *    cannot see — closed since, started from the other device, superseded while you read —
 *    all arrive at the door. Each is a 409 with a sentence rather than a silent no-op.
 *
 * 6. **The reverse leaves the assignee alone.** `Bd.reopen` is the neighbouring write and
 *    clears it; taking an epic off the board is a decision about what leads your screen, and
 *    losing who is on the work as a side effect of that would be invisible on every screen
 *    that matters.
 *
 * 7. **With nothing started, the offer is still reachable.** An empty board switches the
 *    whole section off (bc-6s96) — which, with the picker inside that section, meant a new
 *    install could never start anything from the phone at all, and a `bare` section holding
 *    the offer alone was the answer. bc-khoe.27.2 answers it from the other end: ＋ is drawn
 *    on My Epics whether or not anything is started, so the same requirement is met by a
 *    button that is always on screen and the empty board draws nothing at all.
 *
 * The renderer half runs in a `node:vm` over slices of public/app.js — no DOM, no browser,
 * the same lift test/p0card.mjs uses. The route half runs the real server against a fake
 * `bd` that genuinely changes its mind: `update --status` rewrites the state its own
 * `export` answers from, which is what makes "and then it is a card" a claim about the whole
 * round trip rather than about one handler.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-p0start-'));
// Before lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.message).split('\n').slice(0, 6).join('\n      ')}`);
  }
}

/* ================================================================= the renderer */

const APP = read('public/app.js');

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

/** A started P0 — one card on the board, so the picker has something to sit under. */
const CARD = {
  key: 'alpha/zz-live',
  workspace: 'alpha',
  id: 'zz-live',
  title: 'The epic you are on',
  status: 'in_progress',
  issue_type: 'epic',
  open: 2,
  inFlight: 0,
  waitingOn: null,
  tree: [{ id: 'zz-live.1', title: 'a child', status: 'open', parent: 'zz-live', depth: 1, key: 'alpha/zz-live.1', pending: false }],
};

/** Two you could start, in the order the server sends them — most still open first. */
const CANDIDATES = [
  { key: 'alpha/zz-next', workspace: 'alpha', id: 'zz-next', title: 'The one with the most left', issue_type: 'epic', open: 12 },
  { key: 'alpha/zz-small', workspace: 'alpha', id: 'zz-small', title: 'A P0 nobody has broken down', issue_type: 'epic', open: 0 },
];

/**
 * The board, and the candidates, drawn for real out of a page state you hand it —
 * test/p0card.mjs's harness with `p0CandsHtml` added.
 *
 * Two entry points now rather than one, and that is bc-khoe.27.2's whole shape: the
 * section no longer draws the offer, and the rows are drawn into the panel above ＋ by
 * `showEpicPick`. The renderer half of this suite splits the same way — `board()` for
 * what is left of the section, `cands()` for what a tap on ＋ puts in the panel.
 */
function page({ roots = [CARD], startable = CANDIDATES, owned = true, space = 'all', workspace = 'all' } = {}) {
  const state = {
    rootboard: { owned, roots, startable, under: {} },
    p0open: new Set(),
    p0beadopen: new Set(),
    p0opening: new Map(),
    p0status: 'live',
    space,
    workspace,
    spaces: [],
  };
  const context = vm.createContext({ String, Number, Math, JSON, Date, encodeURIComponent, state, byKey: () => null });
  vm.runInContext(
    [
      lift(APP, 'const esc = ('),
      lift(APP, 'const cardId = ('),
      lift(APP, 'const spaceForWorkspace = ('),
      lift(APP, 'const STATUS_LABEL = '),
      lift(APP, 'function graphUrl(q)'),
      lift(APP, 'const P0_INDENT_CAP = '),
      lift(APP, 'const P0_SECTION_LABEL = '),
      lift(APP, 'const P0_STATUS_FILTERS = '),
      lift(APP, 'function p0StatusFilter()'),
      lift(APP, 'function p0Visible(rows)'),
      lift(APP, 'function p0StatusHtml(cards)'),
      // bc-grut: the collapsed card reads as a progress bar and an "N ask you" pill
      // rather than the hint line `p0HintText` drew, which went with the inline tree.
      lift(APP, 'function p0Progress(card)'),
      lift(APP, 'function p0ProgressHtml(card)'),
      lift(APP, 'const p0RowKey = ('),
      lift(APP, 'const p0Step = ('),
      lift(APP, 'function p0RowHtml(card, row)'),
      lift(APP, 'function p0BeadHtml(card, row)'),
      lift(APP, 'function p0TreeHtml(card)'),
      lift(APP, 'function openingHere(key)'),
      // bc-r2b5.2's four states, which `p0Control` derives through `p0AdvState` — lifted
      // with `relTime`, which the idle line's "last looked 3h ago" is written from.
      lift(APP, 'function relTime(iso)'),
      lift(APP, 'function p0AdvState(c)'),
      lift(APP, 'function p0AdvWhen(s)'),
      lift(APP, 'function p0AdvLine(s)'),
      lift(APP, 'function p0DoneHtml(c)'),
      lift(APP, 'function p0AdvOpenHtml(c, s)'),
      lift(APP, 'function p0Control(c)'),
      // bc-grut: the section is a grid cell, the tab a tap opens, and the head they share.
      lift(APP, 'const p0AsksHtml = '),
      lift(APP, 'function p0FaceHtml(c, asks, tail'),
      lift(APP, 'function p0ActsHtml(c, more'),
      lift(APP, 'function p0CardHtml(c)'),
      lift(APP, 'function p0FullHtml(c)'),
      // bc-rfnr.9.7's two, which `p0SectionHtml` reached for when the flat list went:
      // which cards the scope filters leave (the candidates go through the same one,
      // which is why it takes a list) and how many beads under them are asking you
      // something. Without them the section is a `ReferenceError` rather than a board.
      lift(APP, 'const p0AsksN = ('),
      lift(APP, 'function p0Cards(list)'),
      // The rows a tap on ＋ shows. Lifted beside the section rather than instead of it,
      // because the two have to be checked against one state: the claim that the offer
      // left the board is a claim about both at once.
      lift(APP, 'function p0CandsHtml(rows)'),
      lift(APP, 'function p0SectionHtml()'),
      'p0SectionHtml();',
    ].join('\n'),
    context
  );
  return {
    board: () => vm.runInContext('p0SectionHtml()', context),
    // Exactly what `showEpicPick` puts in the panel — the same two calls, in the same
    // order, so a filter that stopped being applied there would show up here.
    cands: () => vm.runInContext('p0CandsHtml(p0Cards(state.rootboard?.startable))', context),
  };
}
const board = (opts) => page(opts).board();
const cands = (opts) => page(opts).cands();

console.log('\nthe candidates ＋ offers on My Epics\n');

await check('every startable P0 is a row with its id, its title and what is left under it', () => {
  const html = cands();
  assert.match(html, /zz-next/);
  assert.match(html, /The one with the most left/);
  assert.match(html, /12 open/);
  // Nought is drawn rather than left off: an epic nobody has broken down yet is exactly
  // the one you are most likely to be starting, and a blank where a count goes reads as a
  // row that failed to load half of itself.
  assert.match(html, /0 open/);
  // The server's order, kept. Sorting here would be a second answer to "which of these is
  // the week most likely about", and the board's own cards are already sorted by it.
  assert.ok(html.indexOf('zz-next') < html.indexOf('zz-small'), 'the picker re-sorted the list');
});

await check('a row is a button carrying the workspace and the bead, so it is a tap and a keystroke', () => {
  const html = cands();
  // `data-bead` and not `data-key`: these are board controls, not inbox rows, and every
  // other branch of the click handler reads `data-key` as a bead key.
  assert.match(html, /<button type="button" class="p0-cand" data-act="p0-start" data-ws="alpha" data-bead="zz-next"/);
  assert.doesNotMatch(html, /class="p0-cand"[^>]*data-key=/, 'a candidate row carries an inbox row key');
});

await check('nothing to start says which of the reasons it is', () => {
  const html = cands({ startable: [] });
  assert.match(html, /Nothing to start/);
  assert.doesNotMatch(html, /data-act="p0-start"/);
});

await check('AND AN INSTALL THAT DOES NOT KNOW WHO IT IS SAYS THAT INSTEAD', () => {
  // The board could stay silent about `me` being unset, because with nothing owned it
  // draws nothing at all. ＋ cannot: it is on My Epics either way, and "every P0 you own
  // is already started" is a sentence about a list that was never asked for.
  const html = cands({ owned: false });
  assert.match(html, /does not know who you are/);
  assert.match(html, /<code>me<\/code>/);
  assert.doesNotMatch(html, /Nothing to start/, 'the wrong one of the two empty states');
});

await check('a candidate from a workspace this screen is not showing is not offered', () => {
  // Otherwise the tap puts a card on a board you would then have to switch spaces to see,
  // which reads as the write having failed.
  assert.doesNotMatch(cands({ workspace: 'beta' }), /zz-next/, 'the picker ignored the workspace filter');
});

await check('tracker text cannot write markup into the picker', () => {
  const html = cands({ startable: [{ ...CANDIDATES[0], title: '<img src=x onerror=alert(1)>' }] });
  assert.doesNotMatch(html, /<img/, 'a bead title reached the DOM as markup');
  assert.match(html, /&lt;img/, 'the title was dropped rather than escaped');
});

console.log('\nthe board no longer offers it, and ＋ does\n');

await check('THE FOOT OF THE BOARD CARRIES NO OFFER OF ITS OWN', () => {
  // The bead. Two controls doing one thing, one of them at the far end of a scroller past
  // every card on the board, is what the move undoes — so the section drawing it anyway
  // is the regression, not a harmless leftover.
  const html = board();
  assert.doesNotMatch(html, /data-act="p0-pick"/, 'the board still has its own picker button');
  assert.doesNotMatch(html, /Start an epic/, 'the board still offers to start one');
  assert.doesNotMatch(html, /data-act="p0-start"/, 'the candidates are drawn into the board');
});

await check('THE CARD STILL OFFERS THE REVERSE — one tap, back to open', () => {
  // Only the *start* half moved. Taking one off is a decision about a card that is on the
  // screen, so it stays on the card.
  const html = board();
  assert.match(html, /data-act="p0-unstart" data-ws="alpha" data-bead="zz-live"/);
  assert.match(html, /Take it off the board/);
});

await check('with nothing started the section is gone entirely, offer and all', () => {
  // It used to draw a `bare` section holding the offer alone, because with the picker
  // inside the section an empty board hid the one control that would end that state.
  // ＋ is drawn on My Epics whether or not anything is started, so the requirement is met
  // by a button that is always on screen and an empty box above the list is not needed.
  assert.equal(board({ roots: [] }), '', 'an empty board still draws a section');
  assert.equal(board({ roots: [], startable: [] }), '', 'an empty section is drawn where the flat inbox belongs');
});

console.log('\nwhat opens it\n');

await check('＋ branches on the kind, and on the word the kind table gives it', () => {
  // Not a list of kind ids in public/app.js: public/inboxfilter.js is the only place that
  // knows what the six kinds are, and a second one is a second thing that can be wrong
  // about them with nothing to say which is right.
  const FILTER = read('public/inboxfilter.js');
  assert.match(FILTER, /id: 'epics',[\s\S]{0,2000}?compose: 'epic',/, "the epics row does not say it creates an epic");
  assert.match(FILTER, /creates: \(\) => BY_ID\.get\(current\(\)\)\?\.compose \|\| '',/, 'inboxfilter.js exposes no `creates()`');
  const wiring = APP.slice(APP.indexOf("if (composeEl && composePickEl)"));
  assert.match(
    wiring,
    /inboxFilter\?\.creates\?\.\(\) \|\| 'chat'\) === 'epic'\) \{\s*\n\s*showEpicPick\(\);/,
    '＋ does not open the epic picker on My Epics'
  );
  // The fallback is the create ＋ has always made, for a page whose filter script never
  // loaded — the same generosity `composes()` gets, for the same reason.
  assert.ok(wiring.includes("|| 'chat'"), 'a page without inboxfilter.js gets no create at all');
});

await check('the panel it opens is inside the fixed wrapper, which is what removes the scroll problem', () => {
  // The tap used to grow the board, which is *above* the inbox list, so the repaint was
  // wrapped in `keepTheScreenStill` or the list's place-restore pushed the page down by
  // exactly the height of what had opened. A panel in the fixed wrapper adds no flow
  // height at all: there is nothing above the anchor to grow.
  const HTML = read('public/index.html');
  const wrap = HTML.slice(HTML.indexOf('<div class="compose-wrap">'));
  const inside = wrap.slice(0, wrap.indexOf('</div>', wrap.indexOf('id="compose"')));
  assert.ok(inside.includes('id="compose-epics"'), 'the epic picker is not inside .compose-wrap');
  assert.ok(inside.includes('id="compose-epics-row"'), 'nothing in the panel holds the rows');
  assert.doesNotMatch(APP, /p0-pick/, 'the board picker survived somewhere in public/app.js');
  assert.doesNotMatch(APP, /state\.p0picker/, 'the picker still has page state behind it');
});

await check('and the rows in it reach the write, which is not on the list handler', () => {
  // `[data-act]` delegation is on `#list` and the panel is not in it, so the rows need a
  // listener of their own — and it tests `data-act` rather than `data-ws`, which the repo
  // chips in the panel next door also carry and which means the other create entirely.
  assert.match(
    APP,
    /\$\('#compose-epics-row'\)\?\.addEventListener\('click', \(ev\) => \{\s*\n\s*const cand = ev\.target\.closest\('\[data-act="p0-start"\]'\);\s*\n\s*if \(cand\) setOnBoard\(cand, true\);/,
    'nothing in the panel starts an epic'
  );
  // One write, from both controls. A copy beside the panel is what would drift: the
  // refusal handling is the feature rather than incidental to it.
  assert.match(APP, /async function setOnBoard\(btn, on\)/, 'the shared write is gone');
  assert.match(APP, /if \(act === 'p0-unstart'\) \{\s*\n\s*await setOnBoard\(btn, false\);/, 'the card control writes its own way');
});

/* ==================================================================== the routes */

const ME = 'adam@example.com';

const row = (id, extra = {}) => ({
  id,
  title: `bead ${id}`,
  status: 'open',
  priority: 2,
  issue_type: 'task',
  assignee: '',
  labels: [],
  dependencies: [],
  ...extra,
});
const parentEdge = (child, parent) => ({ issue_id: child, depends_on_id: parent, type: 'parent-child' });
const mineP0 = (id, extra = {}) => row(id, { priority: 0, issue_type: 'epic', labels: [`owner:${ME}`], ...extra });

/**
 * One tracker holding every shape the picker has to judge.
 *
 * The four that must not be offered are the point of the fixture: each is P0, each is
 * yours, each is open, and each is a bead something downstream would refuse — so a picker
 * built on "P0 and open and mine" alone passes every other assertion in this file and
 * still hands you four taps that end in a 409.
 */
const BEADS = [
  mineP0('zz-live', { status: 'in_progress', title: 'The epic you are on' }),
  row('zz-live.1', { dependencies: [parentEdge('zz-live.1', 'zz-live')] }),
  mineP0('zz-next', { title: 'The one with the most left' }),
  row('zz-next.1', { dependencies: [parentEdge('zz-next.1', 'zz-next')] }),
  row('zz-next.2', { dependencies: [parentEdge('zz-next.2', 'zz-next')] }),
  row('zz-next.3', { status: 'closed', dependencies: [parentEdge('zz-next.3', 'zz-next')] }),
  mineP0('zz-small', { title: 'A P0 nobody has broken down' }),
  mineP0('zz-shut', { status: 'closed' }),
  mineP0('zz-blocked', { status: 'blocked' }),
  mineP0('zz-held', { labels: [`owner:${ME}`, 'unendorsed'] }),
  mineP0('zz-dupe', { labels: [`owner:${ME}`, 'superseded-by:zz-next'] }),
  mineP0('zz-crash', { labels: [`owner:${ME}`, 'app-error'], title: 'TypeError: cannot read properties of null' }),
  row('zz-theirs', { priority: 0, issue_type: 'epic', labels: ['owner:bob@example.com'] }),
  row('zz-p2', { priority: 2, labels: [`owner:${ME}`] }),
];

const WS = [{ name: 'alpha', dir: path.join(tmp, 'alpha', '.beads') }];
fs.mkdirSync(WS[0].dir, { recursive: true });

/**
 * A fake `bd` that changes its mind.
 *
 * `update <id> --status <s>` writes to a state file its own `export` and `show` then read,
 * which is what makes "start it and it is a card" a claim about the round trip — the write,
 * the graph refresh, and the next payload — rather than about one handler answering 200.
 * Every argv is logged, because two of the assertions here are about what was *not* passed.
 */
const BD_LOG = path.join(tmp, 'bd.log');
const BD_STATE = path.join(tmp, 'status.json');
fs.writeFileSync(BD_LOG, '');
fs.writeFileSync(BD_STATE, '{}');
const BD = path.join(tmp, 'bd.cjs');
fs.writeFileSync(
  BD,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(BD_LOG)}, args.join(' ') + '\\n');
const beads = ${JSON.stringify(BEADS)};
const moved = JSON.parse(fs.readFileSync(${JSON.stringify(BD_STATE)}, 'utf8'));
const now = beads.map((b) => (moved[b.id] ? { ...b, status: moved[b.id] } : b));
if (args[0] === 'export') {
  process.stdout.write(now.map((b) => JSON.stringify(b)).join('\\n'));
  process.exit(0);
}
if (args[0] === 'update') {
  const at = args.indexOf('--status');
  if (at === -1) { process.stderr.write('bd: nothing to do'); process.exit(1); }
  moved[args[1]] = args[at + 1];
  fs.writeFileSync(${JSON.stringify(BD_STATE)}, JSON.stringify(moved));
  process.stdout.write('ok');
  process.exit(0);
}
if (args[0] === 'show') {
  const hit = now.find((b) => b.id === args[1]);
  if (!hit) { process.stderr.write('bd: no issue found matching ' + args[1]); process.exit(1); }
  process.stdout.write(JSON.stringify([hit]));
  process.exit(0);
}
if (args[0] === 'human' && args[1] === 'list') { process.stdout.write('[]'); process.exit(0); }
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const bdLog = () => fs.readFileSync(BD_LOG, 'utf8');

const cfg = {
  port: 0,
  host: '127.0.0.1',
  token: 'p0start-token',
  bdBin: BD,
  actor: 'beadcause-test',
  me: ME,
  workspaces: WS,
  spaces: [],
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  agents: [],
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const { createApp, listen } = await import(path.join(ROOT, 'lib', 'server.js'));
const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const PORT = await boundPort(servers);

const getJson = async (p) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { headers: { 'x-beadcause-token': cfg.token } });
  assert.equal(res.status, 200, `GET ${p} should be 200, got ${res.status}`);
  return res.json();
};

const post = async (p, body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method: 'POST',
    headers: { 'x-beadcause-token': cfg.token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

/** `Bd.graph` is `wait: false` on the request path, so the first payload is always cold. */
async function boardWhenWarm() {
  for (let i = 0; i < 60; i += 1) {
    const payload = await getJson('/api/questions');
    if ((payload.rootboard?.roots || []).length) return payload;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the root board never warmed up — no roots after six seconds of asking');
}

console.log('\nthe two writes behind it\n');

try {
  const warm = await boardWhenWarm();

  await check('THE LIST IS EXACTLY THE P0S OF YOURS THAT ARE OPEN AND NOT STARTED', () => {
    assert.deepEqual(
      (warm.rootboard.startable || []).map((c) => c.id),
      ['zz-next', 'zz-small'],
      'the picker would offer a bead the door refuses, or miss one it takes'
    );
  });

  await check('and each row carries what it draws: the count of what is left under it', () => {
    const [next, small] = warm.rootboard.startable;
    assert.equal(next.open, 2, 'the closed child was counted, or the open ones were not');
    assert.equal(small.open, 0);
    assert.equal(next.key, 'alpha/zz-next');
    assert.equal(next.title, 'The one with the most left');
    // Not the tree. Forty candidates each carrying their whole subtree is the board's
    // heaviest field multiplied by the backlog, on every poll, to draw a list of titles.
    assert.equal(next.tree, undefined, 'a candidate is carrying a tree it will never draw');
  });

  await check('A CRASH THIS APP FILED IS NOT OFFERED AS AN EPIC', () => {
    // lib/errors.js files these at P0 *with an owner*, so on a bad week they are the
    // majority of the list — and each one is a tap the advocate door refuses by name.
    const ids = warm.rootboard.startable.map((c) => c.id);
    assert.equal(ids.includes('zz-crash'), false, 'a stack trace is on offer as something to start');
  });

  await check('nor is one that is held, superseded, blocked, closed, somebody else’s, or not a root', () => {
    const ids = warm.rootboard.startable.map((c) => c.id);
    for (const id of ['zz-held', 'zz-dupe', 'zz-blocked', 'zz-shut', 'zz-theirs', 'zz-p2', 'zz-live']) {
      assert.equal(ids.includes(id), false, `${id} is on offer`);
    }
  });

  await check('starting one answers 200 and says what it did', async () => {
    const out = await post('/api/bead/start', { workspace: 'alpha', id: 'zz-small' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual(out.body, { workspace: 'alpha', id: 'zz-small', started: true, status: 'in_progress' });
  });

  await check('THE WRITE IS A STATUS AND NOTHING ELSE — never a claim, never an assignee', () => {
    const line = bdLog()
      .split('\n')
      .find((l) => l.startsWith('update zz-small'));
    assert.ok(line, 'nothing was written to bd at all');
    assert.match(line, /^update zz-small --status in_progress /, `bd was asked: ${line}`);
    assert.doesNotMatch(line, /--claim|--assignee/, `the tap rewrote who is on the epic: ${line}`);
  });

  await check('AND IT IS A CARD ON THE NEXT POLL — inside the graph cache’s own minute', async () => {
    // The whole of bc-s8mc's fourth acceptance criterion. `Bd.graph` holds a workspace for
    // sixty seconds; without the refresh inside the write this assertion fails for that
    // long, with the write having worked and the screen having nothing to say about it.
    const after = await getJson('/api/questions');
    assert.deepEqual(
      after.rootboard.roots.map((c) => c.id).sort(),
      ['zz-live', 'zz-small'],
      'the card did not arrive — the graph cache was not refreshed by the write'
    );
    assert.equal(
      after.rootboard.startable.some((c) => c.id === 'zz-small'),
      false,
      'the epic you just started is still on offer as something to start'
    );
  });

  await check('taking it off again puts it back exactly where it was', async () => {
    const out = await post('/api/bead/unstart', { workspace: 'alpha', id: 'zz-small' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual(out.body, { workspace: 'alpha', id: 'zz-small', started: false, status: 'open' });
    const after = await getJson('/api/questions');
    assert.deepEqual(after.rootboard.roots.map((c) => c.id), ['zz-live'], 'the card is still on the board');
    assert.equal(after.rootboard.startable.some((c) => c.id === 'zz-small'), true, 'it did not come back to the picker');
  });

  await check('and it leaves the assignee alone, unlike a reopen', () => {
    const line = bdLog()
      .split('\n')
      .find((l) => l.startsWith('update zz-small --status open'));
    assert.ok(line, 'nothing took it off the board');
    assert.doesNotMatch(line, /--assignee/, `taking an epic off the board erased who is on it: ${line}`);
  });

  console.log('\nand every refusal is a sentence\n');

  const refusals = [
    ['a P0 that is already started', '/api/bead/start', 'zz-live', 409, /already on the board/],
    ['a crash bead, at the door as well as in the list', '/api/bead/start', 'zz-crash', 409, /crash/],
    ['one nobody has endorsed', '/api/bead/start', 'zz-held', 409, /unendorsed/],
    ['one that is superseded', '/api/bead/start', 'zz-dupe', 409, /superseded/],
    ['one the tracker says is blocked', '/api/bead/start', 'zz-blocked', 409, /blocked, not open/],
    ['one that has closed', '/api/bead/start', 'zz-shut', 409, /closed/],
    ['somebody else’s P0', '/api/bead/start', 'zz-theirs', 409, /not yours to put on the board/],
    ['a bead that is neither an epic nor a P0', '/api/bead/start', 'zz-p2', 409, /not an epic or a P0/],
    ['a bead that does not exist', '/api/bead/start', 'zz-ghost', 404, /no such bead/],
    ['a P0 that is not on the board', '/api/bead/unstart', 'zz-next', 409, /not on the board/],
  ];

  for (const [what, route, id, status, why] of refusals) {
    await check(`${what} is a ${status} that says so`, async () => {
      const out = await post(route, { workspace: 'alpha', id });
      assert.equal(out.status, status, `${id}: ${JSON.stringify(out.body)}`);
      assert.match(out.body.error || '', why);
      // The sentence is what the phone draws, so it has to name the bead it is about.
      assert.match(out.body.error || '', new RegExp(id));
    });
  }

  await check('an id that is not an id is a 400 before anything is read', async () => {
    const before = bdLog().length;
    const out = await post('/api/bead/start', { workspace: 'alpha', id: '../../etc/passwd' });
    assert.equal(out.status, 400);
    assert.match(out.body.error, /not a bead id/);
    assert.equal(bdLog().length, before, 'a malformed id reached bd');
  });

  await check('and an unknown workspace is a 400 naming it', async () => {
    const out = await post('/api/bead/start', { workspace: 'nowhere', id: 'zz-next' });
    assert.equal(out.status, 400);
    assert.match(out.body.error, /unknown workspace/);
  });

  await check('NOTHING WAS WRITTEN BY ANY REFUSAL', () => {
    // The one that makes the rest of them mean something: a door that answers 409 *after*
    // writing is a door that refused you and did it anyway, and every screen would agree
    // with the write rather than with the sentence.
    const writes = bdLog()
      .split('\n')
      .filter((l) => l.startsWith('update '));
    assert.deepEqual(writes.map((l) => l.split(' ').slice(0, 4).join(' ')), [
      'update zz-small --status in_progress',
      'update zz-small --status open',
    ]);
  });
} finally {
  for (const s of servers || []) s.close?.();
  app.stop?.();
  await cleanupTmp(tmp);
}

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
