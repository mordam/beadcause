/**
 * The docket — an epic's whole arc on one page, in the order it happened.
 *
 * bc-it26z, and Adam's words for it: "the cards coming to me are sometimes hard to
 * understand quickly because a lot of context is missing." A card carries the bead and
 * nothing around it — title, description, decision block, thread. What it cannot say is
 * where the bead sits in the arc it belongs to: what was decided before it, what has
 * landed, what is in flight beside it, why it sat for four days. The only way out of a
 * card was `/graph?ws=…&id=…&open=1`, a force layout with no dates in it at all.
 *
 * So this is the read side of a page that answers those, and the shape was settled in
 * chat before a line of it was written:
 *
 *   - **It roots at the epic, and lights up the bead you came from.** One page per
 *     family, so the second card out of the same epic lands you on a page you have
 *     already read once rather than on a fresh wall of text.
 *   - **Everything dated, with the machine's own work folded away.** One stream. What
 *     was *decided* is always visible; what the machine did to itself is collapsed
 *     under a toggle, present but not competing.
 *   - **Reachable from every card, and browsable cold** through an index of epics.
 *
 * ## One `bd export`, and why not the one the daemon already has
 *
 * `Bd.graph` caches an export per workspace and every board in the app is drawn off it.
 * It is the wrong source here, and lib/ancestry.js's `indexFrom` says why in its own
 * comments: it deliberately keeps *slim* rows — no descriptions, no comments, notes only
 * on a root — because seven hundred bodies of prose in a shared cache for a minute is a
 * cost with no reader. The docket is made of exactly what that index throws away: the
 * timestamps, the close reasons and every comment.
 *
 * Widening `indexFrom` to carry them would put that cost on every inbox repaint to serve
 * a page that is opened a few times a day. So this keeps its own key with its own
 * window, paid only by somebody who actually opened a docket, and lib/history.js's
 * argument applies unchanged from there: swept once, filtered in process, so the whole
 * page — every fold, every bead in the family — costs one sweep between them.
 *
 * ## The root is the top of the family, not the nearest thing typed `epic`
 *
 * `issue_type` is what the filer chose and nothing enforces it: there are roots here of
 * type `feature`, `task` and `bug` with a dozen children under them, and there are beads
 * typed `epic` with none. What a person means by "the epic this card belongs to" is the
 * top of the tree it hangs from, so that is what `rootOf` walks to — through
 * `parent-child` edges only, and cycle-safe, both for lib/ancestry.js's reasons.
 *
 * A bead with no parent is its own root, and its docket is a family of one. That is a
 * real answer rather than a degenerate case: it says, correctly, that nothing else on
 * the tracker is part of this piece of work.
 *
 * ## What is visible and what is folded, and how each rule knows
 *
 * The fold is not a guess at whether a line is interesting. Each visible kind is tied to
 * the one place in this tree that writes the thing:
 *
 *   - **`ruled`** — the comment `Bd.respond` writes immediately before closing with
 *     `RULING_REASON` (lib/beadanswer.js, which holds the constant). Found by the clock
 *     rather than by author: the last comment at or before `closed_at` on a bead closed
 *     for that reason. Author cannot do it — see below — and `answerFromComments` needs
 *     the bead's decision block to beat "the last comment", where `closed_at` is
 *     evidence this file already has in its hand.
 *   - **`replied`** — a comment on a bead carrying `human-replied`. `/api/comment` in
 *     lib/server.js is the only thing that sets that label, and it sets it when you
 *     typed into the box on a card.
 *   - **`filed`**, **`closed`** — the bead's own `created_at` and `closed_at`, the
 *     close carrying its reason, which is the best writing in the tracker.
 *   - **`planned`** — a comment that parses as a plan (lib/plan.js). An epic's phases
 *     are a decision about the epic; they belong beside the rulings.
 *   - **`pr-opened`**, **`pr-merged`** — deliveries, joined from a pull request board
 *     that is already warm. Never one this page paid for; see `eventsOf`'s `prs`.
 *
 * Everything else folds: every other comment, the claim (`started_at`), and each
 * archived session run. Folded is not hidden — the events are in the payload, carry
 * `machine: true`, and the page draws them under a per-day toggle.
 *
 * **Author is not the test, and could not be.** lib/byline.js is explicit about it: a
 * daemon byline covers both your relayed tap *and* the daemon's own bookkeeping (merge
 * notes, salvage notes), and a bare address is either you at a terminal or an agent
 * whose shell exported your `BEADS_ACTOR` — "the two readings differ in the only way
 * that matters". So author is carried as a **voice** for the reader to weigh, and never
 * as the thing that decides what the page shows.
 */
