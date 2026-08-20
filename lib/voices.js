/**
 * Which of the five voices each thing this daemon can say speaks in — and the rule
 * that stops the loudest of them crying wolf.
 *
 * bc-ka5y.15 splits notifications by **what the arrival asks of you** rather than by
 * what produced it, and gives class 2 — *work is stuck* — the one voice allowed to
 * insist: a low double knock, a double buzz, and a card with no timeout on it. That is
 * only a safe thing to hand out if the class cannot be wrong, and it could be. bc-y3qk.4
 * counted nineteen notifications about one workspace in one day, from a tracker that
 * alternated failing and recovering nearly every tick, because the code talked on every
 * transition. A phone that knocks twice about something that fixed itself two minutes
 * later is a phone whose knock you learn to ignore, and then the one outage that mattered
 * arrives in a sound you have already trained yourself out of hearing.
 *
 * So this file is two halves of one argument, and they belong together:
 *
 * 1. **[SPEAKS]** — every notification this daemon can make, assigned to exactly one
 *    class. Not a paragraph in the README, because the assignment is the sort of thing
 *    that goes quietly wrong: a new detection lands, picks whichever emitter looked
 *    nearest, and inherits a sound nobody chose for it. A table in code can be pinned by
 *    a suite, and `test/voices.mjs` fails the repo for a pusher that is in neither this
 *    table nor the file it names.
 * 2. **[DAMPING]** — for every source in class 2, where its "do not say this yet" rule
 *    lives. A stuck detection with no damping is the bug bc-y3qk.4 was filed about, so
 *    the suite requires an entry here for every source that speaks in [STUCK]: adding an
 *    insistent detection means saying, in the same diff, what stops it flapping.
 *
 * **What a recovery is, and it is not a sixth class.** Half the nineteen were *good*
 * news — "syncing again", "serving again". A recovery cancels a warning you have already
 * heard, so it is the other half of the state rather than an arrival of its own, and it
 * is [CLEAR]: on the phone it removes the card and posts nothing at all (`Notifications.stuck`
 * returns before `Tray.add` when `state == "clear"`), and over ntfy it is the calm end of
 * the range. Nothing that clears may ever reach `stuck_v1`.
 *
 * This module imports nothing, for lib/startup.js's reason: bin/router.js reads the
 * damping rule while holding the port with nothing behind it, which is exactly the case
 * where a policy that could fail to load is a policy that costs you the port.
 */

/** 1 — needs an answer from you. The pip, and the smallest buzz the phone will give. */
export const ANSWER = 'answer';
/** 2 — work is stuck. The double knock, and the only voice allowed to insist. */
export const STUCK = 'stuck';
/** 3 — a pull request merged. The pip, smaller, and no vibration. */
export const MERGED = 'merged';
/** 4 — a release went out. A water drop, and no vibration. */
export const RELEASED = 'released';
/** 5 — an epic completed. Two notes, and no vibration. The milestone. */
export const EPIC_DONE = 'epic-done';

/**
 * Not a voice: a warning that has stopped being true.
 *
 * Deliberately outside [VOICES] so that "assign it to one of the five" cannot be
 * satisfied by giving a recovery the sound of the thing it is a recovery *from*. Its
 * whole job is to take a card away, and a card being taken away is not an arrival.
 */
export const CLEAR = 'clear';

/**
 * The five, in the order the epic numbers them, with what each one asks of the reader.
 *
 * `channel` is the Android id the class is carried on and is the join to
 * `Notifications.kt` — see `test/channels.mjs`, which owns the sound, importance and
 * vibration of each. Changing an id here changes nothing on the phone; a channel's id is
 * immutable once created, so a retune is a new id and a `RETIRED_CHANNELS` entry over
 * there, and this table follows it rather than leading it.
 */
