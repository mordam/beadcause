#!/usr/bin/env node
/**
 * lib/jiraingest.js — reading the ticket, and the four ways it goes wrong quietly.
 *
 *     npm test
 *     node test/jiraingest.mjs
 *
 * test/jiraepic.mjs covers the epic each ticket gets. This is what happens next: an agent
 * reads the ticket and the beads it proposes become **real children of that epic**. Four
 * things about that are worth a file, and every one of them fails silently without it.
 *
 * 1. **They are children, and they are held.** `parent` on the create, so `bd dep tree`
 *    renders them — the bead's own description explains why `bin/file.js` cannot be the
 *    seam here, and it is not a style point: a `discovered-from` edge makes `bd update
 *    --parent` refuse outright afterwards, and the epic ends up with no children at all.
 *    They also carry `unendorsed`, and the guarantee is `assertEndorsed` rather than a
 *    queue filter — an ingested child handed straight to the launcher must be refused.
 * 2. **Exactly once, from a tracker rather than from memory.** A daemon that restarts has
 *    forgotten every ingestion it ever did, so the question is asked of the epic: an epic
 *    with children has been ingested. The safe direction is deliberate and is asserted
 *    here, because it is the one that costs something — a half-written decomposition is
 *    left alone rather than added to.
 * 3. **A failure says so, and stops.** Nothing retries within the life of the process:
 *    the failures that reach here are an agent that would not run, a JIRA read that was
 *    refused, a `bd` that would not take a title, and none of those is fixed by trying
 *    again in sixty seconds. What must never happen is a ticket that reads *still
 *    reading* forever — so the state has to move, and `onSettled` has to fire, because
 *    that is the only thing that wakes a phone parked on `/api/poll`.
 * 4. **One at a time.** An ingestion is a `claude -p`; nine tickets arriving in one
 *    morning must not put nine agents on this Mac at once.
 *
 * Plus the row that draws the answer, lifted out of public/app.js and run for real —
 * test/jirarow.mjs's reason for doing it that way, and the same VM.
 *
 * No tracker, no network, no agent: `bd`, the JIRA fetch and the agent run are all fakes
 * that record what they were asked for.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (name) => path.join(ROOT, 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-jiraingest-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { childIssue, createIngester, ingestPrompt, MAX_CHILDREN, planFrom, stateKey, ticketBrief } = await import(
  LIB('jiraingest.js')
);
const { UNENDORSED, assertEndorsed } = await import(LIB('endorse.js'));
const { TICKET_LABEL } = await import(LIB('jiraepic.js'));
const { adfText, descriptionText, threadOf } = await import(LIB('jira.js'));

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));
const checks = (name, fn) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};
const checksAsync = async (name, fn) => {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

const WS = { name: 'climative', dir: path.join(tmp, 'beads', 'climative', '.beads') };
// `sessionDirs` rather than a `projectRoot` mapping: what an ingestion needs from
// lib/session.js is one existing directory to spawn the agent in, and stating it outright
// keeps this suite from also being a test of how a checkout resolves to a workspace.
const CHECKOUT = path.join(tmp, 'checkout');
fs.mkdirSync(CHECKOUT, { recursive: true });
const CFG = { workspaces: [WS], sessionDirs: { climative: CHECKOUT } };

/** A ticket in lib/jirapoll.js's shape — `ticketFrom` builds exactly this. */
const ticket = (key = 'TECH-1', over = {}) => ({
  workspace: 'climative',
  key,
  summary: `${key} needs doing`,
  status: 'In Progress',
  updated: '2026-08-13T10:00:00.000+0000',
  url: `https://climative.atlassian.net/browse/${key}`,
  assignee: 'adam@climative.ai',
  ...over,
});

/** What an agent's answer looks like: prose, then the `beads` block lib/draft.js parses. */
const answer = (yaml) => `Here is what I think it decomposes into.\n\n\`\`\`beads\n${yaml}\`\`\`\n`;

