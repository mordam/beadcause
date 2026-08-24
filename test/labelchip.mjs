#!/usr/bin/env node
/**
 * A card names a label the create will drop before the button is pressed, not after.
 *
 *     npm test
 *     node test/labelchip.mjs
 *
 * `lib/proposedlabels.js`'s `daemonOnly` already answers "would `bd create` drop this
 * label, and why" — `filterProposedLabels` asks it at create time and turns the answer
 * into the warning that lands after the beads exist. Nothing asked it *before* that:
 * the Labels field on a card showed `unendorsed` or `superseded-by:bc-x` as an ordinary
 * value, so the card and the bead it was about to become disagreed until the warning
 * appeared underneath. bc-xl7n.87.
 *
 * The fix is not a second list. `lib/draft.js` calls the same `daemonOnly` while
 * normalising a bead — in `extractProposal`, for an agent's proposal, and in
 * `normalizeDraft`, for a phone's edit — and attaches the answer to the bead as
 * `labelIssues`, keyed by the label string. `public/console.js` reads that field to
 * grey the pill and add a readable line; it does not re-derive the rule.
 *
 * So this pins two things: that `labelIssues` is exactly what `daemonOnly` says, for
 * every label `lib/proposedlabels.js` refuses and for the two it deliberately excepts
 * (`owner:`, `for:`) — a static read of `DAEMON_ONLY` rather than a hardcoded list, so a
 * family added there is covered here without this file being edited; and that the phone
 * draws what it is given, checked as a static read the same way test/consoledupe.mjs and
 * test/draftlabels.mjs check console.js — a chat has to be opened and a sheet rendered to
 * reach the handler otherwise, and what is worth pinning here is the two expressions.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);
const PUBLIC = (name) => path.join(HERE, '..', 'public', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-labelchip-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { extractProposal, normalizeDraft } = await import(LIB('draft.js'));
const { daemonOnly, DAEMON_ONLY } = await import(LIB('proposedlabels.js'));

/* ------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
function check(name, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
}

const block = (...lines) => ['```beads', 'beads:', ...lines, '```'].join('\n');

/* ------------------------------------------------------------- what the agent writes */

console.log('the YAML block an agent writes');

check('a label the create would drop carries the reason on the bead, before any create', () => {
  const { draft } = extractProposal(block('  - title: A bead', '    labels: [unendorsed, ok]'));
  assert.equal(draft.beads[0].labelIssues.unendorsed, daemonOnly('unendorsed'));
  assert.equal('ok' in draft.beads[0].labelIssues, false, 'an ordinary label has nothing to say');
});

check('every family DAEMON_ONLY refuses is caught here too, word for word', () => {
  for (const rule of DAEMON_ONLY) {
    const label = rule.label.includes('…') ? `${rule.label.replace('…', '')}sample` : rule.label;
    const { draft } = extractProposal(block('  - title: A bead', `    labels: ["${label}"]`));
    assert.equal(
      draft.beads[0].labelIssues[label],
      daemonOnly(label),
      `${label}: labelIssues must say exactly what daemonOnly says`
    );
    assert.ok(draft.beads[0].labelIssues[label], `${label}: expected a reason, got none`);
  }
});

check('the two the create excepts — owner: and for: — carry no issue', () => {
  const { draft } = extractProposal(
    block('  - title: A bead', '    labels: ["owner:adam@example.com", "for:adam@example.com"]')
  );
  assert.deepEqual(draft.beads[0].labelIssues, {}, JSON.stringify(draft.beads[0].labelIssues));
});

/* -------------------------------------------------------------- what the phone posts back */

console.log('\nwhat the phone posts back');

check('a draft edited on the phone keeps the reason through normalizeDraft', () => {
  const draft = normalizeDraft({ beads: [{ ref: 'a', title: 'A bead', labels: ['unendorsed'] }] });
  assert.equal(draft.beads[0].labelIssues.unendorsed, daemonOnly('unendorsed'));
});

/* ------------------------------------------------------------------- what the phone draws */

console.log('\nand the copy of this the phone draws');

const consoleJs = fs.readFileSync(PUBLIC('console.js'), 'utf8');

check('the summary pill greys a flagged label and carries the reason as its title', () => {
  const fn = consoleJs.match(/const labelPill = \(l\) =>[\s\S]*?: `<span class="pill">\$\{esc\(l\)\}<\/span>`;/);
  assert.ok(fn, 'labelPill has moved or been renamed');
  assert.match(fn[0], /pill muted/, 'a flagged label must not look like an ordinary one');
  assert.match(fn[0], /title="\$\{esc\(labelIssues\[l\]\)\}"/, 'the reason belongs on the pill');
});

check('the open editor states the reason in words, not only in a hover title', () => {
  // A `title` is a tooltip, and this card is read on a phone — bc-xl7n.87's whole
  // complaint was a warning nobody could see before the button. Something in the
  // Labels field's neighbourhood has to print the sentence outright.
  const idx = consoleJs.indexOf('data-field="labels"');
  assert.ok(idx > 0, 'the Labels field has moved');
  const nearby = consoleJs.slice(idx, idx + 1200);
  assert.match(nearby, /labelIssues/, 'the block after the Labels field must read labelIssues');
  assert.match(nearby, /would be dropped on create/, 'and say what will happen to it, in words');
});

check('the collapsed card and the open one both see the same labelIssues, and it falls back safely', () => {
  // `|| {}` for the same reason `files` falls back a line above it: a draft kept on
  // this phone may predate the field, and the sheet must not throw over it.
  assert.match(consoleJs, /const labelIssues = b\.labelIssues \|\| \{\};/);
});

/* ------------------------------------------------------------------------ end */

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${ran - failures}/${ran} checks passed`);
process.exit(failures ? 1 : 0);
