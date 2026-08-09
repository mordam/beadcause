#!/usr/bin/env node
/**
 * The bits that are worth being sure about, run against a throwaway git repo.
 *
 * beadcause has no test suite (bc-n5g), and most of it resists one honestly: it
 * spawns `claude`, it drives iTerm, it talks to a phone. The amendment loop is
 * different. It parses a block a model wrote, it computes a patch from it, and it
 * commits that patch to a git ref — three pure-ish steps where being wrong is silent
 * and permanent, because the output is a commit that says an agent was allowed to
 * become something.
 *
 * So this covers exactly those: the protocol, the patch arithmetic, and the
 * store. `node scripts/selftest.mjs`, or `npm test`. Exit code is the result — it
 * prints a line per check so a failure says which one, and nothing else.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import * as foundation from '../lib/foundation.js';
import * as amendment from '../lib/amendment.js';
import { DEFAULT_TOOLS } from '../lib/agents.js';
import { toQuestion } from '../lib/decision.js';
import { splitChannels } from '../lib/server.js';
import * as notify from '../lib/notify.js';
import { OBSERVING } from '../lib/config.js';

let failures = 0;
let ran = 0;

async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 6).join('\n       ')}`);
  }
}

/** Counted and named, never silently absent — a check that did not run is not a pass. */
function skip(name) {
  console.log(`  skip ${name}`);
}

/** A real git repo in a temp directory. The foundation store is git, so mocking it would test nothing. */
function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-selftest-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root'], {
    cwd: dir,
  });
  return dir;
}

const REQUEST = `Here is my answer to the question.

\`\`\`amendment
agent: dispatch
kind: prohibited
scope: reading git history in the repo I am already reading; no writes, no other repo
justification: |
  The comment asked which commit introduced the bug. I can read the files but not the
  history, so I had to answer with a guess at the file instead of the commit that made
  it. Reading git log is the whole of what would have turned that into a real answer.
evidence: |
  Bash(git log --oneline -20) was denied.
add:
  allowedTools:
    - Bash(git log:*)
\`\`\`
`;

console.log('foundation');

await check('a baseline is complete on its own, and deep-copied', () => {
  const a = foundation.baseline('dispatch');
  const b = foundation.baseline('dispatch');
  a.allowedTools.push('Bash(rm -rf /)');
  assert.notDeepEqual(a.allowedTools, b.allowedTools, 'mutating one baseline changed the module');
  assert.equal(b.writes, true);
  assert.ok(b.allowedTools.length > 1);
});

await check('every agent kind has a baseline', () => {
  for (const id of foundation.AGENTS) assert.equal(foundation.baseline(id).id, id);
  assert.throws(() => foundation.baseline('nope'));
});

await check('the dispatch allowlist has exactly one home', () => {
  assert.equal(DEFAULT_TOOLS, foundation.baseline('dispatch').allowedTools.join(' '));
  // The narrowing 40977c7 made, restated as a property so a merge cannot undo it
  // quietly: a reply agent that can run `bd create` defeats the proposal flow.
  assert.ok(!DEFAULT_TOOLS.includes('Bash(bd *)'), 'the glob is back, and it includes bd create');
  assert.ok(!/bd create|bd close|bd delete|bd label/.test(DEFAULT_TOOLS));
});

