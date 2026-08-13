#!/usr/bin/env node
/**
 * Speaking an answer instead of thumbing it.
 *
 *     npm test
 *     node test/dictate.mjs
 *
 * The microphone itself cannot be tested here — it is Android's recogniser on one side
 * and Chrome's on the other, and neither exists in Node. What *can* go wrong without
 * either of them, and what this covers, is the half in between:
 *
 * 1. **Where the words land.** `createFill` is the only thing in the app that writes
 *    into an answer box without a keystroke behind it, which makes it the only thing
 *    that can silently eat one. Speech goes in at the caret, around what is already
 *    there; a partial result replaces the last partial rather than piling up; and if
 *    you type while the mic is open, your keystrokes win and the next phrase lands
 *    after them. Getting any of those wrong loses an answer, and loses it in a way
 *    that looks like the app having done nothing.
 * 2. **That every write is an `input` event.** Nothing in dictate.js knows what a draft
 *    is. Per-keystroke saving, the unfinished mark, the suggestion chips letting go —
 *    all of it hangs off `input` on the list in app.js, and dispatching that event is
 *    the whole of how a spoken answer inherits it. Write the value without the event
 *    and a dictated answer is lost by the next repaint, with nothing on screen to say
 *    so.
 * 3. **No button where no microphone can work.** The daemon is plain HTTP on a tailnet
 *    address, so browsers refuse to listen; Android WebView has no speech API at all.
 *    A mic drawn there is a control that does nothing on tap, which teaches you the
 *    feature is broken rather than absent.
 * 4. **The two languages still agree.** The phone's dictation crosses
 *    `@JavascriptInterface` as bare strings — three methods the page calls, five events
 *    Kotlin calls back with. Nothing but this checks that both sides still spell them
 *    the same, and a rename on one side fails silently: the mic simply never appears,
 *    or appears and never hears anything.
 * 5. **And that it is actually wired in.** Every composer that takes prose loads the
 *    file, and the service worker has it in the shell — a page cached without it draws
 *    an answer box with no mic and no explanation.
 *
 * Pure Node. It loads the real `public/dictate.js` in a vm with a hand-made `window`
 * and `document`, the way test/queue.mjs loads the real send queue, so a rewrite of the
 * logic as a test-only module cannot pass this while the phone ships something else.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PUBLIC = (f) => path.join(ROOT, 'public', f);
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/**
 * The real file, in a room with nothing in it.
 *
 * `document` is a stub with the three things the module touches at load: two delegated
 * listeners and the `documentElement.lang` it reads when starting a browser
 * recogniser. Handing it a real DOM would test jsdom's event dispatch, which is not
 * the thing that breaks.
 */
function load({ native = null, secure = false } = {}) {
  const listeners = new Map();
  const document = {
    documentElement: { lang: 'en-GB' },
    addEventListener: (type, fn) => listeners.set(type, fn),
    querySelector: () => null,
    createElement: () => ({ classList: { toggle() {} }, setAttribute() {}, remove() {} }),
  };
  const window = {
    isSecureContext: secure,
    addEventListener: () => {},
    navigator: { language: 'en-GB' },
  };
  if (native) window.BeadcauseNative = native;
  const ctx = vm.createContext({
    window,
    document,
    navigator: window.navigator,
    setTimeout,
    clearTimeout,
    // The disconnected-box sweep. Unref'd, or the suite would sit here for a second
    // after the last check doing nothing.
    setInterval: (fn, ms) => setInterval(fn, ms).unref(),
    Event: class {
      constructor(type, opts = {}) {
        this.type = type;
        this.bubbles = Boolean(opts.bubbles);
      }
    },
  });
  vm.runInContext(fs.readFileSync(PUBLIC('dictate.js'), 'utf8'), ctx, { filename: 'dictate.js' });
  return { dictation: ctx.window.beadcause.dictation, listeners, window };
}

const { dictation } = load();

/**
 * A textarea, as far as the filling half is concerned: a value, a caret, and a count
 * of the `input` events that went out. That is the entire contract — see the note on
 * createFill about why it asks for so little.
 */
function fakeBox(value = '', caret = value.length) {
  return {
    value,
    selectionStart: caret,
    selectionEnd: caret,
    isConnected: true,
    setSelectionRange(a, b) {
      this.selectionStart = a;
      this.selectionEnd = b;
    },
    events: 0,
    dispatchEvent(ev) {
      if (ev.type === 'input') this.events += 1;
      return true;
    },
  };
}

