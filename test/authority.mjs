#!/usr/bin/env node
/**
 * lib/authority.js is a map, and a map can drift out from under the code it points at.
 *
 *     npm test
 *     node test/authority.mjs
 *
 * Every `SITES` entry names a module and the exports a new capability would actually
 * import — so this suite imports each of those modules for real and checks the named
 * exports still exist, the same discipline test/evidence.mjs applies to its own register
 * (a claim naming something that no longer exists is worse than no claim at all). It also
 * pins the two decisions most likely to be re-litigated: that `lib/claims.js` is *not* a
 * member of this family, and that `lib/underroot.js` is, even though the bead that asked
 * for this file did not name it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (f) => path.join(ROOT, 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-authority-'));
// Before anything under lib/ is imported: several of the modules SITES names resolve
// CONFIG_DIR once, at module load (lib/admin.js among them).
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { RUN, ASK, DENY, OUTCOMES, SITES, siteFor } = await import(LIB('authority.js'));
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

let failures = 0;
let ran = 0;
const check = async (name, fn) => {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
};

/* --------------------------------------------------------------- the vocabulary */

await check('the three outcomes are distinct strings, in the order the file introduces them', () => {
  assert.deepEqual(OUTCOMES, [RUN, ASK, DENY]);
  assert.equal(new Set(OUTCOMES).size, 3);
});

await check('every site produces one of the three outcomes', () => {
  for (const s of SITES) assert.ok(OUTCOMES.includes(s.outcome), `${s.id} names an outcome outside RUN/ASK/DENY`);
});

/* -------------------------------------------------------------------- the map */

await check('ids are unique, and siteFor finds each one', () => {
  const ids = SITES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'a duplicate id would silently shadow a site');
  for (const s of SITES) assert.equal(siteFor(s.id), s);
  assert.equal(siteFor('not-a-real-site'), undefined);
});

await check('every named module exists under lib/, and every named export resolves in it', async () => {
  for (const s of SITES) {
    const file = LIB(s.module.replace(/^lib\//, ''));
    assert.ok(fs.existsSync(file), `${s.id} names ${s.module}, which is not on disk`);
    const mod = await import(file);
    for (const name of s.exports) {
      assert.notEqual(
        mod[name],
        undefined,
        `${s.id} claims ${s.module} exports \`${name}\`, and it does not (renamed or removed?)`
      );
    }
  }
});

await check('lib/claims.js is not a member of this family', () => {
  assert.ok(
    !SITES.some((s) => s.module === 'lib/claims.js'),
    'claims.js answers a file-occupancy question, not an authorization one — see its own header'
  );
});

await check('lib/underroot.js is a member, even though the bead that asked for this map did not name it', () => {
  const s = siteFor('root-requirement');
  assert.ok(s, 'the root-requirement site is missing');
  assert.equal(s.module, 'lib/underroot.js');
  assert.equal(s.outcome, DENY);
});

/* ------------------------------------------------------------------- the door */

await check('README.md names this module as the place a new capability asks', () => {
  assert.ok(
    README.includes('## May this run unattended? — the map, not the merger'),
    'the section heading moved or was renamed — update this check alongside it'
  );
  assert.ok(README.includes('lib/authority.js'), 'the README section stopped naming the module');
});

/* ------------------------------------------------------------------------ done */

cleanupTmp(tmp);
console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
