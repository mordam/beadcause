/**
 * Filing — a worker creates the bead itself, the moment it finds the work.
 *
 * This is the other half of lib/endorse.js. That file is the hold; this one is what
 * puts a bead under it. Together they are the whole trade: a session that trips over
 * work no longer has to choose between swallowing it and stopping to ask.
 *
 * **What changed, and why the old order was wrong.** A worker used to be told "do not
 * create beads — propose them", and `bin/propose.js` filed one `human` question
 * carrying the full text of everything it wanted. Nothing existed until a button was
 * pressed. The review was real, but it sat in front of the *filing*, and a session
 * that has found a bug at 02:00 cannot wait for a tap: it either abandons what it
 * found or it parks. So the review moved to the other side. The bead is created now,
 * it arrives carrying `unendorsed`, and **an unendorsed bead is not workable by
 * anything** — no advocate queues it, no launcher opens a session on it (see
 * lib/endorse.js). Endorsement is still a decision Adam makes before any agent time is
 * spent on it; it is simply no longer the thing the finder waits on.
 *
 * Three stamps go on every bead filed this way, and each answers a different question
 * you would ask three weeks later:
 *
 * 1. **`unendorsed`** — may this be worked? No, not until you say so. This is the one
 *    that has teeth, and its spelling lives in lib/endorse.js so there is exactly one.
 *    It is also the one stamp a space may switch off: `autoEndorse` in lib/spaces.js
 *    files without the hold, for a space where the tap was a formality. The other two
 *    are not optional — see `beadToIssue`.
 * 2. **`agent-filed`** — who decided this was work? An agent did, unprompted. One
 *    `bd list --label agent-filed` finds every bead that arrived this way, endorsed or
 *    not, which is the only way to audit the feature after the marker has come off.
 * 3. **`discovered-from:<bead>`** — how was it found? The edge back to the work that
 *    turned it up, so the trail survives the session that had the reason on screen.
 *    It is a `related` edge in bd's vocabulary, not a blocker: the work carries on.
 *
 * **The priority ceiling.** An agent-filed bead is clamped to `PRIORITY_FLOOR` or
 * lower-ranked, so what an agent decided was urgent cannot outrank what Adam chose.
 * This matters much less than it did before the hold existed — a held bead is not in
 * any queue at whatever priority — but it still decides where the bead lands the
 * moment it *is* endorsed, and "the agent said P0" is not a reason for it to be the
 * next thing worked. The clamp is recorded on the bead rather than applied silently,
 * because a session that filed at P0 was saying something worth reading.
 *
 * Nothing here writes the description the agent gave: `notes` carries the provenance,
 * the rationale and any duplicate warning, and the description stays exactly what was
 * filed. The endorsement queue (bc-3zo9.4) renders both, and a bead whose description
 * had a paragraph of daemon prose bolted onto it reads as beadcause's opinion rather
 * than as the work.
 *
 * The priority ceiling is one of six places that decide whether something may run with
 * nobody watching — lib/authority.js is the map of all of them.
 */
import { withSurface } from './beadfiles.js';
import { complexityLabels } from './complexity.js';
import { UNENDORSED } from './endorse.js';
import { homeIn } from './homing.js';
import { dupeNote } from './proposal.js';

/** Provenance: an agent decided this was work. Survives endorsement, unlike the marker. */
export const FILED_LABEL = 'agent-filed';

/**
 * The best an agent-filed bead may be. Numerically a floor because bd's priorities run
 * 0 (critical) to 4 (backlog) — P0 and P1 are Adam's to hand out.
 */
export const PRIORITY_FLOOR = 2;

/** bd's word for "this is where it came from", and not a blocker. See public/graph.js. */
export const DISCOVERED_FROM = 'discovered-from';

