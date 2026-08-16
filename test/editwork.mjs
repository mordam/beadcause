#!/usr/bin/env node
/**
 * A worker opened on a bead that was typed into the running app.
 *
 *   npm test                     (runs it alongside the rest)
 *   node test/editwork.mjs
 *
 * lib/edits.js files those beads; lib/editwork.js is what a session is told when one of
 * them comes up ready, and bin/deliver.js is what stops it landing unseen. Four things
 * here are worth a suite, and every one of them is a way an unattended session gets an
 * in-app edit wrong:
 *
 * 1. **The two files have to still fit together.** The brief lifts the anchor out of the
 *    description by parsing a fenced JSON block that lib/edits.js wrote — a coupling
 *    across two modules with nothing but a code fence between them. So the record here
 *    is never hand-written: it is round-tripped through the real `beadsFor`, and a change
 *    to how the body is laid out fails this rather than quietly producing a brief with no
 *    anchor in it.
 * 2. **A retype and a pointed edit must not read alike.** One is a string replacement
 *    that should come out character-exact; the other is a sentence about intent that has
 *    to be built in the layout system that already exists. An agent given the wrong one
 *    of those two paragraphs does the wrong kind of work confidently — reworded chrome
 *    on one side, absolute positioning bolted onto a stylesheet on the other.
 * 3. **An anchor that resolves to nothing has to come back as a question.** Both shapes
 *    of it: nothing found at all, and more candidates than the chain could narrow. The
 *    assertion that matters is that the brief names `beadcause-ask` and `--blocks`,
 *    because a session with no sanctioned way to stop guesses.
 * 4. **It stops at the pull request, and the guarantee is not the sentence.** The brief
 *    asks for `--review`; `bin/deliver.js` holds it whether it was asked to or not. The
 *    end-to-end half of this file runs the real delivery, in a space with auto-merge
 *    emphatically on, and asserts `gh pr merge` never happens — the same negative
 *    assertion test/approval.mjs makes about a review gate, for the same reason.
 *
 * The end-to-end half is real git against a real bare remote, with `gh` and `bd` as fakes
 * on `PATH`. Nothing here reaches the network, a tracker, or anyone's phone. The fakes
 * are lifted from test/approval.mjs deliberately — that suite is the one that pins the
 * *other* two reasons a delivery hands over, and a card's wording is only meaningful
 * beside its siblings.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);
const DELIVER = path.join(HERE, '..', 'bin', 'deliver.js');

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-editwork-'));
const CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(CONFIG_DIR, { recursive: true });

const { normalizePass, beadsFor, labelsFor, EDIT_LABEL } = await import(LIB('edits.js'));
const { editBriefFor, editOf, isEditBead, fromEditMode } = await import(LIB('editwork.js'));
const { deliveryBody } = await import(LIB('delivery.js'));

/* ------------------------------------------------------------------ the beads */

/** One source hit, in the shape `sitesFor` in public/editmode.js reports them. */
const site = (file, line, text) => ({ file, line, at: line * 30, text });

/**
 * An anchor, in the shape `anchorFor` builds — the served *url* in `file`, not a path.
 * That is the thing the brief has to translate, so it is what the fixture carries.
 */
const anchorFor = ({ from = 'source', textSites = [site('/app.js', 3120, 'const h = `<h3 class="p0-title">Needs you</h3>`;')], found = 1, sources = textSites } = {}) => ({
  page: '/',
  selector: 'div.card > h3.p0-title',
  chain: [],
  classes: ['p0-title'],
  tag: 'h3',
  key: 'bc-9d37',
  text: { value: 'Needs you', from, sites: textSites, provider: 4 },
  source: { kind: 'class-name', query: '"p0-title"', found, sites: sources, tried: [] },
  editable: { ok: from === 'source' && textSites.length === 1, why: '' },
  resolved: true,
});