export const VOICES = [
  { id: ANSWER, n: 1, channel: 'answers_v1', asks: 'answer this' },
  { id: STUCK, n: 2, channel: 'stuck_v1', asks: 'nothing can move until somebody looks' },
  { id: MERGED, n: 3, channel: 'merged_v1', asks: 'nothing — a merge landed' },
  { id: RELEASED, n: 4, channel: 'released_v1', asks: 'nothing — what is running is what is on main' },
  { id: EPIC_DONE, n: 5, channel: 'epicdone_v1', asks: 'nothing — a theme is finished' },
];

/** The five ids as a set, for "is this one of the five" without a linear scan. */
export const VOICE_IDS = new Set(VOICES.map((v) => v.id));

/**
 * Every notification this daemon can make, and the class it speaks in.
 *
 * Keyed by the function that composes it, because that is the name a reader has in front
 * of them when they are about to add a sixth thing to either file, and because it is what
 * a suite can check against the exports of lib/notify.js and lib/news.js without guessing.
 *
 * `deployEvent` is the one entry split by outcome rather than by name, and the split is
 * the point rather than an awkwardness — see [deployVoice].
 */
export const SPEAKS = {
  // ---- lib/notify.js: what stays on ntfy, and why it stays there ------------------
  //
  // The first four are class 1 and reach the phone natively as well; ntfy is the fallback
  // for a phone that is not the Android app. The last three are the two class-2 detections
  // that *cannot* go native — both report a failure of the very path a native card travels,
  // so a phone parked on `/api/poll` is exactly the phone that will not hear them — and the
  // recovery from one of them.
  pushQuestion: ANSWER,
  pushFoundationRequest: ANSWER,
  pushFoundationReply: ANSWER,
  pushReply: ANSWER,
  pushCertificate: STUCK,
  pushNoBackend: STUCK,
  pushServingAgain: CLEAR,

  // ---- lib/news.js: what the phone files as a native card -------------------------
  landedEvent: MERGED,
  'deployEvent:ok': RELEASED,
  'deployEvent:unconfirmed': RELEASED,
  'deployEvent:failed': STUCK,
  'deployEvent:lost': STUCK,
  deployClearEvent: CLEAR,
  syncFlappingEvent: STUCK,
  syncStuckEvent: STUCK,
  syncClearEvent: CLEAR,
  epicDoneEvent: EPIC_DONE,
};

/** What class this emitter speaks in, or `undefined` if nothing has assigned it one. */
export function voiceOf(source) {
  return SPEAKS[source];
}

/**
 * Which class a finished deploy is — and `unconfirmed` is the whole reason this is a
 * function rather than one line in the table.
 *
 * `failed` and `lost` are class 2: something was supposed to go live, nothing did, and
 * nothing else is going to say so. `ok` is class 4. `unconfirmed` was class 2 until this
 * bead and is now class 4, which reverses what bc-ka5y.15.1 landed, so here is both sides.
 *
 * The argument *for* stuck was that "we ran it and nothing outlived it to check" is not a
 * release you can rely on. True, and it is still the sentence the card says. But
 * `sweepDeploys` in lib/deploy.js only ever writes that word for a deploy with
 * `restarts` set — launchd takes the runner along with the daemon it is restarting — so
 * `unconfirmed` is not a rare inconclusive ending, it is **the ordinary ending of every
 * deploy beadcause makes of itself**. Class 2 therefore meant the most common release in
 * this repo was also the loudest sound the phone can make, several times a day, about a
 * deploy that had almost certainly worked. That is the definition of crying wolf, and
 * lib/queues.js had already reached the same conclusion from the other end: its
 * `RELEASED` set is `['ok', 'unconfirmed']`, because the running build you are reading
 * this on came up out of one of them.
 *
 * What is *not* given away by the move: the card still says "deploy unconfirmed" rather
 * than "deployed", and lib/server.js still clears a previous failure's card on `ok`
 * alone. An unconfirmed deploy is no evidence that the last failure is fixed.
 */
export function deployVoice(status) {
  return SPEAKS[`deployEvent:${status}`] || STUCK;
}

