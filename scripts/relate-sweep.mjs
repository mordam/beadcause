#!/usr/bin/env node
/**
 * The sweep half of bc-arj0.4 — every bead id already written in prose, given an edge.
 *
 *   npm run relate -- -w beadcause              # what it would draw, and nothing else
 *   npm run relate -- -w beadcause --apply      # draw it
 *   npm run relate -- -w beadcause --no-comments
 *
 * The write-time hook in lib/bd.js catches prose from here on. This is the other pass:
 * 850 beads that were already written, holding **1,633** references to each other and,
 * on the day this was built, **two** see-also edges in the entire graph. Everything an
 * agent needs to start fast was in those paragraphs — "the same defect as bc-767a", "see
 * also bc-rcrt", "sits in bc-42ow's neighbourhood" — and none of it was reachable by `bd
 * show`, `bd dep tree`, the graph page or a dispatch brief. The first run over this
 * workspace plans 1,308 pairs across 554 beads.
 *
 * **Dry by default, and the dry run is the review.** It prints every pair it would draw,
 * grouped by bead, and writes nothing at all. `--apply` is the only thing that writes.
 * A sweep over a shared tracker is not something to find out about afterwards.
 *
 * **Why bulk `bd dep add --file` and not `bd dep relate` per pair.** Measured here, a
 * `bd dep relate` is about 1.5 seconds of spawn plus write; 1,300 pairs of them is over
 * half an hour, nearly all of it process startup. `--file` takes newline-delimited
 * `{from, to, type}` and writes at about a quarter-second a row with no per-pair spawn.
 * The catch is that bulk wiring **validates the whole batch and rejects every line of it**
 * if one line names a deleted id or duplicates an edge of another type — so the filtering
 * in lib/mentions.js is not tidiness here, it is the difference between 1,300 edges and
 * none. Chunking is the belt to those braces; see `CHUNK`.
 *
 * Either way this is ten to fifteen minutes of intermittently holding Dolt's single
 * writer on a laptop running twenty agent sessions, which is the other half of why it
 * does not write unless it is asked to.
 *
 * **Both directions, written out.** `bd dep relate` stores two rows, one at each end, and
 * that is what makes the edge the same word from either side. A sweep that wrote one row
 * per pair would leave half of them visible only from the bead that did the mentioning —
 * which is the side that already knew.
 *
 * Exit codes: 0 when it swept (or would have), 1 on a bad invocation, 4 when at least one
 * chunk was refused. A partial failure still reports what landed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { Bd } from '../lib/bd.js';
import { proseOf, planFor, edgeRows, MENTION_CAP } from '../lib/mentions.js';

function arg(...names) {
  for (const n of names) {
    const i = process.argv.indexOf(n);
    if (i > -1) return process.argv[i + 1];
  }
  return undefined;
}
const has = (n) => process.argv.includes(n);
const say = (msg) => console.error(`relate-sweep: ${msg}`);

/**
 * How many `{from,to}` rows go in one `bd dep add --file` — a hundred, and the number is
 * measured rather than round.
 *
 * bd writes these at about a quarter of a second a row, whatever the batch size:
 * 400 rows took **100s** on an idle scratch workspace here and **121s** on a loaded one,
 * and `--no-cycle-check` made no difference at all, so the cost is the write and not the
 * checking. `BD_TIMEOUT` is 120 seconds and a `bd` killed at the ceiling is a write torn
 * in half, which is the one outcome worth engineering against — so a chunk is sized to
 * clear it several times over on a bad afternoon. 100 rows is 18s under the load of a
 * full `npm test`.
 *
 * It is also the blast radius. Bulk wiring rejects the whole batch over one bad line, so
 * a surprise costs fifty pairs and the sweep carries on.
 */
const CHUNK = 100;

/** Comment reads that may be in flight at once — reads, so they do not queue on the writer. */
const READERS = 6;

const cfg = loadConfig();
const wsName = arg('--workspace', '-w');
const ws = cfg.workspaces.find((w) => w.name === wsName);
if (!ws || has('--help') || has('-h')) {
  console.error('usage: relate-sweep -w <workspace> [--apply] [--no-comments] [--cap N]');
  console.error(`workspaces: ${cfg.workspaces.map((w) => w.name).join(', ')}`);
  process.exit(1);
}

const apply = has('--apply');
const withComments = !has('--no-comments');
const cap = Number(arg('--cap')) > 0 ? Number(arg('--cap')) : MENTION_CAP;
const bd = new Bd({ bin: cfg.bdBin, actor: cfg.actor, sharedServer: cfg.sharedServer, me: cfg.me });

/**
 * Run `jobs` a few at a time, in order, and keep every answer.
 *
 * Five hundred `bd comments` calls one after another is four minutes of doing nothing;
 * five hundred at once is a laptop with five hundred processes on it. Six is enough to
 * saturate the read path and few enough that a machine already running twenty sessions
 * does not notice.
 */
