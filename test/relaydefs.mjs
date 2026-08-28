#!/usr/bin/env node
/**
 * lib/relaydefs.js — a repo's own relay definition, read and selected.
 *
 *     npm test
 *     node test/relaydefs.mjs
 *
 * Two modules under test and one question behind both: *where may a definition come
 * from, and what may it say*. So what has to hold is mostly about refusing:
 *
 * 1. **A repo that defines nothing is unchanged.** No `.beadcause/` is every repo today,
 *    and the answer has to be the answer `cfg` alone gives, for one cost — a single
 *    failed `statSync`, no read, no parse, no readdir. The advocate asks this per
 *    checkout every 30s.
 * 2. **The empty file and the absent file are opposite answers, one typo apart.**
 *    `relays: {}` is a definition — the only off switch a repo has — and replaces `cfg`
 *    entirely. No file at all falls through to `cfg`. Both are asserted, because a
 *    module that got these the same way round would look right in every other check.
 * 3. **The allow-list refuses, and names what it refused.** An unknown key takes the
 *    whole file down rather than being skipped: a typo'd `deparments:` quietly ignored is
 *    a repo dispatching with no departments at all, which reads as working.
 * 4. **`packet:` and an unprefixed department key are refusals.** Both are the authority
 *    line rather than tidiness — the first files approvals that never reach the phone,
 *    the second captures every bead in the checkout carrying a common label.
 * 5. **An unknown `relay:` name and an ambiguous department are problems, not
 *    fallbacks.** Falling back is how marketing work quietly dispatches as engineering.
 * 6. **Nothing throws.** A refused file is a bead dispatching as it does today plus a
 *    sentence; there is no input here that is allowed to be an exception.
 *
 * 7. **deluvia's real definition survives the move, both ways** (bc-ogicx.8). Sections 1-6
 *    are the module's own contract and every definition in them is synthetic. This last one
 *    is the migration's: the five departments `cfg.relays.deluvia` ships are carried in as
 *    an in-repo fixture, and each of the five chains has to come out *identical* from the
 *    file and from the config — packet included, which is the assertion the whole
 *    whole-definition-replacement design turns on.
 *
 * ## Where bc-ogicx.9's criteria are actually asserted
 *
 * bc-ogicx.9 is the epic's test bead and its description lists nine acceptance criteria.
 * Seven of them were delivered by the beads it was gated behind rather than by a suite
 * written under its own name, so this index is the record — by **check name** and not by
 * line number, because line numbers rot and a check's name is what the runner prints:
 *
 * - *chainFor is null with no file and no cfg.relays* — test/relay.mjs, "a workspace with no
 *   relay entry never relays"; here, "no .beadcause/ at all is the absent answer, and never
 *   a definition".
 * - *the brief is byte-for-byte what it is today* — test/relay.mjs, "a brief with no relay is
 *   byte-for-byte what it was"; test/relaywiring.mjs, "a workspace with no relay anywhere
 *   gets no relay section at all".
 * - *the existing test/relay.mjs run unedited* — true and provable rather than built: `git
 *   log` says that file has been touched exactly once ever, by bc-ogicx.4's own pull request.
 * - *a file wins over cfg, whole-definition* — here, "the off switch replaces cfg entirely;
 *   the absent file falls through to it"; test/relaywiring.mjs, "a definition replaces the
 *   config whole — the config's roles do not survive it".
 * - *`relays: {}` and an absent file are opposite answers* — here, all of section 2.
 * - *unparseable / unknown key / `packet:` / an unprefixed department key* — here, sections
 *   3 and 4.
 * - *selection order, an unknown `relay:` name, an ambiguous department* — here, section 5.
 * - *capacity* — test/deptqueue.mjs, delivered by bc-ogicx.6: "two Story beads, capacity 1",
 *   "a second department is untouched by the first being full", "the department comes from
 *   the graph — a queue row has no assignee to read", and "a tracker that will not answer
 *   means no cap, never an empty one".
 * - *the endorsement gate is unmoved* — test/relaywiring.mjs section 5, which is the one
 *   criterion nothing in this repo covered until bc-ogicx.9 was finished.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chainFor, chainIn, chainLine, PACKET, profilePath } from '../lib/relay.js';
import { RELAY_DIR, forgetRelayDefs, relayDefFor, relaysIn } from '../lib/relaydefs.js';
import { cleanupTmp } from './helpers/tmp.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-relaydefs-'));

let failures = 0;
let ran = 0;
function check(name, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(String(err?.stack || err).split('\n').slice(0, 6).join('\n'));
  }
}

let seq = 0;
/** A checkout with the given file contents under `.beadcause/`, or with no `.beadcause/`. */
function checkout(files = null) {
  seq += 1;
  const dir = path.join(tmp, `repo-${seq}`);
  fs.mkdirSync(dir, { recursive: true });
  if (files) {
    fs.mkdirSync(path.join(dir, RELAY_DIR), { recursive: true });
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, RELAY_DIR, name), body);
  }
  forgetRelayDefs();
  return dir;
}

