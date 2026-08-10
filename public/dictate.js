/* Say the answer instead of thumbing it.
 *
 * A `human` bead is answered in prose, standing up, one-handed, usually within a
 * minute of the notification — which is the worst possible time to be typing three
 * sentences into a phone. The keyboard's own mic key already exists on Android, but
 * it is a property of whichever keyboard is installed, it is not there on the Mac,
 * and it is not discoverable from inside the box you are looking at. So the box gets
 * its own.
 *
 * **Why this is not four lines of `webkitSpeechRecognition`.** The daemon serves
 * plain HTTP on a 100.x tailnet address — there is no certificate to issue to one,
 * see android/app/src/main/res/xml/network_security_config.xml — so the page is not a
 * secure context, and every browser speech API is gated on being one. On top of that
 * the phone is not a browser at all: it is a WebView, and Android WebView has never
 * implemented the Web Speech API in any context, secure or not. The two together mean
 * the obvious implementation would ship a button that does nothing on the only device
 * anybody answers beads from.
 *
 * Hence two backends behind one control:
 *
 *   - **native** — the Android shell's `SpeechRecognizer`, reached over the
 *     `BeadcauseNative` bridge that already exists for notifications and "open in
 *     Chrome". This is the real one. See MainActivity.Bridge.
 *   - **web** — `SpeechRecognition`, used only where it genuinely works: the Mac at
 *     `http://localhost:<port>`, which *is* a secure context, and any future https.
 *
 * and no button at all where neither can run, because a mic that fails on tap is
 * worse than no mic: it teaches you the feature is broken rather than absent.
 *
 * The one rule with teeth is the same one the rest of this app is built around: **a
 * dictation must not be able to eat words you typed.** Speech lands at the caret,
 * around the text already in the box, and if you type while it is listening your
 * keystrokes win — the next phrase goes in after them rather than overwriting them.
 * Every write goes out as a real `input` event, so the per-keystroke draft saving in
 * app.js keeps a spoken answer exactly as safely as a typed one.
 */
