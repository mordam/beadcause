#!/usr/bin/env node
/**
 * A bead's card shows its beadfiles block as its own row, not as raw machinery.
 *
 *     npm test
 *     node test/cardfilessurface.mjs
 *
 * bc-42ow.6. bc-42ow.2 taught the console to write a `beadfiles` fence into a filed
 * bead's `description`, and bc-42ow.1 taught `declaredFiles` to read it back — but
 * nothing between the two ever called `withoutSurface`, so every screen that draws
 * `description` drew the fence too, in the middle of the prose. This suite pins the
 * fix at both ends:
 *
 * 1. **`/api/bead` is where it has to happen, once.** It already returns derived
 *    fields beside the raw issue (`noRoot`, `model`, `approval`, `relay` — see
 *    test/approvalcard.mjs's identical argument), so `files` joins them and
 *    `description` comes back with the block already lifted out, for every reader of
 *    that one route: the inbox card, the graph drawer, and the P0 board's own bead
 *    body. Proved against a real daemon and a stub `bd`, not by reading the source.
 * 2. **A bead with no block is untouched.** `files` is `[]` and `description` is
 *    exactly what `bd show` said — the two must not diverge on the case that is still
 *    almost every bead in the tracker.
 * 3. **Both renderers draw the row, in the same shape.** `public/app.js`'s inbox
 *    brief and `public/graph.js`'s sheet share no script, so each carries its own
 *    `filesRowHtml` — proved by running each for real, in a `vm`, the way
 *    test/approvalcard.mjs runs `approvalChipHtml` and `sheetHtml`.
 * 4. **The row sits where the block used to.** Right after the description, not
 *    buried under notes or the thread — `withSurface` appends the block at the end
 *    of the prose, so the pills replace it exactly there.
 * 5. **`expand()` actually carries the field onto the card it opens.** The route can
 *    answer `files` correctly and the card never see it if the copy is missed — the
 *    same trap `q.notes`/`q.comments` already guard against.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (f) => path.join(ROOT, 'lib', f);
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let failures = 0;
let ran = 0;
const check = async (name, fn) => {
  ran += 1;
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.message).split('\n').slice(0, 6).join('\n      ')}`);
  }
};

/* =================================================== 1+2. the route, for real */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-cardfiles-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const BEADS = path.join(tmp, 'beads', 'zz', '.beads');
const CHECKOUT = path.join(tmp, 'projects', 'zz');
fs.mkdirSync(BEADS, { recursive: true });
fs.mkdirSync(CHECKOUT, { recursive: true });

const WITH_BLOCK = ['The work, described.', '', '```beadfiles', 'lib/a.js', 'test/a.mjs', '```'].join('\n');
const NO_BLOCK = 'Just prose, no fence at all.';

const bin = path.join(tmp, 'bd-stub');
fs.writeFileSync(
  bin,
  [
    '#!/usr/bin/env node',
    'const args = process.argv.slice(2);',
    'const verb = args[0];',
    "if (verb === 'export') { console.log(''); process.exit(0); }",
    "if (verb === 'show') {",
    '  const id = args[1];',
    "  const rows = {",
    `    'zz-block': { id: 'zz-block', title: 'has a surface', status: 'open', description: ${JSON.stringify(
      WITH_BLOCK
    )} },`,
    `    'zz-bare': { id: 'zz-bare', title: 'has none', status: 'open', description: ${JSON.stringify(NO_BLOCK)} },`,
    '  };',
    '  const row = rows[id];',
    '  if (!row) { process.stderr.write(`Error fetching ${id}: no issue found matching "${id}"\\n`); process.exit(1); }',
    "  if (args.includes('--include-comments')) row.comments = [];",
    '  console.log(JSON.stringify([row]));',
    '  process.exit(0);',
    '}',
    'process.exit(0);',
  ].join('\n')
);
fs.chmodSync(bin, 0o755);

const { createApp, listen } = await import(LIB('server.js'));
const cfg = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'cardfiles-test-token',
  actor: 'beadcause-test',
  bdBin: bin,
  workspaces: [{ name: 'zz', dir: BEADS }],
  sessionDirs: { zz: CHECKOUT },
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};
const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const port = await boundPort(servers);

const call = (id) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/api/bead?workspace=zz&id=${id}`,
        method: 'GET',
        headers: { 'x-beadcause-token': cfg.token },
      },
      (res) => {
        let raw = '';
        res.on('data', (d) => (raw += d));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
      }
    );
    req.on('error', reject);
    req.end();
  });

console.log('\n/api/bead lifts the block out and hands the paths across as their own field\n');

await check('a bead with a beadfiles block: the paths come back as `files`, the block leaves `description`', async () => {
  const { status, body } = await call('zz-block');
  assert.equal(status, 200);
  assert.deepEqual(body.files, ['lib/a.js', 'test/a.mjs']);
  assert.equal(body.description, 'The work, described.', 'the fence should be gone and the prose untouched');
  assert.ok(!body.description.includes('```'), 'a fence survived the route meant to strip it');
});

await check('a bead with no block: `files` is empty and the description is exactly what bd said', async () => {
  const { status, body } = await call('zz-bare');
  assert.equal(status, 200);
  assert.deepEqual(body.files, []);
  assert.equal(body.description, NO_BLOCK);
});

for (const s of servers) s.close();
await cleanupTmp(tmp);

/* ============================================== 3+4. both renderers, run for real */

/** Slice one declaration out of a page script — the shape test/approvalcard.mjs uses. */
function lift(src, opener, label) {
  const at = src.indexOf(opener);
  assert.notEqual(at, -1, `${label} no longer declares \`${opener}\``);
  if (/^(async )?function/.test(opener)) {
    let depth = 0;
    for (let i = src.indexOf('{', at); i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (!depth) return src.slice(at, i + 1);
      }
    }
    throw new Error(`unbalanced braces after ${opener} in ${label}`);
  }
  let depth = 0;
  for (let i = at; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') depth -= 1;
    else if (c === ';' && depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`no statement end after ${opener} in ${label}`);
}

