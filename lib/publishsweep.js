/**
 * The caller the publication chain never had — the daemon's own compliance sweep.
 *
 * Everything bc-3muu has built is a leaf with a test and no caller. lib/publishable.js
 * says what may leave the Mac, lib/publication.js keeps the chain and publishes it,
 * lib/posture.js says what this deployment can back up, lib/instance.js says which install
 * is speaking, lib/anchor.js verifies an anchor — and on a running install none of them is
 * ever entered. `refs/beadcause/publications` does not exist on this laptop. Every
 * acceptance criterion in the family that begins "every deployment publishes…" was
 * satisfied by a function nobody called, which is bc-keqy, and this file is the other side
 * of the door.
 *
 * **The door is `whenOn` in lib/management.js and nothing here reaches around it.** Off is
 * the default for every install and off has to cost nothing — not a git repo, not an
 * identity, not a ref, not a stat of a directory that would create one. So the whole of
 * the work below sits inside the loader `whenOn` calls only when the layer is on, and the
 * modules that would touch a store are `import()`ed *there* rather than at the top of this
 * file. An install that has never enabled the layer never parses lib/publication.js, and
 * `test/publishsweep.mjs` asserts the config directory afterwards rather than trusting
 * that sentence.
 *
 * **There is deliberately no `publication.enabled`.** A cadence is a setting and this file
 * has one; whether an install with the management system on publishes at all is not, and a
 * key that could stop the chain growing would be a way to open a gap in the record by
 * editing a settings file — which is the whole thing lib/management.js exists to make
 * impossible. The switch is the transition on `refs/beadcause/management`, it has an author
 * and a reason on it, and this file has no second one.
 *
 * ## What a sweep does, in the order it does it
 *
 * 1. **Enrol, once.** A chain's first record names the instance publishing it and there is
 *    no chain without one. The organisation is not invented — `lib/organisation.js` refuses
 *    `default` and its eighteen siblings precisely so that nobody fills the column in — it
 *    is read from `lib/boundary.js`'s register, which is keyed by organisation id and ships
 *    compiled into the release. A release shipping exactly one organisation belongs to that
 *    organisation; a release shipping two has to be told which, and that is a refusal
 *    rather than a guess.
 * 2. **Attest, then publish a head.** `recordAttestedHead` writes the posture in force and
 *    the chain head at one instant and in that order, which is bc-3muu.12's rule and not
 *    this file's to restate. What this file decides is *when*: a ref whose tip has moved is
 *    published immediately, because the movement is the interesting fact, and a ref that
 *    has not moved is published again once the last head for it is older than the anchoring
 *    interval. The floor is what makes a quiet fortnight read as an instance that went on
 *    reporting rather than as one that stopped.
 * 3. **Publish the management transitions.** The transition record is the one kind that
 *    says the compliance layer itself changed state, and a chain that carries heads but not
 *    the moment the layer was switched off is a chain with the gap taken out of it.
 * 4. **Send whatever the far end has not witnessed.** Through `publishQuietly`, which is
 *    the door that cannot throw, cannot reject and cannot hang — a service that is
 *    unreachable, or accepted-then-silent, leaves the tick untouched and leaves the records
 *    on disk for the next sweep. There is no transport on this Mac yet (bc-3muu.14): that is
 *    not reported as an outage, because an install whose service has not been stood up is not
 *    an install that lost touch with one, and a word that says otherwise every hour is the
 *    word nobody reads on the day it is true.
 *
 * ## Why the poll cycle and not a timer
 *
 * `publish` is written to be called often and to cost nothing when there is nothing to do,
 * so it wants the thing that is already beating rather than a clock of its own — and a
 * timer inside a module is a second lifetime to get wrong at shutdown. It runs in the slow
 * half of lib/server.js's cycle, on its own interval like the tracker sync beside it, and
 * it is last: nothing waits on it, and it is the only sweep that both writes evidence and
 * may reach a network with a thirty-second deadline behind it.
 *
 * ## What a failure is allowed to do to a tick, which is nothing
 *
 * Every outcome is a word and a sentence, never a throw. `sweep` catches its own work the
 * way `syncOnce` does, because a compliance layer that can stop a question reaching a phone
 * has inverted the priority it was installed to protect — "fail open for work, fail closed
 * for claims" is the epic's second principle, and the claim half is kept elsewhere: an
 * unpublished period is refused a claim by `claimProblems` in lib/continuity.js rather than
 * rendering as a clean window. Nothing here papers over a gap; it only declines to make the
 * gap the daemon's problem.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_INTERVAL_HOURS } from './anchor.js';
import { organisations } from './boundary.js';
import { CONFIG_DIR, OBSERVING } from './config.js';
import { git, mainCheckout, ok, refTip } from './gitref.js';
import { whenOn } from './management.js';

/** The directory this file was loaded from, which is the install that is running. */
const SELF = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HOUR = 3600 * 1000;