(() => {
  'use strict';

  /** An error message stays up this long, then the strip goes quiet again. */
  const NOTE_MS = 6000;
  /* Web Speech ends the session on every pause and has to be restarted to keep
     listening. A recogniser that ends immediately would restart forever, so the
     restarts are counted and the run gives up rather than spinning. */
  const MAX_RESTARTS = 20;
  const RESTART_FLOOR_MS = 400;

  /* -------------------------------------------------------------- filling in */

  /** One spoken phrase, tidied. Recognisers vary on leading and doubled spaces. */
  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

  /**
   * Two pieces of speech, joined the way a person would have typed them.
   *
   * The space is inserted here rather than by the caller because the caller cannot
   * see both sides: a partial result arrives with no idea what was finalised before
   * it. Punctuation is the exception — a recogniser that heard "period" and wrote
   * "." must not be given a space in front of it.
   */
  function joinWords(a, b) {
    if (!a) return b || '';
    if (!b) return a;
    if (/\s$/.test(a) || /^[\s,.!?;:)\]]/.test(b)) return a + b;
    return `${a} ${b}`;
  }

  /**
   * The thing that puts words in the box.
   *
   * Split out from the backends, and from the DOM as far as it can be, because this
   * is the half that can silently destroy an answer: the recognisers are replaceable,
   * the "do not lose what he typed" rule is not. `box` needs only `value`,
   * `selectionStart`/`selectionEnd` and — optionally — `setSelectionRange`, which is
   * what lets test/dictate.mjs drive it with a plain object.
   *
   * The model is three strings and a caret:
   *
   *     before | said + live | after
   *
   * `said` is everything the recogniser has finalised this run; `live` is the phrase
   * it is still hearing, replaced wholesale on every partial because that is what a
   * partial result *is* — the current best guess at the whole phrase, not a delta.
   * `before` and `after` are your text on either side of where the caret was when you
   * tapped the mic, so dictating into the middle of a sentence inserts rather than
   * appends, and dictating at the end appends, with no special case for either.
   */
  function createFill(box, { onWrite } = {}) {
    let before = '';
    let after = '';
    let said = '';
    let live = '';
    /** The last value this wrote, so a value that differs must have been typed. */
    let last = null;

    /** Take the box as it stands now as the ground the next phrase lands on. */
    function baseline() {
      const len = box.value.length;
      const start = Math.min(Math.max(Number(box.selectionStart ?? len) || 0, 0), len);
      const end = Math.min(Math.max(Number(box.selectionEnd ?? start) || 0, start), len);
      before = box.value.slice(0, start);
      after = box.value.slice(end);
      said = '';
      live = '';
      last = box.value;
    }

    /**
     * Someone typed while the mic was on.
     *
     * Their keystrokes are already in `box.value` and this has no business rewriting
     * them, so the whole box becomes the new `before`/`after` and the next phrase
     * lands at the caret they left. Anything already spoken stays exactly where it
     * is — it is part of `before` now.
     */
    function reground() {
      if (last !== null && box.value !== last) baseline();
    }

    /** What is on screen for the given state, and where the caret belongs. */
    function compose() {
      const spoken = joinWords(said, live);
      if (!spoken) return { value: before + after, caret: before.length };
      const head = before && !/\s$/.test(before) ? `${before} ` : before;
      return { value: head + spoken + after, caret: head.length + spoken.length };
    }

    function write() {
      const { value, caret } = compose();
      box.value = value;
      last = value;
      if (typeof box.setSelectionRange === 'function') {
        try {
          box.setSelectionRange(caret, caret);
        } catch {
          /* A box that is not focused, or not in the document, refuses. Harmless. */
        }
      }
      if (onWrite) onWrite(box);
      return { value, caret };
    }

    return {
      baseline,
      /** The phrase being heard right now. Replaces the last partial. */
      partial(text) {
        reground();
        live = clean(text);
        return write();
      },
      /** A phrase the recogniser has committed to. Joined on and cleared from `live`. */
      final(text) {
        reground();
        said = joinWords(said, clean(text));
        live = '';
        return write();
      },
      /**
       * Throw away the phrase in flight, keeping everything finalised before it.
       *
       * Only for a run that ended *badly*. A microphone that was denied, or that lost
       * the network mid-sentence, leaves a half-heard guess in the box — "so the thing
       * is what if we" — which then reads as an answer you wrote and abandoned. A run
       * you ended yourself is the opposite case and keeps its last phrase: tapping stop
       * after saying something has to leave the something behind.
       */
      drop() {
        reground();
        if (!live) return null;
        live = '';
        return write();
      },
      spoken: () => joinWords(said, live),
    };
  }

  /* ------------------------------------------------------------------ where */

  /** The Android shell, if it is there and its device can actually listen. */
  function nativeBridge() {
    const n = typeof window !== 'undefined' ? window.BeadcauseNative : null;
    if (!n || typeof n.startDictation !== 'function') return null;
    // An older shell has no availability call; a current one on a device with no
    // recognition service installed answers false, and then there is no mic.
    try {
      if (typeof n.dictationAvailable === 'function' && !n.dictationAvailable()) return null;
    } catch {
      return null;
    }
    return n;
  }

  /** The browser's own recogniser, but only where it is allowed to start. */
  function webRecognition() {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    // Insecure contexts expose the constructor and then refuse `start()` with
    // `not-allowed`, which is exactly the tap-that-does-nothing this guard exists to
    // prevent. Over the tailnet address, that is every browser.
    if (!Ctor || window.isSecureContext === false) return null;
    return Ctor;
  }

  const backend = () => (nativeBridge() ? 'native' : webRecognition() ? 'web' : null);
  const available = () => backend() !== null;

  /* ---------------------------------------------------------------- control */

  /** The run in progress: at most one, because there is only one microphone. */
  let run = null;

  const esc = (s) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );

  /**
   * The control, as markup, for a caller that builds its HTML as a string — which is
   * every screen in this app.
   *
   * Returns nothing at all where there is no backend, so a page can drop it into a
   * strip unconditionally and get a strip with no mic in it rather than a mic that
   * cannot work. `target` is an optional CSS selector; without one the button finds
   * the nearest textarea above it, which is what every current caller wants.
   */
  function buttonHtml({ target = '', note: noteAfter = '', label = 'Dictate' } = {}) {
    if (!available()) return '';
    return `<button type="button" class="mic" data-mic${
      target ? ` data-mic-target="${esc(target)}"` : ''
    }${
      noteAfter ? ` data-mic-note="${esc(noteAfter)}"` : ''
    } aria-label="${esc(label)}" aria-pressed="false" title="${esc(label)}"><span class="mic-glyph" aria-hidden="true">🎤</span></button>`;
  }

  /**
   * The same control, put next to a box that is already on the page.
   *
   * The screens that build their markup as a string call [buttonHtml] inline; the ones
   * whose composer is written out in HTML — the bead console, the agent chat — have
   * nowhere to interpolate it, and a second copy of the markup in each of those files
   * is how two mics end up looking and behaving differently. So they get this instead,
   * one line at boot. A no-op where no microphone can work, for the same reason
   * [buttonHtml] returns nothing there.
   */
  function attach(box, opts = {}) {
    if (!box || !available()) return null;
    box.insertAdjacentHTML('afterend', buttonHtml(opts));
    const btn = box.nextElementSibling;
    return btn && btn.matches('[data-mic]') ? btn : null;
  }

  /**
   * A box you cannot see is not the one you meant to fill.
   *
   * This is not a nicety. The answer card's mic sits in the same strip as the agent
   * chooser, and the chooser's shut popover contains the "create an agent" form —
   * with a textarea in it. A plain "nearest textarea" walk finds *that* one first and
   * dictates a spoken answer into a hidden box, which looks exactly like a microphone
   * that hears nothing. Found in the browser, not in a test, which is why there is now
   * one of each.
   *
   * `offsetParent` is null for anything with `display: none` anywhere above it, and a
   * textarea is never positioned fixed, so it cannot be null for a box you can see.
   */
  function fillable(box) {
    if (box.closest?.('[hidden]')) return false;
    return box.offsetParent !== null;
  }

  /**
   * Which box a mic fills.
   *
   * `data-mic-target` wins when a caller has an id to point at. Otherwise walk up
   * from the button until an ancestor holds a box worth filling — in the answer card
   * that is `.freeform`, one level above the strip the mic sits in — because a mic is
   * always drawn beside the box it fills and nothing else is.
   */
  function targetFor(btn) {
    const sel = btn.dataset.micTarget;
    if (sel) return document.querySelector(sel);
    for (let el = btn.parentElement; el; el = el.parentElement) {
      for (const box of el.querySelectorAll('textarea')) {
        if (fillable(box)) return box;
      }
    }
    return null;
  }

  /* ------------------------------------------------------------- what it says */

  /**
   * Where the status line goes: after the box, unless the caller says otherwise.
   *
   * A composer laid out as a flex row — the bead console's, a session's — would take
   * a paragraph dropped in beside its textarea and stand it up as a third column. So
   * those callers name an element to put it after instead, usually the strip that
   * already carries transient news about that composer.
   */
  function noteHostFor(btn, box) {
    const sel = btn?.dataset?.micNote;
    return (sel && document.querySelector(sel)) || box;
  }

  /**
   * A line saying what the microphone is doing.
   *
   * It has to be said somewhere: "nothing is happening" and "the permission is off"
   * look identical from a box that stays empty, and the second one is fixable. It is
   * created on demand and removed when the run ends, so a card repainted between
   * dictations carries no leftovers.
   */
  function note(box, text, kind) {
    if (!box) return;
    let el = box.nextElementSibling;
    if (!el || !el.classList?.contains('mic-note')) {
      if (!text) return;
      el = document.createElement('p');
      el.className = 'mic-note';
      el.setAttribute('role', 'status');
      box.insertAdjacentElement('afterend', el);
    }
    if (!text) return el.remove();
    el.textContent = text;
    el.classList.toggle('mic-bad', kind === 'bad');
  }

  function paint(btn, on) {
    if (!btn) return;
    // The idle label is whatever the caller asked for and is captured once, because
    // the listening label overwrites it and there is nowhere else to get it back from.
    if (!btn.dataset.micLabel) btn.dataset.micLabel = btn.getAttribute('aria-label') || 'Dictate';
    const label = on ? 'Stop dictating' : btn.dataset.micLabel;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
  }

  /** Recogniser error codes, in words that say what to do about it. */
  function reason(code) {
    switch (code) {
      case 'not-allowed':
      case 'service-not-allowed':
      case 'denied':
        return 'Microphone permission is off — turn it on for Beadcause in Settings.';
      case 'no-speech':
        return 'Heard nothing.';
      case 'network':
        return 'Dictation needs the network, and this one is off the tailnet.';
      case 'busy':
        return 'Something else on the phone is using the microphone.';
      case 'unavailable':
        return 'No speech recognition on this device.';
      case 'aborted':
        return '';
      default:
        return 'Dictation stopped.';
    }
  }

  /* ------------------------------------------------------------------- runs */

  const listening = () => Boolean(run);
  const box = () => run?.box || null;

  function fireInput(el) {
    // The whole draft-saving, mark-painting, suggestion-releasing machinery in app.js
    // hangs off `input` on the list. Dispatching it here is what makes a spoken answer
    // survive the tab being killed, exactly as a typed one does — and is why this file
    // needs to know nothing about drafts.
    el.dispatchEvent?.(new Event('input', { bubbles: true }));
  }

  function start(target, btn) {
    if (run) stop();
    const el = target;
    if (!el) return false;
    const kind = backend();
    if (!kind) return false;

    const fill = createFill(el, { onWrite: fireInput });
    fill.baseline();
    run = { box: el, btn, fill, kind, rec: null, restarts: 0, lastStart: Date.now(), note: noteHostFor(btn, el) };
    paint(btn, true);
    note(run.note, 'Starting…');
    if (kind === 'native') startNative();
    else startWeb();
    return true;
  }

  /**
   * End the run and leave the box alone.
   *
   * Called by a second tap, by an error, by the card being repainted out from under
   * it, and by the page going away — so it has to be safe to call at any point,
   * including from inside a recogniser callback that is about to fire again.
   */
  function stop(message, kind) {
    const r = run;
    if (!r) return;
    run = null;
    // A message means this ended on its own terms rather than on yours, and the phrase
    // that was in flight when it did is not to be trusted. See fill.drop.
    if (message) r.fill.drop();
    paint(r.btn, false);
    note(r.note, message || '', kind);
    if (message) {
      // The message is about a run that has ended; it should not still be on screen
      // the next time this card is looked at.
      setTimeout(() => {
        if (!run || run.box !== r.box) note(r.note, '');
      }, NOTE_MS);
    }
    try {
      if (r.kind === 'native') window.BeadcauseNative?.stopDictation?.();
      else r.rec?.abort?.();
    } catch {
      /* A recogniser that has already died refuses both. Nothing left to do. */
    }
  }

  /** A tap on the mic: start on the box beside it, or end the run it belongs to. */
  function toggle(btn) {
    const target = targetFor(btn);
    if (run && (!target || run.box === target)) return stop();
    start(target, btn);
  }

  /* ---------------------------------------------------------------- backends */

  function startNative() {
    try {
      window.BeadcauseNative.startDictation();
    } catch {
      stop(reason('unavailable'), 'bad');
    }
  }

  /**
   * What the Android shell calls back into.
   *
   * Five events, deliberately flat strings rather than an object: everything crossing
   * `@JavascriptInterface` is a string anyway, and a protocol that survives being
   * hand-written in Kotlin `evaluateJavascript` is worth more here than a typed one.
   */
  function fromNative(event, text) {
    if (!run || run.kind !== 'native') return;
    switch (event) {
      case 'listening':
        return note(run.note, 'Listening…');
      case 'partial':
        return void run.fill.partial(text);
      case 'final':
        run.fill.final(text);
        return note(run.note, 'Listening…');
      case 'end':
        return stop();
      case 'error':
        return stop(reason(text), text === 'no-speech' ? '' : 'bad');
      default:
    }
  }

  function startWeb() {
    const Ctor = webRecognition();
    if (!Ctor) return stop(reason('unavailable'), 'bad');
    let rec;
    try {
      rec = new Ctor();
    } catch {
      return stop(reason('unavailable'), 'bad');
    }
    run.rec = rec;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = document.documentElement.lang || navigator.language || 'en-GB';

    rec.onstart = () => {
      if (!run || run.rec !== rec) return;
      run.lastStart = Date.now();
      note(run.note, 'Listening…');
    };
    rec.onresult = (ev) => {
      if (!run || run.rec !== rec) return;
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
        const res = ev.results[i];
        const said = res[0]?.transcript || '';
        if (res.isFinal) run.fill.final(said);
        else interim = joinWords(interim, said);
      }
      if (interim) run.fill.partial(interim);
    };
    rec.onerror = (ev) => {
      if (!run || run.rec !== rec) return;
      // A pause with nothing said is not a failure worth ending the run over — the
      // browser fires it and then keeps going.
      if (ev.error === 'no-speech') return;
      stop(reason(ev.error), ev.error === 'aborted' ? '' : 'bad');
    };
    /**
     * Chrome ends the session on every silence even with `continuous` set, so
     * carrying on means starting it again. The counter and the floor are what stop a
     * recogniser that dies on `start()` from doing that a thousand times a second.
     */
    rec.onend = () => {
      if (!run || run.rec !== rec) return;
      run.restarts += 1;
      // A session that ended almost as soon as it began did not hear a pause, it
      // failed — restarting that is a spin, not persistence.
      if (run.restarts > MAX_RESTARTS || Date.now() - run.lastStart < RESTART_FLOOR_MS) return stop();
      run.lastStart = Date.now();
      try {
        rec.start();
      } catch {
        stop();
      }
    };

    try {
      rec.start();
    } catch {
      stop(reason('busy'), 'bad');
    }
  }

  /* ------------------------------------------------------------------ wiring */

  if (typeof document !== 'undefined') {
    // Delegated at the document, so every screen that prints `buttonHtml()` is wired
    // by including this file — and a card rebuilt mid-answer, which app.js does
    // constantly, cannot leave a dead listener behind on the old button.
    document.addEventListener('click', (ev) => {
      const btn = ev.target.closest?.('[data-mic]');
      if (!btn) return;
      ev.preventDefault();
      toggle(btn);
    });
    // The caret in the textarea is where speech lands, so the tap that starts
    // dictation must not be allowed to take it away.
    document.addEventListener('pointerdown', (ev) => {
      if (ev.target.closest?.('[data-mic]')) ev.preventDefault();
    });
    // A box repainted, collapsed or navigated away from is a run with nowhere to put
    // its words. Checked on the beat rather than watched with a MutationObserver:
    // this is one comparison a second against one element, and the observer would
    // have to watch every list on every screen.
    setInterval(() => {
      if (run && run.box.isConnected === false) stop();
    }, 1000);
    window.addEventListener('pagehide', () => stop());
  }

  window.beadcause = window.beadcause || {};
  window.beadcause.dictation = {
    available,
    backend,
    attach,
    buttonHtml,
    listening,
    box,
    start,
    stop,
    toggle,
    /** Android's half of the protocol. See MainActivity.Bridge.startDictation. */
    native: fromNative,
    /** For test/dictate.mjs — the half that must never lose a word, and the one
        that has to pick the right box to lose it into. */
    createFill,
    targetFor,
    joinWords,
  };
})();
