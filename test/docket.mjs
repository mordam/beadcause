#!/usr/bin/env node
/**
 * The docket — an epic's arc, and the four ways the obvious version of it is wrong.
 *
 *     npm test
 *     node test/docket.mjs
 *
 * bc-it26z. A page that summarises a fortnight of work is a page that can be quietly
 * wrong for a fortnight, so what is asserted here is not "it draws" but the rules that
 * decide *what* it draws:
 *
 * 1. **The root is the top of the family, not the nearest thing typed `epic`.** Types are
 *    what the filer chose and nothing enforces them. Both directions are pinned: a root
 *    typed `feature` is still the root, and a `parent-child` edge is the only edge that
 *    counts — `discovered-from` rides in the same array and lib/filing.js puts one on
 *    everything an agent files, so a walk that took any edge would pull in the backlog.
 * 2. **A ruling is found by the clock, not by the author.** lib/byline.js is explicit
 *    that a daemon byline covers both your relayed tap and the daemon's own bookkeeping,
 *    so the test is `close_reason` plus `closed_at` — and a comment left on the thread
 *    *after* the close must not be mistaken for the answer.
 * 3. **Nothing is dropped by the fold.** Every event is in the payload; `machine` is a
 *    flag on it. A stream that dropped the machine's lines could not answer the question
 *    the fold exists for, which is why a quiet week was quiet.
 * 4. **A cycle must not hang the daemon.** bd will not let you make one, but this index
 *    is assembled from an export another machine or an id-rewriting import may have
 *    written, and it is read on the request path. lib/ancestry.js's argument, and it
 *    applies to both walks here.
 *
 * Pure: a string of JSONL in, a payload out. No tracker, no daemon, no clock. `chronicle`
 * is the four lines that spawn `bd export` and cache it, and there is nothing in it worth
 * asserting that lib/cache.js's own suite does not assert better.
 *
 * The last check is the read-only one over public/docket.js, for the reason
 * test/beadsession.mjs holds the same one over its page: "this screen only reads" is
 * exactly the kind of property that stays true right up until somebody adds a
 * convenience button.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const { chronicleFrom, rootOf, familyOf, eventsOf, progressOf, docketFrom, epicsFrom, voiceOf, rulingComment } =
  await import(LIB('docket.js'));

/* --------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
const check = (name, fn) => {
  ran += 1;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
};

/* ---------------------------------------------------------------- the fixture */

const parent = (child, of) => ({ issue_id: child, depends_on_id: of, type: 'parent-child' });
const found = (child, from) => ({ issue_id: child, depends_on_id: from, type: 'discovered-from' });

const line = (o) => JSON.stringify(o);

/**
 * One epic, two children, one grandchild, and one bead that merely *mentions* the epic.
 *
 * `bc-zz` is the trap: it is `discovered-from` the epic, which is the edge lib/filing.js
 * puts on everything an agent files. It must never be in the family.
 */
