/**
 * Current sessions — what every agent is on, across every workspace.
 *
 * The inbox answers "what needs *me*". This answers the other question — what did
 * the sessions I'm not watching get up to — which until now was invisible from the
 * phone: a bead only reaches the inbox if it carries the `human` label, so nine
 * beads claimed in sophab five minutes ago showed up nowhere at all.
 *
 * A session shows up here through either of two independent signals, and it matters
 * that they are independent:
 *
 * - **A claimed bead** — `status = in_progress`. This is the signal every session
 *   already emits, because claiming work *is* `bd update --claim`; it needs no
 *   cooperation from the agent, no hook, and no beadcause-specific convention. Live
 *   phase and detail (status.json, `/api/status`) layer on where they exist, but
 *   their absence is normal rather than a gap — most sessions never post one. This
 *   is the half that says *which bead*.
 * - **A live Claude Code process** — see lib/claude.js. This is the half that catches
 *   a session which has claimed nothing, and so appears nowhere in the tracker.
 *
 * They are reported side by side and never merged: nothing on this machine records
 * which bead a given process is on, so pairing them would be a guess dressed up as
 * a fact. A workspace with two sessions and no claimed bead is a real and useful
 * thing to see, and it is precisely what a guess would have hidden.
 */
import { PHASES } from './activity.js';
import { ancestorsOf } from './ancestry.js';
import * as cache from './cache.js';
import { filedWhileTarget } from './filing.js';

/**
 * Trim `adam.morgan@climative.ai` down to something that fits a phone.
 *
 * A byline is shortened *inside* the parenthesis rather than at the first `@` it finds:
 * `bd update --claim` writes the assignee straight off `BEADS_ACTOR`, so since bc-y3qk.1
 * an agent's claim reads `agent (carol@example.com)` and the naive split cut it to
 * `agent (carol` — an unclosed bracket on the work screen and the graph sheet. The same
 * was already true of anything a daemon claimed as `beadcause (carol@example.com)`;
 * nobody had looked, because until agents signed this way it was rare.
 */
export const shortActor = (s) => {
  const str = String(s || '').trim();
  const m = /^(.*?)\s*\(([^()]*)\)$/.exec(str);
  if (m) {
    const who = m[2].split('@')[0].trim();
    return who ? `${m[1].trim()} (${who})` : m[1].trim();
  }
  return str.split('@')[0] || '';
};

/**
 * How long a workspace's four `bd` calls stay warm — bc-1kwl.7.
 *
 * Ten seconds, the ledger's own window and the ledger's own argument: this screen is
 * opened rather than polled (see the header on `/api/work` in lib/server.js), so
 * nothing here is racing a 25-second long-poll the way the inbox is, and a claim that
 * is ten seconds old is still the claim. Measured at up to 7s per workspace and 120s
 * total under bc-1kwl.1, on a screen `window.beadcause.stream.workMoved` refetches the
 * moment a bus event says work moved — this is what turns a burst of those refetches
 * from N sweeps into one.
 */
const WORK_FRESH_MS = 10_000;

/**
 * One workspace's key on the shared layer, exported so the warmer can *peek* it.
 *
 * bc-1kwl.4 needs to answer "is anything kept for this row yet?" without producing
 * anything, and the honest place for the spelling of a key is the module that reads it
 * — a warmer holding its own copy of `work:${name}` is two files that have to agree
 * about a string, which is the way a prefix convention quietly stops meaning anything.
 */
export const workKey = (name) => `work:${name}`;