const TWO_BEADS = answer(`beads:
  - ref: client
    title: Give the DMS client a retry policy
    type: task
    priority: 2
    description: |
      It gives up on the first 503.
    acceptance: A 503 is retried three times.
  - ref: tests
    title: Cover the retry policy
    dependsOn: [client]
`);

/**
 * `bd`, holding rows in an array and recording every call.
 *
 * `children` is the one that matters most: it is the whole of "has this been ingested",
 * so a test that could not make it answer differently could not test the question.
 */
function fakeBd({ kids = [], createFails = null, childrenFails = null, exists = () => false } = {}) {
  const calls = [];
  const created = [];
  const deps = [];
  const comments = [];
  let next = 0;
  return {
    calls,
    created,
    deps,
    comments,
    async children(workspace, id) {
      calls.push(`children ${id}`);
      if (childrenFails) throw new Error(childrenFails);
      return kids.map((k) => ({ id: k, title: k, status: 'open' }));
    },
    async create(workspace, issue) {
      calls.push(`create ${issue.title}`);
      const why = typeof createFails === 'function' ? createFails(issue) : createFails;
      if (why) throw new Error(why);
      next += 1;
      const id = `bc-kid${next}`;
      created.push({ id, issue });
      return id;
    },
    async exists(workspace, id) {
      calls.push(`exists ${id}`);
      return exists(id);
    },
    async addDep(workspace, from, to) {
      calls.push(`dep ${from} -> ${to}`);
      deps.push([from, to]);
    },
    async comment(workspace, id, text) {
      calls.push(`comment ${id}`);
      comments.push({ id, text });
    },
  };
}

/**
 * The ingester with its three outside edges stubbed.
 *
 * `settingsFor` and the JIRA read are reached through `fetchImpl`, which is what
 * lib/jira.js's `get` actually calls — the same seam test/jira-poll.mjs uses, so the URL
 * and the credential header are exercised rather than mocked away.
 */
const SITE = 'https://climative.atlassian.net';

function ingesterOver({ bd, run, settled = [], enabled = true } = {}) {
  const cfg = {
    ...CFG,
    jira: enabled ? { climative: { enabled: true, url: SITE, email: 'adam@climative.ai' } } : {},
  };
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          key: 'TECH-1',
          fields: {
            summary: 'TECH-1 needs doing',
            description: {
              type: 'doc',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'The client gives up on the first 503.' }] },
              ],
            },
            comment: {
              comments: [
                { author: { displayName: 'Sam' }, created: '2026-08-01T09:00:00.000+0000', body: 'Seen in prod.' },
              ],
            },
            issuetype: { name: 'Bug' },
            labels: ['api'],
          },
        });
      },
    };
  };
  fetchImpl.seen = seen;
  const ing = createIngester({ bd, run, fetchImpl, onSettled: (o) => settled.push(o) });
  return { ing, cfg, fetchImpl };
}

// The environment wins over the file in lib/atlassian.js, and this Mac's own shell
// exports one inside a work directory — see test/jira-poll.mjs, which deletes it for the
// same reason: a suite that read the real token would be a suite that could reach JIRA.
delete process.env.JIRA_API_TOKEN;
const { writeToken } = await import(LIB('jira.js'));
writeToken('climative', 'a-token');

console.log('\nreading the ticket: what the agent is handed');

checks('the brief carries the description, which no row ever does', () => {
  const brief = ticketBrief(ticket(), {
    description: 'The client gives up on the first 503.',
    comments: [{ author: 'Sam', at: '2026-08-01T09:00:00.000+0000', text: 'Seen in prod.' }],
    type: 'Bug',
    labels: ['api'],
  });
  assert.match(brief, /TECH-1 — TECH-1 needs doing/);
  assert.match(brief, /gives up on the first 503/, 'the description is the point of fetching one');
  assert.match(brief, /Sam/, 'a comment is where the requirement usually got changed');
  assert.match(brief, /status \*\*In Progress\*\*/);
});

checks('a ticket with no description still produces a brief rather than a blank', () => {
  const brief = ticketBrief(ticket(), {});
  assert.match(brief, /no description/);
});

