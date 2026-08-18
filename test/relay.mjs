#!/usr/bin/env node
/**
 * lib/relay.js — the department relay dispatcher, and the section of brief it writes.
 *
 *     npm test
 *     node test/relay.mjs
 *
 * A relay changes *who the agent in a window is*, which is the first thing in this program
 * that is not a fact about scheduling — so what has to hold is mostly about not firing:
 *
 * 1. **Nothing that is not a studio bead changes by a character.** Four of the five
 *    workspaces have no `relays` entry at all, and most of deluvia's beads are assigned to
 *    a person or to nobody. Every one of those must produce the brief it produced before,
 *    byte for byte — asserted against a brief built with no relay rather than against a
 *    substring, because a section that leaks in anywhere is a generic session being told
 *    it is five agents.
 *
 * 2. **The chain is derived from §6 of the charter, not typed.** Draft, check, revise,
 *    file. A checker that is the drafting role drops out — clio drafting a Story bead is
 *    checked by muse alone and does not check itself — and the revise step exists only
 *    when something actually checked.
 *
 * 3. **Executive gets no relay.** vox, tally and ward produce process, not reviewable
 *    deliverables. A bead assigned to one of them is an ordinary bead, and that has to be
 *    true of `ward` in particular, because `ward` is also the filer at the end of every
 *    chain and therefore a role the definition knows.
 *
 * 4. **The `dept:` label wins over the roster.** It is the routing label
 *    `APPROVAL_PIPELINE.md` defines and the one a human set; the roster is the fallback
 *    for a bead nobody labelled.
 *
 * 5. **The brief says the three things the relay cannot work without** — that the assignee
 *    is a role and not a person, that the packet is a bead of its own that nothing here
 *    closes, and that a hand-back must name the next role. That last one is the resume
 *    mechanism in its entirety: `--claim` destroys the assignee, so a hand-back that
 *    clears it instead of naming a role loses the chain silently.
 *
 * 6. **The shipped config is a real relay.** `defaults()` carries a `deluvia` entry, and a
 *    default that is malformed is one nobody would notice until a window opened with a
 *    chain of one. It is exercised through the same public entry point as the fixtures.
 *
 * Pure functions throughout — no tracker, no checkout, no window, nothing under `~`.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err && err.message ? err.message : String(err)).split('\n').join('\n       ')}`);
  }
}

console.log('\ndepartment relays — who the agent in the window is\n');

const { chainFor, chainLine, departmentOf, profilePath, relayFor, roleOf, rolesOf } = await import(LIB('relay.js'));
const { workPromptFor } = await import(LIB('session.js'));

/**
 * A studio small enough to read, with the two shapes that matter in it: a department whose
 * checks include one of its own members (Story — clio and muse are both Story), and one
 * whose checks are staffed elsewhere (Design — clio is a Story agent checking Design work).
 */
const CFG = {
  relays: {
    studio: {
      profile: 'ai-context/agents/{role}/{role}.md',
      docs: ['docs/STUDIO_CHARTER.md', 'docs/APPROVAL_PIPELINE.md'],
      filer: 'ward',
      packet: ['needs-approval', 'human'],
      executive: ['vox', 'tally', 'ward'],
      departments: {
        'dept:story': { name: 'Story', lead: 'script', members: ['lore', 'aria', 'script', 'clio', 'muse'], check: ['clio', 'muse'] },
        'dept:design': { name: 'Design', lead: 'palette', members: ['palette', 'mien', 'carta'], check: ['clio', 'palette'] },
        'dept:solo': { name: 'Solo', lead: 'solon', members: ['solon'], check: [] },
      },
    },
  },
};

const bead = (over = {}) => ({ id: 'dv-1', title: 'Chapter 7', assignee: '', labels: [], ...over });
const line = (b, ws = 'studio', cfg = CFG) => {
  const c = chainFor(cfg, ws, b);
  return c ? chainLine(c) : null;
};

