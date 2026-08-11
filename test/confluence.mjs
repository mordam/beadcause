#!/usr/bin/env node
/**
 * Publishing a document to Confluence.
 *
 *     npm test
 *     node test/confluence.mjs
 *
 * A fake Confluence on loopback that answers the four v2 calls this uses and records
 * every one of them. Nothing here reaches Atlassian, and nothing writes outside a temp
 * directory — `BEADCAUSE_CONFIG_DIR` is moved before a single lib module is loaded, so
 * the `state.json` these cases write is the temp one.
 *
 * The four things asserted are the four acceptance criteria of bc-c6qp, and each of
 * them is a property a plausible refactor breaks:
 *
 * 1. **A re-publish updates the page it made.** The strongest form of this is the one
 *    tested: not "the second call was a PUT" but *nothing was created twice* — the
 *    fake counts creates, and one document publishing twice must leave that count at
 *    one. And with the `published` record thrown away, which is the case a duplicate
 *    would really arrive by, it still finds the page by title rather than making a
 *    second.
 * 2. **The URL is recorded.** In the returned record, which is what the route writes
 *    into `state.json` and comments onto a bead.
 * 3. **The target is named before it happens, and checked.** `target()` says which
 *    space and which title; `publish()` refuses a confirmation that disagrees with
 *    what `target()` would say *now*. The refusal is the assertion — a client-side
 *    promise would pass a test that only checked the happy path.
 * 4. **Unconfigured, no credential is read.** Not "publish returned an error" but the
 *    token reader was never called, which is why `apiToken` takes an injectable `read`
 *    at all: it is the only way to assert about a file that was not opened.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));
const section = (name) => console.log(`\n${name}\n`);

// Through `realpathSync`, because `assetPath` in lib/server.js resolves the file it is
// given and compares it against `assetRoots` as written — and on macOS `os.tmpdir()` is
// `/var/folders/…`, a symlink to `/private/var/folders/…`. A root that is not itself a
// real path matches nothing inside it, which reads as "the daemon refuses this file"
// rather than as a test that named its own directory two different ways.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-confluence-')));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });
// A token in the environment would answer for every case below and hide the file half
// entirely, so it is cleared whatever the shell running the suite happens to have.
delete process.env.BEADCAUSE_CONFLUENCE_TOKEN;

const DOC = path.join(tmp, 'ux-review.md');
fs.writeFileSync(DOC, '# The inbox, reviewed\n\nOne *paragraph*.\n\n- [x] done\n- [ ] not\n\n---\n');

const conf = await import(LIB('confluence.js'));

/* ------------------------------------------------------------ the fake Confluence */

/** Pages by id, and a log of every call, which is what the duplicate check reads. */
const pages = new Map();
let nextId = 1000;
const calls = [];

const fake = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace('/wiki/api/v2', '');
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    calls.push({ method: req.method, path: p, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization });
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const parsed = body ? JSON.parse(body) : null;

    if (req.method === 'GET' && p === '/spaces') {
      const key = url.searchParams.get('keys');
      if (key !== 'ENG') return send(200, { results: [] });
      return send(200, { results: [{ id: '901', key: 'ENG' }] });
    }
    if (req.method === 'GET' && /^\/spaces\/\d+\/pages$/.test(p)) {
      const title = url.searchParams.get('title');
      const found = [...pages.values()].filter((pg) => pg.title === title);
      return send(200, { results: found, _links: { base: 'http://127.0.0.1/wiki' } });
    }
    if (req.method === 'GET' && /^\/pages\/\d+$/.test(p)) {
      const page = pages.get(p.split('/')[2]);
      return page ? send(200, page) : send(404, { errors: [{ title: 'no such page' }] });
    }
    if (req.method === 'POST' && p === '/pages') {
      const id = String(++nextId);
      const page = {
        id,
        title: parsed.title,
        spaceId: parsed.spaceId,
        version: { number: 1 },
        body: parsed.body,
        _links: { webui: `/spaces/ENG/pages/${id}/x` },
      };
      pages.set(id, page);
      return send(200, page);
    }
    if (req.method === 'PUT' && /^\/pages\/\d+$/.test(p)) {
      const page = pages.get(p.split('/')[2]);
      if (!page) return send(404, { errors: [{ title: 'no such page' }] });
      Object.assign(page, { title: parsed.title, body: parsed.body, version: parsed.version });
      return send(200, page);
    }
    return send(404, { errors: [{ title: `fake has no ${req.method} ${p}` }] });
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const site = `http://127.0.0.1:${fake.address().port}`;

