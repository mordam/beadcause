#!/usr/bin/env node
/**
 * What a new route, page, module or config key still owes the registries that will
 * go red without it — before the gate is worth starting.
 *
 *   b7e-owes                    every unpaid registration in the working tree, right now
 *   b7e-owes --rev <range>      the same, with any finding whose file the range touched
 *                                marked "(touched by <range>)"
 *   b7e-owes < some.diff        the same annotation, read from a unified diff on stdin
 *
 * bc-khoe.27.7 is the audit: four sessions (bc-dgx7.5, bc-khoe.27.3, bc-ka5y.15.2,
 * bc-xl7n.56) each independently rediscovered the same handful of registries a new
 * route, page, lib/ module or config key incurs debt in — some by asking memory one
 * note at a time, some by watching a suite go red after the code was already written,
 * and bc-ka5y.15.2's `advocates.flagFinishedEpics` gap was rediscovered from scratch by
 * three *more* sessions after that. This runs the four checks that exist for exactly
 * that reason, so the debt is named before a line of the actual work.
 *
 * FOUR REGISTRIES, each checked in both directions — something that should be there
 * and is not, and (where it is cheap) something that is there and no longer needs to
 * be:
 *
 *   1. README.md's API table vs. the `(method, path)` chain lib/server.js dispatches
 *      on — the same read test/routes.mjs makes, duplicated deliberately (see the
 *      comment on `routeTable` in lib/server.js for why that duplication is already
 *      the house style here).
 *   2. README.md's Config table vs. every key `loadConfig()` and the advocate
 *      `options()` actually default — the same read test/configtable.mjs makes,
 *      including its shape-row coverage and its short list of real, undefaulted keys.
 *   3. lib/evidence.js's REGISTER/NOT_EVIDENCE vs. every lib/ or bin/ module that
 *      touches `CONFIG_DIR` or a `refs/beadcause/*` ref — `coverageProblems()` is
 *      imported and run directly rather than re-implemented, because it already is
 *      the check, not a description of one.
 *   4. test/pagepaths.mjs's PAGES/REDIRECTS vs. every alias `serveStatic` in
 *      lib/server.js defines (the run of one-line `if (urlPath === '/x') …` this file
 *      itself explains is "read as a table as well as run"). An alias with no mention
 *      anywhere in test/pagepaths.mjs is one nothing has ever asked to answer for —
 *      not a hypothetical: `/foundations`, `/flow`, `/map`, `/requirements` and
 *      `/coverage` are five of them on main today, filed separately as bc-khoe.27.9
 *      rather than fixed here, because fixing five means deciding what each one
 *      should assert and that is a different piece of work than telling you it is
 *      owed.
 *
 * WHAT THIS DOES NOT CHECK. It is the four registries this bead's own evidence names,
 * not a general documentation linter. It does not check `package.json`'s `bin` against
 * `package-lock.json`'s (test/lockfile.mjs already does, unconditionally, on every
 * `npm test`), and it does not check `public/sw.js`'s cache version (see the sw-cache
 * notes in memory — that one collides on its own on every merge and a static read of
 * one working tree cannot see the other branches racing it). Both are real registries
 * a new file can owe; neither goes silently red the way these four do, which is the
 * bar this tool exists to clear.
 *
 * EXIT CODE is a linter's, not b7e-def's: 0 when nothing is owed, 1 when something is
 * — so `b7e-owes || …` is a gate, the same shape `eslint` or `tsc --noEmit` already
 * are in this house.
 *
 * @grant read
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(HERE, '..');

const read = (p) => fs.readFileSync(p, 'utf8');

/* ===================================================================== *
 * 1. the API table
 * ===================================================================== */

/**
 * Every `(method, path)` lib/server.js's dispatch chain answers, from its source —
 * the same two forms `test/routes.mjs` and `routeTable()` in lib/server.js itself
 * match. Kept as a third copy on purpose: this tool has to run before those two are
 * ever booted, and the whole point of the duplication already standing in this repo
 * is that all three are cheap regexes over the same text and are asserted to agree.
 */
