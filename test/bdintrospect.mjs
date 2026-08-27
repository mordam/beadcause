#!/usr/bin/env node
//
// b7e-bd — which call does this to a bead: the Bd wrapper method, the argv it spawns,
// and what the installed bd actually accepts (bc-dgx7.20). lib/bdintrospect.js does the
// work: it parses lib/bd.js (never executes it) for every Bd method and the exact bd
// argv each one spawns, searches that the same way lib/already.js already searches
// lib/ (b7e-already, bc-dgx7.81), and separately searches the installed bd's own
// --help text — top level and per-subcommand — so an intent with no Bd wrapper at all
// still finds the raw flag that answers it.
//
//   npm test
//   node test/bdintrospect.mjs
//
// The source-parse half is pinned against the real lib/bd.js on purpose — the bead's
// own acceptance names three concrete methods (addLabel, update, heartbeat/reclaim) and
// the whole point of this tool is that those answers are exactly right today, not
// approximately right against a fabricated fixture. The raw-bd half is driven against a
// fake `bd --help` (an injectable `exec`, never a real spawn) so it stays deterministic
// regardless of which bd version happens to be installed on the machine running this.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const {
  bdMethods,
  tokenize,
  searchMethods,
  scoreEntry,
  bdTopLevelCommands,
  matchRawCommands,
  helpForArgv,
  checkFlagsSupported,
  matchNotes,
} = await import(path.join(ROOT, 'lib', 'bdintrospect.js'));

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
};

console.log('\nb7e-bd — lib/bdintrospect.js\n');

/* ------------------------------------------------- source-parse against real lib/bd.js */

const methods = bdMethods(ROOT);

check('finds a real, non-trivial number of Bd methods in the actual lib/bd.js', () => {
  assert.ok(methods.length > 30, `expected more than 30 methods, found ${methods.length}`);
  assert.ok(methods.every((m) => m.file === 'lib/bd.js'));
  assert.ok(methods.every((m) => Number.isInteger(m.line) && m.line > 0));
});

check('addLabel resolves to exactly `bd label add <id> <label>`, in that order — the bead\'s own acceptance', () => {
  const addLabel = methods.find((m) => m.shortName === 'addLabel');
  assert.ok(addLabel, 'Bd.addLabel not found by moduleSurface');
  assert.equal(addLabel.calls.length, 1);
  assert.deepEqual(addLabel.calls[0].argv, ['label', 'add', '<id>', '<label>']);
  assert.equal(addLabel.calls[0].retries, 3);
});

check('an intent search for "label" surfaces addLabel', () => {
  const hits = searchMethods(methods, tokenize('label'));
  assert.ok(
    hits.some((m) => m.shortName === 'addLabel'),
    `addLabel missing from: ${hits.map((m) => m.shortName).join(', ')}`
  );
});

check('"reparent" matches no Bd method — update never pushes --parent, and adopt/graph do not surface on a first-doc-line search', () => {
  const hits = searchMethods(methods, tokenize('reparent'));
  assert.deepEqual(
    hits.map((m) => m.shortName),
    [],
    'the bead\'s own acceptance is that no Bd method wraps "reparent"'
  );
});

check('update() builds its argv from a local accumulator — resolved base plus every conditional push, and none of them is --parent', () => {
  const update = methods.find((m) => m.shortName === 'update');
  assert.ok(update);
  assert.equal(update.calls.length, 1);
  const call = update.calls[0];
  assert.deepEqual(call.argv, ['update', '<id>']);
  assert.ok(call.dynamic);
  assert.ok(Array.isArray(call.pushes) && call.pushes.length > 5, 'expected several conditional pushes');
  const flags = call.pushes.map((p) => p.args[0]);
  assert.ok(flags.includes('--title'));
  assert.ok(!flags.includes('--parent'), 'update must not itself push --parent — adopt() owns that flag');
});

check('create()\'s second call site (`args.filter(...)`) resolves off the same accumulator, not as a fake bd verb', () => {
  const create = methods.find((m) => m.shortName === 'create');
  assert.ok(create);
  assert.equal(create.calls.length, 2);
  const [first, second] = create.calls;
  assert.equal(first.argv[0], 'create');
  // The bug this guards: before the fix, an argv built from `args.filter(...)` fell
  // through to the raw-source-text fallback and printed as a single fake argv[0]
  // element — `bd args.filter((a) => a !== NO_INHERIT_LABELS)`, which is not a real
  // bd verb. It must resolve off the same `args` accumulator the first call uses.
  assert.equal(second.argv[0], 'create');
  assert.deepEqual(second.argv, first.argv);
  assert.match(second.note || '', /args\.filter/);
});

check('reopenAbandoned resolves to the --force update call, by --method reverse lookup', () => {
  const found = methods.find((m) => m.shortName === 'reopenAbandoned');
  assert.ok(found);
  assert.equal(found.calls.length, 1);
  assert.ok(found.calls[0].argv.includes('--force'));
  assert.equal(found.calls[0].retries, 3);
});

check('closeAnswered has more than one bd call site (the plain close and the --force fallback)', () => {
  const found = methods.find((m) => m.shortName === 'closeAnswered');
  assert.ok(found);
  assert.ok(found.calls.length >= 2, `expected >=2 call sites, got ${found.calls.length}`);
  assert.ok(found.calls.some((c) => c.argv.includes('--force')));
});

check('a method with no direct bd call (delegates to another Bd method) reports an empty calls list, not a crash', () => {
  const found = methods.find((m) => m.shortName === 'respond');
  assert.ok(found, 'Bd.respond not found');
  assert.deepEqual(found.calls, []);
});

