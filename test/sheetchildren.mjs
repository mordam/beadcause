#!/usr/bin/env node
/**
 * A bead's children on its sheet — the list, the fold, and the call that fetches them.
 *
 *     npm test
 *     node test/sheetchildren.mjs
 *
 * An epic's children were readable in a terminal and nowhere else. The sheet has every
 * other thing `bd show` prints, but children are the one part that is **not in the JSON
 * at all**: `bd show --json` on bc-goo, an epic with seven, answers `dependent_count: 7`
 * and no rows whatsoever. The text output has a CHILDREN section; the payload has
 * nothing to read it from. So this is a second `bd` call, and the three ways a second
 * call can go wrong are what most of this file is about.
 *
 * The claims, in the order they can bite:
 *
 * 1. **The call asks for all of them.** `bd list` hides closed issues by default and
 *    truncates at fifty, silently, both times. Either one turns "6/7 done" into a
 *    number that is simply false — and a fraction is the one thing on the block you
 *    cannot check by eye.
 * 2. **The order is ours, not bd's.** bd prints bc-goo's seven as 5, 7, 1, 4, 6, 2, 3.
 *    Open work first and the closed tail last is what makes folding the closed ones
 *    away cheap to look at: the rows that go are at the bottom, so nothing above them
 *    moves.
 * 3. **The sheet does not wait on it.** The block is a slot in `sheetHtml` that is empty
 *    at first paint, and absent on a bead that cannot have children — so a bead with
 *    none looks exactly as it did before this existed, and a call that never comes back
 *    costs the block and nothing else.
 * 4. **The fold is the point, and its default is *shown*.** An epic whose finished work
 *    is invisible reads as though it never started.
 * 5. **The call is `/api/bead-links`, and its two halves do not overlap.** The children
 *    ride the same `bd dep list --direction=up` that answers what the bead blocks — one
 *    round trip for both — so the route has to lift the `parent-child` rows out of the
 *    dependents rather than leaving the same beads in both lists. `Bd.children` is still
 *    `bd list --parent` and still tested here, because the close gate and the advocate
 *    read it. What the Blocks half then *draws* is test/sheetblocks.mjs.
 *
 * **How it runs the real client code.** public/graph.js is one IIFE over a live DOM, so
 * it cannot be imported. The region from `beadUrl` to the end of `sheetHtml` is pure
 * string building, though, and is sliced out and evaluated with its four helpers
 * stubbed — the same trick, and the same markers, as test/graphsheet.mjs. The fold state
 * is a parameter of `childrenHtml` rather than something it reads, which is what lets it
 * run in here with no DOM and no localStorage.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${err.message.split('\n')[0]}`);
  }
};

/* ==================================================== the call that fetches them */

const { Bd } = await import(path.join(ROOT, 'lib', 'bd.js'));

const WS = { name: 'demo', dir: '/nowhere' };

/** A Bd whose `run` records its argv and answers from a fixture. */
function fakeBd(rows) {
  const bd = new Bd({ bin: '/nonexistent/bd', actor: 'beadcause' });
  bd.calls = [];
  bd.run = async (workspace, args) => {
    bd.calls.push(args.join(' '));
    return JSON.stringify(rows);
  };
  return bd;
}

/** bc-goo's seven, in the order bd itself hands them over. */
const GOO = [
  { id: 'bc-goo.5', title: 'A separate channel for foundation requests', status: 'closed', issue_type: 'task', priority: 2, description: 'x'.repeat(2000) },
  { id: 'bc-goo.7', title: 'An agents page', status: 'closed', issue_type: 'task', priority: 1, description: 'x'.repeat(2000) },
  { id: 'bc-goo.1', title: 'Tier 1 — a ref namespace per agent', status: 'closed', issue_type: 'task', priority: 2 },
  { id: 'bc-goo.4', title: 'The amendment loop', status: 'closed', issue_type: 'task', priority: 2 },
  { id: 'bc-goo.6', title: 'Tier 3 experiment', status: 'open', issue_type: 'task', priority: 3 },
  { id: 'bc-goo.2', title: 'Tier 2 — an agent-facing memory API', status: 'closed', issue_type: 'task', priority: 2 },
  { id: 'bc-goo.3', title: 'The foundation definition', status: 'closed', issue_type: 'task', priority: 2 },
];

console.log('\nasking bd for them');

