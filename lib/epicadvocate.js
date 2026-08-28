/**
 * The Epic Advocate — one agent per owned epic, and everything it knows written on the bead.
 *
 * bc-jk4m made the epic worker a planner and a supervisor: it decides which children
 * should exist, groups them for child-workers, writes their prompts, and argues them
 * through approval, merge and release. This file gives that a name and a row in the
 * roster — `epic-advocate`, a fifth kind in lib/foundation.js's BASELINES rather than a
 * mode of the per-repo advocate.
 *
 * **Why a fifth kind and not a mode.** The two answer different questions and the
 * difference is in their permissions, not their code path. lib/advocate.js is `writes:
 * false` on a deliberate argument — it may not invent work, because it is arguing about
 * a queue nobody has agreed to. This one is `writes: true`, because an epic somebody *owns*
 * has already been agreed to and decomposing it is what planning is. A mode would have
 * had to carry both permissions and pick between them at runtime, which is the shape
 * where a bug grants the wider one. A kind also gets what a mode cannot: a foundation
 * you can amend, its own row on the agents screen, and its own mark — so "which advocate
 * said this" is answerable from a pill rather than by opening the conversation.
 *
 * **It is re-entrant, and that is a constraint rather than a detail.** bc-jk4m already
 * argues that a supervisor holding a worker slot for the life of an epic is both
 * expensive and reaped by `workerTimeoutMinutes`. So this agent is opened on child
 * events, does one turn of thinking, writes down what it concluded, and exits. Which
 * means **everything it knows has to be on the epic bead**: the plan (lib/plan.js already
 * writes one, in a comment, and `readPlan` reads it back), and the one sentence this file
 * adds — what the epic is waiting on.
 *
 * That sentence is not decoration. An epic that has not moved in a week and one quietly
 * progressing are identical from outside, and the inbox card bc-rfnr.2 draws has a slot
 * for exactly this. It is stored the way lib/superseded.js stores its own fingerprint —
 * an HTML comment marker in the notes — because notes survive a claim, a reopen and a
 * sync, and because a label cannot hold a sentence.
 */
import { ERROR_LABEL } from './errors.js';
import { debriefBrief, notesBrief } from './memory.js';
import { isRoot, ownerOf } from './ownership.js';
// bc-jvt0.4/bc-jvt0.6: the childless branch of the brief names the label the "one job"
// answer carries and the floor its reason has to clear, so the two writers of that
// document — this brief and bin/plan.js's own validateWhole — cannot drift. It no longer
// hands over the raw markers to retype (bin/beadcause-epicplan writes and validates the
// document itself now); lib/plan.js imports nothing of this file's, so there is no cycle.
import { MIN_WHY_CHARS, WHOLE_LABEL } from './plan.js';
import { REQS_OPEN, REQS_CLOSE, candidateId, readRequirements } from './beadreqs.js';
import { gleanSection } from './reqglean.js';
import { namesBead } from './reap.js';

/** The kind, as lib/foundation.js keys it. One spelling, because agent ids are on disk. */
export const EPIC_ADVOCATE = 'epic-advocate';

/**
 * Where the advocate writes what its epic is waiting on, and how it finds it again.
 *
 * A marked block in `notes` rather than a field, for lib/plan.js's reason: bd has no
 * field for it, and the two candidates that exist are both worse. `design` is the
 * author's, and a `human` label would put the epic in the inbox as a question — which it
 * is not; it is a status line under a card.
 */
export const WAITING_OPEN = '<!-- beadcause:waiting -->';
export const WAITING_CLOSE = '<!-- /beadcause:waiting -->';

/** How much of a sentence the card can draw. Two lines on a four-inch screen. */
export const WAITING_MAX = 160;

/**
 * One line, held to `WAITING_MAX` — the single place the limit is applied, and the reason
 * this is a function rather than a `.slice` in `waitingBlock`.
 *
 * bc-zjab.5: the limit used to live only in `waitingBlock`, which is the write path
 * **nothing takes**. An Epic Advocate does not emit a block — it is composing a whole
 * notes field around the markers and writes it by hand through `bd update <epic>
 * --notes`, so the slice was never reached, and `waitingOn` did not truncate on read
 * either. Measured on bc-y3qk 2026-08-18: 942 characters, 5.9x the cap, written by four
 * consecutive visits and drawn in full every time. That is the same shape as bc-zjab.1 —
 * a rule that exists, is right, and is enforced only where nobody goes, so compliance is
 * accidental and non-compliance is silent.
 *
 * So the cap moved to where the sentence is *read*, which is a path every drawing of it
 * takes whoever wrote the block and however long ago. `waitingBlock` still calls this, so
 * the two paths cannot drift.
 *
 * **It ends in an ellipsis rather than stopping mid-word**, and the whole thing still
 * fits in `WAITING_MAX`. A sentence that simply stops reads as a bug in the card; one
 * that trails off reads as a sentence somebody wrote too long, which is what happened.
 */
export function waitingLine(text) {
  const line = String(text || '').replace(/\s+/g, ' ').trim();
  if (line.length <= WAITING_MAX) return line;
  return `${line.slice(0, WAITING_MAX - 1).trimEnd()}\u2026`;
}

/** The block, as it goes into `notes`. Empty text erases it rather than writing a hollow one. */
export function waitingBlock(text) {
  const line = waitingLine(text);
  return line ? `${WAITING_OPEN}\n${line}\n${WAITING_CLOSE}` : '';
}

/**
 * What this epic is waiting on, off the row the sweep already has. `null` when nothing
 * has said.
 *
 * Null rather than a cheerful default, because the card draws nothing where this is null
 * and a placeholder would be a claim: "not waiting on anything" is a thing only an
 * advocate that has looked can say, and until one has, the honest card is one line
 * shorter.
 *
 * **Held to `WAITING_MAX` here, not only where it is written** (bc-zjab.5). The block is
 * written by an agent typing a whole notes field into `bd update`, so no code of ours is
 * on that path and nothing there can be made to enforce anything; the read is the one
 * place every drawing of the sentence goes through. Truncating here is also what makes
 * the fix retroactive — the 942-character blocks already sitting in notes stop rendering
 * as paragraphs the moment this ships, without an advocate having to visit each epic.
 *
 * **Right for every caller**, which was the question worth asking before putting a lossy
 * step on a read. There are three. `lib/server.js` puts it on the epic card, which is the
 * screen the cap was chosen for. `isEnrolled` and `advocacyOn`'s `by` use it as a boolean,
 * and truncation cannot turn a non-empty line empty, so neither can change answer. And the
 * one caller that would have made this wrong does not exist: `epicAdvocatePrompt` takes
 * `waiting` as an argument and `openEpicAdvocateSession` never passes one, so the advocate
 * is never handed a shortened version of its own sentence to revise — it reads the block
 * off the bead itself, in full, and is now told the number instead.
 */
