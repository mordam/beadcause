/*
  The notification sounds, and the half of their acceptance test a machine can run.

  ## The half it can

  The bead's actual acceptance criterion is a person naming three sounds blind, on a phone,
  in a pocket. Nothing here can do that and nothing here pretends to — `/sounds` is where
  that happens and it is Adam's to do.

  What a suite *can* hold is everything that would make the human test meaningless if it
  drifted afterwards:

  1. **The committed bytes are what the generator produces.** Three .wav files in a pull
     request are three things nobody can review. Pinning them to `scripts/sounds.mjs` moves
     the review to the script, where the pitches and the peaks are numbers with reasons
     beside them — and makes a hand-edited binary a red suite rather than a surprise.
  2. **Both copies are identical.** The audition plays `public/sounds/x.wav` and the APK
     ships `android/app/src/main/res/raw/x.wav`. If those two ever part company then the
     sound that was auditioned is not the sound that shipped, and a channel's sound cannot
     be changed after `createNotificationChannel` — there is no second chance to notice.
  3. **They are still the format `blip.wav` is**, and still short, and still quieter than
     the question pip. Those are the three claims the bead makes in words, and each one is
     a number.
  4. **They are measurably distinct.** Not a substitute for the ear — a machine cannot hear
     "unmistakably not the blip" — but three sounds whose lengths and spectral centres are
     far apart is the precondition for the ear having a chance, and it is what a later
     retune would silently break.
*/

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOUNDS, OUT_DIRS, RATE, COPIED, fileFor } from '../scripts/sounds.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'android', 'app', 'src', 'main', 'res', 'raw');
const SERVED = path.join(ROOT, 'public', 'sounds');

let ran = 0;
let failures = 0;
const check = (name, fn) => {
  ran++;
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
};

const NAMES = Object.keys(SOUNDS);

/* --------------------------------------------------------------- reading a wav */

/** A canonical mono 16-bit PCM wav, as its header says it is plus its samples. */
function read(file) {
  const b = fs.readFileSync(file);
  assert.equal(b.subarray(0, 4).toString(), 'RIFF', `${file} is not RIFF`);
  assert.equal(b.subarray(8, 12).toString(), 'WAVE', `${file} is not WAVE`);
  const format = b.readUInt16LE(20);
  const channels = b.readUInt16LE(22);
  const rate = b.readUInt32LE(24);
  const bits = b.readUInt16LE(34);
  const n = b.readUInt32LE(40) / 2;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = b.readInt16LE(44 + i * 2) / 32768;
  return { format, channels, rate, bits, x, ms: (n / rate) * 1000 };
}

const peakOf = (x) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

/**
 * The energy-weighted mean frequency, 100–6000Hz — one number for "how bright".
 *
 * A plain DFT rather than anything clever: these are at most half a second of mono audio
 * and the whole sweep costs a few hundred milliseconds, which is cheaper than a dependency
 * and very much cheaper than the class of bug it catches.
 */
function centroid(x) {
  let weighted = 0;
  let total = 0;
  for (let f = 100; f <= 6000; f += 20) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < x.length; i++) {
      const a = (2 * Math.PI * f * i) / RATE;
      re += x[i] * Math.cos(a);
      im += x[i] * Math.sin(a);
    }
    const m = Math.hypot(re, im);
    weighted += m * f;
    total += m;
  }
  return weighted / total;
}

/**
 * How many distinct attacks a sound has — one for a drop, two for a two-note chime.
 *
 * Deliberately crude: short-time energy in 8ms windows, and a rise counts as an onset when
 * it is both loud in absolute terms and a sharp step up from the window before it. It is
 * not a music-information-retrieval problem, it is "did the second note survive an edit",
 * and anything more elaborate would be a second thing to debug when it disagreed.
 */
function onsets(x) {
  const w = Math.round(RATE * 0.008);
  const env = [];
  for (let i = 0; i + w <= x.length; i += w) {
    let s = 0;
    for (let j = i; j < i + w; j++) s += x[j] * x[j];
    env.push(Math.sqrt(s / w));
  }
  const loudest = Math.max(...env);
  let n = 0;
  for (let i = 0; i < env.length; i++) {
    const prev = i === 0 ? 0 : env[i - 1];
    if (env[i] > loudest * 0.3 && env[i] > prev * 1.6) n++;
  }
  return n;
}

/* ------------------------------------------------------ the bytes are the script's */

console.log('\nthe committed files are what scripts/sounds.mjs renders');

for (const name of NAMES) {
  check(`${name}.wav is byte-identical to a fresh render`, () => {
    const want = fileFor(name);
    for (const dir of OUT_DIRS) {
      const at = path.join(dir, `${name}.wav`);
      assert.ok(fs.existsSync(at), `${path.relative(ROOT, at)} is missing — run \`npm run sounds\``);
      assert.ok(
        fs.readFileSync(at).equals(want),
        `${path.relative(ROOT, at)} differs from the render — run \`npm run sounds\` if the script changed, and look hard if it did not`
      );
    }
  });
}

