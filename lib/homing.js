/**
 * Where a bead nobody gave a parent lands — the other half of lib/underroot.js.
 *
 * bc-rfnr.8. That file is the rule: a bead that is not a root and has no root above it is
 * not workable, no advocate queues it and no launcher opens a session on it. This one
 * is what stops the daemon filing beads that are born failing it.
 *
 * **The failure, and why the pill is not enough.** A live sweep on the day bc-rfnr.7
 * landed found four cards from lib/notinmain.js — "never reached main, and <bead> is
 * closed over it" — sitting parentless, and they had to be adopted by hand before the
 * gate could be switched on. The next sweep files another one in exactly the same
 * state, and so does anything else that files without a parent. Two things are wrong
 * with such a bead and only one of them is on the agents screen:
 *
 * 1. It is **held**, which the advocate says out loud — a log line, a bus event and a
 *    `nothing decided above this` pill on its card (lib/underroot.js).
 * 2. It is **invisible**, which nothing says at all. bc-rfnr.2's inbox draws only what
 *    descends from a root you own (`underOwnedRoots` in public/app.js), so a `human` card
 *    filed with no parent is not on the phone — and a `human` card is a *question*. The
 *    whole of this app is the promise that a question cannot be lost, and a card the
 *    daemon writes to a screen that will not draw it is that promise broken from
 *    inside. This is the half a pill on the agents screen cannot reach.
 *
 * ## What was decided
 *
 * bc-rfnr.8 offered three ways and asked for one rather than a patch at one caller:
 * parent at the filing seam, adopt orphans into the unsorted-backlog root, or leave it as
 * something you tidy. The third fails (2) above. The first two are not alternatives —
 * they are the two arms of one answer, and this file is both:
 *
 * **The home is the root the *discovering* bead descends from — not the discovering bead
 * itself.** `from` is already on every agent-filed bead as a `discovered-from` edge, so
 * the daemon almost always knows which work turned this up; what it must not do is turn
 * that edge into a parent link. Two reasons, and the second is the one that bites:
 *
 * - lib/ancestry.js is explicit that a `discovered-from` trail must not pull a bead into
 *   a root's descendants, because lib/filing.js puts one on everything an agent has ever
 *   filed. Writing the same relationship a second time as a `parent-child` edge is that
 *   rule defeated by the file it was written against.
 * - A task closes. bc-rfnr.7's own comment names the recurring shape — an open child of
 *   a non-root parent that has since closed is under nothing, is not parentless by any
 *   obvious query, and is held forever. Parenting every discovery under the task that
 *   found it would *manufacture* that shape on a schedule. A root closing is the end of an
 *   epic, which is the honest moment for what hangs off it to stop being work.
 *
 * **When there is no such root, the unsorted-backlog root adopts it**, found by the
 * `unsorted` label on an open root rather than by an id in config. A label for
 * lib/ownership.js's reason: config.json is per-Mac and this graph is shared, so an id
 * in a settings file would name a different bead — or nothing — on the second machine,
 * and the whole point is that a bead lands somewhere real on whichever machine filed it.
 *
 * **Except for the callers that must not fill it** — `unsorted: false`, and lib/release.js
 * is the one that made it necessary. A ship bead is filed per merge, closes itself when
 * the deploy lands, and carries `unendorsed` so nothing ever opens a session on it; thirty
 * a week of those in the backlog is the pile that means "somebody has to decide where this
 * goes" filled with rows nobody will ever decide anything about. See `homeFor`.
 *
 * **Nothing here refuses, and nothing here falls back to a *wrong* home.** No `from`, a
 * `from` under nothing itself, no unsorted root, a graph that could not be read: the
 * answer is no parent, which is exactly the bead that would have been filed before this
 * existed. The pill and the sheet's adopt control (public/graph.js) are still there for
 * that bead. Fail-open is lib/underroot.js's decision and this inherits it wholesale — a
 * filing seam that threw would turn a Dolt lock race into a discovery nobody kept.
 *
 * **But fail-open is not fail-silent, which is bc-0i27.17.** Three of those four are a
 * decision — no `from`, a `from` under nothing, no unsorted root — and one is an accident:
 * an export that could not be read is not "there is no home for this", it is "we could
 * not look", and the two arrived as the same `{ parent: '', gated: false }` with the
 * second saying nothing at all. Nothing downstream could tell them apart either, so a
 * bead born held and invisible was reported as a success. The reason now rides the
 * index from lib/bd.js and comes out on `error` — see `homeIn`. Everything above about
 * refusing is unchanged; only the silence is.
 */