/**
 * How long a state has to hold before it earns the knock — two consecutive observations.
 *
 * Two rather than three because the cost is asymmetric and both directions are real. A
 * threshold too high delays a genuine outage by the length of a retry, which is seconds;
 * a threshold of one is what produced nineteen pushes in a day. Two removes the entire
 * class of transient that is *already being retried by the thing that noticed it* — the
 * router's own policy is that a slow start says nothing about the build and it will try
 * again in two seconds — while still speaking long before a person could have noticed.
 *
 * Ticks rather than milliseconds because the caller's clock is the retry it is already
 * running, and a wall-clock window would have to be tuned against a backoff that doubles.
 */
export const HOLD_TICKS = 2;

/**
 * Does this class-2 detection earn the sound on this tick?
 *
 * Both halves of the rule in one place, because they fail in the same direction when they
 * are apart: it has held long enough, **and** it has not already been said. The second is
 * what makes the answer true on exactly one tick of an episode, so a caller needs no
 * "have I pushed yet" logic of its own beyond remembering the answer.
 *
 * `ticks` is consecutive observations of the bad state; the caller resets it — usually by
 * dropping the whole episode record — the moment the state clears. A recovery is never
 * damped: it has already waited for the warning it cancels.
 */
export function speaks({ ticks = 0, spoken = false, hold = HOLD_TICKS } = {}) {
  return !spoken && ticks >= hold;
}

/**
 * For every source that speaks in class 2, where the thing that stops it flapping lives.
 *
 * Four detections, three different shapes of damping, and the shapes are different
 * because what "flapping" means differs. A tracker breaks and recovers on its own every
 * few minutes; a deploy is a single event with an outcome and cannot flap at all; a
 * certificate has a date on it and the same problem is still true tomorrow. Writing one
 * rule for all four would mean either damping a deploy that only ever happens once, or
 * failing to damp the tracker, which is where this started.
 *
 * `test/voices.mjs` requires an entry here for every [STUCK] source in [SPEAKS], so a new
 * insistent detection cannot land without an answer to "what stops this crying wolf".
 */
export const DAMPING = {
  pushNoBackend: {
    rule: 'ticks',
    ticks: HOLD_TICKS,
    where: 'bin/router.js — stillServingNothing',
    why:
      'The router retries a failed bring-up in two seconds and its own policy is that a slow start is evidence about the machine ' +
      'rather than about the build. Announcing on the first failure meant a swap that recovered on its second attempt cost an outage ' +
      'push and a recovery push, twenty seconds apart, about an app that was never down long enough to open.',
  },
  pushCertificate: {
    rule: 'once-per-problem',
    where: 'lib/tls.js — the `react` closure',
    why:
      'A certificate problem is a date, not a flap: "there is still no certificate" is news the first time and spam every day after, ' +
      'so `absent` is said once per problem and a failing renewal nags on NAG_EVERY_MS. There is nothing to count ticks against — ' +
      'the state is read off the calendar and holds by definition.',
  },
  syncStuckEvent: {
    rule: 'window',
    where: 'lib/sync.js — record()',
    why:
      'bc-y3qk.4. A workspace that has broken and come back four times inside an hour is neither an outage nor a working sync, and ' +
      'saying either on every transition is the nineteen-pushes-a-day this whole file exists to prevent. Counting transitions in a ' +
      'window rather than consecutive ticks because the bad state here is the *alternation*, which a consecutive counter resets on.',
  },
  syncFlappingEvent: {
    rule: 'window',
    where: 'lib/sync.js — record()',
    why:
      'The other side of the same counter: one push saying the tracker is flapping, and then silence about that workspace until it ' +
      'holds one way for the window. `flapped` is true on exactly one tick, which is what makes it a single notification.',
  },
  deployEvent: {
    rule: 'none',
    where: 'lib/server.js — settleDeploys',
    why:
      'A deploy is an arrival with an outcome, not a state that can alternate: one record ends once, and a repo whose deploys keep ' +
      'failing is failing about a merge you made each time. Damping it would swallow the second real failure of the evening. The card ' +
      'is keyed on the repo rather than the attempt, so a repeated failure replaces the row instead of stacking beside it.',
  },
};
