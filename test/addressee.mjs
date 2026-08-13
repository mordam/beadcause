#!/usr/bin/env node
/**
 * Who a question is for — and the guarantee that a one-Mac install never notices.
 *
 *     npm test
 *     node test/addressee.mjs
 *
 * bc-cvwk. One ntfy topic, one inbox, and on a shared tracker six daemons each reading
 * the whole graph and each buzzing their own phone about every `human` bead in it. The
 * fix is an addressee on the bead — `for:<handle>` — and a machine that knows which
 * handle is its own.
 *
 * Four properties, and the order is the order they would break in:
 *
 * 1. **`me` unset is the old app, exactly.** Not "quiet by default" — a branch that
 *    cannot be entered. Every assertion about a labelled bead is repeated with `me`
 *    absent, because that is the configuration every existing install has and the one
 *    nobody would notice regressing until a question went missing.
 * 2. **Nothing is dropped, only quietened.** `quietReasonFor` answers `'addressed'`
 *    alongside `'filtered'` and `'muted'`, which every surface downstream already
 *    treats as "file it, count it, draw it, stay dark". A suite cannot prove the whole
 *    contract, but it can prove the answer is one of that family and never a
 *    suppression — so `'addressed'` is asserted to be a *reason*, and `arrivedQuiet`
 *    is asserted to accept it, which is what puts the sentence on the card.
 * 3. **It outranks the filter.** A bead addressed elsewhere reads `'addressed'` even
 *    when it is also outside the filter and also in a muted space, because that is the
 *    only one of the three that no chip on this Mac can undo — reporting it as
 *    `'filtered'` sends somebody to press **All** for a card that was never hidden.
 * 4. **The stamp happens where the answer is known.** `created_by` is `cfg.actor` —
 *    the literal string `beadcause` on every machine — so the addressee cannot be
 *    derived by the daemon reading the graph. `bin/ask.js` is driven end to end against
 *    a stub `bd` for that reason: what is under test is the argv it builds, and a unit
 *    test of `addresseeLabel` would pass just as happily against an ask.js that never
 *    called it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (f) => path.join(ROOT, 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-addressee-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const {
  ADDRESSEE_PREFIX,
  addresseeLabel,
  addresseesOf,
  addresseesOn,
  addressedElsewhere,
  describeAddressees,
  meHandles,
  ownAddresseeLabels,
} = await import(LIB('addressee.js'));
const { quietReasonFor } = await import(LIB('spaces.js'));
const { arrivedQuiet, quietArrival } = await import(LIB('hushed.js'));
const { toQuestion } = await import(LIB('decision.js'));

/* --------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
const check = (name, fn) => {
  ran += 1;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
};

console.log('\nwho a question is for\n');

const ALL = { space: 'all', workspace: 'all' };
/** A bead, as the push path sees one: a built question with its handles already read. */
const q = (extra = {}) => ({ workspace: 'acme', id: 'zz-1', space: 'Work', addressees: [], ...extra });

/* ------------------------------------------------------------- reading the label */

check('a bead with no labels is addressed to nobody, which is everybody', () => {
  assert.deepEqual(addresseesOf([]), []);
  assert.deepEqual(addresseesOf(undefined), []);
  assert.deepEqual(addresseesOf(['human', 'agent-filed']), []);
});

check('for:<handle> is read, lowercased, and deduped', () => {
  assert.deepEqual(addresseesOf(['human', 'for:Bob@Example.com']), ['bob@example.com']);
  assert.deepEqual(addresseesOf(['for:bob', 'for:BOB', 'for:carol']), ['bob', 'carol']);
});

check('for:everyone is the absence of an addressee, said out loud', () => {
  // The escape hatch a machine with `me` set needs, and it must read as unaddressed
  // rather than as a handle — otherwise it would be quiet on every phone at once.
  assert.deepEqual(addresseesOf(['for:everyone']), []);
  assert.deepEqual(addresseesOf(['for:all', 'for:anyone', 'for:*']), []);
  assert.equal(addresseeLabel('everyone'), null);
  assert.equal(addresseeLabel(''), null);
  assert.equal(addresseeLabel('bob@example.com'), `${ADDRESSEE_PREFIX}bob@example.com`);
});

check('for: with nothing after it is dropped rather than read as a handle nobody has', () => {
  assert.deepEqual(addresseesOf(['for:', 'for:   ']), []);
});

check('a raw bd row and a built question answer the same way', () => {
  assert.deepEqual(addresseesOn({ labels: ['human', 'for:bob'] }), ['bob']);
  assert.deepEqual(addresseesOn({ addressees: ['bob'] }), ['bob']);
  assert.deepEqual(addresseesOn({}), []);
});

check('toQuestion carries the handles off the row, once per sweep', () => {
  const built = toQuestion('acme', { id: 'zz-1', title: 'Gross or net?', labels: ['human', 'for:Bob'] });
  assert.deepEqual(built.addressees, ['bob']);
  assert.deepEqual(toQuestion('acme', { id: 'zz-2', title: 'x' }).addressees, []);
});