import { ancestorsOf } from './ancestry.js';
import { isRoot } from './ownership.js';
import { rootsOf } from './underroot.js';
import { isHoldBead } from './redbase.js';

/**
 * The label on the root that adopts what has no home. One spelling, and it is a label.
 *
 * `unsorted` rather than `catchall` because the tracker already distinguishes the two and
 * only one of them is this: the unsorted backlog is where a bead goes when *nobody has
 * decided* where it goes, and the answer to a bead sitting in it is usually "file this
 * under the epic it actually belongs to". That is precisely the state a bead the daemon
 * filed unattended is in. A catchall for work that has been looked at and genuinely has
 * no other home is a different pile, and one that filled itself automatically would stop
 * being it.
 */
export const UNSORTED_LABEL = 'unsorted';

/**
 * The root this bead descends from, or null — `hasRootAbove` answering *which*.
 *
 * A root is above itself, matching lib/underroot.js, so asking this of a root answers it.
 * The nearest one wins on the vanishingly rare graph that has two in one line.
 *
 * **`includeSelf: false` is the one exception, and it exists only for `homeFor`'s call
 * on a self-closing root (bc-mwhkg.2) — every other caller wants the default.** Pass it
 * and the walk starts at `id`'s parent rather than at `id`, so a root that is itself the
 * bead in question is skipped rather than answered.
 *
 * **A red-base hold is skipped wherever it appears in the chain, and this is bc-beleq.2.**
 * A hold bead (lib/redbase.js) is a P0 with no parent, so it *is* its own root — and
 * before this, a worker filing `--from <the hold>` (following the ordinary "found more
 * work, file it" instruction while working the hold itself) landed the new bead as the
 * hold's direct child. bd refuses to close any bead with open children, and `sweepBase`
 * closes the hold with `overClaim` (which lifts the claim guard, not the children guard)
 * the moment the base is green — so that close is refused forever, over a base that is
 * already fixed, and the merge queue holds every branch in the repo behind a log line
 * nobody is watching. A hold bead's own close is not a person finishing work; it is a
 * sweep lifting a standing condition, and nothing should ever be parented under it. So a
 * step that is a hold is skipped exactly like one that fails `roots.has` — the search
 * keeps climbing past it — and falls out to `null` when (as today) it has no ancestor of
 * its own, which sends `homeFor`'s caller on to the unsorted-backlog root instead.
 *
 * **The two exceptions are deliberately separate and both apply**, which is the shape the
 * downmerge of bc-beleq.2 onto bc-mwhkg.2 settled on rather than a choice between them:
 * `includeSelf` is decided by the caller and only ever about `id` itself, while the hold
 * skip is a property of the bead and holds anywhere above it. Collapsing them into one
 * predicate would be a decision about what "a root that must not adopt" means, and
 * neither bead made it.
 */
export function rootOver(index, id, { includeSelf = true } = {}) {
  const key = String(id || '').trim();
  if (!key) return null;
  const roots = rootsOf(index?.beads);
  if (!roots.size) return null;
  const chain = includeSelf ? [key, ...ancestorsOf(index?.parents, key)] : ancestorsOf(index?.parents, key);
  for (const step of chain) {
    if (!roots.has(step)) continue;
    if (isHoldBead(index?.beads?.get?.(step))) continue;
    return step;
  }
  return null;
}