await (async () => {
  const bd = fakeBd(GOO);
  const kids = await bd.children(WS, 'bc-goo');
  const argv = bd.calls.join(' | ');

  check('it is `bd list --parent`, because `bd show` does not know', () => {
    assert.match(argv, /list --parent bc-goo/, argv);
  });

  check('`--all`, or the six closed children of bc-goo are simply not there', () => {
    assert.match(argv, /--all/, argv);
  });

  check('`--limit 0`, because bd stops at fifty without a word', () => {
    assert.match(argv, /--limit 0/, argv);
  });

  check('every child comes back, closed ones included', () => {
    assert.equal(kids.length, 7, `${kids.length} of 7`);
  });

  check('open work first, then the closed tail, each by id', () => {
    assert.deepEqual(
      kids.map((c) => c.id),
      ['bc-goo.6', 'bc-goo.1', 'bc-goo.2', 'bc-goo.3', 'bc-goo.4', 'bc-goo.5', 'bc-goo.7']
    );
  });

  check('and the descriptions are left behind rather than sent to a phone', () => {
    assert.deepEqual(Object.keys(kids[0]).sort(), ['id', 'issue_type', 'priority', 'status', 'title']);
  });
})();

// `check` is synchronous on purpose — an async body would resolve to a promise nobody
// looks at, and a failed assertion inside one would pass silently. So the awaiting is
// done out here and only the assertion goes in.
const tenth = await fakeBd([
  { id: 'bc-e.10', title: 'ten', status: 'open' },
  { id: 'bc-e.9', title: 'nine', status: 'open' },
  { id: 'bc-e.1', title: 'one', status: 'open' },
]).children(WS, 'bc-e');

check('a tenth child sorts after the ninth, not between the first and the second', () => {
  // bd's ids are `bc-goo.1` … `bc-goo.10`, and a plain string sort files .10 second.
  assert.deepEqual(tenth.map((c) => c.id), ['bc-e.1', 'bc-e.9', 'bc-e.10']);
});

const none = await fakeBd([]).children(WS, 'bc-nope');
check('a bead with no children is an empty list, not an error', () => {
  assert.deepEqual(none, []);
});

/* ============================================ the real code, in a bare room */

const GRAPH = read('public/graph.js');

const START = 'const beadUrl = (id) =>';
const END = "return parts.join('');";
const from = GRAPH.indexOf(START);
const to = GRAPH.indexOf(END, from);
if (from < 0 || to < 0) {
  console.log('  \x1b[31m✗\x1b[0m public/graph.js no longer has a beadUrl…sheetHtml region to slice');
  process.exit(1);
}
const close = GRAPH.indexOf('\n  }', to);
const region = GRAPH.slice(from, close + 4);

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
const ctx = vm.createContext({
  esc,
  statusColor: (s) => `colour(${s || 'open'})`,
  md: (t) => `<md>${t}</md>`,
  FROM_BD: { breaks: false },
  workspace: 'beadcause',
});
const { childrenHtml, hasDependents, sheetHtml } = vm.runInContext(
  `${region}\n;({ childrenHtml, hasDependents, sheetHtml })`,
  ctx,
  { filename: 'graph.js#children' }
);

const kid = (id, title, status = 'open') => ({ id, title, status });
const SEVEN = [
  kid('bc-goo.6', 'Tier 3 experiment'),
  kid('bc-goo.1', 'Tier 1', 'closed'),
  kid('bc-goo.2', 'Tier 2', 'closed'),
  kid('bc-goo.3', 'The foundation definition', 'closed'),
  kid('bc-goo.4', 'The amendment loop', 'closed'),
  kid('bc-goo.5', 'A separate channel', 'closed'),
  kid('bc-goo.7', 'An agents page', 'closed'),
];