export function waitingOn(issue) {
  const notes = String(issue?.notes || '');
  const from = notes.indexOf(WAITING_OPEN);
  if (from < 0) return null;
  const to = notes.indexOf(WAITING_CLOSE, from);
  const body = to < 0 ? notes.slice(from + WAITING_OPEN.length) : notes.slice(from + WAITING_OPEN.length, to);
  return waitingLine(body) || null;
}

/**
 * Should this bead have an advocate of its own?
 *
 * Three noes, and each is a bead this agent would be wrong about rather than a case it
 * cannot handle:
 *
 * - **It is not a root, or nobody owns it.** A root is an epic at any priority, or a P0
 *   (`isRoot`, lib/ownership.js) — and until bc-htoy it was a P0 and nothing else, which
 *   meant the only way to have an advocate manage a piece of work was to claim it was
 *   the most urgent thing on the tracker. An advocate is also answerable *to* somebody;
 *   one opened on an unowned root has nobody to report to and would be planning work the
 *   user has not agreed to carry. An unowned root is bc-rfnr.5's to fix, not this one's.
 * - **It is closed.** Nothing left to plan, and the same argument lib/stillopen.js makes
 *   at the launcher door: the planner's last act is to reopen its epic so the queue can
 *   see the plan, so one opened on a root that closed mid-survey would resurrect it.
 * - **It is a crash.** lib/errors.js files every daemon crash at P0 by construction, and
 *   a stack trace is not an epic. It gets an owner and a place at the top of the board —
 *   which is the point, the thing that just broke is the first thing on the screen — and
 *   it stays a leaf that is workable directly. A planning agent spun up for a stack
 *   trace is the failure bc-rfnr.4 exists to prevent. This is the branch that carries
 *   the whole cost of widening `isP0` to `isRoot` rather than replacing it: crash beads
 *   are P0 *tasks*, so they are still roots, and they are still turned away here.
 *
 * **A P1 task with an owner is still not advocatable**, which is the shape test/handoffdoor.mjs
 * pins. The widening is to epics, not to everything somebody put their name on: a task is
 * a leaf a worker does, and an advocate opened on one would be a planner with nothing to
 * decompose.
 *
 * `isCrash` reads `app-error`, the label lib/errors.js puts on every bead it files —
 * a marker that already exists and is already the answer to "did the app file this
 * itself", rather than a second one meaning the same thing. Injectable so a test can
 * drive the branch without building an error bead, but the default is the real check
 * and the daemon never overrides it.
 */
export const isCrash = (issue) => (issue?.labels || []).some((l) => String(l).trim() === ERROR_LABEL);

export function wantsAdvocate(issue, { crash = isCrash } = {}) {
  if (!isRoot(issue)) return false;
  if (String(issue?.status || '').toLowerCase() === 'closed') return false;
  if (!ownerOf(issue)) return false;
  return !crash(issue);
}

/**
 * The label that says this epic's advocate is paused — no more windows under it until
 * somebody takes it off.
 *
 * **A label and not a marked block in `notes`**, which is the opposite of the choice
 * `WAITING_OPEN` makes three functions up, and the difference between the two facts is
 * the whole reason. A waiting-on sentence is *prose*: it has to hold a clause a person
 * wrote, so it needs a field that can hold one, and only the advocate writes it. A pause
 * is a **boolean somebody toggles from a phone**, and `bd label add` is one atomic
 * operation where writing into `notes` is a read, a concatenate and a write — with the
 * advocate's own rewrite of its waiting-on block landing in the middle of it. A toggle
 * that occasionally erases the sentence that keeps the epic enrolled would un-advocate the
 * epic as a side effect of pausing it, which is the one failure this feature must not
 * have.
 *
 * On the bead rather than in `advocates.json` (Adam's call, 2026-08-15): it rides the
 * shared graph, so it survives a daemon restart, survives losing the state file, is
 * readable from the phone and from another Mac, and — the argument lib/reenter.js makes
 * about enrolment — the button and the sweep cannot disagree about it, because neither
 * of them is holding it.
 */
export const PAUSED_LABEL = 'advocate-paused';

/**
 * The label that says somebody put an advocate on this epic — **the assignment itself**.
 *
 * Until bc-r2b5.1 the only record of an assignment was the advocate's own waiting-on
 * block, written by the last thing every window is told to do before it exits. That made
 * the enrolment a *consequence* of a window having survived long enough to write a
 * sentence, and lib/reenter.js's header says the cost out loud: a window that died first
 * never enrolled its epic, nothing ever came back, and a second tap was needed. On
 * 2026-08-17, 10 of 40 open epics carried the block.
 *
 * So the tap is the assignment now, and it is recorded at the launch — by
 * `POST /api/bead/advocate` and by the sweep's own launch, both of which stamp this the
 * moment a window is up. Written *after* the launch rather than before it, because the
 * launch has four refusals in front of it (`openEpicAdvocateSession`) and an epic enrolled
 * by a launch that was refused would be one the sweep re-argued every three hours forever.
 *
 * **A label, on `PAUSED_LABEL`'s argument two functions up**, and it is the same argument
 * twice over. It is a *boolean somebody toggles*, so `bd label add` is one atomic write
 * where writing into `notes` is a read, a concatenate and a write — with the advocate's own
 * rewrite of its waiting-on block landing in the middle of it, which is precisely the
 * lost-write that would un-assign an epic as a side effect of enrolling it. And it is on
 * the bead rather than in `advocates.json` for lib/reenter.js's three stated reasons: it
 * survives a restart and losing the state file, it is readable from a phone and from
 * another Mac, and the button and the sweep cannot disagree about who is enrolled because
 * neither of them is holding the fact.
 *
 * **Taking it off is the un-assign**, exactly as erasing the sentence was — and since both
 * carriers enrol (see `isEnrolled`), an advocate that concludes its epic needs no more
 * supervision has to take off both. `epicAdvocatePrompt` says so in as many words, because
 * an off switch nothing is told about is an off switch nobody presses.
 */
