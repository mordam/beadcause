#!/usr/bin/env node
/**
 * The shared cache — what it hands back, and how many times it asks.
 *
 *     npm test
 *     node test/cache.mjs
 *
 * lib/cache.js is bc-1kwl.2, and the P0's acceptance is three sentences: a cold-entry
 * request returns without a `bd` or `gh` call in its critical path, concurrent requests
 * on one expired key produce one refresh, and an invalidated key is refetched on the
 * next read rather than at TTL expiry. Two of those three are about **how often the
 * producer ran**, which is why almost every check here counts producer calls rather than
 * inspecting state: a cache that returns the right value and asks twice for it has
 * failed at the only thing it was built for.
 *
 * Everything runs on a fake clock. The windows this thing exists to manage are ten
 * seconds to two minutes long, and a suite that waited them out would be the slowest
 * file in the repo for no gain — the only real timers here are the ceiling checks, where
 * the point *is* elapsed time and the numbers are shrunk to milliseconds.
 *
 * The one shape worth naming before you read the checks: a producer that never settles.
 * It is not a hypothetical — `gh` over a dropped tailnet does exactly that — and it is
 * the failure that would be invisible without a check, because the symptom is not an
 * error, it is a key that is never refreshed again for the life of the process.
 */
import assert from 'node:assert/strict';

