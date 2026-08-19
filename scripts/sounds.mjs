#!/usr/bin/env node
/*
  The notification sounds, as source rather than as binaries.

  ## Why a generator and not four files somebody dragged in

  `res/raw/blip.wav` arrived as a binary and nothing in the repo says what it is. That is
  survivable for one file; it is not survivable for five, because the whole argument of
  bc-ka5y.15 is that these sounds are *relative to each other* — a merge landing has to be
  audibly smaller than a question, a release audibly calmer than a merge, an epic audibly
  bigger than a release, and a blockage unlike all four. A pile of opaque .wavs cannot be
  reviewed for that. A pile of numbers can: the pitches are a fifth and a fourth apart on
  purpose, the peaks descend on purpose, and every one of those decisions is a line below
  with the reason beside it.

  So the four sounds are **generated**, committed, and pinned. `test/sounds.mjs` re-renders
  them from this file and fails the repo if a committed byte differs, which is what makes a
  binary in a pull request reviewable: the diff that matters is the diff to this script, and
  the .wav either follows from it or the suite is red.

  ## Run it

      npm run sounds          # rewrite both copies from these definitions
      npm run sounds -- --check   # render and report, write nothing

  ## The two copies, and why neither is the copy

  Each sound is written to **two** paths, byte for byte:

  - `android/app/src/main/res/raw/<name>.wav` — what the APK ships and what
    `NotificationChannel.setSound` points an `android.resource://` URI at. Android resource
    names are `[a-z0-9_]`, which is why they are `land`, `drop`, `chime` and not
    `merge-landed.wav`.
  - `public/sounds/<name>.wav` — what /sounds plays, so the audition on the phone is an
    audition of the bytes that ship rather than of a re-synthesis that could drift.

  `blip.wav` gets the second path too, by a straight copy rather than a render — see
  `COPIED` near the bottom for why it is the one sound here that is not reconstructed.

  Duplicating ~80KB of generated audio is the cheap side of that trade. The expensive side
  would be auditioning one file and shipping another, and a channel's sound is immutable
  after `createNotificationChannel` — there is no second chance to notice.

  ## Why these particular sounds

  `blip.wav` measures 75ms, 1045Hz (C6), peak 0.457. Everything here is placed against it:

  - **land** — a merge landed. The same pip an octave and a half up and a third the energy:
    45ms at G6, peak 0.30. It has to read as *the small one* through a trouser pocket, and
    the two levers that survive a pocket are length and pitch. Four of these in a row before
    a release is the pipeline being audible, which is the point, so it must also be a sound
    you can hear four of without it becoming a phrase — hence no glide, no partials, nothing
    for a melody to be made out of.
  - **drop** — a release went out. A water drop is a rising pitch, not a falling one: the
    bubble the sound comes from shrinks as it collapses and its resonance climbs. So the
    frequency sweeps *up* 680→1240Hz over the first 60ms and then rings, with a second quiet
    620Hz resonance under it for the tail the bead asks for. Nothing else here glides, which
    is what makes it unmistakably not the blip.
  - **knock** — work is stuck. Two hits of the same note 155ms apart, B3 with a quiet
    octave over it, 340ms and peaking at 0.44 — the loudest thing here and the only low
    thing here. Everything else lives between 680 and 3150Hz because everything else is
    either good news or a question; a blockage is neither, and an octave and a half down
    is what survives a pocket without simply being louder than a question, which it must
    not be. Two attacks of the *same* note rather than a rising pair: the chime resolves,
    which is what makes it a milestone, and a knock repeats itself, which is what makes it
    a knock. It is the one sound in this file the audition never got to argue with before
    its channel was cut (bc-ka5y.15.4 needed it and bc-ka5y.15.3 had already landed), so
    it is the one most likely to owe a `_v2`.
  - **chime** — an epic completed. Two notes, G5 then C6, a rising fourth landing on the
    same C the question pip has always been: the milestone resolves onto the app's own note.
    Three partials rather than one give it the body the drop deliberately lacks, and the
    second note carries the longer tail because it is the one being arrived at. 480ms all
    in, under the half second the bead caps it at.

  All four peak **below** the question pip's 0.457, and that ordering is deliberate rather
  than incidental: of the five voices only a question asks anything of the reader, and the
  knock is next because a blockage is the one class where being missed is the failure. Good
  news does not get to be the loudest thing the phone does at 2am. The phone's own
  per-channel volume is still the real control (bc-ka5y.15.4 gave each class its own channel
  precisely so that screen is the mixer), but a file that is quiet to begin with is the
  default nobody has to go and fix.
*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Matching `blip.wav`, and matching it is the point: one family, one format. */
export const RATE = 44100;

/** Where a rendered sound lands, both of them, in the order they are written. */
export const OUT_DIRS = [
  path.join(ROOT, 'android', 'app', 'src', 'main', 'res', 'raw'),
  path.join(ROOT, 'public', 'sounds'),
];

const TAU10 = Math.log(10); // decay-to-a-tenth expressed as a time constant