/**
 * How often a sweep may run, in milliseconds.
 *
 * An hour rather than the cycle's thirty seconds, and the number is about *noticing* rather
 * than about publishing: a ref that moved is published on the first sweep after it moved, so
 * this is the longest an amendment or an election can sit unpublished. Against that, every
 * sweep walks the whole chain twice — `chain()` refuses to cap itself for a good reason —
 * so a minute-by-minute sweep would spend the day re-reading a history to establish that
 * nothing had happened.
 *
 * The floor is a minute. Below that the sweep is reading its own tail.
 */
export const publishEveryMs = (cfg) => Math.max(60, Number(cfg?.publication?.seconds) || 3600) * 1000;

/**
 * How stale the last head for a ref may get before it is published again.
 *
 * Taken from lib/anchor.js rather than chosen here, so the two numbers cannot disagree. The
 * anchoring interval is what an auditor's coverage arithmetic is done in; a head published
 * less often than the thing that anchors heads would leave intervals with nothing in them
 * to anchor, and a head published far more often than it would fill the chain with records
 * saying the same sha.
 */
export const HEAD_EVERY_MS = DEFAULT_INTERVAL_HOURS * HOUR;

/**
 * The refs whose heads this deployment publishes, and where each one lives.
 *
 * Every entry is a *chained* evidence class in lib/evidence.js's register that lives at one
 * fixed ref — `test/publishsweep.mjs` crosswalks the whole table against that register by
 * literal id and fails the repo if an id here is not chained there, which is the discipline
 * lib/controls.js keeps over its own crosswalks. `where` is `store` for the common repo and
 * `checkout` for the repository beadcause is installed from, because those are two
 * directories and a head published against the wrong one is a head of nothing.
 *
 * **Two kinds of chained class are deliberately absent, and each is a sentence rather than
 * an omission.**
 *
 * - `publication-chain` itself. A head of the chain, appended to the chain, changes the
 *   head it just published — it is not a stale record, it is a record that was never true
 *   for an instant. What witnesses this ref is the far end holding the same records, and
 *   the anchor over the tip.
 * - The classes that live at a *family* of refs rather than at one — `session-transcripts`
 *   (`refs/beadcause/sessions/<bead>`), and the per-kind, per-topic and per-bead halves of
 *   `agent-memory`. One head each is unbounded in the number of beads this laptop has ever
 *   run, and the right shape for a family is one record digesting the whole set rather than
 *   a thousand records digesting one each. That is worth doing and it is not this bead.
 */