export const ADVOCATE_LABEL = 'advocate-assigned';

/** Has somebody put an advocate on this epic? Off `labels`, which every caller already has. */
export const isAssigned = (issue) =>
  (issue?.labels || []).some((l) => String(l).trim() === ADVOCATE_LABEL);

/**
 * Is this epic enrolled — does the re-entry sweep bring a window back to it?
 *
 * **The label *or* the sentence, and the `or` is what makes this landable.** Every epic
 * enrolled today carries a waiting-on block and nothing else; a rule that read only the
 * label would un-enrol all ten of them on the deploy that shipped it, silently, and the
 * only symptom would be windows that stopped coming. So the old carrier goes on counting,
 * and the new one is what an epic gains the next time anything launches on it.
 *
 * It is deliberately *not* `isAssigned` alone even in the long run. The two facts are
 * genuinely different — "somebody assigned this" and "an advocate has been here and left
 * a sentence" — and an epic with either one is an epic something is supposed to come back
 * to.
 */
export const isEnrolled = (issue) => isAssigned(issue) || Boolean(waitingOn(issue));

/**
 * Is this epic's advocate paused?
 *
 * Read off `labels`, which every row this is asked about already carries: `bd.graph`
 * keeps them, `assignedAdvocates` passes them through to the roster, and `reentryFor`'s
 * `busy` already reads the same field for leases. So nothing new is fetched to answer it.
 *
 * Deliberately **not** folded into `wantsAdvocate`. A paused epic still *has* an advocate —
 * that is what makes it resumable, and it is why its card stays on the console with a
 * badge instead of vanishing. Pausing an epic and closing one look identical if the
 * roster drops it, and the one control that would bring it back would be gone with it.
 */
export const isPaused = (issue) =>
  (issue?.labels || []).some((l) => String(l).trim() === PAUSED_LABEL);

/**
 * Every paused root in a graph, as a Set of ids — what a queue filter needs.
 *
 * A Set rather than a predicate per bead, because the question the queue asks is the
 * other way round: it holds a ready bead and wants to know whether *any* of its
 * ancestors is paused, and `ancestorsOf` produces those ids rather than filtering a
 * list. A membership test is the cheap half of that; a scan of the graph per ready bead
 * is not.
 *
 * Every bead with the label, not only the ones `wantsAdvocate` accepts. An epic that was
 * paused and has since lost its owner is still paused, and reading it as "not paused"
 * because the roster no longer wants it would start dispatching under an epic somebody
 * stopped — which is the failure this whole file is here to prevent, arrived at through
 * a different door.
 */
export function pausedEpics(beads) {
  const rows = beads instanceof Map ? [...beads.values()] : Array.isArray(beads) ? beads : [];
  return new Set(rows.filter((b) => isPaused(b)).map((b) => String(b.id)));
}

/**
 * What this epic says about requirements, and what it is asked for — bc-fvmx's half of the brief.
 *
 * Three things, and the order is the argument.
 *
 * **What it already says.** Ids first, because an advocate that cannot see what it wrote
 * last time rewrites it, and a block that is rewritten every run is a block whose history
 * means nothing.
 *
 * **What it wrote that does not exist.** `dropped` — ids that were in the block and are
 * not in the corpus. Named out loud rather than silently discarded, because an advocate
 * that is not told writes the same invented id every run, forever, and from outside that
 * is indistinguishable from the feature not working. This is the one line that stops the
 * loop.
 *
 * **The vocabulary.** The tokens that exist, so a candidate is filed under a real product
 * rather than one made up on the spot — the same closed-set discipline lib/requirements.js
 * applies to ids, applied one level up.
 *
 * And the refusal that matters most: **an empty answer must be cheap.** Most epics in a
 * personal tracker fulfil no Climative requirement, an agent that feels it owes an answer
 * invents one, and one invented id beside a real one is a graph nobody can trust. So the
 * brief says so in as many words, twice, and asks for the block to be left off entirely
 * rather than filled with something plausible.
 */
export function requirementsSection(epic, corpus = null, { pending = [] } = {}) {
  const known = Boolean(corpus?.ids?.size);
  if (!known && !pending.length) return '';
  const { ids, candidates, dropped } = readRequirements(epic, corpus);

  const lines = ['', '**Requirements — what this epic fulfils.**'];
  if (ids.length) {
    lines.push(
      '',
      'It already names these, and they resolve against the corpus:',
      '',
      ...ids.map((id) => {
        const entry = corpus?.ids?.get(id);
        return `- \`${id}\`${entry?.definition ? ` — ${entry.definition.slice(0, 160)}` : ''}`;
      })
    );
  }
  if (candidates.length) {
    lines.push(
      '',
      'And these **candidates**, which are proposals and not ids until a human approves them:',
      '',
      ...candidates.map((c) => `- \`${candidateId(c)}\` — ${c.definition}`)
    );
  }
  if (dropped.length) {
    lines.push(
      '',
      `**${dropped.map((d) => `\`${d}\``).join(', ')} ${dropped.length === 1 ? 'is' : 'are'} written on this bead and ${dropped.length === 1 ? 'does' : 'do'} not exist.**`,
      'No requirement by that name is in the corpus, so it has been dropped rather than',
      'recorded — an id that does not resolve is a typo or an invention, and a graph with one',
      'in it cannot be told from a graph without. Either use the real id or file it as a',
      'candidate; do not write it back unchanged.'
    );
  }
  if (!ids.length && !candidates.length && !dropped.length) {
    lines.push('', 'It names none, which for most beads is correct and is not something to fix.');
  }

  if (known) {
    lines.push(
      '',
      `The tokens that exist are: ${corpus.tokens.join(', ')}. An id is \`TOKEN.Feature.Thing\` and`,
      'must already be in the corpus. **You may not mint one** — a requirement exists when it is',
      'written into the architecture repo, which forty people clone, and that is a proposal a',
      'human approves. What you can write is a candidate: a token that exists, a short name, and',
      'one testable definition sentence.',
      '',
      'If this epic changes what one of those requirements means, or is the work that implements',
      'it, say so here — replacing any block already present:',
      '',
      '```',
      REQS_OPEN,
      '```json',
      '{ "ids": ["EN.Feature.Thing"], "candidates": [{ "token": "EN", "name": "Feature.Thing", "definition": "As a …, I want …" }] }',
      '```',
      REQS_CLOSE,
      '```',
      '',
      '**Leave it out entirely if nothing applies.** Most work in this repo is about this repo,',
      'and an empty answer costs nothing. A requirement invented to fill the space is worse than',
      'no answer at all, because the next reader will assume you had a reason.'
    );
  }

  const glean = gleanSection(pending, corpus?.tokens || []);
  return `${lines.join('\n')}${glean ? `\n${glean}` : ''}\n`;
}

