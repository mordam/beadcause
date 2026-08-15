/**
 * Who operates each part of the central service, and what that arrangement entitles
 * anybody to claim.
 *
 * The decision this file records, settled by Adam on bc-3muu.9: **each organisation
 * installs and runs its own control-daemon. We host nothing.** Beadcause is a software
 * vendor, optionally a consultant who sets it up and teaches somebody to run it, and
 * never a party holding anyone's evidence. Every other option on that bead — Climative
 * infrastructure, a beadcause-hosted witness deployment, a purpose-built service — made
 * somebody a service organisation holding somebody else's record, and each of them
 * forced a carve-out or inclusive-method decision into a system description that did not
 * want one.
 *
 * **Why the trust model is acceptable given who administers the witness, which is the
 * one line bc-3muu.9 exists to record.** It is acceptable because independence is
 * carried by the *anchor*, not by the access control. A control-daemon the organisation
 * hosts is a second copy in the same hands as the first, so it delivers corroboration —
 * a copy that must agree — and no amount of access control can make it deliver more,
 * because whoever administers the access control is inside the boundary it protects.
 * That is fine, and no clause of SOC 2 or ISO/IEC 27001 asks otherwise; CloudTrail is
 * first-party too. What would not be fine is *saying* independent, and that is the
 * misstatement `claimProblems` refuses.
 *
 * **So the cost of self-hosting is that the anchor stops being optional, and that is the
 * whole reason this file has code in it rather than being a paragraph in the README.**
 * When we hosted the control-daemon there were two parties in the arrangement and the
 * corroboration argument stood on its own. In the self-hosted model the organisation
 * runs the local daemons *and* the control-daemon, so every copy is theirs and that
 * argument collapses back to one party. The receipts from bc-3muu.10 are then the only
 * thing carrying independence at all. An install that has not configured anchoring is
 * therefore not a weaker version of this design — it is a different one, with no
 * tamper-evidence in it, and the failure to guard against is that it goes on rendering
 * the same continuity claim as an anchored one.
 *
 * **The refusal that matters is the fourth rule in `arrangementProblems`: an anchor
 * operated from inside the arrangement is not an anchor.** It is a third copy in the
 * same hands, and it is the single mistake that would make every other claim here false
 * while every check still passed — immutable object storage in our own account is the
 * tempting version of it, and it is a good control at the *storage* layer and not an
 * anchor at any layer. `PARTIES` exists so that mistake has to be written down as the
 * word `organisation` next to the word `anchor`, where a reader can see it.
 *
 * **Assurance is derived and never asserted.** `assuranceOf` reads the arrangement and
 * answers with the strongest word it supports; there is no field anybody can set to
 * `independent`. A record of what an install *believes* about itself is the flag
 * lib/election.js declines to have, one layer up: the way it fails is you believing you
 * configured it.
 *
 * **What this file is not.** It is not the anchor — bc-3muu.10 builds the client and
 * holds the RFC 3161 tokens and the transparency-log proofs, and the seam between us is
 * that a receipt proves an anchoring *happened* while this only knows an anchor party is
 * in the arrangement and who administers it. It is not enrolment (bc-3muu.2), not the
 * protocol (bc-3muu.3), and not the system description that finally has to name the
 * carve-out (bc-3muu.7); `subservices` reports what such a description will have to say,
 * because a consequence discovered by an auditor is worse than one printed by a
 * function.
 *
 * A near-leaf. One import — `orgProblems` from lib/organisation.js, because a second,
 * weaker organisation-id rule here is exactly the mistake that file's own header warns
 * about — and no state read or written, so a check, a service, a daemon and an installer
 * can each hold it.
 */

import { orgProblems } from './organisation.js';

