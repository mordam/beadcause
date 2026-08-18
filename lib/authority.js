/**
 * May this run unattended? One vocabulary, and a map of where each answer is decided.
 *
 * bc-xl7n.56. beadcause is built to let an agent do real work with nobody watching, and
 * that means every capability eventually asks the same question a different way: *does
 * this need a human, or does it just go?* Six places already answer it, well and for
 * good reasons specific to each — lib/endorse.js's `unendorsed` hold, lib/filing.js's P2
 * ceiling, lib/spaces.js's `autoEndorse`, lib/admin.js's pause switch, `OBSERVING`
 * (lib/config.js), and lib/errors.js's P0 bypass of the first two. None of it is wrong.
 * What was missing is a place to read all six at once — which is the question a new
 * capability has to get right, and previously had no single file to learn it from.
 *
 * This file does not re-answer any of those six. It is a map, not a merger — the six
 * disagree in exactly the ways they should (a crash bead and a bead an agent merely
 * *thinks* is worth doing are different claims and get different treatment on purpose;
 * see lib/errors.js), and collapsing them into one function would be the mistake
 * lib/proposedlabels.js already argued against for a smaller pair of lists: two guards
 * that answer different questions must not share one answer just because they look
 * alike from a distance. So `SITES` below is data — id, question, module, the export a
 * caller actually wants, which outcome it produces, and why — and a new capability reads
 * it to find out which existing file already has its answer, or, if none does, adds
 * itself here once it has decided.
 *
 * ## The vocabulary, and where it comes from
 *
 * Three outcomes, borrowed from the eve software factory template
 * (agent/lib/github/approval.ts) because it already named the useful shape: every gate
 * on unattended behaviour resolves to one of not-applicable (proceed), user-approval
 * (stop and wait for one), or denied. `RUN` / `ASK` / `DENY` below are the same three,
 * renamed to match how this file's own six sites already talk about themselves — none of
 * them say "not-applicable", they say "nothing will open a session on it until you
 * endorse it" (lib/endorse.js) or "refused, 409" (lib/underroot.js) — so the constants
 * exist for code that wants to switch on an outcome, and the prose beside each `SITES`
 * entry is what actually explains it.
 *
 * `RUN` and `DENY` are the easy two: something happens with no human step at all, or the
 * call throws/403s and nothing happens yet. `ASK` is the one worth being precise about,
 * because two of the sites below produce it by *withholding* rather than by *refusing* —
 * `unendorsed` never throws, it just keeps the bead out of `bd ready` and every count
 * until a tap changes that (lib/endorse.js's own "two layers" argument, which
 * lib/underroot.js later reused wholesale for the same reason: a filter is what stops the
 * refusal from ever being reached, and the refusal is what makes the filter a guarantee
 * rather than a hope).
 *
 * ## Not a member, on purpose: lib/claims.js
 *
 * It answers "who else is editing this file right now" — a same-machine collision
 * question between two sessions, enforced by a `PreToolUse` hook, with no human tap and
 * no notion of endorsement anywhere in it. It resembles this family from a distance
 * (both are "may this proceed" checks) and is not a member of it; see its own header for
 * the actual question it answers. Left out here rather than mis-filed, the way an earlier
 * pass on this epic mis-filed a conflict card by reading a prefix instead of a parent
 * edge — the cost of guessing at membership is a reader trusting a wrong map.
 *
 * ## One the bead's own list missed: `lib/underroot.js`
 *
 * `assertUnderRoot` sits in the same door as `assertEndorsed` in every one of
 * lib/session.js's launchers (`assertEndorsed`, then `assertUnderRoot`, same order,
 * every time) and answers a caller-class question of its own — not "did a human look at
 * this bead" but "did anybody decide this work should happen at all". It is included
 * below because a map that repeats the bead's blind spot is not an improvement on it.
 *
 * ## This is a map, not a refactor
 *
 * No existing call site changes behaviour for this bead. The six (seven, with the root
 * requirement) keep deciding what they already decide, the way they already decide it —
 * moving that logic into one function was considered and rejected: `lib/session.js`'s own
 * four doors already share the identical five-assert chain where it is safe to share
 * (three of the four; the fourth, the Epic Advocate door, deliberately omits
 * `assertNotContainer` and its own header explains why), and `test/shipbead.mjs` already
 * has a static check that every door asking `assertEndorsed` also asks
 * `assertNotShipBead` — folding that chain into this file would have hidden the very
 * shape that check is reading. What this file adds is the index those doors, and every
 * capability after them, can be found from.
 */

/** Proceeds with no human step. Nothing is on screen because nothing needed to be. */
export const RUN = 'run';

/**
 * Parked until a human acts, or already inert because one already did (lib/admin.js's
 * pause). Nothing throws; nothing runs either, until the state changes.
 */
export const ASK = 'ask';

/** Refused outright — the call throws, or the route answers 403/409. */
export const DENY = 'deny';

/**
 * Where each answer is decided, in the order the bead named them (plus the one it
 * missed). `module` and `exports` name real code — see `checkAuthorityModule` in
 * test/authority.mjs, which imports each one and checks the names still resolve, so
 * this table cannot drift silently the way a comment-only map would.
 */