/* ------------------------------------------------------------------ envelopes */

/**
 * One percussive envelope: a short linear attack so there is no click, then an
 * exponential decay quoted as *the time it takes to fall to a tenth*, which is the
 * number a person can actually picture.
 */
const pluck = ({ attackMs, tenthMs, delayMs = 0 }) => {
  const env = (t) => {
    const s = t - delayMs / 1000;
    if (s < 0) return 0;
    const a = attackMs / 1000;
    if (s < a) return s / a;
    return Math.exp(-(s - a) * TAU10 / (tenthMs / 1000));
  };
  // Carried on the function so `render` can start the *phase* at the same moment, not
  // only the amplitude — a late partial whose oscillator has been running since t=0
  // starts mid-cycle and clicks.
  env.delaySec = delayMs / 1000;
  return env;
};

/** A linear ramp to silence over the last `ms`, so the file never ends on a step. */
const fadeOut = (durMs, ms) => (t) => {
  const left = durMs / 1000 - t;
  return left >= ms / 1000 ? 1 : Math.max(0, left) / (ms / 1000);
};

/* -------------------------------------------------------------------- voices */

/** A steady sine. `phase` is carried by the caller so a voice can glide. */
const tone = (hz) => ({ freq: () => hz, integral: (t) => hz * t });

/**
 * A sine whose pitch climbs from `fromHz` to `toHz` with time constant `riseMs`.
 *
 * The phase has to come from the *integral* of the frequency, not from `f(t) * t` —
 * the second is the mistake that makes a glide sound like a warble, because it moves
 * every past cycle every time the frequency changes.
 */
const glide = (fromHz, toHz, riseMs) => {
  const k = riseMs / 1000;
  const d = fromHz - toHz;
  return {
    freq: (t) => toHz + d * Math.exp(-t / k),
    integral: (t) => toHz * t - d * k * (Math.exp(-t / k) - 1),
  };
};

/* ------------------------------------------------------------- the three sounds */

/**
 * Each sound is `{ ms, peak, parts: [{ voice, gain, env }] }`.
 *
 * `peak` is what the render is scaled to at the end, so the numbers above are the whole
 * loudness argument and no individual gain has to be second-guessed.
 */
export const SOUNDS = {
  land: {
    title: 'A merge landed',
    ms: 45,
    peak: 0.3,
    parts: [
      // G6. One partial, no glide: four of these in a row must not become a phrase.
      { voice: tone(1567.98), gain: 1, env: pluck({ attackMs: 1, tenthMs: 22 }) },
    ],
  },
  drop: {
    title: 'A release went out',
    ms: 360,
    peak: 0.34,
    parts: [
      // The collapse: 680Hz up to 1240Hz inside the first 60ms, then ringing down.
      { voice: glide(680, 1240, 22), gain: 1, env: pluck({ attackMs: 2, tenthMs: 130 }) },
      // The tail the bead asks for — a quiet resonance under the drop, arriving a little
      // late and outliving it, which is what stops this reading as a second blip. A5,
      // just under where the glide lands, so it reads as the same event still ringing
      // rather than as a second low tone that happens to overlap: a tail pitched below
      // the *start* of the sweep is a hum, and a hum is the one thing a calm sound
      // cannot afford at 2am.
      { voice: tone(880), gain: 0.2, env: pluck({ attackMs: 8, tenthMs: 190, delayMs: 12 }) },
    ],
  },
  knock: {
    title: 'Work is stuck',
    // Two hits, 155ms apart, and the only sound here that is *low*. Everything else in
    // this file lives between 680 and 3150Hz because everything else is good news or a
    // question; a blockage is neither, and the cheapest way to make one sound unlike the
    // other four through a pocket is to move it an octave and a half down rather than to
    // make it louder. It is also the only one with two attacks of the *same* note — the
    // chime's two notes rise and resolve, which is what makes it a milestone; a knock
    // repeats itself, which is what makes it a knock.
    ms: 340,
    peak: 0.44,
    parts: [
      // B3 and its octave, twice. `tenthMs` well under the gap so the first hit is over
      // before the second lands: two hits that overlap are one rolled thud.
      { voice: tone(246.94), gain: 1, env: pluck({ attackMs: 2, tenthMs: 45 }) },
      { voice: tone(493.88), gain: 0.3, env: pluck({ attackMs: 2, tenthMs: 30 }) },
      { voice: tone(246.94), gain: 1, env: pluck({ attackMs: 2, tenthMs: 45, delayMs: 155 }) },
      { voice: tone(493.88), gain: 0.3, env: pluck({ attackMs: 2, tenthMs: 30, delayMs: 155 }) },
    ],
  },
  chime: {
    title: 'An epic completed',
    ms: 480,
    peak: 0.38,
    parts: [
      // G5, and its partials: the body the drop does without.
      { voice: tone(783.99), gain: 1, env: pluck({ attackMs: 4, tenthMs: 190 }) },
      { voice: tone(1567.98), gain: 0.3, env: pluck({ attackMs: 4, tenthMs: 120 }) },
      { voice: tone(2359.2), gain: 0.11, env: pluck({ attackMs: 4, tenthMs: 80 }) },
      // C6 — the app's own note, arrived at rather than struck. It gets the longer tail
      // because it is the half of the interval that resolves.
      { voice: tone(1046.5), gain: 0.95, env: pluck({ attackMs: 4, tenthMs: 240, delayMs: 150 }) },
      { voice: tone(2093), gain: 0.28, env: pluck({ attackMs: 4, tenthMs: 150, delayMs: 150 }) },
      { voice: tone(3149.6), gain: 0.1, env: pluck({ attackMs: 4, tenthMs: 95, delayMs: 150 }) },
    ],
  },
};

