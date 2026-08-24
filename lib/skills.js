/**
 * Whether the skill library is being used — the numbers behind the Skills view.
 *
 * bc-dgx7.5. The epic's loop is: a session ends, the audit agent reads its archive next
 * to the ones before it (lib/sessionaudit.js), a repeated shape is filed as a candidate
 * bead, an endorsed candidate ships as a `b7e-<verb>` command every agent can call, and
 * agents call it instead of doing the work by hand. This file is the read of that loop's
 * *state* — the one place the programme is visible from a phone.
 *
 * ## The hard part is the denominator, not the query
 *
 * Everything above is a pipeline whose middle is not instrumented yet. bc-dgx7.6 is the
 * bead that records a skill call; until it lands nothing anywhere knows how many times a
 * command was run, by which session, or whether it has been run at all this month. Four
 * of the six numbers this view was asked for are downstream of that one fact.
 *
 * A screen that quietly omitted them would be read as a screen showing everything there
 * is, and the reader would conclude — from a page whose candidate list is honest and
 * whose adoption section simply is not there — that adoption is fine. That is the same
 * failure public/requirements.js was built to avoid, and it takes the same answer: **what
 * is not measured is drawn, named, and labelled untracked**, next to the bead that would
 * measure it. `UNTRACKED` below is that list, and it is data rather than prose in the page
 * so a test can assert every entry names something and so the page cannot drift from it.
 *
 * ## What *is* measured, and where it comes from
 *
 * Three sources, none of them new — this file adds no store of its own:
 *
 * - **The library.** `skillLibrary` in lib/sessionaudit.js: the `b7e-*` commands in a
 *   checkout's `bin/` and in its `package.json` bin map. Empty today, which is the honest
 *   answer and not a failure — nothing has shipped through the pipeline yet.
 * - **The candidates.** One `bd list --label skill-candidate` per workspace, closed rows
 *   included, because a *declined* candidate is one of the four counts asked for and a
 *   declined bead is a closed one. Their four states are read off fields that already
 *   exist rather than a status this file invents — see `candidateState`.
 * - **The audit ledger.** `readLedger` in lib/sessionaudit.js, per checkout: how many runs
 *   there have been, how many session archives have been read, and every *miss* — a
 *   session that hand-rolled something the library already covers. Misses are the one
 *   adoption number that exists today, and with an empty library there can be none of them
 *   by construction, which the page says out loud rather than drawing a proud zero.
 *
 * ## Per checkout, because that is the grain the evidence has
 *
 * A workspace is one beads graph and may be forty checkouts (lib/repos.js). Candidates are
 * a fact about the *graph* — one query answers for all forty. The library and the ledger
 * are facts about a *checkout*: `bin/` is a directory in one repo, and the audit ref is
 * written into whichever checkout the session it read was archived in. So the fan-out is
 * over `repoUnits` and the payload keeps both grains apart rather than summing them into
 * a number that is true of nothing.
 *
 * Nothing here writes, and nothing here starts an agent. Forcing an audit run is a
 * different act with a different cost — minutes and real money — and it is not a control
 * this page should carry, for the reason public/requirements.js carries no promote button.
 */
import { readLedger, skillLibrary, options as auditOptions, CANDIDATE_LABEL, MIN_SESSIONS } from './sessionaudit.js';
import { repoUnits } from './repos.js';
import { resolveSessionDir } from './session.js';
import { supersededBy } from './superseded.js';
import { REVOKED_PREFIX } from './verdict.js';
import { UNENDORSED } from './endorse.js';

/** The label every candidate carries, and the floor a finding is filed at. */
export { CANDIDATE_LABEL, MIN_SESSIONS };

/** How many checkouts are read at once. Three `git` calls each; forty repos is a sweep. */
const CONCURRENCY = 8;

/** A candidate's command, off the front of the title `candidateBead` writes. */
const COMMAND_RE = /^(b7e-[a-z][a-z0-9-]{1,23})\b/;

/**
 * The four states a candidate is counted in, in the order they are decided — and every
 * one of them is read off a field something else already writes.
 *
 * The order is the whole of the logic, because the three markers overlap on purpose:
 *
 * - **superseded** first. `superseded-by:` is the label a worker writes when the job turns
 *   out to be another bead's (lib/superseded.js), and the bead keeps whatever else it had
 *   — it may still be held, and it may be closed. Nothing else here is true of it.
 * - **declined** next, and it is a *close reason* rather than a label. A revoke closes the
 *   bead and deliberately leaves `unendorsed` on it (lib/verdict.js), so a marker test
 *   would count every declined candidate as one still waiting. `REVOKED_PREFIX` is fixed
 *   for exactly this reason: so the class is readable at a glance.
 * - **waiting** — still carrying the hold, which is where every candidate arrives.
 * - **accepted** is what is left. Not "built": endorsing a candidate is agreeing it is
 *   work worth doing, and whether the command exists is the library's answer rather than
 *   this one's. A candidate that has since shipped is accepted *and* closed, and the row
 *   says both.
 */