/* ------------------------------------------------------- 1. the ordinary bead */

await check('a workspace with no relay entry never relays', () => {
  assert.equal(line(bead({ assignee: 'aria', labels: ['dept:story'] }), 'sophab'), null);
  assert.equal(chainFor({}, 'studio', bead({ assignee: 'aria' })), null);
  assert.equal(chainFor({ relays: {} }, 'studio', bead({ assignee: 'aria' })), null);
});

await check('an assignee that is a person, an email or nothing never relays', () => {
  for (const who of ['', 'adam', 'neadamthal@gmail.com', 'beadcause', 'Aria Smith']) {
    assert.equal(line(bead({ assignee: who, labels: ['dept:story'] })), null, `assignee ${JSON.stringify(who)}`);
  }
});

await check('a relay definition with no departments is not a relay', () => {
  assert.equal(relayFor({ relays: { studio: { filer: 'ward' } } }, 'studio'), null);
  assert.equal(relayFor({ relays: { studio: { departments: {} } } }, 'studio'), null);
  assert.equal(relayFor(CFG, ''), null);
});

/* --------------------------------------------------- 2. the chain, and its shape */

await check('the chain is draft, checks, revise, file — in that order', () => {
  const c = chainFor(CFG, 'studio', bead({ assignee: 'aria', labels: ['dept:story'] }));
  assert.deepEqual(
    c.steps.map((s) => [s.step, s.role]),
    [
      ['draft', 'aria'],
      ['check', 'clio'],
      ['check', 'muse'],
      ['revise', 'aria'],
      ['file', 'ward'],
    ]
  );
  assert.equal(chainLine(c), 'aria → clio → muse → aria → ward');
  assert.equal(c.dept, 'dept:story');
  assert.equal(c.department, 'Story');
  assert.equal(c.lead, 'script');
  assert.equal(c.role, 'aria');
  assert.equal(c.filer, 'ward');
  assert.deepEqual(c.packet, ['needs-approval', 'human']);
});

await check('an agent does not check its own draft', () => {
  // clio is the fact check for Story *and* a Story member. Drafting, it is checked by muse
  // alone — the step it would otherwise occupy is the revise step it already gets.
  assert.equal(line(bead({ assignee: 'clio', labels: ['dept:story'] })), 'clio → muse → clio → ward');
  assert.equal(line(bead({ assignee: 'muse', labels: ['dept:story'] })), 'muse → clio → muse → ward');
});

await check('a department with no checks gets no revise step', () => {
  const c = chainFor(CFG, 'studio', bead({ assignee: 'solon', labels: ['dept:solo'] }));
  assert.deepEqual(
    c.steps.map((s) => [s.step, s.role]),
    [
      ['draft', 'solon'],
      ['file', 'ward'],
    ]
  );
});

await check('a checker staffed by another department still checks', () => {
  assert.equal(line(bead({ assignee: 'mien', labels: ['dept:design'] })), 'mien → clio → palette → mien → ward');
});

await check('a definition with no filer ends at the revise', () => {
  const noFiler = { relays: { studio: { ...CFG.relays.studio, filer: '' } } };
  assert.equal(line(bead({ assignee: 'aria', labels: ['dept:story'] }), 'studio', noFiler), 'aria → clio → muse → aria');
});

/* ------------------------------------------------------------- 3. executive */

await check('an executive role gets no relay, including the filer itself', () => {
  for (const who of ['vox', 'tally', 'ward']) {
    assert.equal(line(bead({ assignee: who, labels: ['dept:story'] })), null, `assignee ${who}`);
  }
  // …and `ward` is a role the definition knows, which is the whole reason this can go
  // wrong: it is the filer at the end of every chain, so it is in `rolesOf`.
  assert.ok(rolesOf(CFG.relays.studio).has('ward'));
  assert.equal(roleOf(CFG.relays.studio, bead({ assignee: 'ward' })), 'ward');
});

/* ------------------------------------------------------- 4. which department */

