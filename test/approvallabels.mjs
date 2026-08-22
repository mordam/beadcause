#!/usr/bin/env node
/**
 * bc-bmry.9 — the approval label vocabulary lives in one place, not two.
 *
 *     npm test
 *     node test/approvallabels.mjs
 *
 * lib/approval.js (the policy) and lib/approvalcard.js (the display) are deliberately
 * two files — see both their headers for why merging them would be wrong — but until
 * this landed both spelled `'gate'` and `'needs-approval'` as their own string
 * literals, and lib/approvalcard.js additionally owned `'draft'`, `'human-replied'`,
 * `'revision:'` and `'gate:'`. lib/approvallabels.js is the third file both import
 * instead of either owning a copy.
 *
 * Two things worth pinning:
 *
 * 1. Both files actually import the shared constants rather than merely agreeing with
 *    them by coincidence — read off the source, since a passing behavioural test
 *    cannot tell "imported" from "redeclared with the same value".
 * 2. Outside that import, neither file spells the label again. Five of the six can
 *    only ever mean the bd label match, so any second quoted copy is exactly the drift
 *    this bead is about. `'draft'` is the sixth and is deliberately left out of that
 *    static check: lib/approvalcard.js's `APPROVAL_STATES` table legitimately reuses
 *    the same word as a *display state id*, unrelated to the label match it also drives
 *    — checked functionally instead, in section 3.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blankJs } from './helpers/blank.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (f) => path.join(ROOT, 'lib', f);
const read = (f) => fs.readFileSync(LIB(f), 'utf8');

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
    console.log(`      ${String(err.message).split('\n').slice(0, 4).join('\n      ')}`);
  }
};

const labels = await import(LIB('approvallabels.js'));
const { approvalCard } = await import(LIB('approvalcard.js'));

console.log('\n1. the six constants, spelled exactly as the bead named them');
check('gate + gate: + needs-approval + draft + human-replied + revision:', () => {
  assert.equal(labels.GATE_LABEL, 'gate');
  assert.equal(labels.GATE_PREFIX, 'gate:');
  assert.equal(labels.NEEDS_APPROVAL, 'needs-approval');
  assert.equal(labels.DRAFT_LABEL, 'draft');
  assert.equal(labels.REPLIED_LABEL, 'human-replied');
  assert.equal(labels.REVISION_PREFIX, 'revision:');
});

const APPROVAL_SRC = blankJs(read('approval.js'));
const CARD_SRC = blankJs(read('approvalcard.js'));

console.log('\n2. both files import the shared vocabulary rather than redeclaring it');
check('lib/approval.js imports GATE_LABEL and NEEDS_APPROVAL from ./approvallabels.js', () => {
  assert.match(
    APPROVAL_SRC,
    /import\s*\{\s*GATE_LABEL,\s*NEEDS_APPROVAL\s*\}\s*from\s*'\.\/approvallabels\.js'/,
  );
});

check('lib/approvalcard.js imports all six names it reads from ./approvallabels.js', () => {
  const importBlock = CARD_SRC.match(/import\s*\{[\s\S]*?\}\s*from\s*'\.\/approvallabels\.js'/);
  assert.ok(importBlock, 'no import from ./approvallabels.js found');
  for (const name of ['GATE_LABEL', 'GATE_PREFIX', 'NEEDS_APPROVAL', 'DRAFT_LABEL', 'REPLIED_LABEL', 'REVISION_PREFIX']) {
    assert.ok(importBlock[0].includes(name), `import block is missing ${name}`);
  }
});

console.log('\n3. outside that import, neither file spells a label of its own');
// A file matching './approvallabels.js' is the import; strip that one line before
// looking for a second, independent quoted copy of the same text.
const withoutImportLine = (src) => src.replace(/^.*from\s*'\.\/approvallabels\.js'.*$/gm, '');
const hasOwnCopy = (src, text) => {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`['"]${escaped}['"]`).test(withoutImportLine(src));
};

const STRICT_LABELS = ['gate', 'gate:', 'needs-approval', 'human-replied', 'revision:'];
for (const [name, src] of [['lib/approval.js', APPROVAL_SRC], ['lib/approvalcard.js', CARD_SRC]]) {
  for (const label of STRICT_LABELS) {
    check(`${name} does not spell '${label}' as its own literal`, () => {
      assert.equal(hasOwnCopy(src, label), false, `${name} still hardcodes '${label}'`);
    });
  }
}

console.log("\n4. 'draft' — a bd label and a display state id at once, checked by behaviour");
check("approvalCard's draft state tracks approvallabels.DRAFT_LABEL's value, not a private copy", () => {
  const card = approvalCard({ id: 'x', status: 'open', labels: [labels.DRAFT_LABEL] });
  assert.equal(card.state, 'draft');
  assert.equal(card.label, 'draft');
});

console.log(`\n${ran - failures}/${ran} passed`);
if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
