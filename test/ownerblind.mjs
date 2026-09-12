#!/usr/bin/env node
/**
 * A workspace nobody has labelled says so, instead of drawing an empty board.
 *
 *     npm test
 *     node test/ownerblind.mjs
 *
 * bc-njfui. Adam filed eight epics in `deluvia`, owned every one of them by `bd`'s own
 * reckoning, and My Beadepics drew nothing — an empty board *and* an empty ＋, which is
 * the pair of symptoms that makes this worth a suite rather than a line.
 *
 * The cause is not the render path. Ownership is the `owner:<handle>` label and
 * deliberately not bd's `owner` cell (lib/ownership.js:20-45): a claim overwrites the
 * cell, six Macs sharing one Dolt tracker turn a cell into a write conflict, and
 * lib/ancestry.js names the sharper half — `owner` is the git identity that *created* the
 * bead, which 633 of 822 records here share. So a workspace nobody has ever labelled has
 * `ownedByMe` false for every root, every root is skipped, and the screen is empty for a
 * reason it cannot say. That last clause is the bug; the rest is the design.
 *
 * Four things, and three of them fail quietly:
 *
 * 1. **A workspace with roots and no owner label anywhere is reported.** This is the
 *    whole fix. It is a list on the payload rather than a thrown fault, for the reason
 *    `unhomed` is one: an unowned root is a state (lib/ownership.js says so outright),
 *    and a tracker that refused to draw until somebody triaged it would be broken for
 *    exactly as long as the triage took.
 *
 * 2. **A workspace whose roots are all a colleague's is NOT reported**, and this is the
 *    assertion that keeps the feature honest. It has owners; they are simply not you,
 *    and that is the board working. A detector written on `ownedByMe` instead of "has
 *    any owner at all" passes every other check in this file and then tells Adam that
 *    nobody owns a workspace where everybody does — noise that trains him to ignore it.
 *
 * 3. **A workspace with no roots at all is NOT reported.** Nothing to label is not a
 *    labelling failure, and an empty personal tracker would otherwise nag from the day
 *    it was created.
 *
 * 4. **The ＋ picker spends it on a sentence that names the workspaces.** The payload
 *    field is invisible on its own; the four reasons the picker can be empty used to be
 *    three, and the fourth was indistinguishable from "you own nothing" — which is what
 *    sent this bug to a render path that was never involved. The sentence is asserted to
 *    name the workspace and to carry the label remedy, because "check your config" is
 *    the kind of empty state that produces another bug report.
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

let failures = 0;
let passes = 0;
function check(what, fn) {
  try {
    fn();
    passes += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${what}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${what}\n      ${err.message}`);
  }
}

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
/** A root — an epic — with whatever labels the case is about. */
const root = (id, labels, extra = {}) => row(id, { priority: 0, issue_type: 'epic', labels, ...extra });

/**
 * Four workspaces, one per branch of the rule.
 *
 * `blind` is the bug: roots, filed by you, and not one `owner:` label — the shape
 * `deluvia` and `sophab` were both in. Its beads carry an `owner` *cell* naming you,
 * which is exactly the fact the detector must not read, and the fixture carries it so a
 * fallback quietly added later fails here rather than in production.
 */
const TRACKERS = {
  alpha: [root('aa-one', [`owner:${ME}`]), root('aa-two', []), row('aa-kid', {})],
  blind: [
    root('bb-one', [], { owner: ME }),
    root('bb-two', [], { owner: ME }),
    row('bb-kid', { owner: ME }),
  ],
  theirs: [root('cc-one', ['owner:bob@example.com']), root('cc-two', ['owner:bob@example.com'])],
  empty: [row('dd-kid', {}), row('dd-other', {})],
};

// The prefix deliberately shares no substring with a tracker name below. `ownerblind-`
// contains `blind`, so the fake `bd`'s path match answered `blind`'s beads for every
// workspace and three of the four assertions failed on the fixture rather than the code.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ownerlbl-'));
const WS = Object.keys(TRACKERS).map((name) => ({ name, dir: path.join(tmp, name, '.beads') }));
for (const w of WS) fs.mkdirSync(w.dir, { recursive: true });

