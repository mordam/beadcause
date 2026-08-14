#!/usr/bin/env node
/**
 * The requirement graph as something a person and an agent can both reach: a command.
 *
 *   beadcause-requirements corpus [<token>]     what requirements exist, and where
 *   beadcause-requirements show <id>            one requirement, and every file that carries it
 *   beadcause-requirements files <path...>      the reverse lookup — what these files carry
 *   beadcause-requirements coverage             how much of the corpus has any edge at all
 *   beadcause-requirements rebuild [<repo>]     rebuild the index from that repo's git notes
 *   beadcause-requirements promote <workspace> <bead>   apply an approved candidate
 *
 * An agent here is a `claude -p` with Bash and an allowlist and no way to `import`
 * anything, so every module under lib/ is invisible to it until something like this
 * exists — the argument lib/memory.js makes at length about capabilities nobody was told
 * about. `files` is the one an agent has most use for and is why this exists at all: the
 * brief pushes the likely answer, and this is how it asks for the rest.
 *
 * **`rebuild` is the repair, and it is also the proof.** The index is a cache of the git
 * notes (lib/reqindex.js); running this over a correct index changes nothing, and running
 * it over a damaged one restores it. If those two ever diverge, the notes are right.
 *
 * **`promote` is the only thing here that writes outside beadcause.** It applies a
 * candidate into the architecture repo after a human has said yes, and it refuses on its
 * own if the id already exists or the token does not. Nothing about it is automatic: the
 * daemon files the question, a person answers it, and then somebody runs this.
 */
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { Bd } from '../lib/bd.js';
import { corpusDir, loadCorpus, requirement } from '../lib/requirements.js';
import { edgesFor, edgesForFiles, everything, rebuildFrom } from '../lib/reqindex.js';
import { coverage, describeCoverage } from '../lib/reqcoverage.js';
import { readRequirements, withRequirements } from '../lib/beadreqs.js';
import { applyPromotion, promotionFor } from '../lib/reqpromote.js';
import { resolveSessionDir } from '../lib/session.js';

const [verb, ...rest] = process.argv.slice(2);
const cfg = loadConfig();

const die = (msg) => {
  console.error(msg);
  process.exit(1);
};

/**
 * Where the corpus is, given every repo this install has been told about.
 *
 * Every workspace rather than one, because this command is run by a human who is standing
 * anywhere — the daemon narrows to one repo because it is opening a session in it, and
 * that reasoning does not apply to a CLI.
 */
function corpus() {
  const dirs = [];
  for (const name of Object.keys(cfg.workspaces || {})) {
    try {
      dirs.push(resolveSessionDir(cfg, { name }));
    } catch {
      // A workspace with no directory is not a place a corpus could be.
    }
  }
  for (const repos of Object.values(cfg.repos || {})) {
    for (const r of repos || []) if (r?.dir) dirs.push(r.dir);
  }
  const where = corpusDir(cfg, dirs);
  if (!where) die('no requirements corpus found — set requirements.corpus in config.json, or check out the architecture repo');
  return loadCorpus(where);
}

const short = (s) => String(s || '').slice(0, 8);