const STUDIO = `
relays:
  story:
    profile: ai-context/agents/{role}/{role}.md
    docs: [docs/STUDIO_CHARTER.md]
    filer: ward
    executive: [vox, ward]
    departments:
      dept:story:
        name: Story
        lead: script
        members: [lore, aria, script, clio, muse]
        check: [clio, muse]
  design:
    filer: ward
    departments:
      dept:design:
        name: Design
        lead: palette
        members: [palette, mien]
        check: [clio]
default: story
`;

/** The config side: one relay, keyed by workspace, exactly as it is today. */
const CFG = {
  relays: {
    deluvia: {
      profile: 'ai-context/agents/{role}/{role}.md',
      filer: 'ward',
      packet: ['needs-approval', 'human'],
      executive: ['vox', 'tally', 'ward'],
      departments: {
        'dept:story': { name: 'Story', lead: 'script', members: ['aria', 'clio', 'muse'], check: ['clio', 'muse'] },
      },
    },
  },
};

const bead = (over = {}) => ({ id: 'dv-1', labels: [], assignee: '', ...over });

/* --------------------------------------------------- 1. a repo that defines nothing */

check('no .beadcause/ at all is the absent answer, and never a definition', () => {
  const read = relaysIn(checkout());
  assert.equal(read.defined, false, 'absent is not a definition');
  assert.deepEqual(read.relays, {});
  assert.equal(read.default, null);
  assert.equal(read.problem, null);
  assert.equal(read.file, null);
});

check('the absent answer costs one failed stat — no read, no readdir', () => {
  const dir = checkout();
  const realStat = fs.statSync;
  const realRead = fs.readFileSync;
  const realDir = fs.readdirSync;
  const stats = [];
  fs.statSync = (...args) => { stats.push(args[0]); return realStat(...args); };
  fs.readFileSync = () => { throw new Error('read a file for a checkout that has no .beadcause/'); };
  fs.readdirSync = () => { throw new Error('listed a directory instead of naming the file'); };
  try {
    relaysIn(dir);
  } finally {
    fs.statSync = realStat;
    fs.readFileSync = realRead;
    fs.readdirSync = realDir;
  }
  assert.equal(stats.length, 1, `one stat, got ${stats.length}: ${stats.join(', ')}`);
  assert.equal(stats[0], path.join(dir, RELAY_DIR));
});

check('a bad directory, an empty name and a missing one are all the absent answer', () => {
  for (const dir of ['', null, undefined, path.join(tmp, 'no-such-checkout')]) {
    const read = relaysIn(dir);
    assert.equal(read.defined, false, String(dir));
    assert.equal(read.problem, null, String(dir));
  }
});

/* ------------------------------------------- 2. the empty file and the absent file */

check('an empty relays: {} IS a definition — a repo\'s only off switch', () => {
  const read = relaysIn(checkout({ 'relays.yaml': 'relays: {}\n' }));
  assert.equal(read.defined, true, 'a file that parses and validates is a definition');
  assert.deepEqual(read.relays, {});
  assert.equal(read.problem, null);
});