export const CANDIDATE_STATES = ['waiting', 'accepted', 'declined', 'superseded'];

export function candidateState(issue = {}) {
  if (supersededBy(issue)) return 'superseded';
  if (String(issue.close_reason || '').startsWith(REVOKED_PREFIX)) return 'declined';
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  if (labels.includes(UNENDORSED)) return 'waiting';
  return 'accepted';
}

/** The command a candidate proposes, or `''` for one whose title was rewritten. */
export const commandOf = (issue = {}) => String(issue.title || '').match(COMMAND_RE)?.[1] || '';

/**
 * The numbers this view was asked for that nothing records — said out loud, with the bead.
 *
 * Every entry names what would have to exist for the number to be real, because "not
 * tracked" on its own reads like an apology and this is a plan. `owed` is a bead in
 * *this* repo whatever workspace is on screen: the instrumentation is a beadcause
 * feature, so it is deliberately plain text rather than a link that would 404 for a
 * reader looking at another tracker.
 */
export const UNTRACKED = [
  {
    id: 'calls',
    metric: 'Calls per skill, and how many distinct sessions made them',
    why: 'Nothing records a skill call. A command on PATH is run by a shell inside a session that has since exited, and neither of them leaves a trace anything here reads.',
    owed: 'bc-dgx7.6',
  },
  {
    id: 'adopt',
    metric: 'Time to adopt — a skill landing to its first call by a session that did not build it',
    why: 'Both ends are missing: nothing stamps the moment a command shipped, and nothing records the call that would stop the clock.',
    owed: 'bc-dgx7.6',
  },
  {
    id: 'dead',
    metric: 'Dead skills — no call in thirty days',
    why: 'A skill with no calls recorded is indistinguishable from a skill whose calls nothing records, and calling the second one dead would retire commands that are working.',
    owed: 'bc-dgx7.6',
  },
  {
    id: 'bytes',
    metric: 'Prompt bytes removed, and cost per session before and after',
    why: 'The bytes come out of workPromptFor when a brief calls a command instead of inlining what it assembles, and nothing measures a prompt either side of that swap.',
    owed: 'bc-dgx7.4',
  },
];

/** Every checkout of one workspace — one per approved repo, or the workspace's own. */
export function checkoutsOf(cfg, ws) {
  const out = [];
  for (const unit of repoUnits(cfg, ws.name)) {
    let dir = null;
    let problem = '';
    try {
      dir = unit.repo ? unit.repo.dir : resolveSessionDir(cfg, ws);
    } catch (err) {
      problem = String(err?.message || err).split('\n')[0];
    }
    out.push({ key: unit.key, workspace: ws.name, repo: unit.repo?.name || '', dir, problem });
  }
  return out;
}

/** One worker per item with a ceiling on how many are in flight at once. */
async function pool(items, worker, limit = CONCURRENCY) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * One checkout's library and ledger. Never throws — a repo that has moved is a row on the
 * screen saying so, not a page that will not draw.
 */
export async function readCheckout(where) {
  const row = { ...where, library: [], runs: 0, audited: 0, misses: [], filed: 0, at: null };
  if (!where.dir) return { ...row, problem: where.problem || 'this workspace names no checkout' };
  try {
    const [library, ledger] = await Promise.all([skillLibrary(where.dir), readLedger(where.dir)]);
    return {
      ...row,
      library,
      runs: Number(ledger.runs) || 0,
      audited: (ledger.audited || []).length,
      misses: ledger.misses || [],
      filed: (ledger.candidates || []).length,
      at: ledger.at || null,
      problem: '',
    };
  } catch (err) {
    return { ...row, problem: String(err?.message || err).split('\n')[0] };
  }
}

/**
 * One workspace's candidate beads, newest-filed first. Never throws.
 *
 * `bd.listLabelAny` takes the **workspace object**, not its name — every `bd.*` call does,
 * and `assertWorkspaceObject` refuses a string with a sentence naming bc-ygwa. Passing the
 * name here is caught by nothing else: the throw lands in the catch below, comes back as
 * one line in `errors[]`, and the screen draws a candidate list that is empty because the
 * query never ran. Which is exactly how it read on the first live run of this file.
 */