export const PUBLISHED_REFS = Object.freeze([
  Object.freeze({
    id: 'foundation-amendments',
    ref: 'refs/beadcause/foundations',
    where: 'checkout',
    why: 'what each agent kind is permitted to be — the head an auditor needs to know a privilege change was not backdated',
  }),
  Object.freeze({
    id: 'audit-runs',
    ref: 'refs/beadcause/audits',
    where: 'checkout',
    why: 'what the checkout was audited against, and when',
  }),
  Object.freeze({
    id: 'merge-notes',
    ref: 'refs/notes/beadcause',
    where: 'checkout',
    why: 'the traceability from a requirement to the commit that satisfied it',
  }),
  Object.freeze({
    id: 'agent-run-logs',
    ref: 'refs/beadcause/agentlogs',
    where: 'checkout',
    why: 'one chained commit per archived agent run, whose bodies are disposed of on a clock',
  }),
  Object.freeze({
    id: 'election-history',
    ref: 'refs/beadcause/election',
    where: 'store',
    why: 'what this organisation elected to be held to, and from when',
  }),
  Object.freeze({
    id: 'management-transitions',
    ref: 'refs/beadcause/management',
    where: 'store',
    why: 'whether the layer was on at all, which is the window every other claim is made inside',
  }),
  Object.freeze({
    id: 'agent-memory',
    ref: 'refs/beadcause/memory',
    where: 'store',
    why: 'what an unattended agent was told about this install before it acted',
  }),
]);

/** The chained classes this deliberately does not publish, and why. Read by the crosswalk. */
export const NOT_PUBLISHED = Object.freeze({
  'publication-chain':
    'the chain itself — a head of it appended to it changes the head it published, and what witnesses this ref is the far end holding the same records',
  'session-transcripts':
    'a family of refs, one per bead. A head each is unbounded in the beads this laptop has run; a family wants one record digesting the set, which is not this bead',
});

/* ------------------------------------------------------------------- outcomes */

/**
 * The words a sweep can come back as, and what each of them means for whoever reads a log.
 *
 * The sweep's own vocabulary rather than the transport's. `publish` in lib/publication.js
 * answers with `compare`'s eleven — `agreed`, `ahead`, `forked`, `truncated` and the rest —
 * which are the right words for *a comparison of two histories* and the wrong ones for a
 * daemon sweep: `ahead` is the ordinary state of a laptop that was shut, and a line saying
 * `ahead` every hour teaches nobody anything. So the comparison's verdict is carried whole
 * in `sent`, and this is the word.
 *
 * `true` marks the two that are somebody's problem. `offline` deliberately is not one of
 * them: a service that cannot be reached is the ordinary condition this whole design is
 * built to survive, and the thing that makes an unpublished period matter is a claim over
 * it being refused — `claimProblems` in lib/continuity.js — rather than a red line in a log.
 */
export const VERDICTS = Object.freeze({
  off: false,
  quiet: false,
  appended: false,
  published: false,
  offline: false,
  unenrolled: true,
  observing: false,
  divergent: true,
  failed: true,
});

const outcome = (verdict, why, extra = {}) =>
  Object.freeze({
    verdict,
    why,
    enrolled: false,
    appended: Object.freeze([]),
    sent: 0,
    pending: 0,
    skipped: Object.freeze([]),
    ...extra,
  });

/** A sentence for the log — one line, and it says which of the eight this was. */
export const describePublication = (o) => `${o?.verdict || 'failed'} — ${o?.why || 'no outcome'}`;

/* --------------------------------------------------------------- the tenant */

/**
 * Which organisation this install publishes as, or a sentence saying why nothing can.
 *
 * Derived rather than configured, and the derivation is the argument. An organisation id is
 * permanent, it prefixes every storage key and every route, and `lib/organisation.js`
 * refuses `default`, `main`, `shared` and fifteen others *because* they are what an install
 * writes when it has one tenant and a column to fill. So there is no config key to fill in
 * wrong: `lib/boundary.js` already keys its register by organisation id, that register ships
 * compiled into the release, and a release shipping exactly one organisation is an install
 * belonging to it. Two, and this refuses — an install that has to be told which tenant it is
 * must be told rather than guessed at, and a guess here is a chain filed under the wrong
 * organisation for as long as the install lives.
 */