const cache = await import('../lib/cache.js');

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
const check = async (fn, name) => {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

/** A clock the checks move by hand. Every window below is measured against this. */
let t = 1_000_000;
const now = () => t;
const tick = (ms) => {
  t += ms;
};

/** A producer that counts its calls and can be told what to do next. */
function producer(value = 'v1') {
  const p = {
    calls: 0,
    value,
    fail: null,
    hang: false,
    async run() {
      p.calls += 1;
      if (p.hang) return new Promise(() => {});
      if (p.fail) throw new Error(p.fail);
      return p.value;
    },
  };
  return p;
}

/** Let every already-resolved promise chain settle, without moving the clock. */
const settle = async (n = 4) => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

const quiet = async (fn) => {
  const said = [];
  const was = console.error;
  console.error = (line) => said.push(String(line));
  try {
    await fn(said);
  } finally {
    console.error = was;
  }
  return said;
};

const FRESH = { freshMs: 10_000, now };

/* ------------------------------------------------------------------ the window */

console.log('\nthe freshness window\n');

cache.clear();
{
  const p = producer('rows');
  const cold = await cache.read('ledger:a', p.run, FRESH);
  await check(() => assert.equal(cold.value, 'rows'), 'a cold key produces, and hands back what the producer returned');
  await check(() => assert.equal(cold.stale, false), 'and says it is not stale');

  tick(9_999);
  const warm = await cache.read('ledger:a', p.run, FRESH);
  await check(() => assert.equal(p.calls, 1), 'a read inside the window does not call the producer at all');
  await check(() => assert.equal(warm.ageMs, 9_999), 'and reports how old what it handed back is');
}

/* ------------------------------------------------------- stale-while-revalidate */

console.log('\npast the window: answer now, refresh behind\n');

cache.clear();
{
  const p = producer('old');
  await cache.read('ledger:b', p.run, FRESH);
  tick(10_001);
  p.value = 'new';
  p.hang = true;

  // The producer for this refresh never settles. If the read waits on it, this line
  // never returns — which is the whole property, stated as a check that can hang.
  const stale = await cache.read('ledger:b', p.run, FRESH);
  await check(() => assert.equal(stale.value, 'old'), 'a stale key answers from memory without waiting on the producer');
  await check(() => assert.equal(stale.stale, true), 'and says outright that it is a kept answer');
  await check(() => assert.equal(stale.refreshing, true), 'and that a fresh one is on its way');
  await check(() => assert.equal(p.calls, 2), 'the refresh did start — behind the response, not in front of it');
}

cache.clear();
{
  const p = producer('old');
  await cache.read('ledger:c', p.run, FRESH);
  tick(10_001);
  p.value = 'new';
  await cache.read('ledger:c', p.run, FRESH);
  await settle();
  const after = await cache.read('ledger:c', p.run, FRESH);
  await check(() => assert.equal(after.value, 'new'), 'and the next read has the refreshed value');
  await check(() => assert.equal(p.calls, 2), 'having asked exactly twice in the whole exchange');
}

/* ---------------------------------------------------------------- single-flight */

console.log('\none refresh, however many callers\n');

cache.clear();
{
  const p = producer('v');
  p.hang = true;
  const readers = [1, 2, 3, 4, 5].map(() => cache.read('prs:/repo', p.run, { freshMs: 10_000, now, ceilingMs: 40 }));
  await settle();
  await check(() => assert.equal(p.calls, 1), 'five cold readers of one key produce one producer call');
  await Promise.allSettled(readers);
}

cache.clear();
{
  const p = producer('v1');
  await cache.read('prs:/repo', p.run, FRESH);
  tick(10_001);
  p.hang = true;
  await Promise.all([1, 2, 3].map(() => cache.read('prs:/repo', p.run, FRESH)));
  await check(() => assert.equal(p.calls, 2), 'and three phones on an expired key cause one refresh, not three');
}

/* ------------------------------------------------------------- last good beats empty */

console.log('\na producer that throws\n');

cache.clear();
{
  const p = producer('good');
  await cache.read('ledger:d', p.run, FRESH);
  tick(10_001);
  p.fail = 'bd: database is locked';

  const said = await quiet(async () => {
    await cache.read('ledger:d', p.run, FRESH);
    await settle();
    tick(1);
    await cache.read('ledger:d', p.run, FRESH);
    await settle();
  });

  const over = await cache.read('ledger:d', p.run, FRESH);
  await check(() => assert.equal(over.value, 'good'), 'the last good value is still readable over a failing producer');
  await check(() => assert.match(over.error, /database is locked/), 'and the failure rides on the envelope, for the screen to say so');
  await check(() => assert.equal(said.length, 1), 'logged once on the way into failure, not once per read');

  p.fail = null;
  p.value = 'better';
  await cache.read('ledger:d', p.run, { ...FRESH, refresh: true });
  const healed = await cache.read('ledger:d', p.run, FRESH);
  await check(() => assert.equal(healed.value, 'better'), 'and a producer that recovers is believed again');
  await check(() => assert.equal(healed.error, null), 'with the failure cleared off the envelope');
}

/* A failure that lands on an entry still INSIDE its window stays there, and a read will not
   shift it — the warm path answers from memory without producing, so only a `refresh`, a
   `drop` or the window running out can clear it. That is a property of a cache and not a
   bug, but it is a trap for any caller that treats `error` as "report this and move on":
   lib/prboard.js does, because a red PR card must not outlive the `gh` outage that caused
   it, which is why it drops the key on the way out rather than only rethrowing. Written
   down here because this is where somebody will look for it. */
cache.clear();
{
  const p = producer('good');
  await cache.read('prs:/repo', p.run, FRESH);
  p.fail = 'gh: could not connect to github.com';
  await quiet(async () => {
    await cache.read('prs:/repo', p.run, { ...FRESH, refresh: true });
  });

  p.fail = null;
  p.value = 'healed';
  const warm = await cache.read('prs:/repo', p.run, FRESH);
  await check(() => assert.match(warm.error || '', /could not connect/), 'a failure on a still-fresh entry is not shifted by a read');
  await check(() => assert.equal(p.calls, 2), 'because a warm read produces nothing — nothing is asking whether it healed');

  cache.drop('prs:/repo');
  const after = await cache.read('prs:/repo', p.run, FRESH);
  await check(() => assert.equal(after.error, null), 'dropping it is what makes the next read find out');
  await check(() => assert.equal(after.value, 'healed'), 'and the answer is the one from after the outage');
}

cache.clear();
{
  const p = producer('never');
  p.fail = 'bd: no such workspace';
  let threw = null;
  try {
    await cache.read('ledger:e', p.run, FRESH);
  } catch (err) {
    threw = err;
  }
  await check(() => assert.match(String(threw?.message), /no such workspace/), 'but a failure with nothing kept is a throw — the caller has an error path and it must be reachable');
}

/* -------------------------------------------------------------------- the ceiling */

console.log('\na producer that never settles\n');

cache.clear();
{
  const p = producer('v');
  p.hang = true;
  const said = await quiet(async () => {
    let threw = null;
    try {
      await cache.read('queue:', p.run, { freshMs: 10_000, now, ceilingMs: 30 });
    } catch (err) {
      threw = err;
    }
    await check(() => assert.match(String(threw?.message), /did not answer within/), 'a cold read on a hung producer is bounded, not parked forever');
    await new Promise((r) => setTimeout(r, 20));
    p.hang = false;
    p.value = 'landed';
    const second = await cache.read('queue:', p.run, { freshMs: 10_000, now, ceilingMs: 200 });
    await check(() => assert.equal(p.calls, 2), 'and the slot it was holding was released, so the next read starts a fresh refresh');
    await check(() => assert.equal(second.value, 'landed'), 'which answers');
  });
  await check(() => assert.ok(said.some((l) => /gave up its refresh slot/.test(l))), 'and the abandoned slot is said out loud');
}

/* ------------------------------------------------------- a late refresh may not go backwards */

console.log('\nan abandoned refresh that lands anyway\n');

cache.clear();
{
  let release;
  const slow = () => new Promise((resolve) => (release = resolve));
  const first = cache.read('ledger:f', slow, { freshMs: 10_000, now, ceilingMs: 20 });
  await first.catch(() => {});
  await new Promise((r) => setTimeout(r, 30));

  // A second, faster answer lands while the first is still out there.
  tick(1);
  await cache.read('ledger:f', async () => 'fast', { freshMs: 10_000, now, ceilingMs: 200 });
  tick(1);
  release('slow — and stale before it arrived');
  await settle(8);

  const after = await cache.read('ledger:f', async () => 'unused', FRESH);
  await check(() => assert.equal(after.value, 'fast'), 'the newer answer stands — a three-minute sweep may not overwrite a three-second one');
}

/* ------------------------------------------------------------------ invalidation */

console.log('\ndropping a key by name\n');

cache.clear();
{
  const p = producer('v1');
  await cache.read('ledger:sophab', p.run, FRESH);
  await cache.read('ledger:deluvia', () => 'other', FRESH);
  p.value = 'v2';

  cache.drop('ledger:sophab');
  const after = await cache.read('ledger:sophab', p.run, FRESH);
  await check(() => assert.equal(after.value, 'v2'), 'a dropped key refetches on the next read, not at expiry');
  await check(() => assert.equal(cache.peek('ledger:deluvia').value, 'other'), 'and nothing else is touched');
}

cache.clear();
{
  await cache.read('ledger:a', () => 'a', FRESH);
  await cache.read('ledger:b', () => 'b', FRESH);
  await cache.read('prs:/repo', () => 'p', FRESH);
  const n = cache.dropPrefix('ledger:');
  await check(() => assert.equal(n, 2), 'a prefix drop takes every scope of one kind');
  await check(() => assert.equal(cache.peek('ledger:a'), null), 'and leaves nothing kept under it');
  await check(() => assert.ok(cache.peek('prs:/repo')), 'while another kind is untouched — which is what the key convention buys');
}

/* A drop takes the *in-flight* refresh with it, and this is the half that has a caller.
   lib/prboard.js drops `board:` before a forced sweep rather than only asking for
   `refresh`, because its producer is the only one in the app that reads another cache —
   joining a background refresh would hand a merge two-minute-old `gh` rows while the code
   around it believed it had re-swept. That is only true if a drop really does release the
   single-flight slot, so: a sweep in flight, a drop, and the next read must start a *second*
   producer and answer with the second one's value. The first is still allowed to land; what
   it may not do is become the answer. See `generation` in lib/cache.js. */
cache.clear();
{
  let release;
  let calls = 0;
  const slow = () => {
    calls += 1;
    const mine = calls;
    return new Promise((resolve) => {
      if (mine === 1) release = () => resolve('in flight when the drop happened');
      else resolve('swept after the drop');
    });
  };

  const joined = cache.read('board:', slow, FRESH);
  cache.drop('board:');
  const forced = await cache.read('board:', slow, FRESH);
  await check(() => assert.equal(calls, 2), 'a read after a drop starts its own sweep rather than joining the doomed one');
  await check(() => assert.equal(forced.value, 'swept after the drop'), 'and answers with the new sweep');

  release();
  const stranded = await joined;
  await check(() => assert.ok(stranded), 'the caller stranded on the dropped sweep is still answered rather than left hanging');
  await check(
    () => assert.equal(cache.peek('board:').value, 'swept after the drop'),
    'and the sweep the drop was about may not write itself back in — a merge would have re-read stale rows'
  );
}

/* ------------------------------------------------------------------- the ⟳ button */

console.log('\nrefresh: the user asked\n');

cache.clear();
{
  const p = producer('v1');
  await cache.read('ledger:g', p.run, FRESH);
  p.value = 'v2';
  const forced = await cache.read('ledger:g', p.run, { ...FRESH, refresh: true });
  await check(() => assert.equal(forced.value, 'v2'), 'refresh skips a value that is still inside its window and pays the cost');
  await check(() => assert.equal(p.calls, 2), 'by asking the producer');

  p.hang = true;
  const forced2 = { freshMs: 10_000, now, refresh: true, ceilingMs: 30 };
  const joined = [cache.read('ledger:g', p.run, forced2), cache.read('ledger:g', p.run, forced2)];
  await settle();
  await check(() => assert.equal(p.calls, 3), 'and two refreshes at once join one sweep rather than starting two');
  const out = await Promise.all(joined.map((j) => j.catch((err) => err)));
  await check(
    () => assert.equal(out.filter((r) => r?.value === 'v2').length, 2),
    'and when that sweep will not answer, both of them fall back to the kept value rather than to an error'
  );
}

/* ---------------------------------------------------------------- what it refuses */

console.log('\nwhat it will not accept\n');

await check(() => assert.rejects(() => cache.read('', () => 1, FRESH)), 'a key must be a non-empty string');
await check(() => assert.rejects(() => cache.read('k', null, FRESH)), 'a producer must be a function');
await check(() => assert.rejects(() => cache.read('k', () => 1, { now })), 'and a freshness window is not optional — a cache with no window is a variable');

/* ---------------------------------------------------------------------- verdict */

console.log('');
if (failures) {
  console.log(`\x1b[31m${failures} of ${ran} checks failed\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32mall ${ran} checks passed\x1b[0m`);