export async function readCandidates(bd, ws) {
  let rows = [];
  try {
    rows = (await bd.listLabelAny(ws, CANDIDATE_LABEL)) || [];
  } catch (err) {
    return { rows: [], problem: String(err?.message || err).split('\n')[0] };
  }
  const out = rows
    .filter(Boolean)
    .map((r) => ({
      id: r.id,
      workspace: ws.name,
      title: String(r.title || ''),
      command: commandOf(r),
      state: candidateState(r),
      status: String(r.status || ''),
      priority: Number.isFinite(r.priority) ? r.priority : null,
      at: r.created_at || null,
      movedAt: r.updated_at || r.created_at || null,
      closeReason: String(r.close_reason || '').slice(0, 240),
      supersededBy: supersededBy(r) || '',
    }))
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return { rows: out, problem: '' };
}

/**
 * The whole screen, for the workspaces a request picked.
 *
 * The two grains stay apart: `candidates` is per workspace (one beads graph answers for
 * every repo in it) and `checkouts` is per repo (a `bin/` and an audit ref are facts about
 * a directory). `library` is the union across checkouts, each command carrying where it
 * was found, because "which repos ship this command" is a question and a bare list of
 * names is not an answer to it.
 */
export async function skillsView(bd, cfg, picked = []) {
  const errors = [];
  const wsList = (picked || []).filter(Boolean);

  const checkouts = (
    await pool(
      wsList.flatMap((ws) => checkoutsOf(cfg, ws)),
      readCheckout
    )
  ).filter(Boolean);
  for (const c of checkouts) if (c.problem) errors.push(`${c.key}: ${c.problem}`);

  const found = new Map();
  for (const c of checkouts) {
    for (const command of c.library) {
      if (!found.has(command)) found.set(command, { command, where: [], candidate: null });
      found.get(command).where.push(c.key);
    }
  }

  // All at once, the way lib/endorsequeue.js sweeps the same shape of query: these are
  // one `bd list` each and reads do not contend for Dolt's writer lock. Sequentially it
  // is ten workspaces' worth of process startup in series, and on a Mac with a dozen
  // sessions running that measured 149 seconds — inside `cache.read`'s 150-second ceiling
  // by one second, which is not a margin.
  const candidates = (
    await Promise.all(
      wsList.map(async (ws) => {
        const { rows, problem } = await readCandidates(bd, ws);
        if (problem) errors.push(`${ws.name}: ${problem}`);
        return rows;
      })
    )
  ).flat();
  // `at` is millisecond-resolution; two candidates filed in the same cataloguing pass
  // can tie on it, and the "first wins" attribution below would then pick by accidental
  // workspace-fetch order instead. id breaks the tie deterministically.
  candidates.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')) || String(a.id).localeCompare(String(b.id)));

  // Which candidate proposed a command that now exists. It is the only link there is
  // between the two halves of the pipeline today, and the nearest thing to a time-to-ship
  // — the shipping *moment* is what is missing, not the pairing.
  for (const row of candidates) {
    const hit = row.command && found.get(row.command);
    if (hit && !hit.candidate) hit.candidate = { id: row.id, workspace: row.workspace, state: row.state };
  }

  const counts = { filed: candidates.length };
  for (const state of CANDIDATE_STATES) counts[state] = candidates.filter((c) => c.state === state).length;

  const o = auditOptions(cfg);
  const misses = checkouts.flatMap((c) => (c.misses || []).map((m) => ({ ...m, key: c.key })));
  const audited = checkouts.reduce((n, c) => n + c.audited, 0);
  const runs = checkouts.reduce((n, c) => n + c.runs, 0);
  const lastAt =
    checkouts
      .map((c) => c.at)
      .filter(Boolean)
      .sort()
      .pop() || null;

  return {
    library: [...found.values()].sort((a, b) => a.command.localeCompare(b.command)),
    candidates: { counts, rows: candidates },
    audit: {
      runs,
      audited,
      misses,
      lastAt,
      enabled: o.enabled,
      every: o.every,
      cooldownMinutes: Math.round(o.cooldownMs / 60000),
      max: o.max,
      minSessions: MIN_SESSIONS,
    },
    checkouts: checkouts.map(({ misses: _misses, ...rest }) => rest),
    untracked: UNTRACKED,
    errors,
  };
}
