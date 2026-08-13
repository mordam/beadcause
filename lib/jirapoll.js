/**
 * The tickets JIRA says are yours — asked for on a clock, held, and never quietly zero.
 *
 * lib/jira.js answers *is JIRA on for this workspace, where does it point, and how is a
 * read issued*. This is the thing that actually asks, on the daemon's own timer, and
 * holds the answer where the inbox (bc-0i27.3), the filing of an epic per ticket
 * (bc-0i27.4) and the ticket view (bc-0i27.6) can all read it without a second call.
 *
 * ## One query, written here, and nowhere else
 *
 * `assignee = "<email>" AND resolution = EMPTY`, scoped to the workspace's projects when
 * it has them, newest first. That is the whole of what this epic asks JIRA, and the JQL
 * is **not** a parameter: `search()` in lib/jira.js will issue whatever string it is
 * given, so the defence against beadcause growing a general JIRA query surface is that
 * there is no caller who can name one. Anything that wants a different slice adds a
 * named query to this file, where it can be read and argued about.
 *
 * `resolution = EMPTY` rather than `status != Done`: every JIRA site renames its
 * statuses and none of them renames the resolution field, so a status-name query is one
 * that works here and silently returns nothing at the next company.
 *
 * **And a second named query, for the sites that will not search by address.** Atlassian
 * Cloud hides user emails on GDPR-strict sites, and on those `assignee = "you@x.com"` is
 * refused with a 400 rather than matched against nobody — so the whole epic would read
 * as a permanent configuration failure on a site that is working exactly as intended.
 * The fallback is `assignee = currentUser()`, which is the same question asked of the
 * account the token belongs to, and it is used **only after** `/myself` has confirmed
 * that account *is* the configured address. Without that confirmation the fallback would
 * silently answer with a different person's tickets the day somebody points the block at
 * a colleague's address — and the whole of bc-0i27 downstream of here files epics from
 * what this returns.
 *
 * ## The clock, and what it costs a workspace that has no JIRA
 *
 * lib/prboard.js is the precedent and lib/sync.js is the shape: a timestamp of its own
 * inside the poll cycle, an interval in the config beside `pollSeconds`, and an
 * `inflight` guard because `setInterval` does not await an async callback and a sweep
 * slower than its interval would otherwise have a second one started on top of it.
 *
 * A minute, because a ticket assigned to you is not a thing you are watching a second
 * hand for and every tick is a network round trip per configured workspace. The floor is
 * fifteen seconds rather than `pollSeconds`' five: there is no such thing as a usefully
 * faster read of somebody's assigned tickets, and the only thing a faster one buys is
 * traffic against a rate limit shared with everything else that talks to that site.
 *
 * **A workspace with no `jira` block costs exactly nothing** — not a network call, not a
 * `bd` spawn, not a cache entry. That is checked in test/jira-poll.mjs rather than left
 * as an intention, because most workspaces on any machine are that workspace, and a
 * poller that costs "almost nothing" per workspace is one whose cost is the size of
 * somebody's `~/beads`.
 *
 * ## `settingsFor` is three `bd` spawns, so it is resolved once and held
 *
 * `settingsFor` asks `bd config get` for `jira.url`, `jira.username` and `jira.projects`
 * — three processes per workspace, for values that change roughly never. On a timer that
 * is three spawns a minute, forever, to learn the same URL. So the *`bd` half* of the
 * resolution is memoised for ten minutes and the rest is redone every sweep:
 *
 * - The config block is read fresh, because it is already in memory and a value somebody
 *   typed into beadcause should take effect on the next tick.
 * - **The token is read fresh**, because it is one `readFileSync` of a small file and the
 *   ordinary way JIRA gets switched on is *writing that file* — a cached "no credential"
 *   would mean the daemon reporting a problem that had been fixed ten minutes ago, which
 *   is precisely the class of failure this whole epic is careful about.
 *
 * Ten minutes rather than forever so that `bd config set jira.url` in a workspace takes
 * effect without a restart, and `invalidate()` drops it outright for a caller that knows
 * something changed.
 *
 * ## A failure must not read as quiet
 *
 * This is lib/sweep.js's whole argument, and a JIRA read is a third kind of read that
 * fails independently of the two `bd` ones: the tracker can be perfectly readable while
 * the token is expired, the site is renamed, or the wifi is down. So the record is a
 * `createSweep('jira')` of its own — the last good answer stands in for a missing one,
 * and the failure is named, with JIRA's own reason, in `trouble()`.
 *
 * A workspace that is switched **on** but not configured is trouble too, not silence:
 * `settings.problem` is a sentence that names the fix, and the alternative is a section
 * that draws nothing while somebody waits for tickets that were never going to be asked
 * for. A workspace that is switched **off** is silent, because that is what off means.
 *
 * Deliberately not persisted, for lib/sweep.js's reason: a restart has no last-good
 * answer for anybody and should ask for one.
 */
