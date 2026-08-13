#!/usr/bin/env node
/**
 * Edit mode — the freeze, and the anchor back to source.
 *
 *     npm test
 *     node test/editmode.mjs
 *
 * Edit mode (bc-p49x.1) is the foundation the rest of bc-p49x sits on, and everything
 * built on top of it inherits whatever this gets wrong. Four things are worth a suite,
 * and only the first is visible by reading one function:
 *
 * 1. **The freeze has to actually stop the paint, and the exit has to take the arrears.**
 *    A mode that half-freezes is worse than no mode: the element you are pointing at is
 *    replaced under your thumb and the edit is filed against whatever took its place.
 *    And a mode that freezes and never thaws leaves an inbox that has silently stopped
 *    updating, which looks exactly like an app that has hung.
 *
 * 2. **The grep-key premise has to hold against the real source.** The whole design
 *    rests on class names being hand-written in the template literals that emit them —
 *    so `class="p0-title"` in the DOM is eleven characters that appear once in
 *    public/app.js. That is a claim about this repo, not a law, and it is checked here
 *    against the actual files rather than against a fixture that agrees with it.
 *
 * 3. **Tracker text must not be offered as app text.** Retyping a bead title is editing
 *    `bd` while believing you are editing the app, and an edit filed that way would be
 *    acted on against a line of public/app.js that does not exist. The precedence — data
 *    beats source when a string is both — is the load-bearing part, and it is the part
 *    that reads as an arbitrary tie-break until it is wrong.
 *
 * 4. **"Not found" has to be reachable and honest.** An anchor that always claims a
 *    site is an anchor nobody can trust; the acceptance criteria ask for exactly one
 *    site *or* an honest none, and the second half is the one a check normally forgets.
 *
 * The client half runs the real public/editmode.js in a vm with a hand-made document,
 * the way test/spacebar.mjs runs the real picker. The document is a fake and cannot see
 * a missing element, so it is paired with static reads of index.html, public/sw.js and
 * the two paint gates in public/app.js — and those reads are scoped to the code line
 * rather than the block, because every file in this repo argues in prose that names the
 * identifiers a lazy grep would match.
 *
 * What is deliberately NOT here: whether a real poll against a real Chrome leaves the
 * DOM alone. That needs a browser and it is scripts/editmode-check.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let failures = 0;
let ran = 0;
function check(name, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${err.message.split('\n')[0]}`);
  }
}

console.log('\nedit mode');

/* ================================================================ a fake document */

/**
 * Elements enough to be walked, read and appended to — and no more.
 *
 * `textContent` is the concatenation of the subtree, because that is what the anchor
 * reads and what a person pointing at a card sees; everything else is the handful of
 * properties `anchorFor` and the banner actually touch.
 */
function makeEl(tag, attrs = {}, kids = [], text = '') {
  const el = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    attrs: { ...attrs },
    children: kids,
    own: text,
    parentElement: null,
    dataset: {},
    id: attrs.id || '',
    className: attrs.class || '',
    events: {},
    getAttribute: (k) => (k in el.attrs ? el.attrs[k] : null),
    setAttribute: (k, v) => {
      el.attrs[k] = v;
      if (k === 'id') el.id = v;
    },
    addEventListener: (type, fn) => {
      el.events[type] = fn;
    },
    remove() {
      const at = el.parentElement?.children.indexOf(el);
      if (at !== undefined && at !== -1) el.parentElement.children.splice(at, 1);
      el.parentElement = null;
    },
    appendChild(node) {
      node.parentElement = el;
      el.children.push(node);
      return node;
    },
    querySelector(sel) {
      const want = String(sel).replace(/^\[|\]$/g, '');
      const [name, value] = want.split('=');
      const v = value ? value.replace(/^"|"$/g, '') : null;
      const walk = (node) => {
        for (const kid of node.children) {
          if (kid.getAttribute(name) === v) return kid;
          const deep = walk(kid);
          if (deep) return deep;
        }
        return null;
      };
      return walk(el);
    },
    closest(sel) {
      const name = String(sel).replace(/^\[|\]$/g, '');
      let node = el;
      while (node) {
        if (node.getAttribute?.(name) !== null && node.getAttribute?.(name) !== undefined) return node;
        node = node.parentElement;
      }
      return null;
    },
    get textContent() {
      return el.own + el.children.map((k) => k.textContent).join('');
    },
    // `innerHTML =` on a created node is how the banner builds itself. Parsed only far
    // enough to find the one element the module then goes looking for.
    set innerHTML(html) {
      el.html = html;
      el.children = [];
      for (const m of String(html).matchAll(/<(\w+)[^>]*?class="([^"]*)"([^>]*)>([^<]*)</g)) {
        const attrs = { class: m[2] };
        for (const a of m[3].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
        el.appendChild(makeEl(m[1], attrs, [], m[4]));
      }
    },
    get innerHTML() {
      return el.html || '';
    },
    classList: {
      add: (n) => {
        const set = new Set(String(el.className).split(/\s+/).filter(Boolean));
        set.add(n);
        el.className = [...set].join(' ');
        el.attrs.class = el.className;
      },
      remove: (n) => {
        const set = new Set(String(el.className).split(/\s+/).filter(Boolean));
        set.delete(n);
        el.className = [...set].join(' ');
        el.attrs.class = el.className;
      },
      toggle: (n, on) => (on ? el.classList.add(n) : el.classList.remove(n)),
      contains: (n) => String(el.className).split(/\s+/).includes(n),
    },
  };
  for (const kid of kids) kid.parentElement = el;
  if (attrs['data-key']) el.dataset.key = attrs['data-key'];
  return el;
}