checks('the prompt forbids the one thing the agent cannot do', () => {
  const prompt = ingestPrompt({
    ticket: ticket(),
    detail: { description: 'x', comments: [] },
    epic: { id: 'bc-ep1', title: 'TECH-1 — needs doing' },
    workspace: 'climative',
  });
  assert.match(prompt, /Do not create anything/, 'a read-only agent that tries to write wastes the whole run');
  assert.match(prompt, /bc-ep1/, 'it has to know which epic it is decomposing');
  assert.match(prompt, new RegExp(UNENDORSED), 'and that what it proposes arrives held');
});

console.log('\nAtlassian Document Format is a tree, not a string');

checks('a description becomes text, with its list and its links', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'See ' }, { type: 'text', text: 'the spec', marks: [{ type: 'link', attrs: { href: 'https://x/y' } }] }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'retry' }] }] }] },
    ],
  };
  const out = adfText(doc);
  assert.match(out, /See the spec <https:\/\/x\/y>/);
  assert.match(out, /- retry/, 'a list the ticket already wrote is half a decomposition');
});

checks('a node type nobody here has heard of costs its wrapper, not its words', () => {
  const out = adfText({ type: 'doc', content: [{ type: 'somePluginPanel', content: [{ type: 'text', text: 'important' }] }] });
  assert.match(out, /important/);
});

checks('and nothing about a malformed description throws', () => {
  assert.equal(adfText(null), '');
  assert.equal(adfText(undefined), '');
  assert.equal(adfText({ type: 'text' }), '');
  assert.equal(descriptionText({}), '');
  assert.deepEqual(threadOf({}), []);
  assert.equal(adfText('already flat'), 'already flat', 'a v2 site answers with a string');
});

console.log('\nwhat a proposal becomes');

checks('the block is parsed by lib/draft.js and ordered for creation', () => {
  const plan = planFrom(TWO_BEADS);
  assert.equal(plan.error, null);
  assert.equal(plan.beads.length, 2);
  assert.equal(plan.beads[0].ref, 'client', 'a bead its sibling depends on has to exist first');
});

checks('an answer with no block at all is an error rather than an empty decomposition', () => {
  const plan = planFrom('I had a look and I am not sure.');
  assert.ok(plan.error, 'silently ingesting nothing is indistinguishable from a ticket with nothing in it');
  assert.equal(plan.beads.length, 0);
});

checks('a runaway proposal is capped, and says so', () => {
  const many = answer(
    `beads:\n${Array.from({ length: MAX_CHILDREN + 5 }, (_, i) => `  - ref: b${i}\n    title: Bead number ${i}\n`).join('')}`
  );
  const plan = planFrom(many);
  assert.equal(plan.beads.length, MAX_CHILDREN);
  assert.ok(
    plan.warnings.some((w) => /MAX_CHILDREN/.test(w)),
    'a silent truncation reads as "the ticket had twenty parts"'
  );
});

console.log('\nwhat a child bead actually is');

checks('it is a child of the epic — the one thing bin/file.js could not have given it', () => {
  const issue = childIssue({ title: 'Retry', type: 'task', priority: 3, labels: [] }, { epic: 'bc-ep1', ticket: ticket() });
  assert.equal(issue.parent, 'bc-ep1', 'without this bd dep tree renders nothing under the epic');
});

checks('held, and stamped with where it came from', () => {
  const issue = childIssue({ title: 'Retry', type: 'task', priority: 2, labels: ['api'] }, { epic: 'bc-ep1', ticket: ticket() });
  assert.ok(issue.labels.includes(UNENDORSED), 'nothing may open a session on it before the ticket is approved');
  assert.ok(issue.labels.includes(TICKET_LABEL), 'and everything one ticket produced is findable by one label');
  assert.ok(issue.labels.includes('api'), "the agent's own labels survive");
  assert.match(issue.notes, /TECH-1/);
});

