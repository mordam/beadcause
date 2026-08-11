#!/usr/bin/env node
/**
 * The signed-in devices, and what revoking one is allowed to do to the others.
 *
 *     npm test
 *     node test/devices.mjs
 *
 * lib/devices.js is the list that turned "sign out" from a request to one browser into
 * something you can point at a phone you no longer have. `test/auth.mjs` drives it
 * over real HTTP — sign in twice, revoke one, watch the other keep working — and this
 * file holds the parts that are cheaper to be exhaustive about below that level:
 *
 *   - **the throttle**, because it is the only reason this can live in `state.json` at
 *     all. A write per request would be an atomic rewrite plus a snapshot commit on
 *     every poll from every open tab;
 *   - **the shapes that must read as "no device"**, because every reader treats a
 *     missing row as a session that is over. A half-written file signing somebody out
 *     is recoverable; one that lets a row through that cannot be revoked is the bug
 *     this feature exists to remove;
 *   - **the store's cache**, which is keyed on the file's mtime rather than a TTL
 *     because two backends are alive at once during a swap and a revoke pressed on one
 *     has to bite on the other.
 *
 * The labels get their own section for a boring reason that is easy to regress: Edge
 * calls itself Chrome *and* Safari and Chrome calls itself Safari, so testing them in
 * the wrong order silently labels every device "Safari" — and the label is what you
 * would revoke by.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-devices-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const {
  DEVICE_MAX,
  SEEN_MS,
  createDeviceStore,
  deviceLabel,
  deviceRows,
  liveDevice,
  newDeviceId,
  normalizeDevices,
  pruneDevices,
  rememberDevice,
  revokeDevice,
  touchDevice,
} = await import(path.join(HERE, '..', 'lib', 'devices.js'));

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
const is = (name, got, want) =>
  got === want ? ok(name) : bad(name, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

const T0 = new Date('2026-08-11T12:00:00.000Z');
const at = (ms) => new Date(T0.getTime() + ms);
const soon = Math.floor(T0.getTime() / 1000) + 86400;

const entry = (over = {}) => ({ id: 'a', email: 'adam@example.com', label: 'Mac · Chrome', exp: soon, ...over });

/* ------------------------------------------------------------------- the ids */

console.log('\nlib/devices.js — the id');
{
  const ids = new Set(Array.from({ length: 200 }, () => newDeviceId()));
  // Not a secret — the cookie carrying it is signed, and it is drawn on a screen. What
  // it must be is unrepeatable: two sessions sharing an id means revoking one revokes
  // the other, which is the exact failure this list is for.
  is('two hundred ids are two hundred different ids', ids.size, 200);
  is('and none of them needs escaping to sit in a URL or an attribute', [...ids].every((i) => /^[A-Za-z0-9_-]+$/.test(i)), true);
}

/* ---------------------------------------------------------------- the labels */

console.log('\nlib/devices.js — what a row is called');
const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
  app: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 Beadcause/1.4',
};
is('a phone', deviceLabel(UA.iphone), 'iPhone · Safari');
// The three that regress together. Chrome says Safari, Edge says both, and testing in
// the wrong order labels every row with the last name in the string.
is('a Mac on Chrome is not called Safari', deviceLabel(UA.mac), 'Mac · Chrome');
is('Edge is not called Chrome', deviceLabel(UA.edge), 'Windows · Edge');
is('Firefox on Linux', deviceLabel(UA.firefox), 'Linux · Firefox');
is('the app’s own WebView says so', deviceLabel(UA.app), 'Android · the beadcause app');
// A wrong label is worse than none: it is the label you would revoke by.
is('no user-agent at all is said plainly', deviceLabel(''), 'an unnamed browser');
is('and so is one nothing matches', deviceLabel('curl/8.4.0'), 'an unrecognised browser');

/* ------------------------------------------------------- remembering, seeing */

console.log('\nlib/devices.js — the list');
{
  const one = rememberDevice({}, entry(), T0);
  is('a session is written down under its id', Object.keys(one).join(), 'a');
  is('with the address that signed in', one.a.email, 'adam@example.com');
  is('first and last are the same instant to begin with', one.a.first, one.a.last);
  is('and it is live', Boolean(liveDevice(one, 'a', T0)), true);
  is('an id nobody issued is not', liveDevice(one, 'b', T0), null);
  // The row and the cookie carry the same instant; a row that outlived its cookie
  // would be a list that shows a device the gate would turn away.
  is('and neither is one whose cookie has expired', liveDevice(one, 'a', at(2 * 86400 * 1000)), null);
}

console.log('\nlib/devices.js — when it was last seen');
{
  const one = rememberDevice({}, entry(), T0);
  is('a request a minute later is not worth a write', touchDevice(one, 'a', at(60_000)), null);
  const later = touchDevice(one, 'a', at(SEEN_MS + 1000));
  is('one past the throttle is', Boolean(later), true);
  is('and it moves `last` and nothing else', later.a.last, at(SEEN_MS + 1000).toISOString());
  is('first stays where it was — it is the answer to a different question', later.a.first, one.a.first);
  is('touching an id that is not there writes nothing', touchDevice(one, 'nope', at(SEEN_MS + 1000)), null);
  // NaN is not "recent". A row that could never update its own timestamp would read
  // as abandoned forever, on the one screen where that is the deciding fact.
  is('an unreadable `last` is repaired rather than kept', Boolean(touchDevice({ a: { ...one.a, last: 'not a date' } }, 'a', T0)), true);
}

/* ------------------------------------------------------------------ revoking */

