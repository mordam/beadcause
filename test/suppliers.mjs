#!/usr/bin/env node
//
// Nothing leaves this Mac for a third party the register does not name — `lib/suppliers.js`.
//
//   npm test
//   node test/suppliers.mjs
//
// bc-eqn1.9: the auditable question about a supplier is always the same four — what is
// sent, why, under what terms, and when was that last looked at. A register answers them
// once. What keeps the answer true is this: sweep the tree for outbound hosts and for the
// commands that are actually executed, and fail the repo on one no supplier claims. A new
// integration then cannot ship without its supplier entry, which is the control operating
// rather than being described. scripts/secret-scan.mjs is the precedent and makes the
// argument — a guard is a promise about the future, and this is the question about what is
// already there.
//
// The finding that shaped the sweep, and the reason there are two axes rather than one:
// **Anthropic is not a host.** Nothing here calls an Anthropic URL; every agent is a
// `claude -p` subprocess. A sweep for `https://` reports a clean tree while prompt content,
// bead text, whole source files and screenshots leave the machine, which is the largest
// egress in the system by a wide margin. So commands are swept too — and by execution
// shape rather than by word, because this repo writes prose inside template literals and
// the bare token `claude` appears in fifteen files that mostly just explain what a session
// is.
//
// The checks below are in three groups: the register is well-formed and every rule in it
// can be shown to fail; the sweep finds what is really there and reports an unclaimed host
// or command; and the two exemptions — the register's own citations, and the operating
// system's own binaries — are each closed rather than left as a hole.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NEVER_LOCAL,
  NOT_EGRESS,
  NOT_SWEPT,
  REGISTER,
  SCAN_DIRS,
  claimsHost,
  commandsIn,
  egressProblems,
  entryProblems,
  hostsIn,
  registerProblems,
  scan,
} from '../lib/suppliers.js';
import { REGISTER as DOCUMENTS } from '../lib/documents.js';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-suppliers-'));

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message.split('\n').join('\n      ')}`);
  }
}

/** A tree with one lib file in it, for pointing the sweep at something it has not seen. */
function fixture(source, name = 'thing.js') {
  const root = fs.mkdtempSync(path.join(tmp, 'tree-'));
  fs.mkdirSync(path.join(root, 'lib'));
  fs.writeFileSync(path.join(root, 'lib', name), source);
  return root;
}

/** A well-formed supplier, to be broken one field at a time. */
const sound = () => ({
  id: 'a-supplier',
  name: 'A Supplier',
  purpose: 'They receive something, for a reason that is written out here in a whole sentence.',
  sends: ['the thing that is sent'],
  hosts: ['a-supplier.example.com'],
  commands: [],
  reachedBy: ['lib/suppliers.js'],
  terms: 'Their published terms of service, as they apply to the account this install uses.',
  termsUrl: 'https://a-supplier.example.com/terms',
  termsConfirmedOn: '2026-08-15',
  retention: 'They keep it for a stated period, which somebody has read and written down here.',
  training: 'Not applicable — no content of any kind reaches them, only an identifier.',
  reviewedOn: '2026-08-15',
  reviewMonths: 12,
  gap: null,
});

console.log('supplier and third-party register\n');

/* ------------------------------------------------------------- the register */

await check('the register is well-formed, and no supplier review is overdue', () => {
  const { problems } = registerProblems(ROOT);
  assert.deepEqual(problems, [], `${problems.length} problem(s):\n${problems.join('\n')}`);
});

await check('every supplier this system actually has is in it', () => {
  const ids = REGISTER.map((e) => e.id);
  for (const id of ['anthropic', 'github', 'atlassian', 'google', 'tailscale', 'ntfy', 'slack']) {
    assert.ok(ids.includes(id), `${id} receives something from this system and is not in the register`);
  }
});

await check('Anthropic is registered as a command, because that is what it is', () => {
  const anthropic = REGISTER.find((e) => e.id === 'anthropic');
  assert.deepEqual(anthropic.hosts, [], 'nothing here calls an Anthropic URL — a host entry would be fiction');
  assert.ok(anthropic.commands.includes('claude'), 'every agent is a `claude -p` subprocess and that is the whole egress');
  assert.ok(
    anthropic.sends.some((s) => /screenshot/i.test(s)) && anthropic.sends.some((s) => /contents of any repository file/i.test(s)),
    'and what leaves is stated at the granularity somebody could object to'
  );
  assert.equal(anthropic.reviewMonths, 6, 'reviewed twice as often as the rest, because its terms are the ones that matter most');
});

await check('the register is itself a controlled document, rather than a second format beside one', () => {
  assert.ok(
    DOCUMENTS.some((d) => d.path === 'lib/suppliers.js'),
    'a register with no owner and no review date is the thing bc-eqn1.11 exists to stop'
  );
});

await check('every module named as reaching a supplier is still in the repo', () => {
  for (const e of REGISTER) for (const rel of e.reachedBy) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${e.id}: reachedBy names ${rel}, which is not there`);
  }
});

