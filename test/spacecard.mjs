#!/usr/bin/env node
/**
 * A row per setting, on the space card — asserted with no Chrome, so `npm test` can say it.
 *
 *     npm test
 *     node test/spacecard.mjs
 *
 * `SETTINGS` in lib/spaces.js is the canonical list of what a space may set: `POST
 * /api/space` refuses any key that is not in it, and the card in public/config.js draws
 * one row per entry. Those two agreeing is the whole of whether the screen can express
 * what the daemon reads — a setting with no row is one you can only set by editing
 * config.json on the Mac, and a row writing a key the list has never heard of is a
 * control whose press comes back 400.
 *
 * Until now the only thing asserting it was `scripts/space-check.mjs`, and that check
 * wants Chrome, so it is not in `npm test` and gets run by hand exactly when somebody has
 * already touched the card. Adding a setting and forgetting the row therefore stayed green
 * everywhere that runs automatically — which is how the count in that check went stale in
 * the first place (bc-qda7): `autoShip` landed, the card gained its row, and nothing said
 * the number was wrong until somebody ran it for an unrelated reason and had to spend time
 * proving the red was not theirs.
 *
 * So this suite asks the same question the browser check asks, in a `node:vm`: the real
 * public/config.js, a fake document, and a `/api/space` payload built by the real
 * `spaceDetail` rather than written out here — a fixture typed by hand is free to be right
 * about a shape the endpoint does not serve. What is left to the browser check is
 * everything a string cannot answer: that a press reaches the config file, and that eleven
 * rows on a 393px screen read as a card rather than as a wall.
 *
 * Four claims:
 *
 * 1. **A row per setting, and no row that is not one.** Read the way space-check reads it
 *    — each row's key off the control in it, never off its heading, because the heading is
 *    a sentence for a human ("Agents may answer unasked") and the key is what the endpoint
 *    takes.
 * 2. **Whatever the space says.** The row set is a property of the card, not of the
 *    payload, so a space that has set everything and a space that has set nothing draw the
 *    same eleven rows — the second is the fresh install, and it is the one where a missing
 *    row would be least visible.
 * 3. **The comparison has teeth.** A setting nothing draws is named, a row writing an
 *    unknown key is named, and a row with no recognisable control is reported rather than
 *    quietly skipped. All three against the real rendered card, because an assertion that
 *    can only fail in theory is one nobody can trust when it goes green.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'config.js'), 'utf8');

const { SETTINGS, spaceDetail } = await import(path.join(ROOT, 'lib', 'spaces.js'));

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

console.log('\nthe space card carries a row for every setting');

/* --------------------------------------------------- the page, in a room of its own */

/**
 * `public/config.js` for real, with the handful of things it touches stubbed.
 *
 * The repo pattern (test/beadsession.mjs, test/spacebar.mjs): run the shipped file rather
 * than a re-implementation of it, because a re-implementation can pass every case here
 * while the phone is served something else. The stubs record instead of rendering, so
 * `out.innerHTML` ends up being the string the page decided on — which is exactly what
 * these cases want to read.
 *
 * **This used to lift public/monitor.js**, which wanted five stub nodes, an `/api/work`
 * payload, an `/api/questions` payload and a page's worth of optional-chained globals to
 * get one card out. The card is its own document since bc-khoe.10 and the room it needs
 * is most of what is left below: three nodes, one payload, and nothing that sweeps.
 *
 * Two details still make it work:
 *
 *   - **`querySelectorAll` answers empty.** The only thing the page asks it for is the
 *     observer's read-only pass, which does nothing on an instance that acts.
 *   - **The Settings panel is opened through `localStorage`.** Which sections are unfolded
 *     lives in `beadcause.mon.open` — the console's key, kept when the card moved — and
 *     survives reloads, so a stored key is the same state a thumb reaches by tapping the
 *     summary, which is what space-check does.
 */