export function organisationOf(known = organisations()) {
  if (known.length === 1) return { org: known[0], problem: null };
  if (!known.length)
    return { org: null, problem: 'this release ships no organisation register, so there is nothing to enrol into' };
  return {
    org: null,
    problem: `this release ships ${known.length} organisations (${known.join(', ')}) and nothing says which one this install is`,
  };
}

/* ------------------------------------------------------------------ cadence */

/**
 * The last `chain-head` record on the chain for each ref, keyed by ref.
 *
 * One walk of the chain for every ref rather than one per ref, because the chain is walked
 * whole either way and the cost of doing it seven times is seven times the cost.
 */
function headsByRef(records) {
  const last = new Map();
  for (const rec of records) if (rec?.kind === 'chain-head' && typeof rec.ref === 'string') last.set(rec.ref, rec);
  return last;
}

/**
 * Whether this ref's head is due, and the reason, which goes in the log.
 *
 * Three answers and the third is the interesting one. Never published: due, because a ref
 * with no head on the chain has never been reported at all. Tip moved: due, because the
 * movement is the fact worth publishing and publishing it late is what makes an amendment
 * look like it happened whenever the daemon next woke. Neither, and the last head is older
 * than the anchoring interval: due, because an interval with no head in it is an interval
 * with nothing for an anchor to cover, and a chain that stops growing during a quiet
 * fortnight is indistinguishable from an instance that stopped.
 */
export function headDue(record, tip, { at = Date.now(), everyMs = HEAD_EVERY_MS } = {}) {
  if (!tip) return { due: false, why: 'the ref has no commits, so there is no head to publish' };
  if (!record) return { due: true, why: 'never published' };
  if (record.head !== tip) return { due: true, why: `moved from ${String(record.head).slice(0, 8)} to ${tip.slice(0, 8)}` };
  const age = at - Date.parse(record.at);
  if (!Number.isFinite(age)) return { due: true, why: 'the last head on the chain has no readable timestamp' };
  if (age >= everyMs) return { due: true, why: `unchanged, and the last head is ${Math.round(age / HOUR)}h old` };
  return { due: false, why: `published ${Math.round(age / HOUR)}h ago and unchanged` };
}

/**
 * The management transitions that are not on the chain yet, newest last.
 *
 * The n-th commit on `refs/beadcause/management` is the n-th transition in its payload, and
 * that correspondence is not an assumption this file introduces — `verify()` in
 * lib/management.js already compares `rev-list --count` against the length of the transition
 * list, so a payload edited without its history is reported there rather than trusted here.
 *
 * **A transition with no bead cannot be published, and it is counted rather than dropped.**
 * The `transition` kind in lib/publishable.js requires all three of its fields and `bead` is
 * one of them, while `setManagement` takes a bead and defaults it to null — so an enable
 * typed without `--bead` is a transition this cannot carry. Saying so in the outcome is the
 * whole difference between a known hole and a silent one; widening the kind or the CLI is
 * filed separately.
 */
export function transitionsOwed(transitions, commits, published) {
  const owed = [];
  const skipped = [];
  for (let i = 0; i < transitions.length; i += 1) {
    const commit = commits[i];
    const bead = transitions[i]?.bead;
    if (!commit) {
      skipped.push(`transition ${i + 1} has no commit on the ref — the payload and its history disagree`);
      continue;
    }
    if (published.has(commit)) continue;
    if (typeof bead !== 'string' || !bead) {
      skipped.push(`transition ${i + 1} (${commit.slice(0, 8)}) names no bead, and a published transition carries one`);
      continue;
    }
    owed.push({ commit, bead });
  }
  return { owed, skipped };
}

/* -------------------------------------------------------------- the sweeper */