checks('an auto-endorsed space gets the marker off, and the note says so plainly', () => {
  const issue = childIssue({ title: 'Retry', type: 'task', priority: 2, labels: [] }, { epic: 'bc-ep1', ticket: ticket(), endorsed: true });
  assert.ok(!issue.labels.includes(UNENDORSED));
  assert.match(issue.notes, /endorsed/, 'a bead claiming to wait for a tap over a running session is the worse error');
});

checks('the agent may not outrank the epic, and may never file a P0', () => {
  const p0 = childIssue({ title: 'Now', type: 'task', priority: 0, labels: [] }, { epic: 'bc-ep1', ticket: ticket() });
  assert.equal(p0.priority, 1, 'P0 is something Adam chooses');
  const p3 = childIssue({ title: 'Later', type: 'task', priority: 3, labels: [] }, { epic: 'bc-ep1', ticket: ticket() });
  assert.equal(p3.priority, 3, 'and a quiet bead stays quiet');
});

checks('a proposed epic becomes a task — the epic already exists', () => {
  const issue = childIssue({ title: 'The whole thing', type: 'epic', priority: 2, labels: [] }, { epic: 'bc-ep1', ticket: ticket() });
  assert.equal(issue.type, 'task');
});

await checksAsync('and the hold has teeth: the launcher refuses one', async () => {
  const issue = childIssue({ title: 'Retry', type: 'task', priority: 2, labels: [] }, { epic: 'bc-ep1', ticket: ticket() });
  const held = { id: 'bc-kid1', title: issue.title, labels: issue.labels };
  await assert.rejects(
    () => assertEndorsed({ async show() { return held; } }, WS, held),
    /endors/i,
    'the queue filter is not the guarantee — assertEndorsed asking the tracker is'
  );
});

console.log('\none ticket, start to finish');

await checksAsync('the children are created under the epic, in order, with their edge', async () => {
  const bd = fakeBd();
  const { ing, cfg } = ingesterOver({ bd, run: async () => TWO_BEADS });
  await ing.sweep(cfg, [{ workspace: WS, ticket: ticket(), epic: 'bc-ep1' }]);
  await ing.drain();

  assert.equal(bd.created.length, 2, `created ${bd.created.length}: ${bd.calls.join(' | ')}`);
  assert.ok(bd.created.every((c) => c.issue.parent === 'bc-ep1'));
  assert.deepEqual(bd.deps, [['bc-kid2', 'bc-kid1']], 'the dependency between two proposed beads survives');
  const state = ing.stateFor('climative', 'TECH-1');
  assert.equal(state.state, 'done');
  assert.equal(state.children, 2);
  assert.equal(state.epic, 'bc-ep1');
});

await checksAsync('the epic is told, because whoever opens it in the morning did not watch this', async () => {
  const bd = fakeBd();
  const { ing, cfg } = ingesterOver({ bd, run: async () => TWO_BEADS });
  await ing.sweep(cfg, [{ workspace: WS, ticket: ticket(), epic: 'bc-ep1' }]);
  await ing.drain();
  assert.equal(bd.comments.length, 1);
  assert.match(bd.comments[0].text, /bc-kid1/);
  assert.match(bd.comments[0].text, new RegExp(UNENDORSED));
});

await checksAsync('the ticket the agent read is the ticket that arrived, description and all', async () => {
  const seen = [];
  const bd = fakeBd();
  const { ing, cfg } = ingesterOver({
    bd,
    run: async ({ prompt }) => {
      seen.push(prompt);
      return TWO_BEADS;
    },
  });
  await ing.sweep(cfg, [{ workspace: WS, ticket: ticket(), epic: 'bc-ep1' }]);
  await ing.drain();
  assert.equal(seen.length, 1);
  assert.match(seen[0], /gives up on the first 503/, 'the fetched description reached the prompt');
  assert.match(seen[0], /Sam/, 'and so did the thread');
});

console.log('\nexactly once, asked of the tracker');