import { check, jiraEnabled, search, settingsFor } from './jira.js';
import { createSweep } from './sweep.js';

/** How often the tickets are re-asked for, in ms, with a floor. See the header. */
export const JIRA_FLOOR_SECONDS = 15;

export const jiraEveryMs = (cfg) => Math.max(JIRA_FLOOR_SECONDS, Number(cfg?.jiraSeconds) || 60) * 1000;

/** How long `bd config get`'s three answers are reused for one workspace. */
export const BD_CACHE_MS = 10 * 60 * 1000;

/**
 * How many tickets one workspace's answer may hold.
 *
 * Not a paging cursor and deliberately not `MAX_RESULTS`: a person with more than fifty
 * unresolved tickets assigned to them does not have an inbox problem this app can fix by
 * drawing all of them, and bc-0i27.4 files an epic per ticket — so this number is also
 * the blast radius of pointing beadcause at a queue account by mistake.
 */
export const TICKET_LIMIT = 50;

/**
 * Exactly what a row draws, and nothing else.
 *
 * The default is every field on the issue, which for a ticket with a long description and
 * a hundred comments is a payload nobody here reads. The description is deliberately not
 * among these: the view in bc-0i27.6 fetches it when it is opened, which is the one place
 * it is read and the only place its size is worth paying for.
 */
export const TICKET_FIELDS = ['summary', 'status', 'assignee', 'updated'];

/** A value going inside a JQL double-quoted string. */
export const escapeJql = (value) =>
  String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');

/**
 * The one query — see the header for why both halves of it are what they are.
 *
 * `ORDER BY updated DESC` because the list is truncated at `TICKET_LIMIT`, and if
 * something has to fall off the end it should be the ticket nobody has touched in a
 * year rather than the one that moved this morning.
 */
export function assignedJql(settings, { currentUser = false } = {}) {
  const who = currentUser ? 'currentUser()' : `"${escapeJql(settings?.email)}"`;
  const projects = (settings?.projects || []).map((p) => String(p || '').trim()).filter(Boolean);
  const scope = projects.length ? ` AND project in (${projects.map((p) => `"${escapeJql(p)}"`).join(', ')})` : '';
  return `assignee = ${who} AND resolution = EMPTY${scope} ORDER BY updated DESC`;
}

/**
 * One workspace's answer as a single comparable string.
 *
 * Each key with the timestamp JIRA last touched it, and deliberately not the whole row.
 * `updated` moves whenever anything about the ticket does, so a status change redraws
 * and a re-read that found the identical list does not — which is what matters, because
 * the daemon wakes every parked phone for a change and a feed that fires on nothing is
 * one clients learn to ignore. Comparing the rows themselves would do the same job and
 * make the answer depend on the shape of a row, which bc-0i27.3 and .6 are still moving.
 */
const keysOf = (tickets) => (tickets || []).map((t) => `${t.key}@${t.updated || ''}`).join(',');

/** Is the account the credential belongs to the address the config named? */
const sameAddress = (a, b) => Boolean(a) && Boolean(b) && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/**
 * One issue, as the rest of the app holds it.
 *
 * The shape is bc-0i27.2's contract and bc-0i27.3 is drawing rows against it: key,
 * summary, status, updated, url, assignee — enough for a row without a second call.
 * `workspace` rides along because everything downstream is per workspace: which space a
 * ticket belongs to, whether that space is quiet, and which tracker its epic gets filed
 * in are all answered from it.
 *
 * `url` is built rather than read off `issue.self`, which is the REST URL — a link that
 * lands a phone on a page of JSON. `/browse/<key>` is the one a person means.
 *
 * `assignee` is an address when the site will say and a display name when it will not,
 * because it exists to answer "is this still mine" for a human reading the row, and a
 * row with an empty name where the site has anonymised its users is a row that reads as
 * unassigned — which is the one thing it cannot be, given the query that found it.
 */
