#!/usr/bin/env node
/**
 * A config key can ship with no row in the README's Config table, and nothing fails.
 *
 *     npm test
 *     node test/configtable.mjs
 *
 * `test/routes.mjs` already does this for `/api` paths: derive what the server actually
 * serves, scrape what the README claims, and fail on either direction disagreeing. There
 * was no equivalent for `~/.config/beadcause/config.json` keys, and the gap was not a
 * hypothetical one. `advocates.maxEpicAdvocates` landed on 2026-08-14 with a default, a
 * ceiling, a per-workspace override and a tag on `/monitor` that names it to the reader
 * — and no row in the Config table for three days. Nothing anywhere went red.
 *
 * Measured against main on 2026-08-17 (871b4c67 and after), the gap was not one key —
 * it was about twenty, spread across `advocates.*`, the daemon's own top-level settings
 * and `release`, `ntfy` and `slack`. Some had never been mentioned in the README at all;
 * others were argued about in prose thousands of lines from the table, which is not the
 * same as being in it — the table is where a person goes to find out what they may set,
 * and a paragraph elsewhere is not that. So this takes the hard line `test/routes.mjs`
 * already took for routes: **table rows only**.
 *
 * Two checks, one in each direction, over the *contiguous* `| key | meaning |` table
 * right after the `## Config` heading — not the whole section, which later reuses the
 * same `| \`x\` |` row shape for unrelated tables (an ingestion-status legend, the
 * environment-variable list). Scraping the wrong boundary is the way this check would
 * quietly stop meaning anything, so the floor assertions below exist for the same reason
 * `routes.mjs`'s do: to catch a regex that has stopped matching before it stops mattering.
 *
 * 1. **Every key the daemon actually defaults has a row.** "Actually defaults" means two
 *    places, because that is where the two owners of config keys put them: `defaults()`
 *    in lib/config.js for everything else, and `options()` — DEFAULTS in lib/advocate.js,
 *    itself assembled from `LEASE_DEFAULTS`, `REENTER_DEFAULTS`, `REAP_DEFAULTS` and
 *    `MAINTENANCE_DEFAULTS` — for `advocates.*`. A **shape row** — one row documenting a
 *    compound value rather than each of its fields, like `sessionWindows.card` for
 *    `{width, height, gap}` — counts as documenting everything under it: a served key whose own
 *    row is missing but whose *parent path* has one is not a gap, because that is
 *    precisely what a shape row is for. Nothing here treats a shape row as covering
 *    anything **outside** its own subtree, so this stays as strict as an exact match
 *    everywhere a shape row does not exist.
 *
 * 2. **Every row names a key something reads.** The reverse direction, and the one that
 *    catches a dead setting — a row for a key nobody reads any more is a setting people
 *    will try to set. Most rows match a served default directly. The handful that do not
 *    are named in `NO_DEFAULT` below, each with the reason it is real and undefaulted
 *    rather than dead: `agentToolsAcknowledged` is written only once you accept the
 *    extended-tools warning, `claudeSessionsDir`/`claudeProjectsDir` are overrides read
 *    only if set, and `agents[].tools` / `jira.<workspace>.tokenFile` document a shape
 *    inside an array or a per-workspace object rather than a top-level default. A row
 *    naming anything else this list and the served set do not cover fails the suite.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-configtable-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

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
const check = (fn, name) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

console.log('\nthe Config table\n');

/* ------------------------------------------------------------- what is served */

const { loadConfig } = await import(LIB('config.js'));
const { options: advocateOptions } = await import(LIB('advocate.js'));

const cfg = loadConfig();
// `cfg.advocates` off loadConfig() is only ever merged against the partial hand-copy of
// `advocates.*` defaults inside lib/config.js's own `defaults()` — a second, incomplete
// mirror of the DEFAULTS this file actually owns (missing `maxEpicAdvocates` among
// others, which is its own drift and not this suite's). `options()` is what every
// consumer of an advocate setting actually calls, so it is the one this checks against.
cfg.advocates = advocateOptions(cfg);

/**
 * Dot-paths for every leaf in `cfg`. An empty object is a leaf in its own right — a
 * default of `{}` (`workspaceDirs`, `repos`, `advocates.perWorkspace`, …) is a real key
 * with nothing under it yet, not an absence to recurse past and lose.
 */
function flatten(obj, prefix, out) {
  const entries = Object.entries(obj);
  if (entries.length === 0) {
    if (prefix) out.push(prefix);
    return out;
  }
  for (const [k, v] of entries) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out.push(key);
  }
  return out;
}

const served = new Set(flatten(cfg, '', []));

check(
  () => assert.ok(served.size >= 170, `only ${served.size} keys found — has defaults() or advocate DEFAULTS moved?`),
  `the merged config is readable — ${served.size} keys in it`
);

/* --------------------------------------------------- what the README documents */

const README = fs.readFileSync(path.join(HERE, '..', 'README.md'), 'utf8');
const readmeLines = README.split('\n');