await checksAsync('an epic that already has children is not ingested again', async () => {
  const bd = fakeBd({ kids: ['bc-old1'] });
  const { ing, cfg } = ingesterOver({ bd, run: async () => assert.fail('no agent should have run') });
  await ing.sweep(cfg, [{ workspace: WS, ticket: ticket(), epic: 'bc-ep1' }]);
  await ing.drain();
  assert.equal(ing.stateFor('climative', 'TECH-1').state, 'done');
  assert.equal(bd.created.length, 0);
});

await checksAsync('and it costs one read per daemon life, not one per tick', async () => {
  const bd = fakeBd({ kids: ['bc-old1'] });
  const { ing, cfg } = ingesterOver({ bd });
  const item = [{ workspace: WS, ticket: ticket(), epic: 'bc-ep1' }];
  await ing.sweep(cfg, item);
  await ing.sweep(cfg, item);
  await ing.sweep(cfg, item);
  assert.equal(bd.calls.filter((c) => c.startsWith('children')).length, 1, `asked ${bd.calls.length} times`);
});

await checksAsync('a half-written decomposition is left alone rather than added to', async () => {
  // The cost of the safe direction, stated: a run that died after two of five leaves two
  // children, and the next daemon start reads that as done. A duplicated tracker is the
  // worse of the two failures, and the row is what says the count looks short.
  const bd = fakeBd({ kids: ['bc-part1', 'bc-part2'] });
  const { ing, cfg } = ingesterOver({ bd, run: async () => assert.fail('no agent should have run') });
  await ing.sweep(cfg, [{ workspace: WS, ticket: ticket(), epic: 'bc-ep1' }]);
  assert.equal(ing.stateFor('climative', 'TECH-1').children, 2);
});

console.log('\nwhen it goes wrong');

await checksAsync('an agent that will not run leaves a reason on the row, not "reading"', async () => {
  const settled = [];
  const bd = fakeBd();
  const { ing, cfg } = ingesterOver({
    bd,
    settled,
    run: async () => {
      throw new Error('could not start claude: ENOENT');
    },
  });
  await ing.sweep(cfg, [{ workspace: WS, ticket: ticket(), epic: 'bc-ep1' }]);
  await ing.drain();
  const state = ing.stateFor('climative', 'TECH-1');
  assert.equal(state.state, 'failed');
  assert.match(state.error, /ENOENT/);
  assert.equal(settled.length, 1, 'and the phone parked on /api/poll is woken for it');
  assert.equal(settled[0].state, 'failed');
});

await checksAsync('a failure is not retried a minute later', async () => {
  const bd = fakeBd();
  let runs = 0;
  const { ing, cfg } = ingesterOver({
    bd,
    run: async () => {
      runs += 1;
      throw new Error('nope');
    },
  });
  const item = [{ workspace: WS, ticket: ticket(), epic: 'bc-ep1' }];
  await ing.sweep(cfg, item);
  await ing.drain();
  await ing.sweep(cfg, item);
  await ing.drain();
  assert.equal(runs, 1, 'a ticket bd will never accept would otherwise buy a claude process a minute, forever');
});

await checksAsync('a create that fails part way keeps what was made and says so', async () => {
  const bd = fakeBd({ createFails: (issue) => (/Cover/.test(issue.title) ? 'bd refused the title' : null) });
  const { ing, cfg } = ingesterOver({ bd, run: async () => TWO_BEADS });
  await ing.sweep(cfg, [{ workspace: WS, ticket: ticket(), epic: 'bc-ep1' }]);
  await ing.drain();
  assert.equal(bd.created.length, 1, 'beads has no transaction; the one that worked is real');
  assert.equal(ing.stateFor('climative', 'TECH-1').state, 'failed');
});

await checksAsync('a tracker that cannot be read is a failure, not a second decomposition', async () => {
  const bd = fakeBd({ childrenFails: 'dolt is locked' });
  const { ing, cfg } = ingesterOver({ bd, run: async () => assert.fail('nothing should have been ingested') });
  await ing.sweep(cfg, [{ workspace: WS, ticket: ticket(), epic: 'bc-ep1' }]);
  await ing.drain();
  assert.equal(ing.stateFor('climative', 'TECH-1').state, 'failed');
});