check('a blank file, and a bare relays:, are definitions too and declare no relays', () => {
  for (const body of ['\n# nothing here yet\n', 'relays:\n', 'relays:\n# and a default nobody wrote\n']) {
    const read = relaysIn(checkout({ 'relays.yaml': body }));
    assert.equal(read.defined, true, JSON.stringify(body));
    assert.deepEqual(read.relays, {}, JSON.stringify(body));
  }
});

check('the off switch replaces cfg entirely; the absent file falls through to it', () => {
  const off = relayDefFor(CFG, 'deluvia', checkout({ 'relays.yaml': 'relays: {}\n' }), bead({ assignee: 'aria' }));
  assert.equal(off.def, null, 'an empty definition means no relay here');
  assert.equal(off.problem, null, 'and it is not a problem — it is an answer');

  const absent = relayDefFor(CFG, 'deluvia', checkout(), bead({ assignee: 'aria' }));
  assert.ok(absent.def, 'no file falls through to cfg');
  assert.equal(absent.key, null, 'the cfg wrap is the unnamed relay');
  assert.deepEqual(Object.keys(absent.def.departments), ['dept:story']);
});

/* ------------------------------------------------------ 3. the allow-list refuses */

check('an unknown top-level key refuses the whole file and names it', () => {
  const read = relaysIn(checkout({ 'relays.yaml': 'relays: {}\nsystems: {}\n' }));
  assert.equal(read.defined, false, 'a refused file is not a definition');
  assert.match(read.problem, /unknown key "systems"/);
  assert.match(read.problem, /relays\.yaml/);
});

check('a typo\'d deparments: refuses rather than dispatching with no departments', () => {
  const read = relaysIn(checkout({ 'relays.yaml': 'relays:\n  story:\n    deparments:\n      dept:story: {}\n' }));
  assert.equal(read.defined, false);
  assert.match(read.problem, /unknown key "deparments"/);
});

check('a file that does not parse is refused with the parser\'s own sentence', () => {
  const read = relaysIn(checkout({ 'relays.yaml': 'relays:\n  story: [unclosed\n' }));
  assert.equal(read.defined, false);
  assert.match(read.problem, /does not parse/);
});

check('a refused file falls back to cfg AND says so', () => {
  const got = relayDefFor(CFG, 'deluvia', checkout({ 'relays.yaml': 'nonsense: true\n' }), bead({ assignee: 'aria' }));
  assert.ok(got.def, 'the bead still dispatches — a definition problem is not a hold');
  assert.equal(got.key, null, 'off the cfg wrap');
  assert.match(got.problem, /unknown key "nonsense"/);
});

check('a wrongly-typed value is refused, naming the relay and the key', () => {
  for (const [body, pattern] of [
    ['relays:\n  story:\n    docs: nope\n    departments:\n      dept:story: {}\n', /docs: is not a list/],
    ['relays:\n  story:\n    departments: []\n', /declares no departments/],
    ['relays:\n  story:\n    departments:\n      dept:story:\n        capacity: many\n', /capacity: is not a whole number/],
    ['relays:\n  story:\n    departments:\n      dept:story:\n        members: nope\n', /members: is not a list/],
    ['relays: {}\ndefault: story\n', /default: names "story"/],
  ]) {
    const read = relaysIn(checkout({ 'relays.yaml': body }));
    assert.equal(read.defined, false, body);
    assert.match(read.problem, pattern, body);
  }
});

/* ------------------------------------ 4. packet and the dept: prefix, the authority line */

check('packet: in a repo file is a refusal, with the reason in the sentence', () => {
  const read = relaysIn(checkout({
    'relays.yaml': 'relays:\n  story:\n    packet: [needs-approval]\n    departments:\n      dept:story:\n        members: [aria]\n',
  }));
  assert.equal(read.defined, false, 'a repo may not restate the packet');
  assert.match(read.problem, /packet:/);
  assert.match(read.problem, /lock screen/, 'the sentence says why, not just that');
});