/**
 * Every root in a workspace that has an advocate assigned to it — the roster.
 *
 * `wantsAdvocate` answers the question one bead at a time and was, until now, only ever
 * asked at a door: a window is being opened, may it be opened. That made an EpicAdvocate
 * a *window*, and a window lives minutes — so nineteen of the twenty epics that had one
 * assigned on 2026-08-13 had nothing anywhere saying so, and the twentieth looked like an
 * ordinary session.
 *
 * An advocate belongs to its epic for as long as the epic is open. That is the lifetime
 * this function exists to express, and it is why the roster is derived from the graph
 * rather than from `a.workers`: **an epic that closes stops having an advocate, and one
 * whose window has exited has not.** Anything reading a window list gets those two
 * backwards, which is the whole of bc-xl7n.8.1.
 *
 * Takes the `beads` half of `bd.graph()` — a `Map(id → {id, title, status, priority,
 * labels, …})`, already cached per workspace for a minute and never built on a request
 * path — so a caller asking every tick costs nothing beyond the filter. An array is
 * accepted too, because a test should not have to build a Map to assert an ordering.
 *
 * Sorted the way the board is: an epic with no id ordering to speak of still needs a
 * stable one, or the sections on `/monitor` reshuffle under a thumb on every repaint.
 */
export function assignedAdvocates(beads, { crash = isCrash } = {}) {
  const rows = beads instanceof Map ? [...beads.values()] : Array.isArray(beads) ? beads : [];
  return rows
    .filter((b) => wantsAdvocate(b, { crash }))
    .sort((x, y) => String(x?.id || '').localeCompare(String(y?.id || '')));
}

/**
 * How long an epic card goes on saying an advocate is opening before it offers the button
 * back.
 *
 * The gap this covers is real and is nobody's bug: a window opened seconds ago carries
 * no bead id in its name until its first turn has run, so there is a minute or so where
 * the launch has happened and nothing on disk says so. lib/advocate.js names the same
 * gap in `resight` and handles it the same way — by remembering the launch rather than
 * by asking harder.
 *
 * Ten minutes because the failure it has to survive is the opposite one: a session that
 * died before it ever named itself leaves a launch nothing will ever match, and a card
 * stuck on "opening" forever is a card whose only control has been taken away. Long
 * enough that a slow Mac is never the reason it lapses, short enough that a dead launch
 * gives the button back while you are still on the same screen.
 */
export const OPENING_TTL_MS = 10 * 60 * 1000;

/**
 * Roots an advocate was launched on here, by `workspace/id`, and when.
 *
 * In memory and not on disk on purpose: it answers one question — "is the window we just
 * opened still on its way up?" — and a daemon restart is a fact that makes the answer no.
 * What survives a restart is the session itself, which the name match finds without this.
 * Pruned as it is read, so it holds a handful of entries on the busiest day and nothing on
 * an ordinary one.
 *
 * **Module state, and that is what it is for.** It began as a `Map` inside lib/server.js,
 * when the only thing that could open one of these windows was the button in that file.
 * There are two doors now — the button, and lib/reenter.js's sweep in the advocate tick —
 * and a card that said "an advocate is opening" for one of them and offered the button
 * again for the other would be offering a control whose only outcome is a 409. Both
 * importers get the same instance in one process, the way lib/resolvers.js's registry does.
 */
const OPENED = new Map();

/** Record a launch, so the card stops offering to make a second one. */
export const rememberAdvocateOpened = (key, at = Date.now()) => OPENED.set(String(key), at);

/** When a launch on this key happened, if it was recent enough to still be coming up. */
export function openedRecently(key, now = Date.now()) {
  const at = OPENED.get(String(key));
  if (!at) return null;
  if (now - at >= OPENING_TTL_MS) {
    OPENED.delete(String(key));
    return null;
  }
  return at;
}

/** Test-only: forget every launch, so one suite's window cannot hold another's card. */
export const forgetAdvocateOpened = () => OPENED.clear();

/**
 * The session advocating this epic — what the card needs to offer a way *in* to it.
 *
 * Three answers, and the middle one is the whole reason this is a function rather than a
 * `find`:
 *
 *   - **A live session naming this bead** — its pid, which is the only address a session
 *     has (`/session?pid=…`, public/session.js). Matched with `namesBead` and not
 *     `name.includes(id)`, because every parent id is a prefix of its children's: a
 *     worker on `bc-d6yk.1` would otherwise be reported as the advocate on `bc-d6yk`,
 *     and the link on the card would open somebody else's window.
 *   - **Opening** — a launch we made inside `OPENING_TTL_MS` that nothing on disk has
 *     caught up with yet. No pid, so nothing to link to; what the card does with it is
 *     say so and not offer to open a second one.
 *   - **Null** — nobody is on it, which is the card's offer to put somebody there.
 *
 * It does not ask whether the session it found is *an advocate*. Nothing in the session
 * record says which agent a window is running (lib/claude.js reads Claude Code's own
 * file, and beadcause is not what writes it), so the honest claim is the one the launch
 * door already makes: one session per epic, whatever opened it. That is the same rule
 * `POST /api/bead/advocate` refuses a second launch on, and the two must agree or the
 * card offers a button whose only outcome is a 409.
 */
