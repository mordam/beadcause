#!/usr/bin/env node
/**
 * What this deployment can back up, and whether an interval may be claimed.
 *
 *   beadcause-attest posture [--json]              what this deployment observes about itself
 *   beadcause-attest record  [--instance <token>]  that posture as a record for the chain
 *   beadcause-attest verify <file|-> [--from <t>] [--to <t>] [--json]
 *
 * **`verify` is the half that has to exist for somebody who is not us.** bc-3muu.9 puts
 * the daemon on the customer's hardware, and an auditor standing in front of it cannot be
 * asked to accept a verdict computed by the vendor of the thing being audited. So it
 * takes an export of published records — a JSON array, or one record per line — and
 * nothing else: no network, no service, no repository, no config directory, no content.
 * It computes exactly what the daemon computes, with lib/posture.js's `report`, which is
 * the only way the two answers cannot quietly diverge.
 *
 * `posture` and `record` are the local half, for the operator. Both go and look; neither
 * takes a value, and there is deliberately no flag that says what the answer should be.
 *
 * **Neither of them writes, and `record` prints rather than publishes on purpose.** The
 * publisher is `recordPosture` in lib/publication.js, which appends the same fields to the
 * chain alongside the head they back. It is not called from here because reaching the chain
 * means creating the common repository, and an attestation that altered what it was
 * attesting would be measuring itself — the same reason this file creates nothing at all,
 * stated in its lib/evidence.js exemption.
 *
 * Expect `unverified` today, from any install. Nothing submits an anchor yet (bc-3muu.14)
 * and a git ref in a directory its operator owns is enforced by the application rather than
 * by the store. That is the honest reading, and the reading this command exists to make
 * hard to avoid.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR } from '../lib/config.js';
import { attest, observe, render, report, unbacked, verdictOf } from '../lib/posture.js';
import { now } from '../lib/publishable.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const [verb, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? null : rest[i + 1] ?? null;
};
const has = (name) => rest.includes(`--${name}`);
const die = (msg) => {
  console.error(msg);
  process.exit(1);
};

/**
 * This install's posture.
 *
 * The checkout is the one this file is in rather than anything configured, because the
 * question `provenance` answers is "is the code that is running the code it says it is"
 * and only the running file knows where it came from. The store is the config directory,
 * which is where every chained ref lives.
 */
const observeHere = () => observe({ cwd: root, store: CONFIG_DIR });

if (verb === 'posture') {
  const p = await observeHere();
  const at = now();
  if (has('json')) {
    console.log(JSON.stringify({ at, posture: p, verdict: verdictOf(p, { at }), why: unbacked(p, { at }) }, null, 2));
  } else {
    for (const [k, v] of Object.entries(p)) console.log(`  ${k.padEnd(11)} ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    console.log(`\n${verdictOf(p, { at }).toUpperCase()}`);
    for (const line of unbacked(p, { at })) console.log(`  · ${line}`);
  }
  process.exit(0);
}

if (verb === 'record') {
  const p = await observeHere();
  // Always a genesis record, and it says so by its seq. Reading the previous record off
  // the chain would mean opening the common repository, which this command may not do —
  // what links a posture onto a chain is `recordPosture` in lib/publication.js, and this
  // one is for looking at the posture rather than for publishing it.
  console.log(JSON.stringify(attest(null, p, { instance: flag('instance') || 'unenrolled' }), null, 2));
  process.exit(0);
}

if (verb === 'verify') {
  const file = rest.find((a) => !a.startsWith('--')) || null;
  if (!file) die('beadcause-attest verify <file|-> — an export of published records, or - for stdin');
  let text;
  try {
    text = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
  } catch (err) {
    die(`cannot read ${file}: ${err.message}`);
  }

  // A JSON array or one record per line, because an export is written by whoever is
  // exporting and refusing the other shape would be a verifier that only reads its own
  // output — which is a verifier an auditor cannot use.
  let records;
  const trimmed = text.trim();
  try {
    records = trimmed.startsWith('[')
      ? JSON.parse(trimmed)
      : trimmed
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => JSON.parse(l));
  } catch (err) {
    die(`${file} is not an export of published records: ${err.message}`);
  }
  if (!Array.isArray(records)) die(`${file} is not an export of published records: expected an array`);

  const rep = report(records, { from: flag('from'), to: flag('to') });
  if (has('json')) console.log(JSON.stringify(rep, null, 2));
  else console.log(render(rep).join('\n'));
  process.exit(rep.verdict === 'verified' ? 0 : 2);
}

die(
  [
    'beadcause-attest posture [--json]              what this deployment observes about itself',
    'beadcause-attest record  [--instance <token>]  that posture as a record for the chain',
    'beadcause-attest verify <file|-> [--from <t>] [--to <t>] [--json]',
    '',
    'verify exits 0 when the interval may be claimed and 2 when it may not.',
  ].join('\n')
);