await checksAsync('a listener that throws does not take the ingestion down with it', async () => {
  const bd = fakeBd();
  const ing = createIngester({
    bd,
    run: async () => TWO_BEADS,
    onSettled: () => {
      throw new Error('the bus blew up');
    },
  });
  // No fetch is reached: with no `jira` block the settings say the workspace is off, the
  // run fails early, and `onSettled` still fires. What is asserted is that it survives.
  await ing.sweep({ ...CFG }, [{ workspace: WS, ticket: ticket(), epic: 'bc-ep1' }]);
  await ing.drain();
  assert.equal(ing.stateFor('climative', 'TECH-1').state, 'failed');
});

console.log('\none agent at a time');

await checksAsync('a morning of nine tickets does not put nine agents on this Mac', async () => {
  const bd = fakeBd();
  let open = 0;
  let peak = 0;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const { ing, cfg } = ingesterOver({
    bd,
    run: async () => {
      open += 1;
      peak = Math.max(peak, open);
      await gate;
      open -= 1;
      return TWO_BEADS;
    },
  });
  const many = ['TECH-1', 'TECH-2', 'TECH-3'].map((k) => ({ workspace: WS, ticket: ticket(k), epic: `bc-ep-${k}` }));
  const out = await ing.sweep(cfg, many);
  assert.equal(out.started.length, 1, `started ${out.started.length}`);
  assert.equal(out.waiting.length, 2);
  assert.equal(ing.stateFor('climative', 'TECH-2').state, 'queued', 'a waiting ticket says so rather than nothing');
  release();
  await ing.drain();
  assert.equal(peak, 1);
});

await checksAsync('and a queued ticket is picked up on a later tick without a second read', async () => {
  const bd = fakeBd();
  const { ing, cfg } = ingesterOver({ bd, run: async () => TWO_BEADS });
  const many = [
    { workspace: WS, ticket: ticket('TECH-1'), epic: 'bc-ep1' },
    { workspace: WS, ticket: ticket('TECH-2'), epic: 'bc-ep2' },
  ];
  await ing.sweep(cfg, many);
  await ing.drain();
  const before = bd.calls.filter((c) => c.startsWith('children')).length;
  await ing.sweep(cfg, many);
  await ing.drain();
  assert.equal(ing.stateFor('climative', 'TECH-2').state, 'done');
  assert.equal(bd.calls.filter((c) => c.startsWith('children')).length, before, 'the cold-start answer was kept');
});

console.log('\nthe row says which of the three it is');

/** public/app.js's own renderer, run for real — test/jirarow.mjs's method and reasons. */
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
function lift(src, opener) {
  const at = src.indexOf(opener);
  assert.notEqual(at, -1, `public/app.js no longer declares \`${opener}\``);
  if (opener.startsWith('function')) {
    let depth = 0;
    for (let i = src.indexOf('{', at); i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (!depth) return src.slice(at, i + 1);
      }
    }
    throw new Error(`unbalanced braces after ${opener}`);
  }
  // An arrow-function const: it ends at the first `;` outside every bracket.
  let depth = 0;
  for (let i = at; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') depth -= 1;
    else if (c === ';' && depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`no statement end after ${opener}`);
}
function renderIngest(ingest) {
  const context = vm.createContext({ String, Number, encodeURIComponent });
  vm.runInContext(
    [
      lift(APP, 'const esc = ('),
      lift(APP, 'function graphUrl(q)'),
      lift(APP, 'function jiraIngestHtml(row)'),
      'globalThis.out = jiraIngestHtml(ROW);',
    ].join('\n'),
    Object.assign(context, { ROW: { workspace: 'climative', jira: { key: 'TECH-1', ingest } } })
  );
  return context.out;
}