/* -------------------------------------------------------- the rules, proved */

await check('a sound supplier has nothing wrong with it', () => {
  assert.deepEqual(entryProblems(sound()), []);
});

await check('each of the four auditable questions can be shown to fail', () => {
  const fires = (patch, re) => {
    const problems = entryProblems({ ...sound(), ...patch });
    assert.ok(problems.some((p) => re.test(p)), `${JSON.stringify(patch)} produced ${JSON.stringify(problems)}`);
  };

  fires({ id: 'Not Kebab' }, /kebab-case/);
  fires({ name: '' }, /`name`/);
  fires({ purpose: 'because' }, /`purpose`/);
  fires({ sends: [] }, /first question an auditor asks/);
  fires({ hosts: [], commands: [] }, /nothing here reaches it/);
  fires({ hosts: ['not a hostname'] }, /is not a hostname/);
  fires({ reachedBy: [] }, /`reachedBy`/);
  fires({ terms: 'their terms' }, /`terms`/);
  fires({ termsUrl: 'ask them' }, /`termsUrl`/);
  fires({ retention: 'a while' }, /`retention`/);
  fires({ training: '' }, /blank is not/);
  fires({ reviewedOn: 'recently' }, /real date/);
  fires({ reviewMonths: 36 }, /between 1 and/);
});

await check('a supplier whose terms nobody has read must say so, and name the bead', () => {
  const unread = entryProblems({ ...sound(), termsConfirmedOn: null, gap: null });
  assert.ok(unread.some((p) => /a guess reads identically to an answer/.test(p)), unread.join('\n'));

  assert.deepEqual(
    entryProblems({ ...sound(), termsConfirmedOn: null, gap: { bead: 'bc-eqn1.9', says: 'nobody has read the agreement in force yet' } }),
    [],
    'and it is answered by naming the bead rather than by inventing a date'
  );

  const wrong = entryProblems({ ...sound(), termsConfirmedOn: null, gap: { bead: 'TECH-1234', says: 'nobody has read the agreement in force yet' } });
  assert.ok(wrong.some((p) => /`gap.bead`/.test(p)), 'and the bead has to be a bead');
});

await check('every entry in the real register carries the gap it owes, because none of the terms are confirmed', () => {
  for (const e of REGISTER) {
    if (e.termsConfirmedOn === null) {
      assert.ok(e.gap?.bead, `${e.id}: unconfirmed terms and no bead saying so`);
    }
  }
});

await check('a supplier review that has passed fails the repo', () => {
  const { problems } = registerProblems(ROOT, new Date('2029-01-01T12:00:00Z'));
  const overdue = problems.filter((p) => /supplier review was due/.test(p));
  assert.equal(overdue.length, REGISTER.length, `${overdue.length} of ${REGISTER.length}`);
});

/* --------------------------------------------------------------- the sweep */

await check('the sweep finds the hosts that are really there, and not the ones in the prose', () => {
  const { hosts } = scan(ROOT);
  for (const h of ['accounts.google.com', 'oauth2.googleapis.com', 'github.com', 'login.tailscale.com', 'ntfy.sh', 'slack.com']) {
    assert.ok(hosts.has(h), `${h} is reached from lib/ and the sweep did not find it`);
  }
  assert.ok(!hosts.has('api.anthropic.com'), 'and it does not find one that is only ever written in a comment');
});

await check('the sweep finds the commands that are really executed', () => {
  const { commands } = scan(ROOT);
  assert.ok(commands.has('claude'), 'the largest egress in the system');
  assert.ok(commands.has('gh'));
  assert.ok(commands.has('git'));
});

await check('a comment naming a host is not a host, which is the wrong answer available to this scan', () => {
  assert.deepEqual(hostsIn('// we deliberately never call https://evil.example.com\nconst x = 1;'), []);
  assert.deepEqual(hostsIn('/* https://evil.example.com */\nconst x = 1;'), []);
  assert.deepEqual(hostsIn('const u = "https://real.example.com/x";'), ['real.example.com']);
});

await check('an interpolated host has no static text and is dropped rather than guessed at', () => {
  assert.deepEqual(hostsIn('const u = `https://${site}.atlassian.net/rest`;'), []);
  assert.deepEqual(hostsIn('const u = `https://api.${domain}/v1`;'), [], 'and a fragment left behind by one is not a host either');
});

await check('a command is an execution, not a word — which is why the scan is worth reading', () => {
  assert.deepEqual(commandsIn('// an agent is a claude -p subprocess, explained at length'), []);
  assert.deepEqual(commandsIn('const help = `run claude yourself to see it`;'), [], 'prose inside a template literal is still prose');
  assert.deepEqual(commandsIn("spawn('claude', args);"), ['claude']);
  assert.deepEqual(commandsIn("execFileSync('gh', ['pr', 'view']);"), ['gh']);
  assert.deepEqual(commandsIn('const cmd = `exec claude -p --model opus`;'), ['claude'], 'the shape an agent actually launches in');

  // RegExp.prototype.exec is written all over lib/, so `exec(` is deliberately not one of
  // the call shapes — a scan that took it would report a subprocess called `literal`.
  assert.deepEqual(commandsIn("const m = /gh-(\\d+)/.exec('literal');"), []);
});