export const SITES = Object.freeze([
  {
    id: 'endorsement',
    question: 'has a human looked at this bead at all?',
    module: 'lib/endorse.js',
    exports: ['UNENDORSED', 'QUEUE_EXCLUDED', 'assertEndorsed', 'isHeld', 'endorse'],
    outcome: ASK,
    note:
      'Two layers on purpose. QUEUE_EXCLUDED is the filter — an unendorsed bead never ' +
      'enters bd ready or any count that says how much work is waiting, so nothing throws ' +
      'and nothing runs. assertEndorsed is the refusal at the door (lib/session.js\'s four ' +
      'launchers all call it first) — a 409 with unendorsed:true, reached only if a bead got ' +
      'past the filter by a stale row or a caller that skipped it. Removed by endorse(), the ' +
      'one door out, called from POST /api/bead/endorse.',
  },
  {
    id: 'priority-ceiling',
    question: 'how high may an agent file its own discovery, before a human raises it?',
    module: 'lib/filing.js',
    exports: ['PRIORITY_FLOOR', 'clampPriority'],
    outcome: RUN,
    note:
      'Not a gate — a clamp. What an agent files always gets filed; it just never lands ' +
      'above P2 (0=critical..4=backlog) regardless of what was asked, and provenanceNotes ' +
      'says so on the bead when it happened. RUN is the right bucket because nothing waits ' +
      'and nothing is refused — the ceiling only ever lowers a number, never blocks a filing.',
  },
  {
    id: 'auto-endorse',
    question: 'does this workspace skip the tap that endorsement would otherwise ask for?',
    module: 'lib/spaces.js',
    exports: ['autoEndorseAllowed', 'autoEndorseInherited'],
    outcome: RUN,
    note:
      'A policy lever on the "endorsement" site above, not a gate of its own. Off by ' +
      'default (must be a literal true, not merely "not false") and resolved own workspace ' +
      '→ space → global. When on, beadToIssue (lib/filing.js) omits the unendorsed label ' +
      'entirely, converting that site\'s ASK into a RUN for everything this workspace files ' +
      '— still capped by the priority ceiling above, still discoverable as agent-filed.',
  },
  {
    id: 'root-requirement',
    question: 'did anybody decide this work should happen at all — is it under a root?',
    module: 'lib/underroot.js',
    exports: ['NO_ROOT_ABOVE', 'assertUnderRoot', 'hasRootAbove', 'rootsOf'],
    outcome: DENY,
    note:
      'Not on the bead\'s own list, and it should have been: it sits in the identical door ' +
      'as assertEndorsed, right after it, in every one of lib/session.js\'s launchers. ' +
      'Where endorsement asks "did a human look at this", this asks "did anyone above it ' +
      'decide the work should exist" — a root is a P0 or an epic at any priority ' +
      '(lib/ownership.js isRoot). Fails open on an unreadable graph rather than closed, ' +
      'deliberately the opposite of assertEndorsed — see the file\'s own header for why.',
  },
  {
    id: 'admin-pause',
    question: 'has a human switched this repo\'s (or space\'s, or everything\'s) advocates off?',
    module: 'lib/admin.js',
    exports: ['createAdmin', 'scopes', 'GLOBAL'],
    outcome: ASK,
    note:
      'The one site here that is a standing switch rather than a per-call predicate. ' +
      'The check itself lives beside what it gates — lib/advocate.js\'s tick loop: ' +
      '`if (a.paused) return note(a, ...)`. Drains rather than interrupts by default: a ' +
      'worker already running finishes and closes its own window; nothing new is dispatched ' +
      'until a human presses resume. No README section names this mechanism on its own — ' +
      'only inline mentions and one endpoint-table row — which is worth fixing separately ' +
      'from this bead.',
  },
  {
    id: 'observer-mode',
    question: 'is this daemon a second instance, booted only to look?',
    module: 'lib/config.js',
    exports: ['OBSERVING', 'OBSERVING_NOTE'],
    outcome: DENY,
    note:
      'Checked at each act site individually rather than through one function — there are ' +
      'roughly forty of them across lib/server.js\'s routes, lib/advocate.js, lib/instance.js, ' +
      'lib/crash.js and more, and no single choke point exists because the daemon has no ' +
      'single place all of its own acts pass through. Mostly DENY (403 on a write/act route); ' +
      'the one routine exception is the daemon\'s own tick, where OBSERVING makes the survey ' +
      'still run and still draw the queue — RUN, but inert, "everything above this line is ' +
      'looking; everything below it is doing" (lib/advocate.js). A new capability that acts ' +
      'checks OBSERVING at the point it would act and says, in its own words, which shape it ' +
      'took — README.md\'s "A second instance — observer mode" table is the list to extend.',
  },
  {
    id: 'error-p0-bypass',
    question: 'is this a program failing, rather than an agent\'s judgement call?',
    module: 'lib/errors.js',
    exports: ['ERROR_PRIORITY', 'intake'],
    outcome: RUN,
    note:
      'The P0 path the bead named as skipping several of the above, and it names exactly ' +
      'two: it passes endorsed:true straight into beadToIssue, skipping "endorsement" above ' +
      'outright, and floor: ERROR_PRIORITY (0), skipping "priority-ceiling". Both bypasses are ' +
      'explicit arguments at the one call site (lib/errors.js fileOne), not a separate code ' +
      'path — a crash bead is not an agent\'s opinion that something is worth doing, it is a ' +
      'program that failed, and the whole point is the advocate reaches it before a human ' +
      'has read it. It still satisfies "root-requirement" above, trivially: filed at P0, the ' +
      'bead is itself a root.',
  },
]);

/** The three outcomes, in the order this file introduces them — for anything that wants to enumerate. */
export const OUTCOMES = Object.freeze([RUN, ASK, DENY]);

/** One entry by id, or undefined. A lookup, not a guarantee the id still means what it did. */
export function siteFor(id) {
  return SITES.find((s) => s.id === id);
}