/** A bead exactly as edit mode's Save would have filed it — body, labels, type and all. */
function editBead(change, { id = 'zz-e1' } = {}) {
  const pass = normalizePass({ page: '/', view: 'inbox', at: '2026-08-13', changes: [change] });
  const { edits } = beadsFor(pass, { labels: labelsFor({}) });
  return { id, title: edits[0].title, description: edits[0].body, issue_type: 'task', labels: edits[0].labels };
}

const RETYPE = { id: 'e1', kind: 'retype', from: 'Needs you', to: 'Needs a tap', anchor: anchorFor(), context: { route: '/', filter: 'P0' } };
const POINT = {
  id: 'e2',
  kind: 'point',
  note: 'the count belongs under the title, not beside it',
  anchor: anchorFor(),
  where: { rel: 'below', target: { text: { value: 'Needs you' } } },
};
const DESCRIBE = { id: 'e3', kind: 'describe', note: 'tapping this should open the bead, not the card', anchor: anchorFor() };

console.log('\nwhich beads get the edit brief at all\n');

{
  const leaf = editBead(RETYPE);
  check('a bead filed by edit mode carries the label, so it is recognised', fromEditMode(leaf) && isEditBead(leaf));
  check(
    'the pass holding it does not — it is an epic, and there is nothing there to build',
    fromEditMode({ ...leaf, issue_type: 'epic' }) && !isEditBead({ ...leaf, issue_type: 'epic' })
  );
  check(
    'but the pass still gets a short brief of its own — a planner or a batch head opens on it',
    /Everything under this bead was typed into the running app/.test(
      editBriefFor({ ...leaf, id: 'zz-pass', issue_type: 'epic' }, { owner: 'Adam' })
    )
  );
  check(
    'which says the two rules and that none of it is the window\'s to merge',
    /character-exact/.test(editBriefFor({ ...leaf, issue_type: 'epic' })) &&
      /None of this is yours to merge/.test(editBriefFor({ ...leaf, issue_type: 'epic' }))
  );
  check(
    'and does not send it grepping for an anchor the epic has not got',
    !/The anchor, and the source it points at/.test(editBriefFor({ ...leaf, issue_type: 'epic' }))
  );
  check('an ordinary bead is neither, and its brief is untouched', !fromEditMode({ id: 'zz-x', labels: ['webapp'] }));
  check('and a bead with no labels at all does not throw', !fromEditMode({ id: 'zz-y' }) && editBriefFor({ id: 'zz-y' }) === '');
  check(
    'a non-edit bead gets the empty string, not a section that says nothing',
    editBriefFor({ id: 'zz-x', issue_type: 'task', labels: ['webapp'] }) === ''
  );
}

console.log('\nthe record, back out of the body lib/edits.js wrote\n');

{
  const leaf = editBead(RETYPE);
  const record = editOf(leaf);
  check('the fenced block round-trips — this is the coupling between the two files', record?.kind === 'retype', leaf.description.slice(-200));
  check('with the anchor on it, which is the whole reason to parse it', record?.anchor?.source?.sites?.[0]?.line === 3120);
  check('a point carries `where`, which is the relationship the drop landed in', editOf(editBead(POINT))?.where?.rel === 'below');
  check('a body with no block at all is null rather than a throw', editOf({ description: 'no json here' }) === null);
  check('so is one whose block will not parse', editOf({ description: '```json\n{not json\n```' }) === null);
  check(
    'and so is a kind that is not one of the three gestures',
    editOf({ description: '```json\n{"kind":"teleport","anchor":{}}\n```' }) === null
  );
  check(
    'a note that itself contains a json block does not win — the record is the last one',
    editOf({ description: '```json\n{"kind":"describe","anchor":{"selector":"decoy"}}\n```\n```json\n{"kind":"retype","anchor":{"selector":"real"}}\n```' })
      ?.anchor?.selector === 'real'
  );
  check(
    'a bead labelled in-app-edit with an unreadable record still gets a brief, and it says so',
    /could not be read/.test(editBriefFor({ id: 'zz-broken', issue_type: 'task', labels: [EDIT_LABEL], description: 'lost' }))
  );
}