/** What a phone can actually read: the text, with every attribute taken off it. */
const visible = (html) => html.replace(/<[^>]*>/g, '').trim();

const APP = read('public/app.js');
const GRAPH = read('public/graph.js');

console.log('\nthe inbox card draws the same field the route now sends');

const STUB = () => '';
const briefReal = { String, Array, Boolean, JSON };
const briefCtx = vm.createContext(
  new Proxy(briefReal, { has: () => true, get: (t, k) => (k in t ? t[k] : STUB) })
);
vm.runInContext(
  [lift(APP, 'const esc = (', 'app.js'), lift(APP, 'const filesRowHtml = (', 'app.js'), lift(APP, 'function agentBriefHtml(q)', 'app.js')].join(
    '\n'
  ),
  briefCtx
);
const brief = (q) => vm.runInContext('agentBriefHtml(Q)', Object.assign(briefCtx, { Q: q }));

await check('a declared surface draws as its own labelled row of pills', () => {
  const html = brief({ description: 'Some prose.', files: ['lib/a.js', 'test/a.mjs'] });
  assert.match(html, /class="prop-field pills"/);
  assert.match(visible(html), /Expects to touch/);
  assert.match(html, /<span class="pill">lib\/a\.js<\/span>/);
  assert.match(html, /<span class="pill">test\/a\.mjs<\/span>/);
});

await check('a bead with no declared files draws nothing extra — the brief looks as it did before', () => {
  const html = brief({ description: 'Some prose.', files: [] });
  assert.ok(!html.includes('prop-field'), 'a files row was drawn for a bead that declared none');
  const bare = brief({ description: 'Some prose.' });
  assert.ok(!bare.includes('prop-field'), 'a payload with no `files` field at all must draw nothing, not throw');
});

await check('the row sits right after the description, ahead of notes and the thread', () => {
  const html = brief({
    description: 'Some prose.',
    files: ['lib/a.js'],
    notes: 'What actually happened.',
    comments: [{ author: 'adam', text: 'a note' }],
  });
  const desc = html.indexOf('class="md"');
  const files = html.indexOf('prop-field pills');
  const notesAt = html.indexOf('section-label">notes');
  assert.ok(desc >= 0 && files > desc, 'the files row landed above the description');
  assert.ok(notesAt > files, 'the files row landed below notes, where the fence never was');
});

await check('a quoted path cannot write markup into the row', () => {
  const html = brief({ description: 'x', files: ['"><img src=x>lib/a.js'] });
  assert.ok(!html.includes('<img'), html);
});

console.log('\nthe graph drawer draws the same field, in a script that shares nothing but style.css');

const START = 'const beadUrl = (id) =>';
const END = "return parts.join('');";
const from = GRAPH.indexOf(START);
const to = GRAPH.indexOf(END, from);
assert.ok(from >= 0 && to > from, 'public/graph.js no longer has a beadUrl…sheetHtml region to slice');
const region = GRAPH.slice(from, GRAPH.indexOf('\n  }', to) + 4);
const sheetCtx = vm.createContext({
  esc: (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
  statusColor: () => 'colour(open)',
  md: (t) => `<p>${t}</p>`,
  FROM_BD: { fromBd: true },
  workspace: 'zz',
});
const { sheetHtml } = vm.runInContext(`${region}\n;({ sheetHtml })`, sheetCtx);

await check('the sheet draws the same row, for the same bead the inbox card would show', () => {
  const html = sheetHtml({ id: 'zz-1', title: 'A bead', status: 'open', description: 'Some prose.', files: ['lib/a.js'] });
  assert.match(html, /class="prop-field pills"/);
  assert.match(visible(html), /Expects to touch/);
  assert.match(html, /<span class="pill">lib\/a\.js<\/span>/);
});

await check('a bead with none draws exactly the sheet it drew before this landed', () => {
  const html = sheetHtml({ id: 'zz-1', title: 'A bead', status: 'open', description: 'Some prose.' });
  assert.ok(!html.includes('prop-field'), 'a files row appeared on a bead that declared none');
});

await check('on the sheet too, the row sits right after the description', () => {
  const html = sheetHtml({
    id: 'zz-1',
    title: 'A bead',
    status: 'open',
    description: 'Some prose.',
    acceptance_criteria: 'Done when it is done.',
    files: ['lib/a.js'],
  });
  const desc = html.indexOf('class="md"');
  const files = html.indexOf('prop-field pills');
  const acceptance = html.indexOf('section-label">acceptance');
  assert.ok(desc >= 0 && files > desc, 'the files row landed above the description on the sheet');
  assert.ok(acceptance > files, 'the files row landed below acceptance, where the fence never was');
});

/* ================================================== 5. expand() actually copies it */

console.log('\nand the tap that opens the card actually carries the field across');

await check('expand() copies `files` off /api/bead the same way it copies notes and comments', () => {
  const at = APP.indexOf('async function expand(');
  assert.notEqual(at, -1, 'public/app.js no longer declares expand()');
  const body = APP.slice(at, APP.indexOf('\n  }', at));
  assert.match(body, /q\.files\s*=\s*full\.files\s*\|\|\s*\[\]/, 'expand() fetched the full record and never copied `files` onto the card');
});

/* ---------------------------------------------------------------------- end */

console.log(`\n${failures ? `${failures} of ${ran} failed` : `all ${ran} checks passed`}`);
process.exit(failures ? 1 : 0);
