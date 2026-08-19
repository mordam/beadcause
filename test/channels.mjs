#!/usr/bin/env node
/**
 * **One Android channel per class of arrival** — and the two ways that goes wrong
 * silently.
 *
 *     npm test
 *     node test/channels.mjs
 *
 * A notification channel's sound, vibration and importance are taken from the *first*
 * `createNotificationChannel` for that id and every later call is ignored, forever. That
 * single fact is what this suite exists for, because it turns two ordinary edits into
 * unrecoverable ones:
 *
 * 1. **A channel cut with the wrong sound.** There is no fixing it in place. The only
 *    repair is a new id and a delete of the old one, which costs every install whatever
 *    it had set by hand on the old channel. So the pairing of channel to sound is pinned
 *    here rather than left to be read off the phone.
 * 2. **A retired id that is not deleted.** It stays in Android's notification settings as
 *    a live row nobody posts to, and it keeps its old sound — so a user who turns it back
 *    on gets a channel the app has forgotten about. [RETIRED_CHANNELS] is the delete
 *    list, and an id that leaves the source without joining it is exactly that ghost.
 *
 * There are no Kotlin tests in this repo and nothing here can run the app, so this is a
 * static read of the Kotlin — the same method the android suites beside it use. It cannot
 * tell you the phone made a noise. What it can do is hold the five channels to the five
 * classes, hold every sound they name to a file that actually ships, and fail the moment
 * an id changes without joining the delete list.
 *
 * The other half of the job — that the sounds are *tellable apart* — is test/sounds.mjs
 * (lengths, loudness, spectral centres) and /sounds on the phone (a person, blind, in a
 * pocket). This file is only about which sound is bound to which class.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOUNDS, COPIED } from '../scripts/sounds.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const KT = (f) => read(path.join('android/app/src/main/java/m4m/beadcause', f));

let ran = 0;
let bad = 0;
const check = (name, ok, detail = '') => {
  ran++;
  if (ok) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    return;
  }
  bad++;
  console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
};

const NOTIF = KT('Notifications.kt');
const TRAY = KT('Tray.kt');
const WATCH = KT('WatchService.kt');

/* ------------------------------------------------------- reading the Kotlin back */

/** `CHANNEL_X = "id"` — every channel this build knows the id of. */
const constants = Object.fromEntries(
  [...NOTIF.matchAll(/const val (CHANNEL_[A-Z]+) = "([a-z0-9_]+)"/g)].map((m) => [m[1], m[2]])
);

/**
 * Every `createNotificationChannel` in the file, as `{ const, label, importance, body }`.
 *
 * Sliced on the closing `)` at the call's own indentation rather than parsed: the `.apply`
 * block is the only brace nesting in there and it is uniformly indented, so anything
 * cleverer would be a second thing to debug when it disagreed with the reader's eye.
 */
const created = [...NOTIF.matchAll(/NotificationChannel\((CHANNEL_[A-Z]+), "([^"]+)", NotificationManager\.(IMPORTANCE_[A-Z]+)\)\.apply \{([\s\S]*?)\n {12}\}/g)].map(
  (m) => ({ const: m[1], label: m[2], importance: m[3], body: m[4] })
);

const by = Object.fromEntries(created.map((c) => [c.const, c]));

/** The delete list, as ids. */
const retired = [...(NOTIF.match(/private val RETIRED_CHANNELS = listOf\(([^)]*)\)/) || [, ''])[1].matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);

/* --------------------------------------------------------------- the five classes */

console.log('\nfive classes, five channels, and each one is the sound the epic asked for\n');

/**
 * The whole of bc-ka5y.15.4, as a table.
 *
 * `buzz` is the vibration pattern constant, or null for a channel that must be silent in
 * the hand — and "must" is the word: of these five only the two that are about *you* are
 * allowed to move the phone at all. Good news that vibrates is an interruption bought
 * with nothing, because there is nothing on those cards to act on.
 */
const CLASSES = [
  { const: 'CHANNEL_ANSWERS', sound: 'blip', importance: 'IMPORTANCE_HIGH', buzz: 'SMALLEST_BUZZ' },
  { const: 'CHANNEL_STUCK', sound: 'knock', importance: 'IMPORTANCE_HIGH', buzz: 'DOUBLE_KNOCK' },
  { const: 'CHANNEL_MERGED', sound: 'land', importance: 'IMPORTANCE_DEFAULT', buzz: null },
  { const: 'CHANNEL_RELEASED', sound: 'drop', importance: 'IMPORTANCE_DEFAULT', buzz: null },
  { const: 'CHANNEL_EPICDONE', sound: 'chime', importance: 'IMPORTANCE_DEFAULT', buzz: null },
];

