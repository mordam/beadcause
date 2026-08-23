/**
 * A handful of named suites, not the whole sweep — `bin/b7e-suite` is the argv shell;
 * this is the one thing it adds on top of `lib/gate.js`: turning what a session actually
 * types into a real suite path, or saying plainly that none exists, before a single
 * child process starts.
 *
 * bc-khoe.30.17 names seven sessions (bc-khoe.30.14, bc-khoe.53, bc-4r10.14, bc-4r10.4,
 * bc-4r10.3, bc-4r10.9, bc-eqn1.2) that each wrote a `for s in <names>; do node
 * test/$s.mjs; done` shell loop after an edit — wanting a handful of suites, not the
 * whole gate — and were refused by the worktree guard on every one of the seven: "this
 * command is too complex to verify that it stays inside the worktree", because a loop is
 * not a command a guard can read in one pass. Two of the seven also named a suite that
 * is not on disk (`readme`, `beadreqs`) and paid for it with a `MODULE_NOT_FOUND` stack
 * from `node test/<name>.mjs` rather than a plain answer. This is the one command: a
 * flat argv of names, resolved before anything runs.
 *
 * ## Reuses lib/gate.js for everything but the name
 *
 * Discovery (`discoverSuites`), the concurrent pool, the per-suite `TMPDIR` sandbox, the
 * solo suites, the timeouts and the per-tree lock are all `lib/gate.js` — the same
 * runner `bin/b7e-gate` itself uses, so a suite passing here and a suite passing in the
 * whole gate can never disagree about what passing means. The only thing this file adds
 * is resolution: `discoverSuites(root)` is the one list both a bare name and a full path
 * are checked against.
 *
 * ## Resolution, in order
 *
 * A name already in the discovered list — `test/panes.mjs`, `scripts/selftest.mjs` —
 * resolves to itself outright. A name containing `*` is a glob over the discovered list,
 * the same grammar `bin/b7e-gate --only` already uses (`*` only, never a regex — see
 * `globToRegExp` in `lib/gate.js`). Everything else is matched against the discovered
 * list by basename: a name with a directory or an extension of its own (`panes.mjs`,
 * `test/panes.mjs`) is compared basename-to-basename; a bare word (`panes`) is compared
 * stem-to-stem, so it resolves whether the real file ends in `.mjs` or `.js`
 * (`scripts/test-swap.js`, `scripts/selftest.mjs`) without this file having to guess an
 * extension. `lib/triage.js`'s `resolveSuite` already does the basename half of this for
 * a failure list handed back from a sweep; this adds the stem match a name typed by hand
 * needs, since nobody types the `.mjs` `test/panes.mjs` actually ends in.
 *
 * A name that resolves to nothing, or to more than one suite by the same stem, is
 * reported before any suite runs — never as the `node test/<name>.mjs` module-not-found
 * stack two of the seven sessions above hit.
 */
import path from 'node:path';
import { globToRegExp } from './gate.js';

/**
 * One name against `allSuites`. `{ suites: [...], missing: false }` on a match — a glob
 * can match more than one suite, everything else matches exactly one — or
 * `{ suites: [], missing: true, reason }` when nothing in the tree answers to it.
 */
export function resolveName(name, allSuites) {
  if (allSuites.includes(name)) return { suites: [name], missing: false };

  if (name.includes('*')) {
    const re = globToRegExp(name);
    const matches = allSuites.filter((s) => re.test(s));
    if (matches.length) return { suites: matches, missing: false };
    return { suites: [], missing: true, reason: `no suite matches ${name}` };
  }

  // A directory or an extension of its own makes this a path fragment, matched by
  // basename; a bare word is matched by stem, so `panes` finds `test/panes.mjs` and
  // (were it ever typed) `test-swap` finds `scripts/test-swap.js` without assuming
  // either suite's real extension.
  const isPathFragment = /[./]/.test(name);
  const matches = isPathFragment
    ? allSuites.filter((s) => path.basename(s) === path.basename(name))
    : allSuites.filter((s) => path.basename(s, path.extname(s)) === name);

  if (matches.length === 1) return { suites: matches, missing: false };
  if (matches.length === 0) return { suites: [], missing: true, reason: `no suite named ${name}` };
  return { suites: [], missing: true, reason: `${name} is ambiguous — matches ${matches.join(', ')}` };
}

/**
 * Every name in `names` resolved against `allSuites`, in the order given, deduped.
 * `resolved` is the flat suite-path list ready for `lib/gate.js`'s `runGate`; `missing`
 * is one `{ input, reason }` per name that resolved to nothing, in the order it was
 * given — the whole point being that this is checked, and reported, before any suite in
 * `resolved` gets to run.
 */
export function resolveNames(names, allSuites) {
  const resolved = [];
  const seen = new Set();
  const missing = [];
  for (const name of names) {
    const { suites, missing: isMissing, reason } = resolveName(name, allSuites);
    if (isMissing) {
      missing.push({ input: name, reason });
      continue;
    }
    for (const s of suites) {
      if (!seen.has(s)) {
        seen.add(s);
        resolved.push(s);
      }
    }
  }
  return { resolved, missing };
}