/** What start() passes as onWrite, minus the DOM event object. */
const bump = (el) => {
  el.events += 1;
};

/* ------------------------------------------------------------------- harness */

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

console.log('\ndictation');

/* ------------------------------------------------------- where the words land */

check('into an empty box, speech is just the answer', () => {
  const box = fakeBox('');
  const fill = dictation.createFill(box);
  fill.baseline();
  fill.final('Restore at promotion');
  assert.equal(box.value, 'Restore at promotion');
  assert.equal(box.selectionStart, box.value.length);
});

check('a partial replaces the last partial rather than piling up', () => {
  const box = fakeBox('');
  const fill = dictation.createFill(box);
  fill.baseline();
  fill.partial('restore');
  fill.partial('restore at');
  fill.partial('restore at promotion');
  assert.equal(box.value, 'restore at promotion');
});

check('and the phrase it settles on replaces the guesses before it', () => {
  const box = fakeBox('');
  const fill = dictation.createFill(box);
  fill.baseline();
  fill.partial('restore at promo');
  fill.final('Restore at promotion.');
  assert.equal(box.value, 'Restore at promotion.');
});

check('two phrases join with one space, not none and not two', () => {
  const box = fakeBox('');
  const fill = dictation.createFill(box);
  fill.baseline();
  fill.final('Restore at promotion.');
  fill.final('Startup is the wrong moment.');
  assert.equal(box.value, 'Restore at promotion. Startup is the wrong moment.');
});

check('speech after your own words is spaced off them', () => {
  const box = fakeBox('Yes —');
  const fill = dictation.createFill(box);
  fill.baseline();
  fill.final('but only for the shared workspaces');
  assert.equal(box.value, 'Yes — but only for the shared workspaces');
});

check('…and a box that already ends in a space is not given a second one', () => {
  const box = fakeBox('Yes — ');
  const fill = dictation.createFill(box);
  fill.baseline();
  fill.final('do it');
  assert.equal(box.value, 'Yes — do it');
});

check('punctuation the recogniser wrote gets no space in front of it', () => {
  const box = fakeBox('');
  const fill = dictation.createFill(box);
  fill.baseline();
  fill.final('Do it');
  fill.final('.');
  assert.equal(box.value, 'Do it.');
});

check('dictating into the middle of a sentence inserts, keeping what came after', () => {
  const box = fakeBox('Yes, and close it', 4);
  const fill = dictation.createFill(box);
  fill.baseline();
  fill.final('with a note');
  assert.equal(box.value, 'Yes, with a note and close it');
  // The caret is left after what was spoken, not at the end of the box, so carrying
  // on talking continues the insertion rather than jumping to the end of the answer.
  assert.equal(box.selectionStart, 'Yes, with a note'.length);
});

check('a selection is spoken over rather than left in place', () => {
  const box = fakeBox('the wrong words entirely');
  box.selectionStart = 4;
  box.selectionEnd = 15;
  const fill = dictation.createFill(box);
  fill.baseline();
  fill.final('right');
  assert.equal(box.value, 'the right entirely');
});

check('typing while the mic is open wins — the next phrase goes after your keystrokes', () => {
  const box = fakeBox('');
  const fill = dictation.createFill(box);
  fill.baseline();
  fill.final('Restore at promotion.');
  // Thumbed in at the end while it was still listening.
  box.value = 'Restore at promotion. Only in prod,';
  box.selectionStart = box.value.length;
  box.selectionEnd = box.value.length;
  fill.final('and only after the swap');
  assert.equal(box.value, 'Restore at promotion. Only in prod, and only after the swap');
});

check('and a phrase in flight when that happens does not come back to overwrite it', () => {
  const box = fakeBox('');
  const fill = dictation.createFill(box);
  fill.baseline();
  fill.partial('restore at prom');
  box.value = 'typed instead';
  box.selectionStart = box.value.length;
  box.selectionEnd = box.value.length;
  fill.partial('restore at promotion');
  assert.equal(box.value, 'typed instead restore at promotion');
});

check('a run that ended badly drops its guess and keeps every finished phrase', () => {
  const box = fakeBox('');
  const fill = dictation.createFill(box);
  fill.baseline();
  fill.final('Restore at promotion.');
  fill.partial('and the other thing is');
  fill.drop();
  assert.equal(box.value, 'Restore at promotion.');
});