check('a department key without dept: is a refusal — it would capture every such bead', () => {
  const read = relaysIn(checkout({
    'relays.yaml': 'relays:\n  story:\n    departments:\n      agent-filed:\n        members: [aria]\n',
  }));
  assert.equal(read.defined, false);
  assert.match(read.problem, /"agent-filed"/);
  assert.match(read.problem, /dept:/);
});

check('a repo-defined relay never gets a packet from the definition — it gets PACKET', () => {
  const got = relayDefFor({}, 'sophab', checkout({ 'relays.yaml': STUDIO }), bead({ labels: ['dept:story'] }));
  assert.ok(got.def);
  const chain = chainIn(got.def, 'sophab', bead({ assignee: 'aria', labels: ['dept:story'] }));
  assert.deepEqual(chain.packet, PACKET, 'the pair that makes the packet answerable from a phone');
  assert.equal(chainLine(chain), 'aria → clio → muse → aria → ward');
});

/* ------------------------------------------------------------- 5. the selection rule */

check('1. a relay: label picks the relay it names', () => {
  const dir = checkout({ 'relays.yaml': STUDIO });
  const got = relayDefFor({}, 'sophab', dir, bead({ labels: ['relay:design'], assignee: 'aria' }));
  assert.equal(got.key, 'design', 'the label wins over the roster that staffs aria');
  assert.equal(got.problem, null);
});

check('an unknown relay: name is a problem, not a fallback', () => {
  const dir = checkout({ 'relays.yaml': STUDIO });
  const got = relayDefFor({}, 'sophab', dir, bead({ labels: ['relay:marketing'], assignee: 'aria' }));
  assert.equal(got.def, null, 'no relay rather than the wrong one');
  assert.match(got.problem, /relay:marketing/);
  assert.match(got.problem, /story/, 'and it lists what there is');
});

check('an unknown relay: name over a cfg-only definition is a problem too', () => {
  const got = relayDefFor(CFG, 'deluvia', checkout(), bead({ labels: ['relay:story'], assignee: 'aria' }));
  assert.equal(got.def, null);
  assert.match(got.problem, /relay:story/);
});

check('2. the department label picks the relay that declares it', () => {
  const dir = checkout({ 'relays.yaml': STUDIO });
  const got = relayDefFor({}, 'sophab', dir, bead({ labels: ['dept:design'] }));
  assert.equal(got.key, 'design');
  assert.equal(got.problem, null);
});

check('a department two relays declare is a problem naming both', () => {
  const dir = checkout({
    'relays.yaml': 'relays:\n  a:\n    departments:\n      dept:story:\n        members: [aria]\n  b:\n    departments:\n      dept:story:\n        members: [lore]\n',
  });
  const got = relayDefFor({}, 'sophab', dir, bead({ labels: ['dept:story'] }));
  assert.equal(got.def, null, 'ambiguity is refused rather than guessed');
  assert.match(got.problem, /dept:story/);
  assert.match(got.problem, /a, b/);
});

check('3. the relay that staffs the assignee, where the bead said nothing', () => {
  const dir = checkout({ 'relays.yaml': STUDIO });
  assert.equal(relayDefFor({}, 'sophab', dir, bead({ assignee: 'mien' })).key, 'design');
  assert.equal(relayDefFor({}, 'sophab', dir, bead({ assignee: 'lore' })).key, 'story');
});

check('an assignee two relays staff is a problem naming both', () => {
  const dir = checkout({
    'relays.yaml': 'relays:\n  a:\n    departments:\n      dept:one:\n        members: [clio]\n  b:\n    departments:\n      dept:two:\n        members: [clio]\n',
  });
  const got = relayDefFor({}, 'sophab', dir, bead({ assignee: 'clio' }));
  assert.equal(got.def, null);
  assert.match(got.problem, /"clio"/);
  assert.match(got.problem, /a, b/);
});