/* ------------------------------------------------------------------ knowing me */

check('me takes a string or a list, and everyone is not a name anybody has', () => {
  assert.deepEqual(meHandles({ me: 'Bob@Example.com' }), ['bob@example.com']);
  assert.deepEqual(meHandles({ me: ['bob', 'bob@work.example'] }), ['bob', 'bob@work.example']);
  assert.deepEqual(meHandles({}), []);
  assert.deepEqual(meHandles({ me: null }), []);
  // Otherwise this machine would become the addressee of beads addressed to others.
  assert.deepEqual(meHandles({ me: 'everyone' }), []);
});

check('a machine that knows who it is stamps one label; one that does not stamps none', () => {
  assert.deepEqual(ownAddresseeLabels({ me: 'bob' }), ['for:bob']);
  // One handle, not both: a question addressed to two of your own addresses is no more
  // yours, and reads on the card as though two people had been asked.
  assert.deepEqual(ownAddresseeLabels({ me: ['bob', 'bob@work.example'] }), ['for:bob']);
  assert.deepEqual(ownAddresseeLabels({}), []);
});

/* ------------------------------------------------------- is this one for this Mac */

check('with me unset, no bead in the graph is somebody else’s', () => {
  assert.equal(addressedElsewhere({}, q({ addressees: ['carol'] })), false);
  assert.equal(addressedElsewhere({ me: null }, q({ addressees: ['carol', 'dave'] })), false);
});

check('an unaddressed bead is nobody else’s either', () => {
  assert.equal(addressedElsewhere({ me: 'bob' }, q()), false);
  assert.equal(addressedElsewhere({ me: 'bob' }, q({ addressees: [] })), false);
});

check('a bead naming me among others is mine', () => {
  assert.equal(addressedElsewhere({ me: 'bob' }, q({ addressees: ['bob'] })), false);
  assert.equal(addressedElsewhere({ me: 'bob' }, q({ addressees: ['carol', 'bob'] })), false);
  assert.equal(addressedElsewhere({ me: ['bob@home.example', 'bob@work.example'] }, q({ addressees: ['bob@work.example'] })), false);
});

check('a bead naming only other people is not', () => {
  assert.equal(addressedElsewhere({ me: 'bob' }, q({ addressees: ['carol'] })), true);
  assert.equal(addressedElsewhere({ me: 'bob' }, q({ addressees: ['carol', 'dave'] })), true);
});

/* ------------------------------------------------ the third answer quietReasonFor gives */

const cfg = (extra = {}) => ({ me: 'bob', spaces: [], ...extra });

check('addressed elsewhere is a reason to stay quiet', () => {
  assert.equal(quietReasonFor(cfg(), ALL, q({ addressees: ['carol'] })), 'addressed');
});

check('and everything else about that bead is unchanged — it is quiet, never suppressed', () => {
  // The contract `'filtered'` and `'muted'` already have: an answer, not an absence.
  // `arrivedQuiet` refusing the word is how the card would silently lose the sentence.
  const rec = quietArrival('addressed', q({ addressees: ['carol'] }), ALL);
  assert.equal(rec.reason, 'addressed');
  assert.deepEqual(rec.for, ['carol']);
  assert.equal(rec.filter, null, 'the filter is not what hid it, so naming one would read as a cause');
  const back = arrivedQuiet({ 'acme/zz-1': rec }, 'acme/zz-1');
  assert.equal(back?.reason, 'addressed');
  assert.deepEqual(back.for, ['carol']);
});

check('a record from before this existed still reads, with no addressees on it', () => {
  const old = { reason: 'muted', at: '2026-08-01T00:00:00.000Z', space: 'Work', filter: null };
  assert.equal(arrivedQuiet({ k: old }, 'k')?.for, null);
});

check('it outranks the filter, because no chip on this Mac would ever bring it back', () => {
  const outside = { space: 'Personal', workspace: 'all' };
  assert.equal(quietReasonFor(cfg(), outside, q({ addressees: ['carol'] })), 'addressed');
  // And the filter still answers for a bead that is merely outside it.
  assert.equal(quietReasonFor(cfg(), outside, q()), 'filtered');
});

check('and it reaches the foundation channel, which the filter deliberately does not', () => {
  const outside = { space: 'Personal', workspace: 'all' };
  const request = (extra) => q({ foundation: true, ...extra });
  assert.equal(quietReasonFor(cfg(), outside, request()), null, 'the filter does not reach a request');
  assert.equal(
    quietReasonFor(cfg(), outside, request({ addressees: ['carol'] })),
    'addressed',
    'but "whose agent is this" is a question a constitutional request has an answer to'
  );
});

