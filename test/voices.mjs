#!/usr/bin/env node
/**
 * **Which voice each thing this daemon says speaks in, and what stops the loud one
 * crying wolf** — bc-ka5y.15.5.
 *
 *     npm test
 *     node test/voices.mjs
 *
 * Class 2 of bc-ka5y.15 — *work is stuck* — is the only voice on the phone allowed to
 * insist: a low double knock, a double buzz, and a card with no timeout. Handing that out
 * is only safe while it cannot be wrong, and there are four ways for it to go wrong that
 * all look like working code:
 *
 * 1. **A detection with no class.** Something new is added to lib/notify.js or
 *    lib/news.js, picks whichever emitter looked nearest, and inherits a sound nobody
 *    chose for it. Checked by parsing the exports of both files and requiring every one
 *    of them to appear in `SPEAKS`.
 * 2. **A stale table.** The reverse: an entry naming a pusher that has since been deleted,
 *    which reads as coverage and is an empty row.
 * 3. **An insistent detection with nothing damping it.** This is bc-y3qk.4 — nineteen
 *    notifications about one workspace in one day, because the code talked on every
 *    transition. Every source that speaks in class 2 must have a `DAMPING` entry saying
 *    where its "not yet" rule lives, and that file has to exist.
 * 4. **A recovery in the stuck voice.** Half of bc-y3qk.4's nineteen were *good* news.
 *    A recovery is `CLEAR` rather than one of the five: on the phone it removes the card
 *    and posts nothing, which is a claim about `Notifications.kt` and is read out of it
 *    here rather than assumed.
 *
 * The behavioural half is small on purpose — `speaks()` is four lines — but it is the
 * whole of the damping rule, so it is worth being able to see fail.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let failures = 0;
let ran = 0;
const ok = (name) => {
  ran += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
};
const bad = (name, detail) => {
  ran += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

const { VOICES, VOICE_IDS, SPEAKS, DAMPING, CLEAR, STUCK, RELEASED, ANSWER, HOLD_TICKS, speaks, voiceOf, deployVoice } =
  await import(path.join(ROOT, 'lib', 'voices.js'));

/* ------------------------------------------------------------- 1. five, and only five */

console.log('\nfive classes, and a recovery that is not one of them\n');

check('there are five voices', VOICES.length === 5, `${VOICES.length}`);
check('numbered the way the epic numbers them', VOICES.map((v) => v.n).join() === '1,2,3,4,5');
check('each with a channel of its own', new Set(VOICES.map((v) => v.channel)).size === 5);
check('and each says what it asks of the reader', VOICES.every((v) => typeof v.asks === 'string' && v.asks.length > 5));
// Five is the ceiling in the epic, not a starting point: past five, sounds stop being
// tellable apart with the phone in a pocket, which is the only place any of this is judged.
check('a recovery is deliberately outside the five', !VOICE_IDS.has(CLEAR), CLEAR);

// The join to the phone. A channel id here that Notifications.kt has never heard of means
// the table is describing a sound nothing can make.
const KT = read('android/app/src/main/java/m4m/beadcause/Notifications.kt');
for (const v of VOICES) {
  check(`${v.id} names a channel the app publishes (${v.channel})`, KT.includes(`"${v.channel}"`), 'no such id in Notifications.kt');
}

/* ------------------------------------------- 2. every notification has exactly one class */

console.log('\nevery push and every event assigned, and nothing assigned twice\n');

const NOTIFY = read('lib/notify.js');
const NEWS = read('lib/news.js');

// The acceptance criterion, read off the source rather than off a list kept by hand:
// "every push in lib/notify.js is assigned to exactly one of the five classes".
const pushers = [...NOTIFY.matchAll(/export async function (push\w+)/g)].map((m) => m[1]);
check('lib/notify.js still has pushers to classify', pushers.length >= 5, `${pushers.length}`);
for (const name of pushers) {
  check(`${name} is assigned a class`, voiceOf(name) !== undefined, 'in neither the table nor a class — see lib/voices.js');
}