/**
 * The label on a root whose own close does not wait on its children — bc-mwhkg.2.
 *
 * **A literal, not an import of `ERROR_LABEL` from lib/errors.js**, and that is the
 * decision rather than an oversight: lib/errors.js imports lib/filing.js (`beadToIssue`,
 * `DISCOVERED_FROM`), and lib/filing.js imports this file for `homeIn` — so importing
 * lib/errors.js here would close `homing.js → errors.js → filing.js → homing.js` into a
 * cycle, exactly the shape test/loadorder.mjs exists to catch. `'app-error'` is stable —
 * lib/errors.js's own comment calls it "the class label", and lib/epicadvocate.js's
 * `isCrash` already asserts the identical string rather than importing it into a module
 * with no such risk. test/homing.mjs pins this against `ERROR_LABEL` directly, so a
 * rename on either side fails loudly here rather than silently reopening the bug below.
 *
 * **Why this needs its own name at all.** `rootOver` counting a root as above itself is
 * right for an epic — it stays open until its children land, so parenting a discovery
 * under it is safe. It is wrong for an app-error P0: lib/errors.js files one
 * automatically, its acceptance criterion is "the error stops being reported", and it
 * closes the moment the fix ships with no regard for anything a session discovered while
 * reading it. Filing under one strands the child the instant it closes
 * (lib/rootclose.js) — measured on bc-mwhkg itself, whose own children (bc-mwhkg.1 and
 * this bead) landed exactly there.
 */
const SELF_CLOSING_ROOT_LABEL = 'app-error';

/** Is `id` a root whose close does not wait on it having no children? See the label above. */
function isSelfClosingRoot(index, id) {
  const key = String(id || '').trim();
  if (!key) return false;
  const bead = index?.beads?.get?.(key);
  return !!bead && isRoot(bead) && (bead.labels || []).some((l) => String(l).trim() === SELF_CLOSING_ROOT_LABEL);
}

/**
 * The open root carrying a label, or null — how every home here is named.
 *
 * **A label rather than an id in config, and that is the decision rather than the
 * implementation.** config.json is per-Mac and this graph is shared, so an id in a
 * settings file names a different bead — or nothing — on the second machine. A label
 * travels with the graph, so the same epic answers on whichever machine filed the bead.
 *
 * **Roots only**, which is also what makes it safe to reuse a label that is already on
 * the work. `self-started-skills` is on every skill candidate as well as on the epic
 * that owns them (bc-dgx7 says so in as many words), and `unsorted` is inherited by
 * every child of the backlog — neither of those is a root, so neither can be mistaken
 * for the home.
 *
 * **Two of them is not an error here.** Labels are rows on a graph several machines write
 * to (lib/ownership.js makes the same argument for `owner:`), so a second one can exist
 * without anybody having decided anything. Sorting and taking the first makes every
 * machine pick the same one until somebody takes the label off, which is a duplicate you
 * can find rather than two daemons quietly filing into different piles.
 */
export function rootLabelled(index, label) {
  const want = String(label || '').trim().toLowerCase();
  if (!want) return null;
  const found = [];
  for (const id of rootsOf(index?.beads)) {
    const bead = index?.beads?.get?.(id);
    if ((bead?.labels || []).some((l) => String(l).trim().toLowerCase() === want)) found.push(id);
  }
  return found.sort((a, b) => String(a).localeCompare(String(b), 'en', { numeric: true }))[0] || null;
}

/** The open root that adopts orphans, or null. `rootLabelled` for the backlog's own label. */
export function unsortedRoot(index) {
  return rootLabelled(index, UNSORTED_LABEL);
}