console.log('\na retype is a string replacement\n');

{
  const brief = editBriefFor(editBead(RETYPE), { owner: 'Adam' });
  check('it says so in those words, so nothing is reimplemented', /character-exact/.test(brief));
  check('and that the new wording is not to be improved on the way past', /do not improve the new wording/.test(brief));
  check('it names the line the string is written on, as a path and not a url', /public\/app\.js:3120/.test(brief), brief.match(/.*app\.js.*/)?.[0]);
  check('and it does not tell a retype to go and think about layout', !/layout system this app already has/.test(brief));
  check(
    'the two refusals are named: two sites, and text that belongs to the tracker',
    /more than one place/.test(brief) && /belongs to the tracker/.test(brief)
  );
}

console.log('\na pointed or described edit is intent\n');

{
  const point = editBriefFor(editBead(POINT), { owner: 'Adam' });
  const describe = editBriefFor(editBead(DESCRIBE), { owner: 'Adam' });

  check('the drag is said to be a way of showing, not a measurement', /no geometry was captured/.test(point));
  check('and the relationship it landed in is named', /`below`/.test(point));
  check('both are told to build it in the layout system that already exists', /layout system this app already has/.test(point) && /layout system this app already has/.test(describe));
  check(
    'and told outright not to reach for absolute positioning or a pixel offset',
    /Not absolute positioning bolted on top, and not a pixel offset/.test(point)
  );
  check('a described edit says the words are the whole of it — there was no gesture', /no gesture at all/.test(describe));
  check('neither is told a string is being replaced', !/character-exact/.test(point) && !/character-exact/.test(describe));
}

console.log('\nan anchor that resolves to nothing is a question\n');

{
  const nowhere = anchorFor({ from: 'unknown', textSites: [], found: 0, sources: [] });
  const brief = editBriefFor(editBead({ ...DESCRIBE, anchor: nowhere }), { owner: 'Adam' });
  check('the brief says the search came back empty rather than offering a line', /resolves to nothing/.test(brief));
  check('and points at the ask command, parked behind this bead', /--blocks zz-e1/.test(brief));
  check('it asks the session to look for itself first, since the search is a substring match', /Look for it yourself first/.test(brief));

  const many = anchorFor({
    textSites: [site('/app.js', 10, 'a'), site('/app.js', 40, 'b')],
    found: 3,
    sources: [site('/app.js', 10, 'a'), site('/app.js', 40, 'b'), site('/console.js', 7, 'c')],
  });
  const ambiguous = editBriefFor(editBead({ ...POINT, anchor: many }), { owner: 'Adam' });
  check('three candidates is ambiguous, and picking one is named as a guess', /picking one is a guess/.test(ambiguous));
  check('every candidate is printed, so reading them is an option', /public\/app\.js:10/.test(ambiguous) && /public\/console\.js:7/.test(ambiguous));
  check('and it may be settled by reading, as long as the session says which it took', /say in a comment which one you took/.test(ambiguous));

  const resolved = editBriefFor(editBead(POINT), { owner: 'Adam' });
  check('a single clean site asks no question at all', !/--blocks/.test(resolved) && !/picking one is a guess/.test(resolved));

  const pageUrl = editBriefFor(
    editBead({ ...DESCRIBE, anchor: anchorFor({ textSites: [site('/advocates', 12, '<h1>Advocates</h1>')] }) }),
    { owner: 'Adam' }
  );
  check(
    'a page url is left alone rather than guessed into a path — the aliases live in lib/server.js',
    /\/advocates:12/.test(pageUrl) && /URL of a page, not a path/.test(pageUrl) && !/public\/advocates/.test(pageUrl)
  );
}

console.log('\nthe brief this bead ends in\n');