// And the other file, whose exports are the native cards. `deployEvent` is the one split
// by outcome rather than by name, because which side `unconfirmed` falls on is a judgement.
const builders = [...NEWS.matchAll(/export function (\w+Event)\b/g)].map((m) => m[1]);
check('lib/news.js still has event builders to classify', builders.length >= 5, `${builders.length}`);
for (const name of builders) {
  const split = Object.keys(SPEAKS).filter((k) => k.startsWith(`${name}:`));
  check(`${name} is assigned a class`, voiceOf(name) !== undefined || split.length > 0, 'in neither the table nor a class');
}

// The reverse, which is the one that rots quietly: a row for something that no longer exists
// reads as coverage and is an empty promise.
const emitters = new Set([...pushers, ...builders]);
for (const key of Object.keys(SPEAKS)) {
  const base = key.split(':')[0];
  check(`${key} names something that still exists`, emitters.has(base), 'stale entry — the emitter is gone');
}
for (const [key, voice] of Object.entries(SPEAKS)) {
  check(`${key} is one of the five, or a clear`, VOICE_IDS.has(voice) || voice === CLEAR, voice);
}

/* --------------------------------------------------- 3. a recovery never knocks */

console.log('\na recovery is the other half of a state, never a sixth voice\n');

// Every builder in lib/news.js that composes `state: 'clear'` is a recovery, and a recovery
// classed as anything but CLEAR would be a knock to say something is fine — which is how
// bc-y3qk.4 spent half of its nineteen notifications.
for (const name of builders) {
  const start = NEWS.indexOf(`export function ${name}`);
  const next = builders.map((b) => NEWS.indexOf(`export function ${b}`)).filter((i) => i > start);
  const body = NEWS.slice(start, next.length ? Math.min(...next) : NEWS.length);
  if (!/state:\s*'clear'/.test(body)) continue;
  check(`${name} is a clear rather than a voice`, voiceOf(name) === CLEAR, `classed ${voiceOf(name)}`);
}
check('and the ntfy recovery is too', voiceOf('pushServingAgain') === CLEAR, voiceOf('pushServingAgain'));
// And the structural half of the same claim: nothing may be both. A source classed CLEAR
// that also appeared among the insistent ones would be a warning and its own cancellation
// sharing a voice, which is the arrangement that makes a knock mean nothing.
const clears = Object.entries(SPEAKS).filter(([, v]) => v === CLEAR).map(([k]) => k.split(':')[0]);
check('there are recoveries to check', clears.length >= 2, clears.join(', '));
check('and none of them also speaks in the stuck voice', clears.every((k) => SPEAKS[k] === CLEAR), clears.join(', '));

// The claim above is only true because the phone honours it. `Notifications.stuck` must
// return before it ever reaches `Tray.add` on a clear — a card posted and then removed is
// a knock you heard.
const stuckFn = KT.slice(KT.indexOf('fun stuck('), KT.indexOf('fun stuck(') + 900);
check('the app removes a cleared card rather than posting it', /state == "clear"[\s\S]{0,120}Tray\.remove/.test(stuckFn), stuckFn.slice(0, 200));
check('and it does so before anything is added', stuckFn.indexOf('Tray.remove') < stuckFn.indexOf('Tray.add'));

/* -------------------------------------------- 4. nothing insistent lands undamped */

console.log('\nevery class-2 detection says what stops it crying wolf\n');

