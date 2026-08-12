#!/usr/bin/env node
/**
 * A branch that ships two coupled shell files under an unchanged cache version.
 *
 *     npm test
 *     node test/swbump.mjs
 *     node test/swbump.mjs --base <rev> --head <rev>   # any two revisions
 *
 * The check itself is `lib/swbump.js`, which reads nothing — this file is the half that
 * knows about git. It does three things, in this order:
 *
 * 1. Unit checks over fixtures, including the two shapes that decide the whole design:
 *    a member gained in one shell file and called in another (fails), and a file added
 *    whole with everything that uses it (says nothing, because a cache from before the
 *    branch has neither half).
 * 2. The two real branches the rule was written from, if this clone still has them —
 *    bc-dmt's head, which must flag `console.js` + `sendqueue.js`, and bc-p38c.2's
 *    additive `report.js`, which must not fail anything.
 * 3. **This branch**, against the `main` it grew from, working tree included. That is
 *    the part with teeth, and the reason this is a suite rather than a script: the
 *    session that is about to deliver runs `npm test` and gates on its exit code.
 *
 * The advisory half never fails the run. It over-reports by construction — "two shell
 * files moved" is not the same claim as "a phone can hold a broken half of them" — and
 * a check that cries wolf on every second branch gets ignored, which is worse than not
 * having it. Only the call-on-a-member-the-other-half-lacks case is red, because that
 * one is a `TypeError` rather than an opinion.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyse, cacheVersion, memberCalls, memberDefs, report, shellFiles } from '../lib/swbump.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let failures = 0;
let ran = 0;
const ok = (name) => {
  ran += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
};
const bad = (name, detail) => {
  ran += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  for (const line of String(detail || '').split('\n')) if (line) console.log(`      ${line}`);
};
const note = (line) => console.log(`  \x1b[90m·\x1b[0m ${line}`);
const check = (name, fn) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const gitQuiet = (args) => {
  try {
    return git(args);
  } catch {
    return null;
  }
};
const hasRev = (rev) => gitQuiet(['cat-file', '-e', `${rev}^{commit}`]) !== null;

/**
 * Everything `analyse` needs about one range, read out of git.
 *
 * `head` may be null, meaning the working tree — which is what the live check wants: a
 * session runs the suite before it commits, and a warning that only arrives after the
 * commit is a warning about work that is already written down.
 */
function collect(base, head) {
  const range = head ? [base, head] : [base];
  const status = gitQuiet(['diff', '--name-status', ...range]);
  if (status === null) return null;
  const entries = [];
  for (const line of status.split('\n')) {
    if (!line.trim()) continue;
    const [code, ...rest] = line.split('\t');
    // A rename arrives as R### old new; the new path is the one that gets cached.
    const p = rest[rest.length - 1];
    entries.push({ path: p, status: code[0] === 'R' ? 'A' : code[0] });
  }
  if (!head) {
    for (const p of (gitQuiet(['ls-files', '--others', '--exclude-standard']) || '').split('\n')) {
      if (p.trim()) entries.push({ path: p.trim(), status: 'A' });
    }
  }
  const show = (rev, p) => gitQuiet(['show', `${rev}:${p}`]) ?? '';
  const at = (p) => (head ? show(head, p) : fs.existsSync(path.join(ROOT, p)) ? fs.readFileSync(path.join(ROOT, p), 'utf8') : '');
  const added = (p) => {
    const d = gitQuiet(['diff', '-U0', ...range, '--', p]) || '';
    return d.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
  };
  const swBase = show(base, 'public/sw.js');
  const swHead = at('public/sw.js');
  // Only the cached files are ever read. A branch that moved the README and a dozen
  // suites is the ordinary case here, and reading both revisions of half a megabyte of
  // prose to decide it is not in SHELL is a second of `npm test` spent on nothing.
  const shell = shellFiles(swHead || swBase);
  return {
    swBase,
    swHead,
    files: entries.map((f) => (shell.has(f.path)
      ? {
        ...f,
        base: f.status === 'A' ? '' : show(base, f.path),
        head: f.status === 'D' ? '' : at(f.path),
        added: added(f.path),
      }
      : { ...f, base: '', head: '', added: [] })),
  };
}

const argv = process.argv.slice(2);
const argAt = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1] || null;
};

console.log('\nthe cache version against the pair of files it gates\n');

// ---------------------------------------------------------------- reading public/sw.js

const sw = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');

check('SHELL parses to the files it names', () => {
  const files = shellFiles(sw);
  if (files.size < 10) throw new Error(`only ${files.size} files parsed out of SHELL — the array moved or the format changed`);
  for (const want of ['public/console.js', 'public/sendqueue.js', 'public/style.css']) {
    if (!files.has(want)) throw new Error(`${want} is in SHELL but did not parse out of it`);
    if (!fs.existsSync(path.join(ROOT, want))) throw new Error(`${want} parsed out of SHELL but is not on disk`);
  }
});