const FIXTURE = [
  line({
    id: 'bc-ep',
    title: 'The epic',
    issue_type: 'feature',
    status: 'open',
    priority: 1,
    description: 'What this whole thing is for.',
    created_at: '2026-08-01T09:00:00Z',
    updated_at: '2026-08-20T09:00:00Z',
    comments: [
      {
        author: 'agent (a@b.c)',
        created_at: '2026-08-02T10:00:00Z',
        text:
          'Planning it.\n<!-- beadcause:plan -->\n```json\n' +
          JSON.stringify({
            groups: [
              { name: 'the read side', beads: ['bc-ep.1'], prs: [{ repo: 'r' }], prompt: 'go' },
              { name: 'the page', beads: ['bc-ep.2'], prs: [{ repo: 'r' }], prompt: 'go' },
            ],
          }) +
          '\n```\n<!-- /beadcause:plan -->',
      },
    ],
  }),
  line({
    id: 'bc-ep.1',
    title: 'The first child',
    status: 'closed',
    priority: 1,
    created_at: '2026-08-01T10:00:00Z',
    started_at: '2026-08-03T08:00:00Z',
    closed_at: '2026-08-05T12:00:00Z',
    close_reason: 'Answered via Beadcause',
    assignee: 'worker@example.com',
    labels: ['human'],
    dependencies: [parent('bc-ep.1', 'bc-ep')],
    comments: [
      { author: 'agent (a@b.c)', created_at: '2026-08-04T09:00:00Z', text: 'working on it' },
      { author: 'beadcause (a@b.c)', created_at: '2026-08-05T11:59:00Z', text: 'Do it the second way.' },
      { author: 'agent (a@b.c)', created_at: '2026-08-06T09:00:00Z', text: 'noted, thanks' },
    ],
  }),
  line({
    id: 'bc-ep.2',
    title: 'The second child',
    status: 'open',
    created_at: '2026-08-02T10:00:00Z',
    labels: ['human', 'unendorsed'],
    dependencies: [parent('bc-ep.2', 'bc-ep')],
    comments: [],
  }),
  line({
    id: 'bc-deep',
    title: 'A grandchild with an unrelated id',
    status: 'in_progress',
    created_at: '2026-08-07T10:00:00Z',
    dependencies: [parent('bc-deep', 'bc-ep.2')],
    comments: [],
  }),
  line({
    id: 'bc-zz',
    title: 'Merely discovered from the epic',
    status: 'open',
    created_at: '2026-08-08T10:00:00Z',
    dependencies: [found('bc-zz', 'bc-ep')],
    comments: [],
  }),
].join('\n');

const chron = chronicleFrom(FIXTURE);

/* ------------------------------------------------------------------ the parse */

check('every record is read, malformed lines and all', () => {
  const withJunk = chronicleFrom(`${FIXTURE}\nnot json at all\n\n`);
  assert.equal(withJunk.beads.size, 5, 'a junk line must cost one row and not the file');
});

check('the root carries its description; a child does not', () => {
  assert.match(chron.beads.get('bc-ep').description, /whole thing is for/);
  assert.equal(chron.beads.get('bc-ep.1').description, '', 'holding every body of prose is the cost this cache exists to avoid');
});

check('timestamps and the close reason survive the parse', () => {
  const one = chron.beads.get('bc-ep.1');
  assert.equal(one.createdAt, '2026-08-01T10:00:00Z');
  assert.equal(one.startedAt, '2026-08-03T08:00:00Z');
  assert.equal(one.closedAt, '2026-08-05T12:00:00Z');
  assert.equal(one.closeReason, 'Answered via Beadcause');
});

/* ------------------------------------------------------------------- the walk */

check('the root is the top of the family, whatever it is typed', () => {
  assert.equal(rootOf(chron.parents, 'bc-deep'), 'bc-ep', 'two levels up, through a child with an unrelated id');
  assert.equal(rootOf(chron.parents, 'bc-ep'), 'bc-ep', 'a root is its own root');
  assert.equal(chron.beads.get('bc-ep').issue_type, 'feature', 'and it is not typed `epic`');
});

check('a bead nothing knows about has no root', () => {
  assert.equal(rootOf(chron.parents, 'bc-nope'), 'bc-nope', 'unknown ids walk nowhere rather than throwing');
  assert.equal(docketFrom(chron, 'bc-nope'), null, 'and the payload is null, which the route turns into a 404');
});

check('only parent-child edges make a family', () => {
  const ids = familyOf(chron, 'bc-ep').map((b) => b.id);
  assert.deepEqual(ids, ['bc-ep', 'bc-ep.1', 'bc-ep.2', 'bc-deep']);
  assert.ok(!ids.includes('bc-zz'), 'discovered-from must not pull the backlog in');
});

check('the family is ordered oldest-filed first, not done-last', () => {
  const family = familyOf(chron, 'bc-ep');
  assert.equal(family[1].id, 'bc-ep.1', 'a bead that closed keeps the place it had');
  assert.equal(family[1].status, 'closed');
  assert.deepEqual(
    family.map((b) => b.depth),
    [0, 1, 1, 2]
  );
});