export function ticketFrom(issue, settings = {}) {
  const fields = issue?.fields || {};
  const site = String(settings.url || '').replace(/\/+$/, '');
  const person = fields.assignee || null;
  return {
    workspace: settings.workspace || null,
    key: issue?.key || null,
    summary: fields.summary || '',
    status: fields.status?.name || null,
    updated: fields.updated || null,
    url: site && issue?.key ? `${site}/browse/${issue.key}` : null,
    assignee: person?.emailAddress || person?.displayName || null,
  };
}

/**
 * The poller: a record, a clock's worth of state, and the tickets it last got.
 *
 * `bd` and `fetchImpl` are both injectable for the same reason they are in lib/sync.js
 * and lib/jira.js — the failure paths are the half that matters here and the half you
 * cannot produce for real from inside a test.
 */
export function createJiraPoller({ bd = null, fetchImpl = undefined } = {}) {
  /** Last good rows and the failures — lib/sweep.js. */
  const record = createSweep('jira');
  /** workspace → the rows to serve right now (the last good answer if it just failed). */
  const latest = new Map();
  /** `<workspace>::<key>` → { value, at }. The three `bd config get` spawns. */
  const bdAnswers = new Map();
  /** Workspaces whose site refuses to search by address — see the header. */
  const byCurrentUser = new Set();
  /** One sweep of a workspace at a time. `setInterval` does not await. */
  const inflight = new Set();
  /** Which workspaces are in trouble right now — read off the record, never a second copy. */
  const failedNames = () => new Set(record.trouble().map((t) => t.workspace));

  /**
   * `bd`, with `config get` memoised.
   *
   * A wrapper rather than a reimplementation of `settingsFor`: the resolution order, the
   * four "no site / not a URL / no address / no credential" sentences and the `(not set)`
   * trap all live in lib/jira.js, and a second copy of them here would be a second thing
   * to keep right. What is cached is exactly the expensive part — the process spawn — and
   * nothing about what it means.
   */
  const memoBd = (now) => ({
    async run(workspace, args, opts) {
      if (!(args?.[0] === 'config' && args?.[1] === 'get')) return bd.run(workspace, args, opts);
      const cacheKey = `${workspace?.name || ''}::${args[2]}`;
      const hit = bdAnswers.get(cacheKey);
      if (hit && now - hit.at < BD_CACHE_MS) return hit.value;
      const value = await bd.run(workspace, args, opts);
      bdAnswers.set(cacheKey, { value, at: now });
      return value;
    },
  });

  /**
   * Ask, with the fallback for a site that will not search by address.
   *
   * The fallback costs one extra call once, on the first tick against such a site, and
   * nothing afterwards: the answer is remembered per workspace, because whether a site
   * anonymises its users is a fact about the site rather than about the query.
   */
  async function issuesFor(settings, name) {
    const opts = { fields: TICKET_FIELDS, limit: TICKET_LIMIT, fetchImpl };
    if (byCurrentUser.has(name)) return search(settings, assignedJql(settings, { currentUser: true }), opts);
    try {
      return await search(settings, assignedJql(settings), opts);
    } catch (err) {
      // Only a 400 — JIRA refused the *query*. A 401, a 404 or a dead network are all
      // things the second query would fail at in exactly the same way, and retrying them
      // would double the traffic of an outage to learn nothing.
      if (err?.status !== 400) throw err;
      const me = await check(settings, { fetchImpl });
      // The guard the header argues for: no confirmation, no fallback. Reported as the
      // original error, because "JIRA refused this query" is the true and useful half —
      // a message about identity would send somebody to look at the wrong thing.
      if (!me.ok || !sameAddress(me.as, settings.email)) throw err;
      const rows = await search(settings, assignedJql(settings, { currentUser: true }), opts);
      byCurrentUser.add(name);
      console.log(`[jira] ${name}: this site will not search by address — asking as currentUser() from now on`);
      return rows;
    }
  }

  /**
   * One workspace, once. Never throws.
   *
   * The outcome is a word rather than a boolean, exactly as `syncOnce` in lib/sync.js is,
   * and for the same reason: `off` is not a success and it is certainly not a failure.
   */
  async function pollOne(cfg, workspace) {
    const name = workspace?.name || '';
    if (!jiraEnabled(cfg, name)) return { workspace: name, state: 'off', tickets: [], error: null };

    let settings = null;
    try {
      settings = await settingsFor(memoBd(Date.now()), workspace, cfg);
    } catch (err) {
      return { workspace: name, state: 'failed', tickets: record.failed(name, err), error: String(err?.message || err) };
    }
    // Switched on and not configured. Trouble rather than silence — the sentence names
    // the file or the key to fix, and nobody is coming to look in the daemon's log.
    if (settings.problem) {
      return { workspace: name, state: 'failed', tickets: record.failed(name, new Error(settings.problem)), error: settings.problem };
    }

    try {
      const issues = await issuesFor(settings, name);
      const tickets = issues.map((issue) => ticketFrom(issue, settings));
      return { workspace: name, state: 'ok', tickets: record.ok(name, tickets), error: null };
    } catch (err) {
      return { workspace: name, state: 'failed', tickets: record.failed(name, err), error: String(err?.message || err) };
    }
  }

  return {
    /** Every workspace that did not answer, in lib/sweep.js's shape. */
    trouble: () => record.trouble(),

    /**
     * The tickets currently held, newest first, or one workspace's.
     *
     * Sorted here rather than at each reader: the order is a fact about the list — JIRA
     * was asked for it newest first — and three readers sorting it three ways is how two
     * screens start disagreeing about which ticket is at the top.
     */
    tickets(name = null) {
      const rows = name === null ? [...latest.values()].flat() : latest.get(name) || [];
      return [...rows].sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
    },

    /** Forget the `bd`-derived settings — for a caller that knows the config moved. */
    invalidate(name = null) {
      if (name === null) return bdAnswers.clear();
      for (const key of [...bdAnswers.keys()]) if (key.startsWith(`${name}::`)) bdAnswers.delete(key);
    },

    /**
     * Every workspace with JIRA switched on, in parallel. Never throws.
     *
     * Parallel because they are separate sites with separate credentials and nothing is
     * shared between two of them, so doing them in turn would make the sweep cost the sum
     * of the slowest case rather than the slowest single one — and a JIRA read is capped
     * at fifteen seconds each (`TIMEOUT_MS` in lib/jira.js).
     *
     * The filter is what makes a workspace without JIRA free, and it is deliberately the
     * *first* thing: `jiraEnabled` reads the config in memory, so a machine whose every
     * workspace is bd-only does one map lookup per workspace per minute and stops there.
     */
    async sweep(cfg, workspaces = cfg?.workspaces || []) {
      const on = (workspaces || []).filter((w) => jiraEnabled(cfg, w?.name || ''));
      // A workspace that has been switched off — or removed — must not keep serving the
      // tickets it had when it was on. The held answer is a stand-in for a read nobody
      // could make, and there is no read to stand in for any more.
      const live = new Set(on.map((w) => w.name));
      for (const name of [...latest.keys()]) if (!live.has(name)) latest.delete(name);

      const due = on.filter((w) => !inflight.has(w.name));
      const skipped = on.filter((w) => inflight.has(w.name)).map((w) => w.name);
      for (const w of due) inflight.add(w.name);
      const results = await Promise.all(
        due.map(async (w) => {
          try {
            // What this workspace looked like *before* the read, so the outcome can say
            // whether anything actually moved. The daemon parks a phone's poll on the
            // event log (lib/events.js) and only wakes it for a change, so a ticket that
            // arrives without one is a ticket nobody is told about until something else
            // happens to move — which on a quiet evening is hours.
            const was = { keys: keysOf(latest.get(w.name)), failed: failedNames().has(w.name) };
            const out = await pollOne(cfg, w);
            latest.set(w.name, out.tickets);
            const changed = keysOf(out.tickets) !== was.keys || (out.state === 'failed') !== was.failed;
            return { ...out, changed };
          } finally {
            inflight.delete(w.name);
          }
        })
      );
      return { results, changed: results.filter((r) => r.changed), skipped, tickets: this.tickets() };
    },
  };
}