export function advocateSession(sessions, id, { openedAt = null, now = Date.now() } = {}) {
  const live = (sessions || []).find((s) => namesBead(s?.name, id));
  if (live) {
    return {
      pid: live.pid,
      name: String(live.name || ''),
      status: String(live.status || ''),
      at: live.at || null,
      opening: false,
    };
  }
  const since = Number(openedAt) || 0;
  if (since > 0 && now - since < OPENING_TTL_MS) {
    return { pid: null, name: '', status: '', at: new Date(since).toISOString(), opening: true };
  }
  return null;
}

/**
 * Everything the daemon already knows about one epic's advocate, as the card's own object.
 *
 * **The card used to get a boolean wearing a session's clothes.** `rootCard` sent
 * `advocate: advocateSession(…)` — a live window or `null` — and `null` was drawn as the
 * offer to put somebody there. So the steady state of a correctly-advocated epic was a
 * card offering to assign it: an Epic Advocate is re-entrant, it takes a turn and exits,
 * and between turns there is nothing running to find. That reads as the assignment having
 * been lost, which is bc-r2b5 in one sentence.
 *
 * Seven facts across eight keys, and every one of them already existed somewhere and
 * reached no screen:
 *
 *   - **`assigned`** — `isEnrolled`, off the bead. The one the card most needs: it is true
 *     between turns, when `session` is null and always will be for hours at a time.
 *   - **`by`** — which carrier is holding the enrolment, `label` | `waiting` | `null`.
 *     Not decoration: the two have different un-assign gestures, and a card that offers
 *     "take the advocate off" has to know which of them it is about to remove.
 *   - **`paused`** — `isPaused`. Assigned *and* stopped is a fourth state, and drawing it
 *     as either "assigned" or "not assigned" is wrong in a way somebody acts on.
 *   - **`session`** — whatever `advocateSession` answered, passed straight through rather
 *     than recomputed here, so this object and the `advocate` field beside it on the card
 *     can never disagree about whether a window is up.
 *   - **`lastAt`** — when a window last ran, from the re-entry sweep's own per-epic record
 *     (`advocated[id].at` in advocates.json). "Idle since 09:40" and "idle since a
 *     fortnight ago" are the same card without it.
 *   - **`hold` / `heldAt`** — why no window is being opened *right now*, in the sweep's own
 *     words, and when it decided that. Reported rather than re-derived: three of the five
 *     reasons (the tick's one-window budget, a worker this advocate is holding, a lease on
 *     another Mac) are things only the tick can see, and a second computation that could
 *     see two of them would be a second answer to one question — the failure `rootCard`'s
 *     own header names about counts.
 *   - **`finished`** — has lib/finishedepic.js already asked whether the theme is done?
 *     Passed in rather than read here, because it is a marker in three fields of the bead
 *     and this file stays a pure function of its arguments (`epicAdvocatePrompt`'s rule).
 *
 * `waitingOn` is **not** repeated in here. The card already carries it at the top level,
 * and one fact arriving twice in one payload is two copies of a state that can drift —
 * the argument `rootCard` makes about `pending` and about its own counts.
 *
 * A plain object with no nulls collapsed away: the client half (bc-r2b5.2) draws four
 * distinct states off these fields, and a field that is sometimes absent and sometimes
 * null is a field every reader has to guard twice.
 */
export function advocacyOn(bead, { session = null, record = null, finished = false } = {}) {
  const hold = record?.hold || null;
  return {
    assigned: isEnrolled(bead),
    by: isAssigned(bead) ? 'label' : waitingOn(bead) ? 'waiting' : null,
    paused: isPaused(bead),
    session: session || null,
    lastAt: record?.at || null,
    hold: hold?.why || null,
    heldAt: hold?.at || null,
    finished: Boolean(finished),
  };
}

/**
 * The brief, for one invocation.
 *
 * The *role* — what an Epic Advocate is, on every run — lives in lib/foundation.js and is
 * amendable. This is what it was asked *this time*, and the split is the one every other
 * agent here keeps: a foundation an agent can argue with, and a brief it cannot.
 *
 * Written as a pure function of its arguments, like `workPromptFor` in lib/session.js and
 * for the same reason: it lets a test assert every branch of the brief without a tracker,
 * a checkout or a window. Anything that needs a disk read is passed in — which is why
 * `notes` arrives as an argument rather than being read here.
 *
 * **`notes` is the index of what this agent already knows, and it closes the gap the
 * whole of bc-goo is about.** The system prompt hands every window `memoryBrief`, which
 * says a memory exists and names four commands for it; it does not say what is *in* it.
 * That difference is not academic for a re-entrant supervisor. This agent is opened,
 * closed and re-opened on the same epic for weeks, and the only thing it was ever handed
 * across those runs was the bead — so the fifth window rebuilt from the tracker what the
 * first four had already worked out, and the store filling up made that *worse* rather
 * than better: eleven notes with no index is 4,500 tokens of undifferentiated dump the
 * window has to ask for, then read, to find the two lines that are about this epic.
 *
 * `notesBrief` is the same selection the epic worker gets (`planPromptFor` in
 * lib/session.js) and it is called the same way, against **the epic alone** rather than
 * against the epic plus its open children. That was the one open design question on
 * bc-goo.14 and the precedent answers it: a supervisor's subject is the subtree, so
 * folding the children in is tempting — but the children's text is where an epic's own
 * words are most diluted, twenty beads' worth of vocabulary would match nearly every
 * note in the store above the floor, and a section that is noise once is a section
 * nobody reads again. The children each get this selection in their own briefs, where
 * it is precise.
 *
 * These are the advocate's *own* notes, not the worker's — `who` says so in the section,
 * because the author is what tells the reader how much weight a line carries. Which
 * store the daemon reads is `openEpicAdvocateSession`'s call and it must name
 * `EPIC_ADVOCATE`; test/epicadvocate.mjs pins that line, since handing this agent the
 * worker's store would look entirely correct and be a different agent's memory.
 *
 * **`debriefs`, and why a supervisor's report belongs in the same store as a worker's**
 * (bc-nib3.9). This window used to be the only bead-shaped session tier 4 could not see:
 * `openEpicAdvocateSession` passed an agent and no bead, so nothing stamped
 * `BEADCAUSE_BEAD` and `beadcause-memory debrief` refused. That refusal is correct for a
 * ship or a rebase window, which are about a pull request and would file a report against
 * the bead as though they had written the code — and it is wrong for the one agent that is
 * opened, closed and re-opened on the *same bead* for weeks. Three carriers now, and they
 * hold three different things: the waiting-on sentence is one line of current state for a
 * phone, the notes store is what is still true next week, and a debrief is what this visit
 * actually was. Until this, the third had nowhere to go and was written as one of the other
 * two — a belief that was false a fortnight later, or nothing at all.
 *
 * The read half arrives here and the write half is asked for at the end, because a store
 * only one side of is the write-only diary bc-714o refused to build. Both are pushed at
 * this agent rather than left to `beadcause-memory debriefs`, for the reason the notes
 * index exists: this window's whole problem is that it starts from the bead every time.
 */