/**
 * The queryable half of "how was it found" — bc-xl7n.76.1.
 *
 * `discovered-from:<bead>` (the edge above) answers the same question and is not
 * enough on its own, for two reasons `withDiscoveredFrom` already lives with: bd drops
 * the edge outright when `from` is the bead's own parent (one typed edge per pair), and
 * even where it survives it is a fact about the graph *now* — an epic's own triage pass
 * adopting a bead by hand afterwards moves it exactly as any other edge would. Either
 * way, the bead a reader sees hanging under an epic today is indistinguishable from one
 * that epic's own worker actually filed there, which is the whole gap bc-w156.2 named
 * and left as "its own bead". This label is written once, at file time, from the same
 * `from` every other writer here already trusts, and nothing after creation ever
 * touches it: public/monitor.js's `heldByAdvocate` reads it in preference to walking the
 * bead's live ancestry. "Produced by its work" read off a stamp, not inferred from
 * wherever the bead has since ended up.
 */
export const FILED_WHILE_PREFIX = 'filed-while:';

/** `filed-while:<bead>`, or `null` when nothing was being worked at file time. */
export function filedWhileLabel(from) {
  const f = String(from || '').trim();
  return f ? `${FILED_WHILE_PREFIX}${f}` : null;
}

/** Is this one of the labels above — checked the way every other prefix here is. */
export const isFiledWhileLabel = (value) =>
  String(value ?? '').trim().toLowerCase().startsWith(FILED_WHILE_PREFIX);

/** The bead a `filed-while:<bead>` label points at, or `''` if this is not one. */
export function filedWhileTarget(label) {
  const l = String(label ?? '').trim();
  return isFiledWhileLabel(l) ? l.slice(FILED_WHILE_PREFIX.length) : '';
}

/** `P0`, `0`, `"1"` or nothing → a number bd will take, never worse than the floor. */
export function clampPriority(priority, floor = PRIORITY_FLOOR) {
  const p = Number(String(priority ?? floor).replace(/^p/i, ''));
  const asked = Number.isInteger(p) && p >= 0 && p <= 4 ? p : floor;
  return { priority: Math.max(asked, floor), asked, clamped: asked < floor };
}

/** What a `deps` entry points at, whether it named a type or not. `blocks:zz-1` → `zz-1`. */
const depTarget = (dep) => {
  const d = String(dep || '').trim();
  const at = d.indexOf(':');
  return at === -1 ? d : d.slice(at + 1).trim();
};

/**
 * The `discovered-from` edge, unless the bead already named one — **or unless that edge
 * would be a second edge to the bead's own parent, which bd refuses outright.**
 *
 * A YAML spec may carry its own `deps`, and one of them may already be a
 * `discovered-from` — an agent filing three beads that hang off each other, most
 * likely. Two edges of the same type between the same pair is noise on the graph
 * sheet, and an agent that wrote its own is more specific than the default.
 *
 * ## Why `parent` is here at all, and it is bc-xl7n.65
 *
 * bd holds **one edge per pair**, typed, and refuses a second of a different type:
 *
 *     validation failed: dependency → bc-eqn1.1 already exists with type "parent-child"
 *     (requested "discovered-from"); remove it first with 'bd dep remove' then re-add
 *
 * `bd create --parent X --deps discovered-from:X` is exactly that, and it is not a rare
 * shape — it is what lib/homing.js answers **every time the discovering bead is itself a
 * root**, since `rootOver` counts a root as being above itself. A worker opened on a P0
 * that files one discovery hits it; a worker opened on a child of one does not. The
 * whole create fails, `fileBeads` drops the parent rather than lose the discovery, and
 * the bead lands parentless — held, undispatchable, and reported to the session as
 * *filed under X*.
 *
 * Measured on this tracker: **every one of the twenty-two `agent-filed` beads sitting
 * with nothing above them on 2026-08-17 was this**, and the transcripts of the sessions
 * that filed them all carry the same refusal. It is not a lock race, not a `bd export`
 * that failed, and not bd's hierarchy rules — all three were ruled out on the bead, and
 * all three were wrong.
 *
 * **The parent-child edge wins and the provenance edge goes**, rather than the other way
 * round, for two reasons. It is the load-bearing one: a `discovered-from` decorates the
 * graph sheet, and a parent is what makes the bead workable at all (lib/underroot.js).
 * And it loses nothing — a parent-child edge to the bead you were working *is* the trail
 * back, drawn more prominently than the edge it replaces, and `provenanceNotes` still
 * writes *filed by an agent while working X* in the bead's own notes either way.
 *
 * Any dep the caller supplied that points at the parent goes for the same reason: bd
 * would refuse the create over it just as readily, and a discovery lost over a decoration
 * is the wrong way round.
 */
