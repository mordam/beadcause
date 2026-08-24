#!/usr/bin/env node
/**
 * The control graph as something a person and an agent can both reach: a command.
 *
 *   beadcause-controls show <id>                  one control, its crosswalk, and its evidence
 *   beadcause-controls declare <workspace> <bead> <id...>   what this bead exercises
 *   beadcause-controls files <path...>            the reverse lookup — what these files evidence
 *   beadcause-controls coverage [--months=N]      what is unevidenced, forecast-only, or stale
 *   beadcause-controls rebuild [<repo-dir>]       rebuild the index from that repo's git notes
 *
 * bin/requirements.js makes the argument for why any of this exists as a command: an agent
 * here is a `claude -p` with Bash and an allowlist and no way to `import` anything, so
 * every module under lib/ is invisible to it until something like this does.
 *
 * **`declare` is the one that makes the rest work.** Nothing else writes the block
 * lib/beadcontrols.js reads, and until something does, every landing records nothing and
 * the coverage list is 192 controls long. It is a *forecast*: a `declared` edge is not
 * written here and no evidence is claimed — what it does is put the ids on the bead so
 * that the merge, when it comes, has something to promote. That is the whole design, and
 * it is why this command cannot be run against a bead that has already landed and expect
 * to change anything.
 *
 * An id the corpus does not have is **refused by name** rather than dropped quietly, and
 * the refusal is the point: a fabricated `ISO42001.A.6.2.9` sitting beside the real
 * `A.6.2.8` is two nodes in the graph forever with nothing to tell them apart.
 *
 * **`rebuild` is the repair, and it is also the proof.** The index is a cache of the git
 * notes (lib/controlindex.js); running this over a correct index changes nothing, and
 * running it over a damaged one restores it. If those two ever diverge, the notes are
 * right.
 */
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { Bd } from '../lib/bd.js';
import { byFramework, control, corpus, crosswalk, FRAMEWORK_TOKENS, keepControls, satisfiedBy } from '../lib/controls.js';
import { edgesFor, edgesForFiles, everything, rebuildFrom } from '../lib/controlindex.js';
import { coverage, describeCoverage } from '../lib/controlcoverage.js';
import { readControls, withControls } from '../lib/beadcontrols.js';

const argv = process.argv.slice(2);
const [verb, ...rest] = argv.filter((a) => !a.startsWith('--'));
const flags = new Map(
  argv
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, ...v] = a.replace(/^--/, '').split('=');
      return [k, v.join('=') || '1'];
    })
);

const cfg = loadConfig();

const die = (msg) => {
  console.error(msg);
  process.exit(1);
};

const short = (s) => String(s || '').slice(0, 8);

