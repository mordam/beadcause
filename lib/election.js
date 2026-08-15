/**
 * What this organisation elected to be held to — and therefore what may be enforced.
 *
 * beadcause records unconditionally. The session chain runs, the transitions publish,
 * the control corpus in lib/controls.js ships compiled in. None of that is optional and
 * none of it is switchable, because a record that can be turned off is not a record.
 *
 * *Enforcement* is the other half, and it is the half that can refuse a merge, hold a
 * session shut, or fail a deploy. It is scoped here — to a **declared boundary** and a
 * set of **elected criteria** — and an install that has elected nothing has nothing in
 * scope, so no gate can fire and the whole layer is invisible without ever having been
 * turned off.
 *
 * **This is a scoping rule and not a switch, and the difference is the entire design.**
 * A switch has a default, and a default is either on — in which case every personal
 * install starts refusing merges for a management system nobody asked for — or off, in
 * which case an auditor asking "how do you know these controls operated for the whole
 * observation window" is told the answer was a config key anyone could have edited. A
 * scope has neither problem. There is no `enabled`, no `BEADCAUSE_COMPLIANCE`, and
 * nothing in `~/.config/beadcause/config.json`: the empty election is the empty set, and
 * it is empty because nothing has been added to it rather than because something is off.
 * `test/election.mjs` reads this file and fails it for `process.env` or a config import,
 * which is what keeps the sentence true rather than merely written.
 *
 * **Electing is a recorded transition.** Every write here is a chained commit on
 * `refs/beadcause/election` in the common repo, with the actor, the bead and the
 * justification in the message — the shape lib/foundation.js uses for what an agent is
 * permitted to be, for the same reason. There is no file to edit and no state to set. So
 * `git log refs/beadcause/election` is the history of what this organisation has claimed
 * to be held to, and *when* it started claiming it, which is the question a Type II
 * report is actually about.
 *
 *   git -C ~/.config/beadcause log --format='%aI %s' refs/beadcause/election
 *   git -C ~/.config/beadcause cat-file -p refs/beadcause/election:election.json
 *
 * **Withdrawing is a transition too, and it does not restore innocence.** `withdraw`
 * empties the scope, and from a gate's point of view the install is then exactly the
 * install that never elected anything — that is the promise, and it is kept. What it is
 * not is *indistinguishable*: the transitions stay in the state and the commits stay on
 * the ref, so a period with a gap in it reads as a gap somebody recorded rather than as a
 * quiet quarter. A window nobody can account for is a finding; a window with an
 * accounted-for gap is a scope note. Making the second one cheap is the only way to stop
 * people reaching for the first.
 *
 * **Why this does not import lib/controls.js.** The corpus is the vocabulary — 192
 * records across three frameworks — and it would be one line to reject an id it does not
 * contain. It is deliberately not done, because an election is a record of what was
 * elected *then*, and the corpus is a table that ships with the release. Joining them at
 * read time means a criterion retired or renamed in a later release silently changes what
 * an organisation is on record as having elected, which is the same failure as the
 * flippable switch wearing different clothes. So the id is checked for *shape* here — the
 * framework token is part of it, exactly as the corpus writes it — and resolving a shape
 * to a record is the business of whatever is showing it to somebody. The surface that
 * offers a list to elect *from* should read the corpus and offer only what is in it; that
 * is a check at the point of choosing, not a filter on the record afterwards.
 */
import { ensureRepo } from './commonrepo.js';
import { commitToRef, readRefFile, refHistory, refTip, readMessage, writeTree } from './gitref.js';
import { ownerName } from './owner.js';

export const ELECTION_REF = 'refs/beadcause/election';

/** The one file in the ref's tree. Flat, like every other payload written this way. */
const STATE_FILE = 'election.json';

/**
 * The framework tokens an elected id may carry.
 *
 * The same three lib/controls.js mints, written again rather than imported for the reason
 * in the header. Widening this list is not how a fourth framework arrives — the corpus
 * mints it, and this only has to agree that the token is spellable.
 */
export const FRAMEWORKS = Object.freeze(['SOC2', 'ISO27001', 'ISO42001']);

/** A criterion id: a framework token, then the framework's own local id. */
const ID_RE = new RegExp(`^(?:${FRAMEWORKS.join('|')})\\.[A-Za-z0-9]+(?:\\.[A-Za-z0-9]+)*$`);

/** The four things that can happen to an election, each of them a commit. */
export const ACTIONS = Object.freeze(['declare', 'elect', 'revoke', 'withdraw']);