export function withDiscoveredFrom(deps, from, { parent = '' } = {}) {
  const home = String(parent || '').trim();
  const have = (deps || [])
    .map((d) => String(d).trim())
    .filter(Boolean)
    .filter((d) => !home || depTarget(d) !== home);
  if (!from) return have;
  // The edge and the parent are the same bead: `rootOver` answers `from` itself whenever
  // `from` is a root. The parent link already says it, and bd will not hold both.
  if (home && String(from).trim() === home) return have;
  const edge = `${DISCOVERED_FROM}:${from}`;
  const already = have.some((d) => d === edge || d === from || d.endsWith(`:${from}`));
  return already ? have : [...have, edge];
}

/**
 * The sentence bd actually said, out of an error whose first line is not it.
 *
 * `Bd.run` builds its message as `bd <every argument> failed in <ws>: <detail>`, and a
 * `create` carries `--description` — so the message's *first* line is the beginning of
 * the command and the reason is somewhere past the description's first newline. Every
 * refusal this file reported for a fortnight was truncated there: what a session saw was
 * its own title echoed back with `Filing it with no parent instead.` bolted on, and never
 * once the reason, which is a large part of why bc-xl7n.65 took three passes to attribute.
 *
 * bd's own words are on `stderr`; the last non-empty line of it is the failure, since a
 * warning (a pending schema migration, most often) can precede it. Nothing there — a
 * child this process killed on a timeout says nothing at all — falls back to the message,
 * whose first line is the whole of it for every error that is not a `create`.
 */
