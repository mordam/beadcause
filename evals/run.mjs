#!/usr/bin/env node
/**
 * `npm run evals` — the suite that grades the *agent*, not the daemon.
 *
 *     npm run evals                       # the free tier only: no model, no tokens, no bill
 *     npm run evals -- --list             # what exists, what tier it is in, what it costs
 *     npm run evals -- --tag fast         # one short real agent run per eval
 *     npm run evals -- --tag fast,slow    # everything, including the multi-run ones
 *     npm run evals -- --all
 *     npm run evals -- --only consoleread
 *     npm run evals -- --tag fast --model haiku
 *
 * ## Why this is not `npm test`
 *
 * Everything in `test/` is deterministic and free, and the gate depends on both of those:
 * a suite that costs money cannot run on every push, and a suite that can fail on a
 * model's mood cannot be the thing that decides whether a branch may merge. So the live
 * evals are a separate command, opt-in by tier, and `scripts/test.mjs` never discovers
 * this directory.
 *
 * The exception is the free tier, and it earns the exception by not being live at all:
 * `foundations/grants.mjs` reads two objects and compares them, and its counterpart
 * `test/grants.mjs` runs the same function inside the gate. A guard that runs only when
 * somebody remembers to run it is a guard against nothing — the same argument
 * lib/checkaudit.js makes for the browser checks.
 *
 * ## The default is the free tier, deliberately
 *
 * `npm run evals` with no arguments spends nothing. The alternative — a default that
 * quietly runs a dozen agents — is a command somebody types once to see what it does and
 * then has to explain. The tiers cost real money, so asking for them is one flag, and the
 * listing prints what each one costs before you spend it.
 *
 * ## The three tiers
 *
 * - **`free`** — no model is run. Static assertions about the foundations themselves.
 * - **`fast`** — one short agent run, on a seeded throwaway directory. Seconds and cents.
 *   This is the loop you can afford to run while changing a role or an allowlist.
 * - **`slow`** — more than one run, or a run that drives something real. Opt-in only.
 *
 * A tier is a claim about cost and nothing else. An eval does not get to be `fast`
 * because it is important.
 *
 * ## What a failure here means
 *
 * A `free` failure is a bug and the repo is wrong. A `fast` or `slow` failure is one
 * observation of one model on one day, and the honest reading is "this stopped holding",
 * not "this is broken" — so a failure prints what the agent actually did rather than only
 * what it should have done. Re-run before you believe it, and if it holds, the thing that
 * changed is usually a role, an allowlist, or the model underneath.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvalFailure, spent, resetSpend } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The tiers, in the order they are printed and run — cheapest first, always. */
export const TAGS = ['free', 'fast', 'slow'];

/**
 * Every eval on disk: any `.mjs` in a **subdirectory** of `evals/`.
 *
 * Discovered rather than listed, for the reason `scripts/test.mjs` gives at length —
 * a command that names its suites is a single line every branch edits, and git cannot
 * merge two insertions into one line. Adding an eval is adding a file.
 *
 * The top level is harness — this file, `helpers.mjs`, `fixtures.mjs` — and it is drawn
 * by *position* rather than by an exclusion list, because an exclusion list is a thing
 * somebody adding a fourth helper has to remember, and forgetting it does not read as a
 * mistake: it reads as `meta.tag must be one of free, fast, slow` against a file that was
 * never an eval.
 */
export function discover(root = HERE) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, `${prefix}${entry.name}/`);
        continue;
      }
      if (!entry.name.endsWith('.mjs')) continue;
      if (prefix === '') continue; // harness, not an eval — see above
      out.push({ id: `${prefix}${entry.name.replace(/\.mjs$/, '')}`, file: full });
    }
  };
  walk(root, '');
  return out;
}

/**
 * Load one, and refuse it if it does not say what it is.
 *
 * An eval with no `meta.tag` would default to *something*, and every default here is
 * wrong: defaulting to `free` puts a paid run in the free tier, and defaulting to `slow`
 * hides it from the tier somebody actually runs. So it is an error, named.
 */