/**
 * The empty election — no boundary, nothing elected, nothing ever transitioned.
 *
 * This is what a fresh install is, what an install with no ref reads back as, and what
 * every predicate below is asked about first. It is exported so a caller can compare
 * against it by identity in a test rather than reconstructing what "nothing" means and
 * getting it subtly different.
 */
export const NOTHING = Object.freeze({
  boundary: null,
  criteria: Object.freeze([]),
  transitions: Object.freeze([]),
});

const stamp = () => new Date().toISOString();

/* ------------------------------------------------------------- reading it */

/**
 * Everything wrong with a criterion id, as sentences. Empty means it is well-shaped.
 *
 * Shape only — see the header for why this does not ask the corpus whether the id names
 * anything. The framework token is required and is part of the id: `ISO27001.A.5.2` and
 * `ISO42001.A.5.2` are different controls, and an election storing a bare `A.5.2` would
 * be a record whose meaning depended on who read it.
 */
export function criterionProblems(id) {
  const s = String(id ?? '').trim();
  if (!s) return ['a criterion id is required'];
  if (!ID_RE.test(s)) {
    return [
      `"${s}" is not the shape a criterion id has — a framework token (${FRAMEWORKS.join(', ')}) ` +
        'then the framework\'s own id, as `SOC2.CC8.1` or `ISO27001.A.8.32`',
    ];
  }
  return [];
}

/** Everything wrong with a boundary declaration, as sentences. */
export function boundaryProblems(boundary) {
  const problems = [];
  const name = String(boundary?.name ?? '').trim();
  const description = String(boundary?.description ?? '').trim();
  if (!name) problems.push('a boundary needs a `name` — who is being held to this');
  if (description.length < 20) {
    problems.push(
      'a boundary needs a `description` saying what is inside it, in a sentence — ' +
        'the scope statement is the first thing an auditor reads and the last thing anyone writes down'
    );
  }
  return problems;
}

/** Parse stored state into the shape everything below expects, or `NOTHING`. */
function parse(raw) {
  if (!raw) return NOTHING;
  let stored;
  try {
    stored = JSON.parse(raw);
  } catch {
    // The same rule as a corrupt foundation overlay or an unreadable memory: what cannot
    // be read is not held, and the previous version is one `git log` away. Degrading to
    // NOTHING is also the safe direction here specifically — an unparseable election
    // enforces nothing rather than enforcing something nobody can read back.
    return NOTHING;
  }
  const criteria = Array.isArray(stored?.criteria) ? stored.criteria.filter((c) => !criterionProblems(c).length) : [];
  return Object.freeze({
    boundary: stored?.boundary ?? null,
    criteria: Object.freeze([...new Set(criteria)].sort()),
    transitions: Object.freeze(Array.isArray(stored?.transitions) ? stored.transitions : []),
  });
}

/**
 * What this install has elected, right now.
 *
 * Never throws and never blocks: a machine with no common repo, no git, or no ref reads
 * back as `NOTHING`, which is the honest answer and is also the answer that makes every
 * gate stand down. An install that cannot read its own election must not be an install
 * that starts enforcing a guess.
 */
export async function current() {
  try {
    const cwd = await ensureRepo();
    return parse(await readRefFile(cwd, ELECTION_REF, STATE_FILE));
  } catch {
    return NOTHING;
  }
}

/* ----------------------------------------------------------- asking it things */

/**
 * Is there anything at all to enforce?
 *
 * Both halves are required, and that is not belt and braces: criteria elected without a
 * boundary are a list with nothing to be true *of*, and a boundary with nothing elected
 * is an organisation that has said who it is and not yet said what it claims. Neither is
 * a state a gate should fire in.
 */
export const enforcing = (election) => Boolean(election?.boundary) && (election?.criteria?.length || 0) > 0;

/** Is this exact criterion elected? The whole of what a gate needs to know. */
export const elected = (election, criterion) =>
  enforcing(election) && election.criteria.includes(String(criterion ?? '').trim());

/** Everything elected, as a frozen list. `[]` when nothing is. */
export const scope = (election) => (enforcing(election) ? election.criteria : NOTHING.criteria);

