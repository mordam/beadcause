#!/usr/bin/env node
/**
 * Render the map — what happens in beadcause, and what decides each step.
 *
 *   node scripts/flowchart.mjs                 write docs/flowchart.html and say where
 *   node scripts/flowchart.mjs --open          …and open it
 *   node scripts/flowchart.mjs --inline        embed mermaid, so the file travels alone
 *   node scripts/flowchart.mjs --out <path>    somewhere else
 *   node scripts/flowchart.mjs --json          the model, for anything else to read
 *   node scripts/flowchart.mjs --mermaid [id]  one flow's diagram source, or all of them
 *   node scripts/flowchart.mjs --list          the flows, the agents, the counts
 *   node scripts/flowchart.mjs --check         is the model still true of the tree?
 *
 * **Why a script and not a checked-in drawing.** Three of the things this page states
 * are read out of lib/foundation.js at render time — what each agent may run, whether it
 * may write to the tracker, and the whole of its role prompt — and a drawing that copied
 * any of them would be a second definition of an agent, which is precisely what
 * lib/foundation.js exists to prevent. Re-run this after a release and the page is true
 * again; nothing has to be remembered.
 *
 * **Why the same file as the app's page.** The HTML this writes embeds the model as
 * `window.FLOWCHART` and then inlines public/flow.js — the identical renderer `/flow`
 * loads. A committed doc and a live screen that draw the same system with two renderers
 * is two things to keep in step, and the one that is not being looked at is always the
 * one that is wrong.
 *
 * **What `--check` is for, and what it cannot do.** Every node in the model names the
 * files it happens in, and `--check` asserts they are still in the tree. That catches
 * the drift a year of refactoring actually produces — a module renamed, a module gone —
 * and it deliberately does not pretend to catch a step that moved *inside* a file it
 * still names. Nothing short of writing the code twice would, and the second copy would
 * be the thing that rotted. `node test/flowchart.mjs` runs the same check in `npm test`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { flowchart, mermaidFor, problems, sourcePaths } from '../lib/flowchart.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (flag, fallback = null) => {
  const i = argv.indexOf(flag);
  return i === -1 || i === argv.length - 1 ? fallback : argv[i + 1];
};

/** The model, plus the mermaid source per flow so no reader has to re-derive it. */
function model() {
  const m = flowchart();
  for (const flow of m.flows) flow.mermaid = mermaidFor(flow.id);
  m.effective = false; // the baselines: see lib/flowchart.js's `agents`
  m.generatedFrom = 'lib/flowchart.js';
  return m;
}

/* --------------------------------------------------------------------- checks */

if (has('--check')) {
  const found = problems({ exists: (rel) => fs.existsSync(path.join(ROOT, rel)) });
  if (!found.length) {
    console.log(`the map is consistent — ${sourcePaths().length} source paths, all present`);
    process.exit(0);
  }
  console.error('the map disagrees with the tree:\n');
  for (const p of found) console.error(`  - ${p}`);
  console.error('\nEdit lib/flowchart.js. A node whose module has moved is the whole failure this catches.');
  process.exit(1);
}

/* ---------------------------------------------------------------------- lists */

if (has('--list')) {
  const m = model();
  console.log(`${m.title}\n`);
  console.log(`${m.counts.flows} flows · ${m.counts.nodes} steps · ${m.counts.agents} agent kinds\n`);
  for (const k of m.kinds) {
    console.log(`  ${String(m.counts.byKind[k.id] || 0).padStart(3)}  ${k.label}`);
  }
  console.log('\nFlows:');
  for (const f of m.flows) {
    const agentic = f.nodes.filter((n) => n.kind === 'agent').length;
    console.log(`  ${f.id.padEnd(10)} ${f.nodes.length} steps, ${agentic} agentic — ${f.title}`);
  }
  console.log('\nAgents:');
  for (const a of m.agents) {
    console.log(
      `  ${a.id.padEnd(14)} ${a.writes ? 'writes ' : 'reads  '} ${String((a.allowedTools || []).length).padStart(2)} allowed  ${a.title}`
    );
  }
  process.exit(0);
}

if (has('--json')) {
  process.stdout.write(`${JSON.stringify(model(), null, 2)}\n`);
  process.exit(0);
}

if (has('--mermaid')) {
  const which = value('--mermaid');
  const m = model();
  const flows = which && !which.startsWith('--') ? m.flows.filter((f) => f.id === which) : m.flows;
  if (!flows.length) {
    console.error(`no such flow: ${which}. One of: ${m.flows.map((f) => f.id).join(', ')}`);
    process.exit(1);
  }
  for (const f of flows) {
    if (flows.length > 1) console.log(`%% ${f.id} — ${f.title}`);
    console.log(f.mermaid);
    if (flows.length > 1) console.log('');
  }
  process.exit(0);
}