/**
 * What a deployment can be. Three, and they are distinguished by what they hold rather
 * than by what they run.
 *
 * - `local` — a daemon on a machine, doing the work and originating the records. This is
 *   beadcause as it has always been.
 * - `control` — the control-daemon: the continuous, high-resolution corroborating copy.
 *   It holds heads and metadata and never content (bc-3muu.1), and it witnesses rather
 *   than authors (bc-3muu.3).
 * - `anchor` — a party outside the arrangement that timestamps a head and returns a
 *   receipt. Rare and coarse: it cannot say what happened between anchors, only that
 *   everything before this point existed by then.
 */
export const ROLES = Object.freeze(['local', 'control', 'anchor']);

/**
 * Who administers a deployment, as a *relation* rather than a name.
 *
 * A name would be a fact about a company; the relation is the fact the trust argument
 * turns on, and it is the one an auditor asks for. `organisation` is the party whose
 * records these are and whose audit they serve. `vendor` is us — whoever ships the
 * software — and is a distinct word from `external` precisely because a vendor that
 * starts operating something is not neutral about what it holds. `external` is anybody
 * who is neither, which is the only party an anchor can be run by.
 */
export const PARTIES = Object.freeze(['organisation', 'vendor', 'external']);

/**
 * What an arrangement supports being claimed, weakest first. The order is the API: an
 * index comparison is what `claimProblems` does, so a fourth word added later slots into
 * the ladder rather than into every caller.
 *
 * - `unwitnessed` — local deployments only. Nothing has left the machine, so a rewritten
 *   history is perfectly self-consistent and nothing can catch it. This is every
 *   beadcause install today, and it is a true thing to say rather than a broken one.
 * - `corroborated` — a second copy exists, held apart from the first, that must agree
 *   with it. Tamper-*evidence* in the ordinary sense, and enough for most of what an
 *   auditor samples.
 * - `independent` — some part of the record is held by a party nobody in the arrangement
 *   administers, so rewriting both copies is detectable from a receipt signed elsewhere.
 */
export const ASSURANCE = Object.freeze(['unwitnessed', 'corroborated', 'independent']);

/**
 * The operating model beadcause ships, as data rather than as a sentence.
 *
 * This is bc-3muu.9's answer in the form a test can read. Every role is operated by the
 * organisation itself except the anchor, which by construction cannot be — see
 * `arrangementProblems`.
 */
export const OPERATED_BY = Object.freeze({
  local: 'organisation',
  control: 'organisation',
  anchor: 'external',
});

/**
 * What the vendor operates: nothing.
 *
 * An empty list looks like a placeholder and is the entire decision. It is what makes
 * "you run it, we never see your data, not even the hashes" a checkable property of this
 * repository rather than a sentence in a security questionnaire, and `test/operator.mjs`
 * asserts both that it is empty and that `shipped()` produces no deployment naming the
 * vendor. The day it stops being empty, something has become a subservice organisation
 * in somebody else's system description and a bead should say so first.
 */
export const VENDOR_OPERATES = Object.freeze([]);

/** A UTC instant, in the one spelling every record in this epic uses. */
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

const isString = (v) => typeof v === 'string';

/* -------------------------------------------------------------- one deployment */

/**
 * Everything wrong with a single deployment record, as sentences. Empty means it is
 * usable.
 *
 * Four fields and no more. `since` is required and is UTC because *since when* is the
 * question a Type II report is actually asking of an operating arrangement — an
 * organisation that took its control-daemon in-house in May has two arrangements that
 * year, and a record with no clock on it cannot say which one covers March. `org` is on
 * every deployment for the reason lib/organisation.js puts it on every published record:
 * a derived tenant has no history.
 */