/**
 * How many beads held for endorsement the row carries, as rows rather than as a count.
 *
 * The count was always here — `counts.held`, the `N held for endorsement` pill — and the
 * rows behind it were thrown away, because until bc-8t3b the only thing that wanted them
 * was a screen of their own. The advocate console wants them now: an endorsement is a
 * decision *this repo's advocate is waiting on*, and it belongs on the card that is
 * otherwise a complete account of what that advocate is doing.
 *
 * **They cost nothing.** `bd.readyHeld` already ran — it is one of `sweep`'s four calls,
 * and it has to, because `ready` is a lie until the held beads come out of it. So this is
 * a projection of a list already in hand, and the objection that killed a held count in
 * the phone's chrome (public/index.html: a `bd list --label unendorsed` per workspace per
 * poll) does not apply here at all.
 *
 * **Which also fixes what the list means, and it is worth saying rather than discovering.**
 * These are `readyHeld`'s beads — `bd ready --label unendorsed`, minus the ship beads — so
 * a held bead that is *blocked* is not among them, where lib/endorsequeue.js's queue asks
 * `listLabel` and draws open, in_progress and blocked alike. That is not a narrower answer
 * to the same question, it is the answer to *this card's* question: these rows are the
 * ones behind `counts.held`, the number the `N held for endorsement` pill on this very row
 * already quotes, and a section that disagreed with the pill six inches above it would be
 * the worse of the two errors. The complete list is one tap away and always was.
 *
 * Capped anyway, because the one thing an endorsement backlog does is grow: a workspace
 * nobody has looked at for a fortnight is exactly where this list gets long, and the row
 * repaints every twenty seconds across every workspace at once. What is over the cap is
 * the difference between `counts.held` and `heldRows.length`, which the card says out
 * loud — a truncation nobody is told about is the one that makes a screen lie.
 */
export const HELD_ROWS_MAX = 100;

/**
 * One held bead, slim, with the chain of epics above it.
 *
 * `under` is what makes the subcard possible and it is the whole of what this file knows
 * about advocates, which is nothing: the parent chain is a fact about the graph, and
 * *which* of those ancestors has an advocate assigned is a fact about the roster, which
 * lives on the advocate snapshot and is joined in the browser (`heldByAdvocate` in
 * public/monitor.js). Deciding it here would mean this module reading `epicAdvocates`,
 * and the two halves of that answer arrive in the same payload from two different
 * producers — so the join belongs where both are already on hand.
 *
 * Nearest first, because that is the order the join wants: an advocate on the bead's own
 * epic owns it over one on the P0 three levels up.
 *
 * `bd ready --json` carries the whole description and none of it is drawn here. A row is
 * a title, an id and a link, on a card that already has fourteen sections — the argument
 * for the fat rows on /endorse (lib/endorsequeue.js: you are being asked to spend an hour
 * of agent, and a decision made off a title is a rubber stamp) is an argument about the
 * screen where the decision is *made*, and this one is a door to that screen.
 *
 * **`under` prefers the filer stamp over the bead's own position, when one was left —
 * bc-xl7n.76.1.** Before this it always walked `ancestorsOf(parents, r.id)`: the chain
 * above wherever the bead sits *now*, which reads a hand-adopted bead exactly like one an
 * epic's own worker filed there — the whole gap bc-w156.2 named. `filed-while:<bead>`
 * (lib/filing.js) is written once, at file time, from the bead that was actually being
 * worked, so where it exists the chain is walked from *that* bead instead — and the
 * stamped bead is included in it, not just its ancestors, because an EpicAdvocate
 * planning its own epic files straight under it (bc-xl7n.65) and the epic is then the
 * nearest thing above its own production. A bead with no stamp — filed before this
 * landed, or filed through a path that never carried one — falls back to the ancestry
 * walk exactly as before.
 */
const heldRow = (parents, r) => {
  const stamp = (r.labels || []).map(filedWhileTarget).find(Boolean);
  const under = stamp ? [stamp, ...ancestorsOf(parents, stamp)] : ancestorsOf(parents, r.id);
  return {
    id: r.id,
    title: r.title || r.id,
    // `issue_type`, not `type` — a `bd` row's own spelling, and the trap `toRow` in
    // lib/endorsequeue.js exists for. A client reading `.type` off a raw row gets undefined.
    type: r.issue_type || null,
    priority: r.priority ?? null,
    createdAt: r.created_at || null,
    under,
  };
};

/**
 * The four `bd` calls behind one workspace's row, cached on their own — see
 * `forWorkspace` for why `sessions` and `store` are not in here with them.
 */
async function sweep(bd, ws) {
  const [summary, rows, held, ship] = await Promise.all([
    bd.status(ws),
    bd.listStatus(ws, 'in_progress'),
    bd.readyHeld(ws).catch(() => []),
    // Guarded on the method existing as well as on the call, which the line above is
    // not: this is the newest thing here, `bd` arrives duck-typed from several
    // harnesses, and a missing count must cost this row a subtraction rather than turn
    // the whole workspace into an error row — the same trade the `.catch` makes, one
    // step earlier. A `bd` that has the method and cannot answer degrades identically.
    bd.readyShip ? bd.readyShip(ws).catch(() => []) : [],
  ]);
  return { summary, rows, held, ship };
}

