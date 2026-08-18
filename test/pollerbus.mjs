#!/usr/bin/env node
/**
 * **The poller reaches the daemon through `app`, and only through `app`.**
 *
 *     npm test
 *     node test/pollerbus.mjs
 *
 * `startPoller(cfg, app)` is a top-level function in lib/server.js and it shares that
 * file with `createApp`, which is one enormous closure holding `bus`, `bd`, `advocates`,
 * `syncer` and the rest as plain locals. So a line that is correct three thousand lines
 * up — `bus.emit(…)` — is a `ReferenceError` down here, where the same object is only
 * reachable as `app.bus`. Nothing catches that at parse time and nothing catches it at
 * boot: it fires on a sweep, in the daemon, minutes or days later.
 *
 * It has fired. bc-gdub is `bus is not defined` out of `settleDeploys`, filed by the
 * daemon against itself, and the reason it survived review is worth writing down: the
 * suite already asserted the emit existed, by reading the source for
 * `/bus\.emit\(deployEvent\(rec/` — a pattern `app.bus.emit(deployEvent(rec` satisfies
 * just as happily as the broken line did. The guard could not tell the two apart, so it
 * stayed green through the whole life of the bug.
 *
 * Two checks here, and they fail in different ways on purpose:
 *
 * 1. **The sweep really runs.** A settled deploy record is planted on disk, a real
 *    poller is started over it, and the events it owes are read off a real bus. This is
 *    the one that would have gone red on the day: the crash lands between the board's
 *    `deploy` event and the phone's `released`/`stuck` card, so half of what a settled
 *    deploy owes arrives and half never does.
 * 2. **No daemon singleton is named bare anywhere in `startPoller`.** The class, not the
 *    instance — `settleDeploys` was one of four sites from one commit, and the other
 *    three were on paths this suite cannot cheaply drive (the sync sweep runs on its own
 *    clock, two minutes after boot). Comments are blanked before the read, because every
 *    paragraph in that file argues in prose that names these very identifiers.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (f) => path.join(ROOT, 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-pollerbus-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(path.join(process.env.BEADCAUSE_CONFIG_DIR, 'deploys'), { recursive: true });

let failures = 0;
let ran = 0;
const check = (name, fn) => {
  ran += 1;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    // Every line of it, not the first: the scope check's whole value is the list of
    // sites it found, and a message truncated to its heading would name none of them.
    for (const line of String(err.message).split('\n')) console.log(`      ${line}`);
  }
};

/* ------------------------------------------------- 1. a real sweep over a real bus */

const DEPLOYS = path.join(process.env.BEADCAUSE_CONFIG_DIR, 'deploys');
const plant = (rec) => fs.writeFileSync(path.join(DEPLOYS, `${rec.id}.json`), JSON.stringify(rec), { mode: 0o600 });

// Two settled records, because the two halves of the notification are different code
// paths: a deploy that worked is a release *and* the withdrawal of the last failure's
// warning, and a deploy that did not is a blockage that no muted space may swallow.
plant({
  id: 'd-ok',
  key: 'demo',
  workspace: 'demo',
  repo: 'widgets',
  status: 'ok',
  requestedAt: '2026-08-17T00:00:00.000Z',
  finishedAt: '2026-08-17T00:01:00.000Z',
  from: '1111111111',
  to: '2222222222',
  reason: 'a merge landed',
});
plant({
  id: 'd-bad',
  key: 'demo',
  workspace: 'demo',
  repo: 'widgets',
  status: 'failed',
  requestedAt: '2026-08-17T00:02:00.000Z',
  finishedAt: '2026-08-17T00:03:00.000Z',
  error: 'the deploy command failed (exit 1)',
});

const { startPoller } = await import(LIB('server.js'));
const { createEventBus } = await import(LIB('events.js'));

const bus = createEventBus();
const cfg = {
  baseUrl: 'http://127.0.0.1',
  token: 'pollerbus-token',
  actor: 'beadcause-test',
  workspaces: [{ name: 'demo' }],
  pollSeconds: 5,
  autoDispatch: false,
  ntfy: { enabled: false },
};

// Only what the deploy sweep's cycle actually reaches for. The advocates, the merge
// queue and the whole JIRA family are optional-chained off `app` and left out on
// purpose — a poller started without them takes its own documented defaults, which is a
// truer fixture than a stub of mine guessing at their return shapes.
const timer = startPoller(cfg, {
  bus,
  hooks: {},
  // A stand-in index rather than a throw: the adoption sweep reads `error` and says so
  // in one line, where a `bd.graph is not a function` would be noise in every run.
  bd: { comments: async () => [], removeLabel: async () => {}, graph: async () => ({ error: 'no tracker in this suite' }) },
  allQuestions: async () => [],
  warmKeys: async () => {},
  syncer: { sweep: async () => ({ skipped: [], changed: [] }), trouble: () => [] },
});

const settled = async (fn, ms = 20000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};
const events = () => bus.since(0) || [];
const seen = (type, id) => events().some((e) => e.type === type && e.id === id);

// The board's delta for the failed record is the last thing the sweep emits before the
// news, so waiting on the news alone would time out rather than tell us anything.
const arrived = await settled(() => seen('released', 'd-ok') && seen('stuck', 'd-bad'));
clearInterval(timer);

check('the settle sweep emits the board’s own delta for every record it announces', () => {
  assert.ok(
    seen('deploy', 'd-ok') && seen('deploy', 'd-bad'),
    `two deploy events (saw ${events().map((e) => `${e.type}/${e.id}`).join(', ') || 'nothing'})`
  );
});

