#!/usr/bin/env node
/**
 * **What a failed answer may claim** — *nothing was written* over a merge that landed.
 *
 *     npm test
 *     node test/landednote.mjs
 *
 * An answer on the phone is several acts in a row, and the answer itself is written
 * **last**: the merge, the endorsement, the beads a "yes" files all run before
 * `bd.respond`, deliberately, because a merge GitHub refuses has to leave the question
 * answerable and a question closed on a promise nobody kept is the ending this app was
 * built to prevent.
 *
 * The cost of that ordering is a window. Between the last act and the write there is a
 * second in which the act has happened and the answer has not — bd unreachable, the
 * daemon restarted underneath the request, a 500 — and the card drew every refused write
 * with one sentence: *Nothing was written and nothing was lost. What you typed is still
 * in the box below.* Over a delivery card that is a claim it cannot make. The pull
 * request is merged, the branch is gone, the work bead is closed, and the phone is
 * telling Adam to try again.
 *
 * bc-s2d8 closed the one path that reached it in practice (`gh` failing to delete a
 * local branch after a merge that landed). This is the class, and the fix is that the
 * failure carries what already happened:
 *
 * 1. **The acts are collected before the answer is written** — `performed` in
 *    lib/server.js, built from the notes the thread would have carried, so there is one
 *    account of the act rather than two that can disagree.
 * 2. **A failure of the answer takes them with it**, out through the handler's own catch
 *    as `landed` on the JSON body.
 * 3. **Wherever in the write it fell over** — `bd.respond` is a comment, then a close,
 *    then the mention sweep, and a bd that dies at any of the three is one refusal as far
 *    as the card is concerned.
 * 4. **And an ordinary failure still says nothing was written**, because it is true, and
 *    a note that hedged on every refusal would teach you to ignore the one that matters.
 *
 * The whole path is real — a `POST /api/respond` through `createApp`, with `bd` and `gh`
 * as fakes. The card's half is `failedNoteHtml` in public/app.js, lifted into a vm at the
 * bottom of this file, and proven in a browser by `scripts/absorb-check.mjs`.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-landednote-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

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
  if (detail) console.log(`      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

const { deliveryBody } = await import(LIB('delivery.js'));
const { MERGE_SWEEPS_PATH } = await import(LIB('mergesweep.js'));

/* ---------------------------------------------------------------- the fake bd */

const WORLD = path.join(tmp, 'world.json');
const BREAK = path.join(tmp, 'break.json');
const FAKE_BD = path.join(tmp, 'bd');
const world = () => JSON.parse(fs.readFileSync(WORLD, 'utf8'));
const writeWorld = (w) => fs.writeFileSync(WORLD, JSON.stringify(w, null, 2));
/** Which subcommands this bd is currently refusing, and for which beads. */
const breaks = (b) => fs.writeFileSync(BREAK, JSON.stringify(b));

fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const WORLD = ${JSON.stringify(WORLD)};
const args = process.argv.slice(2);
const w = JSON.parse(fs.readFileSync(WORLD, 'utf8'));
const brk = JSON.parse(fs.readFileSync(${JSON.stringify(BREAK)}, 'utf8'));
const save = () => fs.writeFileSync(WORLD, JSON.stringify(w, null, 2));
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1]; };
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
const hydrate = (i) => ({ ...i, dependencies: (i.dependencies || []).map((d) => ({ ...d, status: (w.issues[d.id] || {}).status || 'closed' })) });

// The daemon going away underneath the request, wherever it is asked to. Every fake
// refusal in this file is this one line: bd is simply not there any more.
if ((brk.subcommands || []).includes(args[0]) && (!brk.only || brk.only.includes(args[1]))) {
  die('bd: could not open database: resource temporarily unavailable');
}

if (args[0] === 'show') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error fetching ' + args[1] + ': no issue found');
  process.stdout.write(JSON.stringify([hydrate(issue)]));
  process.exit(0);
}
if (args[0] === 'comments') { process.stdout.write('[]'); process.exit(0); }
if (args[0] === 'close') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  issue.status = 'closed';
  issue.close_reason = flag('--reason') || '';
  save();
  process.exit(0);
}
if (args[0] === 'comment') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  (issue.comments = issue.comments || []).push(args[2]);
  save();
  process.exit(0);
}
if (args[0] === 'dep' && args[1] === 'remove') {
  const issue = w.issues[args[2]];
  if (!issue) die('no such issue ' + args[2]);
  issue.dependencies = (issue.dependencies || []).filter((d) => d.id !== args[3]);
  save();
  process.exit(0);
}
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

/* ---------------------------------------------------------------- the fake gh */

const BIN = path.join(tmp, 'bin');
fs.mkdirSync(BIN, { recursive: true });
const PR_STATE = path.join(tmp, 'pr.json');
const rawPR = () => ({
  number: 7,
  title: 'Something small',
  url: 'https://github.com/acme/widgets/pull/7',
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  headRefName: 'bead/zz-work',
  baseRefName: 'main',
  additions: 4,
  deletions: 1,
  changedFiles: 1,
  statusCheckRollup: [],
  reviewDecision: null,
  mergedAt: null,
  mergeCommit: null,
});
fs.writeFileSync(PR_STATE, JSON.stringify(rawPR()));