/**
 * One workspace's picture, built out of `sweep`'s four `bd` calls: counts, the claimed
 * beads, the ones held for endorsement, and the ship beads.
 *
 * The last two exist because `ready` is a number someone acts on. `bd status` counts a
 * bead held for endorsement as ready — it is ready in every way except the one that
 * matters, since nothing may open a session on it (lib/endorse.js) — so a monitor
 * quoting it raw would say "9 ready" over a queue of 4 and explain none of the
 * difference. So the held ones come out of `ready` and are reported as their own
 * number, which is the honest shape: work waiting on you, not work waiting on nobody.
 *
 * **A ship bead is the same argument with no pill at the end of it.** `bd status` counts
 * one as ready too, and nothing will ever open a session on one — only a deploy closes
 * it (lib/shipbead.js). But it is not work waiting on a decision either, so it is
 * subtracted and not reported: what it is waiting for is the press on the pull request
 * board, which has its own count over its own button. Twelve of them sat inside this
 * row's `ready` for two days with nothing on the screen to say so.
 *
 * The two sets overlap and must not be double-subtracted: a ship bead filed today
 * carries `unendorsed`, and one that "Endorse all" reached does not. `Bd.readyHeld`
 * excludes ship beads for exactly this reason — so the two counts partition rather than
 * intersect, and the pill agrees with the screen it links to.
 *
 * Those two calls are the only ones allowed to fail quietly. `bd ready --label` is the
 * newest thing here, and an older `bd` that refuses the combination should cost this row
 * a held count, not turn the whole workspace into an error row.
 *
 * A workspace that fails — a database mid-write, a workspace directory that has
 * gone away — reports its error rather than vanishing from the list. A missing row
 * would read as "nothing happening there", which is the one thing it doesn't mean.
 *
 * **The four `bd` calls are on lib/cache.js now, `sessions` and `store` are not**
 * (bc-1kwl.7). They come from the filesystem and an in-memory map respectively, not
 * from `bd`, so keeping them off the layer costs nothing and holding them back a
 * window would only mean a session that just opened waits up to `WORK_FRESH_MS` to
 * show up next to the row it belongs on. `store` and the label read below still run
 * fresh on every call — a cached row's raw `bd` fields plus a live `agent:<phase>`
 * label do the same phase lookup they always did, just over rows that may be a few
 * seconds old.
 */