check('4. the file\'s default, when nothing on the bead answered', () => {
  const got = relayDefFor({}, 'sophab', checkout({ 'relays.yaml': STUDIO }), bead({ assignee: 'nobody@example.com' }));
  assert.equal(got.key, 'story', 'default: story');
});

check('5. nothing — a file with relays but no default and no match', () => {
  const dir = checkout({ 'relays.yaml': STUDIO.replace('default: story\n', '') });
  const got = relayDefFor({}, 'sophab', dir, bead({ assignee: 'nobody@example.com' }));
  assert.equal(got.def, null);
  assert.equal(got.problem, null, 'no relay is an answer, not a problem');
});

check('the order is label, then department, then roster — each overruling the next', () => {
  const dir = checkout({ 'relays.yaml': STUDIO });
  // aria is staffed by story; the label and then the department each take precedence.
  assert.equal(relayDefFor({}, 'sophab', dir, bead({ assignee: 'aria' })).key, 'story');
  assert.equal(relayDefFor({}, 'sophab', dir, bead({ assignee: 'aria', labels: ['dept:design'] })).key, 'design');
  assert.equal(relayDefFor({}, 'sophab', dir, bead({ assignee: 'aria', labels: ['dept:design', 'relay:story'] })).key, 'story');
});

/* ---------------------------------------------------------- 6. .json, cache, no throw */

check('relays.json is accepted, and relays.yaml wins where both exist', () => {
  const only = relaysIn(checkout({ 'relays.json': JSON.stringify({ relays: { j: { departments: { 'dept:j': { members: ['jo'] } } } } }) }));
  assert.equal(only.defined, true, '.json is a definition');
  assert.deepEqual(Object.keys(only.relays), ['j']);

  const both = relaysIn(checkout({ 'relays.yaml': STUDIO, 'relays.json': '{"relays":{"j":{}}}' }));
  assert.deepEqual(Object.keys(both.relays), ['story', 'design'], 'yaml is the one named first');
});

check('a second read of an unchanged file costs no parse', () => {
  const dir = checkout({ 'relays.yaml': STUDIO });
  const first = relaysIn(dir);
  const realRead = fs.readFileSync;
  fs.readFileSync = () => { throw new Error('re-read an unchanged file'); };
  let second;
  try {
    second = relaysIn(dir);
  } finally {
    fs.readFileSync = realRead;
  }
  assert.equal(second, first, 'the very same object, off the cache');
});

check('a rewritten file is re-read', () => {
  const dir = checkout({ 'relays.yaml': STUDIO });
  assert.deepEqual(Object.keys(relaysIn(dir).relays), ['story', 'design']);
  const file = path.join(dir, RELAY_DIR, 'relays.yaml');
  fs.writeFileSync(file, 'relays: {}\n');
  // mtime granularity on some filesystems is coarser than this test is fast.
  const later = new Date(Date.now() + 2000);
  fs.utimesSync(file, later, later);
  assert.deepEqual(Object.keys(relaysIn(dir).relays), [], 'the new file, not the cached one');
});

check('nothing here throws, whatever the file says', () => {
  for (const body of ['', '[]', 'null', '- 1\n- 2\n', 'relays: 7\n', 'relays:\n  "": {}\n', '\u0000']) {
    assert.doesNotThrow(() => {
      const read = relaysIn(checkout({ 'relays.yaml': body }));
      relayDefFor(CFG, 'deluvia', path.dirname(path.dirname(read.file || path.join(tmp, 'x', 'y'))), bead());
    }, JSON.stringify(body));
  }
});

/* ------------------------------ 7. deluvia, carried in as a fixture, proved both ways */

