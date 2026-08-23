/**
 * A root closed over open work, and until now nothing anywhere said so.
 *
 * bc-xl7n.107. `rootsOf` (lib/underroot.js) counts only *open* roots, and that decision is
 * argued out in that file and is not in question here: a child left open under a finished
 * epic must not be dispatched all night while being invisible on the phone. The cost it
 * names — "the first time an epic closes over an open child, that child stalls" — was
 * supposed to be a stall you can see. It is not. The bead stays open, keeps its title, its
 * priority and its labels, and reads as ordinary work on every screen there is; the only
 * difference is that `withoutOrphans` drops it out of the advocate's queue and
 * `assertUnderRoot` refuses it 409 at every launcher. No log line, no card, no count.
 *
 * Three measured instances, all of them beads that were homed *correctly* at filing time:
 * bc-b4fs.1, bc-ysqd.1 (bc-ysqd closed on #489 four minutes after its own worker filed the
 * child under it) and bc-ibt8g.1 (bc-ibt8g closed on #571). Each surfaced only because an
 * Epic Advocate ran a census by hand off `bd export`, and each would otherwise have sat
 * there indefinitely. Since #402 fixed the other source — a daemon filing with no parent at
 * all — this is the whole remaining inflow to the unsorted backlog.
 *
 * ## Why this is a sweep and not a hook on the close
 *
 * The same argument lib/epicdone.js makes, and for once it is not being reused loosely: it
 * is the identical event. A close happens in four places and only one of them is in this
 * process — a tap on this app, `bd close` typed at a terminal on this Mac, a worker session
 * an advocate opened, or the same arriving over `bd dolt pull` from the other Mac — and bd
 * has no pre-close hook to teach. `Bd.close` would have caught the two instances above
 * (both were merge-queue closes) and it would have caught neither a hand close nor
 * `bin/deliver.js`, which is a separate process shelling out to `bd` and cannot import a
 * `Bd` at all (the five close call sites are lib/server.js `finishWorkBead`, lib/landed.js,
 * lib/owed.js, lib/mergequeue.js and `bin/deliver.js`, and only the first three share a
 * funnel). There is no call site to hook, only a row that changes.
 *
 * ## State, not a transition — the one place this deliberately differs from lib/epicdone.js
 *
 * That file compares against what the last sweep saw, and accepts losing an epic that
 * closed while the daemon was down: "a chime for something that finished yesterday is
 * noise". The opposite is true here. A chime is over in a second; a stranded bead is
 * permanent, and the whole complaint is that nothing ever comes back for it. A watcher that
 * only fired on a transition it happened to be awake for would go quiet across exactly the
 * restart that a merge-and-deploy causes.
 *
 * So the question asked is *"is this bead unworkable right now, and was a root closing what
 * did it"*, which is answerable from one graph read with no history at all — and the
 * duplicate-suppression a transition would have given for free is bought instead the way
 * lib/landed.js buys it, by reading the thread and looking for the sentence we are about to
 * write again (`alreadySaid`). That read is paid once per bead per daemon run, because an
 * in-memory ledger remembers what this process has already traced.
 *
 * ## What counts as stranded, and the two things that deliberately do not
 *
 * `hasRootAbove` verbatim, so what this reports and what the dispatcher refuses can never
 * disagree — including its fail-open, which is what makes an unreadable graph produce no
 * strandings rather than a comment on every bead in the tracker.
 *
 * **A bead with no ancestors at all is not stranded**, it was never rooted, and since
 * bc-xl7n.25 was answered on 2026-08-21 a parentless person-filed bead stays parentless on
 * purpose. Requiring a *closed root* somewhere in the chain is exactly the discriminator
 * between the two populations, and it is why this file walks upwards from the bead rather
 * than downwards from the close.
 *
 * **A superseded bead is not stranded either.** It is being tidied away rather than left
 * behind, lib/superseded.js already raises a card for it, and "adopt it under an epic" is
 * the wrong instruction for a bead whose ending is a close. An **unendorsed** one, by
 * contrast, is traced like any other, and that is the acceptance criterion of the bead this
 * file is for: unendorsed is the case no other mechanism can see, because it never reaches
 * the queue for `heldByNoRoot` to count it (bc-xl7n.83).
 *
 * ## What it writes
 *
 * A comment on each stranded bead naming the root that closed and the one edit that undoes
 * it, and one on the closing root listing what it left behind. Both end in a fixed sentence
 * — `STRANDED_MARK` and `STRANDING_MARK` — which is what makes them greppable and what
 * `alreadySaid` matches, so the wording above those lines can be improved later without the
 * sweep re-commenting on every bead in the tracker.
 *
 * Naming ids in the prose means `Bd.comment` draws a `relates-to` on the way past. Between
 * a root and its own child that is refused as already `parent-child` and skipped; between a
 * root and a *grandchild* it is a new see-also, and a link from a closed root to a bead it
 * stranded is a true and useful one, so it is left to happen rather than worked around.
 *
 * No `CONFIG_DIR` file and no `refs/beadcause` ref, so there is nothing for lib/evidence.js
 * to claim: the ledger is a `Set` that dies with the process, and everything durable this
 * writes is a bead comment in the tracker.
 */