check('the cache version reads off the one line every other suite matches', () => {
  const v = cacheVersion(sw);
  if (!/^beadcause-v\d+$/.test(String(v))) throw new Error(`const CACHE read as ${JSON.stringify(v)}`);
});

// ------------------------------------------------------------------------- the reading

check('prose in a comment is not a definition — the trap bc-w122 nearly fell into', () => {
  const src = [
    '// Cleared before anything is told about the failure, so a caller that repaints',
    ' * Callers pass this on every repaint, so it has to be cheap and idempotent.',
    'const x = 1; // repaint: announce,',
  ].join('\n');
  if (memberDefs(src).has('repaint')) throw new Error('a comment mentioning repaint was read as defining it');
  if (memberCalls(['   * moving repaints nothing, and forward is `repaint()` on its queue.']).has('repaint')) {
    throw new Error('a comment mentioning repaint() was read as calling it');
  }
});

check('a key, a method and a member assignment are all definitions', () => {
  const defs = memberDefs(['  repaint: announce,', '  drainQueue(item) {', '  this.pending = [];'].join('\n'));
  for (const want of ['repaint', 'drainQueue', 'pending']) {
    if (!defs.has(want)) throw new Error(`${want} was not read as a definition`);
  }
});

check('a call is a call and a bare read is not', () => {
  const calls = memberCalls(['    chat.queue.repaint();', '    const n = chat.queue.pending;', '    thing?.repaint();']);
  if (!calls.has('repaint')) throw new Error('.repaint() was not read as a call');
  if (calls.has('pending')) throw new Error('a bare .pending read was counted as a call');
});

// ------------------------------------------------------------------------- the verdict

const SW = (version, extra = []) =>
  [`const CACHE = '${version}';`, 'const SHELL = [', "  '/console.js',", "  '/sendqueue.js',", "  '/report.js',", ...extra, '];'].join('\n');

check('a member gained in one shell file and called in another fails, unbumped', () => {
  const r = analyse({
    swBase: SW('beadcause-v37'),
    swHead: SW('beadcause-v37'),
    files: [
      { path: 'public/sendqueue.js', status: 'M', base: '// nothing about repaint yet\n', head: '  repaint: announce,\n', added: ['  repaint: announce,'] },
      { path: 'public/console.js', status: 'M', base: 'const a = 1;\n', head: 'chat.queue.repaint();\n', added: ['    chat.queue.repaint();'] },
    ],
  });
  if (r.couplings.length !== 1) throw new Error(`expected one coupling, got ${JSON.stringify(r.couplings)}`);
  const [c] = r.couplings;
  if (c.member !== 'repaint' || c.defines !== 'public/sendqueue.js' || c.calls !== 'public/console.js') {
    throw new Error(`the coupling names the wrong halves: ${JSON.stringify(c)}`);
  }
});

check('the same branch with the version moved says nothing at all', () => {
  const r = analyse({
    swBase: SW('beadcause-v37'),
    swHead: SW('beadcause-v38'),
    files: [
      { path: 'public/sendqueue.js', status: 'M', base: '', head: '  repaint: announce,\n', added: ['  repaint: announce,'] },
      { path: 'public/console.js', status: 'M', base: '', head: '', added: ['    chat.queue.repaint();'] },
    ],
  });
  if (r.couplings.length || r.advisory) throw new Error(`a bumped branch was still flagged: ${JSON.stringify(r)}`);
});

check('an edit to sw.js that leaves the version alone is not a bump', () => {
  const r = analyse({
    swBase: SW('beadcause-v37'),
    swHead: SW('beadcause-v37', ["  '/added.js',"]),
    files: [
      { path: 'public/sendqueue.js', status: 'M', base: '', head: '  repaint: announce,\n', added: ['  repaint: announce,'] },
      { path: 'public/console.js', status: 'M', base: '', head: '', added: ['    chat.queue.repaint();'] },
    ],
  });
  if (!r.couplings.length) throw new Error('a branch that edited sw.js without moving CACHE was let through');
});

check('a file added whole, with its callers, is never a mixed pair', () => {
  const r = analyse({
    swBase: SW('beadcause-v37'),
    swHead: SW('beadcause-v37'),
    files: [
      { path: 'public/report.js', status: 'A', base: '', head: '  send(err) {\n', added: ['  send(err) {'] },
      { path: 'public/console.js', status: 'M', base: '', head: '', added: ['    report.send(err);'] },
    ],
  });
  if (r.couplings.length) throw new Error(`an added file was treated as a cached older half: ${JSON.stringify(r.couplings)}`);
});