/**
 * Where this bead should land, over an index already in hand.
 * `{ parent, why, gated, error }` — `error` copied off the index rather than decided
 * here: lib/bd.js stamps the empty stand-in it invents when a `bd export` could not be
 * read, and an index that genuinely answered carries nothing. See `homeIn` for what it
 * is for. An index built from real rows always answers `''`.
 *
 * `parent` is `''` when there is no honest answer, and `why` is the phrase a log line or
 * a provenance note prints — empty in that case too, because "could not find a home" is
 * the caller's fact to report and not this function's opinion.
 *
 * **`gated` is what stops a caller lying on the way out.** With no parent found, whether
 * the bead is actually held depends on something this answer does not otherwise carry:
 * `hasRootAbove` fails *open* on a workspace with no open root at all, so on a tracker that
 * has never raised one — or one whose export could not be read — a parentless bead is
 * perfectly workable. A warning saying "nothing will work this until you adopt it under
 * an epic" would then be a false claim printed at every single filing, which is a worse
 * failure than the silence it replaced. True means there are roots and the gate is live.
 *
 * An explicit `parent` always wins and is handed straight back. A caller that named one
 * has decided something; this file exists for the callers that have not.
 *
 * **`homeLabel` is for a caller whose beads all belong to one programme, and it is
 * bc-khoe.48.** The rule above — the root the *discovering* bead descends from — is the
 * right default precisely because it is the only thing the daemon knows about a
 * discovery. It is the wrong answer for a seam that files the same *kind* of bead every
 * time: lib/sessionaudit.js files skill candidates, evidenced by whichever sessions
 * happened to run that day, so for four months every candidate landed under whichever
 * epic was busiest that hour. Thirty-seven of them ended up spread over twelve unrelated
 * epics — each one counted against a theme it had nothing to do with, and each one ahead
 * of that theme's own work in `byPickOrder`, because the tiebreak below priority is
 * `created_at` and a burst filed at midnight can never fall behind. Such a caller names
 * the label its home epic carries and gets that epic instead of the accident.
 *
 * It sits *above* `from` and *below* an explicit `parent` for the reason both of those
 * are where they are: naming a label is the caller saying "these are all one thing",
 * which is a stronger claim than "this is what turned it up" and a weaker one than a
 * parent the caller worked out per bead. **And it falls through rather than refusing** —
 * no root carries the label, and the answer is exactly what it was before, which is what
 * makes pointing a seam at a home that has not been raised yet a no-op rather than a
 * pile of orphans.
 *
 * **`unsorted: false` is for a bead the backlog must not collect.** That pile is done
 * when it is empty, and being in it is a question — *which epic does this belong to?* — so
 * it works only while everything in it is a bead somebody could answer that about. A
 * caller filing on a schedule, over beads that settle themselves and that nothing will
 * ever open a session on, is not asking that question thirty times a week; it is burying
 * the beads that are. Such a caller says so here and gets `''` where the root is not
 * knowable — which is the parentless bead it filed before, and for a bead no queue
 * carries (see `UNENDORSED` in lib/endorse.js) the gate that would otherwise hold it is
 * not holding anything. Every other caller files work a person will one day pick up, and
 * for those the backlog is the right answer: a pile you can see beats an orphan nothing
 * draws.
 *
 * **`from` itself is skipped when it is a self-closing root — bc-mwhkg.2.** "The root the
 * discovering bead descends from" is `from` itself whenever `from` is already a root
 * (`rootOver` counts a root as above itself), which is exactly right for an epic and
 * exactly wrong for an app-error P0 (see `SELF_CLOSING_ROOT_LABEL`). For that population
 * the walk starts one step up instead, landing on the next root above — or, having none,
 * falling through to the unsorted pile like any other `from` with nothing above it. The
 * `discovered-from` edge back to `from` is untouched either way; only the parent moves.
 */
export function homeFor(index, { parent = '', from = '', unsorted = true, homeLabel = '' } = {}) {
  const gated = rootsOf(index?.beads).size > 0;
  // Not a reading of the tracker at all — lib/bd.js stamps its stand-in with why. An
  // index that answered carries nothing here, including a stale one, which is a real
  // reading whose roots are real.
  const error = String(index?.error || '').trim();
  const named = String(parent || '').trim();
  if (named) return { parent: named, why: '', gated, error };

  const home = rootLabelled(index, homeLabel);
  if (home) {
    return { parent: home, why: `${home}, the ${String(homeLabel).trim()} epic`, gated, error };
  }

  const overFrom = rootOver(index, from, { includeSelf: !isSelfClosingRoot(index, from) });
  if (overFrom) return { parent: overFrom, why: `${overFrom}, the root ${String(from).trim()} belongs to`, gated, error };

  if (!unsorted) return { parent: '', why: '', gated, error };
  const pile = unsortedRoot(index);
  if (pile) return { parent: pile, why: `${pile}, the unsorted backlog`, gated, error };

  return { parent: '', why: '', gated, error };
}

/**
 * What is said when the export fails and the caller named no channel of its own.
 *
 * The daemon log, in the shape every other unattended failure here takes
 * (`[module] could not …`), because that is where the seven callers that are not
 * `fileBeads` report — an advocate tick, a merge sweep, a crash card. A silent default
 * would be the bug this exists to close, one layer down: `homeIn` cannot know whether
 * its caller inspects `error`, and seven of the eight destructure `{ parent }` alone.
 */