{
  const { workPromptFor } = await import(LIB('session.js'));
  const MODE = (over = {}) => ({
    repo: 'acme/widgets',
    base: 'main',
    method: 'merge',
    autoMerge: true,
    requireApproval: false,
    deliver: 'beadcause-deliver',
    ...over,
  });
  const leaf = editBead(RETYPE);
  const brief = workPromptFor('demo', leaf, 1, MODE(), 'Adam', { edit: editBriefFor(leaf, { owner: 'Adam' }) });
  const ordinary = workPromptFor('demo', { id: 'zz-plain', title: 'A thing' }, 1, MODE(), 'Adam');

  // bc-r941: an ordinary bead's brief no longer promises a merge, because the session no
  // longer performs one — it promises the queue. What this scenario is really about is
  // that an *edit* bead's brief is different from an ordinary one's in the same space, so
  // what the ordinary one says has to be pinned to something, and this is the sentence
  // that replaced the merge.
  check('an ordinary bead in this space goes on the merge queue', /merge queue/i.test(ordinary), (ordinary.match(/.*merge queue.*/i) || [])[0]);
  check('an in-app edit in the same space does not', !/merge queue/i.test(brief) && /you do not merge it — you deliver it/.test(brief));
  check('the command it is given carries --review', /--tests "<how you ran them and what happened>" --review <<'EOF'/.test(brief));
  check('the marker it is asked for is the review one, and only that', /\*\* BEAD WORK DONE \*\* CAN BE REVIEWED \*\*/.test(brief) && !/CAN BE DEPLOYED, REBUILT/.test(brief));
  check('it is told the delivery holds it either way, so the flag is not the guarantee', /holds it either way/.test(brief));
  check('and it is told not to deploy it either', /you do not merge this and you do not deploy it/.test(brief));
  check(
    'the ask-first reason is the bead, not the repo — a session must not read this as "auto-merge is off here"',
    /an in-app edit is merged by the person who asked for\s+it/.test(brief) &&
      !/lands work through pull requests that Adam approves/.test(brief)
  );
  check(
    'a bead not from edit mode is byte-identical to the brief it got before any of this existed',
    ordinary === workPromptFor('demo', { id: 'zz-plain', title: 'A thing' }, 1, MODE(), 'Adam', { edit: '' })
  );
  check(
    'and a space with auto-merge off keeps its own sentence for an ordinary bead',
    /lands work through pull requests that Adam approves/.test(
      workPromptFor('demo', { id: 'zz-plain', title: 'A thing' }, 1, MODE({ autoMerge: false }), 'Adam')
    )
  );
  check(
    'a workspace with no pull requests at all does not crash on one, it just closes its bead',
    /bd close zz-e1/.test(workPromptFor('demo', leaf, 1, null, 'Adam', { edit: editBriefFor(leaf, { owner: 'Adam' }) }))
  );
}

console.log('\nthe card, when a delivery hands one of these over\n');

{
  const d = { workspace: 'demo', repo: 'acme/widgets', bead: 'zz-e1', number: 7, url: 'u', branch: 'b', base: 'main', method: 'merge', title: 't' };
  const card = deliveryBody(d, { edit: true });
  check('it says what kind of bead this is, in the first sentence', /typed into the app itself with edit mode on/.test(card), card.split('\n')[0]);
  check('and that this is why it is here, rather than a switch being off', !/Nothing is merged until you say so/.test(card));
  check('it offers the same merge it always did', /Answering \*\*Merge\*\*/.test(card));
  check(
    'a refusal that actually happened still outranks it — that is the more urgent fact',
    /It could not:/.test(deliveryBody(d, { edit: true, refused: 'the branch has conflicts.' }))
  );
  check(
    'and it outranks the worker asking, because with the hold on there was no choice to credit',
    /in-app edit is merged by the person who asked for it/.test(deliveryBody(d, { edit: true, asked: true }))
  );
  check('a card with none of the four reads exactly as it always did', /Nothing is merged until you say so/.test(deliveryBody(d, {})));
}

/* ------------------------------------------------- the delivery, for real */