await check('an unamendable field is refused, not filtered', async () => {
  const dir = tempRepo();
  await assert.rejects(() => foundation.amend(dir, 'dispatch', { writes: true }), /not amendable/);
  await assert.rejects(() => foundation.amend(dir, 'dispatch', { protocolOwner: 'x' }), /not amendable/);
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('an amendment survives as a commit, and composes with the next', async () => {
  const dir = tempRepo();
  const before = await foundation.effective(dir, 'dispatch');
  assert.deepEqual(before.amended, []);

  await foundation.amend(dir, 'dispatch', { allowedTools: [...before.allowedTools, 'Bash(git log:*)'] }, {
    bead: 'beadcause/bc-1',
    justification: 'so it can name the commit',
  });
  const after = await foundation.effective(dir, 'dispatch');
  assert.ok(after.allowedTools.includes('Bash(git log:*)'));
  assert.deepEqual(after.amended, ['allowedTools']);

  await foundation.amend(dir, 'dispatch', { timeoutMs: 1234 }, { justification: 'slow repo' });
  const third = await foundation.effective(dir, 'dispatch');
  assert.ok(third.allowedTools.includes('Bash(git log:*)'), 'the second amendment reverted the first');
  assert.equal(third.timeoutMs, 1234);

  const log = await foundation.history(dir);
  assert.equal(log.length, 2);
  assert.match(log[1].message, /so it can name the commit/);
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('a refusal is remembered, with its reason', async () => {
  const dir = tempRepo();
  await foundation.decline(dir, 'console', {
    bead: 'beadcause/bc-2',
    request: 'allowedTools — bd create',
    reason: 'No. Proposing is filing, as far as you are concerned.',
  });
  const refusals = await foundation.declined(dir, 'console');
  assert.equal(refusals.length, 1);
  assert.match(refusals[0].reason, /Proposing is filing/);
  // And it must not have changed what the agent is.
  const f = await foundation.effective(dir, 'console');
  assert.deepEqual(f.allowedTools, foundation.baseline('console').allowedTools);
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('an unreadable overlay degrades to the baseline instead of failing', async () => {
  const dir = tempRepo();
  await foundation.amend(dir, 'dispatch', { timeoutMs: 999 }, { justification: 'x'.repeat(50) });
  // Overwrite the stored overlay with something that is not JSON.
  const sha = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: 'not json' }).toString().trim();
  const tree = execFileSync('git', ['mktree'], { cwd: dir, input: `100644 blob ${sha}\tdispatch.json\n` })
    .toString()
    .trim();
  const commit = execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit-tree', tree, '-m', 'break it'], {
    cwd: dir,
  })
    .toString()
    .trim();
  execFileSync('git', ['update-ref', foundation.FOUNDATION_REF, commit], { cwd: dir });

  const f = await foundation.effective(dir, 'dispatch');
  assert.equal(f.timeoutMs, foundation.baseline('dispatch').timeoutMs, 'a corrupt overlay should fall back');
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('no repo at all is not an error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-norepo-'));
  const f = await foundation.effective(dir, 'advocate');
  assert.equal(f.id, 'advocate');
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log('the amendment block');

await check('a well-formed request parses', () => {
  const r = amendment.parseAmendment(REQUEST);
  assert.equal(r.error, null);
  assert.equal(r.agent, 'dispatch');
  assert.equal(r.kind, 'prohibited');
  assert.deepEqual(r.add.allowedTools, ['Bash(git log:*)']);
  assert.match(r.scope, /no writes/);
});

await check('no block is not an error', () => {
  assert.equal(amendment.parseAmendment('just an answer, thanks'), null);
  assert.equal(amendment.parseAmendment(''), null);
});

await check('the two bars are enforced, not suggested', () => {
  const without = (field) => REQUEST.replace(new RegExp(`^${field}:.*$`, 'm'), `${field}: `);
  assert.match(amendment.parseAmendment(without('scope')).error, /scope/);
  assert.match(
    amendment.parseAmendment(REQUEST.replace(/justification: \|[\s\S]*?evidence:/, 'justification: more\nevidence:'))
      .error,
    /justification/
  );
});

await check('a protected field is rejected before it can become a bead', () => {
  const bad = REQUEST.replace('add:\n  allowedTools:\n    - Bash(git log:*)', 'set:\n  writes: true');
  assert.match(amendment.parseAmendment(bad).error, /not amendable/);
});

await check('an unknown agent, an empty block and bad YAML each say so', () => {
  assert.match(amendment.parseAmendment(REQUEST.replace('agent: dispatch', 'agent: gremlin')).error, /unknown agent/);
  assert.match(amendment.parseAmendment('```amendment\n\n```').error, /empty/);
  assert.match(amendment.parseAmendment('```amendment\nagent: [unclosed\n```').error, /not valid YAML/);
});

await check('a block asking for nothing is rejected', () => {
  const nothing = REQUEST.replace('add:\n  allowedTools:\n    - Bash(git log:*)', 'add:\n  allowedTools: []');
  assert.match(amendment.parseAmendment(nothing).error, /no change/);
});

console.log('the patch');

await check('add and remove compose against what the agent is now', () => {
  const current = { allowedTools: ['Read', 'Grep'] };
  const patch = amendment.patchFor(
    { set: {}, add: { allowedTools: ['Bash(git log:*)'] }, remove: { allowedTools: ['Grep'] } },
    current
  );
  assert.deepEqual(patch.allowedTools, ['Read', 'Bash(git log:*)']);
});

await check('adding something already there does not duplicate it', () => {
  const patch = amendment.patchFor({ set: {}, add: { allowedTools: ['Read'] }, remove: {} }, { allowedTools: ['Read'] });
  assert.deepEqual(patch.allowedTools, ['Read']);
});

await check('the change is shown as gains and losses, not two lists', () => {
  const lines = amendment.changeLines(
    { set: {}, add: { allowedTools: ['Bash(git log:*)'] }, remove: { allowedTools: ['Grep'] } },
    { allowedTools: ['Read', 'Grep'] }
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0].summary, /\*\*\+\*\* `Bash\(git log:\*\)`/);
  assert.match(lines[0].summary, /\*\*−\*\* `Grep`/);
});

console.log('the question');

await check('the body round-trips: what Adam reads and what is applied agree', async () => {
  const dir = tempRepo();
  const request = amendment.parseAmendment(REQUEST);
  const f = await foundation.effective(dir, 'dispatch');
  const body = amendment.amendmentBody(request, f, { workspace: 'beadcause', from: 'beadcause/bc-1' });

  const back = amendment.parseAmendment(body);
  assert.equal(back.error, null);
  assert.deepEqual(amendment.patchFor(back, f), amendment.patchFor(request, f));
  // Verbatim, not merely equivalent. The default YAML style folds a long
  // justification and inserts a blank line at every fold, so the argument would come
  // back out with paragraph breaks the agent never wrote — and this block is the copy
  // the commit message is built from.
  assert.equal(back.justification, request.justification);
  assert.equal(back.scope, request.scope);
  assert.equal(back.evidence, request.evidence);
  // The prose has to name the thing being granted, or the card is unanswerable.
  assert.match(body, /Bash\(git log:\*\)/);
  assert.match(body, /Scoped to:/);
  assert.match(body, new RegExp(amendment.APPROVE_MARKER));
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('the phone gets prose, not YAML', async () => {
  const dir = tempRepo();
  const request = amendment.parseAmendment(REQUEST);
  const f = await foundation.effective(dir, 'dispatch');
  const q = toQuestion('beadcause', {
    id: 'bc-1',
    title: 'x',
    description: amendment.amendmentBody(request, f, { workspace: 'beadcause' }),
  });
  assert.ok(q.amendment, 'the question does not know it is a constitutional one');
  assert.equal(q.amendment.agent, 'dispatch');
  assert.equal(q.decision.options.length, 2);
  for (const s of q.sections) assert.ok(!s.markdown.includes('```amendment'), 'the block reached the phone');
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('consent cannot be given by accident', () => {
  assert.equal(amendment.isApproval('yeah go on then'), false);
  assert.equal(amendment.isApproval('I would AMEND: it if I were you'), false);
  assert.equal(amendment.isApproval('AMEND: apply this to the dispatch foundation.'), true);
});

console.log('the loop');

/** Just enough of lib/bd.js for the two calls the loop makes. */
function fakeBd(issue, { open = [] } = {}) {
  const created = [];
  return {
    created,
    show: async () => issue,
    listLabel: async () => open,
    create: async (_ws, spec) => {
      created.push(spec);
      return 'bc-new';
    },
  };
}

await check('approving commits the change and reports the fields', async () => {
  const dir = tempRepo();
  const request = amendment.parseAmendment(REQUEST);
  const f = await foundation.effective(dir, 'dispatch');
  const issue = { id: 'bc-1', description: amendment.amendmentBody(request, f, { workspace: 'beadcause' }) };
  const ws = { name: 'beadcause', dir };

  const out = await amendment.resolveAmendment(fakeBd(issue), ws, dir, 'bc-1', 'AMEND: apply it.');
  assert.equal(out.declined, null);
  assert.deepEqual(out.amended.fields, ['allowedTools']);
  const now = await foundation.effective(dir, 'dispatch');
  assert.ok(now.allowedTools.includes('Bash(git log:*)'));
  // And it did not quietly drop anything it was not asked about.
  for (const t of foundation.baseline('dispatch').allowedTools) assert.ok(now.allowedTools.includes(t), t);
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('anything that is not the marker is a refusal, and is written down', async () => {
  const dir = tempRepo();
  const request = amendment.parseAmendment(REQUEST);
  const f = await foundation.effective(dir, 'dispatch');
  const issue = { id: 'bc-1', description: amendment.amendmentBody(request, f, { workspace: 'beadcause' }) };
  const ws = { name: 'beadcause', dir };

  const out = await amendment.resolveAmendment(fakeBd(issue), ws, dir, 'bc-1', 'No — read the file instead.');
  assert.equal(out.amended, null);
  assert.deepEqual(out.declined.fields, ['allowedTools']);
  const now = await foundation.effective(dir, 'dispatch');
  assert.ok(!now.allowedTools.includes('Bash(git log:*)'), 'a refusal changed the foundation');

  const refusals = await foundation.declined(dir, 'dispatch');
  assert.match(refusals[0].reason, /read the file instead/);
  // And the agent must not be able to walk straight back in with the same ask.
  assert.equal(await amendment.alreadyRefused(dir, request), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('an ordinary question answered "AMEND:" is left alone', async () => {
  const dir = tempRepo();
  const issue = { id: 'bc-1', description: 'Should we use gross or net?' };
  const out = await amendment.resolveAmendment(fakeBd(issue), { name: 'beadcause', dir }, dir, 'bc-1', 'AMEND: sure');
  assert.deepEqual(out, { amended: null, declined: null });
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('one open request at a time', async () => {
  const dir = tempRepo();
  const request = amendment.parseAmendment(REQUEST);
  const ws = { name: 'beadcause', dir };

  const first = await amendment.fileRequest(fakeBd(null), ws, dir, request);
  assert.equal(first.id, 'bc-new');

  const second = await amendment.fileRequest(fakeBd(null, { open: [{ id: 'bc-new' }] }), ws, dir, request);
  assert.equal(second.id, null);
  assert.match(second.skipped, /already open/);
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('a tracker that cannot be asked files nothing', async () => {
  const dir = tempRepo();
  const bd = { listLabel: async () => { throw new Error('dolt is locked'); }, create: async () => 'bc-nope' };
  assert.equal(await amendment.fileRequest(bd, { name: 'beadcause', dir }, dir, amendment.parseAmendment(REQUEST)), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log('reading the transcript');

await check('a denied tool call is recognised', () => {
  const event = {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          is_error: true,
          content: [{ type: 'text', text: 'Claude requested permissions to use Bash, but you have not granted it yet.' }],
        },
      ],
    },
  };
  assert.match(amendment.denialFrom(event), /permissions to use Bash/);
});

await check('an ordinary tool failure is not a denial', () => {
  assert.equal(
    amendment.denialFrom({
      type: 'user',
      message: { content: [{ type: 'tool_result', is_error: true, content: 'ENOENT: no such file' }] },
    }),
    null
  );
  assert.equal(amendment.denialFrom({ type: 'assistant', message: { content: [] } }), null);
  assert.equal(amendment.denialFrom(null), null);
});

console.log('the reflection prompt');

await check('it carries the refusals back, verbatim', async () => {
  const dir = tempRepo();
  await foundation.decline(dir, 'dispatch', { request: 'allowedTools — bd create', reason: 'That is the proposal flow.' });
  const f = await foundation.effective(dir, 'dispatch');
  const text = amendment.reflectionPrompt(f, await foundation.declined(dir, 'dispatch'));
  assert.match(text, /Do not ask these again/);
  assert.match(text, /That is the proposal flow\./);
  assert.match(text, /agent: dispatch/);
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('with no history it still tells the agent what it is', () => {
  const text = amendment.reflectionPrompt(foundation.baseline('advocate'), []);
  assert.ok(!text.includes('Do not ask these again'));
  assert.match(text, /Most runs should ask for nothing/);
});

console.log('the separate channel');

await check('a foundation request is not in the questions feed', () => {
  const rows = [
    { key: 'cl/1', priority: 0 },
    { key: 'bc/2', foundation: true },
    { key: 'cl/3', priority: 2 },
  ];
  const { questions, requests } = splitChannels(rows);
  assert.deepEqual(questions.map((q) => q.key), ['cl/1', 'cl/3']);
  assert.deepEqual(requests.map((q) => q.key), ['bc/2']);
  // The point of the split, stated as an assertion: a P0 question and a request
  // never sort against each other, because they are never in the same list.
  assert.ok(!questions.some((q) => q.foundation), 'a request reached the work feed');
});

await check('a request whose block did not parse still lands in the channel', () => {
  // `foundation` comes off the bead's label, not off a successful parse. A request
  // that fell back into the questions feed because its YAML was wrong would be the
  // one nobody is looking for and nobody finds.
  const { questions, requests } = splitChannels([{ key: 'bc/9', foundation: true, amendment: null, errors: ['bad'] }]);
  assert.equal(questions.length, 0);
  assert.equal(requests.length, 1);
});

/*
 * The notification checks below assert that something *is* published, so they are a
 * lie in an observer shell — `OBSERVING` short-circuits every push, by design. Said
 * out loud rather than worked around: test/observe.mjs owns that flag and spawns
 * children to test both values of it, and a second copy of that machinery here would
 * be two answers to one question.
 */
if (OBSERVING) {
  console.log('  --   the notification checks need a non-observer shell (BEADCAUSE_OBSERVE is set)');
}

/** Capture what would have been POSTed to ntfy, without posting it. */
async function captureNtfy(fn) {
  const real = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (_url, opts) => {
    sent = JSON.parse(opts.body);
    return { ok: true, status: 200, text: async () => '' };
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
  return sent;
}

const NTFY_CFG = {
  baseUrl: 'http://beadcause.ts.net',
  token: 'tok',
  ntfy: { enabled: true, topic: 'topic', server: 'https://ntfy.sh', actionButtons: true },
};

await (OBSERVING ? skip : check)('a request notifies down its own path, not the question one', async () => {
  const dir = tempRepo();
  const request = amendment.parseAmendment(REQUEST);
  const f = await foundation.effective(dir, 'dispatch');
  const q = toQuestion('beadcause', {
    id: 'bc-1',
    title: 'x',
    priority: 0,
    description: amendment.amendmentBody(request, f, { workspace: 'beadcause' }),
  });

  const asked = await captureNtfy(() => notify.pushFoundationRequest(NTFY_CFG, q));
  const work = await captureNtfy(() => notify.pushQuestion(NTFY_CFG, { ...q, foundation: false }));

  assert.match(asked.title, /asks to change what it is/);
  assert.notEqual(asked.title, work.title);
  assert.deepEqual(asked.tags, ['scales']);
  assert.notDeepEqual(asked.tags, work.tags);
  // A P0 bead: the question shouts, the request does not. There is no such thing as
  // a constitutional change that should interrupt harder.
  assert.equal(work.priority, 5);
  assert.equal(asked.priority, 3);
  // The scope leads, because it is what decides most of these.
  assert.match(asked.message, /^reading git history/);
  fs.rmSync(dir, { recursive: true, force: true });
});

await (OBSERVING ? skip : check)('approve and decline are both one tap from the shade', async () => {
  const dir = tempRepo();
  const request = amendment.parseAmendment(REQUEST);
  const f = await foundation.effective(dir, 'dispatch');
  const q = toQuestion('beadcause', {
    id: 'bc-1',
    title: 'x',
    description: amendment.amendmentBody(request, f, { workspace: 'beadcause' }),
  });

  const sent = await captureNtfy(() => notify.pushFoundationRequest(NTFY_CFG, q));
  assert.equal(sent.actions.length, 2, 'both options must fit inside ntfy’s three');
  const approve = sent.actions.find((a) => JSON.parse(a.body).response.startsWith(amendment.APPROVE_MARKER));
  assert.ok(approve, 'no button actually consents');
  assert.equal(JSON.parse(approve.body).id, 'bc-1');
  // And the body still opens the thread — the Q and A is a conversation, and a
  // notification cannot be one.
  assert.match(sent.click, /#beadcause%2Fbc-1$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

await (OBSERVING ? skip : check)('a reply about a request carries no buttons', async () => {
  const sent = await captureNtfy(() =>
    notify.pushFoundationReply(NTFY_CFG, { key: 'beadcause/bc-1', workspace: 'beadcause' }, {
      author: 'dispatch',
      text: 'The narrowest version is read-only git log in this repo.',
    })
  );
  assert.equal(sent.actions, undefined, 'a reply is something to read, not a second decision');
  assert.match(sent.title, /on its own request/);
  assert.match(sent.click, /#beadcause%2Fbc-1$/);
});

await check('a silent ntfy is reported as skipped, not as sent', async () => {
  const off = { ...NTFY_CFG, ntfy: { enabled: false } };
  assert.deepEqual(await notify.pushFoundationRequest(off, { key: 'a/1' }), { skipped: true });
  assert.deepEqual(await notify.pushFoundationReply(off, { key: 'a/1' }, {}), { skipped: true });
});

console.log('');
console.log(failures ? `${failures} of ${ran} failed` : `${ran} checks passed`);
process.exit(failures ? 1 : 0);