async function pool(items, worker, width = READERS) {
  const out = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, run));
  return out;
}

/**
 * Every pair the graph already joins, in both directions, off the one export.
 *
 * This has to be global rather than per-row, and that is the trap the first version of
 * this fell into: bd stores a `parent-child` edge on the **child**, so an epic's own
 * export row lists none of its children and looks unlinked to every one of them. bc-xl7n
 * — the catch-all root with 87 children — planned sixty-nine see-alsos to beads it
 * already parents, until the pairs were collected from both ends of every row instead of
 * from the row being asked about.
 */
function linkedPairs(rows) {
  const pairs = new Set();
  const neighbours = new Map();
  const join = (a, b) => {
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    neighbours.get(a).add(b);
  };
  for (const row of rows) {
    for (const dep of row?.dependencies || []) {
      const a = String(dep?.issue_id || row.id || '').toLowerCase();
      const b = String(dep?.depends_on_id || dep?.id || '').toLowerCase();
      if (!a || !b || a === b) continue;
      pairs.add([a, b].sort().join('|'));
      join(a, b);
      join(b, a);
    }
  }
  return { pairs, neighbours };
}

async function main() {
  say(`reading ${ws.name}…`);
  const dump = await bd.run(ws, ['export']);
  const rows = dump
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((r) => r && r.id);
  if (!rows.length) {
    say('the export named no beads — refusing to call that a clean sweep');
    process.exit(4);
  }

  const known = new Set(rows.map((r) => String(r.id).toLowerCase()));
  const { pairs: joined, neighbours } = linkedPairs(rows);
  say(`${rows.length} beads, ${joined.size} pairs already joined`);

  /**
   * Comments, which the export does not carry — and the expensive half of this.
   *
   * `comment_count` is on the export row, so only the beads that have any are asked
   * about: 507 of 850 here, and they are worth 270 pairs the descriptions alone do not
   * name. The rest cost nothing. `--no-comments` drops this entirely
   * and makes the whole sweep a single `bd export`, which is the right shape when what
   * you want is a fast look at what descriptions alone would draw.
   */
  const threads = new Map();
  if (withComments) {
    const chatty = rows.filter((r) => (r.comment_count || 0) > 0);
    say(`reading comments on ${chatty.length} beads…`);
    await pool(chatty, async (r) => {
      const comments = await bd.comments(ws, r.id);
      if (comments.length) threads.set(r.id, comments);
    });
  }

  const plans = [];
  let capped = 0;
  for (const row of rows) {
    const id = String(row.id).toLowerCase();
    const linked = neighbours.get(id) || new Set();
    const prose = proseOf(row, threads.get(row.id) || []);
    const to = planFor({ id, prose, linked, known, cap });
    if (to.length >= cap) capped++;
    if (to.length) plans.push({ id, to });
  }

  // Undirected, because two beads that mention each other are one edge and writing the
  // pair twice would put four rows where bd wants two.
  const seen = new Set();
  const wanted = [];
  for (const { id, to } of plans) {
    for (const other of to) {
      const key = [id, other].sort().join('|');
      if (seen.has(key) || joined.has(key)) continue;
      seen.add(key);
      wanted.push([id, other]);
    }
  }

  for (const { id, to } of plans) console.log(`${id}  ↔  ${to.join(' ')}`);
  say(`${wanted.length} new pairs across ${plans.length} beads${capped ? `, ${capped} at the ${cap} cap` : ''}`);

  if (!wanted.length) return 0;
  if (!apply) {
    say('dry run — nothing written. Re-run with --apply.');
    return 0;
  }

  const lines = wanted.flatMap(([a, b]) => edgeRows(a, [b])).map((r) => JSON.stringify(r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relate-sweep-'));
  let failed = 0;
  try {
    for (let i = 0; i < lines.length; i += CHUNK) {
      const slice = lines.slice(i, i + CHUNK);
      const file = path.join(dir, `chunk-${i}.jsonl`);
      fs.writeFileSync(file, `${slice.join('\n')}\n`);
      try {
        await bd.run(ws, ['dep', 'add', '--file', file], { retries: 4 });
        say(`wrote ${slice.length / 2} pairs (${i / 2 + slice.length / 2}/${wanted.length})`);
      } catch (err) {
        failed += slice.length / 2;
        // Named rather than swallowed: a refused chunk is the one thing about this run
        // worth acting on, and bd's message says which line and why.
        say(`chunk at ${i} refused, ${slice.length / 2} pairs not drawn: ${err.message}`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  say(`done — ${wanted.length - failed} pairs drawn${failed ? `, ${failed} refused` : ''}`);
  return failed ? 4 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    say(err?.message || String(err));
    process.exit(4);
  }
);