/**
 * deluvia's five departments in the **in-repo file shape**, holding exactly what
 * `cfg.relays.deluvia` states — minus `packet:`, which a repo may not set and which the
 * check below is largely about.
 *
 * This is the one fixture in this file that is not invented. Everything above proves what
 * `lib/relaydefs.js` does with a definition somebody made up for the occasion; the only
 * definition that has to survive the move intact is the one already in service, and until
 * this section the shipped `cfg.relays.deluvia` entry was asserted against nothing at all.
 * (The `deluvia` name elsewhere in this file is a workspace *label* over a synthetic `CFG`
 * two departments smaller than the real one.)
 *
 * Named `studio` because a file holds *named* relays where `cfg` holds one per workspace —
 * which is the one thing about the two shapes that is not a rename, and the reason the
 * comparison below is `chainIn` against `chainFor` rather than one object against another.
 */
const DELUVIA_FIXTURE = `
relays:
  studio:
    profile: ai-context/agents/{role}/{role}.md
    profiles:
      herald: .claude/agents/herald.md
    docs: [docs/STUDIO_CHARTER.md, docs/APPROVAL_PIPELINE.md]
    filer: ward
    executive: [vox, tally, ward]
    departments:
      dept:story:
        name: Story
        lead: script
        members: [lore, aria, script, clio, muse]
        check: [clio, muse]
      dept:design:
        name: Design
        lead: palette
        members: [palette, mien, carta]
        check: [clio, palette]
      dept:board:
        name: Board and Camera
        lead: frame
        members: [frame, panel, lens]
        check: [clio, lens, palette]
      dept:post:
        name: Post
        lead: splice
        members: [splice, timbre, cadence]
        check: [clio, lens]
      dept:mktg:
        name: Outward
        lead: herald
        members: [herald, sage]
        check: [clio, palette]
default: studio
`;

/**
 * The **shipped** config, not one written here — `loadConfig()` against an empty config
 * directory is `defaults()`, which is the `relays.deluvia` block in lib/config.js and the
 * thing the fixture claims to be equal to. A copy of that block pasted into this file would
 * make the whole section circular.
 *
 * Imported dynamically, and after `BEADCAUSE_CONFIG_DIR` is pointed inside `tmp`, because
 * `CONFIG_DIR` resolves once at module load: a static import would read the real config on
 * this Mac and write to it. Nothing above this line loads lib/config.js — lib/relay.js
 * imports nothing and lib/relaydefs.js imports only `yaml` and lib/relay.js — and the
 * assertion after the import is what says so out loud if that ever stops being true.
 */
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
const { CONFIG_DIR, loadConfig } = await import('../lib/config.js');
const shippedCfg = (() => {
  const said = console.log;
  // `loadConfig` announces the config it writes; one line per suite run is noise here.
  console.log = () => {};
  try {
    return loadConfig();
  } finally {
    console.log = said;
  }
})();

check('the shipped config is read from this suite’s own directory, never from the Mac’s', () => {
  assert.equal(CONFIG_DIR, path.join(tmp, 'config'), 'lib/config.js was loaded before the env var was set');
});

/**
 * A deluvia bead in one department, carrying that department's routing label and assigned
 * to its lead — the shape `APPROVAL_PIPELINE.md` describes, and the only bead shape this
 * section needs. The lead comes off the shipped config rather than being typed here, so a
 * department that is renamed cannot leave a check quietly asserting about nobody.
 */
const beadFor = (key) =>
  bead({ id: `dv-${key.slice(5)}`, labels: [key], assignee: shippedCfg.relays.deluvia.departments[key].lead });

check('the fixture states exactly what cfg.relays.deluvia states, minus the packet', () => {
  const read = relaysIn(checkout({ 'relays.yaml': DELUVIA_FIXTURE }));
  assert.equal(read.problem, null, 'the real definition does not survive the repo file validator');
  assert.equal(read.defined, true);
  const { packet, ...withoutPacket } = shippedCfg.relays.deluvia;
  assert.deepEqual(packet, PACKET, 'the shipped entry no longer states the pair this proof is about');
  // The whole of the fixture against the whole of the config entry, so that an edit to
  // either one that is not made to the other fails here rather than silently proving that
  // two stale definitions agree.
  assert.deepEqual(read.relays.studio, withoutPacket);
});