const rows = (html) => html.match(/<a class="rel-row[\s\S]*?<\/a>/g) || [];

/* ------------------------------------------------------------ what it draws */

console.log('\nthe block');

check('one tappable row per child, closed ones included', () => {
  const html = childrenHtml(SEVEN, false);
  assert.equal(rows(html).length, 7, `${rows(html).length} rows for 7 children`);
});

check('a row carries the id, the title and the status as colour', () => {
  const html = childrenHtml([kid('bc-goo.6', 'Tier 3 experiment')], false);
  assert.ok(html.includes('bc-goo.6'), 'no id on the row');
  assert.ok(html.includes('Tier 3 experiment'), 'no title on the row');
  assert.match(html, /background:colour\(open\)/, 'no status colour on the row');
});

check('and lands on that child’s own sheet', () => {
  assert.match(
    childrenHtml([kid('bc-goo.6', 'Tier 3')], false),
    /href="\/graph\?ws=beadcause&amp;id=bc-goo\.6&amp;open=1"/,
    'a child row is not a /graph?…&open=1 link'
  );
});

check('the fraction bd prints is beside the heading', () => {
  assert.ok(childrenHtml(SEVEN, false).includes('6/7 done'), 'no completion count');
});

check('a closed child is stepped back as well as greyed', () => {
  const html = childrenHtml([kid('bc-goo.1', 'Tier 1', 'closed')], false);
  assert.match(html, /class="rel-row is-closed"/, 'a closed row is not marked closed');
  assert.match(html, /background:colour\(closed\)/, 'a closed row is not coloured closed');
});

check('an open child is not', () => {
  assert.ok(!childrenHtml([kid('bc-goo.6', 'Tier 3')], false).includes('is-closed'), 'an open row was dimmed');
});

check('a title somebody wrote markup into is escaped, not rendered', () => {
  const html = childrenHtml([kid('bc-evil', '<img src=x onerror="boom">')], false);
  assert.ok(!html.includes('<img'), 'a child title was injected as markup');
  assert.ok(html.includes('&lt;img'), 'the title was dropped instead of escaped');
});

console.log('\nthe fold');

check('closed children are shown by default — nothing is hidden on your behalf', () => {
  const html = childrenHtml(SEVEN, false);
  assert.equal(rows(html).length, 7);
  assert.ok(html.includes('Hide closed (6)'), 'the control does not say what it would hide');
  assert.ok(html.includes('aria-pressed="false"'), 'the control does not say it is off');
});

check('folded, only the open work is left — and the button says how many went', () => {
  const html = childrenHtml(SEVEN, true);
  const left = rows(html);
  assert.equal(left.length, 1, `${left.length} rows left of 1 open`);
  assert.ok(left[0].includes('bc-goo.6'), 'the row left is not the open one');
  assert.ok(html.includes('Show closed (6)'), 'the count of what is hidden is not on the control');
  assert.ok(html.includes('aria-pressed="true"'), 'the control does not say it is on');
});

check('the fraction still counts every child, folded or not', () => {
  assert.ok(childrenHtml(SEVEN, true).includes('6/7 done'), 'the fold changed the fraction');
});

check('no control on an epic with nothing finished — it would hide nothing', () => {
  const html = childrenHtml([kid('bc-e.1', 'One'), kid('bc-e.2', 'Two')], false);
  assert.ok(!html.includes('kids-toggle'), 'a fold was offered over zero closed children');
  assert.ok(html.includes('0/2 done'), 'the fraction is missing');
});

check('an epic that is entirely done folds down to its heading and nothing else', () => {
  const html = childrenHtml([kid('bc-e.1', 'One', 'closed')], true);
  assert.equal(rows(html).length, 0, 'a closed child survived the fold');
  assert.ok(html.includes('Show closed (1)'), 'no way back to the rows that went');
});

check('no children at all is nothing at all, not an empty heading', () => {
  assert.equal(childrenHtml([], false), '');
  assert.equal(childrenHtml(null, false), '');
});

/* ------------------------------------------- and what the first paint costs */

console.log('\nwhat the sheet pays for it');

const epic = { id: 'bc-goo', title: 'An epic', status: 'in_progress', description: 'Some prose.', dependent_count: 7 };
const leaf = { id: 'bc-7w1l', title: 'On its own', status: 'open', description: 'Some prose.' };

check('a bead with nothing pointing at it is never asked about', () => {
  assert.equal(hasDependents(leaf), false);
  assert.equal(hasDependents({ dependent_count: 0 }), false);
  assert.equal(hasDependents(null), false);
});

check('a bead with dependents is — one of them may be a child, and the rest are Blocks', () => {
  assert.equal(hasDependents(epic), true);
});

check('the slot is empty at first paint — the sheet never waits on the call', () => {
  const html = sheetHtml(epic);
  assert.ok(html.includes('<div id="sheet-links"></div>'), 'no slot for the children to land in');
  assert.ok(!html.includes('Children'), 'a heading was drawn before the children arrived');
});

check('it sits below the description, where landing late shifts nothing above it', () => {
  const html = sheetHtml(epic);
  assert.ok(html.indexOf('Some prose.') < html.indexOf('sheet-links'), 'the slot is above the description');
});

check('and a bead that cannot have children draws no slot at all', () => {
  assert.ok(!sheetHtml(leaf).includes('sheet-links'), 'a leaf bead carries a children slot');
});

/* ------------------------------------------------------- the style it wears */

check('the block has a style to wear', () => {
  const css = read('public/style.css');
  for (const sel of ['.kids-head', '.kids-count', '.kids-toggle', '.rel-row.is-closed']) {
    assert.ok(css.includes(sel), `${sel} has no rule in style.css`);
  }
  // The fold is a control you hit with a thumb, not a word you read.
  assert.match(css, /\.kids-toggle \{[\s\S]*?min-height: 36px/, '.kids-toggle is smaller than a thumb');
});

/* ============================================== the route, against a real server */

console.log('\nthe route');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-kids-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const ws = path.join(tmp, 'ws');
fs.mkdirSync(path.join(ws, '.beads'), { recursive: true });

// A `bd` that answers `dep list --direction=up` with bc-goo's seven children and one
// bead that is not a child, and everything else with an empty list — so the shape the
// sheet reads is proved end to end, through the real handler and the real adapter,
// without a tracker to seed. The route is the thing that has to keep those two apart.
const UP = [
  ...GOO.map((r) => ({ ...r, dependency_type: 'parent-child' })),
  { id: 'bc-2ocm', title: 'Something waiting on the epic', status: 'open', dependency_type: 'blocks' },
];
const FAKE = path.join(tmp, 'bd');
fs.writeFileSync(
  FAKE,
  `#!/usr/bin/env node
const argv = process.argv.slice(2);
const rows = ${JSON.stringify(JSON.stringify(UP))};
if (argv[0] !== 'dep' || argv[1] !== 'list' || !argv.includes('--direction=up')) {
  process.stdout.write('[]');
} else if (argv[2] !== 'bc-goo') {
  // What the real bd says for an id it cannot resolve — it exits non-zero rather than
  // answering with an empty list, which is the one thing \`dep list\` does differently
  // from \`list --parent\`.
  process.stderr.write('resolving ' + argv[2] + ': no issue found matching "' + argv[2] + '"');
  process.exit(1);
} else {
  process.stdout.write(rows);
}
`,
  { mode: 0o755 }
);

const cfg = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'kids-token',
  actor: 'beadcause-test',
  bdBin: FAKE,
  workspaces: [{ name: 'demo', dir: ws }],
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

// foundation.js first: it and agents.js import each other, and agents.js is not the
// end of that cycle that can be pulled in cold.
await import(path.join(ROOT, 'lib', 'foundation.js'));
const { createApp, listen } = await import(path.join(ROOT, 'lib', 'server.js'));

const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port: p } = probe.address();
    probe.close(() => resolve(p));
  });
});