check('a cycle is answered, not hung', () => {
  const cyclic = chronicleFrom(
    [
      line({ id: 'a', title: 'a', created_at: '2026-01-01T00:00:00Z', dependencies: [parent('a', 'b')] }),
      line({ id: 'b', title: 'b', created_at: '2026-01-01T00:00:00Z', dependencies: [parent('b', 'a')] }),
    ].join('\n')
  );
  assert.ok(['a', 'b'].includes(rootOf(cyclic.parents, 'a')), 'rootOf stops rather than looping');
  assert.ok(familyOf(cyclic, 'a').length <= 2, 'familyOf visits each node once');
});

/* ------------------------------------------------------------------ the voice */

check('a voice is named, and the unknowable one says so', () => {
  assert.equal(voiceOf('agent (a@b.c)').voice, 'agent');
  assert.equal(voiceOf('beadcause (a@b.c)').voice, 'daemon');
  // A bare address: you at a terminal, or an agent's shell exporting your BEADS_ACTOR.
  // lib/byline.js says the two readings differ in the only way that matters, so the page
  // is told `person` and nothing stronger.
  assert.equal(voiceOf('adam@example.com').voice, 'person');
});

/* ---------------------------------------------------------------- the rulings */

check('the ruling is the last comment at or before the close', () => {
  const ruling = rulingComment(chron.beads.get('bc-ep.1'));
  assert.equal(ruling.text, 'Do it the second way.', 'not the "noted, thanks" left on the thread afterwards');
});

check('a bead closed for any other reason has no ruling', () => {
  const merged = chronicleFrom(
    line({
      id: 'x',
      title: 'x',
      status: 'closed',
      created_at: '2026-01-01T00:00:00Z',
      closed_at: '2026-01-02T00:00:00Z',
      close_reason: 'Landed as #92',
      comments: [{ author: 'beadcause', created_at: '2026-01-01T12:00:00Z', text: 'anything' }],
    })
  );
  assert.equal(rulingComment(merged.beads.get('x')), null);
});

/* ----------------------------------------------------------------- the stream */

check('nothing is dropped — the fold is a flag, not a filter', () => {
  const family = familyOf(chron, 'bc-ep');
  const events = eventsOf(family);
  const kinds = events.map((e) => e.kind);
  for (const want of ['filed', 'claimed', 'planned', 'ruled', 'commented', 'closed']) {
    assert.ok(kinds.includes(want), `${want} is missing from the stream`);
  }
  assert.ok(
    events.some((e) => e.machine),
    'a stream with nothing folded cannot answer why a week was quiet'
  );
});

check('the ruling is visible and the agent chatter is folded', () => {
  const events = eventsOf(familyOf(chron, 'bc-ep'));
  const ruled = events.find((e) => e.kind === 'ruled');
  assert.equal(ruled.machine, false);
  assert.match(ruled.text, /second way/);
  const chatter = events.find((e) => e.kind === 'commented' && e.text === 'working on it');
  assert.equal(chatter.machine, true, 'an agent talking to itself is the machine at work');
});

check('a comment on a human-replied bead reads as yours', () => {
  const replied = chronicleFrom(
    line({
      id: 'y',
      title: 'y',
      status: 'open',
      created_at: '2026-01-01T00:00:00Z',
      labels: ['human', 'human-replied'],
      comments: [{ author: 'beadcause (a@b.c)', created_at: '2026-01-02T00:00:00Z', text: 'try the other one' }],
    })
  );
  const ev = eventsOf(familyOf(replied, 'y')).find((e) => e.kind === 'replied');
  assert.ok(ev, '/api/comment is the only thing that sets that label');
  assert.equal(ev.machine, false);
});

check('the plan is an event and carries its group names', () => {
  const planned = eventsOf(familyOf(chron, 'bc-ep')).find((e) => e.kind === 'planned');
  assert.equal(planned.machine, false, 'phases are a decision about the epic');
  assert.deepEqual(planned.groups.map((g) => g.name), ['the read side', 'the page']);
});

