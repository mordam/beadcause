#!/usr/bin/env node
/**
 * The management system's switch, as the one thing that can throw it.
 *
 *   beadcause-management status                  is it on, since when, and who said so
 *   beadcause-management on --reason "…"         turn it on, recorded
 *   beadcause-management off --reason "…"        turn it off, recorded — and readable as a gap
 *   beadcause-management history [<n>]           the transitions, newest first
 *   beadcause-management windows                 the same record as periods
 *   beadcause-management coverage --from … --to … was it on for the whole of a window
 *   beadcause-management verify                  does the chain hold together
 *
 * **There is deliberately no config key and no HTTP route that writes this.** The whole
 * argument is in lib/management.js: a layer that can be switched off by editing a file is
 * not a control, so the only writer is a person at a terminal who has to say why, and
 * what they say becomes the commit message an auditor reads. A daemon that could disable
 * its own gates is the failure this shape exists to prevent, which is why the daemon does
 * not import the writers at all.
 *
 * `--reason` is required on `on` and on `off`, and the refusal is the point rather than
 * an inconvenience — see the note above `setManagement`.
 */
import {
  MANAGEMENT_REF,
  coverage,
  disable,
  enable,
  history,
  recordLocation,
  state,
  verify,
  windows,
} from '../lib/management.js';

const [verb, ...rest] = process.argv.slice(2);

const die = (msg) => {
  console.error(msg);
  process.exit(1);
};

/** `--flag value` out of the tail, so the reason can be a sentence with spaces in it. */
function flag(name) {
  const i = rest.indexOf(`--${name}`);
  if (i >= 0) return rest[i + 1] ?? '';
  const inline = rest.find((a) => a.startsWith(`--${name}=`));
  return inline === undefined ? null : inline.slice(name.length + 3);
}

const when = (iso) => (iso ? iso.replace('T', ' ').replace(/\..*$/, 'Z') : 'never');

const USAGE = [
  'beadcause-management status',
  'beadcause-management on --reason "why"  [--bead <id>]',
  'beadcause-management off --reason "why" [--bead <id>]',
  'beadcause-management history [<n>]',
  'beadcause-management windows',
  'beadcause-management coverage [--from <iso>] [--to <iso>]',
  'beadcause-management verify',
].join('\n');

async function main() {
  if (!verb || verb === '--help' || verb === '-h') {
    console.log(USAGE);
    return;
  }

  if (verb === 'status') {
    const s = await state();
    if (!s.on && !s.seq) {
      // The ordinary install, and it should read as ordinary rather than as a warning.
      console.log('management system: off (never enabled)');
      console.log(`nothing compliance-related runs here. ${recordLocation()} holds the record when there is one.`);
      return;
    }
    console.log(`management system: ${s.on ? 'on' : 'off'} since ${when(s.since)}`);
    console.log(`${s.on ? 'enabled' : 'disabled'} by ${s.by}${s.bead ? ` (${s.bead})` : ''}: ${s.reason}`);
    console.log(`transition ${s.seq} on ${MANAGEMENT_REF}`);
    return;
  }

  if (verb === 'on' || verb === 'off') {
    const reason = flag('reason');
    if (!reason) die(`beadcause-management ${verb} --reason "why" — the reason is what the record is for`);
    const bead = flag('bead') || null;
    const res = await (verb === 'on' ? enable : disable)({ reason, bead });
    if (!res.changed) {
      console.log(`already ${verb} since ${when(res.state.since)} — nothing recorded`);
      return;
    }
    console.log(`management system ${verb} — transition ${res.state.seq} recorded on ${MANAGEMENT_REF}`);
    return;
  }

  if (verb === 'history') {
    const limit = Number(rest[0]) > 0 ? Number(rest[0]) : 50;
    const rows = await history({ limit });
    if (!rows.length) {
      console.log('no transitions — the management system has never been enabled here');
      return;
    }
    for (const r of rows) console.log(`${when(r.at)}  ${r.subject}`);
    return;
  }

  if (verb === 'windows') {
    for (const w of await windows()) {
      const span = `${when(w.from)} → ${w.to ? when(w.to) : 'now'}`;
      const why = w.implicit ? '(default — never enabled)' : `${w.by}: ${w.reason}`;
      console.log(`${w.on ? 'ON ' : 'OFF'}  ${span}  ${why}`);
    }
    return;
  }

  if (verb === 'coverage') {
    const c = await coverage({ from: flag('from'), to: flag('to') });
    console.log(`${when(c.from)} → ${when(c.to)}: ${c.complete ? 'covered' : `${c.gaps.length} gap${c.gaps.length === 1 ? '' : 's'}`}`);
    for (const g of c.gaps) {
      const why = g.implicit ? '(not yet enabled)' : `${g.by}: ${g.reason}`;
      console.log(`  gap ${when(g.from)} → ${when(g.to)}  ${why}`);
    }
    if (!c.complete) process.exitCode = 1;
    return;
  }

  if (verb === 'verify') {
    const v = await verify();
    console.log(`${v.commits} commit${v.commits === 1 ? '' : 's'}, ${v.transitions} transition${v.transitions === 1 ? '' : 's'}: ${v.ok ? 'consistent' : 'INCONSISTENT'}`);
    for (const p of v.problems) console.log(`  ${p}`);
    if (!v.ok) process.exitCode = 1;
    return;
  }

  die(`unknown command: ${verb}\n\n${USAGE}`);
}

main().catch((err) => die(err.message));