console.log('\nand the delivery itself, which is what actually keeps the promise\n');

const WORLD = path.join(tmp, 'world.json');
const BD_LOG = path.join(tmp, 'bd-calls.log');
const FAKE_BD = path.join(tmp, 'bd');
const world = () => JSON.parse(fs.readFileSync(WORLD, 'utf8'));

fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const WORLD = ${JSON.stringify(WORLD)};
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(BD_LOG)}, JSON.stringify(args) + '\\n');
const w = JSON.parse(fs.readFileSync(WORLD, 'utf8'));
const save = () => fs.writeFileSync(WORLD, JSON.stringify(w, null, 2));
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const all = (name) => args.map((a, i) => (a === name ? args[i + 1] : null)).filter(Boolean);
const die = (msg) => { process.stderr.write(msg + '\\n'); process.exit(1); };
const hydrate = (issue) => ({
  ...issue,
  dependencies: (issue.dependencies || []).map((d) => ({ ...d, status: (w.issues[d.id] || {}).status || 'closed' })),
});
if (args[0] === 'show') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error fetching ' + args[1] + ': no issue found');
  process.stdout.write(JSON.stringify([hydrate(issue)]));
  process.exit(0);
}
if (args[0] === 'list') {
  const label = flag('--label');
  const rows = Object.values(w.issues)
    .filter((i) => (label ? (i.labels || []).includes(label) : true))
    .filter((i) => i.status !== 'closed')
    .map(hydrate);
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
if (args[0] === 'create') {
  const id = 'zz-' + (w.seq = (w.seq || 0) + 1);
  w.issues[id] = {
    id,
    title: flag('--title') || '',
    description: flag('--description') || '',
    labels: all('--label'),
    status: 'open',
    issue_type: flag('--type') || 'task',
    dependencies: [],
  };
  save();
  process.stdout.write(JSON.stringify({ id }));
  process.exit(0);
}
if (args[0] === 'close') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  issue.status = 'closed';
  issue.close_reason = flag('--reason') || '';
  save();
  process.stdout.write('closed\\n');
  process.exit(0);
}
if (args[0] === 'comment') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  (issue.comments = issue.comments || []).push(args[2]);
  save();
  process.exit(0);
}
if (args[0] === 'dep' && args[1] === 'add') {
  const issue = w.issues[args[2]];
  if (!issue) die('Error: no issue found matching "' + args[2] + '"');
  issue.dependencies = issue.dependencies || [];
  if (!issue.dependencies.some((d) => d.id === args[3])) issue.dependencies.push({ id: args[3], dependency_type: 'blocks' });
  save();
  process.exit(0);
}
if (args[0] === 'dep' && args[1] === 'remove') {
  const issue = w.issues[args[2]];
  if (!issue) die('Error: no issue found matching "' + args[2] + '"');
  issue.dependencies = (issue.dependencies || []).filter((d) => d.id !== args[3]);
  save();
  process.exit(0);
}
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const BIN = path.join(tmp, 'bin');
fs.mkdirSync(BIN, { recursive: true });
const GH_STATE = path.join(tmp, 'gh.json');
const GH_LOG = path.join(tmp, 'gh-calls.log');
fs.writeFileSync(GH_STATE, JSON.stringify({ next: 70, prs: {} }));