/** How long the closing ramp is, per sound: long enough to be inaudible, short enough not to eat the tail. */
const FADE_MS = { land: 5, drop: 14, chime: 22, knock: 18 };

/* -------------------------------------------------------------------- render */

/** One sound as float samples in [-1, 1], scaled so its loudest sample is `peak`. */
export function render(name) {
  const spec = SOUNDS[name];
  if (!spec) throw new Error(`no such sound: ${name}`);
  const n = Math.round((spec.ms / 1000) * RATE);
  const out = new Float64Array(n);
  const fade = fadeOut(spec.ms, FADE_MS[name]);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    let v = 0;
    for (const p of spec.parts) {
      const e = p.env(t);
      if (e <= 0) continue;
      // The delay lives in the envelope, so the phase has to start at the delay too or
      // a late partial begins mid-cycle and clicks.
      const d = p.env.delaySec || 0;
      v += p.gain * e * Math.sin(2 * Math.PI * p.voice.integral(Math.max(0, t - d)));
    }
    out[i] = v * fade(t);
  }
  let loudest = 0;
  for (const v of out) loudest = Math.max(loudest, Math.abs(v));
  const k = loudest > 0 ? spec.peak / loudest : 1;
  for (let i = 0; i < n; i++) out[i] *= k;
  return out;
}

/**
 * Canonical 44-byte mono 16-bit PCM WAV, which is what `blip.wav` is and what
 * `setSound` on a notification channel is happiest with. Nothing exotic: an Android
 * channel sound is played by the system's own mixer and a plain RIFF is the one format
 * that has never needed a second opinion.
 */
export function wav(samples, rate = RATE) {
  const bytes = samples.length * 2;
  const buf = Buffer.alloc(44 + bytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + bytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM header size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits
  buf.write('data', 36);
  buf.writeUInt32LE(bytes, 40);
  for (let i = 0; i < samples.length; i++) {
    // Round, then clamp — 0.999 * 32768 rounds to 32767 and needs no clamp, but a peak
    // of exactly 1 would wrap to -32768 without one.
    const v = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
    buf.writeInt16LE(v, 44 + i * 2);
  }
  return buf;
}

/** The finished file for one sound — the single thing both copies and the test agree on. */
export const fileFor = (name) => wav(render(name));

/**
 * The one sound that is copied rather than rendered.
 *
 * `blip.wav` arrived as a binary in 2026-08 and nothing in the repo says what it is; it is
 * not reconstructible from anything here and it must not be *re*-rendered, because it is
 * already on three live channels and a channel's sound cannot be changed. But the audition
 * needs it — it is the sound everything else is placed against, and a reference list with a
 * hole where the reference goes is worse than no reference list. So it is copied from
 * `res/raw` into `public/sounds` byte for byte, and `test/sounds.mjs` holds the two equal
 * the same way it holds the generated three.
 */
export const COPIED = 'blip';

/* ---------------------------------------------------------------------- main */

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes('--check');
  {
    const from = path.join(OUT_DIRS[0], `${COPIED}.wav`);
    const to = path.join(OUT_DIRS[1], `${COPIED}.wav`);
    const buf = fs.readFileSync(from);
    const same = fs.existsSync(to) && fs.readFileSync(to).equals(buf);
    if (!same && !check) {
      fs.mkdirSync(OUT_DIRS[1], { recursive: true });
      fs.writeFileSync(to, buf);
    }
    console.log(`${same ? '  same' : check ? ' DIFFERS' : ' copied'}  ${path.relative(ROOT, to)}  ${buf.length} bytes (not rendered — see COPIED)`);
  }
  for (const name of Object.keys(SOUNDS)) {
    const buf = fileFor(name);
    for (const dir of OUT_DIRS) {
      const at = path.join(dir, `${name}.wav`);
      const same = fs.existsSync(at) && fs.readFileSync(at).equals(buf);
      if (check) {
        console.log(`${same ? '  same' : ' DIFFERS'}  ${path.relative(ROOT, at)}`);
        continue;
      }
      if (!same) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(at, buf);
      }
      console.log(`${same ? '  same' : ' wrote '}  ${path.relative(ROOT, at)}  ${buf.length} bytes`);
    }
    const s = SOUNDS[name];
    console.log(`         ${name}: ${s.ms}ms, peak ${s.peak} — ${s.title}`);
  }
}