checks('before it has been read, the row says so and shows no id', () => {
  const html = renderIngest({ state: 'reading', epic: 'bc-ep1', children: 0 });
  assert.match(html, /reading the ticket/);
  assert.ok(!/bc-ep1/.test(html), 'the id appearing is what "the reading finished" means');
});

checks('once it has, the parent id is on the row and links to its bead', () => {
  const html = renderIngest({ state: 'done', epic: 'bc-ep1', children: 3 });
  assert.match(html, /bc-ep1/);
  assert.match(html, /\/graph\?ws=climative&amp;id=bc-ep1&amp;open=1/, 'the bead detail view, not the graph index');
  assert.match(html, /3 beads under it/);
});

checks('one bead is one bead', () => {
  assert.match(renderIngest({ state: 'done', epic: 'bc-ep1', children: 1 }), /1 bead under it/);
});

checks('a failure says so rather than reading forever', () => {
  const html = renderIngest({ state: 'failed', epic: 'bc-ep1', error: 'the ingestion timed out' });
  assert.match(html, /could not be read/);
  assert.match(html, /timed out/);
  assert.match(html, /bc-ep1/, 'the epic is still worth opening');
  assert.match(html, /jira-ingest bad/);
});

checks('and a reason out of JIRA cannot write markup into the inbox', () => {
  const html = renderIngest({ state: 'failed', epic: 'bc-ep1', error: '<img src=x onerror=alert(1)>' });
  assert.ok(!/<img/.test(html), 'an error message is a string off the network like any other');
});

checks('a ticket the ingester has not reached draws nothing at all', () => {
  assert.equal(renderIngest(null), '');
});

console.log('\nthe wiring, which is the half no unit test reaches');

{
  const server = fs.readFileSync(LIB('server.js'), 'utf8');
  check('the ingester is constructed beside the epic filer', /createIngester\(\{/.test(server));
  // The join, and specifically which list it is made from. Off `epics.filed` — this
  // tick's creations — a daemon that restarted an hour after the epics were filed would
  // never ingest a single one of them, and nothing about that looks broken.
  const join = server.slice(server.indexOf('const pending = []'), server.indexOf('jiraIngest?.sweep'));
  check(
    'it is handed every ticket whose epic is known, not only this tick’s',
    // `live` is `liveResults(out.results)` — the poller's own answer with the tickets you
    // cancelled taken out of it (bc-0i27.7), which the epic filer one line above is given
    // too. What this is guarding against is the join being made from `epics.filed`.
    join.length > 0 && /for \(const r of live \|\| \[\]\)/.test(join) && /knownFor\(/.test(join) && !/epics\.filed/.test(join),
    'the pending list is built from something other than the poller’s own results'
  );
  check(
    'and `live` really is that answer, filtered rather than replaced',
    /const live = liveResults\(out\.results\)/.test(server),
    'a cancelled ticket would still be read by an agent and given children under a closed epic'
  );
  check(
    'the state reaches the row through the poll payload',
    /ingest: jiraIngest\.stateFor\(t\.workspace, t\.key\)/.test(server)
  );
  check(
    'and a run that settles wakes the phones parked on /api/poll',
    /onSettled: \(out\) => \{[\s\S]{0,600}bus\.emit/.test(server),
    'a run outlives the sweep that started it, so the sweep cannot be what emits'
  );
  check('the ingester is on the app, so a test can reach it', /return \{[^}]*\bjiraIngest\b/.test(server));

  const consoleSrc = fs.readFileSync(LIB('console.js'), 'utf8');
  check(
    'the wire format is imported rather than copied',
    /export \{[^}]*\bPROTOCOL\b/.test(consoleSrc) && /import \{ PROTOCOL \} from '\.\/console\.js'/.test(fs.readFileSync(LIB('jiraingest.js'), 'utf8')),
    'a second copy of the block is a second thing that can drift from lib/draft.js'
  );
}

checks('the state key namespaces by workspace, or two JIRAs collide', () => {
  assert.notEqual(stateKey('a', 'TECH-1'), stateKey('b', 'TECH-1'));
});

console.log(failures ? `\n${failures} failed` : '\nall good');
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