/**
 * Load the real file into a room with a document, a fetch and nothing else.
 *
 * `files` is what the page's own source is, as far as the module can tell: the fetch
 * hands back exactly these and the anchor resolves against exactly these, which is what
 * lets one case feed it the real public/app.js and another feed it two lines.
 */
function load({ files = {}, scripts = [], body = null, button = null } = {}) {
  const root = body || makeEl('body');
  const fetched = [];
  const win = {
    beadcause: {},
    location: { pathname: '/' },
    fetch: async (url) => {
      fetched.push(url);
      const text = files[url];
      return text === undefined ? { ok: false } : { ok: true, text: async () => text };
    },
  };
  const document = {
    body: root,
    scripts: scripts.map((src) => makeEl('script', { src })),
    createElement: (tag) => makeEl(tag),
    getElementById: (id) => (id === 'editmode' ? button : null),
  };
  win.document = document;
  const ctx = vm.createContext({ window: win, document, Promise, JSON });
  vm.runInContext(read('public/editmode.js'), ctx, { filename: 'editmode.js' });
  return { edit: ctx.window.beadcause.editMode, body: root, fetched, win };
}

/* ===================================================================== 1. the mode */

check('the screen is not frozen until the mode is on, and thaws when it is off', () => {
  const { edit, body } = load();
  assert.equal(edit.frozen(), false, 'frozen before anything happened');
  edit.on();
  assert.equal(edit.frozen(), true, 'not frozen with the mode on');
  assert.equal(body.classList.contains('editing'), true, 'body.editing missing');
  edit.off();
  assert.equal(edit.frozen(), false, 'still frozen after leaving the mode');
  assert.equal(body.classList.contains('editing'), false, 'body.editing left behind');
});

check('the mode tells its listeners both ways — this is app.js`s catch-up repaint', () => {
  const { edit } = load();
  const said = [];
  edit.onChange((on) => said.push(on));
  edit.on();
  edit.on();
  edit.off();
  edit.off();
  // Twice on, twice off, and only the transitions are reported: a second `on()` while
  // the mode is already on must not make app.js think it has arrears to take.
  assert.deepEqual(said, [true, false]);
});

check('a listener that throws does not stop the mode or the listener after it', () => {
  const { edit } = load();
  const said = [];
  edit.onChange(() => {
    throw new Error('some page script');
  });
  edit.onChange((on) => said.push(on));
  edit.on();
  assert.equal(edit.frozen(), true);
  assert.deepEqual(said, [true]);
});

check('the banner says the screen is frozen, and takes itself down', () => {
  const { edit, body } = load();
  edit.on();
  const bar = body.children.find((k) => k.className === 'editbar');
  assert.ok(bar, 'no banner');
  assert.match(bar.textContent, /frozen/i, `banner says "${bar.textContent}"`);
  edit.off();
  assert.equal(body.children.some((k) => k.className === 'editbar'), false, 'banner left behind');
});

check('Done on the banner is a second way out', () => {
  const { edit, body } = load();
  edit.on();
  const bar = body.children.find((k) => k.className === 'editbar');
  const done = bar.children.find((k) => k.getAttribute('data-act') === 'edit-done');
  assert.ok(done?.events.click, 'the banner has no Done wired to anything');
  done.events.click();
  assert.equal(edit.frozen(), false, 'Done did not leave the mode');
});