import * as cache from './cache.js';
import { childrenFrom, PARENT_EDGE } from './ancestry.js';
import { planFrom } from './plan.js';
import { RULING_REASON } from './beadanswer.js';
import { REPLIED_LABEL } from './approvallabels.js';
import { bylineBase, bylineHandle, writtenByDaemon, AGENT_BYLINE_BASE } from './byline.js';

/**
 * How long a workspace's chronicle stays warm.
 *
 * Thirty seconds rather than the ledger's ten. A docket is *read*, not polled — you open
 * it from a card, scroll it, and go back to answer — and the thing being described is a
 * fortnight of work, where a row half a minute old changes nothing about the arc. Ten
 * seconds would re-sweep on a fold toggle that never leaves the page.
 */
export const CACHE_MS = 30_000;

/** The `<what>:<scope>` key convention is lib/cache.js's; the scope is the workspace. */
const PREFIX = 'docket:';
const keyFor = (name) => `${PREFIX}${name}`;

/**
 * Throw the chronicles away — one workspace, or all of them.
 *
 * For the tests and for `refresh=1`, the same two readers lib/history.js's `forget` has
 * and for the same reason: nothing here is a queue, so a bead that changed a moment ago
 * is still in the docket, at worst with a thirty-second-old status.
 */
export const forget = (workspace = null) => {
  if (workspace) cache.drop(keyFor(workspace));
  else cache.dropPrefix(PREFIX);
};

const text = (c) => String(c?.text ?? c?.body ?? c?.comment ?? '').trim();
const iso = (v) => {
  const s = String(v ?? '').trim();
  return s || null;
};

/**
 * `bd export` JSONL → `{ beads, parents }`, keeping what the docket is made of.
 *
 * The fields kept are the ones with a reader on the page and no more: the identity and
 * status a row draws, the three timestamps, the close reason, the labels the fold rules
 * read, and the comments. `description` is kept because the docket opens with the
 * epic's own account of itself — but only on a **root**, which is lib/ancestry.js's
 * `notes` trick and its argument: the page quotes one description, and holding seven
 * hundred of them for thirty seconds to do it is the cost that made this its own cache
 * in the first place.
 *
 * A line that does not parse is skipped rather than fatal. An export is written by
 * whichever `bd` this Mac has, and a page that refuses to draw an epic because one
 * unrelated record in the workspace is malformed would be the worse failure by far.
 */