check('the stream is oldest first and a close never precedes its own filing', () => {
  const events = eventsOf(familyOf(chron, 'bc-ep'));
  const ats = events.map((e) => e.at);
  assert.deepEqual(ats, [...ats].sort(), 'events must arrive in the order they happened');
  const sameSecond = eventsOf([
    {
      id: 'z',
      title: 'z',
      status: 'closed',
      labels: [],
      comments: [],
      createdAt: '2026-01-01T00:00:00Z',
      closedAt: '2026-01-01T00:00:00Z',
      closeReason: 'done',
    },
  ]);
  assert.deepEqual(sameSecond.map((e) => e.kind), ['filed', 'closed']);
});

check('pull requests join by bead, and a board nobody swept is not an empty one', () => {
  const family = familyOf(chron, 'bc-ep');
  const prs = [
    { number: 7, url: 'u', title: 'the first child', repoName: 'r', beads: [{ id: 'bc-ep.1' }], createdAt: '2026-08-04T00:00:00Z', mergedAt: '2026-08-05T00:00:00Z' },
    { number: 8, url: 'u', title: 'somebody else', repoName: 'r', beads: [{ id: 'bc-other' }], createdAt: '2026-08-04T00:00:00Z' },
  ];
  const kinds = eventsOf(family, { prs }).filter((e) => String(e.kind).startsWith('pr-'));
  assert.deepEqual(kinds.map((e) => e.number), [7, 7], 'only the pull request naming a bead in this family');
  assert.equal(docketFrom(chron, 'bc-ep', { prs }).prsKnown, true);
  assert.equal(docketFrom(chron, 'bc-ep').prsKnown, false, '"nobody looked" is not "there are none"');
});

check('sessions arrive folded', () => {
  const sessions = new Map([['bc-ep.1', [{ at: '2026-08-03T09:00:00Z', subject: 'ran', commit: 'abc' }]]]);
  const ev = eventsOf(familyOf(chron, 'bc-ep'), { sessions }).find((e) => e.kind === 'session');
  assert.equal(ev.machine, true);
  assert.equal(ev.bead, 'bc-ep.1');
});

/* --------------------------------------------------------------- the progress */

check('what is waiting on you is counted apart from what is open', () => {
  const p = progressOf(familyOf(chron, 'bc-ep'));
  assert.equal(p.counts.total, 4);
  assert.equal(p.counts.closed, 1);
  assert.equal(p.counts.in_progress, 1);
  assert.equal(p.counts.asking, 1, 'bc-ep.2 carries `human`; bc-ep.1 carries it too but is closed');
  assert.equal(p.counts.held, 1, 'and nobody may claim bc-ep.2 until it is endorsed');
  assert.equal(p.firstAt, '2026-08-01T09:00:00Z');
});

/* ---------------------------------------------------------------- the payload */

check('the payload roots at the epic and remembers where you came from', () => {
  const d = docketFrom(chron, 'bc-deep');
  assert.equal(d.root.id, 'bc-ep');
  assert.equal(d.focus, 'bc-deep', 'the page lights up the bead the card sent you from');
  assert.equal(d.family.length, 4);
  assert.equal(d.plan.groups.length, 2);
});

check('the family rows carry no comments — the stream is where those went', () => {
  const d = docketFrom(chron, 'bc-ep');
  assert.ok(
    d.family.every((b) => b.comments === undefined),
    'a family row and an event row are two shapes of the same fact, and one of them is enough'
  );
});

/* ------------------------------------------------------------------ the index */

check('the index is roots with children, newest activity first', () => {
  const rows = epicsFrom(chron);
  assert.deepEqual(rows.map((r) => r.id), ['bc-ep'], 'bc-zz is a root, and a root with no children is not an epic');
  assert.equal(rows[0].counts.total, 4);
});

