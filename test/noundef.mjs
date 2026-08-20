#!/usr/bin/env node
/**
 * A name that resolves to no binding, anywhere in `lib/`, `bin/` or `scripts/`, is a
 * `ReferenceError` waiting for whichever sweep or route first reaches that line — and
 * until this suite existed, nothing in this repo could see that class of mistake
 * before it did. `node --check` only parses; the only other guards were regexes over
 * the source, which cannot tell `bus` from `app.bus` (see test/pollerbus.mjs, which
 * pins that one function by name and is kept for what it proves that this file
 * deliberately does not attempt — that the sweep really runs).
 *
 *     npm test
 *     node test/noundef.mjs
 *
 * bc-gdub is the reason this exists: `bus.emit(...)` inside `startPoller`, correct
 * three thousand lines up inside `createApp` where `bus` is a plain local, and a
 * `ReferenceError` down here where the same object is only reachable as `app.bus`. It
 * parsed, it booted, and it threw on the first deploy the daemon settled — days after
 * it merged. The scope-analysis approach (lib/noundef.js) is real: acorn to parse,
 * `eslint-scope` — the engine ESLint's own `no-undef` rule runs on, not a hand-rolled
 * approximation — to resolve every reference to a binding or report that it found
 * none.
 *
 * Two checks, and they fail in different ways on purpose:
 *
 * 1. **The whole tree is clean.** Every `.js`/`.mjs` file under lib/, bin/ and
 *    scripts/ is scanned; a finding here is a real bug — see the second check below
 *    for what "real" means, and lib/server.js:5047's `requireUnit` destructure
 *    (fixed alongside this suite) for what one looked like: `const { unit } =
 *    requireUnit(...)` where `requireUnit` returns `{ ws, unit }` and the route went
 *    on to read `ws.name` fifty lines later, inside a `.catch`. This check found it
 *    on the very first run over this tree — proof it does the job before it is ever
 *    asked to hold the line.
 * 2. **It really does catch bc-gdub's own line.** The exact historical mistake —
 *    `bus.emit(deployEvent(rec` in place of `app.bus.emit(deployEvent(rec` inside
 *    `startPoller` — is re-introduced into a copy of the real lib/server.js source
 *    and must be seen. A guard that cannot fail is one nobody should trust.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTree, undefinedRefs, scanFiles } from '../lib/noundef.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let failures = 0;
let ran = 0;
const check = (name, fn) => {
  ran += 1;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${err.message}`);
  }
};

check('scans a real, non-trivial slice of the tree', () => {
  const files = scanFiles(ROOT);
  // Not pinned to an exact count — that would conflict with itself the day anyone
  // adds a file — just enough to prove this did not silently scan nothing.
  assert.ok(files.length > 100, `expected well over 100 files under lib/, bin/, scripts/, saw ${files.length}`);
  assert.ok(files.includes('lib/server.js'), 'lib/server.js — where bc-gdub happened — must be in scope');
});

check('every reference in lib/, bin/ and scripts/ resolves to a binding', () => {
  const findings = checkTree(ROOT);
  assert.ok(
    findings.length === 0,
    `every one of these is a ReferenceError at runtime:\n  ${findings
      .map((f) => `${f.file}:${f.line}:${f.column} — ${f.name}`)
      .join('\n  ')}`
  );
});

// A guard which cannot fail is one nobody should trust — so the read is proved
// against the bug it exists for, rather than against the fixed source alone. Same
// discipline as test/pollerbus.mjs's matching check.
check('and it really does catch the line bc-gdub was filed for', () => {
  const server = fs.readFileSync(path.join(ROOT, 'lib', 'server.js'), 'utf8');
  const start = server.indexOf('export function startPoller(cfg, app) {');
  assert.ok(start > -1, 'startPoller must still be a top-level export of lib/server.js');
  const broken = server.replace('app.bus.emit(deployEvent(rec', 'bus.emit(deployEvent(rec');
  assert.notStrictEqual(broken, server, 'the line this bug looked like must still be present to break');
  const refs = undefinedRefs(broken);
  assert.ok(
    refs.some((r) => r.name === 'bus'),
    'a bare `bus` reintroduced into startPoller must be reported as undefined'
  );
});

console.log(`\n${ran - failures}/${ran} checks passed`);
process.exit(failures ? 1 : 0);