for (const c of CLASSES) {
  const made = by[c.const];
  check(`${c.const} is published`, !!made && !!constants[c.const], made ? '' : 'no createNotificationChannel for it');
  if (!made) continue;
  check(`  …at ${c.importance}`, made.importance === c.importance, `it is ${made.importance}`);
  // Either `setSound(rawSound(ctx, R.raw.drop), …)` or `setSound(blip, …)` — the pip is
  // the one held in a local, because three channels share it and it is parsed once.
  const named = (made.body.match(/setSound\((?:rawSound\(ctx, R\.raw\.([a-z0-9_]+)\)|([a-z][a-z0-9_]*))/) || []).slice(1).find(Boolean);
  check(`  …with res/raw/${c.sound}.wav`, named === c.sound, named ? `it plays ${named}.wav` : 'no setSound at all');
  if (c.buzz) {
    check(`  …and buzzes with ${c.buzz}`, new RegExp(`enableVibration\\(true\\)[\\s\\S]*vibrationPattern = ${c.buzz}`).test(made.body));
  } else {
    check('  …and never vibrates', /enableVibration\(false\)/.test(made.body) && !/vibrationPattern/.test(made.body), 'good news must not move the phone');
  }
}

// The five, plus the three that are not voices of this epic at all: agent replies and
// foundation requests share the pip and are unchanged by design, and the service row is
// the silent "the watcher is alive" line the platform demands of a foreground service.
check(
  'and no sixth voice has been added',
  created.length === CLASSES.length + 3,
  `${created.length} channels created rather than ${CLASSES.length + 3} — past five voices, sounds stop being tellable apart in a pocket, which is the epic's own ceiling: ${created.map((c) => c.const).join(', ')}`
);

/* --------------------------------------------------------------------- the buzz */

console.log('\nthe smallest buzz the phone will give, and the one place a bigger one is allowed\n');

const buzzOf = (name) => {
  const m = NOTIF.match(new RegExp(`private val ${name} = longArrayOf\\(([^)]*)\\)`));
  return m ? m[1].split(',').map((n) => Number(n.trim())) : null;
};
const smallest = buzzOf('SMALLEST_BUZZ');
const knock = buzzOf('DOUBLE_KNOCK');

check('SMALLEST_BUZZ is a single pulse', Array.isArray(smallest) && smallest.length === 2 && smallest[0] === 0, JSON.stringify(smallest));
// 40ms is what questions_v2 shipped with. The floor is a floor of the mechanism, not of
// taste: a channel pattern has no amplitude, so "smaller" can only mean "shorter", and
// under about 20ms most phones never get the motor moving at all. Below it there is no
// pattern left to shrink — bc-ka5y.15.6 (an app-fired PRIMITIVE_TICK) is the way past.
check('and it is shorter than the 40ms it replaces', smallest?.[1] < 40, `${smallest?.[1]}ms`);
check('but not so short the motor never moves', smallest?.[1] >= 20, `${smallest?.[1]}ms is under the floor a vibrationPattern can express`);
check('the blockage is the only one that buzzes twice', Array.isArray(knock) && knock.length === 4, JSON.stringify(knock));
check('and it is felt as two, not as one long one', knock && knock[2] >= 100, `${knock?.[2]}ms between the hits`);
check(
  'nothing else in the file sets a pattern of its own',
  (NOTIF.match(/vibrationPattern = /g) || []).length === 2,
  'a third vibrationPattern means a class is buzzing that the bead says must not'
);

/* -------------------------------------------------------- nothing is left behind */

console.log('\nthe old ids are deleted, and the live ones are not\n');

check('questions_v2 is retired', retired.includes('questions_v2'), 'its buzz changed, so its id had to — and an id that changes without being deleted stays in the settings screen with the old sound');
check('so are the two ids before it', retired.includes('questions') && retired.includes('replies'));
check('the delete actually runs on every start', /RETIRED_CHANNELS\.forEach\(mgr::deleteNotificationChannel\)/.test(NOTIF));
check(
  'and nothing live is on the delete list',
  Object.values(constants).every((id) => !retired.includes(id)),
  `deleting a channel this build still posts to: ${Object.values(constants).filter((id) => retired.includes(id)).join(', ')}`
);
check(
  'every id is distinct',
  new Set(Object.values(constants)).size === Object.keys(constants).length,
  'two constants share an id, so one class inherits the other\'s sound'
);
check(
  'no channel is created twice',
  new Set(created.map((c) => c.const)).size === created.length,
  'the second call is ignored by Android, silently — the first one wins forever'
);
check(
  'and every channel this build can post to is created',
  [...new Set([...NOTIF.matchAll(/NotificationCompat\.Builder\(ctx, (CHANNEL_[A-Z]+)\)/g)].map((m) => m[1]))].every((c) => !!by[c]),
  'posting to a channel that was never created is a notification that never appears'
);

/* -------------------------------------------------------------- the sounds exist */

console.log('\nevery sound a channel names is a file that ships\n');

const RAW = path.join(ROOT, 'android/app/src/main/res/raw');
const generated = new Set([...Object.keys(SOUNDS), COPIED]);

for (const c of CLASSES) {
  check(`${c.sound}.wav is in res/raw`, fs.existsSync(path.join(RAW, `${c.sound}.wav`)));
  check(`  …and is one scripts/sounds.mjs knows about`, generated.has(c.sound), 'a hand-dropped binary is a sound nothing can review or re-render');
}
check(
  'and every generated sound is bound to a channel',
  [...generated].every((s) => CLASSES.some((c) => c.sound === s)),
  `unused: ${[...generated].filter((s) => !CLASSES.some((c) => c.sound === s)).join(', ')} — a sound in the APK that nothing plays`
);

/* ----------------------------------------------------------- which card sounds it */

console.log('\nthe three sizes of good news share a card and not a voice\n');

// One card, three channels: the card is the shade's business (a landing must not push a
// question off a summary) and the channel is the ear's. So the voice comes off the entry
// that caused this render rather than off the deck.
check('the news entry carries its own voice', /val voice: String\? = null/.test(TRAY));
check('and the card takes it from the newest arrival', /chan == Tray\.Chan\.NEWS -> newest\.voice \?: CHANNEL_MERGED/.test(NOTIF));
check('a blockage takes the blockage channel', /chan == Tray\.Chan\.STUCK -> CHANNEL_STUCK/.test(NOTIF));
check('and a question still outranks a reply on the shared card', /questions == 0 -> CHANNEL_REPLIES[\s\S]*else -> CHANNEL_ANSWERS/.test(NOTIF));

// A notification's channel is fixed when it is posted. Updating a live id with a
// different channel has no defined behaviour worth relying on, so the card is cancelled
// first and re-posted — which is free, because the entries live in Tray rather than in
// the notification.
check('the card is re-posted rather than updated when its voice changes', /if \(wasOn != null && wasOn != androidChannel\) mgr\.cancel\(trayId\)/.test(NOTIF));
check('and the remembered channel is dropped when the card goes', /posted\.remove\(trayId\)/.test(NOTIF));

// The types are the wire's, from lib/news.js. A type with no branch here is not a crash,
// it is a landing sound on a release — which is the failure mode the three channels exist
// to prevent, arriving silently.
for (const [type, chan] of [['released', 'CHANNEL_RELEASED'], ['epic-done', 'CHANNEL_EPICDONE']]) {
  check(`voiceFor maps ${type}`, new RegExp(`"${type}" -> ${chan}`).test(NOTIF));
}
check('and everything else falls back to the smallest of the three', /else -> CHANNEL_MERGED/.test(NOTIF));
check(
  'the three types the watcher files are the three the voices cover',
  /"landed", "released", "epic-done" ->/.test(WATCH),
  'the watcher and voiceFor disagree about what good news is'
);

/* ----------------------------------------------------------------- and it is said */

console.log('\nwhat the settings screen will say\n');

// The labels are the only text a person ever sees for these, on a screen beadcause does
// not draw. A label that repeats another's words is two rows nobody can tell apart, which
// is the whole benefit of five channels lost in the one place it is spent.
const labels = created.map((c) => c.label);
check('every channel has a distinct name', new Set(labels).size === labels.length, labels.join(' · '));
check('and a description', created.every((c) => /description = "/.test(c.body)), 'a channel with no description is a bare row in the settings screen');

console.log(bad ? `\n\x1b[31m${bad} of ${ran} failed\x1b[0m` : `\n\x1b[32mall ${ran} passed\x1b[0m`);
process.exit(bad ? 1 : 0);