export function chronicleFrom(jsonl) {
  const rows = [];
  const parents = new Map();
  for (const line of String(jsonl || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const id = String(row?.id || '').trim();
    if (!id) continue;
    rows.push(row);
    for (const dep of Array.isArray(row.dependencies) ? row.dependencies : []) {
      if (dep?.type !== PARENT_EDGE) continue;
      const from = String(dep.issue_id || '').trim();
      const to = String(dep.depends_on_id || '').trim();
      if (!from || !to || from === to) continue;
      parents.set(from, to);
    }
  }

  // A second pass, because whether a row is a root is only knowable once every edge in
  // the file has been read — the parent edge for `bc-x.1` may be written on the line
  // after it, or on the parent's own row.
  const beads = new Map();
  for (const row of rows) {
    const id = String(row.id).trim();
    const root = !parents.has(id);
    beads.set(id, {
      id,
      title: row.title || '',
      status: row.status || 'open',
      priority: row.priority ?? null,
      issue_type: row.issue_type || '',
      assignee: row.assignee || '',
      owner: row.owner || '',
      labels: Array.isArray(row.labels) ? row.labels : [],
      createdAt: iso(row.created_at),
      startedAt: iso(row.started_at),
      closedAt: iso(row.closed_at),
      updatedAt: iso(row.updated_at),
      closeReason: String(row.close_reason || '').trim(),
      // See the header: one description, on the root, because that is the one the page
      // quotes. A child's own prose is a tap away on its card and on /graph.
      description: root ? String(row.description || '') : '',
      notes: root ? String(row.notes || '') : '',
      comments: (Array.isArray(row.comments) ? row.comments : [])
        .filter(Boolean)
        .map((c) => ({ at: iso(c.created_at), author: String(c.author || ''), text: text(c) }))
        .filter((c) => c.at || c.text),
    });
  }
  return { beads, parents };
}

/**
 * The top of the family a bead hangs from — itself, when it hangs from nothing.
 *
 * Cycle-safe, and not as a formality: lib/ancestry.js's `ancestorsOf` carries the whole
 * argument, and it applies here word for word. An unguarded walk meets a cycle by
 * hanging the daemon, and this one runs on the request path.
 *
 * `''` for an id nothing knows about, which the route turns into an honest 404 rather
 * than an empty page.
 */
export function rootOf(parents, id) {
  let at = String(id || '').trim();
  if (!at) return '';
  const seen = new Set([at]);
  for (;;) {
    const up = parents?.get?.(at);
    if (!up || seen.has(up)) return at;
    seen.add(up);
    at = up;
  }
}

/**
 * Every bead in a root's family, depth-first, oldest first within a level.
 *
 * **Oldest first, and this is the one ordering decision on the page.** lib/ancestry.js's
 * `treeUnder` sorts done-last for the P0 board, which is right for a board — a board is
 * a list of what to do next. A docket is the opposite question. It is read to find out
 * how the work went, so its tree reads in the order the work was filed, and a bead that
 * closed in June keeps the place it had.
 *
 * Cycle-safe by the same seen-set, for the same reason as `rootOf`.
 */
export function familyOf({ beads, parents }, rootId) {
  const root = String(rootId || '').trim();
  if (!root || !beads?.has?.(root)) return [];
  const children = childrenFrom(parents);
  const out = [];
  const seen = new Set([root]);
  // Numeric collation on the tiebreak, for lib/ancestry.js's `byDoneThenId` reason: bd's
  // own ids run `bc-goo.1` to `bc-goo.10`, and a plain string sort files the tenth child
  // between the first and the second.
  const oldestFirst = (a, b) =>
    String(a.createdAt || '').localeCompare(String(b.createdAt || '')) ||
    String(a.id).localeCompare(String(b.id), 'en', { numeric: true });

  const push = (bead, depth, parent) => out.push({ ...bead, depth, parent });
  push(beads.get(root), 0, null);
  const walk = (parent, depth) => {
    const kids = (children.get(parent) || [])
      .filter((id) => !seen.has(id) && beads.has(id))
      .map((id) => beads.get(id))
      .sort(oldestFirst);
    for (const kid of kids) {
      seen.add(kid.id);
      push(kid, depth, parent);
      walk(kid.id, depth + 1);
    }
  };
  walk(root, 1);
  return out;
}

/**
 * What a byline says about who spoke, as a word the page can print beside a line.
 *
 * Three voices and one of them is honest about not knowing, which is the point. See the
 * header: this decides nothing about what the page *shows*.
 *
 *   - `agent` — the byline lib/byline.js reserves for a session beadcause started.
 *   - `daemon` — a beadcause byline, any install's. Your relayed tap looks like this,
 *     and so does the daemon's own bookkeeping.
 *   - `person` — anything else, which is an address typed somewhere. Might be you at a
 *     terminal; might be an agent's shell before bc-y3qk.1 gave agents a byline.
 *
 * `writtenByDaemon` rather than a comparison of my own, so an install that renamed its
 * actor is recognised here exactly as it is by the reply test in lib/server.js — two
 * spellings of "is this our daemon" would eventually disagree about one comment.
 */
export function voiceOf(author, cfg = null) {
  const base = bylineBase(author);
  if (!base) return { voice: 'person', who: '' };
  if (base === AGENT_BYLINE_BASE) return { voice: 'agent', who: bylineHandle(author) || '' };
  if (writtenByDaemon(author, cfg)) return { voice: 'daemon', who: bylineHandle(author) || '' };
  return { voice: 'person', who: base.split('@')[0] || base };
}

/** The comment that carried a ruling — the last one at or before the close. See header. */
export function rulingComment(bead) {
  if (bead?.closeReason !== RULING_REASON) return null;
  const at = bead.closedAt || '';
  let found = null;
  for (const c of bead.comments || []) {
    if (!c.text) continue;
    if (at && c.at && c.at > at) continue;
    found = c;
  }
  return found;
}

/** How many characters of a comment ride in the stream. The rest is a tap away. */
export const EVENT_TEXT_MAX = 600;

const clip = (s) => {
  const str = String(s || '').trim();
  return str.length > EVENT_TEXT_MAX ? `${str.slice(0, EVENT_TEXT_MAX)}…` : str;
};

/**
 * Everything dated in a family, oldest first — the stream the page is built around.
 *
 * `machine` is the fold, and the header says which rule puts each kind on which side.
 * Nothing is dropped: a folded event is in this array with `machine: true`, because the
 * question "why did this sit for four days" is answered by exactly the lines a stream
 * that dropped them could not show.
 *
 * **`prs` is a board this page did not pay for.** A pull request sweep is `gh` over
 * every repo and is the most expensive thing in the app; a docket that triggered one
 * would take a page opened from a card into the tens of seconds. So the caller passes
 * whatever board is already warm, and `null` and `[]` stay different answers the way
 * public/app.js's `p0PrsFor` keeps them: `[]` is "the board is in hand and no pull
 * request names this family", `null` is "nobody has swept, so this page cannot say".
 * That travels out as `prs` on the payload rather than being flattened here.
 *
 * `sessions` is the same contract, from the archive refs: `Map(beadId → [{at, subject}])`.
 */
export function eventsOf(family, { prs = null, sessions = null, cfg = null } = {}) {
  const out = [];
  const add = (e) => {
    if (!e.at) return;
    out.push(e);
  };

  for (const bead of family) {
    const on = { bead: bead.id, beadTitle: bead.title };
    add({ ...on, at: bead.createdAt, kind: 'filed', machine: false });
    add({ ...on, at: bead.startedAt, kind: 'claimed', machine: true, who: bead.assignee || '' });

    const ruling = rulingComment(bead);
    for (const c of bead.comments) {
      const { voice, who } = voiceOf(c.author, cfg);
      const plan = planFrom([c]);
      if (plan) {
        add({
          ...on,
          at: c.at,
          kind: 'planned',
          machine: false,
          voice,
          who,
          groups: plan.groups.map((g) => ({ name: g.name, beads: g.beads })),
        });
        continue;
      }
      const isRuling = ruling && c === ruling;
      const isReply = !isRuling && (bead.labels || []).includes(REPLIED_LABEL);
      add({
        ...on,
        at: c.at,
        kind: isRuling ? 'ruled' : isReply ? 'replied' : 'commented',
        machine: !isRuling && !isReply,
        voice,
        who,
        text: clip(c.text),
      });
    }

    add({
      ...on,
      at: bead.closedAt,
      kind: 'closed',
      machine: false,
      reason: bead.closeReason,
      ruled: bead.closeReason === RULING_REASON,
    });

    for (const run of sessions?.get?.(bead.id) || []) {
      add({ ...on, at: run.at, kind: 'session', machine: true, text: clip(run.subject), commit: run.commit });
    }
  }

  const ids = new Set(family.map((b) => b.id));
  for (const pr of prs || []) {
    // Tolerant of a bare string as well as `{ id, … }`, because lib/beadref.js has
    // written both and a board warmed by an older daemon is still a board.
    const named = (pr.beads || [])
      .map((b) => (typeof b === 'string' ? b : b?.id))
      .filter((id) => id && ids.has(id));
    if (!named.length) continue;
    // **One line per pull request, hung on the first bead in this family that it names.**
    // A delivery that closes three siblings is one event in the story, not three, and the
    // number on the line is what a reader follows to see the whole of it. Which of the
    // three it hangs on is the family's own order, which is the order they were filed.
    const on = { bead: named[0], beadTitle: '', number: pr.number, url: pr.url, repo: pr.repoName || '' };
    add({ ...on, at: iso(pr.createdAt), kind: 'pr-opened', machine: false, text: pr.title || '' });
    add({ ...on, at: iso(pr.mergedAt), kind: 'pr-merged', machine: false, text: pr.title || '' });
  }

  // Oldest first: a docket is read forwards. Ties broken by kind so a bead filed and
  // closed in the same second never draws its close above its filing.
  const rank = { filed: 0, claimed: 1, planned: 2, commented: 3, replied: 3, ruled: 4, session: 5, 'pr-opened': 6, 'pr-merged': 7, closed: 8 };
  out.sort(
    (a, b) => String(a.at).localeCompare(String(b.at)) || (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9)
  );
  return out;
}

/** Every label the page counts a bead by, spelled where the thing that sets it is named. */
const HUMAN_LABEL = 'human';
const UNENDORSED_LABEL = 'unendorsed';

/**
 * Where the epic has got to — the line the page opens with.
 *
 * Counts rather than a percentage. "9 of 24 closed" is a fact; a bar at 37% invites the
 * reading that the remaining 63% is the same size as the first, which on a tracker where
 * one bead can be a fortnight is exactly the thing not to imply.
 *
 * `asking` and `held` are counted separately from `open` because they are the two states
 * that are **waiting on you** rather than on work — a bead carrying `human` is a card in
 * your inbox, and one carrying `unendorsed` cannot be claimed by anybody until you say
 * so (lib/endorse.js). An epic that looks stalled is usually one of those two.
 */
export function progressOf(family) {
  const counts = { total: 0, open: 0, in_progress: 0, blocked: 0, closed: 0, asking: 0, held: 0 };
  let first = '';
  let last = '';
  for (const bead of family) {
    counts.total += 1;
    if (counts[bead.status] !== undefined) counts[bead.status] += 1;
    const labels = bead.labels || [];
    if (bead.status !== 'closed' && labels.includes(HUMAN_LABEL)) counts.asking += 1;
    if (bead.status !== 'closed' && labels.includes(UNENDORSED_LABEL)) counts.held += 1;
    for (const at of [bead.createdAt, bead.closedAt, bead.updatedAt]) {
      if (!at) continue;
      if (!first || at < first) first = at;
      if (!last || at > last) last = at;
    }
  }
  return { counts, firstAt: first || null, lastAt: last || null };
}

/**
 * One docket, from a chronicle already in hand — the whole of the page, as data.
 *
 * Pure, so the suite can assert every rule above against a string of JSONL with no
 * tracker and no daemon behind it. `docket` below is the eight lines that spawn `bd
 * export` and cache it.
 *
 * `null` for an id the workspace has never had. The route turns that into a 404 with the
 * id in it, which is the one thing a reader who followed a stale link needs to be told.
 */
export function docketFrom(chronicle, id, { prs = null, sessions = null, cfg = null } = {}) {
  const asked = String(id || '').trim();
  if (!chronicle?.beads?.has?.(asked)) return null;
  const rootId = rootOf(chronicle.parents, asked);
  const family = familyOf(chronicle, rootId);
  const root = family[0] || chronicle.beads.get(asked);
  return {
    root: {
      id: root.id,
      title: root.title,
      status: root.status,
      priority: root.priority,
      issue_type: root.issue_type,
      description: root.description,
      notes: root.notes,
      labels: root.labels,
    },
    // Which bead you arrived on. The page lights it up; it is not necessarily the root.
    focus: asked,
    family: family.map(({ comments, description, notes, ...rest }) => rest),
    plan: planFrom(chronicle.beads.get(rootId)?.comments || []),
    events: eventsOf(family, { prs, sessions, cfg }),
    progress: progressOf(family),
    // See `eventsOf`: whether anybody has swept the pull requests at all. The page says
    // "no delivery yet" only when this is true; over `false` it says it does not know,
    // because "the board is in hand and names none" and "nobody has looked" are
    // different sentences and only one of them is about this epic.
    prsKnown: prs !== null,
  };
}

/**
 * The epics a workspace has, newest activity first — the index you browse cold.
 *
 * A root with no children is not an epic and is left out: its docket is a family of one,
 * which is a real page (a card links straight to it) and a useless row in a list of
 * hundreds. Closed roots are kept, because the index is a record and "what did we
 * finish" is half of what anyone opens it for; the row says so and the page filters.
 */
export function epicsFrom(chronicle) {
  const children = childrenFrom(chronicle.parents);
  const out = [];
  for (const [id, bead] of chronicle.beads) {
    if (chronicle.parents.has(id)) continue;
    if (!(children.get(id) || []).length) continue;
    const family = familyOf(chronicle, id);
    const { counts, firstAt, lastAt } = progressOf(family);
    out.push({
      id,
      title: bead.title,
      status: bead.status,
      priority: bead.priority,
      issue_type: bead.issue_type,
      labels: bead.labels,
      counts,
      firstAt,
      lastAt,
    });
  }
  out.sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')) || a.id.localeCompare(b.id));
  return out;
}

/**
 * One workspace's chronicle, and how old it is — the envelope, not the maps.
 *
 * `refresh` reaches the layer unchanged and means what it means everywhere else here:
 * skip what is kept, pay the sweep, the reader asked for it. It still joins one already
 * in flight rather than starting a second, which is the right reading — an export that
 * began a moment ago is reading the same tracker.
 */
export const chronicle = (bd, ws, { refresh = false, now = () => Date.now() } = {}) =>
  // Two retries, `Bd`'s own `SWEEP_RETRIES` — a read that lost a Dolt lock is worth
  // trying again and is not worth a write's four.
  cache.read(keyFor(ws.name), async () => chronicleFrom(await bd.run(ws, ['export'], { retries: 2 })), {
    freshMs: CACHE_MS,
    now,
    refresh,
  });