export function bdReason(err) {
  const said = String(err?.stderr || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return said[said.length - 1] || String(err?.message || err || '').split('\n')[0].trim();
}

/**
 * The paragraph that says where this came from and what state it is in.
 *
 * Written for the person reading the endorsement queue with no memory of the session
 * that filed it, which is everyone by the next morning. It says the three things they
 * need before deciding: an agent filed this unprompted, it is doing nothing until they
 * say so, and here is what the agent's argument for it was.
 *
 * **An auto-endorsed bead gets the opposite sentence, and it matters more than the
 * first one.** With `autoEndorse` on for the space (lib/spaces.js) this bead is not
 * waiting for anybody: it is in `bd ready`, and the next advocate tick may open a
 * session on it. The reader of that bead is no longer somebody deciding whether to
 * allow it — they are somebody finding out it was allowed, possibly after the work has
 * already run — so the note has to say plainly that no human passed it and where the
 * setting that decided so lives. A bead saying "nothing will open a session on it until
 * you endorse it" over a session already running on it is the worst of the two errors.
 *
 * **`endorsedNote` is for the one caller that endorses for a reason of its own.** The
 * auto-endorse sentence names the policy setting, because for `autoEndorse` that setting
 * *is* the reason and the reader's next question is where to turn it off — and it says
 * "this repo" rather than "this space" because the answer resolves per workspace first
 * (lib/spaces.js), so a bead endorsed by a repo's own override would otherwise send its
 * reader to a space control that says nothing at all. A reported
 * error (lib/errors.js) arrives endorsed for a completely different reason — a program
 * failed, and no space setting was consulted — so it says so in its own words rather
 * than sending the reader to a switch that had nothing to do with it. Absent, nothing
 * changes; this is why the sentence is a parameter and not a rewrite.
 */
export function provenanceNotes(
  bead,
  { from = '', clamped = false, asked = null, endorsed = false, endorsedNote = '', homed = '' } = {}
) {
  const lines = [
    `_Filed by an agent${from ? ` while working ${from}` : ''}, at the moment it found the work._ ` +
      (endorsed
        ? endorsedNote ||
          'It arrived **endorsed**: auto-endorsement is on for this repo, so nobody read it before ' +
          'it became workable and an advocate may open a session on it. Turn that off on the ' +
          "space's details screen — on this repo's own row, or on the space above it — if you " +
          'want the tap back.'
        : `It is \`${UNENDORSED}\`: nothing will open a session on it until you endorse it.`),
  ];
  if (bead?.rationale) lines.push('', `**How it was found:** ${bead.rationale}`);
  // Where it landed, and only when something *chose* for it. A bead adopted into an
  // epic nobody named it under reads as somebody else's decision unless the bead says
  // who made it — and the answer, "it had to be under a root to be workable at all", is
  // the sentence that makes moving it somewhere better an obvious next step rather than
  // a correction of a mistake. See lib/homing.js.
  if (homed) {
    lines.push(
      '',
      `**Filed under ${homed}.** A bead with nothing decided above it is not workable (bc-rfnr.7), and nothing ` +
        'named a home for this one, so the filing seam picked the nearest honest one. Move it if it ' +
        'belongs somewhere better — adopting it elsewhere needs no other change.'
    );
  }
  if (clamped) {
    lines.push(
      '',
      `**Filed as P${asked}, held at P${PRIORITY_FLOOR}.** What an agent files may not outrank the ` +
        'work you chose; raise it yourself if it really is that.'
    );
  }
  if (bead?.duplicate) {
    lines.push(
      '',
      `**Looks like a duplicate** — ${dupeNote(bead.duplicate)}. Filed anyway, flagged rather than ` +
        'dropped: the agent that found it could not read the tracker, and a near-miss title is not ' +
        'proof of the same bug. Revoking it is one tap.'
    );
  }
  if (bead?.notes) lines.push('', bead.notes);
  return lines.join('\n');
}

/**
 * One normalised bead (lib/proposal.js shape) → the arguments `Bd.create` takes.
 *
 * Separate from `fileBeads` because it is the whole of the decision-making and none of
 * the I/O: what the labels are, what the priority becomes, what the edge is. A test
 * that wants to know whether the marker goes on should not have to run a tracker.
 */
export function beadToIssue(
  bead,
  { from = '', floor = PRIORITY_FLOOR, labels = [], endorsed = false, endorsedNote = '', home = null } = {}
) {
  const { priority, asked, clamped } = clampPriority(bead?.priority, floor);
  // `home` is `lib/homing.js`'s answer, resolved once by the caller for the whole batch
  // because it is one `bd export` and every bead in a batch was discovered from the same
  // work. Absent — a caller that has no tracker to ask, or a workspace with no P0 the
  // bead could hang off — is the bead this function built before bc-rfnr.8, parentless.
  const parent = String(home?.parent || '').trim();
  return {
    title: bead.title,
    type: bead.type || 'task',
    priority,
    // The declared surface goes *into* the description, and not into `notes` where
    // everything else this function adds goes. The rule is not stylistic: `notes` is
    // beadcause's prose about the bead and the advocate never reads it — `bd list --json`
    // carries `description` and not `notes`, so a surface written there would cost one
    // `bd show` per candidate per tick. lib/beadfiles.js owns the spelling; a bead that
    // declared nothing gets its description back untouched, and that is every bead any
    // caller of this filed before bc-42ow.
    //
    // Guarded on there being a surface rather than handed straight to `withSurface`,
    // whose empty-list case *withdraws* a block. Withdrawal is a real act and this is not
    // the place it can be meant: nothing that calls this can express "take the block
    // out", so an empty list here only ever means "nobody said" — and a description that
    // happens to carry a block somebody typed by hand would be quietly emptied of it by a
    // caller that simply has no opinion. Declaring nothing must leave the text alone.
    body: bead.files?.length ? withSurface(bead.description || '', bead.files) : bead.description || '',
    acceptance: bead.acceptance || '',
    design: bead.design || '',
    notes: provenanceNotes(bead, { from, clamped, asked, endorsed, endorsedNote, homed: home?.why || '' }),
    parent,
    // The marker first: a reader of `bd show` should see why it is not being worked
    // before anything else. `bead.labels` is whatever the agent asked for, minus
    // `human` — lib/proposal.js already drops that, since a filed bead is not a
    // question and must not land in the inbox as one.
    //
    // `endorsed` is the one thing that drops it, and it drops *only* it: the space said
    // the tap was a formality, not that the provenance was. `agent-filed` and the
    // `discovered-from` edge below are what a bead filed this way can still be audited
    // by afterwards, and with the hold gone they are the only thing left that says an
    // agent decided this — so they are not conditional on anything.
    //
    // `filed-while:<from>` rides beside `agent-filed` for the same reason and survives
    // the one case the edge below cannot: `withDiscoveredFrom` drops the edge when `from`
    // collides with `parent`, but the label is unconditional — it is the queryable
    // "produced by its work" bc-xl7n.76.1 asks for, and it costs nothing to write even
    // when the edge next to it is about to be dropped for the same bead.
    //
    // The tier rides along with them, and it is not a stamp of the same kind: nothing
    // about it says whether this bead may be worked, only how hard it is and therefore
    // which model a session on it runs (bc-nc6o). It goes on last because it is the one
    // an agent can be wrong about in a way nobody can see later — a bead filed with no
    // tier is honestly unrated and takes the expensive fallback, which is why nothing
    // here invents one.
    labels: [
      ...(endorsed ? [] : [UNENDORSED]),
      FILED_LABEL,
      ...(filedWhileLabel(from) ? [filedWhileLabel(from)] : []),
      ...labels,
      ...(bead.labels || []),
      ...complexityLabels(bead.complexity),
    ].filter((l, i, all) => l && all.indexOf(l) === i),
    // `parent` and not just `from`: the two are the same bead whenever the work that
    // found this was itself a root, and bd refuses a `discovered-from` edge to a bead
    // that is already the parent. See `withDiscoveredFrom` — bc-xl7n.65.
    deps: withDiscoveredFrom(bead.deps, from, { parent }),
    clamped,
    asked,
    endorsed,
  };
}

/**
 * File them for real, one at a time, and report what happened to each.
 *
 * **One bead's failure does not lose the others.** Embedded Dolt is single-writer and
 * a create can lose a lock race (`Bd.create` retries four times, and then it is a real
 * error); a session filing three discoveries at 02:00 should not have the third eaten
 * because the second collided. So each is caught, and the caller gets both lists.
 *
 * `from` is verified before it becomes an edge. A `--from` naming a bead that is not
 * in this workspace — a typo, or the id of a bead in another repo's tracker — would
 * otherwise fail the whole `bd create` at the dep, and losing the bead over the
 * provenance is the wrong way round. It is dropped with a warning instead.
 *
 * `endorsed` is decided by the caller, not here — `bin/file.js` asks
 * `autoEndorseAllowed` for the workspace it was given. It is reported back on the
 * result as well as applied, because the one thing the filing session must not do is
 * tell Adam his bead is waiting for a tap when it is not: the sentence the command
 * prints has to come from what actually happened, not from what the brief said would.
 *
 * **The home is resolved once, for the batch, and it is why this is where bc-rfnr.8
 * landed.** Every bead here shares one `from`, so they share one answer, and one
 * `bd export` for three discoveries beats three. It is also the honest place for the
 * decision: `beadToIssue` is the pure half and has no tracker to ask, and patching the
 * parent onto each caller in turn is precisely what bc-rfnr.8 said not to do. See
 * lib/homing.js — a workspace that cannot answer files the bead parentless, exactly as
 * it did before, and since bc-0i27.17 says out loud that that is what happened rather
 * than reporting a success over a bead nothing will ever draw.
 */
export async function fileBeads(
  bd,
  workspace,
  beads,
  { from = '', floor = PRIORITY_FLOOR, onWarn = () => {}, endorsed = false } = {}
) {
  let source = String(from || '').trim();
  if (source) {
    let known = false;
    try {
      known = await bd.exists(workspace, source);
    } catch {
      known = false;
    }
    if (!known) {
      onWarn(`${source} is not a bead in ${workspace.name || 'this workspace'} — filing without the ${DISCOVERED_FROM} edge`);
      source = '';
    }
  }

  // `onWarn` handed through so a tracker that could not be READ is reported on the
  // filing session's own stderr rather than only in the daemon log — bc-0i27.17, where
  // two of three beads filed minutes apart landed parentless and printed nothing at
  // all. `homeIn` says that one itself, because it is the only place that knows the
  // reason; everything below is about a tracker that answered.
  const home = await homeIn(bd, workspace, { from: source, onWarn });
  // `gated` and not merely `!parent`: on a workspace with no open root at all the gate
  // fails open and the bead is perfectly workable, so warning about a hold would be a
  // false claim printed at every filing. And `gated` is false on a failed export too,
  // which is why that case is warned about above and not here — the two are one
  // `{ parent: '', gated: false }` and only one of them is "there is nowhere to put it".
  // See lib/homing.js.
  if (!home.parent && home.gated) {
    onWarn(
      'nothing to hang this under — filing with no parent, which means nothing will work it until you ' +
        'adopt it under an epic at any priority (bc-rfnr.7). Label an open one `unsorted` and the next one lands there.'
    );
  }

  const filed = [];
  const failed = [];
  for (const bead of beads || []) {
    let issue = beadToIssue(bead, { from: source, floor, endorsed, home });
    try {
      /**
       * The parent is the one field this may drop rather than lose the bead over.
       *
       * Same trade as the `--from` check above, one field along: nothing here chose the
       * parent, `lib/homing.js` did, and a bead refused because of it is a discovery
       * gone. bd's hierarchy is its own — a P0 that is a crash `bug` rather than an epic
       * (lib/errors.js files one per daemon crash, and bc-rfnr.4 makes it dispatchable
       * directly, so a session *can* be working under one) is the shape most likely to
       * be refused a child. Rather than model bd's rules from out here, the refusal is
       * treated as the answer: file it where it would have gone before, and say so.
       *
       * Only when a parent was actually set, so an ordinary failure — a title bd will
       * not take, a lock race that outlived its four retries — still fails once and is
       * reported, rather than being tried a second time on its way to the same error.
       *
       * **This is a floor and it was doing a load-bearing job it should never have had.**
       * For a fortnight the one refusal it caught was `--parent X` colliding with
       * `--deps discovered-from:X` (see `withDiscoveredFrom`) — a shape this file was
       * building itself, on every filing by a session working a root, so what reads as a
       * last resort was the ordinary path for twenty-two beads. The collision is fixed
       * upstream of here; what stays is the floor, now reporting a reason a reader can
       * act on rather than the first line of its own command line.
       */
      let id = null;
      try {
        id = await bd.create(workspace, issue);
      } catch (err) {
        if (!issue.parent) throw err;
        onWarn(
          `${workspace.name || 'the tracker'} would not take "${issue.title}" under ${issue.parent} — ` +
            `${bdReason(err)}. Filing it with no parent instead, which means nothing will work it ` +
            'until you adopt it under an epic at any priority (bc-rfnr.7).'
        );
        // Rebuilt rather than patched: the notes carry a "Filed under <x>" sentence that
        // would be a lie on a bead filed under nothing, and a bead lying about its own
        // provenance is worse than one with no provenance at all.
        issue = beadToIssue(bead, { from: source, floor, endorsed, home: null });
        id = await bd.create(workspace, issue);
      }
      if (!id) throw new Error('bd create returned no id');
      filed.push({
        id,
        title: issue.title,
        priority: issue.priority,
        clamped: issue.clamped,
        endorsed,
        parent: issue.parent || null,
        duplicate: bead.duplicate || null,
      });
    } catch (err) {
      failed.push({ title: issue.title, error: bdReason(err) });
    }
  }
  return { filed, failed, from: source, endorsed, home };
}