/* -------------------------------------------------- the sweep, made to fail */

await check('a new host nothing claims fails the repo, and the message says how to fix it', () => {
  // A fixture tree has none of the real exemptions in it, so it is swept against an empty
  // NOT_EGRESS — otherwise every one of them reports itself as stale and buries the finding.
  const root = fixture('const u = "https://api.newvendor.example.com/v1";');
  const problems = egressProblems(root, REGISTER, []);
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /api\.newvendor\.example\.com is reached from lib\/thing\.js/);
  assert.match(problems[0], /no supplier claims it/);
  assert.match(problems[0], /NOT_EGRESS/, 'and offers the other answer, because not every host is a supplier');
});

await check('a new subprocess nothing claims fails the repo too', () => {
  const root = fixture("import { spawn } from 'node:child_process';\nspawn('somevendor-cli', ['sync']);");
  const problems = egressProblems(root, REGISTER, []);
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /`somevendor-cli` is executed from lib\/thing\.js/);
});

await check('a registered host passes, exactly or by the suffix a per-install hostname needs', () => {
  assert.equal(egressProblems(fixture('const u = "https://ntfy.sh/topic";'), REGISTER, []).length, 0);
  assert.equal(
    egressProblems(fixture('const u = "https://yourteam.atlassian.net/wiki";'), REGISTER, []).length,
    0,
    "the site is the operator's, so the entry is a pattern"
  );

  const atlassian = REGISTER.find((e) => e.id === 'atlassian');
  assert.ok(claimsHost(atlassian, 'anything.atlassian.net'));
  assert.ok(!claimsHost(atlassian, 'atlassian.net.evil.example'), 'and a suffix pattern is a suffix, not a substring');
});

/* ---------------------------------------------------------- the exemptions */

await check("the operating system's own binaries are exempt structurally, rather than eight times over", () => {
  const root = fixture(
    "import { execFileSync } from 'node:child_process';\n" +
      "execFileSync('/usr/bin/osascript', []);\nexecFileSync('/bin/zsh', []);\nexecFileSync('/usr/bin/id', []);"
  );
  assert.deepEqual(egressProblems(root, REGISTER, []), []);
});

await check('and that exemption is not a hole — a networked binary in the same directory is still egress', () => {
  // /usr/bin/curl lives exactly where /usr/bin/id lives and does something entirely
  // different. Without NEVER_LOCAL, "it is under /usr/bin" would have been enough to
  // send anything anywhere with nothing to say about it.
  for (const bin of NEVER_LOCAL) {
    const problems = egressProblems(fixture(`import { execFileSync } from 'node:child_process';\nexecFileSync('/usr/bin/${bin}', []);`), REGISTER, []);
    assert.equal(problems.length, 1, `/usr/bin/${bin} was let through: ${problems.join('\n')}`);
  }
  assert.ok(NEVER_LOCAL.includes('curl') && NEVER_LOCAL.includes('ssh'), 'the two that would actually happen');
});

await check('an exemption that matches nothing is a sentence excusing nothing, and fails', () => {
  const root = fixture('const x = 1;');
  const problems = egressProblems(root, [], [{ what: 'gone.example.com', kind: 'host', why: 'it used to be here and is not any more' }]);
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /no longer finds/);
});

await check('every exemption in the real list says why, and still matches something', () => {
  for (const x of NOT_EGRESS) {
    assert.ok(['host', 'command'].includes(x.kind), `${x.what}: kind must say which axis it exempts`);
    assert.ok(x.why.trim().length >= 30, `${x.what}: an exemption without an argument is a waiver`);
  }
  assert.deepEqual(egressProblems(ROOT), [], 'which the real sweep already proved, and this says out loud');
});

await check('the register is kept out of its own sweep, and the reason is pinned', () => {
  // Every termsUrl in the register is a host. Left in the sweep it reports itself as five
  // unregistered suppliers — the check finding its own documentation, arriving through a
  // field rather than through a paragraph. The exemption is only safe while this file
  // stays data, so its imports are pinned: anything that could make a request has to come
  // through here first.
  assert.equal(NOT_SWEPT, 'lib/suppliers.js');
  const source = fs.readFileSync(path.join(ROOT, NOT_SWEPT), 'utf8');
  const imports = [...source.matchAll(/^import [^;]*? from '([^']+)';$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(
    imports,
    ['./documents.js', './evidence.js', 'node:fs', 'node:path'],
    'lib/suppliers.js gained an import. It is exempt from the egress sweep because it is data — if it is not data any more, that exemption has to be argued again rather than inherited.'
  );
  assert.ok(SCAN_DIRS.includes('lib') && SCAN_DIRS.includes('bin'));
});

await cleanupTmp(tmp);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