check('a call the calling file answers itself is not a coupling', () => {
  const r = analyse({
    swBase: SW('beadcause-v37'),
    swHead: SW('beadcause-v37'),
    files: [
      { path: 'public/sendqueue.js', status: 'M', base: '', head: '  repaint: announce,\n', added: ['  repaint: announce,'] },
      { path: 'public/console.js', status: 'M', base: '', head: '  repaint() {}\n', added: ['    this.repaint();'] },
    ],
  });
  if (r.couplings.length) throw new Error('a file calling its own method was paired with a sibling');
});

check('one shell file on its own is not an advisory', () => {
  const r = analyse({
    swBase: SW('beadcause-v37'),
    swHead: SW('beadcause-v37'),
    files: [{ path: 'public/console.js', status: 'M', base: 'a', head: 'b', added: ['b'] }],
  });
  if (r.advisory) throw new Error('a single changed file was reported as a pair');
});

check('files outside SHELL are not counted', () => {
  const r = analyse({
    swBase: SW('beadcause-v37'),
    swHead: SW('beadcause-v37'),
    files: [
      { path: 'lib/console.js', status: 'M', base: 'a', head: 'b', added: ['b'] },
      { path: 'test/console.mjs', status: 'M', base: 'a', head: 'b', added: ['b'] },
      { path: 'public/presence.js', status: 'M', base: 'a', head: 'b', added: ['b'] },
    ],
  });
  if (r.advisory || r.changed.length) throw new Error(`counted files SHELL does not cache: ${JSON.stringify(r.changed)}`);
});

check('the advisory names every file and the failure names both halves', () => {
  const advisory = report({ bumped: false, version: { after: 'beadcause-v37' }, changed: ['public/a.js', 'public/b.js'], advisory: true, couplings: [] });
  if (!advisory.join('\n').includes('public/b.js')) throw new Error('the advisory did not name the files');
  const hard = report({ bumped: false, version: { after: 'beadcause-v37' }, changed: [], advisory: false, couplings: [{ member: 'repaint', defines: 'public/sendqueue.js', calls: 'public/console.js' }] });
  const text = hard.join('\n');
  for (const want of ['repaint', 'public/sendqueue.js', 'public/console.js']) {
    if (!text.includes(want)) throw new Error(`the failure text does not name ${want}`);
  }
});

// -------------------------------------------------------- the two branches it comes from

/** bc-dmt (#115): the miss this whole file exists because of. */
const DMT = '65745de5';
/** bc-p38c.2: report.js onto all twelve pages, and it owed no bump. */
const P38C = 'cbfd7367';

if (hasRev(DMT) && hasRev(`${DMT}^2`)) {
  check(`bc-dmt (${DMT.slice(0, 7)}) is flagged: console.js calls a key sendqueue.js only gained on that branch`, () => {
    const r = analyse(collect(`${DMT}^2`, DMT));
    const hit = r.couplings.find((c) => c.member === 'repaint');
    if (!hit) throw new Error(`the repaint coupling was not found; couplings: ${JSON.stringify(r.couplings)}`);
    if (hit.defines !== 'public/sendqueue.js' || hit.calls !== 'public/console.js') throw new Error(`wrong halves: ${JSON.stringify(hit)}`);
  });
} else {
  note(`bc-dmt (${DMT.slice(0, 7)}) is not in this clone — skipped`);
}

if (hasRev(P38C)) {
  check(`bc-p38c.2 (${P38C.slice(0, 7)}) adding report.js to every page fails nothing`, () => {
    const r = analyse(collect(`${P38C}^`, P38C));
    if (r.couplings.length) throw new Error(`a purely additive branch was failed: ${JSON.stringify(r.couplings)}`);
  });
} else {
  note(`bc-p38c.2 (${P38C.slice(0, 7)}) is not in this clone — skipped`);
}

// ------------------------------------------------------------------------- this branch

const baseArg = argAt('--base');
const headArg = argAt('--head');
const base = baseArg || (() => {
  const upstream = hasRev('origin/main') ? 'origin/main' : hasRev('main') ? 'main' : null;
  if (!upstream) return null;
  return (gitQuiet(['merge-base', upstream, 'HEAD']) || '').trim() || null;
})();

console.log('');
if (!base) {
  note('no main to compare against — the live check needs origin/main or main');
} else {
  const data = collect(base, headArg);
  if (!data) {
    note('git would not describe this range — the live check was skipped');
  } else {
    const r = analyse(data);
    const short = baseArg || base.slice(0, 8);
    const where = headArg ? `${short}..${headArg}` : `${short}..working tree`;
    const lines = report(r);
    if (r.couplings.length) {
      bad(`this branch (${where}) ships a pair the cache version does not separate`, lines.join('\n'));
    } else if (r.advisory) {
      ok(`this branch (${where}) ships no pair that must break — read the advisory below`);
      console.log('');
      for (const line of lines) console.log(`  \x1b[33m!\x1b[0m ${line}`);
      console.log('');
    } else {
      ok(`this branch (${where}) is not shipping a broken pair`);
    }
  }
}

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