fs.writeFileSync(
  path.join(BIN, 'gh'),
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const out = (s) => { process.stdout.write(s); process.exit(0); };
if (args[0] === 'auth') out('Logged in to github.com\\n');
if (args[0] === 'pr') {
  const pr = JSON.parse(fs.readFileSync(${JSON.stringify(PR_STATE)}, 'utf8'));
  if (args[1] === 'view') out(JSON.stringify(pr));
  if (args[1] === 'merge') {
    pr.state = 'MERGED';
    pr.mergedAt = '2026-08-10T12:00:00Z';
    pr.mergeCommit = { oid: 'c5004cceabcdef01' };
    fs.writeFileSync(${JSON.stringify(PR_STATE)}, JSON.stringify(pr));
    out('Merged pull request #7\\n');
  }
  if (args[1] === 'comment' || args[1] === 'close') out('done\\n');
}
process.stderr.write('unknown gh invocation: ' + args.join(' ') + '\\n');
process.exit(1);
`,
  { mode: 0o755 }
);
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;

/* ------------------------------------------------------------------ the daemon */

const wsDir = path.join(tmp, 'ws');
fs.mkdirSync(path.join(wsDir, '.beads'), { recursive: true });
const SESSIONS = path.join(tmp, 'claude', 'sessions');
fs.mkdirSync(SESSIONS, { recursive: true });

const cfg = {
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'landednote-token',
  actor: 'beadcause-test',
  bdBin: FAKE_BD,
  workspaces: [{ name: 'demo', dir: wsDir }],
  sessionDirs: { demo: wsDir },
  openSessions: false,
  autoDispatch: false,
  claudeSessionsDir: SESSIONS,
  pollSeconds: 3600,
  terminal: false,
  port: 0,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const { createApp, listen } = await import(LIB('server.js'));
const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const port = await boundPort(servers);

const post = (pathname, body) =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'x-beadcause-token': cfg.token,
        },
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(out || '{}') }));
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });

const DELIVERY = {
  workspace: 'demo',
  bead: 'zz-work',
  repo: 'acme/widgets',
  number: 7,
  url: 'https://github.com/acme/widgets/pull/7',
  branch: 'bead/zz-work',
  base: 'main',
  method: 'merge',
  summary: 'Something small.',
};

/** The tracker as a delivery leaves it, plus one card that is only ever a question. */
const reset = () => {
  fs.rmSync(MERGE_SWEEPS_PATH, { force: true });
  fs.writeFileSync(PR_STATE, JSON.stringify(rawPR()));
  breaks({ subcommands: [] });
  writeWorld({
    issues: {
      'zz-pr': {
        id: 'zz-pr',
        title: 'Merge #7?',
        description: deliveryBody(DELIVERY),
        labels: ['human', 'pr-delivery'],
        status: 'open',
        issue_type: 'task',
        dependencies: [],
        comment_count: 0,
      },
      'zz-work': {
        id: 'zz-work',
        title: 'The work',
        description: '',
        labels: [],
        status: 'in_progress',
        issue_type: 'task',
        dependencies: [{ id: 'zz-pr', dependency_type: 'blocks' }],
      },
      'zz-ask': {
        id: 'zz-ask',
        title: 'Which of these two?',
        description: 'An ordinary question with no act behind it.',
        labels: ['human'],
        status: 'open',
        issue_type: 'task',
        dependencies: [],
        comment_count: 0,
      },
    },
  });
};

const MERGE = 'MERGE: merge #7, then close zz-work.';
const merged = () => JSON.parse(fs.readFileSync(PR_STATE, 'utf8')).state === 'MERGED';

/* ========================================================== the merge that landed */

console.log('\nthe merge landed and the answer did not\n');

{
  reset();
  // bd goes away between the merge and the comment. Nothing else about the request
  // changes: this is exactly the daemon-restarted, database-locked second.
  breaks({ subcommands: ['comment'] });
  const res = await post('/api/respond', { workspace: 'demo', id: 'zz-pr', response: MERGE });

  check('the answer is reported as having failed', res.status >= 500, `${res.status} ${JSON.stringify(res.json)}`);
  check('and it is, in fact, merged', merged(), 'the pull request is still open');
  check(
    'the work bead closed with it, before the answer was ever attempted',
    world().issues['zz-work'].status === 'closed',
    world().issues['zz-work'].status
  );
  check(
    'so the failure carries what already happened',
    Array.isArray(res.json.landed) && res.json.landed.length > 0,
    JSON.stringify(res.json)
  );
  check(
    'naming the merge, by number and by commit',
    (res.json.landed || []).some((s) => /#7/.test(s) && /c5004cce/.test(s)),
    JSON.stringify(res.json.landed)
  );
  check(
    'and the close it performed',
    (res.json.landed || []).some((s) => /zz-work/.test(s)),
    JSON.stringify(res.json.landed)
  );
  check('the reason bd gave is still on it', /database|resource/i.test(res.json.error || ''), res.json.error);
}

/* ============================ the tracker going away under the merge itself ====== */

console.log('\nand when it is the close rather than the comment that bd refuses\n');

{
  reset();
  // The other half of `bd.respond`, and the reason this is not a special case of the
  // one above: the write is a comment, then a close, then the mention sweep, and a bd
  // that dies at the second of those has still left a merged pull request behind it.
  // (`answerOnce` is why pressing again is safe — it will not comment twice.)
  breaks({ subcommands: ['close'] });
  const res = await post('/api/respond', { workspace: 'demo', id: 'zz-pr', response: MERGE });

  check('the request fails', res.status >= 500, `${res.status} ${JSON.stringify(res.json)}`);
  check('the merge happened anyway', merged(), 'the pull request is still open');
  check(
    'and the failure says so rather than claiming nothing was written',
    (res.json.landed || []).some((s) => /Merged #7/.test(s)),
    JSON.stringify(res.json)
  );
  check(
    'including the half of the delivery that bd would not do either',
    (res.json.landed || []).some((s) => /zz-work is still open/.test(s)),
    JSON.stringify(res.json.landed)
  );
}

/* =================================== an ordinary failure, which owes no such thing */

console.log('\na refusal with nothing behind it still says nothing was written\n');

{
  reset();
  breaks({ subcommands: ['comment'] });
  const res = await post('/api/respond', { workspace: 'demo', id: 'zz-ask', response: 'The first one.' });

  check('the answer fails', res.status >= 500, `${res.status} ${JSON.stringify(res.json)}`);
  check('and carries no `landed` at all, because nothing did', res.json.landed === undefined, JSON.stringify(res.json));
}

/* ============================================ the sentence the card actually draws */

console.log('\nwhat the card says\n');

/**
 * `failedNoteHtml` and its two helpers, sliced out of public/app.js and run in a vm.
 *
 * The recipe is test/jirarow.mjs's: a `function foo(` ends at its balanced brace, a
 * `const foo = (` arrow at the first semicolon outside every bracket. This renderer
 * touches no DOM — it returns a template string — so the context needs nothing but
 * `String`.
 */
const APP = fs.readFileSync(path.join(HERE, '..', 'public', 'app.js'), 'utf8');
const lift = (name) => {
  const at = APP.search(new RegExp(`^  (?:function ${name}\\(|const ${name} = )`, 'm'));
  if (at === -1) throw new Error(`${name} is not in public/app.js in the shape this slice expects`);
  const isArrow = /^  const /.test(APP.slice(at, at + 10));
  let depth = 0;
  for (let i = at; i < APP.length; i++) {
    const c = APP[i];
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) {
      depth -= 1;
      if (!isArrow && depth === 0 && c === '}') return APP.slice(at, i + 1);
    } else if (isArrow && depth === 0 && c === ';') return APP.slice(at, i + 1);
  }
  throw new Error(`could not find the end of ${name}`);
};

const ctx = vm.createContext({ String });
vm.runInContext([lift('esc'), lift('plainly'), lift('failedNoteHtml')].join('\n\n'), ctx);
const note = (failed) =>
  vm.runInContext(`failedNoteHtml(${JSON.stringify({ id: 'zz-pr', key: 'demo/zz-pr', failed })})`, ctx);

{
  const plain = note({ reason: 'bd: database is locked', from: 'answer' });
  check('an ordinary refusal keeps the reassurance', /Nothing was written and nothing was lost/.test(plain), plain);
  check('and offers the draft back', /still in the box/.test(plain), plain);
}

{
  const over = note({
    reason: 'bd: could not open database',
    from: 'answer',
    landed: ['Merged #7 as c5004cce — closed `zz-work`.', '**Endorsed:** zz-two.'],
  });
  check('a failure over an act that landed drops the reassurance entirely', !/Nothing was written/.test(over), over);
  check('and says what did happen instead', /Merged #7 as c5004cce/.test(over) && /Endorsed: zz-two/.test(over), over);
  check('with the thread’s markup taken off, because this is an alert', !/\*\*/.test(over) && !/`/.test(over), over);
  check('the draft is still offered back', /still in the box/.test(over), over);
  check('and the way out of the note is still there', /data-act="failed-dismiss"/.test(over), over);
}

{
  // Text out of bd cannot write markup into the card, `landed` included.
  const nasty = note({ reason: 'x', from: 'answer', landed: ['<img src=x onerror=alert(1)>'] });
  check('and nothing on it can write markup into the list', !/<img/.test(nasty) && /&lt;img/.test(nasty), nasty);
}

for (const s of servers) s.close();
await cleanupTmp(tmp);

console.log(failures ? `\n${failures} of ${ran} failed\n` : `\nall ${ran} passed\n`);
process.exit(failures ? 1 : 0);