/* ----------------------------------------------------------------- the render */

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * `</script>` inside a JSON string ends the script tag it is sitting in, whatever the
 * JSON says. Every role prompt in this payload is prose written for an agent and one of
 * them will eventually contain one.
 */
const embed = (obj) => JSON.stringify(obj).replace(/<\/(script)/gi, '<\\/$1');

/**
 * The tokens the renderer expects, lifted from the app's own stylesheet rather than
 * retyped.
 *
 * public/style.css is 5000 lines of app chrome this page has no use for, and its
 * `:root` block plus the light-scheme override is the whole of what flow.js reads. Cut
 * to the two blocks at the top of the file, and it fails loudly if their shape ever
 * changes rather than silently rendering an unstyled page.
 */
function tokens() {
  const css = read('public/style.css');
  const dark = /^:root \{[\s\S]*?\n\}/m.exec(css);
  // `\n\s*\}` on the inner brace: the nested `:root` closes indented, and a pattern that
  // assumed column zero silently matched nothing at all.
  const light = /@media \(prefers-color-scheme: light\) \{[\s\S]*?\n\s*\}\n\}/m.exec(css);
  if (!dark || !light) {
    throw new Error(
      'public/style.css no longer opens with a :root block and a light-scheme override — scripts/flowchart.mjs lifts its tokens from there and needs updating'
    );
  }
  return `${dark[0]}\n${light[0]}`;
}

const inlineMermaid = has('--inline');
const mermaidPath = path.join(ROOT, 'public', 'vendor', 'mermaid.js');
const haveMermaid = fs.existsSync(mermaidPath);

if (inlineMermaid && !haveMermaid) {
  console.error('public/vendor/mermaid.js is not there — run `npm run vendor` first, or drop --inline');
  process.exit(1);
}

const out = path.resolve(value('--out') || path.join(ROOT, 'docs', 'flowchart.html'));

/**
 * How the page reaches mermaid, and the one honest failure it has.
 *
 * Not inlined by default: mermaid is 3.5MB, and a 3.5MB file in `docs/` is a diff
 * nobody can read and a commit that dwarfs the repo. A relative path works from the
 * checkout, which is where this file is meant to be opened. `--inline` is for the copy
 * you send somebody, where the checkout is exactly what they do not have.
 */
const mermaidTag = inlineMermaid
  ? `<script>${fs.readFileSync(mermaidPath, 'utf8')}</script>`
  : `<script src="${path.relative(path.dirname(out), mermaidPath).split(path.sep).join('/')}"></script>`;

const m = model();
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Every step in beadcause, and whether it is code this repo can be held to or an agent it cannot.">
<title>Beadcause — the map</title>
<style>*,*::before,*::after{box-sizing:border-box}img{max-width:100%}</style>
<style>
${tokens()}
html, body { margin: 0; background: var(--bg); color: var(--text); }
body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; -webkit-text-size-adjust: 100%; }
.made { max-width: 1100px; margin: 0 auto; padding: 0 14px 40px; color: var(--muted); font-size: 0.78rem; }
.made code { background: var(--surface-2); border-radius: 6px; padding: 2px 6px; }
</style>
</head>
<body>
<div id="flow"><div style="padding:24px">Drawing…</div></div>
<p class="made">Generated from <code>lib/flowchart.js</code> by <code>node scripts/flowchart.mjs</code>${
  inlineMermaid ? ' with mermaid embedded' : ''
}. Re-run it after a release: the agent halves of this page are read out of <code>lib/foundation.js</code>, so an approved amendment changes what it says. The screen version, with the <em>effective</em> foundations rather than the baselines, is <code>/flow</code> in the app.</p>
${mermaidTag}
<script>window.FLOWCHART = ${embed(m)};</script>
<script>
${read('public/flow.js')}
</script>
</body>
</html>
`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);

const kb = Math.round(Buffer.byteLength(html) / 1024);
console.log(`${out}  (${kb} KB, ${m.counts.flows} flows, ${m.counts.nodes} steps, ${m.counts.agents} agents)`);
if (!inlineMermaid && !haveMermaid) {
  console.log('note: public/vendor/mermaid.js is missing, so the diagrams will show as their source until you run `npm run vendor`');
}

// Said after the path, not instead of it — a stale map that renders perfectly is the
// failure mode this warning is the only sign of.
const found = problems({ exists: (rel) => fs.existsSync(path.join(ROOT, rel)) });
if (found.length) {
  console.warn(`\n${found.length} problem(s) with the model — run --check`);
}

if (has('--open')) {
  spawn('open', [out], { stdio: 'ignore', detached: true }).unref();
}