check('searchMethods is scoreEntry from lib/already.js, unmodified — reusing the identical convention', () => {
  const entry = { name: 'Bd.addLabel', doc: 'bd label add <issue-id...> <label>' };
  assert.equal(scoreEntry(entry, ['label']), 1);
  assert.equal(scoreEntry(entry, ['nope', 'label']), 1);
});

/* --------------------------------------------------------------------- raw bd, faked */

/** A tiny fake `bd --help` / `bd <verb> --help` surface, close enough to the real
 * cobra layout to exercise bdTopLevelCommands' section parsing and the boundary-aware
 * scoring — including the exact "release" vs "lease" collision this suite guards. */
const FAKE_TOP_HELP = `Issues chained together like beads.

Working With Issues:
  update            Update one or more issues
  reclaim           Revert stale-lease in_progress issues back to ready (dead-worker recovery)
  release-notes     Generate release notes from closed issues since a tag
  label             Manage issue labels

Flags:
      --actor string   Actor name for audit trail
  -h, --help            help for bd
`;

const FAKE_SUB_HELP = {
  update: `Update one or more issues.

Usage:
  bd update [id...] [flags]

Flags:
      --parent string   New parent issue ID (reparents the issue, use empty string to remove parent)
      --status string   New status
`,
  reclaim: `Revert in_progress issues whose lease has gone stale back to ready.

Usage:
  bd reclaim [flags]

Flags:
      --older-than duration   grace window
`,
  'release-notes': `Generate release notes from closed issues since a tag.

Usage:
  bd release-notes [flags]
`,
  label: `Manage issue labels

Usage:
  bd label [command]

Available Commands:
  add         Add one or more labels to one or more issues
  remove      Remove one or more labels from one or more issues
`,
  'label add': `Add labels to issues.

Usage:
  bd label add [issue-id...] [label...] [flags]

Flags:
  -h, --help   help for add
`,
};

function fakeExec(_bin, args) {
  if (args.length === 1 && args[0] === '--help') return FAKE_TOP_HELP;
  const key = args.slice(0, -1).join(' '); // drop the trailing --help
  if (args[args.length - 1] !== '--help' || !(key in FAKE_SUB_HELP)) {
    const err = new Error(`fake bd: unsupported ${args.join(' ')}`);
    throw err;
  }
  return FAKE_SUB_HELP[key];
}

check('bdTopLevelCommands parses the cobra section shape and skips the Flags: lines', () => {
  const cmds = bdTopLevelCommands(FAKE_TOP_HELP);
  assert.deepEqual(
    cmds.map((c) => c.name),
    ['update', 'reclaim', 'release-notes', 'label']
  );
  assert.ok(!cmds.some((c) => c.name === 'actor' || c.name === 'help'), 'a Flags: line must never be read as a subcommand');
});

check('"lease" finds reclaim (real match) and does not false-positive on release-notes ("re-lease")', () => {
  const hits = matchRawCommands('fake-bd', tokenize('lease'), { exec: fakeExec });
  const names = hits.map((h) => h.name);
  assert.ok(names.includes('reclaim'), `expected reclaim among: ${names.join(', ')}`);
  assert.ok(!names.includes('release-notes'), `release-notes must not match "lease": ${names.join(', ')}`);
});

check('"reparent" finds update, by its --parent flag description, and nothing else', () => {
  const hits = matchRawCommands('fake-bd', tokenize('reparent'), { exec: fakeExec });
  assert.deepEqual(
    hits.map((h) => h.name),
    ['update']
  );
  assert.ok(hits[0].matchedLines.some((l) => l.includes('reparents')));
});

check('a command whose own name matches outranks one that only matches deep in its help text', () => {
  const hits = matchRawCommands('fake-bd', tokenize('label'), { exec: fakeExec });
  assert.equal(hits[0].name, 'label');
});

check('helpForArgv descends one level for a two-part verb (label add) but not for a plain one (update)', () => {
  const leaf = helpForArgv('fake-bd', ['label', 'add', '<id>', '<label>'], { exec: fakeExec });
  assert.match(leaf, /help for add/);
  const top = helpForArgv('fake-bd', ['update', '<id>', '--parent', '<parent>'], { exec: fakeExec });
  assert.match(top, /New parent issue ID/);
});

check('checkFlagsSupported flags a wrapper flag the installed bd no longer advertises', () => {
  const helpText = FAKE_SUB_HELP.update;
  const supported = checkFlagsSupported(['update', '<id>', '--parent', '<p>', '--force'], helpText);
  assert.deepEqual(
    supported.sort((a, b) => a.flag.localeCompare(b.flag)),
    [
      { flag: 'force', supported: false },
      { flag: 'parent', supported: true },
    ]
  );
});

/* ------------------------------------------------------------------- memory notes */

const FAKE_NOTES = {
  'two-lease-concepts-native-bd-vs-held-label': 'beadcause now touches TWO independent "lease" concepts...',
  'release-checklist': 'What a release actually ships, end to end.',
  'a-dead-window-is-pinned-by-a-workers-not-by-any-name-guard': 'mentions lease only in passing, deep in the text about lease renewal',
};

check('matchNotes ranks a key match over a text-only match, and the key beats "release" too', () => {
  const hits = matchNotes(FAKE_NOTES, tokenize('lease'));
  assert.equal(hits[0].key, 'two-lease-concepts-native-bd-vs-held-label');
  assert.ok(!hits.some((h) => h.key === 'release-checklist'), '"release" must not satisfy the query "lease"');
});

console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