const logWarn = (msg) => console.error(`[homing] ${msg}`);

/**
 * The same question, over a tracker. Never throws, and `''` is a complete answer.
 *
 * `wait: true` (the default) where the inbox's own sweep uses `wait: false`, and for
 * `assertUnderRoot`'s reason: this is on a write path, once per bead filed, and a caller
 * about to create a row that outlives the process can afford ~1.3s to put it in the
 * right place. The request path cannot, which is why the two disagree on purpose.
 *
 * A caller with no `bd`, or one whose workspace could not be exported, gets `''` — the
 * bead is filed exactly as it would have been before this existed. See the header.
 *
 * **`error` is the floor under that fail-open, and bc-0i27.17 is why it had to exist.**
 * `gated: false` has two causes that a caller cannot tell apart and must not treat the
 * same: *there are no roots in this workspace*, where a parentless bead is perfectly
 * workable and a warning would be a lie printed at every filing — and *we could not
 * look*, where there may be twenty and the bead is being filed held and off the inbox.
 * Observed for real: three `bin/file.js` calls minutes apart in one session, same
 * inputs, and the two whose `bd export` did not answer landed with no parent and
 * printed **nothing at all**. Worse, that is not a rare case but a correlated one — the
 * export fails when Dolt is loaded, which is when twenty sessions are filing.
 *
 * **The failure does not arrive here as a throw, and expecting one is why the hole
 * stayed open.** `Bd.graph` deliberately never throws — it logs, and hands back the
 * last good index or an empty one, so that the inbox and the dispatch gate stay
 * reachable. An empty index is a graph with no roots in it, which is precisely the
 * *other* cause, and the `catch` below never ran in production for a single one of the
 * beads that went missing. So the fact travels on the index itself: lib/bd.js stamps
 * the stand-in it invents with `error`, `homeFor` carries it through, and `''` here
 * means the tracker genuinely answered — including a stale answer, which is a real
 * reading whose roots are real.
 *
 * The read is still not fatal — a filing seam that threw would turn a lock race into a
 * discovery nobody kept, which the header argues for and this does not touch. What
 * changes is that the failure is now *said*, once, through `onWarn`: the caller's own
 * channel where it has one (`fileBeads` hands its warnings to `beadcause-file`, which
 * is what the filing session actually reads), the daemon log otherwise.
 *
 * A caller with no `graph` at all gets no warning and no `error`, deliberately: nothing
 * was attempted and nothing failed. That is a caller with no tracker to ask — a fixture,
 * or lib/release.js's shape before it had one — not a tracker that refused to answer.
 */
export async function homeIn(
  bd,
  workspace,
  { parent = '', from = '', unsorted = true, homeLabel = '', onWarn = logWarn } = {}
) {
  const named = String(parent || '').trim();
  if (named) return { parent: named, why: '', gated: false, error: '' };
  if (typeof bd?.graph !== 'function') return { parent: '', why: '', gated: false, error: '' };
  let home;
  try {
    home = homeFor(await bd.graph(workspace), { from, unsorted, homeLabel });
  } catch (err) {
    // Belt as well as braces: `Bd.graph` does not throw (it stamps the index instead),
    // but this is the one call here that reaches a tracker and a caller may hand in any
    // object with a `graph`. Both arms end in the same answer and the same sentence.
    home = { parent: '', why: '', gated: false, error: String(err?.message || err).split('\n')[0] };
  }
  // `!parent` as well, so the sentence can never be printed over a bead that did get
  // one. It cannot happen from lib/bd.js — the index it stamps is the empty one — but
  // `error` is carried out of every arm of `homeFor`, and a warning that contradicts
  // the answer beside it is the shape of thing that gets believed over the answer.
  if (home.error && !home.parent) {
    onWarn(
      `could not read ${workspace?.name || 'the tracker'} to find a home — ${home.error}. ` +
        'Filing with no parent: if this workspace has an open root the bead is held by bc-rfnr.7 ' +
        'and off the inbox until you adopt it.'
    );
  }
  return home;
}