async function main() {
  if (!verb || verb === '--help' || verb === '-h') {
    console.log(
      [
        'beadcause-requirements corpus [<token>]',
        'beadcause-requirements show <id>',
        'beadcause-requirements files <path...>',
        'beadcause-requirements coverage',
        'beadcause-requirements rebuild [<repo-dir>]',
        'beadcause-requirements promote <workspace> <bead>',
      ].join('\n')
    );
    return;
  }

  if (verb === 'corpus') {
    const c = corpus();
    const token = rest[0];
    const rows = token ? c.byToken.get(token) || [] : [...c.ids.values()];
    if (!rows.length) die(token ? `no requirements under token ${token}` : 'the corpus is empty');
    console.log(`${c.dir} — ${c.ids.size} requirements, ${c.tokens.length} tokens`);
    // A corpus bug, and one nothing else would ever show: the losing definition is simply
    // absent, and an edge recorded against the id means whichever of the two you assumed.
    for (const d of c.duplicates || []) {
      console.error(`  ⚠ ${d.id} is defined twice — using ${d.kept}, ignoring ${d.ignored}`);
    }
    for (const e of rows) {
      console.log(`  ${e.id}${e.stub ? '  (no definition yet)' : ''}`);
      if (e.definition) console.log(`      ${e.definition.slice(0, 140)}`);
      if (e.specs.length) console.log(`      tests: ${e.specs.map((s) => s.name).join(', ')}`);
    }
    return;
  }

  if (verb === 'show') {
    const id = rest[0];
    if (!id) die('usage: beadcause-requirements show <id>');
    const c = corpus();
    const entry = requirement(c, id);
    if (!entry) die(`${id} is not in the corpus — that is the point of the corpus`);
    console.log(`${entry.id}  (${entry.file})`);
    if (entry.definition) console.log(`  ${entry.definition}`);
    if (entry.specs.length) console.log(`  tests: ${entry.specs.map((s) => s.name).join(', ')}`);
    const edges = await edgesFor(id);
    if (!edges.length) {
      console.log('  no code recorded against it yet');
      return;
    }
    console.log(`  ${edges.length} edge${edges.length === 1 ? '' : 's'}:`);
    for (const e of edges) {
      console.log(`    ${short(e.commit)}  ${e.provenance}  ${e.workspace || '?'}/${e.bead || '?'}  ${path.basename(e.repo || '')}`);
      if (e.files.length) console.log(`        ${e.files.join(', ')}`);
    }
    return;
  }

  if (verb === 'files') {
    if (!rest.length) die('usage: beadcause-requirements files <path...>');
    const c = corpus();
    const matches = await edgesForFiles(rest.map((f) => f.replace(/^\.\//, '')));
    if (!matches.length) {
      console.log('nothing recorded against those files — which means nothing is written down, not that nothing is at stake');
      return;
    }
    for (const m of matches) {
      const entry = requirement(c, m.id);
      console.log(`${m.id} — ${entry?.definition?.slice(0, 140) || '(not in the corpus any more)'}`);
      console.log(`    via ${m.files.join(', ')}`);
      if (entry?.specs?.length) console.log(`    tests: ${entry.specs.map((s) => s.name).join(', ')}`);
    }
    return;
  }

  if (verb === 'coverage') {
    const c = corpus();
    const graph = await everything();
    const cov = coverage(c, graph);
    console.log(describeCoverage(cov));
    for (const t of cov.tokens) {
      if (!t.total) continue;
      console.log(`  ${t.token.padEnd(8)} ${String(t.covered).padStart(3)}/${String(t.total).padEnd(4)} covered · ${t.observed} observed · ${t.edges} edges`);
    }
    for (const o of cov.orphans) console.log(`  orphan: ${o.id} (${o.edges} edges, not in the corpus)`);
    return;
  }

  if (verb === 'rebuild') {
    const dir = rest[0] || process.cwd();
    const res = await rebuildFrom(dir);
    console.log(`rebuilt from ${dir}: ${res.commits} noted commit(s), ${res.edges} edge(s)`);
    return;
  }

  if (verb === 'promote') {
    const [workspace, bead] = rest;
    if (!workspace || !bead) die('usage: beadcause-requirements promote <workspace> <bead>');
    const c = corpus();
    const bd = new Bd(cfg);
    const issue = await bd.show(workspace, bead);
    if (!issue) die(`${workspace}/${bead} not found`);
    const { candidates } = readRequirements(issue, c);
    if (!candidates.length) die(`${bead} carries no candidate requirement`);

    const applied = [];
    for (const candidate of candidates) {
      const promotion = promotionFor(candidate, c);
      if (!promotion.ok) {
        console.error(`skipped ${promotion.id || candidate.name}: ${promotion.why}`);
        continue;
      }
      const res = applyPromotion(c.dir, promotion);
      if (!res.written) {
        console.error(`skipped ${promotion.id}: ${res.why}`);
        continue;
      }
      console.log(`wrote ${promotion.id} into ${promotion.file}`);
      applied.push(promotion.id);
    }
    if (!applied.length) return;

    // The candidate is now an id, and saying both would leave the bead proposing something
    // that exists. `readRequirements` collapses that on read; this makes it true on disk.
    const { ids } = readRequirements(issue, loadCorpus(c.dir));
    const keep = candidates.filter((k) => !applied.includes(`${k.token}.${k.name}`));
    await bd.update(workspace, bead, {
      notes: withRequirements(issue.notes, { ids: [...new Set([...ids, ...applied])], candidates: keep }),
    });
    console.log(`${bead}: ${applied.join(', ')} ${applied.length === 1 ? 'is' : 'are'} now a requirement id`);
    console.log('commit the corpus change in the architecture repo — nothing here pushes.');
    return;
  }

  die(`unknown command: ${verb}`);
}

main().catch((err) => die(err.message));