export function deploymentProblems(dep) {
  if (!dep || typeof dep !== 'object' || Array.isArray(dep)) return ['not a deployment record'];

  const problems = [];
  if (!ROLES.includes(dep.role)) {
    problems.push(`role must be one of ${ROLES.join(', ')} — what it holds, not what it runs`);
  }
  if (!PARTIES.includes(dep.operator)) {
    problems.push(
      `operator must be one of ${PARTIES.join(', ')} — who administers it, as a relation to the ` +
        'organisation whose records these are, because that relation is what an auditor asks about'
    );
  }
  problems.push(...orgProblems(dep.org));
  if (!isString(dep.since) || !INSTANT_RE.test(dep.since)) {
    problems.push('since must be a UTC instant, such as 2026-08-15T17:48:35Z — an arrangement is a period, not a state');
  }

  const known = new Set(['role', 'operator', 'org', 'since']);
  for (const name of Object.keys(dep)) {
    if (!known.has(name)) problems.push(`"${name}" is not part of a deployment record`);
  }
  return problems;
}

/* ------------------------------------------------------------ the arrangement */

/**
 * Everything wrong with an organisation's whole arrangement, as sentences.
 *
 * The rules a single deployment cannot see, and the fourth is the one this file exists
 * for.
 *
 * 1. **There is something to witness.** An arrangement with no `local` deployment is a
 *    witness with nothing to witness, and it reads as a healthy setup in every list.
 * 2. **It is one organisation's.** Deployments naming different organisations are two
 *    arrangements, and answering "what may this claim" over the union of them would
 *    quietly answer it for a tenant that has no control-daemon at all.
 * 3. **Two copies in the same hands are one party.** A second `control` under the same
 *    operator is redundancy, which is an availability property and a good one; counting
 *    it as a second party is how "we keep two copies" becomes "we are corroborated" in a
 *    sentence nobody meant to overstate.
 * 4. **An anchor operated from inside the arrangement is not an anchor.** Independence
 *    is not a feature that can be implemented — it is the property of somebody else
 *    holding the record — so an `anchor` run by the `organisation` or by the `vendor` is
 *    a third copy wearing the word. Refused by name, because this is the mistake that
 *    would leave every other check in the epic passing over a claim that is false.
 */
export function arrangementProblems(deployments) {
  if (!Array.isArray(deployments)) return ['an arrangement is a list of deployment records'];

  const problems = [];
  const sound = [];

  for (const [i, dep] of deployments.entries()) {
    const own = deploymentProblems(dep);
    for (const p of own) problems.push(`deployment ${i}: ${p}`);
    if (!own.length) sound.push(dep);
  }
  if (!sound.length) {
    if (!problems.length) problems.push('an arrangement with no deployments in it claims nothing, and cannot be asked what it claims');
    return problems;
  }

  const orgs = new Set(sound.map((d) => d.org));
  if (orgs.size > 1) {
    problems.push(
      `deployments name ${[...orgs].sort().join(' and ')} — an arrangement belongs to one organisation, ` +
        'because asking the union what it may claim answers for a tenant that has none of it'
    );
  }
  if (!sound.some((d) => d.role === 'local')) {
    problems.push('there is no local deployment — a witness with nothing to witness is not an arrangement, and it looks like a healthy one in every list');
  }

  const controllers = sound.filter((d) => d.role === 'control').map((d) => d.operator);
  for (const party of new Set(controllers)) {
    if (controllers.filter((p) => p === party).length > 1) {
      problems.push(
        `${party} operates more than one control deployment — that is redundancy, which is an availability ` +
          'property and a good one, but two copies in the same hands are one party and must not be counted as two'
      );
    }
  }

  for (const dep of sound) {
    if (dep.role === 'anchor' && dep.operator !== 'external') {
      problems.push(
        `an anchor operated by the ${dep.operator} is not an anchor — independence is not a feature that can be ` +
          'implemented, it is the property of somebody else holding the record, so this is a third copy in the same hands'
      );
    }
  }
  return problems;
}

/**
 * The strongest word this arrangement supports, derived and never asserted.
 *
 * Returns one of `ASSURANCE`, or `null` if the arrangement is not sound — `null` rather
 * than `unwitnessed` on purpose, and it is the same distinction lib/election.js draws
 * between `null` and `false`. `unwitnessed` is an answer about a real arrangement;
 * `null` means nothing was asked, and a caller handed the weakest word for a record it
 * could not read would go on to render a continuity claim over it.
 *
 * Note what it does *not* weigh: resolution. The anchor is coarse by construction — once
 * an hour or once a day — so `independent` says a rewrite before the last anchor is
 * detectable, and says nothing about the interval since. Continuity across that interval
 * is the control-daemon's job (bc-3muu.3) and an unpublished period is bc-3muu.4's. Two
 * axes, deliberately not folded into one number.
 */