await check('the dept: label wins over the roster', () => {
  // clio is staffed by Story. Labelled Design, the bead is Design work — and the chain is
  // Design's, with palette on look, which Story's chain would never have added.
  assert.equal(line(bead({ assignee: 'clio', labels: ['dept:design'] })), 'clio → palette → clio → ward');
  assert.equal(departmentOf(CFG.relays.studio, bead({ labels: ['dept:design'] }), 'clio').key, 'dept:design');
});

await check('an unlabelled bead falls back to the department that staffs the role', () => {
  assert.equal(line(bead({ assignee: 'aria' })), 'aria → clio → muse → aria → ward');
  assert.equal(line(bead({ assignee: 'carta' })), 'carta → clio → palette → carta → ward');
});

await check('a role no department staffs and no label places gets no relay', () => {
  // `sage` is in the shipped studio but not in this fixture's roster at all.
  assert.equal(line(bead({ assignee: 'sage' })), null);
  assert.equal(departmentOf(CFG.relays.studio, bead(), 'nobody'), null);
});

await check('the assignee is matched case- and space-insensitively', () => {
  assert.equal(line(bead({ assignee: '  ARIA  ', labels: ['dept:story'] })), 'aria → clio → muse → aria → ward');
});

await check('profilePath fills the role into the template, and answers empty for none', () => {
  const c = chainFor(CFG, 'studio', bead({ assignee: 'aria', labels: ['dept:story'] }));
  assert.equal(profilePath(c, 'clio'), 'ai-context/agents/clio/clio.md');
  assert.equal(profilePath({ profile: '' }, 'clio'), '');
  assert.equal(profilePath(c, ''), '');
});

/* --------------------------------------------------------------- 5. the brief */

const BEAD = { id: 'dv-1', title: 'Chapter 7 opens on the harbour' };
const PR = { autoMerge: true };
const plain = workPromptFor('studio', BEAD, 1, PR, 'Adam', {});
const relayed = workPromptFor('studio', BEAD, 1, PR, 'Adam', {
  relay: chainFor(CFG, 'studio', bead({ assignee: 'aria', labels: ['dept:story'] })),
});

await check('a brief with no relay is byte-for-byte what it was', () => {
  // The point of the whole assertion: not that the section is absent, but that a brief
  // built with `relay: null` and one built with the option left off are the same string.
  assert.equal(workPromptFor('studio', BEAD, 1, PR, 'Adam', { relay: null }), plain);
  assert.equal(workPromptFor('studio', BEAD, 1, PR, 'Adam', { relay: { steps: [] } }), plain);
  assert.ok(!plain.includes('This window is a relay'));
});

await check('the relayed brief is the plain one with one section added', () => {
  const cut = relayed.indexOf('**This window is a relay');
  const end = relayed.indexOf('\nStart:');
  assert.ok(cut > 0 && end > cut, 'the section is between the opening and `Start:`');
  assert.equal(relayed.slice(0, cut) + relayed.slice(end + 1), plain.slice(0, cut) + plain.slice(plain.indexOf('\nStart:') + 1));
});

await check('the brief names every step, in order, with its profile', () => {
  for (const [i, role] of ['aria', 'clio', 'muse', 'aria', 'ward'].entries()) {
    assert.ok(relayed.includes(`${i + 1}. `), `step ${i + 1}`);
    assert.ok(relayed.includes(`ai-context/agents/${role}/${role}.md`), `profile for ${role}`);
  }
  const order = ['1. draft', '2. check', '3. check', '4. revise', '5. file'];
  let at = -1;
  for (const step of order) {
    const found = relayed.indexOf(step);
    assert.ok(found > at, `${step} out of order`);
    at = found;
  }
});

await check('the brief says the assignee is a role and not a person', () => {
  assert.ok(/is a role in the Story department rather than a person/.test(relayed));
});