// Built with `new RegExp` from a plain string, not a `/…/` literal — a literal
// containing this many quote characters defeats lib/evidence.js's own
// `blankComments`, which is not a real parser and does not know a regex literal
// from a string: an odd count of `'` inside one leaves its quote-tracking stuck
// "inside a string" for the rest of the file, so every comment after it stops being
// recognised as a comment at all. Found the hard way — this file tripped its own
// evidence check on its own quoted regex once written the obvious way.
const FORWARD_ROUTE_RE = "if \\(\\s*p === '([^']+)'\\s*&&\\s*req\\.method === '([A-Z]+)'";
const BACKWARD_ROUTE_RE = "if \\(\\s*req\\.method === '([A-Z]+)'\\s*&&\\s*p === '([^']+)'";

export function routePairs(serverSrc) {
  const pairs = [];
  for (const m of serverSrc.matchAll(new RegExp(FORWARD_ROUTE_RE, 'g'))) {
    pairs.push({ path: m[1], method: m[2] });
  }
  for (const m of serverSrc.matchAll(new RegExp(BACKWARD_ROUTE_RE, 'g'))) {
    pairs.push({ path: m[2], method: m[1] });
  }
  // Served before the dispatch chain these pairs come from — see test/routes.mjs.
  pairs.push({ path: '/api/health', method: 'GET' });
  return pairs;
}

/** Every `(method, path)` row in a `| GET | \`/api/x\` | … |` table anywhere in README.md. */
const API_ROW_RE = '^\\|\\s*(GET|POST|PUT|DELETE|PATCH)\\s*\\|\\s*`(/api/[a-z0-9/-]+)`';

export function apiTableRows(readmeSrc) {
  const documented = new Set();
  for (const m of readmeSrc.matchAll(new RegExp(API_ROW_RE, 'gim'))) {
    documented.add(`${m[1].toUpperCase()} ${m[2]}`);
  }
  return documented;
}

/** `{missing, phantom}` — served-but-undocumented, and documented-but-unserved. */
export function routeGaps(pairs, documented) {
  const served = new Set(pairs.map((r) => `${r.method} ${r.path}`));
  return {
    missing: [...served].filter((r) => !documented.has(r)).sort(),
    phantom: [...documented].filter((r) => !served.has(r)).sort(),
  };
}

/* ===================================================================== *
 * 2. the Config table
 * ===================================================================== */

/**
 * Real keys with no default, so they never show up in a served set however
 * completely `loadConfig()`+`options()` are walked — kept in sync with
 * test/configtable.mjs's own `NO_DEFAULT`, which is the check this one stands in
 * for before that suite is worth running.
 */
export const NO_DEFAULT_CONFIG_KEYS = new Set([
  'agentToolsAcknowledged',
  'claudeSessionsDir',
  'claudeProjectsDir',
  'agents[].tools',
  'jira.<workspace>.tokenFile',
]);

/** The one `| key | meaning |` table right after `## Config —`, not the whole section. */
export function configTableRows(readmeSrc) {
  const lines = readmeSrc.split('\n');
  const headingIdx = lines.findIndex((l) => l.startsWith('## Config —'));
  if (headingIdx < 0) return null;
  const tableStart = lines.findIndex((l, i) => i >= headingIdx && l.startsWith('| key | meaning |'));
  if (tableStart < 0) return null;
  let tableEnd = tableStart + 1;
  while (tableEnd < lines.length && lines[tableEnd].startsWith('|')) tableEnd += 1;
  const documented = new Set();
  for (const line of lines.slice(tableStart, tableEnd)) {
    if (!line.startsWith('| `')) continue;
    const firstCell = line.split('|')[1];
    for (const m of firstCell.matchAll(new RegExp('`([^`]+)`', 'g'))) documented.add(m[1]);
  }
  return documented;
}

/** Dot-paths for every leaf of a merged config object — an empty `{}` counts as a leaf. */
export function flattenConfig(obj, prefix = '', out = []) {
  const entries = Object.entries(obj || {});
  if (entries.length === 0) {
    if (prefix) out.push(prefix);
    return out;
  }
  for (const [k, v] of entries) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flattenConfig(v, key, out);
    else out.push(key);
  }
  return out;
}

/**
 * `{missing, phantom}` for the Config table — the same two directions
 * test/configtable.mjs checks. `served` is every dot-path `flattenConfig` found;
 * `documented` is every row `configTableRows` found.
 */