/**
 * The one call an enforcement gate makes, and the shape of its answer is the point.
 *
 * `null` means *no opinion* rather than "allowed": a gate that gets null must behave
 * exactly as it did before any of this existed — not warn, not log, not tell the user
 * there is a compliance layer they could turn on. That is what "an install electing
 * nothing sees nothing" reduces to in code, and it is a one-line early return at the top
 * of every gate:
 *
 *   const scope = inScope(await current(), 'SOC2.CC8.1');
 *   if (!scope) return null;   // nothing is claimed here; behave as beadcause always did
 *
 * When it is in scope the caller gets the boundary and the moment it was elected, because
 * a gate that refuses something owes the person in front of it both — "who says so" and
 * "since when" are the two questions a refusal has to be able to answer, and reaching
 * back for them later is how a gate ends up saying only "not permitted".
 */
export function inScope(election, criterion) {
  const id = String(criterion ?? '').trim();
  if (!elected(election, id)) return null;
  const at = [...(election.transitions || [])]
    .reverse()
    .find((t) => t.action === 'elect' && Array.isArray(t.criteria) && t.criteria.includes(id))?.at;
  return Object.freeze({ criterion: id, boundary: election.boundary, since: at || null });
}

/* ------------------------------------------------------------- changing it */

/**
 * Read the state *and* the tip it came from, because a write has to check both.
 *
 * The tip is carried through to `record` and handed to the compare-and-swap rather than
 * re-read there. Re-reading it would make the swap check only "did anyone commit between
 * my two git calls", which is a window of milliseconds, instead of "is this still the
 * state I built my next state out of", which is the window that matters and is however
 * long the caller took to decide. lib/memory.js's `cas` has the same shape for the same
 * reason.
 */
async function readForWrite() {
  const cwd = await ensureRepo();
  const tip = await refTip(cwd, ELECTION_REF);
  return { cwd, tip, prior: parse(await readRefFile(cwd, ELECTION_REF, STATE_FILE)) };
}

/** Write the next state as a commit on the ref. The only way any of this changes. */
async function record({ cwd, tip }, next, subject, body) {
  const tree = await writeTree(cwd, [[STATE_FILE, Buffer.from(JSON.stringify(next, null, 2) + '\n')]]);
  const { commit } = await commitToRef(cwd, ELECTION_REF, tree, [subject, '', body].join('\n'), { expect: tip });
  return { election: parse(JSON.stringify(next)), commit };
}

const transition = (action, { bead, by, justification, criteria = null, boundary = null }) => ({
  at: stamp(),
  action,
  by,
  bead: bead || null,
  ...(criteria ? { criteria } : {}),
  ...(boundary ? { boundary } : {}),
  justification: justification || '',
});

/**
 * Declare the boundary — who is being held to this, and what is inside it.
 *
 * First move, always. Nothing can be elected before there is something for it to be
 * elected *into*, which is why `elect` refuses without one: a criteria list with no
 * boundary is the half-state where a gate could plausibly read as armed while nobody has
 * yet said what it is armed around.
 *
 * Re-declaring is allowed and is a transition of its own. A scope statement that changes
 * — a new entity, a system that grew — is an ordinary thing an organisation does, and
 * forcing it through a withdraw-and-start-again would delete the continuity that is the
 * only reason any of this is on a ref.
 */
export async function declare(boundary, { bead = null, justification = '', by = ownerName() } = {}) {
  const problems = boundaryProblems(boundary);
  if (problems.length) throw new Error(`election: ${problems.join('; ')}`);

  const { cwd, tip, prior } = await readForWrite();
  const declared = {
    name: String(boundary.name).trim(),
    description: String(boundary.description).trim(),
    declaredAt: stamp(),
    declaredBy: by,
  };
  const next = {
    boundary: declared,
    criteria: [...prior.criteria],
    transitions: [...prior.transitions, transition('declare', { bead, by, justification, boundary: declared })],
  };
  return record(
    { cwd, tip },
    next,
    `declare boundary: ${declared.name}${bead ? ` (${bead})` : ''}`,
    `${justification || '(no justification recorded)'}\n\ndeclared by ${by}`
  );
}

/**
 * Elect criteria into the boundary — the transition that makes enforcement possible.
 *
 * Additive and idempotent: electing something already elected is not an error and is not
 * a commit, because a no-op transition in the history is a line an auditor has to read
 * and rule out. Electing nothing new returns the election unchanged with a null commit,
 * and the caller can tell the two apart.
 */