check('all five departments chain identically from the file and from cfg, packet included', () => {
  const dir = checkout({ 'relays.yaml': DELUVIA_FIXTURE });
  const expected = {
    'dept:story': 'script → clio → muse → script → ward',
    'dept:design': 'palette → clio → palette → ward',
    'dept:board': 'frame → clio → lens → palette → frame → ward',
    'dept:post': 'splice → clio → lens → splice → ward',
    'dept:mktg': 'herald → clio → palette → herald → ward',
  };
  const keys = Object.keys(shippedCfg.relays.deluvia.departments);
  assert.deepEqual(keys, Object.keys(expected), 'the shipped relay gained or lost a department');
  for (const key of keys) {
    const bead = beadFor(key);
    const fromFile = chainIn(relayDefFor({}, 'deluvia', dir, bead).def, 'deluvia', bead);
    const fromCfg = chainFor(shippedCfg, 'deluvia', bead);
    assert.ok(fromFile, `${key} got no chain from the file`);
    // The whole chain object, not a summary of it: steps, lead, filer, profile, profiles,
    // docs and packet. `packet` is the one that would go missing quietly — a file may not
    // state it, so it can only come from the PACKET constant, and a chain that lost it
    // files a review packet with no `needs-approval`/`human` pair and raises nothing.
    assert.deepEqual(fromFile, fromCfg, `${key} chains differently from the file and from cfg`);
    assert.deepEqual(fromFile.packet, PACKET, `${key} lost the pair that reaches a lock screen`);
    assert.equal(chainLine(fromFile), expected[key]);
  }
});

check('the department comes off the label or off the roster — identically, either way', () => {
  const dir = checkout({ 'relays.yaml': DELUVIA_FIXTURE });
  for (const key of Object.keys(shippedCfg.relays.deluvia.departments)) {
    // The same bead with its routing label taken off: every one of these five leads is
    // staffed by the department it leads, so the roster has to answer the same way.
    const bead = { ...beadFor(key), labels: [] };
    const fromFile = chainIn(relayDefFor({}, 'deluvia', dir, bead).def, 'deluvia', bead);
    assert.deepEqual(fromFile, chainFor(shippedCfg, 'deluvia', bead), `${key} unlabelled`);
    assert.equal(fromFile.dept, key, `${key} was routed somewhere else by its roster`);
  }
});

check('herald keeps the one profile the template does not reach, from either side', () => {
  const dir = checkout({ 'relays.yaml': DELUVIA_FIXTURE });
  const bead = beadFor('dept:mktg');
  const fromFile = chainIn(relayDefFor({}, 'deluvia', dir, bead).def, 'deluvia', bead);
  const fromCfg = chainFor(shippedCfg, 'deluvia', bead);
  // charter §10: eighteen agents are under the template and herald is a Claude Code
  // subagent living somewhere else. A path in a brief that resolves to nothing is worse
  // than no path, so the override is part of the definition and has to travel with it.
  assert.equal(profilePath(fromFile, 'herald'), '.claude/agents/herald.md');
  assert.equal(profilePath(fromFile, 'herald'), profilePath(fromCfg, 'herald'));
  assert.equal(profilePath(fromFile, 'clio'), 'ai-context/agents/clio/clio.md');
  assert.equal(profilePath(fromFile, 'clio'), profilePath(fromCfg, 'clio'));
});

check('executive is no relay from the file either — vox, tally and ward all get null', () => {
  const dir = checkout({ 'relays.yaml': DELUVIA_FIXTURE });
  for (const role of shippedCfg.relays.deluvia.executive) {
    const who = bead({ assignee: role });
    assert.equal(chainIn(relayDefFor({}, 'deluvia', dir, who).def, 'deluvia', who), null, role);
    assert.equal(chainFor(shippedCfg, 'deluvia', who), null, role);
  }
});

await cleanupTmp(tmp);

console.log(`\n${ran - failures}/${ran} checks passed\n`);
process.exit(failures ? 1 : 0);
