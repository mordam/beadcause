#!/usr/bin/env node
/**
 * Print the access register — every principal, human and agent, and what revokes it.
 *
 *   beadcause-access [--json] [--review]
 *
 * The one command to answer an auditor's version of CC6.1: who could reach production in
 * the period, on whose authority, and what would have taken it away. It reads live config
 * and live state, so what it prints is what is true now rather than what somebody wrote
 * down once — see lib/access.js for why the roster half is derived and the credential
 * half is closed.
 *
 * **Exit 1 when the periodic access review is overdue**, and only then. That is the same
 * condition test/access.mjs fails on, deliberately: a control needs to be checkable from
 * a terminal by a person and from the gate by a machine, and two conditions that could
 * drift apart would be two controls. `--review` prints just that line, for a cron or a
 * check that does not want the whole register. Exit 2 is a bad invocation.
 */
import { loadConfig, loadState } from '../lib/config.js';
import { register, reviewState, reviewLine, CREDENTIALS, JML } from '../lib/access.js';

const USAGE = 'usage: beadcause-access [--json] [--review]';

let json = false;
let reviewOnly = false;
for (const a of process.argv.slice(2)) {
  if (a === '--json') json = true;
  else if (a === '--review') reviewOnly = true;
  else if (a === '--help' || a === '-h') {
    console.log(USAGE);
    process.exit(0);
  } else {
    console.error(`access: unknown argument ${a}\n${USAGE}`);
    process.exit(2);
  }
}

const cfg = loadConfig();
const state = loadState();

if (reviewOnly) {
  const review = reviewState();
  if (json) console.log(JSON.stringify(review, null, 2));
  else console.log(reviewLine(review));
  process.exit(review.overdue ? 1 : 0);
}

const reg = register(cfg, state);

if (json) {
  console.log(JSON.stringify(reg, null, 2));
  process.exit(reg.review.overdue ? 1 : 0);
}

const rule = (t) => `\n${t}\n${'─'.repeat(t.length)}`;

console.log(`Access register · ${reg.generatedAt}`);
console.log(reviewLine(reg.review));

console.log(rule('Principals'));
for (const p of reg.principals) {
  console.log(`\n  ${p.id}  [${p.kind}]`);
  console.log(`    ${p.name}`);
  if (p.what) console.log(`    what    ${p.what}`);
  console.log(`    reaches ${p.reaches}`);
  if (p.writes) console.log(`    writes  ${p.writes}`);
  if (p.mayRun) console.log(`    may run ${p.mayRun}`);
  if (p.inTransit) console.log(`    wire    ${p.inTransit}`);
  console.log(`    granted ${p.grant}`);
  console.log(`    revoke  ${p.revoke}`);
}

console.log(rule('Credentials'));
for (const c of CREDENTIALS) {
  console.log(`\n  ${c.id}`);
  console.log(`    ${c.what}`);
  console.log(`    where   ${c.where}`);
  console.log(`    holder  ${c.holder}`);
  console.log(`    scope   ${c.scope}`);
  console.log(`    revoke  ${c.revoke}`);
}

console.log(rule('Joiner'));
for (const s of JML.joiner) console.log(`  · ${s}`);
console.log(rule('Mover'));
for (const s of JML.mover) console.log(`  · ${s}`);
console.log(rule('Leaver'));
for (const s of JML.leaver) console.log(`  · ${s.act}  (${s.credential})`);

process.exit(reg.review.overdue ? 1 : 0);