async function drawCard(detail) {
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
  const nodes = { space: node(), pulse: node(), observing: node(), refresh: node() };
  const store = {
    'beadcause.token': 'tok',
    'beadcause.mon.open': JSON.stringify([`space:${detail.space}:cfg`]),
  };

  const ctx = vm.createContext({
    window: {
      beadcause: {
        // The space picker, which is what tells this page it is about one space at all —
        // `spaceHtml` draws no card while the picker is on All, because there is no single
        // space those settings would belong to. See public/spacebar.js.
        space: {
          filter: { space: detail.space },
          matches: () => true,
          label: () => detail.space,
          adopt() {},
          onChange() {},
        },
      },
    },
    document: { getElementById: (id) => nodes[id] || null, addEventListener() {}, activeElement: null },
    location: { search: '', pathname: '/config', hash: '' },
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
    // One path, which is the whole of what this page fetches. `/api/spaces` is asked for
    // only after a write, and nothing here writes.
    fetch: async (url) => {
      const body = url.startsWith('/api/space?') ? detail : {};
      return { ok: true, status: 200, json: async () => body };
    },
  });
  vm.runInContext(PAGE, ctx, { filename: 'config.js' });

  // The boot is async and the IIFE hands nothing back, so settle on the stubs' own
  // microtasks. Bounded rather than timed: nothing here waits on a clock.
  for (let i = 0; i < 80; i += 1) await new Promise((r) => setImmediate(r));
  return nodes.space.innerHTML;
}

/**
 * Which setting each drawn row actually writes — read off its controls, never its heading.
 *
 * The same three rules `scripts/space-check.mjs` reads by, deliberately: a `data-space-set`
 * is what the shared press handler sends, and quiet hours and quiet days are the two rows
 * with bespoke controls instead of one, so they are named from the attribute they do carry.
 * A row matching none of the three is reported as `unknown:` rather than dropped — a row
 * that vanished from this list would be a new control shape silently exempting itself.
 *
 * Rows are cut out of the string rather than parsed into a tree: the fake-DOM parser these
 * suites share drops an element that directly follows another tag, which is exactly the
 * shape every one of these rows has.
 */
function rowKeys(html) {
  const OPEN = '<div class="space-row">';
  // The per-repo panel sits below the last row and carries `data-repo-set` controls of its
  // own; the last row's slice stops at it so a repo's press can never be read as a row.
  const end = html.indexOf('<div class="space-repos">');
  const body = end === -1 ? html : html.slice(0, end);
  const starts = [];
  for (let i = body.indexOf(OPEN); i !== -1; i = body.indexOf(OPEN, i + 1)) starts.push(i);
  return starts.map((start, n) => {
    const row = body.slice(start, starts[n + 1] ?? body.length);
    const set = row.match(/data-space-set="([^"]*)"/);
    if (set) return set[1];
    if (row.includes('data-space-hours=')) return 'quietHours';
    if (row.includes('data-space-day=')) return 'quietDays';
    return `unknown: ${(row.match(/class="space-what">([^<]*)</) || [, '?'])[1]}`;
  });
}

/**
 * What the two lists say about each other, in the words the failure needs.
 *
 * A function rather than three assertions inline because it is also what makes the check
 * testable: the cases below run it against a list with a setting nothing draws, and against
 * a card with a row nothing accepts, which is the only way to know a green here means
 * anything. Duplicates are their own answer — two rows writing one key is a card where one
 * of them is dead, and a set comparison alone would call it agreement.
 */
function disagreement(settings, keys) {
  return {
    missingRow: settings.filter((k) => !keys.includes(k)),
    extraRow: keys.filter((k) => !settings.includes(k)),
    twice: keys.filter((k, i) => keys.indexOf(k) !== i),
  };
}

const said = (d) => [
  d.missingRow.length ? `no row for ${d.missingRow.join(', ')}` : '',
  d.extraRow.length ? `a row for ${d.extraRow.join(', ')}, which is not a setting` : '',
  d.twice.length ? `two rows for ${d.twice.join(', ')}` : '',
].filter(Boolean).join(' — ');

/* ------------------------------------------------------------------- the two payloads */

const WORKSPACES = [{ name: 'demo' }];

/** A space that has set every one of them, so no row can be drawn by a default alone. */
const set = spaceDetail(
  {
    workspaces: WORKSPACES,
    slack: { enabled: true, channel: 'C0000000000' },
    spaces: [
      {
        name: 'Work',
        workspaces: ['demo'],
        muted: true,
        quietHours: { from: '18:00', to: '09:00' },
        quietDays: ['sat', 'sun'],
        ntfyDetail: 'minimal',
        slackChannel: 'C1234567890',
        slackDetail: 'minimal',
        autoDispatch: false,
        autoEndorse: true,
        autoMerge: false,
        requireApproval: true,
        autoShip: false,
      },
    ],
  },
  'Work'
);