check('every write is an input event, which is the whole of how drafts survive', () => {
  const box = fakeBox('');
  const fill = dictation.createFill(box, { onWrite: bump });
  fill.baseline();
  fill.partial('one');
  fill.partial('one two');
  fill.final('One two.');
  assert.equal(box.events, 3);
});

/* ----------------------------------------------------------- where it appears */

check('no bridge and no secure context means no mic at all', () => {
  const { dictation: d } = load({ secure: false });
  assert.equal(d.available(), false);
  assert.equal(d.backend(), null);
  assert.equal(d.buttonHtml({ label: 'Dictate' }), '');
  assert.equal(d.attach(fakeBox(''), {}), null);
});

check('the Android shell is a backend, and draws one', () => {
  const { dictation: d } = load({ native: { startDictation() {}, dictationAvailable: () => true } });
  assert.equal(d.backend(), 'native');
  const html = d.buttonHtml({ label: 'Dictate this answer' });
  assert.match(html, /data-mic\b/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /Dictate this answer/);
});

check('a device with no recogniser behind the same bridge draws nothing', () => {
  const { dictation: d } = load({ native: { startDictation() {}, dictationAvailable: () => false } });
  assert.equal(d.available(), false);
  assert.equal(d.buttonHtml({}), '');
});

check('an APK too old to know the word "dictation" is not asked to', () => {
  // The shell before this feature has `answered` and `openInBrowser` and nothing else.
  const { dictation: d } = load({ native: { answered() {}, openInBrowser() {} } });
  assert.equal(d.available(), false);
});

/* ----------------------------------------------------------- which box it fills */

/**
 * Enough of an element to walk: a tag, a hidden flag, children, and a parent. Nothing
 * else in `targetFor` touches the DOM, and a real one here would mean jsdom for a
 * fifteen-line tree.
 */
function node(tag, { hidden = false, children = [] } = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    hidden,
    children,
    parentElement: null,
    dataset: {},
    closest(sel) {
      if (sel !== '[hidden]') throw new Error(`fake closest cannot answer ${sel}`);
      for (let at = el; at; at = at.parentElement) if (at.hidden) return at;
      return null;
    },
    querySelectorAll(sel) {
      if (sel !== 'textarea') throw new Error(`fake querySelectorAll cannot answer ${sel}`);
      const found = [];
      const walk = (n) => {
        for (const kid of n.children) {
          if (kid.tagName === 'TEXTAREA') found.push(kid);
          walk(kid);
        }
      };
      walk(el);
      return found;
    },
  };
  // `display: none` anywhere above is what the browser reports as a null offsetParent,
  // and the hidden attribute is the only way this app produces one.
  Object.defineProperty(el, 'offsetParent', {
    get: () => (el.closest('[hidden]') ? null : {}),
  });
  for (const kid of children) kid.parentElement = el;
  return el;
}

check('the mic fills the answer box, not the shut roster it shares a strip with', () => {
  // The real shape of the answer card: the agent chooser's popover is hidden and has a
  // "create an agent" textarea in it, and it is *nearer* the mic than the answer box.
  const answer = node('textarea');
  const agentDesc = node('textarea');
  const mic = node('button');
  const bar = node('div', {
    children: [mic, node('div', { children: [node('div', { hidden: true, children: [agentDesc] })] })],
  });
  const freeform = node('div', { children: [bar, answer] });
  freeform.parentElement = null;

  const found = dictation.targetFor(mic);
  assert.equal(found, answer, found === agentDesc ? 'dictated into the hidden agent form' : 'found no box');
});

check('…and with nothing hidden in the way, still the nearest one', () => {
  const answer = node('textarea');
  const mic = node('button');
  const say = node('div', { children: [mic, answer] });
  say.parentElement = null;
  assert.equal(dictation.targetFor(mic), answer);
});

/* --------------------------------------------------------- the two languages */

const kotlin = read('android/app/src/main/java/m4m/beadcause/Dictation.kt');
const activity = read('android/app/src/main/java/m4m/beadcause/MainActivity.kt');
const js = read('public/dictate.js');

check('the page calls exactly the three bridge methods the activity exposes', () => {
  for (const method of ['startDictation', 'stopDictation', 'dictationAvailable']) {
    assert.match(js, new RegExp(`\\b${method}\\b`), `dictate.js never calls ${method}`);
    assert.match(
      activity,
      new RegExp(`@JavascriptInterface[\\s\\S]{0,400}?fun ${method}\\b`),
      `MainActivity does not expose ${method} to the page`
    );
  }
});