/**
 * The daemon's publisher. `sweep()` is the whole of it, and it never throws.
 *
 * `transport` is `{ head, deliver }` or null and is the caller's, exactly as `publish`
 * insists: the same loop drives an HTTP client, a queue or a test's in-process ledger, and
 * there is no code path here that a service outage can throw through. `store` and
 * `checkout` are places to look rather than values, for the reason lib/posture.js's
 * `observe` takes places: a sweep has to be runnable against a deployment that is not this
 * one, from a check and from a CLI.
 */
export function createPublisher({
  transport = null,
  store = CONFIG_DIR,
  checkout = null,
  observing = OBSERVING,
  deadlineMs = undefined,
} = {}) {
  let sweptAt = 0;
  let cachedCheckout;

  const checkoutDir = async () => {
    if (checkout) return checkout;
    if (cachedCheckout === undefined) cachedCheckout = (await ok(mainCheckout(SELF))) || SELF;
    return cachedCheckout;
  };

  /**
   * One sweep. `force` is for a caller that has its own clock — a test, or a CLI.
   *
   * The interval is checked before `whenOn` on purpose: an install with the layer off gets
   * `state()` asked of it once an hour rather than twice a minute, and `state()` is the one
   * read that has to stay free.
   */
  const sweep = async ({ cfg = null, now = Date.now(), force = false } = {}) => {
    if (!force && now - sweptAt < publishEveryMs(cfg)) {
      return outcome('quiet', 'not due yet');
    }
    sweptAt = now;

    return await whenOn(
      async () => {
        try {
          return await run(now);
        } catch (err) {
          // Reached only by something none of the calls below already answers for — a
          // common repo that vanished mid-sweep, a git that is not on the PATH. Still not
          // the daemon's problem: the records are on disk and the next sweep reads them.
          return outcome('failed', `the publication sweep could not be attempted: ${err.message}`);
        }
      },
      { fallback: outcome('off', 'the management system is off, so nothing is published and nothing is created') }
    );
  };

  /**
   * Everything that touches a store, behind the door.
   *
   * The three `import()`s are why this is a separate function and not the body of the
   * loader above: they are what makes "an off install never parses lib/publication.js" a
   * property of the module graph rather than a promise in a comment.
   */
  const run = async (now) => {
    const [{ append, chain, publishQuietly, recordAttestedHead }, instance, { record: managementRecord }] =
      await Promise.all([import('./publication.js'), import('./instance.js'), import('./management.js')]);

    /* ------------------------------------------------------------- enrolment */

    const { org, problem } = organisationOf();
    if (problem) return outcome('unenrolled', problem);

    const place = instance.placeOf(store);
    let identity = instance.load(store);
    let enrolled = false;
    if (!identity) {
      if (observing) {
        return outcome('observing', 'this instance watches and never enrols as the install it was copied from');
      }
      const fresh = instance.enrol(store, { org, place });
      identity = fresh.identity;
      enrolled = fresh.enrolled;
    }

    const cannot = instance.publishProblems(identity, { place, observing });
    if (cannot.length) {
      // An observer sharing a copied config directory would otherwise append to the
      // original install's chain — the chain is *in* the directory it copied — and two
      // writers on one chain fork the sequence. `publishProblems` is the guard that names
      // both that and a placement that moved, and it is asked before the first append
      // rather than at the transport, because the local records are the claim.
      return outcome(observing ? 'observing' : 'unenrolled', cannot[0], { enrolled });
    }

    const at = new Date(now).toISOString();
    const appended = [];

    let records = await chain();
    if (!records.length) {
      // The genesis. Stamped at the moment the identity was minted rather than now, so the
      // chain and the one `enrolmentRecord` mints from the same identity are the same record
      // rather than two that differ by a clock read. Clamped forward if that stamp is somehow
      // ahead of this sweep, because `linkProblems` refuses a chain whose stamps run backwards
      // and an enrolment nobody can append is an install that can never publish again.
      const born = Date.parse(identity.enrolledAt);
      const stamp = Number.isFinite(born) && born <= now ? identity.enrolledAt : at;
      const { record } = await append(
        'enrolment',
        { fingerprint: identity.fingerprint, org: identity.org },
        { instance: identity.id, at: stamp }
      );
      appended.push(`enrolment #${record.seq}`);
      records = await chain();
    }

    /* ------------------------------------------------------- heads and postures */

    const skipped = [];
    const last = headsByRef(records);
    const published = new Set(
      records.filter((r) => r?.kind === 'transition' && typeof r.commit === 'string').map((r) => r.commit)
    );
    for (const entry of PUBLISHED_REFS) {
      const cwd = entry.where === 'store' ? store : await checkoutDir();
      if (!cwd) {
        skipped.push(`${entry.ref}: beadcause is not installed from a checkout, so there is nowhere to read it`);
        continue;
      }
      const tip = await refTip(cwd, entry.ref);
      const due = headDue(last.get(entry.ref) || null, tip, { at: now });
      if (!due.due) continue;
      const { posture, head } = await recordAttestedHead(cwd, entry.ref, {
        deployment: { cwd: await checkoutDir(), store, witness: null },
        instance: identity.id,
        at,
      });
      if (posture.changed) appended.push(`posture #${posture.record.seq}`);
      appended.push(`chain-head #${head.record.seq} ${entry.ref} (${due.why})`);
    }

    /* -------------------------------------------------------------- transitions */

    const mgmt = await managementRecord();
    // Raw `rev-list` rather than `refHistory`, which would answer with the same walk and a
    // cap on it — and a cap is exactly what must not be here: what this compares against is
    // the whole history of the switch, and a walk that quietly stops at fifty is how the
    // fifty-first transition stops being published without anybody changing anything.
    const commits = String((await ok(git(store, ['rev-list', '--reverse', 'refs/beadcause/management']))) || '')
      .split('\n')
      .filter(Boolean);
    const owed = transitionsOwed(mgmt.transitions, commits, published);
    skipped.push(...owed.skipped);
    for (const t of owed.owed) {
      const { record } = await append('transition', { ref: 'refs/beadcause/management', commit: t.commit, bead: t.bead }, { at });
      appended.push(`transition #${record.seq} ${t.commit.slice(0, 8)} (${t.bead})`);
    }

    /* ------------------------------------------------------------- publication */

    // Through `publishQuietly` even when there is no transport, because it is the one door
    // and answering "nothing was given" in two places is how the two answers come to
    // disagree. What is not taken from it is the *word*: an install whose service has not
    // been stood up yet is not offline, it is an install with a growing chain and nowhere to
    // send it, and reporting that as an outage every hour would train the reading of the one
    // that is an outage.
    const sent = await publishQuietly({ ...(transport || {}), ...(deadlineMs === undefined ? {} : { deadlineMs }) });
    const local = appended.length ? `${appended.length} record(s) appended: ${appended.join(', ')}` : 'nothing to append';
    const carried = transport ? sent.why : 'no service is configured, so the chain is kept and nothing is sent';

    // The order is the priority a reader needs rather than the order the code ran in. A
    // divergence outranks everything, including a successful append, because it is the one
    // outcome here that never resolves itself and the one this epic exists to detect. An
    // outage outranks the append below it for the opposite reason — it says nothing is
    // reaching the far end, which "appended" on its own reads as denying.
    const verdict = sent.divergent
      ? 'divergent'
      : transport && sent.verdict === 'offline'
        ? 'offline'
        : sent.sent
          ? 'published'
          : appended.length
            ? 'appended'
            : 'quiet';
    return outcome(verdict, `${local}. ${carried}`, {
      enrolled,
      appended: Object.freeze(appended),
      compared: sent.verdict,
      sent: sent.sent || 0,
      pending: sent.pending || 0,
      skipped: Object.freeze(skipped),
      divergent: Boolean(sent.divergent),
    });
  };

  return { sweep, organisationOf, refs: PUBLISHED_REFS };
}