check('the ✏️ in the page toggles the mode and reports which way it is', () => {
  const button = makeEl('button', { id: 'editmode' });
  const { edit } = load({ button });
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  button.events.click();
  assert.equal(edit.frozen(), true);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(button.classList.contains('on'), true);
  button.events.click();
  assert.equal(edit.frozen(), false);
  assert.equal(button.getAttribute('aria-pressed'), 'false');
});

check('a page with no ✏️ still gets the whole module', () => {
  // Which is how the checks and, later, the console drive it — and what makes adding
  // the mode to a second page a question about that page's layout alone.
  const { edit } = load();
  edit.on();
  assert.equal(edit.frozen(), true);
});

/* ============================================================ 2. the real source */

const APP = read('public/app.js');
const INDEX = read('public/index.html');
const REAL = { '/': INDEX, '/app.js': APP, '/editmode.js': read('public/editmode.js') };

/** The module, with the app's actual source behind it and its sources already read. */
async function realised(el) {
  const host = load({ files: REAL, scripts: ['/app.js', '/editmode.js'] });
  host.edit.on();
  await host.edit.ready();
  return { ...host, anchor: host.edit.anchorFor(el) };
}

// A P0 card's title, as public/app.js actually emits it: `<a class="p0-title" ...>`.
const p0 = await realised(makeEl('a', { class: 'p0-title', href: '/graph?x' }, [], 'Some epic'));

check('a hand-written class name resolves to exactly one line of the real source', () => {
  assert.equal(p0.anchor.source.found, 1, `found ${p0.anchor.source.found}: ${JSON.stringify(p0.anchor.source.tried)}`);
  assert.equal(p0.anchor.source.sites[0].file, '/app.js');
  assert.match(p0.anchor.source.sites[0].text, /p0-title/);
});

check('and the anchor carries the chain, the classes and the text with it', () => {
  assert.equal(p0.anchor.selector, 'a.p0-title');
  assert.deepEqual([...p0.anchor.classes], ['p0-title']);
  assert.equal(p0.anchor.text.value, 'Some epic');
  assert.equal(p0.anchor.tag, 'a');
  assert.equal(p0.anchor.page, '/');
});

check('the vendored bundles are never read — they emit none of this app`s markup', () => {
  const host = load({ files: REAL, scripts: ['/app.js', '/vendor/marked.js', 'https://cdn/x.js'] });
  host.edit.on();
  assert.deepEqual(host.fetched, ['/', '/app.js']);
});

check('a class named in a comment is not a site — prose is not where markup is emitted', async () => {
  // The regression case, and it is not hypothetical: the first version of this counted
  // the paragraph at the top of public/editmode.js, which quotes `class="p0-title"`
  // while explaining why class names make good grep keys. Two sites reads as "ambiguous,
  // refuse the edit" — the wrong answer, reached by counting an English sentence.
  const host = load({
    files: {
      '/': '<div class="q">x</div>',
      '/a.js': ['// the .q class is drawn below', '/* and `class="q"` again, in a block */', 'h += `<i class="q">y</i>`;'].join('\n'),
    },
    scripts: ['/a.js'],
  });
  host.edit.on();
  await host.edit.ready();
  const a = host.edit.anchorFor(makeEl('i', { class: 'q' }, [], 'y'));
  assert.equal(a.source.found, 1, JSON.stringify(a.source.sites));
  assert.equal(a.source.sites[0].line, 3, 'the site is on the wrong line — the blanking moved an offset');
});

check('but a comment`s spelling does not blank the code around it', async () => {
  // `//` inside a string is not a comment, a quote inside a comment does not open one,
  // and this app nests template literals one inside another. All three on one line,
  // because all three are on real lines of public/app.js.
  const host = load({
    files: { '/a.js': ['const u = "http://x/";', 'h += `${esc(`${u}&open=1`)}<b class="deep">z</b>`;'].join('\n') },
    scripts: ['/a.js'],
  });
  host.edit.on();
  await host.edit.ready();
  const a = host.edit.anchorFor(makeEl('b', { class: 'deep' }, [], 'z'));
  assert.equal(a.source.found, 1, `the scanner lost the line: ${JSON.stringify(a.source.tried)}`);
});

