#!/usr/bin/env node
//
// b7e-def — where a symbol is defined, in one call instead of four failed greps
// (bc-khoe.27.5).
//
//   npm test
//   node test/b7edef.mjs
//
// Runs the real command against this repo's own source, which is the whole point:
// the acceptance criteria on the bead are stated in terms of two real symbols
// (`indexFrom` in lib/ancestry.js, `loadBead` in lib/verdict.js) rather than a
// fixture, because a fixture cannot reproduce "lib/server.js is 10,560 lines" and
// that was the actual failure mode. If either symbol below ever moves, this test
// is meant to go red — a b7e-def that stops finding real code is worse than one
// that never shipped.
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-def');

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

const run = (args) => spawnSync(process.execPath, [BIN, ...args], { cwd: ROOT, encoding: 'utf8' });

console.log('\nfinding a real definition, in one call');

{
  const r = run(['indexFrom']);
  check('exits 0', r.status === 0, `status was ${r.status}\n${r.stderr}`);
  check('names lib/ancestry.js, not just the file that imports it', /^lib\/ancestry\.js:\d+-\d+/m.test(r.stdout), r.stdout);
  check('includes the doc comment above the function', r.stdout.includes('giving back every half of what the export is worth reading for'), r.stdout);
  check('includes the function body, not just its head', r.stdout.includes('return { parents, beads, adopts, edges };'), r.stdout);
}

console.log('\na name only imported where you look is not the answer — the real site is');

{
  // loadBead is imported into lib/server.js and lib/discuss.js; defined in
  // lib/verdict.js. The acceptance criterion is specifically that b7e-def finds
  // the real site rather than stopping at an import.
  const r = run(['loadBead']);
  check('exits 0', r.status === 0, `status was ${r.status}\n${r.stderr}`);
  check('reports the import into lib/server.js', /imported at lib\/server\.js:\d+ \(from '\.\/verdict\.js'\)/.test(r.stdout), r.stdout);
  check('reports the real definition in lib/verdict.js', /^lib\/verdict\.js:\d+-\d+/m.test(r.stdout), r.stdout);
  check('the real definition is printed, not just named', r.stdout.includes('export async function loadBead('), r.stdout);
}

console.log('\ntwo definitions is a report of two, not a guess');

{
  // `normalize` is a plain (non-exported) function, independently defined in at
  // least three files here — not one function imported under the same name.
  const r = run(['normalize']);
  check('exits 0', r.status === 0, `status was ${r.status}\n${r.stderr}`);
  const spans = [...r.stdout.matchAll(/^lib\/[\w./-]+:\d+-\d+/gm)];
  check('finds at least two independent definitions', spans.length >= 2, `found ${spans.length}:\n${r.stdout}`);
  const files = new Set(spans.map((m) => m[0].split(':')[0]));
  check('they are in different files, not one match repeated', files.size >= 2, [...files].join(', '));
}

console.log('\na name with no definition exits non-zero and says so');

{
  const r = run(['thisSymbolDoesNotExistAnywhereInThisRepoXyz']);
  check('exits non-zero', r.status !== 0, `status was ${r.status}`);
  check('says so, rather than printing nothing', /no definition of/.test(r.stdout), r.stdout);
}

console.log('\n--callers adds call sites without duplicating the definition or the import');

{
  const r = run(['pairKey', '--callers']);
  check('exits 0', r.status === 0, `status was ${r.status}\n${r.stderr}`);
  check('lists at least one caller', /^callers \(\d+\):/m.test(r.stdout), r.stdout);
  check('a known call site is named', /lib\/adoptsweep\.js:\d+:.*pairKey\(/.test(r.stdout), r.stdout);
  const defLine = r.stdout.match(/^lib\/ancestry\.js:(\d+)-\d+/m);
  check('the definition line itself is not re-listed as a caller', Boolean(defLine) && !new RegExp(`callers[\\s\\S]*lib/ancestry\\.js:${defLine?.[1]}:`).test(r.stdout), r.stdout);
}

console.log('\na call passing an object literal is not mistaken for a definition (bc-dgx7.36)');

{
  // openReviewAnswerSession is a real export in lib/session.js. Its only call site,
  // lib/server.js:3322, is a bare `openReviewAnswerSession(...)` at the start of a
  // trimmed line — syntactically identical to the method/property-function head
  // shape — whose own closing `)` is immediately followed by a comma, then
  // `resolveFor`'s own third-argument object literal three arguments later. Before
  // bc-dgx7.36, findBody walked past that comma to the first `{` at depth 0,
  // however far away, and reported the call site as a second, phantom definition.
  const r = run(['openReviewAnswerSession']);
  check('exits 0', r.status === 0, `status was ${r.status}\n${r.stderr}`);
  const spans = [...r.stdout.matchAll(/^lib\/[\w./-]+:\d+-\d+/gm)];
  check('exactly one definition, not the call site too', spans.length === 1, `found ${spans.length}:\n${r.stdout}`);
  check('the one definition is in lib/session.js', spans[0]?.[0].startsWith('lib/session.js:'), r.stdout);
  check('no phantom definition at the lib/server.js call site', !spans.some((m) => m[0].startsWith('lib/server.js:')), r.stdout);
}

console.log('\nno name, or --help, is a usage message rather than a crash');

{
  const r = run([]);
  check('bare invocation exits non-zero', r.status !== 0, `status was ${r.status}`);
  check('prints usage', /b7e-def <name>/.test(r.stderr), r.stderr);
}

{
  const r = run(['--help']);
  check('--help exits 0', r.status === 0, `status was ${r.status}`);
  check('prints usage', /b7e-def <name>/.test(r.stdout), r.stdout);
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : '\n\x1b[32mall checks passed\x1b[0m\n');
process.exit(failures ? 1 : 0);