const app = createApp({ ...cfg, port });
const servers = listen({ ...cfg, port }, app.handler);

const get = (pathname) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', headers: { 'x-beadcause-token': cfg.token } },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(out || '{}') }));
      }
    );
    req.on('error', reject);
    req.end();
  });

for (let i = 0; i < 100; i += 1) {
  try {
    await get('/api/health');
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 20));
  }
}

const answer = await get('/api/bead-links?workspace=demo&id=bc-goo');

check('GET /api/bead-links answers 200', () => {
  assert.equal(answer.status, 200, JSON.stringify(answer.json).slice(0, 160));
});

check('with every child, in the order the block draws them', () => {
  assert.deepEqual(
    (answer.json.children || []).map((c) => c.id),
    ['bc-goo.6', 'bc-goo.1', 'bc-goo.2', 'bc-goo.3', 'bc-goo.4', 'bc-goo.5', 'bc-goo.7']
  );
});

check('and the rows the sheet reads, without the descriptions it does not', () => {
  const first = (answer.json.children || [])[0] || {};
  assert.ok(first.title, 'no title on a row');
  assert.ok(!('description' in first), 'the full description was sent to the phone');
});

check('the beads that are not children come back separately, off the same call', () => {
  assert.deepEqual((answer.json.dependents || []).map((d) => d.id), ['bc-2ocm']);
});

check('and no child is among them — the same bead twice is what the split is for', () => {
  const both = (answer.json.dependents || []).filter((d) => (answer.json.children || []).some((c) => c.id === d.id));
  assert.deepEqual(both, [], 'a child was also listed as a dependent');
});

const gone = await get('/api/bead-links?workspace=demo&id=bc-gone');
check('a bead deleted since the sheet opened is a 404, not a 500', () => {
  assert.equal(gone.status, 404, JSON.stringify(gone.json).slice(0, 160));
});

const nonsense = await get('/api/bead-links?workspace=demo&id=../../etc/passwd');
check('an id that is not a bead id is a 400, not a lookup', () => {
  assert.equal(nonsense.status, 400, JSON.stringify(nonsense.json).slice(0, 160));
});

const nowhere = await get('/api/bead-links?workspace=nosuchworkspace&id=bc-goo');
check('an unknown workspace is refused rather than 500ing', () => {
  assert.ok(nowhere.status >= 400 && nowhere.status < 500, `got ${nowhere.status}`);
});

for (const s of servers) s.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures ? `\n${failures} failed\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