fs.writeFileSync(
  path.join(BIN, 'gh'),
  `#!/usr/bin/env node
const fs = require('fs');
const STATE = ${JSON.stringify(GH_STATE)};
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(GH_LOG)}, JSON.stringify(args) + '\\n');
const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const save = () => fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
const out = (t) => { process.stdout.write(t); process.exit(0); };
const fail = (t) => { process.stderr.write(t + '\\n'); process.exit(1); };
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1]; };
const find = (ref) => Object.values(s.prs).find((p) => p.headRefName === ref || String(p.number) === String(ref));
if (args[0] === 'auth') out('Logged in to github.com\\n');
if (args[0] === 'repo' && args[1] === 'view') out(JSON.stringify({ nameWithOwner: 'acme/widgets' }));
if (args[0] === 'pr') {
  if (args[1] === 'create') {
    const head = flag('--head');
    const number = s.next++;
    s.prs[head] = {
      number,
      title: flag('--title') || '',
      url: 'https://github.com/acme/widgets/pull/' + number,
      state: 'OPEN',
      isDraft: false,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      headRefName: head,
      baseRefName: flag('--base') || 'main',
      additions: 3,
      deletions: 1,
      changedFiles: 1,
      statusCheckRollup: [{ name: 'build', conclusion: 'SUCCESS' }],
      reviewDecision: 'APPROVED',
      mergedAt: null,
      mergeCommit: null,
    };
    save();
    out(s.prs[head].url + '\\n');
  }
  const pr = find(args[2]);
  if (args[1] === 'view') {
    if (!pr) fail('no pull requests found for branch ' + args[2]);
    out(JSON.stringify(pr));
  }
  if (args[1] === 'comment') out('commented\\n');
  if (args[1] === 'merge') {
    if (!pr) fail('no pull request found');
    pr.state = 'MERGED';
    pr.mergedAt = '2026-08-13T12:00:00Z';
    pr.mergeCommit = { oid: 'aa11bb22cc33dd44' };
    save();
    out('Merged pull request #' + pr.number + '\\n');
  }
}
fail('unknown gh invocation: ' + args.join(' '));
`,
  { mode: 0o755 }
);

const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@e' },
  }).trim();