async function forWorkspace(bd, ws, store, sessions = [], refresh = false) {
  const mine = sessions.filter((s) => s.workspace === ws.name);
  try {
    const got = await cache.read(workKey(ws.name), () => sweep(bd, ws), { freshMs: WORK_FRESH_MS, refresh });
    const { summary, rows, held, ship } = got.value;
    // Which epics sit above each held bead — and this row will not go and find out.
    //
    // `bd.graph` is a `bd export` per workspace, measured at 7.3 seconds for nine of them
    // (see `graph` in lib/bd.js), and this is a request path on a screen with a
    // one-second budget. `wait: false` is half the answer: it takes what is on hand and
    // lets a refresh land behind it. **`graphReady` is the other half** — it is the
    // question "has anything ever exported this workspace?", and asking it is what keeps
    // this row from *starting* an export nobody else wanted. The daemon's own tick reads
    // the graph for every workspace that has an advocate (`rosterFor` in lib/advocate.js)
    // and so does the inbox's P0 board, so on the machine this card is drawn on the
    // answer is already paid for; on a process where it is not, the chain is simply not
    // known.
    //
    // Not knowing is not an error here. Every held bead falls to the workspace's own
    // section, which is the bucket bc-w156.2 put under the whole feature anyway — so the
    // cold start costs the card its per-advocate split for one repaint and loses no bead.
    // Guarded on the methods as well as on the call, like `readyShip` above: `bd` arrives
    // duck-typed from several harnesses.
    const parents =
      bd.graphReady?.(ws) && bd.parents
        ? await bd.parents(ws, { wait: false }).catch(() => new Map())
        : new Map();
    // Newest first, and stable — the same order /endorse draws them in (`newestFirst` in
    // lib/endorsequeue.js), so the section and the page it links to agree about what is
    // at the top. Spelled here rather than imported: lib/endorsequeue.js reaches
    // lib/filing.js and lib/homing.js through `FILED_LABEL`, and this module is on the
    // request path of every repaint of the console.
    const heldRows = held
      .map((r) => heldRow(parents, r))
      .sort(
        (a, b) =>
          String(b.createdAt || '').localeCompare(String(a.createdAt || '')) ||
          String(a.id).localeCompare(String(b.id), 'en', { numeric: true })
      )
      .slice(0, HELD_ROWS_MAX);
    const working = rows.map((r) => {
      const key = `${ws.name}/${r.id}`;
      const live = store[key];
      // `agent:<phase>` is the cross-session signal — any tool can set it with
      // `bd set-state`, where status.json only knows what came through beadcause.
      const labelled = (r.labels || []).find((l) => l.startsWith('agent:'));
      const phase = live?.phase || (labelled ? labelled.slice(6) : null);
      return {
        id: r.id,
        title: r.title,
        priority: r.priority ?? null,
        actor: shortActor(r.assignee || r.owner),
        since: r.started_at || r.updated_at || r.created_at || null,
        phase: phase && phase !== 'idle' ? phase : null,
        icon: phase ? PHASES[phase]?.icon || '•' : null,
        detail: live?.detail || '',
      };
    });
    // Longest-running first: a bead claimed six hours ago is the interesting one.
    working.sort((a, b) => String(a.since || '').localeCompare(String(b.since || '')));
    return {
      name: ws.name,
      working,
      sessions: mine,
      counts: {
        open: summary?.open_issues ?? null,
        // Never below zero: the two numbers come from two calls a moment apart, and a
        // bead endorsed in between would otherwise show as "-1 ready".
        ready:
          summary?.ready_issues == null
            ? null
            : Math.max(0, summary.ready_issues - held.length - ship.length),
        held: held.length,
        blocked: summary?.blocked_issues ?? null,
        inProgress: summary?.in_progress_issues ?? working.length,
        // The only number on this row that is not work outstanding, and the only one
        // that costs nothing to have: `bd status` has carried `closed_issues` since
        // before this row existed and `forWorkspace` has always read that summary, so
        // surfacing it adds no fourth `bd` call to a screen that repaints every twenty
        // seconds. `?? null` rather than `?? 0`, like `open` and `blocked` above: a bd
        // too old to report it draws no pill at all, where a nought would state as a
        // fact that this repo has finished nothing.
        closed: summary?.closed_issues ?? null,
      },
      // The rows behind `counts.held`, for the console's "Requested endorsements"
      // sections. Capped at `HELD_ROWS_MAX`; the card compares this length against the
      // count above and says so when they differ, rather than quietly drawing fewer.
      heldRows,
      // Last good beats empty (bc-1kwl.7): `got.error` is set when the cache is
      // serving a kept answer because the refresh behind it just failed, so this row
      // is still real numbers over a workspace that is genuinely troubled — the catch
      // below is what a workspace with *no* last-good answer at all falls into.
      // `|| undefined` rather than `|| null`: a healthy row carried no `error` key at
      // all before this file went on lib/cache.js, and `w.error ? …` on the client
      // reads either the same way, so there is no reason to hand it a key it never had.
      error: got.error || undefined,
    };
  } catch (err) {
    // The sessions are still reported: they come from the filesystem, not from bd,
    // so a workspace whose database is mid-write can still tell you someone is in it.
    return { name: ws.name, working: [], sessions: mine, counts: {}, error: err.message.split('\n')[0] };
  }
}

/**
 * Throw the sweeps away — one workspace, or all of them. Same shape as
 * lib/endorsequeue.js's `forget` and lib/history.js's: for a test that changed the
 * world out from under a kept key, and for a `refresh=1` this route does not expose
 * yet but a future caller can wire without touching this file.
 */
export const forget = (workspace = null) => {
  if (workspace) cache.drop(`work:${workspace}`);
  else cache.dropPrefix('work:');
};

export async function collectWork(bd, workspaces, store = {}, sessions = [], { refresh = false } = {}) {
  const spaces = await Promise.all(workspaces.map((ws) => forWorkspace(bd, ws, store, sessions, refresh)));
  // Busiest first, then alphabetical — the ones with something happening in them are
  // why you opened this. A session counts as busy even with no bead claimed, which is
  // the whole reason it is here.
  spaces.sort(
    (a, b) =>
      b.working.length + b.sessions.length - (a.working.length + a.sessions.length) ||
      a.name.localeCompare(b.name)
  );
  return spaces;
}