const KEY_FILE = path.join(process.env.BEADCAUSE_CONFIG_DIR, 'confluence.key');
fs.writeFileSync(KEY_FILE, 'atlassian-api-token\n', { mode: 0o600 });

const CFG = {
  confluence: { site, email: 'adam@example.com', space: 'ENG' },
  spaces: [
    { name: 'Work', workspaces: ['acme'], confluenceSpace: 'TEAM' },
    { name: 'Evening', workspaces: ['sideproject'], confluenceSpace: false },
    { name: 'Plain', workspaces: ['notes'] },
  ],
};
const creates = () => calls.filter((c) => c.method === 'POST' && c.path === '/pages').length;

/* ------------------------------------------------------- unconfigured, and silent */

section('an install that never asked for Confluence');

{
  let reads = 0;
  const read = (f) => {
    reads += 1;
    return fs.readFileSync(f, 'utf8');
  };

  check('no confluence block is not configured', conf.settings({}) === null);
  check('and it is not complained about either', conf.problem({}) === null);

  const empty = { confluence: { site: null, email: null, space: null, apiTokenFile: null } };
  check('the default block written by defaults() is the same silence', conf.problem(empty) === null && conf.settings(empty) === null);

  await conf.target(empty, { workspace: 'acme', filePath: DOC, text: 'x' }, { read });
  await assert
    .rejects(() => conf.publish(empty, { workspace: 'acme', filePath: DOC, text: 'x', confirm: {} }, { read }))
    .then(() => ok('publishing from an unconfigured install is refused'))
    .catch((e) => bad('publishing from an unconfigured install is refused', e.message));
  check('and the credential file was never opened', reads === 0, `${reads} reads`);

  const half = { confluence: { site: 'https://x.atlassian.net', email: '' } };
  check('half a block says which half is missing', /email/.test(conf.problem(half) || ''), String(conf.problem(half)));
}

/* -------------------------------------------------------------- where it may go */

section('which spaces may publish, and to where');

check('a space with its own key overrides the global', conf.spaceKeyFor(CFG, 'acme') === 'TEAM');
check('a space with none inherits the global', conf.spaceKeyFor(CFG, 'notes') === 'ENG');
check('a workspace in no space inherits it too', conf.spaceKeyFor(CFG, 'unknown') === 'ENG');
check(
  'confluenceSpace: false is a refusal, not "inherit"',
  conf.spaceKeyFor(CFG, 'sideproject') === null,
  'a space that has said no must not start publishing when a global default appears'
);
check('and with no global at all, nothing publishes by default', conf.spaceKeyFor({ confluence: { site, email: 'a@b' } }, 'x') === null);

/* --------------------------------------------------------- the credential's home */

section('where the token lives');

check('the default file is the one the config repo refuses', conf.DEFAULT_TOKEN_FILE.endsWith('.key'));
check('and it is inside the config directory', conf.apiTokenFile({}) === KEY_FILE);
check('a .key name draws no warning', conf.tokenFileWarning(CFG) === null);
check(
  'a name the config repo would commit does',
  /WILL be committed/.test(conf.tokenFileWarning({ confluence: { apiTokenFile: path.join(process.env.BEADCAUSE_CONFIG_DIR, 'token.txt') } }) || '')
);
check('a file outside that directory is your business', conf.tokenFileWarning({ confluence: { apiTokenFile: '/tmp/elsewhere.txt' } }) === null);
check('the token is read from the file', conf.apiToken(CFG) === 'atlassian-api-token');
check('the file is 0600', (fs.statSync(KEY_FILE).mode & 0o777) === 0o600);

/* ----------------------------------------------------------- the document itself */

section('the document, and what it becomes');