export async function load(entry) {
  const mod = await import(entry.file);
  const meta = mod.meta || {};
  if (!TAGS.includes(meta.tag)) {
    throw new Error(`evals/${entry.id}.mjs: meta.tag must be one of ${TAGS.join(', ')} — got ${JSON.stringify(meta.tag)}`);
  }
  if (typeof mod.run !== 'function') throw new Error(`evals/${entry.id}.mjs: exports no run()`);
  if (!meta.title) throw new Error(`evals/${entry.id}.mjs: meta.title says what is being asserted, and is missing`);
  return { ...entry, meta, run: mod.run };
}

export function parseArgs(argv) {
  const opts = { tags: null, only: null, model: null, list: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') opts.list = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--tag' || a === '--tags') opts.tags = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith('--tag=')) opts.tags = a.slice(6).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--only') opts.only = String(argv[++i] || '');
    else if (a.startsWith('--only=')) opts.only = a.slice(7);
    else if (a === '--model') opts.model = String(argv[++i] || '');
    else if (a.startsWith('--model=')) opts.model = a.slice(8);
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (opts.all) opts.tags = [...TAGS];
  if (!opts.tags) opts.tags = ['free'];
  const bad = opts.tags.filter((t) => !TAGS.includes(t));
  if (bad.length) throw new Error(`unknown tag${bad.length > 1 ? 's' : ''} ${bad.join(', ')} — the tiers are ${TAGS.join(', ')}`);
  return opts;
}

/** Which of the discovered evals this invocation selects, cheapest tier first. */
export function select(loaded, opts) {
  return loaded
    .filter((e) => opts.tags.includes(e.meta.tag))
    .filter((e) => !opts.only || e.id.includes(opts.only))
    .sort((a, b) => TAGS.indexOf(a.meta.tag) - TAGS.indexOf(b.meta.tag) || a.id.localeCompare(b.id));
}

const usd = (n) => (n ? `$${n.toFixed(4)}` : '$0');

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`evals: ${err.message}`);
    process.exit(2);
  }

  const loaded = [];
  for (const entry of discover()) {
    try {
      loaded.push(await load(entry));
    } catch (err) {
      console.error(`evals: ${err.message}`);
      process.exit(2);
    }
  }

  if (opts.help) {
    // The header comment of this file *is* the help, so there is one place to keep it
    // right rather than two that drift apart.
    const head = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0];
    console.log(head.replace(/^#!.*\n/, '').replace(/^\/\*\*?\n?|^ \* ?|^ \*$/gm, '').trim());
    return;
  }

  if (opts.list) {
    console.log('evals\n');
    for (const tag of TAGS) {
      const mine = loaded.filter((e) => e.meta.tag === tag);
      if (!mine.length) continue;
      console.log(`  ${tag}`);
      for (const e of mine) console.log(`    ${e.id.padEnd(28)} ${e.meta.title}\n${' '.repeat(36)}${e.meta.cost || 'cost not stated'}`);
      console.log('');
    }
    console.log(`  npm run evals -- --tag ${TAGS.filter((t) => t !== 'free').join(',')}   to run the paid tiers`);
    return;
  }

  const running = select(loaded, opts);
  if (!running.length) {
    console.log(`evals: nothing matched --tag ${opts.tags.join(',')}${opts.only ? ` --only ${opts.only}` : ''}`);
    process.exit(1);
  }

  console.log(`evals — ${opts.tags.join(', ')}${opts.model ? ` on ${opts.model}` : ''}\n`);
  resetSpend();
  let failures = 0;
  for (const e of running) {
    const started = Date.now();
    try {
      const said = await e.run({ model: opts.model || null });
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`PASS  ${e.id}  (${secs}s)`);
      if (said) console.log(`      ${String(said).split('\n').join('\n      ')}`);
    } catch (err) {
      failures++;
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`FAIL  ${e.id}  (${secs}s)`);
      console.log(`      ${e.meta.title}`);
      console.log(`      ${String(err instanceof EvalFailure ? err.message : err.stack || err).split('\n').join('\n      ')}`);
    }
  }

  const bill = spent();
  console.log(`\n${running.length} eval${running.length === 1 ? '' : 's'}, ${failures} failed — ${usd(bill)} of model time`);
  process.exit(failures ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