/** And the fresh install: a space that says nothing at all and inherits the lot. */
const unset = spaceDetail({ workspaces: WORKSPACES, spaces: [{ name: 'Work', workspaces: ['demo'] }] }, 'Work');

const setHtml = await drawCard(set);
const unsetHtml = await drawCard(unset);

/* ------------------------------------------------------------------------ the claims */

await check('the card is drawn for the space, with its settings panel open', async () => {
  assert.match(setHtml, /class="[^"]*\bspace-card\b/, 'no card on the rendered page');
  assert.ok(setHtml.includes('<div class="space-row">'), 'the settings panel drew no rows — is it still folded?');
});

await check('a row for every setting in SETTINGS, and no row for anything else', async () => {
  const keys = rowKeys(setHtml);
  const d = disagreement(SETTINGS, keys);
  assert.ok(
    !d.missingRow.length && !d.extraRow.length && !d.twice.length,
    `${said(d)} — drawn: ${keys.join(', ') || 'none'}`
  );
});

await check('and the same rows for a space that has set none of them', async () => {
  // The fresh install, where a missing row would be least visible: every control is on
  // Inherit and there is nothing on the card to look wrong.
  const keys = rowKeys(unsetHtml);
  const d = disagreement(SETTINGS, keys);
  assert.ok(!d.missingRow.length && !d.extraRow.length && !d.twice.length, `${said(d)} — drawn: ${keys.join(', ')}`);
  assert.deepEqual(keys, rowKeys(setHtml), 'the row set changed with what the space said');
});

/* The three below are the check checking itself, and each is written against what the card
   actually drew rather than against `SETTINGS` — so the day somebody does add a setting
   and forget the row, the two claims above go red and these do not. A suite that reported
   five failures for one mistake is one whose next reader starts by disbelieving it. */

await check('a setting the card has no row for is named — the failure this suite exists for', async () => {
  // The acceptance criterion, run rather than described: a key in the list and in nothing
  // else. Added to a copy of the drawn set instead of to lib/spaces.js, because a suite
  // that edited the module it is checking would only be asserting its own edit.
  const keys = rowKeys(setHtml);
  const d = disagreement([...keys, 'throwaway'], keys);
  assert.deepEqual(d.missingRow, ['throwaway'], 'a setting with no row went unnoticed');
  assert.match(said(d), /no row for throwaway/, 'and the failure has to say which');
});

await check('a row writing a key the server would refuse is named too', async () => {
  // The other direction, and the one that reaches the phone as a 400: the real card with
  // one row's key changed to something `POST /api/space` has never heard of.
  const keys = rowKeys(setHtml);
  // Whichever row is pressed rather than typed or tapped, found rather than named: a row
  // named here would make this case fail the day that particular setting was renamed, for
  // a reason that has nothing to do with what it is asserting.
  const victim = keys.find((k) => setHtml.includes(`data-space-set="${k}"`));
  assert.ok(victim, 'no row on the card writes through data-space-set at all');
  const typo = rowKeys(setHtml.replaceAll(`data-space-set="${victim}"`, 'data-space-set="not-a-setting"'));
  const d = disagreement(keys, typo);
  assert.deepEqual(d.extraRow, ['not-a-setting']);
  assert.deepEqual(d.missingRow, [victim], 'and the setting it stopped writing is named as well');
});

await check('and a row with no control this reader knows is reported, not skipped', async () => {
  // The trap under any new shape of control — the free-text Slack channel was one — is a
  // row whose key cannot be read coming back as no row at all. It comes back named by its
  // heading instead, which is a failure somebody can act on.
  const drawn = rowKeys(setHtml);
  const victim = drawn.find((k) => setHtml.includes(`data-space-set="${k}"`));
  const keys = rowKeys(setHtml.replaceAll(`data-space-set="${victim}"`, 'data-nothing="x"'));
  assert.equal(keys.length, drawn.length, 'the row disappeared instead of being reported');
  const unknown = keys.filter((k) => k.startsWith('unknown: '));
  assert.equal(unknown.length, 1, `expected one unreadable row, got: ${keys.join(', ')}`);
  assert.notEqual(unknown[0], 'unknown: ?', 'and it has to name the row by its heading');
});

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
