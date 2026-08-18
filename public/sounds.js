/* The audition — the acceptance test for bc-ka5y.15.3, made into a screen you can hold.
 *
 * ## Why this is a page and not a paragraph in a pull request
 *
 * A notification channel's sound is immutable after `createNotificationChannel`: Android
 * takes it from the first call and ignores every one after it, forever. So the only moment
 * these three files can be argued with is *before* bc-ka5y.15.4 cuts the channels, and the
 * only place the argument is worth having is the phone — a sound that is obviously distinct
 * over laptop speakers can be three identical ticks through a trouser pocket, which is where
 * every one of these is actually heard.
 *
 * ## Blind, and shuffled, because a named audition is not one
 *
 * The bead's acceptance criterion is the method: three sounds played in a random order and
 * named correctly without looking. That is not ceremony. Play a file called `drop.wav` and
 * you hear a water drop whatever came out of the speaker — the label does the work the
 * sound was supposed to do. So the audition draws three anonymous pads in a shuffled order,
 * takes a guess for each, and only then says which was which.
 *
 * The reference list underneath is the same four files with their names on, and it is
 * *underneath* on purpose: reading it first is precisely the contamination the pads exist
 * to avoid. Nothing stops you scrolling — this is a test you are administering to yourself
 * and the only person it can be cheated by is the person it is for.
 *
 * ## It plays the shipped bytes
 *
 * `/sounds/<name>.wav` is written by `scripts/sounds.mjs`, which writes the identical file
 * into `android/app/src/main/res/raw/` in the same pass, and `test/sounds.mjs` fails the
 * repo if the two ever differ by a byte. That is the whole reason the wavs are duplicated
 * rather than synthesised here in Web Audio: an audition of a re-synthesis is an audition of
 * something the APK does not contain, and there is no second chance to notice.
 */