export function epicAdvocatePrompt(workspace, epic, kids = [], plan = null, owner = 'the owner', extra = {}) {
  const {
    waiting = null,
    reason = '',
    notes = null,
    debriefs = [],
    corpus = null,
    gleaning = [],
    // bc-xl7n.99: which of `kids` is parked behind an open delivery or merge-queue card,
    // by id — `waitingOnMergeCard` in lib/reenter.js, built once per sweep off the same
    // index `reentryFor` already reads. `() => null` is not "nothing is delivered", it is
    // "this caller has no index to answer from" (the card-driven door, `POST
    // /api/bead/advocate`) — the safe direction, since the alternative is a fresh `bd.graph`
    // call this bead's acceptance forbids.
    deliveryCard = () => null,
    // bc-khoe.33: the whole subtree, where the caller has one — `advocatedRoots` builds it
    // beside `kids` off the same index, so this costs nothing. `kids` is direct children and
    // is what the list above is; this is what the list above *cannot see*, and until a plan
    // could name a grandchild there was no reason to show it. Now there is: a plan may name
    // anything under the epic at any depth, so an advocate deciding whether the plan still
    // fits over one level is deciding it over half the beads. Empty from the card-driven
    // door, which has no index — the same safe direction `deliveryCard` takes.
    tree = [],
  } = extra;
  const open = kids.filter((k) => String(k.status) !== 'closed');
  const done = kids.length - open.length;
  const lines = [
    `You are the Epic Advocate for **${epic.id}** in \`${workspace}\`: ${epic.title}`,
    '',
    reason
      ? `You were opened because ${reason}.`
      : 'You were opened to take stock of this epic and decide what happens next.',
    '',
    `**Owned by ${ownerOf(epic) || owner}.** They agreed to carry this; you are the thing that carries it.`,
    '',
  ];

  if (!kids.length) {
    // bc-jvt0.4. This branch used to open *"planning it is the whole job this time"* and go
    // straight on to filing children — an instruction, to the one agent that has read the
    // bead, to decompose it whatever it says. Two things were wrong with that and only the
    // second is obvious.
    //
    // The obvious one: a childless epic is often simply one change, and a decomposition
    // filed to satisfy a brief is a bead invented so that a worker has something to hold.
    // Adam's decision (2026-08-21) is that this agent judges and **the default is to do the
    // work.**
    //
    // The other one is that nothing was *waiting* for the judgement. The queue dispatched a
    // childless epic as ordinary ready work on the first tick it saw it, so on almost every
    // occasion the answer arrived after the question had been settled by whoever got there
    // first. `heldByChildren` (lib/advocate.js) now holds an owned childless epic until one
    // of the three answers below exists — which is what makes this a decision rather than a
    // recommendation, and also what makes writing it down load-bearing: an epic this window
    // decides about and does not mark is an epic that goes on being held.
    //
    // So: the default first, the split second with a reason asked for, and asking third. The
    // third is the one worth spelling out rather than leaving implied — a plan filed to look
    // productive is the failure this bead was filed about, and an agent with no third answer
    // has to pick one of the first two.
    lines.push(
      '**This epic has no children, so the one thing this visit decides is what that means** — and it is',
      'yours to decide. Nothing else will: until you have recorded an answer the queue holds this epic',
      'and opens no window on it, so a visit that concludes nothing leaves it exactly where it was.',
      '',
      'Read the bead and read the repo, then answer in this order.',
      '',
      '**1. Do it whole — and this is the default.** If the description is enough to act on and the job is',
      'simple enough for one branch and one pull request, that is the answer. Do not file a child bead',
      'merely to give a worker something to hold: a bead invented for the dispatcher is a bead somebody',
      'has to read, review and close, and it says nothing the epic did not already say. Record it with a',
      'comment on ' + epic.id + ' and the `' + WHOLE_LABEL + '` label — the label is what lets the epic be',
      'dispatched as itself, and the comment is why. Run `beadcause-epicplan`, which writes and validates',
      'both in one step rather than a comment and a label typed by hand to match markers you cannot check:',
      '',
      '```',
      `beadcause-epicplan -w ${workspace} -b ${epic.id} <<'EOF'`,
      'whole:',
      '  why: |',
      '    what in the bead is enough to act on, and why it is one change rather than several',
      'EOF',
      '```',
      '',
      `The \`why\` is not a formality and has a floor of ${MIN_WHY_CHARS} characters where nothing else`,
      'here has one: it is the whole of what you decided, and the worker opened on this epic reads it',
      'before the diff. A `why` too short, or missing, is refused before anything is written — fix it and',
      'run the command again rather than writing the comment or the label yourself.',
      '',
      '**2. Split it — and say why, in the same breath.** Only when the work genuinely needs to be several',
      'beads: different files, different orderings, or a piece that cannot start until another has landed.',
      'File each child under it with `--parent ' + epic.id + '` — a bead filed anywhere else is a bead',
      'nothing will ever work, because a bead with nothing decided above it is not workable — then group',
      'them for child-workers and write each group a prompt. The children are the record: the moment one',
      'exists this epic is no longer childless and the hold is gone, so there is no label to add. What is',
      'owed instead is the reason, in a comment: what made this several pieces rather than one, so the next',
      'window does not re-argue it and so a split nobody can justify is visible as one.',
      '',
      '**3. Neither — ask.** If the description is not enough to act on and reading the repo does not settle',
      'it, that is the answer and it is not a failure. Do not invent a decomposition to have something to',
      'show: file the question under this epic as a `human` bead carrying a `decision` block, and put',
      '`human` on ' + epic.id + ' itself as well so the queue stops offering it while the question stands.',
      'A guessed answer costs a worker window and a branch; asking costs one tap.'
    );
  } else {
    lines.push(
      `**${open.length} of ${kids.length} children are still open** (${done} closed). Your job this time is`,
      'to decide whether the plan still fits: whether anything is stuck, whether a child should be split,',
      'and whether anything is missing that this epic cannot finish without.'
    );
    lines.push(
      '',
      ...open.slice(0, 20).map((k) => {
        // bc-xl7n.99: `in_progress` is the tracker's status and nothing more. A worker that
        // reached either of its two documented endings — delivered, or handed back with a
        // question — is left in exactly this state, and this epic's own debriefs describe
        // paying a PR read, a worktree check and a lock check every pass to tell that apart
        // from a real stall. Both facts are free here: `human` is a label already on the
        // row, and `deliveryCard` is this same sweep's index, already walked for
        // `reentryFor` — so a genuinely stuck child reads exactly as it always has.
        //
        // bc-xl7n.118 adds the third, and it is the one where a mis-read does damage
        // rather than costing a window: a sub-epic is `in_progress` because *Adam* put it
        // on the root board, or because an advocate of its own is on it. Neither is a
        // claim this window may release — see the stall paragraph below. `reentryFor`
        // already drops such a row from the clock, so it will not be the reason you were
        // opened; it is annotated rather than hidden because it is still a child of this
        // epic and its state is still worth seeing.
        const card = String(k.status) === 'in_progress' ? deliveryCard(k) : null;
        const note =
          String(k.status) === 'in_progress' && (k.labels || []).includes('human')
            ? ' — handed back, waiting on an answer'
            : card
              ? ` — delivered, waiting on \`${card}\``
              : String(k.status) === 'in_progress' && isAssigned(k)
                ? ' — supervised by an advocate of its own, not stalled'
                : '';
        return `- \`${k.id}\` P${k.priority ?? '?'} ${k.status}${note} — ${k.title}`;
      })
    );
    if (open.length > 20) lines.push(`- …and ${open.length - 20} more.`);
    // Everything open under this epic that is not one of its direct children — a sub-epic's
    // children, or a bead a child-worker filed under its own bead. Listed separately rather
    // than folded into the list above because the two are answerable in different places: a
    // stalled child is this window's to release, and a deeper bead usually belongs to the
    // sub-epic between them. What they have in common is the only thing this section is for
    // — a group may name either, and one nobody groups re-opens a planner here.
    const ids = new Set(kids.map((k) => k.id));
    const deeper = (tree || []).filter((b) => !ids.has(b.id) && b.id !== epic.id && String(b.status) !== 'closed');
    if (deeper.length) {
      lines.push(
        '',
        `**${deeper.length} more ${deeper.length === 1 ? 'bead is' : 'beads are'} open further down** — under a child of`,
        'this epic rather than under it directly. **A group may name any of them.** A plan reaches the whole',
        'subtree, not one level (bc-khoe.33), and the sweep that re-opens you counts a ready bead at any depth',
        'as work your plan has to cover — so one you leave in no group is not left alone, it is what brings a',
        'planner back here.',
        '',
        ...deeper.slice(0, 20).map((b) => `- \`${b.id}\` P${b.priority ?? '?'} ${b.status} — ${b.title}`)
      );
      if (deeper.length > 20) lines.push(`- …and ${deeper.length - 20} more.`);
    }
    // What the reason above actually asks of this visit. The sweep opens this window on
    // exactly three shapes of event and hands them over as one prose sentence — which
    // says what moved and, until this, nothing at all about what to do with it. The
    // stall is the one worth the words: a bead left `in_progress` by a window that died
    // is out of `bd ready` for ever and no advocate, worker or queue will touch it
    // again, so releasing the claim is the whole of the repair and it is inside this
    // agent's allowlist. Ordered closed / filed / stalled to match `reason` in
    // lib/reenter.js, so the sentence at the top of the brief and the list here read in
    // the same order.
    lines.push(
      '',
      '**Take the reason you were opened for first, and read it as one of three shapes.** You are opened when',
      'something in this subtree closes, is filed or stalls — never when a child merely starts — and each of',
      'those asks a different question of you:',
      '',
      '- **A child closed.** Does the plan still fit, is anything now unblocked that nobody has noticed, and',
      '  is this P0 itself finishable? That last one only ever becomes true on a close.',
      '- **A child was filed.** Is it in the plan, under the right parent, and work this P0 has to carry at',
      `  all? One carrying \`unendorsed\` is waiting on ${ownerOf(epic) || owner} rather than on you.`,
      '- **A child stalled** — the tracker says `in_progress` while nothing on this Mac is in a window on it',
      '  and no other machine holds a lease. The list above already says `handed back`, `delivered` or',
      '  `supervised` when any of the three is known, off the same facts this section used to send you to check by',
      '  hand — a plain `in_progress` there is the one actually worth this. Look for a branch or an open pull request',
      '  carrying its work before you touch it: if there is one, the work exists and the bead is where it should be.',
      '  If there is not, the claim belongs to a window that died — and while it stands the bead is invisible to `bd',
      '  ready`, so nothing will ever pick it up again. `bd update <id> --status open --assignee ""` puts it',
      '  back in the queue, and a comment on the child saying what you found and that you released it is',
      '  what stops the next window redoing the same reasoning.',
      '',
      '**Never run that on a child that is an epic with an advocate of its own** — the list above says',
      '`supervised by an advocate of its own` when it is. On a root, `in_progress` is not a worker\'s claim: it',
      'is what **Start** on the board writes, and it is the same fact on every device rather than a pin on one',
      `screen. Clearing it takes the epic off ${ownerOf(epic) || owner}'s board, silently, and the board is theirs`,
      'to own. Such a child is never the reason you were opened — the sweep excludes it — so if one is what you',
      'are looking at, leave it alone and say so.'
    );
  }

  if (plan) {
    lines.push('', '**The plan already on this bead**, which you wrote and should update rather than restate:', '', plan);
  }

  // Read before you conclude, and conclude before you write: the index goes above the
  // block that tells this agent what to leave behind, because a supervisor that writes
  // its waiting-on sentence without having read the last four is exactly the write-only
  // diary bc-714o refused to build the other half of.
  const learned = notesBrief(notes || {}, epic, { who: 'Epic Advocate' });
  if (learned) lines.push(learned);

  // And tier 4 beside it, in the same order the worker's brief and the planner's put the
  // two: what is still true, then what happened last time. The selection is narrower here
  // than in either of those and deliberately so — `debriefFamily` keys off the bead's
  // parent, a root epic has none, so what arrives is the reports of previous runs *at this
  // epic* rather than its children's. That is the right narrowing twice over: it is this
  // agent's own account of its last visit, which is the thing a re-entrant supervisor has
  // never had, and it cannot be swamped by twenty children's afternoons.
  const past = debriefBrief(debriefs || [], epic);
  if (past) lines.push(past);

  // bc-fvmx. After what earlier sessions worked out and before the closing instructions,
  // because it is a fact about the epic rather than something to do first — and because an
  // agent reads what is nearest the ask last.
  const requirements = requirementsSection(epic, corpus, { pending: gleaning });
  if (requirements) lines.push(requirements);

  lines.push(
    '',
    '**Before you exit, write down what you concluded.** You are re-entrant: this window closes and the',
    'next one starts from the bead, not from this conversation. In particular, put one sentence saying',
    'what this epic is waiting on into its notes, between these markers, replacing any block already there:',
    '',
    '```',
    WAITING_OPEN,
    waiting || 'what it is waiting on, in one line',
    WAITING_CLOSE,
    '```',
    '',
    'That sentence is what the epic card on the phone draws — an epic stalled for a week and one quietly',
    'progressing look identical without it.',
    '',
    // bc-zjab.5. The number was in the code and nowhere an advocate could see it: the
    // block above quotes the two markers, and a marker says nothing about length. Four
    // consecutive visits to bc-y3qk each wrote ~900 characters into it. Said here, at the
    // moment the sentence is asked for, rather than in the foundation — the foundation is
    // what this agent *is*, and this is a constraint on one thing it writes.
    `**One sentence, and at most ${WAITING_MAX} characters of it** — about two lines on a four-inch screen, which is`,
    'all the card has. Anything past that is cut with an ellipsis when the card is drawn, so a paragraph in',
    'there is not a fuller card, it is the same card with your last clause thrown away. If what you concluded',
    'does not fit in one line it is not this sentence: the state of the epic goes here, what is still true next',
    'week goes in your notes, and what this visit actually was goes in the debrief below.',
    '',
    `**What keeps you being re-opened is the \`${ADVOCATE_LABEL}\` label on ${epic.id}, not that sentence.**`,
    'It was written the moment somebody put you on this epic, so a window that dies before writing anything',
    'still leaves the epic assigned — which is the whole of bc-r2b5.1. The sweep that brings you back on a',
    'child closing, being filed or stalling does so for an epic carrying **either** that label or the block',
    `above. So if you conclude this epic needs no more supervision, take both off — \`bd label remove ${epic.id}\``,
    `\`${ADVOCATE_LABEL}\` and erase the block — because either one left in place keeps you being re-opened.`,
    'That is the un-assign, and it is yours to make; leaving it assigned is the right answer whenever there',
    'is still anything under this epic to supervise.',
    '',
    '**Then leave a report on this visit, and it is the third thing rather than a restatement of the',
    'other two.** Run it as a tool call before your final message:',
    '',
    '```',
    'beadcause-memory debrief "<what you found this time, and what you did about it>"',
    '```',
    '',
    'The waiting-on sentence above is one line for a phone and it says the *current* state. Your notes',
    'hold what is still true next week. Neither can hold what this visit actually was: which child you',
    'looked at and decided was fine, the blockage you thought you had found and had not, why you split',
    'one bead and left another alone, what you would look at first if you were opened again tomorrow.',
    'That is what the next window on this epic — yours or a planner’s — is handed before it plans',
    'anything, and you are the only run that will ever be able to write it.',
    '',
    `**And if what this epic needs is a decision only ${owner} can make, that is not a note to yourself.** File`,
    `it under ${epic.id} as a bead labelled \`human\` carrying a \`decision\` block — the question, the options,`,
    'one of them marked `recommended: true` — and it arrives on their phone as something answerable in',
    'thirty seconds. A question left in a comment is a question nobody is shown, and one filed without the',
    'label is picked up as work by the next worker window.',
    '',
    '**And you may offer them a *not yet*: `defers: true` on an option.** Answering ordinarily closes the',
    'bead and `closes: false` hands it to an agent as work, so for a long time a card had no way to say',
    '"ask me again later" — every advocate gave every option a close as a workaround and reasoned it',
    'out again from scratch. An option marked this way comments the answer, leaves the bead open and',
    'unclaimed, and keeps the `human` label, and nothing opens a session on it. The card is set aside and',
    'comes back on its own when the gate it is waiting on clears, so write the label for that condition —',
    '"not yet, ask me again once the children have merged" — rather than for a list it should sit on.',
    '',
    '**Three things you may not do.** You may not endorse anything in your own subtree — you file the work,',
    `${owner} agrees to it. You may not change the priority or the owner of ${epic.id}: the owner is what the`,
    'board is built out of and the priority is their statement of how urgent this is — both theirs, and since',
    'bc-htoy an epic needs no particular priority to have you, so there is nothing to reach for.',
    'And you may not close anything — a work bead closes when its merge lands and the merge queue is what',
    'closes it, and this epic closes when its theme is done, which is a call only they can make. If you',
    'think it is finished, say so in the sentence above and leave the close to them.'
  );
  return lines.join('\n');
}