export async function elect(criteria, { bead = null, justification = '', by = ownerName() } = {}) {
  const list = (Array.isArray(criteria) ? criteria : [criteria]).map((c) => String(c ?? '').trim());
  const problems = list.flatMap((c) => criterionProblems(c));
  if (problems.length) throw new Error(`election: ${problems.join('; ')}`);

  const { cwd, tip, prior } = await readForWrite();
  if (!prior.boundary) {
    throw new Error(
      'election: nothing can be elected before a boundary is declared — ' +
        'criteria with no boundary are a list with nothing to be true of'
    );
  }

  const added = [...new Set(list)].filter((c) => !prior.criteria.includes(c)).sort();
  if (!added.length) return { election: prior, commit: null };

  const next = {
    boundary: prior.boundary,
    criteria: [...new Set([...prior.criteria, ...added])].sort(),
    transitions: [...prior.transitions, transition('elect', { bead, by, justification, criteria: added })],
  };
  return record(
    { cwd, tip },
    next,
    `elect ${added.join(', ')}${bead ? ` (${bead})` : ''}`,
    `${justification || '(no justification recorded)'}\n\nelected by ${by}`
  );
}

/**
 * Take criteria back out of scope, one at a time rather than all at once.
 *
 * This is the narrow half of `withdraw` and it exists because the alternative is worse:
 * an organisation that decided the privacy category was not for them after all would
 * otherwise withdraw the whole boundary and re-declare it, which reads in the history as
 * having stopped claiming everything for as long as the two commits are apart.
 */
export async function revoke(criteria, { bead = null, justification = '', by = ownerName() } = {}) {
  const list = (Array.isArray(criteria) ? criteria : [criteria]).map((c) => String(c ?? '').trim());
  const { cwd, tip, prior } = await readForWrite();
  const removed = list.filter((c) => prior.criteria.includes(c)).sort();
  if (!removed.length) return { election: prior, commit: null };

  const next = {
    boundary: prior.boundary,
    criteria: prior.criteria.filter((c) => !removed.includes(c)),
    transitions: [...prior.transitions, transition('revoke', { bead, by, justification, criteria: removed })],
  };
  return record(
    { cwd, tip },
    next,
    `revoke ${removed.join(', ')}${bead ? ` (${bead})` : ''}`,
    `${justification || '(no justification recorded)'}\n\nrevoked by ${by}`
  );
}

/**
 * Stop claiming anything at all — the boundary and everything elected into it.
 *
 * From a gate's point of view this is a return to the install that never elected
 * anything, and that is the promise the whole design rests on. From the history's point
 * of view it is nothing of the sort: the transitions and the commits are still there, so
 * the period after it is a *stated* gap. Both are true at once and neither is a
 * compromise — the first is what makes the layer optional, the second is what stops
 * optional meaning deniable.
 *
 * The justification carries the weight here, which is why it is required and is not
 * required by the others: withdrawing is the transition an auditor reads first, and "(no
 * justification recorded)" against it is a sentence nobody can do anything with.
 */
export async function withdraw({ bead = null, justification = '', by = ownerName() } = {}) {
  const reason = String(justification || '').trim();
  if (reason.length < 20) {
    throw new Error(
      'election: withdrawing needs a justification, in a sentence — ' +
        'it is the transition an auditor reads first, and an unexplained one is a finding'
    );
  }

  const { cwd, tip, prior } = await readForWrite();
  if (!prior.boundary && !prior.criteria.length) return { election: prior, commit: null };

  const next = {
    boundary: null,
    criteria: [],
    transitions: [
      ...prior.transitions,
      transition('withdraw', {
        bead,
        by,
        justification: reason,
        criteria: prior.criteria.length ? [...prior.criteria] : null,
        boundary: prior.boundary,
      }),
    ],
  };
  return record(
    { cwd, tip },
    next,
    `withdraw${prior.boundary ? `: ${prior.boundary.name}` : ''}${bead ? ` (${bead})` : ''}`,
    `${reason}\n\nwithdrawn by ${by}`
  );
}

/* ------------------------------------------------------------- reading it back */

/**
 * The transitions as commits, newest first, each with its justification.
 *
 * The stored `transitions` list and this answer the same question from opposite ends and
 * both are worth having: the list is what the current state was built out of and travels
 * with it, and this is the chain — where a rewrite shows up as a broken parent rather
 * than as an array somebody edited.
 */
export async function history({ limit = 50 } = {}) {
  let cwd;
  try {
    cwd = await ensureRepo();
  } catch {
    return [];
  }
  const commits = await refHistory(cwd, ELECTION_REF, { limit });
  const out = [];
  for (const c of commits) out.push({ ...c, message: await readMessage(cwd, c.commit) });
  return out;
}