import { ancestorsOf } from './ancestry.js';
import { isRoot } from './ownership.js';
import { isSuperseded } from './superseded.js';
import { hasRootAbove, NO_ROOT_ABOVE } from './underroot.js';

/** The sentence at the foot of the note on a stranded bead. What `alreadySaid` matches. */
export const STRANDED_MARK = 'left unworkable by a root closing above it';

/** The sentence at the foot of the note on the root that did it. */
export const STRANDING_MARK = 'closing this left open work with nothing decided above it';

/**
 * How many beads one pass will comment on, across every workspace.
 *
 * Not a rate limit on a hot path — in a healthy tracker this sweep writes nothing at all,
 * for days. It is a bound on the one bad day: an import that closes a hundred roots, or a
 * `bd` that reports half the graph closed, would otherwise spray a comment onto every
 * descendant in the workspace before anybody could stop it. What is left over is not
 * dropped — the ledger only remembers what was actually written, so the next pass takes the
 * next batch — and `capped` in the outcome says out loud that a pass was cut short.
 */
export const TRACE_CAP = 25;

/** How many stranded beads the note on the root names before it stops listing them. */
const LIST_CAP = 20;

const lower = (s) => String(s || '').trim().toLowerCase();
const isClosed = (row) => lower(row?.status) === 'closed';
const wsName = (workspace) => String(workspace?.name || workspace?.dir || '').trim();
const byId = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });

/**
 * Every bead in this index that a root closing has made unworkable, grouped by the root.
 *
 * One pass over the beads walking upwards, rather than a pass per closed root walking down,
 * for `descendantsOf`'s reason: the export gives child → parent, and the question is being
 * asked of every bead anyway.
 *
 * The root a bead is attributed to is the **nearest** closed root above it, because
 * `ancestorsOf` answers nearest-first and the nearest one is the close that most recently
 * made the bead's situation what it is. A chain with two closed roots in it is one
 * stranding, not two.
 *
 * The three tests are in cost order and the ordering is deliberate: `hasRootAbove` rebuilds
 * the whole root set on every call, so asking it about every bead in the workspace is a
 * pass over the tracker per bead, on every beat of the poll cycle. Everything cheap runs
 * first — a status, a label, an upward walk of two or three links — and by the time the
 * expensive question is asked, the candidates are the handful of beads that actually have a
 * closed root over them. It is the same question either way; only the order changes.
 */