const headingIdx = readmeLines.findIndex((l) => l.startsWith('## Config —'));
assert.ok(headingIdx >= 0, 'README has no "## Config —" heading — has it been renamed?');
// The single contiguous table right after the heading, not the whole "## Config"
// section: that section goes on for another 1,600 lines and reuses the same
// `| \`x\` |` row shape for an ingestion-status legend and the environment-variable
// list, neither of which is a config.json key.
const tableStart = readmeLines.findIndex((l, i) => i >= headingIdx && l.startsWith('| key | meaning |'));
assert.ok(tableStart >= 0, 'no "| key | meaning |" table found under "## Config —"');
let tableEnd = tableStart + 1;
while (tableEnd < readmeLines.length && readmeLines[tableEnd].startsWith('|')) tableEnd += 1;

const documented = new Set();
for (const line of readmeLines.slice(tableStart, tableEnd)) {
  if (!line.startsWith('| `')) continue;
  const firstCell = line.split('|')[1];
  for (const m of firstCell.matchAll(/`([^`]+)`/g)) documented.add(m[1]);
}

check(
  () => assert.ok(documented.size >= 165, `only ${documented.size} rows matched — has the Config table moved or changed shape?`),
  `the README's Config table is readable — ${documented.size} rows in it`
);

/* ---------------------------------------------- direction 1: served → documented */

/**
 * A served key counts as documented if its own row exists, or if a **shape row** exists
 * for one of its ancestor paths — `sessionWindows.card` covering `.width`/`.height`/
 * `.gap`, `incidents.sev1` covering `.acknowledge`/`.resolve`. Checking every ancestor
 * rather than only the immediate parent is what lets `incidents.vulnerabilityDays` cover
 * `.critical` two levels down without a row for `incidents.vulnerabilityDays.critical`
 * existing on its own — and it stays safe against a shape row silently swallowing
 * unrelated keys, because there is no bare `advocates` or `sessionWindows` row: every
 * shape row here names the exact subtree it stands for.
 */
function coveredByRow(key) {
  if (documented.has(key)) return true;
  const parts = key.split('.');
  for (let i = parts.length - 1; i > 0; i -= 1) {
    if (documented.has(parts.slice(0, i).join('.'))) return true;
  }
  return false;
}

const undocumented = [...served].filter((k) => !coveredByRow(k)).sort();
check(
  () => assert.deepEqual(undocumented, [], `served but undocumented:\n      ${undocumented.join('\n      ')}`),
  'every key the daemon actually defaults has a row (or a shape row over it)'
);

/* ---------------------------------------------- direction 2: documented → read */

/**
 * Rows for a real key with no default — read only if set, so it never appears in
 * `served` however completely `defaults()` is walked. Each is verified below to still
 * be read somewhere in `lib/`, so this stays a list of exceptions with a reason rather
 * than a way to silence a genuinely dead row.
 */
const NO_DEFAULT = {
  // Written once you accept the extended-tools warning for an agent — lib/agents.js.
  agentToolsAcknowledged: 'lib/agents.js',
  // Overrides read only if set — lib/claude.js, lib/transcript.js.
  claudeSessionsDir: 'lib/claude.js',
  claudeProjectsDir: 'lib/transcript.js',
  // Shape rows: a field inside an array element or a per-workspace object, not a
  // top-level default `agents: []` or `jira: {}` can ever carry on its own.
  'agents[].tools': 'lib/agents.js',
  'jira.<workspace>.tokenFile': 'lib/jira.js',
};

const libSrc = fs
  .readdirSync(LIB('.'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => fs.readFileSync(LIB(f), 'utf8'))
  .join('\n');

for (const [key, owner] of Object.entries(NO_DEFAULT)) {
  const prop = key.split(/[.[]/).pop().replace(/[>\]]/g, '');
  check(
    () => assert.ok(libSrc.includes(`.${prop}`), `no reference to .${prop} found under lib/ — is ${owner} still the reader, or is this row dead?`),
    `${key} has no default but is still read (${owner})`
  );
}

// A shape row's own key — `sessionWindows.card`, `incidents.sev1` — is never itself a
// served *leaf* (its children are), so it needs the same "is this an ancestor of
// something real" test direction 1 runs, just pointed the other way.
const isShapeParent = (k) => [...served].some((s) => s.startsWith(`${k}.`));

const phantom = [...documented].filter((k) => !served.has(k) && !(k in NO_DEFAULT) && !isShapeParent(k)).sort();
check(
  () => assert.deepEqual(phantom, [], `documented but not served and not in NO_DEFAULT:\n      ${phantom.join('\n      ')}`),
  'and every other row names a key the daemon actually defaults'
);

/* ---------------------------------------------------------------------- done */

await cleanupTmp(tmp);

console.log('');
if (failures) {
  console.log(`\x1b[31m${failures} of ${ran} checks failed\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32mall ${ran} checks passed\x1b[0m`);