check('a muted space still says muted for a bead that is mine', () => {
  const muted = cfg({ spaces: [{ name: 'Work', workspaces: ['acme'], muted: true }] });
  assert.equal(quietReasonFor(muted, ALL, q({ addressees: ['bob'] })), 'muted');
  assert.equal(quietReasonFor(muted, ALL, q({ addressees: ['carol'] })), 'addressed');
});

check('WITH ME UNSET, EVERY ONE OF THOSE RINGS — the one-Mac guarantee', () => {
  const solo = { spaces: [] };
  assert.equal(quietReasonFor(solo, ALL, q({ addressees: ['carol'] })), null);
  assert.equal(quietReasonFor(solo, ALL, q({ addressees: ['carol', 'dave'] })), null);
  assert.equal(quietReasonFor(solo, ALL, q({ foundation: true, addressees: ['carol'] })), null);
  // And the two old answers are exactly as they were.
  assert.equal(quietReasonFor(solo, { space: 'Personal', workspace: 'all' }, q()), 'filtered');
  assert.equal(
    quietReasonFor({ spaces: [{ name: 'Work', workspaces: ['acme'], muted: true }] }, ALL, q()),
    'muted'
  );
});

check('a sentence naming who was asked', () => {
  assert.equal(describeAddressees([]), '');
  assert.equal(describeAddressees(['bob']), 'bob');
  assert.equal(describeAddressees(['bob', 'carol']), 'bob and carol');
  assert.equal(describeAddressees(['bob', 'carol', 'dave']), 'bob, carol and dave');
});

/* ------------------------------------------- the stamp, end to end through bin/ask.js */

const WORLD = path.join(tmp, 'world.json');
const FAKE_BD = path.join(tmp, 'bd');
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const w = JSON.parse(fs.readFileSync(${JSON.stringify(WORLD)}, 'utf8'));
const one = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
const many = (n) => { const out = []; for (let i = 0; i < args.length; i++) if (args[i] === n) out.push(String(args[i + 1] || '')); return out.filter(Boolean); };
if (args[0] === 'create') {
  const id = 'zz-n' + (Object.keys(w.issues).length + 1);
  w.issues[id] = { id, title: one('--title', ''), labels: many('--label') };
  fs.writeFileSync(${JSON.stringify(WORLD)}, JSON.stringify(w, null, 2));
  process.stdout.write(JSON.stringify({ id }));
  process.exit(0);
}
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const wsDir = path.join(tmp, 'ws', '.beads');
fs.mkdirSync(wsDir, { recursive: true });

/** Rewrite the config this Mac is running under, and empty the tracker. */
const configure = (extra) => {
  fs.writeFileSync(WORLD, JSON.stringify({ issues: {} }, null, 2));
  fs.writeFileSync(
    path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'),
    JSON.stringify(
      { bdBin: FAKE_BD, actor: 'beadcause-test', workspaces: [{ name: 'demo', dir: wsDir }], ...extra },
      null,
      2
    )
  );
};

/** `bin/ask.js`, run the way the brief tells a worker to run it: body on stdin. */
const ask = (args) => {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'ask.js'), '-w', 'demo', '-t', 'Gross or net?', ...args], {
    input: 'Which of these two did you mean?\n',
    encoding: 'utf8',
    // HOME into the temp tree so discoverWorkspaces finds no ~/beads to reconcile onto
    // stdout, which is the stream the id comes back on.
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: process.env.BEADCAUSE_CONFIG_DIR },
  });
  if (res.error) throw res.error;
  const id = (res.stdout || '').trim().split('\n').pop();
  const issues = JSON.parse(fs.readFileSync(WORLD, 'utf8')).issues;
  return { status: res.status, stderr: res.stderr || '', labels: issues[id]?.labels || null };
};

check('with me set, a question filed here is addressed to the person holding this Mac', () => {
  configure({ me: 'bob@example.com' });
  const { status, labels } = ask([]);
  assert.equal(status, 0);
  assert.deepEqual(labels, ['human', 'for:bob@example.com']);
});

check('--for puts it on somebody else’s phone', () => {
  configure({ me: 'bob@example.com' });
  assert.deepEqual(ask(['--for', 'Carol@Example.com']).labels, ['human', 'for:carol@example.com']);
});

check('--for everyone puts it back on all of them', () => {
  configure({ me: 'bob@example.com' });
  assert.deepEqual(ask(['--for', 'everyone']).labels, ['human']);
});

check('WITH ME UNSET, THE BEAD IS THE ONE ask.js ALWAYS FILED', () => {
  configure({});
  assert.deepEqual(ask([]).labels, ['human']);
  // Even asked for by hand: a machine with no identity has no business claiming one,
  // but a session that names a person is still naming a person.
  assert.deepEqual(ask(['--for', 'carol']).labels, ['human', 'for:carol']);
});

/* ------------------------------------------------------------------------ done */

await cleanupTmp(tmp);
console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