export function strandingsIn(index) {
  const beads = index?.beads;
  const parents = index?.parents;
  if (!beads?.values || index?.error) return [];
  const byRoot = new Map();
  for (const row of beads.values()) {
    if (!row?.id || isClosed(row)) continue;
    if (isSuperseded(row)) continue;
    const root = ancestorsOf(parents, row.id).find((a) => {
      const up = beads.get(a);
      return up && isRoot(up) && isClosed(up);
    });
    // No closed root above it: this bead was never rooted, which is a different bead
    // (bc-xl7n.25) with a different and already-decided answer. Not ours.
    if (!root) continue;
    // And the last word is the gate's own, so what this reports and what the dispatcher
    // refuses cannot disagree — including its fail-open, which is what keeps a workspace
    // with no open roots at all, and a graph that could not be read, silent.
    if (hasRootAbove(index, row.id)) continue;
    let group = byRoot.get(root);
    if (!group) {
      group = { root, title: beads.get(root)?.title || '', stranded: [] };
      byRoot.set(root, group);
    }
    group.stranded.push({ id: row.id, title: row.title || '', status: lower(row.status) || 'open' });
  }
  for (const group of byRoot.values()) group.stranded.sort((a, b) => byId(a.id, b.id));
  return [...byRoot.values()].sort((a, b) => byId(a.root, b.root));
}

/** The note left on a bead a close has made unworkable. */
export function strandedNote(root, rootTitle, bead) {
  const named = String(rootTitle || '').trim() ? `${root} ("${String(rootTitle).trim()}")` : root;
  return [
    `**${root} closed, and this bead went unworkable with it.**`,
    '',
    `${named} was the only root above ${bead.id}. A closed root is not a root ` +
      `(lib/underroot.js), so there is now ${NO_ROOT_ABOVE}: the advocate drops this bead out ` +
      'of the ready queue and every session launcher refuses it 409. Nothing about it looks ' +
      'any different on any screen, and nothing clears it on its own.',
    '',
    'Adopt it under an open epic at any priority — or raise a P0 — and it is workable again ' +
      'with no other change. If the work is finished or no longer wanted, close it: leaving ' +
      'it open is the one ending nothing will ever come back for.',
    '',
    `— ${STRANDED_MARK}, noticed by lib/rootclose.js`,
  ].join('\n');
}

/** The note left on the root, listing what it left behind. */
export function strandingNote(group) {
  const rows = group?.stranded || [];
  const shown = rows.slice(0, LIST_CAP);
  const rest = rows.length - shown.length;
  const lines = [
    `**Closing this left ${rows.length} open bead(s) under it with ${NO_ROOT_ABOVE}.**`,
    '',
    ...shown.map((b) => `- ${b.id} (${b.status}) — ${String(b.title || '').trim() || 'untitled'}`),
  ];
  if (rest > 0) lines.push(`- …and ${rest} more`);
  lines.push(
    '',
    'The close itself is not in question — the work landed. But a closed root is not a root ' +
      '(lib/underroot.js), so each of these is now out of the ready queue and refused at ' +
      'every session launcher, while still reading as ordinary open work everywhere it is ' +
      'drawn. Each carries the same note.',
    '',
    'Adopting them under an open epic — at any priority — is the whole of the fix.',
    '',
    `— ${STRANDING_MARK}, noticed by lib/rootclose.js`
  );
  return lines.join('\n');
}

/**
 * Has this bead already been told? lib/landed.js's `alreadyLanded`, mark for mark.
 *
 * A tracker that will not answer is **not** evidence either way, and the safe reading of
 * "I cannot tell whether I already said this" is to say nothing: a duplicate note on a bead
 * is worse than a late one, because the late one still arrives.
 */
async function alreadySaid(bd, workspace, id, mark) {
  let comments;
  try {
    // The workspace **object**, never its name: `Bd.run` asserts the shape and throws on a
    // bare string, which would turn a duplicate guard into a sweep that cannot read at all.
    comments = await bd.comments(workspace, id);
  } catch {
    return true;
  }
  return (comments || []).some((c) => String(c?.text || c?.body || c?.comment || '').includes(mark));
}

