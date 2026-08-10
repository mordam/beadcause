#!/usr/bin/env node
/**
 * "Yes, I am still working on it."
 *
 *   beadcause-checkin -w sophab -i sp-abc -m "rebasing onto main, then the tests"
 *
 * The answer to a ** BEADCAUSE CHECK-IN ** message. An advocate that has been asked
 * to reclaim its slots says that line into each of its open sessions and then waits;
 * running this is how a session says "still here" and keeps its slot. Say nothing and
 * the slot goes back to the queue after `advocates.checkinMinutes`. The other honest
 * answer is to finish — do the ** BEAD WORK DONE ** steps from the brief and exit —
 * and that needs no command at all, because exiting is already the signal.
 *
 * A file rather than an HTTP call, and the same file the done marker is: the reply
 * comes minutes after the question, from a process the daemon does not own, possibly
 * across a restart of the daemon. Nothing has to be listening for a file to arrive.
 * See `checkinFileFor` in lib/advocate.js — imported rather than recomputed, because a
 * check-in written a directory away from where it is read is the worst failure
 * available here: the session answered, and lost its slot anyway.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { writeJsonAtomic } from '../lib/atomic.js';
import { checkinFileFor } from '../lib/advocate.js';

function arg(...names) {
  for (const n of names) {
    const i = process.argv.indexOf(n);
    if (i > -1) return process.argv[i + 1];
  }
  return undefined;
}

const cfg = loadConfig();
const wsName = arg('--workspace', '-w');
const id = arg('--issue', '-i');
const note = arg('--message', '-m') || '';

const ws = cfg.workspaces.find((w) => w.name === wsName);
if (!ws || !id) {
  console.error('usage: beadcause-checkin -w <workspace> -i <issue-id> [-m "what you are doing"]');
  console.error(`workspaces: ${cfg.workspaces.map((w) => w.name).join(', ')}`);
  process.exit(1);
}

const file = checkinFileFor(ws.name, id);
fs.mkdirSync(path.dirname(file), { recursive: true });
// The timestamp is the whole payload: the advocate compares it against when it asked,
// so a check-in older than the question correctly fails to answer it.
writeJsonAtomic(file, { at: new Date().toISOString(), note });

console.log(`checked in on ${ws.name}/${id}${note ? ` — ${note}` : ''}`);