check('the two copies are the same file', () => {
  for (const name of NAMES) {
    const raw = fs.readFileSync(path.join(RAW, `${name}.wav`));
    const served = fs.readFileSync(path.join(SERVED, `${name}.wav`));
    assert.ok(raw.equals(served), `${name}.wav differs between res/raw and public/sounds — the audition would be of a different file than ships`);
  }
});

check('the reference pip is served too, and is the same file', () => {
  // blip.wav is the one sound that is copied rather than rendered — it is already on three
  // live channels and cannot be re-cut. The audition needs it anyway: it is what everything
  // else is placed against, and a reference list with a hole where the reference goes is
  // worse than no reference list. This assertion exists because the hole is exactly what
  // shipped first — the page played /sounds/blip.wav and the daemon answered 404.
  const raw = fs.readFileSync(path.join(RAW, `${COPIED}.wav`));
  const served = path.join(SERVED, `${COPIED}.wav`);
  assert.ok(fs.existsSync(served), `public/sounds/${COPIED}.wav is missing — run \`npm run sounds\``);
  assert.ok(fs.readFileSync(served).equals(raw), `${COPIED}.wav differs between res/raw and public/sounds`);
});

check('every sound the page can play is on disk where the page looks for it', () => {
  // The page's list, read out of the page, against what public/sounds actually holds —
  // the pair that 404ed. Derived on both sides so adding a fifth voice cannot half-land.
  const js = fs.readFileSync(path.join(ROOT, 'public', 'sounds.js'), 'utf8');
  const listed = [...js.matchAll(/\{ id: '([a-z]+)'/g)].map((m) => m[1]);
  assert.ok(listed.length > 0, 'no sounds parsed out of public/sounds.js');
  for (const id of listed) {
    assert.ok(fs.existsSync(path.join(SERVED, `${id}.wav`)), `the page plays /sounds/${id}.wav and there is no such file`);
  }
});

check('the generator writes to exactly those two places', () => {
  // Named here as well as in the script so that dropping one of them is a failing suite
  // rather than a quiet loss of the guarantee above.
  const rel = OUT_DIRS.map((d) => path.relative(ROOT, d)).sort();
  assert.deepEqual(rel, ['android/app/src/main/res/raw', 'public/sounds']);
});

/* ------------------------------------------------------------------ the format */

console.log('\nthe same format as the pip that already exists');

const blip = read(path.join(RAW, 'blip.wav'));

for (const name of NAMES) {
  check(`${name}.wav is mono 16-bit PCM at ${blip.rate}Hz`, () => {
    const w = read(path.join(RAW, `${name}.wav`));
    assert.equal(w.format, 1, 'not uncompressed PCM');
    assert.equal(w.channels, 1, 'not mono');
    assert.equal(w.bits, 16, 'not 16-bit');
    assert.equal(w.rate, blip.rate, 'a different sample rate to blip.wav');
  });
}

check('and no file starts or ends on a step', () => {
  for (const name of NAMES) {
    const { x } = read(path.join(RAW, `${name}.wav`));
    // blip.wav itself ends at 177/32768 and clicks very faintly; these do not, and the
    // assertion is here so that a later retune cannot reintroduce it by accident.
    assert.equal(x[0], 0, `${name}.wav opens on a non-zero sample`);
    assert.ok(Math.abs(x[x.length - 1]) < 1 / 32768 + 1e-9, `${name}.wav closes on ${x[x.length - 1]} rather than silence`);
  }
});

/* -------------------------------------------------------- short, and quiet, and apart */

console.log('\nshort enough, quiet enough, and far enough apart');

const measured = new Map(NAMES.map((n) => [n, read(path.join(RAW, `${n}.wav`))]));

check('the merge blip is smaller than the question pip, in both senses', () => {
  const land = measured.get('land');
  assert.ok(land.ms < blip.ms, `land is ${land.ms.toFixed(0)}ms against the pip's ${blip.ms.toFixed(0)}ms`);
  assert.ok(peakOf(land.x) < peakOf(blip.x), 'land peaks at or above the pip');
});

check('nothing here is louder than the question pip', () => {
  // The ordering is the epic's argument, not a detail: of the five voices only a question
  // asks anything of the reader, so good news does not get to be the loudest thing the
  // phone does at 2am.
  const pip = peakOf(blip.x);
  for (const name of NAMES) {
    const p = peakOf(measured.get(name).x);
    assert.ok(p < pip, `${name} peaks at ${p.toFixed(3)}, at or above the pip's ${pip.toFixed(3)}`);
  }
});

check('the chime is under the half second the bead caps it at', () => {
  assert.ok(measured.get('chime').ms <= 500, `${measured.get('chime').ms.toFixed(0)}ms`);
});

check('and every sound is short enough that several in a row is not a melody', () => {
  for (const name of NAMES) {
    assert.ok(measured.get(name).ms <= 500, `${name} runs ${measured.get(name).ms.toFixed(0)}ms`);
  }
});

check('the merge blip is a different order of length to the other two', () => {
  // Length is what separates `land` from everything else and it is not a subtle margin:
  // 45ms against 360 and 480. It is deliberately *not* what separates the drop from the
  // chime — those two are close in length on purpose and are told apart by timbre, which
  // is the next two assertions.
  const land = measured.get('land').ms;
  for (const name of NAMES.filter((n) => n !== 'land')) {
    assert.ok(measured.get(name).ms > land * 3, `land is ${land.toFixed(0)}ms and ${name} is ${measured.get(name).ms.toFixed(0)}ms`);
  }
});

check('the drop and the chime are told apart by shape rather than by length', () => {
  const drop = measured.get('drop');
  const chime = measured.get('chime');
  assert.equal(onsets(drop.x), 1, 'the drop no longer arrives as one event');
  assert.equal(onsets(chime.x), 2, 'the chime no longer arrives as two notes — that is the whole of "two-note"');
  assert.ok(
    Math.abs(centroid(drop.x) - centroid(chime.x)) > 150,
    'the drop and the chime have converged on one brightness, which is the pair a pocket would lose first'
  );
});

check('and far apart in brightness', () => {
  const c = Object.fromEntries(NAMES.map((n) => [n, centroid(measured.get(n).x)]));
  const all = Object.values(c).sort((a, b) => a - b);
  for (let i = 1; i < all.length; i++) {
    assert.ok(all[i] - all[i - 1] > 150, `two spectral centres are ${(all[i] - all[i - 1]).toFixed(0)}Hz apart: ${JSON.stringify(c)}`);
  }
  // The one ordering worth naming: the small one is the bright one. Length and pitch are
  // the two things that survive a trouser pocket, and land leans on both.
  assert.ok(c.land > c.chime && c.land > c.drop, `land is not the brightest: ${JSON.stringify(c)}`);
});

/* --------------------------------------------------------------- the audition page */

console.log('\nthe audition can actually play them');

const read0 = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

check('the daemon serves .wav as audio, not as a download', () => {
  // Without a real content-type an <audio> is handed application/octet-stream and simply
  // never plays — a silent page on the one screen whose whole job is making a noise.
  assert.match(read0('lib/server.js'), /'\.wav':\s*'audio\/wav'/, 'no .wav in the MIME table');
});

check('/sounds and /audition both reach the page', () => {
  assert.match(
    read0('lib/server.js'),
    /if \(urlPath === '\/sounds' \|\| urlPath === '\/audition'\) urlPath = '\/sounds\.html';/,
    'the alias is gone from serveStatic'
  );
});

check('the page fetches the shipped files rather than synthesising its own', () => {
  const js = read0('public/sounds.js');
  assert.match(js, /new Audio\(`\/sounds\/\$\{s\.id\}\.wav`\)/, 'the page no longer loads /sounds/<id>.wav');
  assert.ok(!/AudioContext|OscillatorNode/.test(js), 'the page synthesises audio — it must play the bytes that ship');
});

check('the audition is blind and shuffled, which is the whole method', () => {
  const js = read0('public/sounds.js');
  assert.ok(js.includes('shuffled(BLIND)'), 'the pads are no longer shuffled');
  assert.ok(/Math\.random\(\)/.test(js), 'nothing randomises the order');
  // The reveal is what separates an audition from a list of buttons: names must not be on
  // the pads before an answer has been committed to.
  assert.ok(js.includes('run.revealed'), 'nothing withholds the answer until a guess is in');
});

check('every sound in the generator is on the page, and nothing else is', () => {
  const js = read0('public/sounds.js');
  const listed = [...js.matchAll(/\{ id: '([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(listed.slice().sort(), ['blip', ...NAMES].sort(), `the page lists ${listed.join(', ')}`);
  // blip is the reference rather than a fourth thing to name: it is the sound that already
  // exists, and in the case that matters — a decision waiting on you — it arrives with a
  // buzz, so it never has to be told apart by ear alone.
  assert.ok(js.includes("SOUNDS.filter((s) => s.id !== 'blip')"), 'blip is in the blind test, which is a harder test than the phone ever sets');
});

console.log(`\n${failures ? `${failures} of ${ran} failed` : `${ran} passed`}`);
process.exit(failures ? 1 : 0);
