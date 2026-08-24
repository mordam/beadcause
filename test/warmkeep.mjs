#!/usr/bin/env node
/**
 * A warm boot draws no epic board, because the kept payload has no rootboard.
 *
 *     npm test
 *     node test/warmkeep.mjs
 *
 * bc-khoe.51. `keep()` in public/app.js is what a cold `/api/questions` fetch leaves
 * behind for the next document that opens the inbox — `warmBoot()` reads it back and
 * feeds it straight into `adopt()`, with no round trip to the daemon. `adopt()` treats a
 * missing field as "an old server that predates it, keep what's on screen" for six of
 * them: `rootboard`, `tickets`, `cancelledTickets`, `strandedCancels`, `trouble` and
 * `syncTrouble`. On a warm boot there is nothing on screen yet — the state object's own
 * hard-coded defaults are what "on screen" means before the first `adopt()` of the
 * document — so a `keep()` that drops one of those six does not fail loud, it silently
 * paints the empty default (`rootboard: {owned: false}` chief among them) until a parked
 * `/api/poll` happens to carry a payload that disagrees, which on a quiet tracker is
 * minutes to hours.
 *
 * `keep()` used to store only `{ questions, requests, workspaces, spaces, filter,
 * summary }`, on a comment claiming that was "trimmed to what `adopt` reads" — which had
 * stopped being true. This suite lifts `keep()` out of public/app.js and asserts the
 * object it hands to the warm store's `write()` carries all six.
 *
 * No `bd`, no network, no browser: `keep()` touches nothing but its own argument and the
 * `warm.write` it is handed, so it is testable in a `node:vm` the way test/jirarow.mjs
 * lifts a renderer.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let failures = 0;
let ran = 0;
function check(name, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.message).split('\n').slice(0, 6).join('\n      ')}`);
  }
}

const APP = read('public/app.js');

/**
 * Lift one declaration out of public/app.js — test/jirarow.mjs's `lift`, unchanged.
 *
 * Two shapes: a `function` ends at its balanced closing brace, a `const` arrow ends at
 * the first `;` outside every bracket. Nothing tracks strings, which is sound over these
 * two declarations and unsound in general — and it does not fail quietly, because the
 * slice stops parsing and this suite goes red naming the line.
 */
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

/**
 * Call `keep(scope, data)` for real, and hand back whatever it passed to `warm.write`.
 *
 * `questionsPath` is lifted alongside it because `keep` calls it directly rather than
 * taking it as a parameter — it is a one-line `const` arrow with no dependency of its
 * own, so lifting it costs nothing and keeps this test from hand-rolling a second
 * implementation that could drift from the real one.
 */
function callKeep(scope, data) {
  let written = null;
  const context = vm.createContext({
    encodeURIComponent,
    scope,
    data,
    window: {
      beadcause: {
        warm: {
          write: (path, stored, seq) => {
            written = { path, stored, seq };
          },
        },
      },
    },
  });
  vm.runInContext(
    [lift(APP, 'const questionsPath = ('), lift(APP, 'function keep(scope, data)'), 'keep(scope, data);'].join('\n'),
    context
  );
  return written;
}

/** A full `/api/questions` payload — every field `adopt()` reads off it. */
const PAYLOAD = {
  questions: [{ key: 'beadcause/bc-1' }],
  requests: [{ key: 'beadcause/bc-2' }],
  workspaces: ['beadcause'],
  spaces: [{ name: 'Climative' }],
  filter: { space: 'all', workspace: 'all' },
  summary: { open: 3 },
  rootboard: { roots: [{ key: 'beadcause/bc-rfnr' }], startable: [], under: {}, unhomed: {}, assigned: {}, owned: true },
  tickets: [{ key: 'TECH-1' }],
  cancelledTickets: [{ key: 'TECH-2' }],
  strandedCancels: [{ key: 'TECH-3' }],
  trouble: [{ workspace: 'sophab', error: 'timeout' }],
  syncTrouble: [{ workspace: 'deluvia', error: 'behind' }],
  // On the payload but not in `keep`'s output — these are re-fetched their own way
  // (public/accountbar.js's own `/api/accounts` call) rather than carried warm, and
  // asserting their absence is what would catch `keep` growing to store the whole
  // payload again, which is the size problem its own comment argues against.
  account: 'adam.morgan@climative.ai',
  accounts: ['adam.morgan@climative.ai'],
  seq: 41,
};

const kept = callKeep('human', PAYLOAD);

check('keep() writes to the path the scope resolves to', () => {
  assert.equal(kept?.path, '/api/questions?scope=human');
});

check('keep() carries the sequence number through unchanged', () => {
  assert.equal(kept?.seq, 41);
});

for (const field of ['questions', 'requests', 'workspaces', 'spaces', 'filter', 'summary']) {
  check(`keep() still stores ${field}, as it always did`, () => {
    assert.deepEqual(kept?.stored?.[field], PAYLOAD[field]);
  });
}

// The six fields adopt() reads as "absent means an old server, keep what's on screen" —
// the ones a warm boot has no "screen" to fall back to, and the whole of bc-khoe.51.
for (const field of ['rootboard', 'tickets', 'cancelledTickets', 'strandedCancels', 'trouble', 'syncTrouble']) {
  check(`keep() now stores ${field}, so a warm boot has it to adopt`, () => {
    assert.deepEqual(kept?.stored?.[field], PAYLOAD[field], `${field} did not round-trip through keep()`);
  });
}

check('a rootboard with roots on it is not silently narrowed on the way through', () => {
  assert.equal(kept?.stored?.rootboard?.owned, true, 'owned:true became owned:false — the exact silent default this bead is about');
  assert.equal(kept?.stored?.rootboard?.roots?.length, 1);
});

check('a payload with none of the six still keeps cleanly — an old daemon is a miss, not a throw', () => {
  const { rootboard, tickets, cancelledTickets, strandedCancels, trouble, syncTrouble, ...rest } = PAYLOAD;
  const out = callKeep('human', rest);
  // **These three go first, and they are what make the six below mean anything.**
  // `out?.stored?.[field] === undefined` is equally true of a `keep()` that wrote
  // nothing at all, so on its own the loop cannot tell "kept, without inventing the
  // six" from "never kept". Every other check in this file asserts a field is present,
  // and would go red on a `keep()` that stopped writing; this one is the only one that
  // asserts a *behaviour*, and it is the one covering the mixed-fleet path the six
  // `adopt` guards exist for — so vacuous here means a later `keep()` could drop
  // old-daemon payloads on the floor and the file written to stop exactly that silence
  // stays green. Verified against the mutation `if (!data.rootboard) return;` at the
  // top of `keep()`, which left this suite 16/16 before these lines and fails on them.
  assert.ok(out, 'keep() wrote nothing at all for a payload missing the six — an old daemon is not warm-kept');
  assert.deepEqual(out.stored.questions, rest.questions, 'the payload did not round-trip through keep()');
  assert.equal(out.seq, 41, 'the sequence number did not come through');
  for (const field of ['rootboard', 'tickets', 'cancelledTickets', 'strandedCancels', 'trouble', 'syncTrouble']) {
    assert.equal(out.stored[field], undefined, `${field} appeared from nowhere on a payload that never had it`);
  }
});

console.log(
  failures ? `\n\x1b[31m${failures} of ${ran} checks failed\x1b[0m` : `\n\x1b[32mall ${ran} checks passed\x1b[0m`
);
process.exit(failures ? 1 : 0);