const origin = path.join(tmp, 'origin.git');
const repo = path.join(tmp, 'repo');
git(tmp, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
git(tmp, 'clone', '--quiet', origin, repo);
git(repo, 'config', 'user.email', 't@e');
git(repo, 'config', 'user.name', 'test');
fs.writeFileSync(path.join(repo, 'file.txt'), 'one\n');
git(repo, 'add', 'file.txt');
git(repo, 'commit', '--quiet', '-m', 'one');
git(repo, 'push', '--quiet', '-u', 'origin', 'main');

const branchOff = (name) => {
  git(repo, 'checkout', '--quiet', 'main');
  git(repo, 'checkout', '--quiet', '-b', name);
  fs.writeFileSync(path.join(repo, `${name}.txt`), `${name}\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', name);
};

const wsDir = path.join(tmp, 'ws');
fs.mkdirSync(path.join(wsDir, '.beads'), { recursive: true });
// Auto-merge on, globally and in the space, and an approving review already on the pull
// request. Everything that could stop a merge is switched off, so the only thing left
// that can stop one is the bead itself.
fs.writeFileSync(
  path.join(CONFIG_DIR, 'config.json'),
  JSON.stringify({
    port: 4318,
    host: '127.0.0.1',
    baseUrl: 'http://127.0.0.1:4318',
    token: 'editwork-token',
    actor: 'beadcause-test',
    bdBin: FAKE_BD,
    workspaces: [{ name: 'demo', dir: wsDir }],
    sessionDirs: { demo: repo },
    openSessions: false,
    claudeSessions: false,
    ntfy: { enabled: false },
    advocates: { enabled: false, workspaces: [] },
    pr: { base: 'main', mergeMethod: 'merge', autoMerge: true, mergeWaitMs: 1000 },
    spaces: [{ name: 'Solo', workspaces: ['demo'], autoMerge: true }],
  })
);

function deliver(bead) {
  const res = execFileSync(process.execPath, [DELIVER, '-w', 'demo', '-b', bead, '--dir', repo, '--tests', 'npm test — green'], {
    cwd: repo,
    encoding: 'utf8',
    input: 'What changed and why.',
    env: { ...process.env, BEADCAUSE_CONFIG_DIR: CONFIG_DIR, PATH: `${BIN}${path.delimiter}${process.env.PATH}` },
  });
  return res.trim().split('\n').filter(Boolean).pop() || '';
}

const reset = (bead, labels) => {
  fs.writeFileSync(
    WORLD,
    JSON.stringify({
      seq: 300,
      issues: {
        [bead]: { id: bead, title: 'The edit', description: '', labels, status: 'in_progress', issue_type: 'task', dependencies: [] },
      },
    })
  );
  fs.writeFileSync(BD_LOG, '');
  fs.writeFileSync(GH_LOG, '');
};

const ghCalls = () =>
  fs.readFileSync(GH_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const merged = () => ghCalls().some((c) => c[0] === 'pr' && c[1] === 'merge');
const cardOf = (id) => world().issues[id]?.description || '';

{
  reset('zz-edit', [EDIT_LABEL, 'owner:adam']);
  branchOff('edit-one');
  const last = deliver('zz-edit');
  const card = last.split(' ')[0];

  check('an in-app edit does not merge, in a space where everything says it should', !merged(), ghCalls().map((c) => c.join(' ')).join(' | '));
  check('it hands over, printing a question id rather than `landed`', /^zz-/.test(card) && !/^landed/.test(last), last);
  check('the bead stays open, because nothing has landed', world().issues['zz-edit'].status !== 'closed');
  check('and it is parked behind the card, so nothing opens a second session on it', (world().issues['zz-edit'].dependencies || []).some((d) => d.id === card));
  check('the card says why, and it is a fact about the bead', /typed into the app itself with edit mode on/.test(cardOf(card)), cardOf(card).split('\n')[0]);
  check(
    'and so does the bead thread, in the same words the command uses',
    (world().issues['zz-edit'].comments || []).some((c) => /will not be by a worker/.test(c)),
    JSON.stringify(world().issues['zz-edit'].comments)
  );
  check('the pull request was still opened — the work is pushed and reviewable', ghCalls().some((c) => c[0] === 'pr' && c[1] === 'create'));
  check(
    'and it says on the pull request why a green one is sitting open, where the diff is read',
    ghCalls().some((c) => c[0] === 'pr' && c[1] === 'comment' && /typed into the running app/.test(c.join(' '))),
    ghCalls().filter((c) => c[1] === 'comment').map((c) => c.join(' ')).join(' | ')
  );
}

{
  reset('zz-plain', ['owner:adam']);
  branchOff('plain-one');
  const last = deliver('zz-plain');
  // The contrast this scenario exists for is unchanged and is what matters: an in-app
  // edit is held for a human where an ordinary bead is not. What an ordinary bead does
  // instead of being held moved with bc-r941 — it queues rather than merging — so that
  // is what is asserted, including the negative that nothing here merged.
  check('an ordinary bead in the same space is not held — it goes to the queue', /^queued #\d+ /.test(last), last);
  check('and nothing merged it here either', !merged(), ghCalls().map((c) => c.join(' ')).join(' | '));
  check('the bead is open, and closes when the queue merges it', world().issues['zz-plain'].status !== 'closed');
  check(
    'and no card was filed, which is the difference from the in-app edit above',
    !Object.values(world().issues).some((i) => (i.labels || []).includes('pr-delivery') && i.status !== 'closed'),
    JSON.stringify(Object.entries(world().issues).filter(([, i]) => (i.labels || []).includes('pr-delivery')).map(([k]) => k))
  );
}

{
  // The pass and the standing root carry the label too, and neither is a thing to
  // deliver against at all — so holding one is the harmless direction, and worth
  // pinning: an epic delivery that quietly merged would close the pass over its
  // children.
  reset('zz-pass', [EDIT_LABEL]);
  const w = world();
  w.issues['zz-pass'].issue_type = 'epic';
  fs.writeFileSync(WORLD, JSON.stringify(w));
  branchOff('pass-one');
  deliver('zz-pass');
  check('the pass epic is held as well, even though it never gets the brief', !merged());
}

await cleanupTmp(tmp);

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : '\n\x1b[32mall checks passed\x1b[0m\n');
process.exit(failures ? 1 : 0);
