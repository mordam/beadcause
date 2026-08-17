/**
 * The AI system registry: every system beadcause runs, and the card for each.
 *
 * ISO/IEC 42001 asks for system documentation per AI system — the intended use, the
 * reasonably foreseeable misuse, who is affected, the human oversight measure, the model
 * and the stated limitations. lib/foundation.js already carries all of that for an agent,
 * because a card field is a foundation field and therefore inside the amendment chain
 * (see `CARD_FIELDS` there, and `cardGap` for the gate that keeps it honest). This module
 * is the two things that could not live in that file.
 *
 * **The first is beadcause itself, which is a registered system and is not an agent.**
 * Six kinds of agent do work; the daemon, the phone app and the loop connecting them are
 * the system those agents are part of, and an auditor asking "what is this thing" is not
 * asking about the worker. It has no `BASELINES` entry on purpose: a seventh key in that
 * map would put `beadcause` in `AGENTS`, and every reader of `AGENTS` — the activity
 * matcher, the chat launcher, the amendment parser, `POST /api/console` — would then be
 * wrong in a way that fails as a runtime surprise rather than as a compile error. So it
 * is a sibling record, resolved by the same reader below, and `AGENTS` still means agent
 * kinds afterwards.
 *
 * **The second is that beadcause's own card is not amendable, and that is stronger than
 * amendable rather than weaker.** An agent's card is amendable because there is an agent
 * that could ask — the amendment loop exists so a "no" can be argued with, and a card
 * outside `AMENDABLE` could drift in a release with nothing on the ref to show for it.
 * Nothing *is* beadcause, so there is nobody to file that request; changing what the
 * system is for is a commit to this file, reviewed by a person, which is the higher bar
 * of the two. Said out loud because "not in the chain" reads as an oversight otherwise.
 *
 * There is no loader, no cache and no state here. The register ships with the release and
 * an absent one is a broken build, the way lib/controls.js ships its corpus — a registry
 * you could fail to install is a registry that answers "no systems" on a machine that is
 * running six of them.
 */
import { AGENTS, baseline, all as allFoundations, cardOf, CARD_FIELDS } from './foundation.js';

/** The id of the system itself, as opposed to any of its agents. */
export const SYSTEM = 'beadcause';

/**
 * Beadcause, as a card.
 *
 * Deliberately the same shape as an agent's — `id`, `title`, `purpose` and the five card
 * fields — so `systemCard` can answer for either without the caller knowing which it
 * asked about. What it does not have is `tools`, `allowedTools` or `model`: those are
 * facts about a process that runs, and beadcause is the thing that opens the processes.
 * `cardOf` would answer `opus, routed` for a null model, which is true of a worker on an
 * unrated bead and not true of a daemon, so the model line is written here instead and
 * points at the six agents that do run on something.
 */
const BEADCAUSE = {
  id: SYSTEM,
  title: 'beadcause',
  purpose: 'The management system itself: the daemon, the phone app, and the agents it opens.',
  intendedUse:
    "Running one person's issue trackers as a supervised loop — an advocate proposes, they approve from a " +
    'phone, a worker does the work in a terminal on their own Mac, and a merge queue lands it. Every ' +
    'repository it touches and every tracker it writes to is one that person already had access to; it ' +
    'adds no reach of its own, only speed.',
  foreseeableMisuse:
    'Pointed at a shared team repository and left running, it becomes a system that files, works and merges ' +
    "into other people's code at machine speed with one person's tap standing in for a team's review. It is " +
    'also, structurally, a way to spend a great deal of model budget unattended, and the screen that would ' +
    'show you that is one you have to go and look at.',
  affects:
    'Adam, whose Mac it runs on and whose git and tracker identities every agent acts under. His ' +
    'colleagues, whose repositories it reads, whose tickets it ingests, and whose work its beads describe ' +
    'without their taking part. And anyone reading a repository it has merged into afterwards, for whom a ' +
    'commit from an agent and a commit from a person look the same.',
  oversight:
    'Three separations, each a property of the process rather than an instruction to a model. Nothing an ' +
    'agent proposes becomes work without a tap. Nothing an agent writes reaches `main` except through the ' +
    'merge queue, which is a different agent from the one that wrote it. And no agent may change what it is ' +
    'without an amendment a person approved, which is a commit on refs/beadcause/foundations carrying the ' +
    'argument that was accepted. What may leave the Mac is bounded separately and narrowly: hashes, chain ' +
    'heads and metadata, never bead content, prompts or files.',
  limitations:
    'It is one person\'s system on one laptop. There is no multi-user model, no approval quorum, and no ' +
    'way for it to notice that a decision it is asking for is not the asker\'s to make. Its agents behave ' +
    'as the models underneath them behave, and change when those change; its record of what an agent was is ' +
    'exactly as good as the amendment log and no better.',
  // Not `null` by omission. A card that quietly had no model line would read as a system
  // whose model nobody wrote down, which is the opposite of true here.
  model: {
    model: null,
    source: 'per-agent',
    routed: false,
    note: 'beadcause does not run on a model; each of its agents does. See their cards.',
  },
};

/** Every registered system, the system itself first, then the agent kinds. */
export const SYSTEMS = [SYSTEM, ...AGENTS];

/** True for an id this registry can answer for — the system, or one of its agents. */
export const isSystem = (id) => SYSTEMS.includes(id);

/**
 * One system's card, off the baseline — synchronous, and answers for `beadcause` as
 * readily as for any agent.
 *
 * Baseline rather than effective, because this is the one that has to work with no git
 * and no ref: an amendment is a thing a repository has, and a card is a thing the release
 * has. `systemCards` below is the version that layers the approved amendments on, which
 * is what a screen or an auditor wants; this is what a test, a CLI and a boot-time check
 * can rely on.
 */
export function systemCard(id) {
  if (id === SYSTEM) return structuredClone(BEADCAUSE);
  return cardOf(baseline(id)); // throws, by name, on an id that is neither
}

/**
 * Every system's card, with approved amendments applied — the register as it stands in
 * this repository right now.
 *
 * `dir` is any directory in the repo that owns the foundations; a worktree is fine. The
 * system's own card is first and is the same on every machine, because nothing amends it.
 */
export async function systemCards(dir) {
  const foundations = await allFoundations(dir);
  return [structuredClone(BEADCAUSE), ...foundations.map(cardOf)];
}

/**
 * Which cards are missing which fields — empty when the register is complete.
 *
 * The check a suite runs, and the reason it is here rather than only in the test: a
 * seventh agent kind added to `BASELINES` with no card is a registered AI system with no
 * documentation, and the failure should name the field rather than surface as a screen
 * with a blank row on it.
 */
export function registryGaps() {
  const out = [];
  for (const id of SYSTEMS) {
    const card = systemCard(id);
    const missing = CARD_FIELDS.filter((field) => !String(card[field] || '').trim());
    if (missing.length) out.push({ id, missing });
  }
  return out;
}