check('the title is the document’s own first heading', conf.titleFor(DOC, fs.readFileSync(DOC, 'utf8')) === 'The inbox, reviewed');
check('a document with no heading falls back to its filename', conf.titleFor('/a/b/notes-for-later.md', 'no heading here') === 'notes-for-later');

{
  const storage = await conf.toStorage(fs.readFileSync(DOC, 'utf8'), { dropLeadingHeading: true });
  check('storage format closes its void elements', !/<hr>/.test(storage) && /<hr \/>/.test(storage), storage);
  check('the heading that became the title is not in the body twice', !/<h1>/.test(storage), storage);
  check('a task list arrives as marks, not as inputs', !/<input/.test(storage) && /☑/.test(storage) && /☐/.test(storage), storage);
  check('and the prose survives', /<em>paragraph<\/em>/.test(storage), storage);
}

/* ----------------------------------------------------- naming the target, then acting */

section('what it would do, said before it does it');

let plan;
{
  plan = await conf.target(CFG, { workspace: 'notes', filePath: DOC, text: fs.readFileSync(DOC, 'utf8'), state: {} });
  check('it names the space and the title', plan.spaceKey === 'ENG' && plan.title === 'The inbox, reviewed', JSON.stringify(plan));
  check('and says this would create a page', plan.action === 'create' && plan.existing === null);
  check('a space that may not publish says so instead', (await conf.target(CFG, { workspace: 'sideproject', filePath: DOC, text: 'x', state: {} })).publishable === false);
  check('the credential goes as basic auth', calls.some((c) => c.auth === `Basic ${Buffer.from('adam@example.com:atlassian-api-token').toString('base64')}`));
}

section('publishing, and publishing again');