console.log('\nlib/devices.js — revoking one and only one');
{
  const two = rememberDevice(rememberDevice({}, entry({ id: 'a' }), T0), entry({ id: 'b' }), T0);
  const { devices, revoked } = revokeDevice(two, 'a');
  is('it says it did something', revoked, true);
  is('the row is gone', liveDevice(devices, 'a', T0), null);
  // The acceptance criterion, in one line: the other device is untouched.
  is('and the other one is exactly where it was', Boolean(liveDevice(devices, 'b', T0)), true);
  is('revoking it twice is not an error', revokeDevice(devices, 'a').revoked, false);
  // Deleting is the whole revocation: there is no tombstone, because an id this list
  // has never heard of and an id it has forgotten are the same fact and both mean no.
  is('and there is nothing left behind to have to keep', Object.keys(devices).join(), 'b');
}

/* -------------------------------------------------------- junk and the bound */

console.log('\nlib/devices.js — a state file that is not what it should be');
// Every one of these must read as *fewer* devices. Signing somebody out costs one
// sign-in; letting a row through that cannot be revoked is the bug this feature is.
is('a missing map', Object.keys(normalizeDevices(undefined)).length, 0);
is('an array where a map should be', Object.keys(normalizeDevices([{ id: 'a' }])).length, 0);
is('a string where a record should be', Object.keys(normalizeDevices({ a: 'yes' })).length, 0);
is('a null record', Object.keys(normalizeDevices({ a: null })).length, 0);
is('a record with nothing in it is kept but reads as expiring never', normalizeDevices({ a: {} }).a.exp, 0);
is('and a garbled expiry is not treated as a date', normalizeDevices({ a: { exp: 'soon' } }).a.exp, 0);

console.log('\nlib/devices.js — the file cannot grow forever');
{
  const many = {};
  for (let i = 0; i < DEVICE_MAX + 10; i += 1) {
    many[`d${i}`] = { email: 'a@b.c', label: 'x', first: T0.toISOString(), last: at(i * 1000).toISOString(), exp: soon };
  }
  const kept = pruneDevices(many, T0);
  is('the cap holds', Object.keys(kept).length, DEVICE_MAX);
  // Evicting a row signs that device out, so the order is not arbitrary: the oldest
  // thing seen is the one least likely to be in somebody's hand right now.
  is('and it is the least recently seen that goes', Boolean(kept[`d${DEVICE_MAX + 9}`]), true);
  is('not the most recent', kept.d0, undefined);
}
{
  const mixed = {
    live: { email: 'a@b.c', label: 'x', first: T0.toISOString(), last: T0.toISOString(), exp: soon },
    dead: { email: 'a@b.c', label: 'x', first: T0.toISOString(), last: T0.toISOString(), exp: Math.floor(T0.getTime() / 1000) - 1 },
  };
  is('an expired row is dropped — the browser threw that cookie away days ago', Object.keys(pruneDevices(mixed, T0)).join(), 'live');
}

console.log('\nlib/devices.js — the list a screen draws');
{
  const two = {
    old: { email: 'a@b.c', label: 'Mac · Chrome', first: T0.toISOString(), last: T0.toISOString(), exp: soon },
    now: { email: 'a@b.c', label: 'iPhone · Safari', first: T0.toISOString(), last: at(60_000).toISOString(), exp: soon },
  };
  const rows = deviceRows(two, { current: 'old', now: T0 });
  is('newest seen first', rows[0].id, 'now');
  is('the row you are reading it from is marked', rows.find((r) => r.id === 'old').current, true);
  is('and no other row is', rows.filter((r) => r.current).length, 1);
}

/* ----------------------------------------------------------------- the store */

console.log('\nlib/devices.js — the store over state.json');
{
  const file = path.join(tmp, 'state.json');
  let state = {};
  const store = createDeviceStore({
    load: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    save: (patch) => {
      state = { ...state, ...patch };
      fs.writeFileSync(file, JSON.stringify(state));
    },
    statePath: file,
  });
  fs.writeFileSync(file, JSON.stringify(state));

  store.remember(entry({ id: 'a' }), T0);
  store.remember(entry({ id: 'b' }), T0);
  is('two sessions are on disk', Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).devices).length, 2);
  is('and both are live', Boolean(store.live('a', T0)) && Boolean(store.live('b', T0)), true);
  is('the list marks the one asking', store.list({ current: 'a', now: T0 }).find((r) => r.id === 'a').current, true);

  is('revoking says it did something', store.revoke('b'), true);
  is('and the row is gone from the file too', Boolean(JSON.parse(fs.readFileSync(file, 'utf8')).devices.b), false);
  is('while the other survives', Boolean(store.live('a', T0)), true);

  // The reason the cache is keyed on mtime and size rather than a TTL: during a swap
  // two backends serve at once, and a revoke pressed on the new one has to be believed
  // by the old one on its very next request.
  state = { devices: {} };
  fs.writeFileSync(file, JSON.stringify(state));
  is('another process emptying the file is noticed at once', store.live('a', T0), null);

  // A saveState that throws must not cost somebody the page they asked for — a lost
  // "last seen" is cosmetic — but it must not be swallowed on the way *in*, because a
  // cookie whose row was never written is one the next request refuses.
  const broken = createDeviceStore({
    load: () => ({ devices: { a: { email: 'a@b.c', label: 'x', first: T0.toISOString(), last: T0.toISOString(), exp: soon } } }),
    save: () => {
      throw new Error('disk is full');
    },
    statePath: path.join(tmp, 'nothing.json'),
  });
  let threw = false;
  try {
    broken.remember(entry({ id: 'c' }), T0);
  } catch {
    threw = true;
  }
  is('a write that fails refuses the sign-in', threw, true);
  broken.touch('a', at(SEEN_MS + 1000));
  ok('and the same failure while touching is survivable');
}

/* ---------------------------------------------------------------------- done */

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures ? '\x1b[31m' : '\x1b[32m'}${ran - failures}/${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