check('a regular expression holding a slash pair is not a comment either', async () => {
  const host = load({
    files: { '/a.js': ['const bare = /^https?:\\/\\//i.test(u) ? 1 : 2;', 'h += `<b class="after">z</b>`;'].join('\n') },
    scripts: ['/a.js'],
  });
  host.edit.on();
  await host.edit.ready();
  const a = host.edit.anchorFor(makeEl('b', { class: 'after' }, [], 'z'));
  assert.equal(a.source.found, 1, `a regex ate the rest of the file: ${JSON.stringify(a.source.tried)}`);
});

check('an id beats a class, because an id is unique on the page by definition', async () => {
  // `#refresh` is the ⟳ in the top bar, written once in index.html.
  const { anchor } = await realised(makeEl('button', { id: 'refresh', class: 'icon-btn' }, [], '⟳'));
  assert.equal(anchor.source.kind, 'id');
  assert.equal(anchor.source.found, 1, JSON.stringify(anchor.source.tried));
  assert.equal(anchor.source.sites[0].file, '/');
});

check('a data-act names the one handler branch that answers it', async () => {
  const { anchor } = await realised(makeEl('button', { class: 'p0-advocate', 'data-act': 'advocate' }, [], 'Put an advocate on it'));
  assert.equal(anchor.source.found, 1, JSON.stringify(anchor.source.tried));
  assert.match(anchor.source.query, /data-act|p0-advocate/);
});

check('the chain stops at the nearest id rather than walking to the body', async () => {
  const list = makeEl('main', { id: 'list', class: 'list' });
  const card = makeEl('div', { class: 'card', 'data-key': 'demo/bc-1' });
  const title = makeEl('div', { class: 'title' }, [], 'A question');
  list.appendChild(card);
  card.appendChild(title);
  const { anchor } = await realised(title);
  assert.equal(anchor.selector, '#list > div.card > div.title');
  assert.equal(anchor.key, 'demo/bc-1', 'the owning chunk is not on the anchor');
});

check('an element nothing in the source drew reports an honest none', async () => {
  const { anchor } = await realised(makeEl('div', { class: 'zzz-not-a-real-class' }, [], 'zzz not real text either'));
  assert.equal(anchor.source.found, 0, JSON.stringify(anchor.source.sites));
  assert.deepEqual([...anchor.source.sites], []);
  assert.ok(anchor.source.tried.length >= 1, 'it did not say what it tried');
  assert.equal(anchor.text.from, 'unknown');
  assert.equal(anchor.editable.ok, false);
});

/* ================================================== 3. source text versus tracker text */

check('text written in this app`s source is source text, and may be retyped', async () => {
  const host = load({ files: { '/': '<button class="q">Refresh</button>' }, scripts: [] });
  host.edit.on();
  await host.edit.ready();
  const a = host.edit.anchorFor(makeEl('button', { class: 'q' }, [], 'Refresh'));
  assert.equal(a.text.from, 'source');
  assert.equal(a.editable.ok, true, a.editable.why);
});

check('text the payload put there is tracker text, and may not be', async () => {
  const host = load({ files: { '/': '<div class="title"></div>' }, scripts: [] });
  host.edit.provideText(() => ['Edit the app from inside the app']);
  host.edit.on();
  await host.edit.ready();
  const a = host.edit.anchorFor(makeEl('div', { class: 'title' }, [], 'Edit the app from inside the app'));
  assert.equal(a.text.from, 'data');
  assert.equal(a.editable.ok, false);
  assert.match(a.editable.why, /tracker/);
});

check('a bead titled "Refresh" is not the ⟳ button — data beats source', () => {
  // The precedence, and the whole reason it is written down. Being wrong this way
  // refuses an edit somebody can still make in a chat; being wrong the other way files
  // a rename against a line of public/app.js and lets an agent apply it.
  const host = load({ files: { '/': '<button class="icon-btn">Refresh</button>' }, scripts: [] });
  host.edit.provideText(() => ['Refresh']);
  host.edit.on();
  return host.edit.ready().then(() => {
    const a = host.edit.anchorFor(makeEl('button', { class: 'icon-btn' }, [], 'Refresh'));
    assert.equal(a.text.from, 'data');
    assert.equal(a.editable.ok, false);
  });
});

check('text written in two places is not retypable — picking one would be a guess', async () => {
  const host = load({ files: { '/': '<a class="x">Open</a>', '/app.js': 'html += `<b>Open</b>`;' }, scripts: ['/app.js'] });
  host.edit.on();
  await host.edit.ready();
  const a = host.edit.anchorFor(makeEl('a', { class: 'x' }, [], 'Open'));
  assert.equal(a.text.sites.length, 2);
  assert.equal(a.editable.ok, false);
  assert.match(a.editable.why, /2 places/);
});