let first;
{
  first = await conf.publish(CFG, {
    workspace: 'notes',
    filePath: DOC,
    text: fs.readFileSync(DOC, 'utf8'),
    state: {},
    actor: 'adam@example.com',
    confirm: { spaceKey: 'ENG', title: 'The inbox, reviewed' },
  });
  check('a page is created', first.action === 'create' && first.pageId, JSON.stringify(first));
  check('and its URL comes back to be recorded', /\/spaces\/ENG\/pages\/\d+\//.test(first.url), first.url);
  check('the record says which file it came from', first.file === DOC && first.by === 'adam@example.com');
  check('exactly one page was created', creates() === 1, `${creates()} creates`);
}

{
  const state = { published: { [conf.publishKey(DOC)]: first } };
  fs.writeFileSync(DOC, '# The inbox, reviewed\n\nA **second** draft.\n');
  const again = await conf.publish(CFG, {
    workspace: 'notes',
    filePath: DOC,
    text: fs.readFileSync(DOC, 'utf8'),
    state,
    confirm: { spaceKey: 'ENG', title: 'The inbox, reviewed' },
  });
  check('the second publish updates the same page', again.pageId === first.pageId && again.action === 'update');
  check('and creates nothing', creates() === 1, `${creates()} creates`);
  check('the version moved', again.version === 2, JSON.stringify(again.version));
  check('the body was replaced, not appended to', /second/.test(pages.get(first.pageId).body.value) && !/One <em>paragraph/.test(pages.get(first.pageId).body.value));
  check('and the version carries a message saying who did it', /beadcause/.test(pages.get(first.pageId).version.message || ''));
}

{
  // The case a duplicate would really arrive by: the state file is gone (restored from
  // an older copy, or a second machine), so the record cannot be the thing that stops
  // it. The title search has to.
  const found = await conf.publish(CFG, {
    workspace: 'notes',
    filePath: DOC,
    text: fs.readFileSync(DOC, 'utf8'),
    state: {},
    confirm: { spaceKey: 'ENG', title: 'The inbox, reviewed' },
  });
  check('with the record lost it finds the page by title', found.pageId === first.pageId && found.action === 'update');
  check('and still creates nothing', creates() === 1, `${creates()} creates`);
}

section('the confirmation is checked, not trusted');

{
  await assert
    .rejects(
      () =>
        conf.publish(CFG, {
          workspace: 'notes',
          filePath: DOC,
          text: fs.readFileSync(DOC, 'utf8'),
          state: {},
          confirm: { spaceKey: 'ENG', title: 'Something else entirely' },
        }),
      (err) => err.status === 409 && /not what you were shown/.test(err.message)
    )
    .then(() => ok('a title that has moved since it was drawn is a 409'))
    .catch((e) => bad('a title that has moved since it was drawn is a 409', e.message));

  await assert
    .rejects(() =>
      conf.publish(CFG, {
        workspace: 'notes',
        filePath: DOC,
        text: fs.readFileSync(DOC, 'utf8'),
        state: {},
        confirm: { spaceKey: 'TEAM', title: 'The inbox, reviewed' },
      })
    )
    .then(() => ok('and so is a space that has moved'))
    .catch((e) => bad('and so is a space that has moved', e.message));

  await assert
    .rejects(() => conf.publish(CFG, { workspace: 'notes', filePath: DOC, text: 'x', state: {} }))
    .then(() => ok('no confirmation at all is refused outright'))
    .catch((e) => bad('no confirmation at all is refused outright', e.message));

  check('and none of those created anything', creates() === 1, `${creates()} creates`);
}

section('the record does not expire');

{
  const many = Object.fromEntries(
    Array.from({ length: 600 }, (_, i) => [`/doc/${i}.md`, { at: new Date(Date.UTC(2020, 0, 1 + i)).toISOString(), url: `u${i}` }])
  );
  const pruned = conf.prunePublished(many);
  check('the map is capped', Object.keys(pruned).length === conf.PUBLISHED_MAX);
  check('and it is the oldest that go, not the newest', Boolean(pruned['/doc/599.md']) && !pruned['/doc/0.md']);
  const small = { a: { at: '2000-01-01T00:00:00.000Z' } };
  check('nothing is dropped on age alone — an expired record is a duplicate page', Boolean(conf.prunePublished(small).a));
}

/* ------------------------------------------------------------------- the routes */

section('through the real server');

{
  const { createApp, listen } = await import(LIB('server.js'));
  const { boundPort } = await import('./helpers/net.mjs');

  const base = {
    port: 0,
    host: '127.0.0.1',
    token: 'test-token',
    workspaces: [],
    spaces: [],
    assetRoots: [tmp],
    claudeSessions: false,
    advocates: { enabled: false, workspaces: [] },
    ntfy: {},
  };

  const drive = async (cfg, fn) => {
    const app = createApp(cfg);
    const servers = listen(cfg, app.handler);
    const port = await boundPort(servers);
    try {
      await fn((p, init) => fetch(`http://127.0.0.1:${port}${p}`, { ...init, headers: { 'x-beadcause-token': cfg.token, ...(init?.headers || {}) } }));
    } finally {
      for (const s of servers) s.close();
    }
  };

  await drive({ ...base }, async (get) => {
    const res = await get(`/api/confluence?p=${encodeURIComponent(DOC)}`);
    const body = await res.json();
    check('an unconfigured daemon answers configured:false', res.status === 200 && body.configured === false, JSON.stringify(body));
    check('and says nothing else at all — the reader tab draws no button', Object.keys(body).length === 1, JSON.stringify(body));
  });

  await drive({ ...base, ...CFG }, async (get) => {
    const res = await get(`/api/confluence?p=${encodeURIComponent(DOC)}`);
    const body = await res.json();
    check('configured, it names the target', body.configured === true && body.spaceKey === 'ENG' && body.title, JSON.stringify(body));

    const outside = await get(`/api/confluence?p=${encodeURIComponent('/etc/hosts')}`);
    check('a file outside assetRoots is refused, as it is for the reader', outside.status === 403, String(outside.status));

    const pdf = path.join(tmp, 'report.pdf');
    fs.writeFileSync(pdf, '%PDF-1.4\n');
    const notProse = await get(`/api/confluence?p=${encodeURIComponent(pdf)}`);
    check('a document with no markdown in it is not publishable', (await notProse.json()).publishable === false);

    const wrote = await get('/api/confluence', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ p: DOC, spaceKey: 'ENG', title: 'The inbox, reviewed' }),
    });
    const record = await wrote.json();
    check('the POST publishes', wrote.status === 200 && record.ok === true, JSON.stringify(record));
    check('and still nothing was created twice', creates() === 1, `${creates()} creates`);

    const { loadState } = await import(LIB('config.js'));
    const saved = loadState().published?.[conf.publishKey(DOC)];
    check('the URL is written into state.json', Boolean(saved?.url) && saved.url === record.url, JSON.stringify(saved));

    const stale = await get('/api/confluence', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ p: DOC, spaceKey: 'ENG', title: 'A title nobody was shown' }),
    });
    check('a confirmation that disagrees is a 409 on the wire too', stale.status === 409, String(stale.status));
  });

  /* The other half of "recorded where the bead can show it". A fake `bd` on disk that
     writes down its own argv, because the assertion is about the words that reach the
     tracker: a URL a person can tap, on the bead they opened the document from. */
  {
    const BD_LOG = path.join(tmp, 'bd-calls.log');
    const BD_BIN = path.join(tmp, 'bd');
    fs.writeFileSync(
      BD_BIN,
      `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(BD_LOG)}, JSON.stringify(process.argv.slice(2)) + '\\n');
`,
      { mode: 0o755 }
    );
    const wsDir = path.join(tmp, 'ws');
    fs.mkdirSync(path.join(wsDir, '.beads'), { recursive: true });

    await drive({ ...base, ...CFG, bdBin: BD_BIN, actor: 'beadcause', workspaces: [{ name: 'notes', dir: wsDir }] }, async (get) => {
      const res = await get('/api/confluence', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ p: DOC, workspace: 'notes', bead: 'bc-c6qp', spaceKey: 'ENG', title: 'The inbox, reviewed' }),
      });
      const body = await res.json();
      check('naming a bead publishes and says which bead was told', res.status === 200 && body.bead === 'notes/bc-c6qp', JSON.stringify(body));

      const said = fs
        .readFileSync(BD_LOG, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
        .find((a) => a[0] === 'comment');
      check('the bead gets a comment, not a note or a close', Boolean(said) && said[1] === 'bc-c6qp', JSON.stringify(said));
      check('and the comment carries the page URL', said && said[2].includes(body.url), said?.[2]);
      check('and says a re-publish updates that same page', said && /updates this same page/.test(said[2]));
      check('nothing was closed', !fs.readFileSync(BD_LOG, 'utf8').includes('"close"'));
    });
  }
}