await check('the brief tells it to read the contract documents', () => {
  assert.ok(relayed.includes('docs/STUDIO_CHARTER.md'));
  assert.ok(relayed.includes('docs/APPROVAL_PIPELINE.md'));
});

await check('the brief asks for a handoff line on the bead at every step', () => {
  assert.ok(relayed.includes('bd comment dv-1 "<role> → <next role>'));
});

await check('the packet is a bead of its own, and nothing here closes it', () => {
  // `bin/ask.js` is in every brief already (the "a fact only Adam has" ending), so the
  // assertion has to be on the packet's own sentence rather than on the command.
  assert.ok(relayed.includes('file the packet as its **own** bead'));
  assert.ok(relayed.includes('bd label add <the-new-id> needs-approval'));
  assert.ok(relayed.includes('bd label add <the-new-id> human'));
  assert.ok(/Its own bead and not \\?`dv-1\\?`/.test(relayed));
  assert.ok(/you do not close the packet, and you do not close a gate/.test(relayed));
});

await check('the hand-back names the next role, which is the whole resume mechanism', () => {
  assert.ok(relayed.includes('bd update dv-1 --status open --assignee <the role that should run next>'));
  assert.ok(/`--claim` overwrote it/.test(relayed));
});

await check('a relay with no filer says nothing about a packet', () => {
  const noFiler = { relays: { studio: { ...CFG.relays.studio, filer: '' } } };
  const text = workPromptFor('studio', BEAD, 1, PR, 'Adam', {
    relay: chainFor(noFiler, 'studio', bead({ assignee: 'aria', labels: ['dept:story'] })),
  });
  assert.ok(text.includes('This window is a relay'));
  assert.ok(!text.includes('file the packet as its **own** bead'), 'no filer, no packet section');
  assert.ok(!text.includes('bd label add <the-new-id>'), 'no filer, no packet labels');
  // The hand-back is not part of the packet section and must survive without it.
  assert.ok(text.includes('--assignee <the role that should run next>'));
});

/* ------------------------------------------------------- 6. the shipped config */

await check('the shipped deluvia relay is a real relay', async () => {
  const { loadConfig } = await import(LIB('config.js'));
  // `loadConfig` merges the defaults over whatever is on this Mac; the entry under test is
  // a default, so this passes on a machine that has never heard of deluvia.
  const cfg = loadConfig();
  const c = chainFor(cfg, 'deluvia', bead({ assignee: 'aria', labels: ['dept:story'] }));
  assert.ok(c, 'deluvia relays');
  assert.equal(chainLine(c), 'aria → clio → muse → aria → ward');
  assert.equal(profilePath(c, 'aria'), 'ai-context/agents/aria/aria.md');
  assert.deepEqual(c.packet, ['needs-approval', 'human']);
  // Every producing department in `docs/STUDIO_CHARTER.md` §3, and each one's chain ends
  // at the filer. A department whose `check` list went missing would still produce a
  // chain — of two — which is exactly the failure a length assertion catches and a
  // truthiness one does not.
  const def = relayFor(cfg, 'deluvia');
  const depts = Object.keys(def.departments);
  assert.deepEqual(depts, ['dept:story', 'dept:design', 'dept:board', 'dept:post', 'dept:mktg']);
  for (const key of depts) {
    const lead = def.departments[key].lead;
    const chain = chainFor(cfg, 'deluvia', bead({ assignee: lead, labels: [key] }));
    assert.ok(chain, `${key} lead ${lead} relays`);
    assert.ok(chain.steps.length >= 4, `${key} runs ${chainLine(chain)}`);
    assert.equal(chain.steps.at(-1).role, 'ward');
    assert.equal(chain.steps.at(-1).step, 'file');
  }
  // And the one that must not: Executive.
  for (const who of ['vox', 'tally', 'ward']) {
    assert.equal(chainFor(cfg, 'deluvia', bead({ assignee: who })), null, who);
  }
});

console.log(`\n${ran - failures}/${ran} checks passed\n`);
process.exit(failures ? 1 : 0);