/** A fake `bd` that answers `export` per workspace, keyed off the `--db`/cwd it is given. */
const BD = path.join(tmp, 'bd.cjs');
fs.writeFileSync(
  BD,
  `#!/usr/bin/env node
const trackers = ${JSON.stringify(TRACKERS)};
const args = process.argv.slice(2);
const whole = args.join(' ') + ' ' + (process.env.BEADS_DIR || '') + ' ' + process.cwd();
// On the path SEGMENT, not on a bare substring: every workspace dir is <tmp>/<name>/.beads
// and a loose \`includes\` matches whichever name the tmp prefix happens to contain.
const name = Object.keys(trackers).find((n) => whole.includes('/' + n + '/')) || '';
if (args[0] === 'export') {
  process.stdout.write((trackers[name] || []).map((b) => JSON.stringify(b)).join('\\n'));
  process.exit(0);
}
if (args[0] === 'human' && args[1] === 'list') { process.stdout.write('[]'); process.exit(0); }
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const cfg = {
  port: 0,
  host: '127.0.0.1',
  token: 'ownerblind-token',
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

/** `Bd.graph` is `wait: false` on the request path, so the first payload is always cold. */
async function boardWhenWarm() {
  for (let i = 0; i < 60; i += 1) {
    const payload = await getJson('/api/questions');
    if ((payload.rootboard?.startable || []).length) return payload;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the root board never warmed up — nothing startable after six seconds of asking');
}

console.log('\nwhat the payload reports\n');

try {
  const warm = await boardWhenWarm();
  const unowned = warm.rootboard.unowned || [];

  check('A WORKSPACE WITH ROOTS AND NO OWNER LABEL ANYWHERE IS NAMED', () => {
    assert.equal(unowned.includes('blind'), true, `\`blind\` is the bug and it is not on the list: ${JSON.stringify(unowned)}`);
  });

  check('a workspace where some root is labelled is not named', () => {
    assert.equal(unowned.includes('alpha'), false, '`alpha` has an owned root and is being reported as blind');
  });

  check("a workspace whose roots are all somebody else's is NOT named", () => {
    assert.equal(
      unowned.includes('theirs'),
      false,
      'a colleague’s workspace is being reported as unowned — the detector is asking `ownedByMe` rather than "has any owner"'
    );
  });

  check('a workspace with no roots at all is not named', () => {
    assert.equal(unowned.includes('empty'), false, 'a tracker with nothing to label is being nagged about labelling');
  });

  check('and the list is exactly that one, sorted', () => {
    assert.deepEqual(unowned, ['blind'], 'the report drifted from the four cases above');
  });
} finally {
  for (const s of servers) s.close();
  cleanupTmp(tmp);
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

/** The picker, over a state with nothing to offer and whatever `unowned` the case wants. */
function candsWith(unowned, me = [ME]) {
  const state = { me, rootboard: { owned: true, roots: [], startable: [], under: {}, unowned } };
  const context = vm.createContext({ String, Number, Math, JSON, Date, state });
  vm.runInContext([lift(APP, 'const esc = ('), lift(APP, 'function p0CandsHtml(rows)')].join('\n'), context);
  return vm.runInContext('p0CandsHtml([])', context);
}

console.log('\nwhat the picker says\n');

check('THE EMPTY PICKER NAMES THE WORKSPACE NOBODY HAS LABELLED', () => {
  const html = candsWith(['deluvia']);
  assert.match(html, /deluvia/, 'the sentence does not name the workspace, so there is nothing to act on');
});

check('and it names every one of them, not just the first', () => {
  const html = candsWith(['deluvia', 'sophab']);
  assert.match(html, /deluvia/, 'the first workspace is missing');
  assert.match(html, /sophab/, 'the second workspace is missing — the sentence is not iterating');
});

check('and it carries the remedy, as a label and not a config edit', () => {
  const html = candsWith(['deluvia']);
  assert.match(html, /--add-label owner:/, 'the sentence does not say what to type');
  assert.match(html, new RegExp(ME.replace('@', '@')), 'the remedy does not use the handle this Mac knows itself by');
});

check('with nothing blind, the old sentence is unchanged', () => {
  const html = candsWith([]);
  assert.match(html, /already on the board|on the board already/, 'the ordinary empty state was replaced rather than added to');
  assert.doesNotMatch(html, /--add-label/, 'the labelling nag is showing when nothing is unlabelled');
});

check('a workspace name cannot write markup into the sentence', () => {
  const html = candsWith(['<img src=x onerror=alert(1)>']);
  assert.doesNotMatch(html, /<img/, 'a workspace name is going into the page unescaped');
  assert.match(html, /&lt;img/, 'the escaped form is not there either — the name was dropped rather than escaped');
});

check('and it survives a Mac that has not said who it is', () => {
  const html = candsWith(['deluvia'], []);
  assert.match(html, /deluvia/, 'the sentence throws or empties when `me` is absent');
});

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m, ${passes} passed` : `\n\x1b[32mall ${passes} checks passed\x1b[0m`);
process.exit(failures ? 1 : 0);