/* ------------------------------------------------------------- the page reads */

check('public/docket.js writes nothing', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'public', 'docket.js'), 'utf8');
  assert.ok(!/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(src), 'a docket is the record, and a record is read');
  assert.ok(!/\bmethod:\s*"(POST|PUT|PATCH|DELETE)"/.test(src));
});

/* ------------------------------------------------------------------ the routes

   Everything above is a string in and a payload out. What it cannot reach is the joining
   the route does — resolving the workspace, refusing a bead the tracker has never had,
   and the two borrowed reads that must never become sweeps of their own. So the last
   section boots the real `createApp` against a fake `bd` whose `export` is the fixture,
   and asks it the two questions a phone asks.

   A fake `bd` rather than a tracker for the reason every suite here uses one: an embedded
   Dolt is single-writer and ~20 sessions share this Mac's workspace, so a suite that
   spawned the real thing would be slow when it passed and flaky when it did not. */

const http = await import('node:http');
const os = await import('node:os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-'));
const wsDir = path.join(tmp, 'ws');
fs.mkdirSync(path.join(wsDir, '.beads'), { recursive: true });

// `export` answers the fixture; everything else answers an empty list, which is what the
// rest of the daemon's boot asks for and none of what this section is about.
const FAKE = path.join(tmp, 'bd');
fs.writeFileSync(
  FAKE,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('export')) process.stdout.write(${JSON.stringify(FIXTURE)});
else process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const cfg = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'docket-token',
  actor: 'beadcause-test',
  bdBin: FAKE,
  workspaces: [{ name: 'demo', dir: wsDir }],
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const { createApp, listen } = await import(LIB('server.js'));
const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const port = await new Promise((resolve) => {
  const one = Array.isArray(servers) ? servers[0] : servers;
  if (one.listening) return resolve(one.address().port);
  one.once('listening', () => resolve(one.address().port));
});

const get = (pathname) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', headers: { 'x-beadcause-token': cfg.token } },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(out || '{}'), headers: res.headers }));
      }
    );
    req.on('error', reject);
    req.end();
  });

const asked = async (name, fn) => {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
};

await asked('GET /api/docket roots at the epic and says how old the answer is', async () => {
  const res = await get('/api/docket?ws=demo&id=bc-deep');
  assert.equal(res.status, 200);
  assert.equal(res.json.workspace, 'demo');
  assert.equal(res.json.root.id, 'bc-ep');
  assert.equal(res.json.focus, 'bc-deep');
  assert.equal(res.json.family.length, 4);
  assert.ok(res.json.events.length > 0);
  assert.match(String(res.headers['x-beadcause-kept'] || ''), /^(fresh|stale); age=/);
});

await asked('and it never claims there are no deliveries when nobody swept', async () => {
  const res = await get('/api/docket?ws=demo&id=bc-ep');
  assert.equal(res.json.prsKnown, false, 'the board is cold in a fixture, and `false` is the honest word for that');
});

await asked('a bead the workspace has never had is a 404 that names it', async () => {
  const res = await get('/api/docket?ws=demo&id=bc-nope');
  assert.equal(res.status, 404);
  assert.match(res.json.error, /bc-nope/);
});

await asked('an unknown workspace is a 400, and junk in `id` never reaches bd', async () => {
  assert.equal((await get('/api/docket?ws=nosuch&id=bc-ep')).status, 400);
  assert.equal((await get('/api/docket?ws=demo&id=' + encodeURIComponent('../../etc/passwd'))).status, 400);
});

await asked('GET /api/dockets lists the epics, labelled with their workspace', async () => {
  const res = await get('/api/dockets?workspace=demo');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.rows.map((r) => r.id), ['bc-ep']);
  assert.equal(res.json.rows[0].workspace, 'demo');
  assert.deepEqual(res.json.errors, []);
});

for (const one of Array.isArray(servers) ? servers : [servers]) one.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${ran - failures}/${ran} checks passed`);
process.exit(failures ? 1 : 0);