const insistent = [...new Set(Object.entries(SPEAKS).filter(([, v]) => v === STUCK).map(([k]) => k.split(':')[0]))];
check('there are class-2 detections to check', insistent.length >= 4, insistent.join(', '));
for (const name of insistent) {
  const entry = DAMPING[name];
  check(`${name} says how it is damped`, !!entry, 'no DAMPING entry — a new insistent detection owes one');
  if (!entry) continue;
  check(`  ${name}: and where the rule lives`, typeof entry.where === 'string' && entry.where.includes('.js'), entry.where);
  check(`  ${name}: in a file that exists`, fs.existsSync(path.join(ROOT, entry.where.split(' ')[0])), entry.where);
  // `rule: 'none'` is allowed and is the interesting one: a deploy is an arrival with an
  // outcome rather than a state that alternates, so damping it would swallow the second
  // real failure of the evening. It has to be argued for, not merely left blank.
  check(`  ${name}: with a reason a reader can argue with`, typeof entry.why === 'string' && entry.why.length > 80, `${entry.why?.length} chars`);
}
for (const name of Object.keys(DAMPING)) {
  check(`${name} in DAMPING is still a class-2 detection`, insistent.includes(name), 'stale — it no longer speaks in the stuck voice');
}

/* ---------------------------------------------------------- 5. the rule itself */

console.log('\nthe rule: a state has to hold before it earns the sound\n');

check('the hold is more than one observation', HOLD_TICKS >= 2, `${HOLD_TICKS}`);
check('nothing speaks on the first tick', speaks({ ticks: 1, spoken: false }) === false);
check('it speaks once the state has held', speaks({ ticks: HOLD_TICKS, spoken: false }) === true);
check('and keeps speaking to a caller that forgot it had', speaks({ ticks: HOLD_TICKS + 5, spoken: false }) === true);
// The half that makes an episode one notification rather than one per retry.
check('but never twice in one episode', speaks({ ticks: HOLD_TICKS + 5, spoken: true }) === false);
check('a caller with nothing to say says nothing', speaks() === false);
check('and the hold is overridable for a detection with a different clock', speaks({ ticks: 1, hold: 1 }) === true);

// The router is the caller this bead wired it into: an outage announced on the first
// failed bring-up is a knock about an app that the same file is about to retry in two
// seconds, followed by a recovery push twenty seconds later.
const ROUTER = read('bin/router.js');
check('bin/router.js reads the rule rather than keeping its own', /speaks\(\{\s*ticks: outage\.ticks/.test(ROUTER));
check('and counts consecutive failures of a bring-up', /outage\.ticks \+= 1/.test(ROUTER));
check('the log is not damped, only the sound', /if \(first\) warn\('NOTHING IS BEING SERVED/.test(ROUTER));
check('and a recovery is still only said if the outage was', /const announced = outage\.announced;[\s\S]{0,200}if \(!announced\) return;/.test(ROUTER));

/* ------------------------------------------------------ 6. the deploy judgement */

console.log('\nwhich side a finished deploy falls on\n');

check('a deploy that worked is a release', deployVoice('ok') === RELEASED);
check('a deploy that failed is a blockage', deployVoice('failed') === STUCK);
check('so is one that was lost', deployVoice('lost') === STUCK);
// The change bc-ka5y.15.5 made, and the reason it is safe: `sweepDeploys` writes
// `unconfirmed` only for a deploy with `restarts` set, so it is the ordinary ending of
// every deploy beadcause makes of itself — class 2 meant the commonest release in this
// repo was also the loudest noise the phone can make.
check('and an unconfirmed one is a release, not the insistent voice', deployVoice('unconfirmed') === RELEASED);
check('a status nothing has classified falls to stuck rather than to silence', deployVoice('who-knows') === STUCK);
const DEPLOY = read('lib/deploy.js');
check('unconfirmed is still only written for a restart', /restartEnding \? 'unconfirmed' : 'lost'/.test(DEPLOY));
check('and lib/news.js takes the side from here rather than deciding again', /deployVoice\(rec\.status\)/.test(NEWS));
// Not given away by the move: the card still refuses to call it deployed, and a previous
// failure's card is still only cleared by an `ok`.
const SERVER = read('lib/server.js');
check('an unconfirmed deploy does not clear a previous failure', /rec\.status === 'ok'\) bus\.emit\(deployClearEvent\(rec\)\)/.test(SERVER));

check('a question is class 1', voiceOf('pushQuestion') === ANSWER);

console.log(
  failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} passed\x1b[0m\n`
);
process.exit(failures ? 1 : 0);