/* ------------------------------------------------------- the reader tab's own half */

section('the button, in the page that draws it');

/**
 * The real `public/doc.js` in a vm with a hand-made document, the way test/dictate.mjs
 * and test/spacebar.mjs load the real files they are about — so a rewrite of this logic
 * as a test-only module cannot pass while the phone ships something else.
 *
 * The stub answers every `getElementById`, which means it cannot notice an element that
 * is missing from doc.html. So the ids are also asserted statically, below, against the
 * page itself: between the two, both halves of "the button exists and is wired" are
 * covered, and neither is covered by either alone.
 */
async function loadDocJs({ search, routes }) {
  const vm = await import('node:vm');
  const requests = [];
  const els = new Map();
  const element = (id) => {
    if (!els.has(id)) {
      els.set(id, {
        id,
        hidden: true,
        disabled: false,
        textContent: '',
        innerHTML: '',
        classes: new Set(),
        clicks: [],
        classList: { add(c) { this.owner.classes.add(c); }, remove(c) { this.owner.classes.delete(c); }, toggle() {} },
        addEventListener(type, fn) { if (type === 'click') this.clicks.push(fn); },
        appendChild(child) { this.innerHTML += child.textContent; },
        replaceChildren() {},
        querySelectorAll: () => [],
      });
      const el = els.get(id);
      el.classList.owner = el;
    }
    return els.get(id);
  };

  const ctx = vm.createContext({
    location: { search },
    localStorage: { getItem: () => 'test-token' },
    document: {
      getElementById: element,
      createElement: () => ({ className: '', textContent: '' }),
      querySelectorAll: () => [],
      title: '',
    },
    window: {
      marked: { parse: (t) => `<p>${t}</p>` },
      DOMPurify: { sanitize: (h) => h },
      beadcause: { presence: { report() {} }, closeView() {} },
    },
    URLSearchParams,
    setTimeout,
    Date,
    Number,
    Math,
    JSON,
    String,
    Boolean,
    Object,
    fetch: async (url, init = {}) => {
      requests.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
      const answer = routes(url, init);
      if (!answer) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
      return {
        ok: answer.status === undefined || answer.status < 400,
        status: answer.status ?? 200,
        json: async () => answer.body,
        text: async () => answer.text ?? '',
      };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(HERE, '..', 'public', 'doc.js'), 'utf8'), ctx, { filename: 'doc.js' });
  // Three turns of the microtask queue: the asset read, the plan, and whatever a click
  // in a case below sets going. Cheap, and it is the whole of the asynchrony here.
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  return { requests, el: element, bar: element('doc-publish') };
}

const SEARCH = `?p=${encodeURIComponent('/docs/ux.md')}&ws=notes&bead=bc-c6qp`;
const asset = { text: '# Read me\n\nprose\n' };

{
  const { bar, requests } = await loadDocJs({
    search: SEARCH,
    routes: (url) => (url.startsWith('/api/asset') ? asset : url.startsWith('/api/confluence') ? { body: { configured: false } } : null),
  });
  check('unconfigured, the footer is not drawn at all', bar.hidden === true && bar.innerHTML === '', JSON.stringify(bar.innerHTML));
  check('and it asked exactly once', requests.filter((r) => r.url.startsWith('/api/confluence')).length === 1);
}

{
  const plan = {
    configured: true,
    publishable: true,
    spaceKey: 'ENG',
    title: 'Read me',
    action: 'create',
    existing: null,
    lastPublished: null,
  };
  const { bar, el, requests } = await loadDocJs({
    search: SEARCH,
    routes: (url, init) => {
      if (url.startsWith('/api/asset')) return asset;
      if (url.startsWith('/api/confluence') && (init?.method || 'GET') === 'GET') return { body: plan };
      return { body: { ok: true, url: 'https://x/wiki/p/1', title: 'Read me', spaceKey: 'ENG', action: 'create', bead: 'notes/bc-c6qp' } };
    },
  });

  check('configured, the target is named in full before anything is pressed', /ENG/.test(bar.innerHTML) && /Read me/.test(bar.innerHTML));
  check('and it says which of create or replace this is', /creates a new page/.test(bar.innerHTML), bar.innerHTML);
  check('the button is there', /id="publish-go"/.test(bar.innerHTML));

  const go = el('publish-go');
  await go.clicks[0]();
  check('the first press only arms it — nothing has been published', !requests.some((r) => r.method === 'POST'));
  check('and it re-reads the target back as the act', /ENG \/ Read me/.test(go.textContent) && go.classes.has('armed'), go.textContent);

  await go.clicks[0]();
  const post = requests.find((r) => r.method === 'POST');
  check('the second press publishes', Boolean(post));
  check(
    'and sends back the target it drew, which is what the daemon checks',
    post?.body?.spaceKey === 'ENG' && post?.body?.title === 'Read me',
    JSON.stringify(post?.body)
  );
  check('with the bead the document was opened from', post?.body?.bead === 'bc-c6qp' && post?.body?.workspace === 'notes', JSON.stringify(post?.body));
  check('and afterwards the footer is the page URL', /https:\/\/x\/wiki\/p\/1/.test(bar.innerHTML), bar.innerHTML);
}

{
  const page = fs.readFileSync(path.join(HERE, '..', 'public', 'doc.html'), 'utf8');
  check('doc.html has the footer doc.js draws into', /id="doc-publish"/.test(page));
  check('and it starts hidden, so an unconfigured install shows nothing', /id="doc-publish"[^>]*hidden/.test(page));
  const sw = fs.readFileSync(path.join(HERE, '..', 'public', 'sw.js'), 'utf8');
  check('and the three files that have to arrive together are in one cache version', /doc\.js/.test(sw) && /const CACHE = 'beadcause-v\d+'/.test(sw));
}

fake.close();
console.log(failures ? `\n\x1b[31m${failures} check${failures === 1 ? '' : 's'} failed\x1b[0m` : '\n\x1b[32mall good\x1b[0m');
process.exit(failures ? 1 : 0);