export function configGaps(served, documented) {
  const servedSet = new Set(served);
  const coveredByRow = (key) => {
    if (documented.has(key)) return true;
    const parts = key.split('.');
    for (let i = parts.length - 1; i > 0; i -= 1) {
      if (documented.has(parts.slice(0, i).join('.'))) return true;
    }
    return false;
  };
  const isShapeParent = (k) => served.some((s) => s.startsWith(`${k}.`));
  const missing = served.filter((k) => !coveredByRow(k)).sort();
  const phantom = [...documented]
    .filter((k) => !servedSet.has(k) && !NO_DEFAULT_CONFIG_KEYS.has(k) && !isShapeParent(k))
    .sort();
  return { missing, phantom };
}

/**
 * The real, live answer to "what does the daemon actually default" — dynamically
 * importing lib/config.js and lib/advocate.js from `root`, under a throwaway
 * `BEADCAUSE_CONFIG_DIR` so nothing here ever touches `~/.config/beadcause`. Real-repo
 * only: there is no fixture cheap enough to stand in for `loadConfig()`, which is
 * exactly the argument test/configtable.mjs's own header makes for reading it live
 * rather than re-describing its shape.
 */
export async function servedConfigKeys(root) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b7e-owes-config-'));
  const prior = process.env.BEADCAUSE_CONFIG_DIR;
  process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
  fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });
  try {
    const { loadConfig } = await import(path.join(root, 'lib', 'config.js'));
    const { options } = await import(path.join(root, 'lib', 'advocate.js'));
    const cfg = loadConfig();
    cfg.advocates = options(cfg);
    return flattenConfig(cfg);
  } finally {
    if (prior === undefined) delete process.env.BEADCAUSE_CONFIG_DIR;
    else process.env.BEADCAUSE_CONFIG_DIR = prior;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* ===================================================================== *
 * 3. lib/evidence.js
 * ===================================================================== */

/**
 * `coverageProblems()` off lib/evidence.js, imported and run rather than
 * re-implemented — the register's own coverage check already IS the answer to "does
 * a lib/ module naming CONFIG_DIR have a claim", not a description of one to copy.
 *
 * The function always comes from *this* checkout's lib/evidence.js — REGISTER and
 * NOT_EVIDENCE are this repo's own claims and nowhere else has them — but `root` is
 * whatever tree to scan, which is what lets test/b7eowes.mjs point it at a small
 * fabricated `lib/newthing.js` without needing a second copy of lib/evidence.js
 * beside it, the same split `coverageProblems(root, claims)` already offers.
 */
export async function evidenceGaps(root) {
  const { coverageProblems } = await import(path.join(ROOT, 'lib', 'evidence.js'));
  return coverageProblems(root);
}

/* ===================================================================== *
 * 4. test/pagepaths.mjs
 * ===================================================================== */

/**
 * Every alias `serveStatic` defines, off the run of one-line `if (urlPath === '/x')
 * …` (and its few braced multi-path siblings) that function's own doc comment calls
 * "read as a table as well as run" — the bound is the function's own header and the
 * `const rel = urlPath === '/' ? …` line that starts turning a path into a file,
 * which is everything the aliasing actually is.
 */
export function serveStaticAliases(serverSrc) {
  const start = serverSrc.indexOf('async function serveStatic(req, res, url, urlPath) {');
  const end = serverSrc.indexOf("const rel = urlPath === '/' ?", start);
  if (start < 0 || end < 0) return null;
  const block = serverSrc.slice(start, end);
  const aliases = new Set();
  for (const m of block.matchAll(new RegExp("urlPath === '([^']+)'", 'g'))) aliases.add(m[1]);
  return [...aliases].sort();
}

/** Aliases mentioned nowhere in test/pagepaths.mjs's source — a textual check, on
 * purpose: PAGES, REDIRECTS, GONE and NEVER_MADE all name a path the same way, as a
 * quoted string literal, and asking "is this exact alias quoted anywhere in the
 * file" catches all four without needing four separate parsers kept in sync with
 * whichever one this file's author reached for. */
export function pageGaps(aliases, pagepathsSrc) {
  return (aliases || []).filter((a) => !pagepathsSrc.includes(`'${a}'`));
}

/* ===================================================================== *
 * touched-files annotation — --rev <range> or a diff on stdin
 * ===================================================================== */

function touchedFiles({ rev, diffText }) {
  if (diffText) {
    const touched = new Set();
    for (const m of diffText.matchAll(/^\+\+\+ b\/(.+)$/gm)) touched.add(m[1]);
    return touched;
  }
  if (!rev) return null;
  try {
    const out = execFileSync('git', ['diff', '--name-only', rev], { cwd: ROOT, encoding: 'utf8' });
    return new Set(out.split('\n').filter(Boolean));
  } catch {
    return null; // not fatal — annotation is a courtesy, not the check
  }
}

/* ===================================================================== *
 * assembling and printing findings
 * ===================================================================== */

function annotate(finding, file, touched, label) {
  if (touched && file && touched.has(file)) return `${finding} (touched by ${label})`;
  return finding;
}

async function findAll(root, { touched, touchedLabel } = {}) {
  const findings = [];
  const serverSrc = read(path.join(root, 'lib', 'server.js'));
  const readmeSrc = read(path.join(root, 'README.md'));

  // 1. API table
  {
    const { missing, phantom } = routeGaps(routePairs(serverSrc), apiTableRows(readmeSrc));
    for (const r of missing) {
      findings.push(annotate(`README.md API table: no row for ${r} (test/routes.mjs)`, 'lib/server.js', touched, touchedLabel));
    }
    for (const r of phantom) {
      findings.push(
        annotate(`README.md API table: a row for ${r}, but nothing serves it (test/routes.mjs)`, 'README.md', touched, touchedLabel)
      );
    }
  }

  // 2. Config table
  {
    const served = await servedConfigKeys(root);
    const documented = configTableRows(readmeSrc);
    if (documented) {
      const { missing, phantom } = configGaps(served, documented);
      for (const k of missing) {
        findings.push(
          annotate(`README.md Config table: no row for ${k} (test/configtable.mjs)`, 'lib/config.js', touched, touchedLabel)
        );
      }
      for (const k of phantom) {
        findings.push(
          annotate(
            `README.md Config table: a row for ${k}, but nothing defaults it (test/configtable.mjs)`,
            'README.md',
            touched,
            touchedLabel
          )
        );
      }
    }
  }

  // 3. lib/evidence.js
  {
    const problems = await evidenceGaps(root);
    for (const p of problems) {
      findings.push(annotate(`lib/evidence.js: ${p} (test/evidence.mjs)`, 'lib/evidence.js', touched, touchedLabel));
    }
  }

  // 4. test/pagepaths.mjs
  {
    const aliases = serveStaticAliases(serverSrc);
    if (aliases) {
      const pagepathsSrc = read(path.join(root, 'test', 'pagepaths.mjs'));
      for (const a of pageGaps(aliases, pagepathsSrc)) {
        findings.push(
          annotate(
            `test/pagepaths.mjs: no PAGES/REDIRECTS entry for the '${a}' alias lib/server.js's serveStatic defines (test/pagepaths.mjs)`,
            'lib/server.js',
            touched,
            touchedLabel
          )
        );
      }
    }
  }

  return findings;
}

/* ------------------------------------------------------------------- run */

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        'b7e-owes                    every unpaid registration in the working tree, right now',
        'b7e-owes --rev <range>      the same, with findings the range touched marked',
        'b7e-owes < some.diff        the same annotation, read from a unified diff on stdin',
      ].join('\n')
    );
    process.exit(0);
  }

  const revIdx = argv.indexOf('--rev');
  const rev = revIdx >= 0 ? argv[revIdx + 1] : null;

  let diffText = null;
  if (!process.stdin.isTTY) {
    try {
      const chunks = [];
      for await (const c of process.stdin) chunks.push(c);
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.includes('+++ b/')) diffText = text;
    } catch {
      /* no stdin to read — fine, annotation is optional */
    }
  }

  const touched = touchedFiles({ rev, diffText });
  const touchedLabel = rev || 'the diff on stdin';

  const findings = await findAll(ROOT, { touched, touchedLabel });

  if (!findings.length) {
    console.log('nothing owed — all four registries agree with what the working tree serves and defaults');
    process.exit(0);
  }
  for (const f of findings) console.log(f);
  process.exit(1);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`[b7e-owes] ${err.stack || err.message}`);
    process.exit(2);
  });
}