check('a data provider that throws is reported, not silently believed', async () => {
  const host = load({ files: { '/': '<div class="t">Whatever</div>' }, scripts: [] });
  host.edit.provideText(() => {
    throw new Error('state is not ready');
  });
  host.edit.on();
  await host.edit.ready();
  const a = host.edit.anchorFor(makeEl('div', { class: 't' }, [], 'Whatever'));
  // `from` says source, because it was found in source — but `provider: null` is the
  // flag saying nothing could be recognised as data, so that verdict is unchecked.
  assert.equal(a.text.provider, null);
});

check('an element with no text at all says so rather than guessing', async () => {
  const { anchor } = await realised(makeEl('span', { class: 'dot' }));
  assert.equal(anchor.text.from, 'empty');
  assert.equal(anchor.editable.ok, false);
});

check('an anchor made before the source is read says it is unresolved', () => {
  const { edit } = load({ files: REAL, scripts: ['/app.js'] });
  edit.on();
  const a = edit.anchorFor(makeEl('a', { class: 'p0-title' }, [], 'Some epic'));
  assert.equal(a.resolved, false, 'it claimed to have resolved against source it had not read');
  assert.equal(a.source.found, 0);
});

check('an anchor is JSON and outlives the document it describes', () => {
  const a = p0.anchor;
  assert.deepEqual(JSON.parse(JSON.stringify(a)).selector, a.selector);
});

/* ==================================================== 4. the wiring, read statically */

/**
 * The code line, not the block.
 *
 * Every file here argues in prose that names the identifier a grep would match — the
 * comment above each gate says `isFrozen` twice — so an assertion over the whole
 * function is satisfied by the comment and stays green when the gate is deleted. These
 * pull out the one line that starts the statement.
 */
const codeLines = (src) =>
  src
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));

const APP_CODE = codeLines(APP);

check('render() refuses to paint while the screen is frozen', () => {
  assert.ok(
    APP_CODE.includes('if (isFrozen()) {'),
    'no `if (isFrozen()) {` on a code line in public/app.js — the gate is gone or renamed'
  );
  const at = APP.indexOf('function render(force = false) {');
  const answering = APP.indexOf('if (!force && isAnswering()) {', at);
  const frozen = APP.indexOf('if (isFrozen()) {', at);
  assert.ok(frozen !== -1 && frozen < answering, 'render() tests isAnswering before isFrozen — a forced repaint would slip through');
});

check('paintList refuses too — the error panel is painted straight through it', () => {
  const at = APP.indexOf('function paintList(chunks) {');
  const end = APP.indexOf('\n  }', at);
  assert.ok(at !== -1 && APP.slice(at, end).includes('if (isFrozen()) return;'), 'paintList has no gate');
});

check('leaving the mode is what takes the deferred repaint', () => {
  assert.ok(
    APP_CODE.some((l) => l.includes('editMode?.onChange?.(')),
    'app.js never registers for the exit'
  );
  const at = APP.indexOf('editMode?.onChange?.(');
  assert.match(APP.slice(at, at + 200), /if \(!on\) render\(true\)/);
});

check('app.js hands over what the payload is drawing, or nothing can be called tracker text', () => {
  assert.ok(APP_CODE.some((l) => l.includes('editMode?.provideText?.(')), 'no provideText registration');
  assert.ok(APP_CODE.some((l) => l.startsWith('function payloadText()')), 'no payloadText in app.js');
});

check('the inbox loads the file, and loads it before app.js', () => {
  const mine = INDEX.indexOf('/editmode.js');
  const app = INDEX.indexOf('/app.js');
  assert.ok(mine !== -1, 'index.html does not load editmode.js');
  assert.ok(mine < app, 'index.html loads app.js first — the registrations would find nothing');
});

check('and carries the ✏️ the module wires itself to', () => {
  // A fake document answers every getElementById, so only a read of the markup can see
  // this one missing.
  assert.match(INDEX, /id="editmode"/, 'no #editmode button in index.html');
});

check('the service worker caches it, so an offline inbox is not half a mode', () => {
  assert.match(read('public/sw.js'), /^\s*'\/editmode\.js',$/m, 'editmode.js is not in SHELL');
});

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