check('a deploy that worked reaches the phone as a release', () => {
  assert.ok(arrived, `a released event for d-ok (saw ${events().map((e) => e.type).join(', ') || 'nothing'})`);
  const rel = events().find((e) => e.type === 'released' && e.id === 'd-ok');
  assert.equal(rel.workspace, 'demo');
  assert.match(rel.title, /deployed/);
});

check('and takes the last failure’s warning away with it', () => {
  const clear = events().find((e) => e.type === 'stuck' && e.id === 'd-ok');
  assert.ok(clear, 'a clearing event keyed on the repo');
  assert.equal(clear.state, 'clear');
  assert.equal(clear.source, 'deploy');
});

check('a deploy that did not reaches it as a blockage', () => {
  const bad = events().find((e) => e.type === 'stuck' && e.id === 'd-bad');
  assert.ok(bad, 'a stuck event for d-bad');
  assert.equal(bad.state, 'stuck');
  assert.equal(bad.quiet, false, 'a blockage is never quiet');
});

/* --------------------------------------- 2. nothing in the poller is named bare */

/**
 * Comments and string bodies replaced by spaces of the same length, so every offset
 * still lands on the line it came from and a hit can be reported where it really is.
 *
 * Strings as well as comments: a route path or a log line that happens to contain one
 * of these words is not a reference to the object. Template literals are tracked with
 * their `${…}` holes left alone, because an interpolation *is* code and a bare `bus`
 * inside one would be exactly the bug this is looking for.
 */
function blank(src) {
  const out = src.split('');
  const wipe = (a, b) => {
    for (let i = a; i < b; i += 1) if (out[i] !== '\n') out[i] = ' ';
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j += 1;
      wipe(i, j);
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      const at = src.indexOf('*/', i + 2);
      const j = at === -1 ? n : at + 2;
      wipe(i, j);
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === c || src[j] === '\n') break;
        j += 1;
      }
      wipe(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '`' && depth === 0) break;
        if (src[j] === '$' && src[j + 1] === '{') {
          depth += 1;
          j += 2;
          continue;
        }
        if (src[j] === '}' && depth > 0) {
          depth -= 1;
          j += 1;
          continue;
        }
        if (depth === 0 && src[j] !== '\n') out[j] = ' ';
        j += 1;
      }
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/**
 * The daemon's singletons, as `createApp` hands them over.
 *
 * `handler` is deliberately not in this list, and it is the only omission: it is an
 * ordinary English word for an ordinary local, and a future `const handler = …` inside
 * a sweep would be a false red rather than a bug. Everything else here names one object
 * that exists once per daemon, so a bare mention of one inside `startPoller` is a
 * mistake every time.
 */
const SINGLETONS = [
  'allQuestions',
  'foundationRequests',
  'agentBeads',
  'warmKeys',
  'forgetInbox',
  'splitChannels',
  'bd',
  'hooks',
  'bus',
  'advocates',
  'syncer',
  'jira',
  'jiraEpics',
  'jiraResolved',
  'jiraIngest',
  'runMergeQueue',
];

const SERVER = fs.readFileSync(LIB('server.js'), 'utf8');
const blanked = blank(SERVER);
const from = blanked.indexOf('export function startPoller(cfg, app) {');
// The function ends at the first line that is exactly `}` — every top-level declaration
// in this file closes that way, and nothing nested inside one is indented to column 0.
const to = blanked.indexOf('\n}\n', from) + 2;
const poller = from === -1 ? '' : blanked.slice(from, to);
const lineAt = (off) => SERVER.slice(0, off).split('\n').length;

check('the poller is where this suite thinks it is', () => {
  assert.notEqual(from, -1, 'startPoller(cfg, app) is declared in lib/server.js');
  assert.ok(to > from, 'and its body has an end');
  assert.ok(poller.includes('const settleDeploys'), 'and settleDeploys is inside it');
});

check('no daemon singleton is named bare inside startPoller — it is only reachable as app.x', () => {
  const bare = [];
  for (const name of SINGLETONS) {
    const re = new RegExp(`(^|[^.\\w$])${name}\\b`, 'g');
    let m;
    while ((m = re.exec(poller))) {
      const off = from + m.index + m[1].length;
      bare.push(`${name} at lib/server.js:${lineAt(off)} — ${SERVER.split('\n')[lineAt(off) - 1].trim().slice(0, 80)}`);
    }
  }
  // `ok` rather than `deepEqual` so the sites are the whole of the message: an assertion
  // diff of two arrays would push the one useful line off the top of the output.
  assert.ok(bare.length === 0, `every one of these is a ReferenceError at runtime:\n  ${bare.join('\n  ')}`);
});

// A guard which cannot fail is one nobody should trust — so the read is proved against
// the bug it exists for, rather than against the fixed source alone.
check('and that read really does catch the line bc-gdub was filed for', () => {
  const broken = blank(SERVER.replace('app.bus.emit(deployEvent(rec', 'bus.emit(deployEvent(rec'));
  const start = broken.indexOf('export function startPoller(cfg, app) {');
  const slice = broken.slice(start, broken.indexOf('\n}\n', start) + 2);
  assert.match(slice, /(^|[^.\w$])bus\b/, 'a bare `bus` in the poller is seen');
});

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* a temp directory that will not go is not a test failure */
}

console.log(`\n${ran - failures}/${ran} checks passed`);
process.exit(failures ? 1 : 0);