async function main() {
  if (!verb || verb === '--help' || verb === '-h') {
    console.log(
      [
        'beadcause-controls corpus [<framework>]',
        'beadcause-controls show <id>',
        'beadcause-controls declare <workspace> <bead> <id...>',
        'beadcause-controls files <path...>',
        'beadcause-controls coverage [--months=N]',
        'beadcause-controls rebuild [<repo-dir>]',
      ].join('\n')
    );
    return;
  }

  if (verb === 'corpus') {
    const token = rest[0];
    if (token && !FRAMEWORK_TOKENS.includes(token)) {
      die(`${token} is not a framework — try one of ${FRAMEWORK_TOKENS.join(', ')}`);
    }
    const c = corpus();
    const rows = token ? byFramework(token) : [...c.ids.values()];
    console.log(`${c.size} controls in ${c.tokens.length} frameworks, ${c.edges} crosswalk edges`);
    for (const r of rows) {
      console.log(`  ${r.id}  [${r.kind}]  ${r.title}`);
    }
    return;
  }

  if (verb === 'show') {
    const id = rest[0];
    if (!id) die('usage: beadcause-controls show <id>');
    const record = control(id);
    if (!record) die(`${id} is not in the corpus — that is the point of the corpus`);
    console.log(`${record.id}  [${record.kind}]  ${record.title}`);
    console.log(`  ${record.definition}`);
    if (record.groupName) console.log(`  group: ${record.groupName}`);
    const out = crosswalk(record.id);
    const inbound = satisfiedBy(record.id);
    if (out.length) console.log(`  claims: ${out.join(', ')}`);
    if (inbound.length) console.log(`  satisfied by: ${inbound.join(', ')}`);
    const edges = await edgesFor(record.id);
    if (!edges.length) {
      console.log('  no evidence recorded against it yet');
      return;
    }
    console.log(`  ${edges.length} edge${edges.length === 1 ? '' : 's'}:`);
    for (const e of edges) {
      console.log(
        `    ${short(e.commit)}  ${e.provenance}  ${e.at.slice(0, 10)}  ${e.workspace || '?'}/${e.bead || '?'}  ${path.basename(e.repo || '')}`
      );
      if (e.files.length) console.log(`        ${e.files.join(', ')}`);
    }
    return;
  }

  if (verb === 'declare') {
    const [workspace, bead, ...ids] = rest;
    if (!workspace || !bead || !ids.length) die('usage: beadcause-controls declare <workspace> <bead> <id...>');
    const { ids: good, dropped } = keepControls(ids);
    // Refused by name, and refused outright rather than partially applied: a command that
    // wrote three of the four ids and mentioned the fourth in passing is one whose caller
    // reads the exit code and moves on.
    if (dropped.length) die(`not in the corpus: ${dropped.join(', ')} — nothing written`);
    const bd = new Bd(cfg);
    const issue = await bd.show(workspace, bead);
    if (!issue) die(`${workspace}/${bead} not found`);
    const had = readControls(issue).ids;
    const merged = [...new Set([...had, ...good])];
    await bd.update(workspace, bead, { notes: withControls(issue.notes, { ids: merged }) });
    console.log(`${bead} exercises ${merged.join(', ')}`);
    console.log('nothing is evidenced yet — the merge that lands this bead is what proves it.');
    return;
  }

  if (verb === 'files') {
    if (!rest.length) die('usage: beadcause-controls files <path...>');
    const matches = await edgesForFiles(rest.map((f) => f.replace(/^\.\//, '')));
    if (!matches.length) {
      console.log('nothing recorded against those files — which means nothing is written down, not that nothing is at stake');
      return;
    }
    for (const m of matches) {
      const record = control(m.id);
      console.log(`${m.id} — ${record?.title || '(not in the corpus any more)'}`);
      console.log(`    via ${m.files.join(', ')}`);
    }
    return;
  }

  if (verb === 'coverage') {
    const months = Number.parseInt(flags.get('months') || '', 10);
    const graph = await everything();
    const cov = coverage(graph, Number.isInteger(months) && months > 0 ? { reviewMonths: months } : {});
    console.log(describeCoverage(cov));
    for (const f of cov.frameworks) {
      if (!f.total) continue;
      console.log(
        `  ${f.token.padEnd(9)} ${String(f.proved).padStart(3)}/${String(f.total).padEnd(4)} proved · ` +
          `${f.forecast} forecast · ${f.stale} stale · ${f.unevidenced} unevidenced${f.certifiable ? '' : '  (guidance)'}`
      );
    }
    for (const s of cov.stale) console.log(`  stale: ${s.id} — newest proof ${s.at.slice(0, 10)}, ${s.days} day(s) past the window`);
    for (const o of cov.orphans) console.log(`  orphan: ${o.id} (${o.edges} edges, not in the corpus)`);
    // The unevidenced list is the long one and the useful one, so it goes last and whole:
    // a truncated compliance gap is a gap somebody thinks they have read.
    if (cov.unevidenced.length) console.log(`  unevidenced: ${cov.unevidenced.join(', ')}`);
    return;
  }

  if (verb === 'rebuild') {
    const dir = rest[0] || process.cwd();
    const res = await rebuildFrom(dir);
    console.log(`rebuilt from ${dir}: ${res.commits} noted commit(s), ${res.edges} edge(s)`);
    return;
  }

  die(`unknown command: ${verb}`);
}

main().catch((err) => die(err.message));
