#!/usr/bin/env node
/**
 * A live PR re-read has to outlive the document that read it — bc-jefsi.
 *
 *     npm test
 *     node test/boardrowadopt.mjs
 *
 * `ensurePrDetail` (public/app.js) forces a live, uncached `gh pr view` for the one PR a
 * card was opened or acted on, and hands the fresh row to `adoptBoardRow`, which patches
 * it into `state.board` — the same payload the whole list draws its buttons from. That
 * half already worked: the resolve-conflicts button cannot draw over a live `MERGEABLE`.
 *
 * What did not work is persistence. `/api/prs` is `holdOnly` (public/warm.js) on
 * purpose — it is a `gh` call per repo and must not become one per page load — and its
 * only two writers used to be `loadBoard`'s own sweep and `public/prs.js`'s board page.
 * `adoptBoardRow` mutated `state.board` in memory and stopped there, so a correction won
 * by opening or acting on a card died with the document: the next warm boot repainted
 * from the held entry, still carrying whatever `fresh` had just corrected — which is
 * exactly the "stale CONFLICTING survives reopens" bug bc-jefsi was filed over.
 *
 * The fix is one line: `adoptBoardRow` now writes the whole (patched) board back into
 * the warm entry, the same call `loadBoard` makes at its own sweep — same path, same
 * whole-payload shape, so a reopen after acting on a card paints the corrected row
 * rather than the held one.
 *
 * No `bd`, no network, no browser. `adoptBoardRow` touches no DOM, only `state` and
 * `window.beadcause.warm.write` — both given as plain stand-ins, the way test/jirarow.mjs
 * and test/p0card.mjs give the functions they lift a room with nothing else in it.
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
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.message).split('\n').slice(0, 4).join('\n      ')}`);
  }
}

const APP = read('public/app.js');

/**
 * Lift one declaration out of public/app.js — the same two-shape slice test/jirarow.mjs
 * uses, kept local rather than shared because this suite only ever needs the `function`
 * shape and a shared helper across files this size is its own kind of coupling.
 */
function lift(src, opener) {
  const at = src.indexOf(opener);
  assert.notEqual(at, -1, `public/app.js no longer declares \`${opener}\``);
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

console.log('\na freshly-read PR row replaces the one the board is holding');

const ROW_STALE = { key: 'beadcause/626', number: 626, mergeable: 'CONFLICTING' };
const ROW_OTHER = { key: 'beadcause/641', number: 641, mergeable: 'MERGEABLE' };
const FRESH = { key: 'beadcause/626', number: 626, mergeable: 'MERGEABLE' };

function adopt(board, fresh) {
  const calls = [];
  const context = vm.createContext({
    state: { board },
    FRESH: fresh,
    window: { beadcause: { warm: { write: (p, data) => calls.push({ path: p, data }) } } },
  });
  vm.runInContext(`${lift(APP, 'function adoptBoardRow(fresh)')}\nadoptBoardRow(FRESH);`, context, {
    filename: 'adoptBoardRow.js',
  });
  return calls;
}

await check('the matching row in state.board is replaced in place', () => {
  const board = { repos: [{ name: 'beadcause', prs: [ROW_STALE, ROW_OTHER] }] };
  adopt(board, FRESH);
  assert.deepEqual(board.repos[0].prs[0], FRESH, 'the stale row was not overwritten');
  assert.deepEqual(board.repos[0].prs[1], ROW_OTHER, 'the untouched row was disturbed');
});

await check('matching is by key, not by position or number alone', () => {
  // A `beadcause` #626 and an `athena-service` #626 sharing a number is bc-l853.6's
  // whole point — matching on `.number` would put this fresh row into both repos.
  const board = {
    repos: [
      { name: 'beadcause', prs: [{ key: 'beadcause/626', number: 626, mergeable: 'CONFLICTING' }] },
      { name: 'athena-service', prs: [{ key: 'climative/athena-service/626', number: 626, mergeable: 'CONFLICTING' }] },
    ],
  };
  adopt(board, FRESH);
  assert.equal(board.repos[0].prs[0].mergeable, 'MERGEABLE', 'the named repo was not corrected');
  assert.equal(board.repos[1].prs[0].mergeable, 'CONFLICTING', 'a same-numbered PR in another repo was also touched');
});

console.log('\nand the correction is written back into the warm entry — the gap bc-jefsi found');

await check('adopting a row persists the whole board to /api/prs, not only to memory', () => {
  const board = { repos: [{ name: 'beadcause', prs: [ROW_STALE] }] };
  const calls = adopt(board, FRESH);
  assert.equal(calls.length, 1, 'warm.write was not called at all — the correction dies with the document');
  assert.equal(calls[0].path, '/api/prs', 'written under a different key than loadBoard uses, so a reopen would never see it');
  assert.strictEqual(calls[0].data, board, 'not the same whole-payload shape loadBoard writes at public/app.js:2645');
});

await check('a row that matches nothing writes nothing — there is no board to persist', () => {
  const board = { repos: [{ name: 'beadcause', prs: [ROW_OTHER] }] };
  const calls = adopt(board, FRESH);
  assert.equal(calls.length, 0, 'warm.write ran even though adoptBoardRow found no match to adopt');
});

await check('an absent board (no card open yet) is a silent no-op, not a throw', () => {
  const context = vm.createContext({
    state: {},
    FRESH,
    window: {},
  });
  assert.doesNotThrow(() => {
    vm.runInContext(`${lift(APP, 'function adoptBoardRow(fresh)')}\nadoptBoardRow(FRESH);`, context, {
      filename: 'adoptBoardRow.js',
    });
  });
});

console.log('\nthe write matches the shape loadBoard already uses for the same entry');

await check('same path string as the sweep\'s own write', () => {
  assert.match(APP, /window\.beadcause\?\.warm\?\.write\?\.\('\/api\/prs', data\)/, 'loadBoard no longer writes /api/prs the way this suite assumes');
  const adoptSrc = lift(APP, 'function adoptBoardRow(fresh)');
  assert.match(adoptSrc, /window\.beadcause\?\.warm\?\.write\?\.\('\/api\/prs',\s*state\.board\)/, 'adoptBoardRow does not write the same warm entry loadBoard does');
});

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
