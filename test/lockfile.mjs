#!/usr/bin/env node
/**
 * package-lock.json says the same thing package.json says.
 *
 *     npm test
 *     node test/lockfile.mjs
 *
 * The lock file is generated, so nobody reads it and nobody notices when it stops
 * matching. `package.json` grew six more `bin` entries across several PRs — `ask`,
 * `checkin`, `deliver`, `get`, `memory`, `propose` — and the committed lock still
 * listed two. Nothing compared the two files, so the only symptom was that anyone
 * who ran `npm install` got a permanently modified `package-lock.json` in their
 * working tree, which is the worst possible signal: it looks like local noise, it
 * never goes away, and every ship has to decide again whether to carry it. It sat
 * dirty in the main checkout for weeks and was reported as "generated drift, not
 * mine to commit" — correctly, each time, by a different session.
 *
 * A stale lock is not cosmetic. `npm ci` installs *the lock*, ignoring package.json
 * entirely, so a bin or a dependency that exists only in package.json is simply
 * absent from a clean install — and the machine that does a clean install is never
 * the machine that noticed.
 *
 * This compares the two files directly: no npm, no network, no node_modules, so it
 * costs nothing and can live in `npm test`. It is deliberately narrower than
 * `npm ci --dry-run`, which would catch more but needs the registry and takes
 * ~30s; the drift that actually happens here is "package.json was edited and the
 * lock was not regenerated", and that is exactly what this sees.
 *
 * When it fails the fix is always the same, and it is not to edit the lock by hand:
 *
 *     npm install --package-lock-only        # regenerate from package.json
 *     git add package-lock.json              # and commit it WITH the package.json change
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));

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

const pkg = read('package.json');
const lock = read('package-lock.json');

/* --------------------------------------------------------------- the shape */

/**
 * `packages[""]` is the lock's copy of package.json's own manifest, and it is the
 * half that drifts. It only exists from lockfileVersion 2 on; on an older lock
 * there is nothing here to compare and the rest of this file would pass vacuously,
 * so fail loudly instead of quietly checking nothing.
 */
if (!(lock.lockfileVersion >= 2)) {
  bad('the lock is version 2 or newer', `lockfileVersion is ${lock.lockfileVersion} — no packages[""] to compare`);
  console.log(`\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n`);
  process.exit(1);
}
ok('the lock is version 2 or newer');

const root = lock.packages?.[''];
if (!root) {
  bad('the lock has a root package entry', 'packages[""] is missing');
  console.log(`\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n`);
  process.exit(1);
}
ok('the lock has a root package entry');

/* ------------------------------------------------------------ name/version */

for (const field of ['name', 'version']) {
  if (lock[field] !== pkg[field]) bad(`the lock's ${field} matches package.json`, `lock ${JSON.stringify(lock[field])} vs package.json ${JSON.stringify(pkg[field])}`);
  else ok(`the lock's ${field} matches package.json`);

  if (root[field] !== pkg[field]) bad(`the root entry's ${field} matches package.json`, `root ${JSON.stringify(root[field])} vs package.json ${JSON.stringify(pkg[field])}`);
  else ok(`the root entry's ${field} matches package.json`);
}

/* ------------------------------------------------------- maps, both ways */

/**
 * Compared in both directions on purpose. A missing entry is the stale-lock case;
 * a *surplus* one is the opposite and just as wrong — something was deleted from
 * package.json and the lock kept installing it.
 */
const compareMap = (label, want = {}, got = {}) => {
  const names = [...new Set([...Object.keys(want), ...Object.keys(got)])].sort();
  const wrong = [];
  for (const n of names) {
    if (!(n in got)) wrong.push(`${n}: in package.json (${want[n]}), missing from the lock`);
    else if (!(n in want)) wrong.push(`${n}: in the lock (${got[n]}), not in package.json`);
    else if (want[n] !== got[n]) wrong.push(`${n}: package.json says ${want[n]}, the lock says ${got[n]}`);
  }
  if (wrong.length) bad(`the lock's ${label} matches package.json`, wrong.join('\n      '));
  else ok(`the lock's ${label} matches package.json${names.length ? ` (${names.length})` : ' (none declared)'}`);
};

compareMap('bin', pkg.bin, root.bin);
for (const block of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
  compareMap(block, pkg[block], root[block]);
}

/* -------------------------------------------------- every dep is resolved */

/**
 * The root entry can agree with package.json and the tree below it still be stale:
 * a bumped range regenerates `packages[""]` but a hand-edit would not bring the
 * resolved version with it. So check each declared dependency actually has a
 * locked entry, and that its version is inside the declared range.
 *
 * A tiny range check rather than pulling in `semver` — it is not a dependency of
 * this project and a test gate should not add one. Only `^`, `~` and exact pins
 * are understood, which is every range this package.json uses; anything else is
 * reported as unchecked rather than silently passed.
 */
const satisfies = (version, range) => {
  const m = /^([\^~]?)(\d+)\.(\d+)\.(\d+)$/.exec(String(range).trim());
  const v = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim());
  if (!m || !v) return null;
  const op = m[1];
  const want = [Number(m[2]), Number(m[3]), Number(m[4])];
  const have = [Number(v[1]), Number(v[2]), Number(v[3])];
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  if (cmp(have, want) < 0) return false;
  if (op === '^') {
    if (want[0] !== 0) return have[0] === want[0];
    if (want[1] !== 0) return have[0] === 0 && have[1] === want[1];
    return cmp(have, want) === 0;
  }
  if (op === '~') return have[0] === want[0] && have[1] === want[1];
  return cmp(have, want) === 0;
};

const declared = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
const missing = [];
const unsatisfied = [];
const unchecked = [];

for (const [name, range] of Object.entries(declared)) {
  const entry = lock.packages?.[`node_modules/${name}`];
  if (!entry || !entry.version) {
    missing.push(`${name}@${range}: no node_modules/${name} entry in the lock`);
    continue;
  }
  const verdict = satisfies(entry.version, range);
  if (verdict === false) unsatisfied.push(`${name}: package.json wants ${range}, the lock pins ${entry.version}`);
  else if (verdict === null) unchecked.push(`${name}@${range} (locked ${entry.version})`);
}

if (missing.length) bad('every declared dependency is resolved in the lock', missing.join('\n      '));
else ok(`every declared dependency is resolved in the lock (${Object.keys(declared).length})`);

if (unsatisfied.length) bad('every locked version is inside its declared range', unsatisfied.join('\n      '));
else ok('every locked version is inside its declared range');

if (unchecked.length) console.log(`      note: range not understood, version unchecked — ${unchecked.join(', ')}`);

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