/**
 * The watcher the poll cycle ticks — one per daemon, holding what it has already said.
 *
 * Shaped like `createEpicWatch` in lib/epicdone.js: the work lives in a module that returns
 * an **outcome** rather than throwing, so anything that does reach the cycle's catch is the
 * cycle's own bookkeeping, which is the bar `sweepFailed` is for.
 *
 * The ledger holds beads this process has traced, so the `bd comments` read that suppresses
 * a duplicate across a restart is paid once per bead rather than once per tick. It is never
 * pruned: an entry is one short string, and it can only grow by one per bead this daemon
 * has actually written a comment on.
 */
export function createStrandWatch({ bd }) {
  const said = new Set();
  const key = (ws, id) => `${ws} :: ${id}`;

  /**
   * One pass over every workspace. Never throws.
   *
   * `traced` is the beads that were told, `roots` the closes that were told on, `errors` is
   * for the log, and `capped` names a workspace whose pass was cut short by `TRACE_CAP` —
   * which is the difference between a bound and a silent truncation.
   */
  async function sweep(workspaces = []) {
    const out = { traced: [], roots: [], errors: [], capped: [] };
    let budget = TRACE_CAP;
    for (const workspace of workspaces || []) {
      const name = wsName(workspace);
      if (!name) continue;
      let index;
      try {
        index = await bd.graph(workspace);
      } catch (err) {
        out.errors.push({ workspace: name, error: String(err?.message || err).split('\n')[0] });
        continue;
      }
      // An export that timed out comes back as an empty index carrying `.error` rather than
      // as a throw — lib/epicdone.js's trap, and here it would read as every bead in the
      // workspace having lost its root at once.
      if (index?.error) {
        out.errors.push({ workspace: name, error: String(index.error).split('\n')[0] });
        continue;
      }

      for (const group of strandingsIn(index)) {
        let told = 0;
        let cut = false;
        for (const bead of group.stranded) {
          if (said.has(key(name, bead.id))) continue;
          if (budget <= 0) {
            if (!out.capped.includes(name)) out.capped.push(name);
            cut = true;
            break;
          }
          if (await alreadySaid(bd, workspace, bead.id, STRANDED_MARK)) {
            said.add(key(name, bead.id));
            continue;
          }
          try {
            await bd.comment(workspace, bead.id, strandedNote(group.root, group.title, bead));
          } catch (err) {
            out.errors.push({ workspace: name, id: bead.id, error: String(err?.message || err).split('\n')[0] });
            continue;
          }
          said.add(key(name, bead.id));
          budget -= 1;
          told += 1;
          out.traced.push({ workspace: name, id: bead.id, root: group.root, title: bead.title });
        }
        // The note on the root goes in only when this pass actually told somebody, so a
        // workspace whose strandings are all old news stays silent — and it is written after
        // the children rather than before, so a root that says "each carries the same note"
        // is telling the truth by the time anybody reads it. Which is also why a group the
        // cap cut short waits for the next pass: the sentence would be false today and true
        // in a minute, and a note that has to be re-read to become true is worse than a late
        // one. The children it did reach keep their own notes either way.
        if (!told || cut) continue;
        if (said.has(key(name, group.root))) continue;
        if (await alreadySaid(bd, workspace, group.root, STRANDING_MARK)) {
          said.add(key(name, group.root));
          continue;
        }
        try {
          await bd.comment(workspace, group.root, strandingNote(group));
        } catch (err) {
          out.errors.push({ workspace: name, id: group.root, error: String(err?.message || err).split('\n')[0] });
          continue;
        }
        said.add(key(name, group.root));
        out.roots.push({ workspace: name, id: group.root, title: group.title, stranded: group.stranded.length });
      }
    }
    return out;
  }

  return { sweep };
}