check('every event Kotlin sends is one the page knows what to do with', () => {
  const sent = [...kotlin.matchAll(/send\("([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(sent.length >= 5, `only found ${sent.length} events in Dictation.kt`);
  for (const event of new Set(sent)) {
    assert.match(js, new RegExp(`case '${event}':`), `dictate.js has no case for the "${event}" event`);
  }
});

check('and every error code it sends is one the page can turn into a sentence', () => {
  const codes = [...kotlin.matchAll(/-> "([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(codes.includes('denied'), 'Dictation.kt never reports a denied microphone');
  for (const code of new Set(codes)) {
    assert.match(js, new RegExp(`case '${code}':`), `dictate.js has no message for the "${code}" code`);
  }
});

check('the shell asks for the microphone, and can see that a recogniser exists', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android\.permission\.RECORD_AUDIO/, 'no RECORD_AUDIO permission');
  // Without the queries block, isRecognitionAvailable is false on every Android 11+
  // device and the mic silently never appears.
  assert.match(manifest, /<queries>[\s\S]*android\.speech\.RecognitionService[\s\S]*<\/queries>/);
});

check('the microphone is let go when the app goes to the background', () => {
  assert.match(activity, /override fun onPause\(\)[\s\S]{0,300}?dictation\.stop\(\)/);
  assert.match(activity, /override fun onDestroy\(\)[\s\S]{0,200}?dictation\.destroy\(\)/);
});

/* ------------------------------------------------------------------- wired in */

check('every composer that takes prose loads it', () => {
  // The board's composer is on monitor.html now (bc-d4d5), which is already in the list.
  for (const page of ['index.html', 'console.html', 'session.html', 'monitor.html', 'foundations.html']) {
    assert.match(read(`public/${page}`), /<script src="\/dictate\.js">/, `public/${page} does not load dictate.js`);
  }
});

check('…and asks it for a mic rather than drawing one of its own', () => {
  for (const file of ['app.js', 'session.js', 'prs.js', 'mirror.js']) {
    assert.match(
      read(`public/${file}`),
      /dictation\?\.buttonHtml\(/,
      `public/${file} does not get its mic from dictate.js`
    );
  }
  for (const file of ['console.js', 'foundations.js']) {
    assert.match(read(`public/${file}`), /dictation\?\.attach\(/, `public/${file} does not attach a mic`);
  }
});

check('the session composer keeps its mic off the row the transcript pays for', () => {
  // A third round button between the box and the send arrow squeezed the textarea on a
  // 393px screen until its placeholder wrapped — 22px that pushed the transcript past
  // the bottom of the phone. scripts/say-check.mjs measures the transcript; this pins
  // the cause, because the fix is a placement that a later edit would undo without
  // noticing. The mic goes on the label above, and names its box rather than walking
  // to it, since it is no longer beside it.
  const src = read('public/session.js');
  assert.match(src, /label-mic/, 'the session mic is not on the label row');
  assert.match(src, /target: '\.session-say textarea'/, 'the session mic does not name its box');
  assert.doesNotMatch(
    src,
    /<textarea data-say-text[\s\S]{0,400}?buttonHtml\(/,
    'the mic is back inside the composer row'
  );
});

check('a repaint cannot pull the box out from under a live microphone', () => {
  // isAnswering() is what defers render(). A dictation that has not produced a word
  // yet leaves the box empty, so without this the first poll to land would rebuild the
  // card and the run would end on a textarea that no longer exists.
  assert.match(
    read('public/app.js'),
    /const isAnswering = \(\) =>[\s\S]{0,300}?dictation\?\.listening\(\)/,
    'app.js repaints while dictating'
  );
});

check('the service worker ships it with the page that needs it', () => {
  const sw = read('public/sw.js');
  assert.match(sw, /^\s*'\/dictate\.js',$/m, '/dictate.js is not in the shell');
  // app.js and dictate.js have to arrive together — see the note on the version.
  const version = sw.match(/const CACHE = 'beadcause-v(\d+)'/);
  assert.ok(version && Number(version[1]) >= 20, `cache version not bumped for the mic (${version?.[1]})`);
});

console.log(`\n${ran - failures}/${ran} checks passed\n`);
process.exit(failures ? 1 : 0);