(() => {
  'use strict';

  /**
   * The four voices, in the order the reference list draws them.
   *
   * `blip` is first and is not in the audition: it is the sound that already exists, the
   * one everything else is placed against, and the three that need naming are the three
   * that are new. A four-way blind test would also be a harder test than the phone ever
   * sets: the case that matters for the pip is a decision waiting on you, and there it
   * arrives with a buzz, so it never has to be told apart by ear alone.
   */
  const SOUNDS = [
    { id: 'blip', name: 'A question is waiting', detail: 'The pip that already exists — 75ms at C6. On Decisions it arrives with a 40ms buzz; on replies and foundation requests it comes alone.' },
    { id: 'land', name: 'A merge landed', detail: '45ms at G6. Smaller than the pip on purpose: four in a row is the pipeline being audible.' },
    { id: 'drop', name: 'A release went out', detail: 'A water drop — 360ms, pitch rising, with a tail. Calm, and unmistakably not the pip.' },
    { id: 'chime', name: 'An epic completed', detail: 'Two notes, G5 up to C6, 480ms. The milestone, resolving onto the app’s own note.' },
  ];

  /** The three that have to be told apart. */
  const BLIND = SOUNDS.filter((s) => s.id !== 'blip');

  /*
    One <audio> per sound, made once and reused.

    `preload="auto"` matters more here than it looks: the first play of a sound that has
    not been fetched arrives late, and a pad that answers half a second after the thumb is
    a pad you press twice — which in a blind test reads as "I could not tell", when what
    actually happened is that the network was slow. They are ~80KB in total.
  */
  const players = new Map(
    SOUNDS.map((s) => {
      const a = new Audio(`/sounds/${s.id}.wav`);
      a.preload = 'auto';
      return [s.id, a];
    })
  );

  /**
   * Play one, from the start, and never two at once.
   *
   * Restarting rather than ignoring a second press is deliberate: the thing being judged
   * is a sound's *onset*, and letting a tail run under the next pad is the one way to make
   * two of these genuinely hard to tell apart for a reason that has nothing to do with
   * either of them.
   */
  const play = (id) => {
    for (const a of players.values()) {
      a.pause();
      a.currentTime = 0;
    }
    const a = players.get(id);
    if (!a) return;
    // A rejected play() is an autoplay refusal, and every call here is inside a tap, so
    // there is nothing to recover — but an unhandled rejection would be a P0 bead.
    a.play().catch(() => {});
  };

  /* ------------------------------------------------------------------- audition */

  /** Fisher-Yates, so the pads are in an order nothing about the page can predict. */
  const shuffled = (list) => {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };

  const root = document.getElementById('audition');

  /** `{ order: [sound], guess: Map(id -> id), revealed: bool }` — the whole run. */
  let run = null;

  const start = () => {
    run = { order: shuffled(BLIND), guess: new Map(), revealed: false };
    draw();
  };

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  function draw() {
    root.textContent = '';
    if (!run) {
      const b = el('button', 'primary sound-start', 'Start a blind audition');
      b.type = 'button';
      b.addEventListener('click', start);
      root.append(b);
      return;
    }

    run.order.forEach((sound, i) => {
      const pad = el('div', 'sound-pad');
      const head = el('div', 'sound-padhead');
      // Numbered rather than lettered because the guess buttons are words and two
      // alphabets on one row is one more thing to hold in your head than the test needs.
      head.append(el('span', 'sound-num', String(i + 1)));

      const listen = el('button', 'sound-play', '▶ Play');
      listen.type = 'button';
      listen.addEventListener('click', () => play(sound.id));
      head.append(listen);
      pad.append(head);

      const picks = el('div', 'sound-picks');
      for (const option of BLIND) {
        const b = el('button', 'sound-pick', option.name);
        b.type = 'button';
        if (run.guess.get(sound.id) === option.id) b.classList.add('is-picked');
        if (run.revealed) {
          b.disabled = true;
          // Both markers, not one: the right answer is worth seeing whether or not it is
          // the one that was picked, and a wrong pick with nothing beside the truth just
          // says "no".
          if (option.id === sound.id) b.classList.add('is-right');
          else if (run.guess.get(sound.id) === option.id) b.classList.add('is-wrong');
        } else {
          b.addEventListener('click', () => {
            run.guess.set(sound.id, option.id);
            draw();
          });
        }
        picks.append(b);
      }
      pad.append(picks);
      root.append(pad);
    });

    if (run.revealed) {
      const right = run.order.filter((s) => run.guess.get(s.id) === s.id).length;
      const said = el(
        'p',
        `sound-verdict ${right === run.order.length ? 'is-pass' : 'is-fail'}`,
        right === run.order.length
          ? `All ${right} named correctly. That is the acceptance test.`
          : `${right} of ${run.order.length} named correctly — which is the audition failing, not you.`
      );
      root.append(said);
      const again = el('button', 'sound-again', 'Shuffle and go again');
      again.type = 'button';
      again.addEventListener('click', start);
      root.append(again);
      return;
    }

    const all = run.order.every((s) => run.guess.has(s.id));
    const reveal = el('button', 'primary sound-reveal', all ? 'Reveal' : `Name all three to reveal`);
    reveal.type = 'button';
    reveal.disabled = !all;
    reveal.addEventListener('click', () => {
      run.revealed = true;
      draw();
    });
    root.append(reveal);
  }

  /* ---------------------------------------------------------------- the reference */

  const named = document.getElementById('named');
  for (const s of SOUNDS) {
    const row = el('div', 'sound-row');
    const b = el('button', 'sound-play', '▶');
    b.type = 'button';
    b.setAttribute('aria-label', `Play ${s.name}`);
    b.addEventListener('click', () => play(s.id));
    const words = el('div', 'sound-words');
    words.append(el('strong', null, s.name), el('span', 'sound-file', `${s.id}.wav`), el('p', 'sound-detail', s.detail));
    row.append(b, words);
    named.append(row);
  }

  draw();
})();