export function assuranceOf(deployments) {
  if (arrangementProblems(deployments).length) return null;
  if (deployments.some((d) => d.role === 'anchor')) return 'independent';
  if (deployments.some((d) => d.role === 'control')) return 'corroborated';
  return 'unwitnessed';
}

/**
 * Everything wrong with claiming `claim` over this arrangement, as sentences. Empty
 * means the arrangement backs the claim.
 *
 * The rule Adam's answer attached to self-hosting, in the one form that survives being
 * forgotten: a deployment that has not configured anchoring must not be able to claim
 * continuity it cannot back. A *weaker* claim than the arrangement supports is always
 * fine and never mentioned — an organisation entitled to say `independent` and choosing
 * to say `corroborated` has understated its position, which is nobody's problem.
 */
export function claimProblems(deployments, claim) {
  if (!ASSURANCE.includes(claim)) {
    return [`"${claim}" is not something an arrangement can claim — one of ${ASSURANCE.join(', ')}`];
  }
  const bad = arrangementProblems(deployments);
  if (bad.length) return [`the arrangement cannot back any claim until it is sound: ${bad.join('; ')}`];

  const held = assuranceOf(deployments);
  if (ASSURANCE.indexOf(claim) <= ASSURANCE.indexOf(held)) return [];

  const missing =
    claim === 'independent'
      ? 'no anchor is operated by anybody outside the arrangement, so both copies are in the same hands and a rewrite of both is undetectable'
      : 'nothing holds a second copy, so a rewritten history is perfectly self-consistent and nothing can catch it';
  return [`this arrangement is ${held} and cannot claim ${claim} — ${missing}`];
}

/* ------------------------------------------------------- the consequences of it */

/**
 * The deployments in this arrangement that somebody else operates, and what each one
 * forces into a system description.
 *
 * Returns a list of `{ role, operator, why }`, empty in the model beadcause ships —
 * which is the whole commercial and audit argument for self-hosting, printed rather than
 * promised. Naming this is bc-3muu.7's job; computing it is this file's, because a
 * consequence an auditor discovers is worse than one a function prints, and the day
 * somebody stands up a hosted control-daemon for a customer the list stops being empty
 * on its own.
 *
 * The anchor is excluded, and the distinction is real rather than convenient. A
 * subservice organisation performs part of the service commitments on the
 * organisation's behalf, which is what holding its evidence is. An anchor is handed a
 * hash, returns a receipt, and performs no control for anybody — it is a supplier in the
 * vendor register, and calling it a subservice organisation would put a timestamping CA
 * in a system description alongside a hosting provider.
 */
export function subservices(deployments) {
  if (arrangementProblems(deployments).length) return [];
  return deployments
    .filter((d) => d.role !== 'anchor' && d.operator !== 'organisation')
    .map((d) => ({
      role: d.role,
      operator: d.operator,
      why:
        `the ${d.role} deployment is operated by the ${d.operator}, which holds the organisation's evidence on its ` +
        'behalf — a subservice organisation, forcing a carve-out or inclusive-method decision in the system description',
    }));
}

/**
 * The arrangement beadcause ships, for one organisation, as of `since`.
 *
 * The answer to bc-3muu.9 in the form anything can compare itself against: the
 * organisation runs its own daemons and its own control-daemon, an external party
 * anchors, and the vendor operates nothing. An installer builds this; a check asserts a
 * real install has not drifted from it; a report says which of the three it is missing.
 */
export function shipped(org, since) {
  return ROLES.map((role) => ({ role, operator: OPERATED_BY[role], org, since }));
}
